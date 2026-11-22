import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Sunucunun güncelleyiciye (bekçi, scripts/kasa/windows/kurulum/guncelle.mjs) iki yanıtı ve Ayarlar ve yedek'teki
 * sürüm kartının verisi: /api/health derleme numarası, açık gün sorusu yalnız bu bilgisayardan, durum dosyası salt
 * okunur ve yalnız ayar yetkisiyle
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

async function fromAddr(addr: string | null, path: string) {
  const { createApp } = await import('../server/app');
  const env = addr ? { incoming: { socket: { remoteAddress: addr } } } : undefined;
  return createApp().request(`/api${path}`, {}, env);
}

describe('güncelleyicinin soruları', () => {
  it('/api/health oturumsuz; derleme numarası alanı var (git ile çalışan sunucuda null)', async () => {
    const r = await h.call<{ ok: boolean; build: number | null }>('', 'GET', '/health');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    expect('build' in r.json).toBe(true);
  });

  it('açık gün sorusu yalnız bu bilgisayardan; yerel ağ ve Tailscale 403', async () => {
    for (const addr of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      const r = await fromAddr(addr, '/kasa/guncelleme-durumu');
      expect(r.status).toBe(200);
      // Yalnız açık gün, Merkez'in hedefi (Merkez kapalı: hedef yok) ve satış/ödeme sürüyor mu; başka bir şey dönmez
      expect(await r.json()).toEqual({ dayOpen: expect.any(Boolean), merkez: { enabled: false, hedef: null }, mesgul: expect.any(Boolean) });
    }
    for (const addr of ['192.168.1.20', '100.101.7.9', null]) expect((await fromAddr(addr, '/kasa/guncelleme-durumu')).status).toBe(403);
  });

  it('gün açılınca "açık gün var" der', async () => {
    const before = (await (await fromAddr('127.0.0.1', '/kasa/guncelleme-durumu')).json()) as { dayOpen: boolean };
    if (!before.dayOpen) await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const after = (await (await fromAddr('127.0.0.1', '/kasa/guncelleme-durumu')).json()) as { dayOpen: boolean };
    expect(after.dayOpen).toBe(true);
  });
});

describe('Ayarlar ve yedek › Sürüm ve güncelleme', () => {
  it('durum dosyası yokken yalnız sürüm; varsa okunan alanlar, beklenmeyen değer düşer', async () => {
    const empty = await h.ok<{ installed: { version: string }; status: unknown }>('patron', 'GET', '/admin/guncelleme');
    expect(empty.installed.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(empty.status).toBeNull();
    const dir = join(process.env.LAFPOS_DATA_DIR!, 'guncelleme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'durum.json'),
      JSON.stringify({ durum: 'bekliyor', mesaj: 'Yeni sürüm hazır', yeni: { surum: '0.2.0', build: 1795100000 }, sonBasariliKontrol: '2026-11-21T03:00:00.000Z', gizli: 'x', basarisiz: [1] }),
    );
    const full = await h.ok<{ status: Record<string, unknown> }>('patron', 'GET', '/admin/guncelleme');
    expect(full.status).toMatchObject({ durum: 'bekliyor', mesaj: 'Yeni sürüm hazır', yeni: { surum: '0.2.0', build: 1795100000 } });
    expect(full.status).not.toHaveProperty('gizli');
    writeFileSync(join(dir, 'durum.json'), JSON.stringify({ durum: 'uydurma' }));
    expect((await h.ok<{ status: unknown }>('patron', 'GET', '/admin/guncelleme')).status).toBeNull();
  });

  it('garson göremez', async () => {
    expect((await h.call('garson', 'GET', '/admin/guncelleme')).status).toBe(403);
  });
});

describe('Ayarlar ve yedek › Şimdi güncelle', () => {
  const file = () => join(process.env.LAFPOS_DATA_DIR!, 'guncelleme', 'istek.json');
  afterAll(() => {
    delete process.env.LAFPOS_STDIN_CONTROL;
  });

  it('Windows kurulumu (bekçi) değilse 409; istek dosyası yazılmaz', async () => {
    delete process.env.LAFPOS_STDIN_CONTROL;
    const r = await h.call<{ code: string }>('patron', 'POST', '/admin/guncelleme', {});
    expect(r).toMatchObject({ status: 409, json: { code: 'not_installed' } });
    expect(existsSync(file())).toBe(false);
    expect((await h.ok<{ canRequest: boolean }>('patron', 'GET', '/admin/guncelleme')).canRequest).toBe(false);
  });

  it('bekçi altında istek dosyası yazılır, bekçi alana dek ekranda bekler; denetim kaydına düşer', async () => {
    process.env.LAFPOS_STDIN_CONTROL = '1';
    expect((await h.call('garson', 'POST', '/admin/guncelleme', {})).status).toBe(403);
    const r = await h.ok<{ canRequest: boolean; request: { simdi: boolean } | null }>('mudur', 'POST', '/admin/guncelleme', {});
    expect(r.canRequest).toBe(true);
    expect(r.request).toMatchObject({ simdi: false });
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ simdi: false, at: expect.any(Number) });
    const audit = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.some((a) => a.action === 'guncelleme')).toBe(true);
    // Bekçi aldı (dosyayı sildi): istek ekrandan kalkar
    rmSync(file());
    expect((await h.ok<{ request: unknown }>('patron', 'GET', '/admin/guncelleme')).request).toBeNull();
  });

  it('gün açıkken hemen kurmayı yalnız patron seçer; gün kapalıyken "şimdi" ayrıca işaretlenmez', async () => {
    process.env.LAFPOS_STDIN_CONTROL = '1';
    const s = await h.ok<{ dayOpen: boolean }>('patron', 'GET', '/admin/guncelleme');
    if (!s.dayOpen) await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect(await h.call('mudur', 'POST', '/admin/guncelleme', { simdi: true })).toMatchObject({ status: 403, json: { code: 'patron_only' } });
    const r = await h.ok<{ request: { simdi: boolean }; dayOpen: boolean }>('patron', 'POST', '/admin/guncelleme', { simdi: true });
    expect(r).toMatchObject({ dayOpen: true, request: { simdi: true } });
  });
});

