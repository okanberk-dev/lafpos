import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';
import { ESKI_ENV_ONEKI as E } from '@shared/eski-adlar';

/**
 * Anahtar değişimi ve bulut yedeği (27 Kasım 2026 incelemesi, bulgu 6; docs/07-UZAKTAN-ERISIM.md §7). Kasa bulut yedeğini
 * Uzaktan anahtarıyla şifreler. Anahtar gün sonunda değişince değişimden önceki bütün yedekler eski değerle şifreli kalır:
 * geri yükleme yalnız şimdiki anahtarları deniyordu, yeni anahtarla kurulan bilgisayar ertesi günün yedeğine dek hiçbir
 * yedeği açamazdı. Artık (1) değişen anahtarın eski değeri ayarlar dosyasında `_ONCEKI` satırında kalır ve geri yükleme onu
 * da dener, (2) anahtar değiştikten sonraki ilk yedek turunda veritabanı yeni anahtarla hemen buluta gider.
 */
const CLOUD = 'https://anahtar-yedek.test';
const ESKI = 'e'.repeat(40);
const YENI = 'y'.repeat(40);
const SUBE_ESKI = 'm'.repeat(40);
const SUBE_YENI = 'n'.repeat(40);

let h: Harness;
/** Bulut yedeğine yüklenen dosyalar (imzalı adrese PUT) */
const yuklenen: Buffer[] = [];

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: YENI, cloudSubeSecret: '', cloudSecretOnceki: '', cloudSubeSecretOnceki: '' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input instanceof Request ? input.url : input));
    if (u.origin === CLOUD && u.pathname === '/api/uzaktan/yedek/yukle') {
      return new Response(JSON.stringify({ ok: true, url: 'https://blob.test/put', pathname: `yedek/dukkan/2026112${yuklenen.length}-230000.lpy` }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (u.origin === 'https://blob.test') {
      yuklenen.push(Buffer.from(init!.body as Uint8Array));
      return new Response('', { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});
beforeEach(async () => {
  yuklenen.length = 0;
  const { env } = await import('../server/env');
  Object.assign(env, { cloudSecret: YENI, cloudSubeSecret: '', cloudSecretOnceki: '', cloudSubeSecretOnceki: '' });
});

describe('ayarlar dosyası: değişen kafe anahtarının eski değeri _ONCEKI satırında kalır', () => {
  it('ortak ve şube anahtarı başka değere geçince (ya da kaldırılınca) eskisi; aynı kalınca, kısa ya da boşken hiçbir şey', async () => {
    const { oncekiSatirlari } = await import('../server/lib/ayar-dosyasi');
    expect(oncekiSatirlari({ [`${E}CLOUD_SECRET`]: ESKI }, { ASILPOS_CLOUD_SECRET: YENI })).toEqual({ ASILPOS_CLOUD_SECRET_ONCEKI: ESKI });
    expect(oncekiSatirlari({ ASILPOS_CLOUD_SECRET: ESKI }, { [`${E}CLOUD_SECRET`]: YENI })).toEqual({ ASILPOS_CLOUD_SECRET_ONCEKI: ESKI });
    expect(oncekiSatirlari({ ASILPOS_CLOUD_SUBE_SECRET: SUBE_ESKI }, { ASILPOS_CLOUD_SUBE_SECRET: null })).toEqual({ ASILPOS_CLOUD_SUBE_SECRET_ONCEKI: SUBE_ESKI });
    expect(oncekiSatirlari({ ASILPOS_CLOUD_SECRET: ESKI }, { ASILPOS_CLOUD_SECRET: ESKI })).toEqual({});
    expect(oncekiSatirlari({ ASILPOS_CLOUD_SECRET: 'kisa' }, { ASILPOS_CLOUD_SECRET: YENI })).toEqual({});
    expect(oncekiSatirlari({}, { ASILPOS_CLOUD_SECRET: YENI })).toEqual({});
    // Başka anahtarlar (site, ladmin) tutulmaz: yedek onlarla şifrelenmez
    expect(oncekiSatirlari({ LAFFOGATO_SYNC_SECRET: ESKI }, { LAFFOGATO_SYNC_SECRET: YENI })).toEqual({});
  });

  it('dosyaya yazarken: eski değer dosyanın adlandırmasıyla (eski önekli dosyada eski adla) önceki satırına', async () => {
    const { writeEnvEdits, readEnvText } = await import('../server/lib/ayar-dosyasi');
    const dir = mkdtempSync(join(tmpdir(), 'asilpos-anahtar-yedek-'));
    const file = join(dir, 'ayarlar.env');
    writeFileSync(file, `${E}CLOUD_URL=${CLOUD}\n${E}CLOUD_SECRET=${ESKI}\n`);
    writeEnvEdits({ path: file, restart: 'elle' }, { ASILPOS_CLOUD_SECRET: YENI });
    expect(readEnvText(readFileSync(file, 'utf8'))).toEqual({ [`${E}CLOUD_URL`]: CLOUD, [`${E}CLOUD_SECRET`]: YENI, [`${E}CLOUD_SECRET_ONCEKI`]: ESKI });
    // İkinci değişimde önceki satır yerinde değişir (yalnız bir önceki)
    writeEnvEdits({ path: file, restart: 'elle' }, { ASILPOS_CLOUD_SECRET: 'z'.repeat(40) });
    expect(readEnvText(readFileSync(file, 'utf8'))).toEqual({ [`${E}CLOUD_URL`]: CLOUD, [`${E}CLOUD_SECRET`]: 'z'.repeat(40), [`${E}CLOUD_SECRET_ONCEKI`]: YENI });
    // Ayarlar okunurken iki adla da (sunucu)
    const { configFrom } = await import('../server/env-config');
    expect(configFrom({ [`${E}CLOUD_SECRET_ONCEKI`]: YENI }).cloudSecretOnceki).toBe(YENI);
    expect(configFrom({ ASILPOS_CLOUD_SUBE_SECRET_ONCEKI: SUBE_ESKI }).cloudSubeSecretOnceki).toBe(SUBE_ESKI);
  });
});

describe('geri yükleme: değişimden önce alınmış yedek de açılır', () => {
  const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100, 7)]);

  it('ortak anahtarın eski değeriyle şifreli yedek: _ONCEKI varken açılır, yokken "başka bir anahtarla"', async () => {
    const y = await import('../server/sync/yedek');
    const { yedekCozmeAnahtarlari } = await import('../server/lib/kafe-anahtari');
    const { env } = await import('../server/env');
    const eski = await y.sealBackupAsync(db, ESKI);
    expect(() => y.openBackupAny(eski, yedekCozmeAnahtarlari())).toThrow(/başka bir anahtarla/);
    env.cloudSecretOnceki = ESKI;
    expect(y.openBackupAny(eski, yedekCozmeAnahtarlari()).equals(db)).toBe(true);
    // Yeni anahtarla alınan yedek önce denenir
    expect(yedekCozmeAnahtarlari()[0]).toBe(YENI);
    expect(y.openBackupAny(await y.sealBackupAsync(db, YENI), yedekCozmeAnahtarlari()).equals(db)).toBe(true);
  });

  it('şube anahtarının eski değeriyle şifreli yedek de', async () => {
    const y = await import('../server/sync/yedek');
    const { yedekCozmeAnahtarlari } = await import('../server/lib/kafe-anahtari');
    const { env } = await import('../server/env');
    Object.assign(env, { cloudSubeSecret: SUBE_YENI, cloudSubeSecretOnceki: SUBE_ESKI });
    const eski = await y.sealBackupAsync(db, SUBE_ESKI);
    expect(y.openBackupAny(eski, yedekCozmeAnahtarlari()).equals(db)).toBe(true);
    expect(yedekCozmeAnahtarlari().slice(0, 2)).toEqual([SUBE_YENI, YENI]);
  });
});

describe('anahtar değiştikten sonra yeni anahtarla hemen bir yedek', () => {
  /** Yarım saatlik yeniden deneme aralığını atlamak için her çağrıda ileri alınan an */
  let an = Date.now() + 24 * 3600_000;
  const sonraki = () => (an += 31 * 60_000);
  const GUN = '2026-11-27';

  async function gunlukDosya(): Promise<string> {
    const { backupNamed } = await import('../server/jobs');
    return backupNamed('test-gunluk');
  }

  it('bugünün yedeği eski anahtarla yüklendiyse veritabanının şimdiki hâli yeni anahtarla yüklenir; anlık kopya silinir', async () => {
    const y = await import('../server/sync/yedek');
    const { setSyncState } = await import('../server/lib/settings');
    const { yedekAnahtarIzi } = await import('../server/lib/kafe-anahtari');
    const { backupNamed } = await import('../server/jobs');
    const { env } = await import('../server/env');
    const file = await gunlukDosya();
    // Günün yedeği gün içinde eski anahtarla gitti; gün sonunda ladmin'in yeni değeri yazıldı, sunucu yeni anahtarla açıldı
    setSyncState('yedek.bulut', { lastDay: GUN, lastKey: yedekAnahtarIzi(ESKI), lastAt: 1, lastName: 'x', lastSize: 1, lastError: null });
    const kopyalar: string[] = [];
    y.afterDailyBackup(file, GUN, sonraki(), async () => {
      const f = await backupNamed('anahtar-degisimi');
      kopyalar.push(f);
      return f;
    });
    await vi.waitFor(() => expect(y.cloudBackupState().lastKey).toBe(yedekAnahtarIzi(YENI)));
    expect(yuklenen).toHaveLength(1);
    expect(y.openBackup(yuklenen[0]!, YENI).subarray(0, 16).toString('latin1')).toBe('SQLite format 3\0');
    expect(() => y.openBackup(yuklenen[0]!, ESKI)).toThrow(/başka bir anahtarla/);
    expect(y.cloudBackupState().lastDay).toBe(GUN);
    expect(kopyalar).toHaveLength(1);
    await vi.waitFor(() => expect(existsSync(kopyalar[0]!)).toBe(false));
    expect(readdirSync(resolve(env.dataDir, 'backups')).some((f) => f.includes('anahtar-degisimi'))).toBe(false);

    // Aynı gün, aynı anahtar: yeniden yüklenmez
    y.afterDailyBackup(file, GUN, sonraki(), async () => backupNamed('anahtar-degisimi'));
    await new Promise((r) => setTimeout(r, 50));
    expect(yuklenen).toHaveLength(1);
  });

  it('iz yoksa (bu sürümden önceki kayıt) bilinmiyor: aynı gün yeniden yüklenmez; yeni günde her zamanki gibi', async () => {
    const y = await import('../server/sync/yedek');
    const { setSyncState } = await import('../server/lib/settings');
    const { yedekAnahtarIzi } = await import('../server/lib/kafe-anahtari');
    const file = await gunlukDosya();
    setSyncState('yedek.bulut', { lastDay: GUN, lastAt: 1, lastName: 'x', lastSize: 1, lastError: null });
    expect(y.yedekAnahtariDegisti()).toBe(false);
    y.afterDailyBackup(file, GUN, sonraki(), async () => {
      throw new Error('kopya alınmamalı');
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(yuklenen).toHaveLength(0);
    y.afterDailyBackup(file, '2026-11-28', sonraki());
    await vi.waitFor(() => expect(y.cloudBackupState().lastDay).toBe('2026-11-28'));
    expect(yuklenen).toHaveLength(1);
    expect(y.cloudBackupState().lastKey).toBe(yedekAnahtarIzi(YENI));
  });

  it('yükleme gidemezse iz eski kalır, sonraki turda yeniden denenir', async () => {
    const y = await import('../server/sync/yedek');
    const { setSyncState } = await import('../server/lib/settings');
    const { yedekAnahtarIzi } = await import('../server/lib/kafe-anahtari');
    const { backupNamed } = await import('../server/jobs');
    const file = await gunlukDosya();
    setSyncState('yedek.bulut', { lastDay: GUN, lastKey: yedekAnahtarIzi(ESKI), lastAt: 1, lastName: 'x', lastSize: 1, lastError: null });
    let ilk = true;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(String(input instanceof Request ? input.url : input));
      // Uzaktan yeni anahtarı henüz tanımıyor (27 Kasım'daki gibi): ilk tur 401
      if (u.pathname === '/api/uzaktan/yedek/yukle') {
        if (ilk) {
          ilk = false;
          return new Response(JSON.stringify({ error: 'İmza geçersiz', code: 'bad_signature' }), { status: 401, headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ ok: true, url: 'https://blob.test/put', pathname: 'yedek/dukkan/20261127-235900.lpy' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      yuklenen.push(Buffer.from(init!.body as Uint8Array));
      return new Response('', { status: 200 });
    });
    y.afterDailyBackup(file, GUN, sonraki(), () => backupNamed('anahtar-degisimi'));
    await vi.waitFor(() => expect(y.cloudBackupState().lastError).toBeTruthy());
    expect(y.cloudBackupState().lastKey).toBe(yedekAnahtarIzi(ESKI));
    y.afterDailyBackup(file, GUN, sonraki(), () => backupNamed('anahtar-degisimi'));
    await vi.waitFor(() => expect(y.cloudBackupState().lastKey).toBe(yedekAnahtarIzi(YENI)));
    expect(yuklenen).toHaveLength(1);
  });
});
