import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Kasa penceresinin bakım arası (server/lib/kasa-bakim.ts): kasa bekçisi kapatılan kasa penceresini 15 sn içinde yeniden
 * açar (#144). Yönetim › Ağ ve uzaktan erişim › Bu bilgisayar'dan 15 dakikalık ara verilir; bekçi bu sürede açmaz, süre
 * bitince ya da "Bitir"le yine açar. Yalnız ayar yetkisi, yalnız Windows kurulumu; bekçinin sorusu yalnız bu bilgisayardan.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => {
  delete process.env.ASILPOS_STDIN_CONTROL;
  h.cleanup();
});

async function fromAddr(addr: string | null) {
  const { createApp } = await import('../server/app');
  const env = addr ? { incoming: { socket: { remoteAddress: addr } } } : undefined;
  return createApp().request('/api/kasa/bakim', {}, env);
}

describe('kasa penceresinin bakım arası', () => {
  it('bekçinin sorusu yalnız bu bilgisayardan; ara yokken active false', async () => {
    const r = await fromAddr('127.0.0.1');
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ until: null, active: false });
    for (const addr of ['192.168.1.20', '100.101.7.9', null]) expect((await fromAddr(addr)).status).toBe(403);
  });

  it('yalnız ayar yetkisi ve Windows kurulumu; 15 dakika, Bitir hemen; denetim kaydına yazılır', async () => {
    expect((await h.call('kasa', 'POST', '/admin/kasa-bakim', { on: true })).status).toBe(403);
    delete process.env.ASILPOS_STDIN_CONTROL;
    expect((await h.call<{ code: string }>('patron', 'POST', '/admin/kasa-bakim', { on: true })).json).toMatchObject({ code: 'not_installed' });

    process.env.ASILPOS_STDIN_CONTROL = '1';
    const t0 = Date.now();
    const on = await h.ok<{ kasaBakim: number }>('mudur', 'POST', '/admin/kasa-bakim', { on: true });
    expect(on.kasaBakim).toBeGreaterThanOrEqual(t0 + 15 * 60_000);
    expect(on.kasaBakim).toBeLessThan(t0 + 15 * 60_000 + 5_000);
    expect(await (await fromAddr('127.0.0.1')).json()).toEqual({ until: on.kasaBakim, active: true });
    // Ağ ekranı bekçiyi ve süren arayı gösterir
    expect(await h.ok('mudur', 'GET', '/admin/network')).toMatchObject({ bekci: true, kasaBakim: on.kasaBakim });

    const off = await h.ok<{ kasaBakim: number | null }>('mudur', 'POST', '/admin/kasa-bakim', { on: false });
    expect(off.kasaBakim).toBeNull();
    expect(await (await fromAddr('127.0.0.1')).json()).toMatchObject({ active: false });

    const audits = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audits.filter((a) => a.action === 'kasa.bakim').map((a) => a.message)).toEqual([
      'Kasa penceresinin bakım arası bitirildi',
      'Kasa penceresine 15 dakikalık bakım arası verildi (bekçi bu sürede yeniden açmaz)',
    ]);
  });

  it('süre bitince ara kendiliğinden biter', async () => {
    const { kasaBakim, setKasaBakim, KASA_BAKIM_MS } = await import('../server/lib/kasa-bakim');
    const now = Date.now();
    setKasaBakim(true, 'test', now);
    expect(kasaBakim(now + KASA_BAKIM_MS - 1)).not.toBeNull();
    expect(kasaBakim(now + KASA_BAKIM_MS)).toBeNull();
    setKasaBakim(false, 'test');
  });

  it('bekçi arayı sorar: süren arada kasa penceresini açmaz, soru düşerse açık tutar', () => {
    const ps1 = readFileSync('scripts/kasa/windows/kurulum/kasa-yazici.ps1', 'utf8');
    const fn = ps1.slice(ps1.indexOf('function Test-KasaBakim'), ps1.indexOf('function Test-Server'));
    expect(fn).toContain("'/api/kasa/bakim'");
    expect(fn).toContain('.active');
    expect(fn).toMatch(/catch \{ return \$false \}/);
    // Bekçi yalnız kısayolun açma isteğiyle açar (28 Kas 2026); bakım arasında istek olsa da açmaz
    expect(ps1).toContain('if ($tur -gt 0 -and (Test-KasaAcIstegi) -and -not (Test-KasaWindow) -and -not (Test-KasaBakim $displayBase) -and (Test-Server $displayBase)) {');
    // Kasa kısayolunun kendi açışı (-KasaAc) aradan etkilenmez: kullanıcı kasayı açmak istiyor
    const kasaAc = ps1.slice(ps1.indexOf('if ($KasaAc) {'), ps1.indexOf('if ($Bekci) {'));
    expect(kasaAc).not.toContain('Test-KasaBakim');
  });
});
