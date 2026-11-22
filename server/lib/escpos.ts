import { connect } from 'node:net';

/**
 * Fişi Windows'un yazdırma penceresi açılmadan doğrudan termal yazıcıya basmak (ESC/POS, ağ yazıcısı). Arayüz fişi
 * bugünkü bileşenle görüntüye çevirir (src/lib/print.tsx, 576 nokta = 72 mm @203 dpi) ve 1 bitlik satırlar olarak
 * gönderir; burada raster komutu (GS v 0) ve kesme (GS V) eklenip yazıcının RAW portuna (9100) TCP ile yollanır. Yazı
 * görüntü olduğundan Türkçe karakter ve kod sayfası sorunu yok. Bağlanılamazsa arayüz tarayıcıdan basar (fiş kaybolmaz)
 */

/** 80 mm termal yazıcının basabildiği genişlik (nokta) */
export const RASTER_WIDTH = 576;
/** En uzun fiş (nokta): ~2 m; daha uzunu reddedilir */
export const RASTER_MAX_HEIGHT = 16000;
/** Tek GS v 0 komutundaki satır: ucuz yazıcıların alma belleği için bantlara bölünür */
const BAND = 256;

export interface Raster {
  /** Nokta; 8'in katı */
  width: number;
  height: number;
  /** Satır satır, her bayt 8 nokta (en soldaki en yüksek bit), 1 = siyah */
  bits: Uint8Array;
}

/** ESC @ (sıfırla), bant bant GS v 0, sonra kesme yerine kadar ilerletip kes (GS V 65 0) */
export function escposRaster(img: Raster): Uint8Array {
  const xBytes = img.width / 8;
  if (!Number.isInteger(xBytes) || xBytes < 1) throw new Error('Görüntü genişliği 8’in katı olmalı');
  if (img.bits.length !== xBytes * img.height) throw new Error('Görüntü boyu tutmuyor');
  const parts: Uint8Array[] = [Uint8Array.of(0x1b, 0x40)];
  for (let y = 0; y < img.height; y += BAND) {
    const rows = Math.min(BAND, img.height - y);
    parts.push(Uint8Array.of(0x1d, 0x76, 0x30, 0x00, xBytes & 0xff, xBytes >> 8, rows & 0xff, rows >> 8));
    parts.push(img.bits.subarray(y * xBytes, (y + rows) * xBytes));
  }
  parts.push(Uint8Array.of(0x1d, 0x56, 0x41, 0x00));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/**
 * Windows yazıcı portunun adından ağ yazıcısının adresi: Standard TCP/IP portu "192.168.1.249", "IP_192.168.1.249" ya da
 * "192.168.1.249_1" gibi adlanır. Port numarası adda yoksa RAW 9100. USB001 gibi yerel portta null
 */
export function printerAddress(port: string | null | undefined): { host: string; port: number } | null {
  if (!port) return null;
  const m = /(?:^|[^\d.])((?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})(?![\d.])(?::(\d{2,5}))?/.exec(port);
  if (!m) return null;
  const n = m[2] ? Number(m[2]) : 9100;
  return { host: m[1]!, port: n > 0 && n < 65536 ? n : 9100 };
}

/** Aynı yazıcıya iki iş aynı anda gitmez (RAW port tek bağlantı kabul eder; iki nüsha sırayla kesilir) */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Baytları yazıcıya gönderir. Bağlantı `connectMs` içinde kurulmazsa ya da yazıcı `idleMs` boyunca veri almazsa
 * reddedilir. Veri işletim sistemine teslim edilince (yazıcı almaya başlamışken) biter
 */
export function sendRaw(addr: { host: string; port: number }, data: Uint8Array, opts: { connectMs?: number; idleMs?: number } = {}): Promise<void> {
  const run = () =>
    new Promise<void>((done, fail) => {
      let settled = false;
      const finish = (e?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        if (e) {
          sock.destroy();
          fail(e);
        } else done();
      };
      const sock = connect({ host: addr.host, port: addr.port });
      const connectTimer = setTimeout(() => finish(new Error('Yazıcıya bağlanılamadı (zaman aşımı)')), opts.connectMs ?? 3000);
      sock.on('error', (e) => finish(e));
      sock.on('connect', () => {
        clearTimeout(connectTimer);
        sock.setTimeout(opts.idleMs ?? 10_000, () => finish(new Error('Yazıcı veriyi almadı (zaman aşımı)')));
        sock.end(data, () => {
          finish();
          // Yazıcı bağlantıyı kendisi kapatmazsa bir süre sonra bırakılır
          setTimeout(() => sock.destroy(), 15_000).unref?.();
        });
      });
    });
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
