import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePrinters, pickReceiptPrinter, type WinPrinter } from '../server/lib/yazici';
import { type Harness, startApp } from './harness';

/**
 * Fiş yazıcısı (Windows kurulumu): kasa kısayolunun betiği yazıcıları bildirir, LafPOS fişin çıkacağını söyler; tek fiş
 * yazıcısı kendiliğinden seçilir, birden çoksa yönetimden seçilir
 */
const p = (name: string, extra: Partial<WinPrinter> = {}): WinPrinter => ({ name, port: 'USB001', driver: null, isDefault: false, offline: false, ...extra });

describe('fiş yazıcısının seçimi', () => {
  it('PDF, XPS, OneNote ve faks yanında tek gerçek yazıcı kendiliğinden seçilir', () => {
    const list = [p('Microsoft Print to PDF', { port: 'PORTPROMPT:' }), p('Microsoft XPS Document Writer'), p('OneNote (Desktop)'), p('Fax'), p('POS-80C')];
    expect(pickReceiptPrinter(list, null)).toEqual({ name: 'POS-80C', auto: true });
  });

  it('birden çok gerçek yazıcıda adından fiş yazıcısı olduğu anlaşılan tek yazıcı; anlaşılmazsa seçim beklenir', () => {
    expect(pickReceiptPrinter([p('HP LaserJet'), p('XP-80 Thermal')], null)).toEqual({ name: 'XP-80 Thermal', auto: true });
    expect(pickReceiptPrinter([p('HP LaserJet'), p('Canon Ofis')], null)).toEqual({ name: null, auto: false });
  });

  it('seçilen yazıcı bilgisayarda varsa o; söküldüyse kendiliğinden seçime döner', () => {
    const list = [p('HP LaserJet'), p('XP-80 Thermal')];
    expect(pickReceiptPrinter(list, 'HP LaserJet')).toEqual({ name: 'HP LaserJet', auto: false });
    expect(pickReceiptPrinter(list, 'Eski yazıcı')).toEqual({ name: 'XP-80 Thermal', auto: true });
  });

  it('betiğin JSON’u: tek yazıcıda nesne, çokta dizi; adsız ve tekrar eden düşer', () => {
    expect(parsePrinters({ Name: 'POS-80C', PortName: 'USB001', DriverName: 'POS-80C', Default: true, WorkOffline: false })).toEqual([
      { name: 'POS-80C', port: 'USB001', driver: 'POS-80C', isDefault: true, offline: false },
    ]);
    expect(parsePrinters([{ Name: 'A' }, { Name: 'A' }, { PortName: 'x' }, null]).map((x) => x.name)).toEqual(['A']);
    expect(parsePrinters('bozuk')).toEqual([]);
  });

  it('kasa kısayolu Chrome’dan önce yazıcı betiğini çalıştırır; betik yalnız ASCII ve kurulum paketine girer', () => {
    const root = join(__dirname, '..');
    const bat = readFileSync(join(root, 'scripts/kasa/windows/LafPOS-Kasa.bat'), 'utf8');
    expect(bat.indexOf('kasa-yazici.ps1')).toBeGreaterThan(0);
    expect(bat.indexOf('kasa-yazici.ps1')).toBeLessThan(bat.indexOf(':chrome'));
    const ps1 = readFileSync(join(root, 'scripts/kasa/windows/kurulum/kasa-yazici.ps1'), 'latin1');
    expect(/^[\x00-\x7f]*$/.test(ps1)).toBe(true);
    expect(ps1).toContain('/api/kasa/yazicilar');
    expect(ps1).toContain('SetDefaultPrinter');
    expect(readFileSync(join(root, 'scripts/kasa/windows/kurulum/paket.mjs'), 'utf8')).toMatch(/\['kasa-yazici\.ps1', 'kasa-yazici\.ps1'\]/);
  });
});

describe('uçlar', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startApp();
  });
  afterAll(() => h.cleanup());

  async function fromAddr(addr: string | null, body: unknown) {
    const { createApp } = await import('../server/app');
    const env = addr ? { incoming: { socket: { remoteAddress: addr } } } : undefined;
    return createApp().request('/api/kasa/yazicilar', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, env);
  }

  it('bildirim yalnız bu bilgisayardan; yanıtta kendiliğinden seçilen fiş yazıcısı', async () => {
    for (const addr of ['192.168.1.20', '100.101.7.9', null]) expect((await fromAddr(addr, { printers: [] })).status).toBe(403);
    const r = await fromAddr('127.0.0.1', { printers: [{ Name: 'Microsoft Print to PDF', PortName: 'PORTPROMPT:' }, { Name: 'POS-80C', PortName: 'USB001' }] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ name: 'POS-80C' });
  });

  it('yönetim listeyi görür ve seçer; kasa betiği seçileni alır; denetim kaydına düşer', async () => {
    expect((await h.call('garson', 'GET', '/admin/yazici')).status).toBe(403);
    const v = await h.ok<{ printers: { name: string }[]; effective: string | null; auto: boolean; reportedAt: number | null }>('patron', 'GET', '/admin/yazici');
    expect(v).toMatchObject({ effective: 'POS-80C', auto: true, reportedAt: expect.any(Number) });
    expect(v.printers.map((x) => x.name)).toEqual(['Microsoft Print to PDF', 'POS-80C']);
    await fromAddr('127.0.0.1', { printers: [{ Name: 'POS-80C' }, { Name: 'HP LaserJet' }] });
    const chosen = await h.ok<{ chosen: string; effective: string; auto: boolean }>('mudur', 'PUT', '/admin/yazici', { name: 'HP LaserJet' });
    expect(chosen).toMatchObject({ chosen: 'HP LaserJet', effective: 'HP LaserJet', auto: false });
    expect(await (await fromAddr('127.0.0.1', { printers: [{ Name: 'POS-80C' }, { Name: 'HP LaserJet' }] })).json()).toEqual({ name: 'HP LaserJet' });
    const back = await h.ok<{ chosen: string | null; effective: string }>('patron', 'PUT', '/admin/yazici', { name: null });
    expect(back).toMatchObject({ chosen: null, effective: 'POS-80C' });
    const audit = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.some((a) => a.action === 'ayar.yazici')).toBe(true);
  });

  it('boş liste (yazıcı sorgusu zaman aşımı, kurulum) bilinen listeyi ve seçimi silmez', async () => {
    await h.ok('patron', 'PUT', '/admin/yazici', { name: 'HP LaserJet' });
    expect(await (await fromAddr('127.0.0.1', { printers: [] })).json()).toEqual({ name: 'HP LaserJet' });
    const v = await h.ok<{ printers: { name: string }[]; effective: string | null }>('patron', 'GET', '/admin/yazici');
    expect(v.effective).toBe('HP LaserJet');
    expect(v.printers.map((x) => x.name)).toEqual(['POS-80C', 'HP LaserJet']);
  });
});