describe('Kasadaki güncelleme teklifi: Şimdi güncelle / Gün sonunda güncelle', () => {
  const dir = () => join(process.env.LAFPOS_DATA_DIR!, 'guncelleme');
  const file = () => join(dir(), 'istek.json');
  const ready = () => {
    mkdirSync(dir(), { recursive: true });
    writeFileSync(join(dir(), 'durum.json'), JSON.stringify({ durum: 'bekliyor', mesaj: 'Yeni sürüm hazır', yeni: { surum: '0.2.1', build: 1795200000 } }));
    if (existsSync(file())) rmSync(file());
  };
  afterAll(() => {
    delete process.env.LAFPOS_STDIN_CONTROL;
  });

  it('kasayı yöneten görür; garson göremez. Gün sonunda: seçim saklanır, istek dosyası yazılmaz', async () => {
    process.env.LAFPOS_STDIN_CONTROL = '1';
    ready();
    expect((await h.call('garson', 'GET', '/admin/guncelleme/teklif')).status).toBe(403);
    const offer = await h.ok<{ yeni: { build: number }; secim: string | null; canRequest: boolean }>('kasa', 'GET', '/admin/guncelleme/teklif');
    expect(offer).toMatchObject({ yeni: { build: 1795200000 }, secim: null, canRequest: true });
    const after = await h.ok<{ secim: string }>('kasa', 'POST', '/admin/guncelleme/secim', { secim: 'gunsonu' });
    expect(after.secim).toBe('gunsonu');
    expect(existsSync(file())).toBe(false);
    // Yeni bir sürüm gelince seçim yeniden sorulur
    writeFileSync(join(dir(), 'durum.json'), JSON.stringify({ durum: 'bekliyor', mesaj: 'Yeni sürüm hazır', yeni: { surum: '0.2.2', build: 1795300000 } }));
    expect((await h.ok<{ secim: string | null }>('kasa', 'GET', '/admin/guncelleme/teklif')).secim).toBeNull();
  });

  it('Şimdi: satış ya da ödeme sürerken reddedilir (409 busy); kasa boşken gün açıkken de hemen kurma isteği yazılır', async () => {
    process.env.LAFPOS_STDIN_CONTROL = '1';
    ready();
    const { resetActivity, QUIET_MS } = await import('../server/lib/mesgul');
    const s = await h.ok<{ dayOpen: boolean }>('patron', 'GET', '/admin/guncelleme');
    if (!s.dayOpen) await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    // Az önce bir satış yazması oldu: kasa meşgul
    await h.call('kasa', 'POST', '/orders', {});
    expect(QUIET_MS).toBeGreaterThan(0);
    expect(await h.call('kasa', 'POST', '/admin/guncelleme/secim', { secim: 'simdi' })).toMatchObject({ status: 409, json: { code: 'busy' } });
    expect(existsSync(file())).toBe(false);
    resetActivity();
    const ok = await h.ok<{ secim: string }>('kasa', 'POST', '/admin/guncelleme/secim', { secim: 'simdi' });
    expect(ok.secim).toBe('simdi');
    expect(JSON.parse(readFileSync(file(), 'utf8'))).toMatchObject({ simdi: true });
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=5');
    expect(audit.some((a) => a.action === 'guncelleme' && a.message.includes('şimdi kurulacak'))).toBe(true);
  });
});
