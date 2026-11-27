import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { PAVO_DEFAULT_PORT, PavoClient, PavoError, type PavoStore } from './pavo';
import { PAVO_KIMLIGI } from '@shared/eski-adlar';

/**
 * Yönetim › Yazarkasa POS › Pavo › "Cihazı ağda ara": kasa bilgisayarının bağlı olduğu yerel ağda (yalnız özel adres
 * aralıkları, /24) Pavo'nun REST portlarını yoklar, açık bulduğuna `/Ping` gönderir. `/Ping` eşleştirme ve sıra no
 * istemez (Pavo'nun REST kuralı); cihaz durumunu değiştirmez. Yanıt veren adresler aday olur, kasiyer seçer.
 * Seri numarası bu yolla okunmaz: cihazın ayarlarından ya da fişinden yazılır. Ayrıntı: docs/04-YAZARKASA.md §8.1
 *
 * Kasada aynı ağda iki adres olabilir (kablo ve Wi-Fi): ağ bir kez taranır, kasanın bütün adresleri taramadan düşer.
 */

/** Pavo'nun REST portları: N86'da entegratörlerin kullandığı 4567, belgedeki HTTPS 4568 */
export const PAVO_PORTS = [PAVO_DEFAULT_PORT, 4568];

export interface PavoCandidate {
  url: string;
  /** Cihaz `/Ping`'i hatasız yanıtladı (seri no verildiyse onunla: seri no tutuyor demektir) */
  ok: boolean;
  /** Cihazın yanıtındaki mesaj (ör. "Seri numarası eşleşmiyor") */
  message: string | null;
  /** Adres HTTP yanıtı verdi ama gövde Pavo'nun JSON'u değil: Pavo olduğu doğrulanamadı */
  unrecognized?: boolean;
}

/** Yoklama hiçbir şey yazmaz: sıra no ve sertifika izi kalıcı depoya gitmez */
const noStore: PavoStore = { getSequence: () => 0, setSequence: () => {}, getCert: () => null, setCert: () => {} };

/** Özel ağ adresi mi (10/8, 172.16/12, 192.168/16); Tailscale (100.64/10), bağlantı yerel ve genel ağ taranmaz */
export function privateIpv4(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return p[0] === 10 || (p[0] === 172 && p[1]! >= 16 && p[1]! <= 31) || (p[0] === 192 && p[1] === 168);
}

/** Bu bilgisayarın yerel ağ adresleri (dış ağ kartları, özel IPv4) */
export function localAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) {
      const v4 = a.family === 'IPv4' || (a.family as unknown) === 4;
      if (v4 && !a.internal && privateIpv4(a.address)) out.push(a.address);
    }
  }
  return [...new Set(out)];
}

/** Taranacak adresler: her yerel adresin /24'ü (kendisi hariç), en çok üç ağ */
export function scanHosts(own: string[]): { subnets: string[]; hosts: string[] } {
  const subnets = [...new Set(own.map((ip) => ip.split('.').slice(0, 3).join('.')))].slice(0, 3);
  const mine = new Set(own);
  const hosts = subnets.flatMap((net) => Array.from({ length: 254 }, (_, i) => `${net}.${i + 1}`)).filter((h) => !mine.has(h));
  return { subnets: subnets.map((n) => `${n}.0/24`), hosts };
}

/** Yoklamanın sonucu: `open` bağlantı kuruldu · `refused` adres var, port kapalı · `silent` süresinde yanıt yok */
type Probe = 'open' | 'refused' | 'silent';

/** Port açık mı: TCP bağlantısı kurulup hemen kapatılır */
function probePort(host: string, port: number, timeoutMs: number): Promise<Probe> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r: Probe) => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolve(r);
    };
    let socket: ReturnType<typeof connect> | null = null;
    try {
      socket = connect({ host, port });
    } catch {
      return finish('silent');
    }
    socket.setTimeout(timeoutMs, () => finish('silent'));
    socket.once('connect', () => finish('open'));
    socket.once('error', (e) => finish((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' ? 'refused' : 'silent'));
  });
}

/** `limit` kadar iş aynı anda */
async function pool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Açık porttaki cihaz Pavo gibi yanıt veriyor mu: önce HTTPS (N86), sonra HTTP; JSON yanıt veren adres aday. Cihaz
 * yanıt verdi ama gövde JSON değilse (`HTTP_<kod>`: cihaz `/Ping`'i seri no'suz reddediyor olabilir) adres yine aday
 * olur, tanınmadığı işaretlenir: kasiyer adresi görür, "Bağlantıyı dene" kesin söyler. Hiç yanıt yoksa bir kez daha
 * denenir: cihaz aynı anda tek istek işler, az önceki port yoklamasının bağlantısını kapatıyor olabilir
 */
