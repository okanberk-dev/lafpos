import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import { upstashFetch } from './fake-upstash';

/**
 * Uzaktan görünüm dükkân bazında (api/uzaktan.ts): kasa `x-laf-dukkan` ile iter, görünüm seçili dükkânı okur; Merkez'e
 * bağlı olmayan eski kasanın `default` özeti eski anahtarda okunmaya devam eder.
 */
const CLOUD = 'https://lafpos.vercel.app';
const SECRET = 'd'.repeat(40);
const PASSWORD = 'dukkan-parola-123';
const store = new Map<string, string>();
const KEYS = ['LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_PAROLA', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA'];
const before: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) before[k] = process.env[k];
  delete process.env.LAFPOS_UYE_EPOSTA;
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  const redis = upstashFetch(store);
  vi.stubGlobal('fetch', async (_i: string, init?: RequestInit) => redis(init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
});

const api = () => import('../api/uzaktan');
const snap = (name: string, at: number) => ({ at, bootstrap: { settings: { businessName: name } }, patron: {}, floor: {}, kitchen: [], board: {}, orders: {} });

async function push(shop: string | null, s: object) {
  const { POST } = await api();
  const body = JSON.stringify({ gz: gzipSync(JSON.stringify(s)).toString('base64') });
  const headers = { ...signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/uzaktan/push`), body), ...(shop ? { 'x-laf-dukkan': shop } : {}) };
  return POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/push`, { method: 'POST', body, headers }));
}

async function view(path: string, shop?: string) {
  const { GET, POST } = await api();
  const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '2.2.2.2' } }))).json()) as { token: string };
  const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { headers: { authorization: `Bearer ${token}`, ...(shop ? { 'x-laf-dukkan': shop } : {}) } }));
  return (await res.json()) as any;
}

describe('dükkân bazında uzaktan görünüm', () => {
  it('eski kasa (başlıksız) default anahtarına yazar ve okunur', async () => {
    expect((await push(null, snap('Eski', 1000))).status).toBe(200);
    expect(store.has('lafpos:snapshot')).toBe(true);
    expect((await view('bootstrap')).settings.businessName).toBe('Eski');
  });

  it('iki dükkân ayrı anahtarda; seçilen dükkân okunur, seçilmezse en son veri gönderen', async () => {
    const A = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    const B = 'f1e2d3c4b5a6f7e8d9c0b1a2';
    store.set(`lafpos:merkez:kurulum:${A}`, JSON.stringify({ ad: 'Tuzla' }));
    await push(A, snap('Tuzla', 2000));
    await push(B, snap('Marina', 3000));
    expect((await view('bootstrap', A)).settings.businessName).toBe('Tuzla');
    expect((await view('bootstrap', B)).settings.businessName).toBe('Marina');
    expect((await view('bootstrap')).settings.businessName).toBeTruthy();
    const list = (await view('uzaktan/dukkanlar')) as { id: string; ad: string | null }[];
    expect(list.map((s) => s.id).sort()).toEqual(['default', A, B].sort());
    expect(list.find((s) => s.id === A)!.ad).toBe('Tuzla');
    // Liste anahtar ya da kurulum bilgisi taşımaz
    expect(Object.keys(list[0]!).sort()).toEqual(['ad', 'at', 'id']);
  });

  it('dükkânın eski özeti yenisini ezmez; geçersiz başlık default sayılır', async () => {
    const A = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    expect(await (await push(A, snap('Tuzla eski', 1500))).json()).toMatchObject({ stale: true });
    await push('GECERSIZ!', snap('Default yeni', 5000));
    expect((await view('bootstrap', 'default')).settings.businessName).toBe('Default yeni');
  });
});

describe('kasa: dükkân kimliği', () => {
  it('Merkez kapalıyken default, açıkken kurulum kimliği; kimlik değişince rapor geçmişi baştan gider', async () => {
    const { startApp } = await import('./harness');
    const h = await startApp();
    try {
      const { env } = await import('../server/env');
      const { remoteShop, identity } = await import('../server/sync/merkez');
      const { getSyncState, setSyncState } = await import('../server/lib/settings');
      expect(remoteShop()).toBe('default');
      setSyncState('cloud.reports', { sent: { '2026-11-01': 'x' }, queue: [], cursor: null, sweptAt: 5 });
      Object.assign(env, { merkezUrl: 'https://merkez.test', cloudUrl: 'https://merkez.test', cloudSecret: SECRET });
      expect(remoteShop()).toBe(identity().id);
      const { pendingReportDays } = await import('../server/sync/cloud-reports');
      // Eski durum default dükkânındı: yeni kimlikte boş durumla başlar (kuyrukta bir şey yok, tarama baştan)
      expect(pendingReportDays()).toBe(0);
      expect(getSyncState<{ sent: object }>('cloud.reports')!.sent).toEqual({ '2026-11-01': 'x' });
      Object.assign(env, { merkezUrl: '', cloudUrl: '', cloudSecret: '' });
    } finally {
      h.cleanup();
    }
  });
});
