import { createServer, type Server } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { escposRaster, printerAddress, sendRaw } from '../server/lib/escpos';
import { type Harness, startApp } from './harness';

type PrintVia = <T>(opts: { sheet: boolean; enabled: boolean; direct: () => Promise<void>; browser: () => T }) => Promise<{ how: 'direct' } | { how: 'browser'; result: T }>;
/** Arayüz modülü (tsconfig'te JSX yok: fis.test.ts gibi çalışma anında yüklenir) */
const PRINT = '../src/lib/print';
const print = () => import(/* @vite-ignore */ PRINT) as Promise<{ packBits: (rgba: Uint8ClampedArray, w: number, h: number) => Uint8Array; printVia: PrintVia }>;

/**
 * Fişi yazdırma penceresi açmadan basmak: arayüz fişi 1 bitlik görüntüye çevirir, sunucu ESC/POS raster ve kesme ile
 * ağdaki fiş yazıcısına (IP:9100) gönderir; olmazsa tarayıcıdan basılır (fiş kaybolmaz)
 */
describe('ESC/POS kodlayıcı', () => {
  it('sıfırla, 256 satırlık bantlarda GS v 0, sonunda bıçağa ilerletip kes', () => {
    const width = 576;
    const height = 300;
    const bits = new Uint8Array((width / 8) * height);
    bits[0] = 0x80;
    bits[bits.length - 1] = 0x01;
    const out = escposRaster({ width, height, bits });
    expect([...out.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    // İlk bant: GS v 0 m=0, x=72 bayt, y=256 satır
    expect([...out.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 0, 1]);
    expect(out[10]).toBe(0x80);
    const second = 10 + 72 * 256;
    expect([...out.subarray(second, second + 8)]).toEqual([0x1d, 0x76, 0x30, 0x00, 72, 0, 44, 0]);
    expect([...out.subarray(out.length - 4)]).toEqual([0x1d, 0x56, 0x41, 0x00]);
    expect(out[out.length - 5]).toBe(0x01);
    expect(out.length).toBe(2 + 8 * 2 + bits.length + 4);
  });

  it('boyu tutmayan ya da 8’in katı olmayan görüntü reddedilir', () => {
    expect(() => escposRaster({ width: 576, height: 2, bits: new Uint8Array(72) })).toThrow();
    expect(() => escposRaster({ width: 570, height: 1, bits: new Uint8Array(72) })).toThrow();
  });

  it('yazıcının adresi Windows port adından; yerel portta yok', () => {
    expect(printerAddress('192.168.1.249')).toEqual({ host: '192.168.1.249', port: 9100 });
    expect(printerAddress('IP_192.168.1.249')).toEqual({ host: '192.168.1.249', port: 9100 });
    expect(printerAddress('192.168.1.249_1')).toEqual({ host: '192.168.1.249', port: 9100 });
    expect(printerAddress('10.0.0.5:9101')).toEqual({ host: '10.0.0.5', port: 9101 });
    expect(printerAddress('USB001')).toBeNull();
    expect(printerAddress('PORTPROMPT:')).toBeNull();
    expect(printerAddress(null)).toBeNull();
    expect(printerAddress('192.168.1.2490')).toBeNull();
  });

  it('görüntü 1 bite: koyu nokta siyah, açık ve saydam beyaz', async () => {
    const { packBits } = await print();
    const w = 16;
    const rgba = new Uint8ClampedArray(w * 4).fill(255);
    const set = (x: number, v: number, a = 255) => rgba.set([v, v, v, a], x * 4);
    set(0, 0);
    set(9, 40);
    set(3, 200);
    set(5, 0, 0);
    expect([...packBits(rgba, w, 1)]).toEqual([0x80, 0x40]);
  });
});

describe('doğrudan ya da tarayıcıdan', () => {
  it('doğrudan basılamazsa tarayıcıdan basılır; A4 sayfa ve kapalı ayar hep tarayıcıdan', async () => {
    const { printVia } = await print();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const browser = vi.fn(() => 'b');
    const ok = vi.fn(async () => undefined);
    const fails = vi.fn(async () => {
      throw new Error('502');
    });
    expect(await printVia({ sheet: false, enabled: true, direct: ok, browser })).toEqual({ how: 'direct' });
    expect(browser).not.toHaveBeenCalled();
    expect(await printVia({ sheet: false, enabled: true, direct: fails, browser })).toEqual({ how: 'browser', result: 'b' });
    expect(browser).toHaveBeenCalledTimes(1);
    ok.mockClear();
    expect((await printVia({ sheet: true, enabled: true, direct: ok, browser })).how).toBe('browser');
    expect((await printVia({ sheet: false, enabled: false, direct: ok, browser })).how).toBe('browser');
    expect(ok).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('uç: POST /api/kasa/fis', () => {
  let h: Harness;
  let fake: Server;
  let fakePort = 0;
  const received: Buffer[] = [];
  beforeAll(async () => {
    h = await startApp();
    fake = createServer((sock) => {
      const chunks: Buffer[] = [];
      sock.on('data', (d) => chunks.push(d));
      sock.on('end', () => {
        received.push(Buffer.concat(chunks));
        sock.end();
      });
    });
    await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
    fakePort = (fake.address() as { port: number }).port;
  });
  afterAll(async () => {
    await new Promise((r) => fake.close(r));
    h.cleanup();
  });

  async function req(path: string, opts: { who?: string; addr?: string | null; body: unknown }) {
    const { createApp } = await import('../server/app');
    const env = opts.addr ? { incoming: { socket: { remoteAddress: opts.addr } } } : undefined;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (opts.who) headers.authorization = `Bearer ${h.tokens[opts.who]}`;
    return createApp().request(`/api${path}`, { method: 'POST', headers, body: JSON.stringify(opts.body) }, env);
  }
  const report = (printers: unknown[]) => req('/kasa/yazicilar', { addr: '127.0.0.1', body: { printers } });
  const slip = (height = 3) => {
    const bits = new Uint8Array(72 * height);
    bits[0] = 0xff;
    return { width: 576, height, data: Buffer.from(bits).toString('base64') };
  };

  it('seçili yazıcının IP’sine ESC/POS gider; oturum ve yetki gerekir', async () => {
    await report([{ Name: 'KASA', PortName: `IP_127.0.0.1:${fakePort}`, DriverName: 'XP-80C' }, { Name: 'Microsoft Print to PDF', PortName: 'PORTPROMPT:' }]);
    expect((await req('/kasa/fis', { body: slip() })).status).toBe(401);
    // Garsonun ödeme yetkisi yok: başka cihazdan basamaz, kasa bilgisayarından basar
    expect((await req('/kasa/fis', { who: 'garson', addr: '192.168.1.20', body: slip() })).status).toBe(403);
    const r = await req('/kasa/fis', { who: 'garson', addr: '127.0.0.1', body: slip() });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, printer: 'KASA' });
    const r2 = await req('/kasa/fis', { who: 'kasa', addr: '192.168.1.20', body: slip(2) });
    expect(r2.status).toBe(200);
    await vi.waitFor(() => expect(received.length).toBe(2));
    expect([...received[0]!.subarray(0, 10)]).toEqual([0x1b, 0x40, 0x1d, 0x76, 0x30, 0x00, 72, 0, 3, 0]);
    expect(received[0]![10]).toBe(0xff);
    expect([...received[0]!.subarray(-4)]).toEqual([0x1d, 0x56, 0x41, 0x00]);
    expect(received[1]!.length).toBe(2 + 8 + 72 * 2 + 4);
  });

  it('bozuk ya da çok büyük görüntü reddedilir', async () => {
    expect((await req('/kasa/fis', { who: 'kasa', body: { ...slip(3), height: 4 } })).status).toBe(422);
    expect((await req('/kasa/fis', { who: 'kasa', body: { ...slip(), width: 384 } })).status).toBe(422);
    expect((await req('/kasa/fis', { who: 'kasa', body: { width: 576, height: 20000, data: '' } })).status).toBe(422);
  });

  it('düşme: yazıcıya ulaşılamazsa 502, ağ adresi yoksa 409 (arayüz tarayıcıdan basar)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Kapalı port: bağlantı reddedilir
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const deadPort = (closed.address() as { port: number }).port;
    await new Promise((r) => closed.close(r));
    await report([{ Name: 'KASA', PortName: `127.0.0.1:${deadPort}` }]);
    const r = await req('/kasa/fis', { who: 'kasa', body: slip() });
    expect(r.status).toBe(502);
    expect(((await r.json()) as { code: string }).code).toBe('printer_unreachable');
    await report([{ Name: 'KASA', PortName: 'USB001' }]);
    const r2 = await req('/kasa/fis', { who: 'kasa', body: slip() });
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as { code: string }).code).toBe('no_printer_address');
    warn.mockRestore();
  });

  it('bağlantı kurulamazsa zaman aşımıyla biter (yazıcı kapalı ya da ağda yok)', async () => {
    const t0 = Date.now();
    // Yönlendirilemeyen adres: ya hemen reddedilir ya da bağlantı süresi dolar
    await expect(sendRaw({ host: '10.255.255.1', port: 9100 }, new Uint8Array([0x1b, 0x40]), { connectMs: 300 })).rejects.toThrow();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('ayar varsayılan açık ve herkese gider; yönetimden kapatılır', async () => {
    expect(h.boot.settings.receiptDirect).toBe(true);
    await h.ok('patron', 'PUT', '/admin/settings', { receiptDirect: false });
    expect((await h.ok<{ settings: { receiptDirect: boolean } }>('kasa', 'GET', '/bootstrap')).settings.receiptDirect).toBe(false);
  });
});