async function pingPavo(host: string, port: number, serial: string, timeoutMs: number): Promise<PavoCandidate | null> {
  let answered: PavoCandidate | null = null;
  for (let attempt = 0; attempt < 2 && !answered; attempt++) {
    if (attempt) await wait(400);
    for (const scheme of ['https', 'http']) {
      const url = `${scheme}://${host}:${port}`;
      try {
        const res = await new PavoClient({ url, serial, fingerprint: PAVO_KIMLIGI }, noStore).ping(timeoutMs);
        return { url, ok: !res.HasError, message: typeof res.Message === 'string' ? res.Message.slice(0, 120) : null };
      } catch (e) {
        const code = e instanceof PavoError ? e.code : null;
        if (code && /^HTTP_\d+$/.test(code)) answered ??= { url, ok: false, message: `Yanıt verdi ama Pavo olduğu doğrulanamadı (${code.replace('_', ' ')})`, unrecognized: true };
        /* bu şemayla yanıt yok */
      }
    }
  }
  return answered;
}

/**
 * Ağda Pavo arar. `serial` yazıldıysa `/Ping` onunla gider: cihaz seri no'yu denetler, tutup tutmadığı adayda görünür.
 * `hosts` ve `ports` testler içindir (sahte cihaz bu bilgisayarda); verilmezse yerel ağ taranır.
 *
 * Sahada (Kasım 2026) sağlıklı, eşleştirilmemiş bir N86 192.168.1.221:4567'de dururken tarama "bulunamadı" dedi;
 * IP'si elle yazılınca dakikalar sonra sorunsuz eşleşti. Tarama bağlantı denemesinden üç yerde daha katıydı:
 * 1. `/Ping` 3 sn bekleniyordu (bağlantı denemesi 10 sn). Android tabanlı cihaz ilk HTTPS el sıkışmasını (kendi
 *    imzaladığı sertifika) yavaş yapabilir: artık 8 sn, yanıt gelmezse bir kez daha.
 * 2. JSON olmayan yanıt (cihaz seri no'suz `/Ping`'i HTTP hatasıyla reddedebilir; aynı cihaz `/PrintEODCopy`'ye gövdesiz
 *    HTTP 404 döndü) adresi elerdi: artık "yanıt verdi, doğrulanamadı" adayıdır, kasiyer adresi görür.
 * 3. Port yoklaması adres başına 0,7 sn bekliyordu. Wi-Fi'daki cihaz güç tasarrufundayken ya da 254 adres aynı anda
 *    aranırken ağdaki ilk soru (ARP) ya da ilk bağlantı paketi kaybolursa Windows yaklaşık 1 sn sonra yineler: yanıt
 *    0,7 sn'ye sığmaz. İlk turda yanıtsız kalan (reddetmeyen) adresler 2,5 sn'yle bir kez daha yoklanır.
 * İki ağda toplam 15-20 sn sürer
 */
export async function findPavo(opts: { serial?: string; hosts?: string[]; ports?: number[]; connectMs?: number; retryMs?: number; pingMs?: number } = {}) {
  const started = Date.now();
  const scan = opts.hosts ? { subnets: [], hosts: opts.hosts } : scanHosts(localAddresses());
  const ports = opts.ports ?? PAVO_PORTS;
  type Target = { host: string; port: number };
  const targets: Target[] = scan.hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const first = await pool(targets, 128, async (t) => ({ t, r: await probePort(t.host, t.port, opts.connectMs ?? 700) }));
  const open: Target[] = first.filter((x) => x.r === 'open').map((x) => x.t);
  // Portu reddeden adres vardır ve yanıt veriyor: yeniden yoklanmaz. Yanıtsız kalan bir kez daha, daha uzun süreyle
  const silent = first.filter((x) => x.r === 'silent').map((x) => x.t);
  const retryMs = opts.retryMs ?? 2500;
  if (silent.length && retryMs > 0) {
    const second = await pool(silent, 256, async (t) => ((await probePort(t.host, t.port, retryMs)) === 'open' ? t : null));
    open.push(...second.filter((t): t is Target => !!t));
  }
  const found = (await pool(open, 8, (t) => pingPavo(t.host, t.port, opts.serial ?? '', opts.pingMs ?? 8000))).filter((c): c is PavoCandidate => !!c);
  return { subnets: scan.subnets, scanned: scan.hosts.length, retried: silent.length, candidates: found, ms: Date.now() - started };
}
