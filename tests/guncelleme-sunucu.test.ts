import { mkdirSync, writeFileSync } from 'node:fs';
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
      expect(Object.keys(await r.json())).toEqual(['dayOpen']);
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
