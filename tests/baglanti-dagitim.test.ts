import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Anahtar değişimi (docs/03-ENTEGRASYON.md §4b): kasa Uzaktan ve site bağlantısını ladmin'den sorar, değişeni bekletir,
 * gün kapanınca ayarlar dosyasına yazar; kasada tanımlı olmayan bağlantı kendiliğinden açılmaz.
 */

const OLD = 'o'.repeat(40);
const NEW = 'n'.repeat(40);
let h: Harness;
let envFile: string;

const answer = (cloud = NEW, site = NEW) => ({
  ok: true,
  surum: 'abcdef0123456789',
  baglanti: { LAFPOS_CLOUD_URL: 'https://lafpos.laffogato.net', LAFPOS_CLOUD_SECRET: cloud, LAFFOGATO_URL: 'https://laffogato.net', LAFFOGATO_SYNC_SECRET: site },
});

beforeAll(async () => {
  h = await startApp();
  const dir = mkdtempSync(join(tmpdir(), 'lafpos-baglanti-'));
  envFile = join(dir, 'ayarlar.env');
  writeFileSync(envFile, `LAFPOS_CLOUD_URL=https://lafpos.laffogato.net\nLAFPOS_CLOUD_SECRET=${OLD}\n`);
  process.env.LAFPOS_AYAR_DOSYASI = envFile;
  Object.assign(process.env, { LAFPOS_CLOUD_URL: 'https://lafpos.laffogato.net', LAFPOS_CLOUD_SECRET: OLD });
  delete process.env.LAFFOGATO_URL;
  const { env } = await import('../server/env');
  Object.assign(env, { lafmaliyetUrl: 'https://ladmin.laffogato.net', lafmaliyetToken: 'l'.repeat(40) });
});
afterAll(() => {
  delete process.env.LAFPOS_AYAR_DOSYASI;
  h.cleanup();
});

describe('bağlantı farkı (saf)', () => {
  it('yalnız kasada tanımlı bağlantının farklı değeri; çift eksikse yazılmaz; bozuk yanıt yok sayılır', async () => {
    const { dagitimFarki } = await import('../server/sync/baglanti-dagitim');
    const current = { LAFPOS_CLOUD_URL: 'https://lafpos.laffogato.net/', LAFPOS_CLOUD_SECRET: OLD };
    expect(dagitimFarki(answer(), current)).toEqual({ surum: 'abcdef0123456789', edits: { LAFPOS_CLOUD_SECRET: NEW } });
    expect(dagitimFarki(answer(OLD), current)!.edits).toEqual({});
    expect(dagitimFarki({ ...answer(), baglanti: { LAFPOS_CLOUD_URL: 'https://lafpos.laffogato.net' } }, current)!.edits).toEqual({});
    expect(dagitimFarki(answer('kisa'), current)!.edits).toEqual({});
    expect(dagitimFarki({ ok: false }, current)).toBeNull();
  });
});

describe('çekme ve gün kapanınca yazma', () => {
  const fake = (json: unknown, seen?: URL[]) =>
    (async (_secret: string, _method: string, url: URL) => {
      seen?.push(url);
      return { status: 200, json };
    }) as never;

  it('gün açıkken değişen anahtar bekler, dosyaya yazılmaz; gün kapanınca yazılır, denetime düşer', async () => {
    const { pullConnections, applyPendingConnections, bekleyenBaglanti } = await import('../server/sync/baglanti-dagitim');
    const open = await h.call('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect([200, 409]).toContain(open.status);
    const seen: URL[] = [];
    const pending = await pullConnections({ fetchImpl: fake(answer(), seen) });
    expect(seen[0]!.pathname).toBe('/api/panel/pos/baglanti');
    expect(seen[0]!.searchParams.get('sube')).toBe('marina');
    // Site bağlantısı kasada kapalı: açılmaz
    expect(pending).toMatchObject({ edits: { LAFPOS_CLOUD_SECRET: NEW } });
    expect(Object.keys(pending!.edits)).toEqual(['LAFPOS_CLOUD_SECRET']);
    expect(applyPendingConnections()).toBe(false);
    expect(readFileSync(envFile, 'utf8')).toContain(`LAFPOS_CLOUD_SECRET=${OLD}`);

    // Gün kapalı: yazılır
    const { db, schema } = await import('../server/db/client');
    db.update(schema.businessDays).set({ closedAt: Date.now() }).run();
    expect(applyPendingConnections()).toBe(true);
    expect(readFileSync(envFile, 'utf8')).toContain(`LAFPOS_CLOUD_SECRET=${NEW}`);
    expect(bekleyenBaglanti()).toBeNull();
    const rows = db.select().from(schema.auditLog).all();
    expect(rows.some((r) => r.action === 'settings.connections' && r.message.includes('LAFPOS_CLOUD_SECRET') && !r.message.includes(NEW))).toBe(true);
  });

  it('kasa güncelse bekleyen kalmaz, uygulanan sürüm sonraki sorguda söylenir', async () => {
    const { pullConnections } = await import('../server/sync/baglanti-dagitim');
    process.env.LAFPOS_CLOUD_SECRET = NEW;
    expect(await pullConnections({ fetchImpl: fake(answer()) })).toBeNull();
    const seen: URL[] = [];
    await pullConnections({ fetchImpl: fake(answer(), seen) });
    expect(seen[0]!.searchParams.get('uygulanan')).toBe('abcdef0123456789');
  });
});
