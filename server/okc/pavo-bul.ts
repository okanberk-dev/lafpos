import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { PAVO_DEFAULT_PORT, PavoClient, type PavoStore } from './pavo';

/**
 * Yönetim › Yazarkasa POS › Pavo › "Cihazı ağda ara": kasa bilgisayarının bağlı olduğu yerel ağda (yalnız özel adres
 * aralıkları, /24) Pavo'nun REST portlarını yoklar, açık bulduğuna `/Ping` gönderir. `/Ping` eşleştirme ve sıra no
 * istemez (Pavo'nun REST kuralı); cihaz durumunu değiştirmez. Yanıt veren adresler aday olur, kasiyer seçer.
 * Seri numarası bu yolla okunmaz: cihazın ayarlarından ya da fişinden yazılır. Ayrıntı: docs/04-YAZARKASA.md §8.1
 */

/** Pavo'nun REST portları: N86'da entegratörlerin kullandığı 4567, belgedeki HTTPS 4568 */
export const PAVO_PORTS = [PAVO_DEFAULT_PORT, 4568];

export interface PavoCandidate {
  url: string;
  /** Cihaz `/Ping`'i hatasız yanıtladı (seri no verildiyse onunla: seri no tutuyor demektir) */
  ok: boolean;
  /** Cihazın yanıtındaki mesaj (ör. "Seri numarası eşleşmiyor") */
  message: string | null;
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

/** Port açık mı: TCP bağlantısı kurulup hemen kapatılır */
function portOpen(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      socket?.destroy();
      resolve(ok);
    };
    let socket: ReturnType<typeof connect> | null = null;
    try {
      socket = connect({ host, port });
    } catch {
      return finish(false);
    }
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
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

/** Açık porttaki cihaz Pavo gibi yanıt veriyor mu: önce HTTPS (N86), sonra HTTP; JSON yanıt veren adres aday */
async function pingPavo(host: string, port: number, serial: string, timeoutMs: number): Promise<PavoCandidate | null> {
  for (const scheme of ['https', 'http']) {
    const url = `${scheme}://${host}:${port}`;
    try {
      const res = await new PavoClient({ url, serial, fingerprint: 'LafPOS' }, noStore).ping(timeoutMs);
      return { url, ok: !res.HasError, message: typeof res.Message === 'string' ? res.Message.slice(0, 120) : null };
    } catch {
      /* bu şemayla yanıt yok */
    }
  }
  return null;
}

/**
 * Ağda Pavo arar. `serial` yazıldıysa `/Ping` onunla gider: cihaz seri no'yu denetler, tutup tutmadığı adayda görünür.
 * `hosts` ve `ports` testler içindir (sahte cihaz bu bilgisayarda); verilmezse yerel ağ taranır. 254 adres × 2 port,
 * 128'er yoklama, adres başına en çok ~0,7 sn: birkaç saniye sürer
 */
export async function findPavo(opts: { serial?: string; hosts?: string[]; ports?: number[]; connectMs?: number; pingMs?: number } = {}) {
  const started = Date.now();
  const scan = opts.hosts ? { subnets: [], hosts: opts.hosts } : scanHosts(localAddresses());
  const ports = opts.ports ?? PAVO_PORTS;
  const targets = scan.hosts.flatMap((host) => ports.map((port) => ({ host, port })));
  const open = (await pool(targets, 128, async (t) => ((await portOpen(t.host, t.port, opts.connectMs ?? 700)) ? t : null))).filter((t): t is { host: string; port: number } => !!t);
  const found = (await pool(open, 8, (t) => pingPavo(t.host, t.port, opts.serial ?? '', opts.pingMs ?? 3000))).filter((c): c is PavoCandidate => !!c);
  return { subnets: scan.subnets, scanned: scan.hosts.length, candidates: found, ms: Date.now() - started };
}
