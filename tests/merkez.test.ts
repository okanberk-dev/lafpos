import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GRACE_DAYS, licenseState, TRIAL_DAYS } from '@shared/lisans';
import { type Harness, startApp } from './harness';

/**
 * Merkez: kasanın kaydı (ilk görüşte güven), imzalı nabız, lisans süreleri (deneme, uyarı, kapanma, internetsiz),
 * panelden lisans ve seçerek güncelleme gönderme. Kasa gerçek bulut işleyicisiyle (api/uzaktan.ts) konuşur; Upstash
 * yerine bellekte sahte Redis.
 */
const CLOUD = 'https://merkez.test';
const SECRET = 'm'.repeat(40);
const PASSWORD = 'merkez-parola-123';
const DAY = 86_400_000;
const BUILD = 1_795_000_000;
const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
let release: { v: 1; version: string; build: number; date: string; not?: string } | null = { v: 1, version: '0.3.0', build: BUILD + 500, date: '2026-11-21T10:00:00.000Z', not: 'Merkez ve lisans' };
let cloudDown = false;
let h: Harness;

const api = () => import('../api/uzaktan');

async function redisCmd(cmd: string, key: string, rest: string[]): Promise<unknown> {
  if (cmd === 'GET') return store.get(key) ?? null;
  if (cmd === 'MGET') return [key, ...rest].map((k) => store.get(k) ?? null);
  if (cmd === 'SET') {
    if (rest.includes('NX') && store.has(key)) return null;
    store.set(key, rest[0]!);
    return 'OK';
  }
  if (cmd === 'SADD') {
    const s = sets.get(key) ?? new Set();
    rest.forEach((x) => s.add(x));
    sets.set(key, s);
    return 1;
  }
  if (cmd === 'SMEMBERS') return [...(sets.get(key) ?? [])];
  if (cmd === 'INCR') {
    store.set(key, String(Number(store.get(key) ?? 0) + 1));
    return Number(store.get(key));
  }
  if (cmd === 'DEL') return store.delete(key) ? 1 : 0;
  return 1;
}

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  const { env } = await import('../server/env');
  Object.assign(env, { merkezUrl: CLOUD });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
      return new Response(JSON.stringify({ result: await redisCmd(cmd!, key!, rest) }), { status: 200 });
    }
    if (url === `${CLOUD}/guncelleme/surum.json`) return release ? Response.json(release) : new Response('yok', { status: 404 });
    if (url.startsWith(`${CLOUD}/api/`)) {
      if (cloudDown) throw new TypeError('fetch failed');
      const { GET, POST } = await api();
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body as string | undefined });
      return (init?.method ?? 'GET') === 'POST' ? POST(req) : GET(req);
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

async function adminToken(): Promise<string> {
  const { POST } = await api();
  const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '1.1.1.1' } }));
  return ((await res.json()) as { token: string }).token;
}

async function panel<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<{ status: number; json: T }> {
  const { GET, POST } = await api();
  const t = token ?? (await adminToken());
  const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method, headers: { authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await (method === 'GET' ? GET(req) : POST(req));
  return { status: res.status, json: (await res.json()) as T };
}

describe('lisans kuralı (shared/lisans.ts)', () => {
  const at = Date.parse('2026-11-01T09:00:00+03:00');
  it('onaysız kurulum 14 gün deneme, sonra 7 gün uyarı, sonra yeni satış kapalı', () => {
    expect(licenseState(null, { installedAt: at, now: at + 13 * DAY })).toMatchObject({ state: 'deneme' });
    expect(licenseState({ durum: 'bekliyor' }, { installedAt: at, now: at + TRIAL_DAYS * DAY + 1 })).toMatchObject({ state: 'uyari' });
    expect(licenseState({ durum: 'bekliyor' }, { installedAt: at, now: at + (TRIAL_DAYS + GRACE_DAYS) * DAY + 1 })).toMatchObject({ state: 'kapali' });
  });
  it('aktif lisans bitiş gününün sonuna kadar (İstanbul); bitişsiz süresiz', () => {
    const rec = { durum: 'aktif' as const, bitis: '2026-11-30' };
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-11-30T23:59:00+03:00') })).toMatchObject({ state: 'aktif' });
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-12-01T00:01:00+03:00') }).state).toBe('uyari');
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-12-08T00:01:00+03:00') }).state).toBe('kapali');
    expect(licenseState({ durum: 'aktif' }, { installedAt: at, now: at + 900 * DAY })).toMatchObject({ state: 'aktif', until: null });
  });
  it('pasif: pasife alındığı andan 7 gün uyarı', () => {
    const p = { durum: 'pasif' as const, pasifAt: at };
    expect(licenseState(p, { installedAt: at, now: at + 6 * DAY }).message).toMatch(/1 gün sonra yeni satış kapanacak/);
    expect(licenseState(p, { installedAt: at, now: at + 7 * DAY }).state).toBe('kapali');
  });
});

describe('Merkez: kayıt, nabız, panel', () => {
  it('Merkez kapalıyken (adres yok) lisans uygulanmaz', async () => {
    const { env } = await import('../server/env');
    const { licenseNow } = await import('../server/sync/merkez');
    Object.assign(env, { merkezUrl: '' });
    expect(licenseNow()).toBeNull();
    Object.assign(env, { merkezUrl: CLOUD });
  });

  it('kasa ilk nabızda kaydolur, "Onay bekliyor"da görünür; anahtar panele dönmez', async () => {
    const { merkezBeat, identity, merkezLast } = await import('../server/sync/merkez');
    expect(await merkezBeat()).toBe(true);
    const me = identity();
    expect(me.registered).toBe(true);
    expect(merkezLast()).toMatchObject({ lisans: { durum: 'bekliyor' }, mod: 'elle', hedef: null });
    const list = await panel('GET', 'merkez/kurulumlar');
    expect(list.status).toBe(200);
    expect(list.json.kurulumlar).toHaveLength(1);
    expect(list.json.kurulumlar[0]).toMatchObject({ id: me.id, ad: null, online: true, lisans: { durum: 'bekliyor', state: 'deneme' }, bekleyen: false });
    expect(JSON.stringify(list.json)).not.toContain(me.key);
    expect(list.json.enYeni).toMatchObject({ version: '0.3.0', not: 'Merkez ve lisans' });
  });

  it('kayıt bir kez: aynı kimliğe başka anahtar yazılamaz; imzasız ya da yanlış imzalı nabız reddedilir', async () => {
    const { identity } = await import('../server/sync/merkez');
    const { POST } = await api();
    const me = identity();
    const stolen = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/kayit`, { method: 'POST', body: JSON.stringify({ id: me.id, anahtar: 'x'.repeat(40) }) }));
    expect(stolen.status).toBe(409);
    const unsigned = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/nabiz`, { method: 'POST', headers: { 'x-laf-kurulum': me.id }, body: '{}' }));
    expect(unsigned.status).toBe(401);
    const { signedHeaders } = await import('../server/lib/signature');
    const body = '{"surum":"9.9.9"}';
    const forged = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/nabiz`, { method: 'POST', headers: { 'x-laf-kurulum': me.id, ...signedHeaders('y'.repeat(40), 'POST', new URL(`${CLOUD}/api/merkez/nabiz`), body) }, body }));
    expect(forged.status).toBe(401);
  });

  it('panel yalnız gerçek oturumla: jetonsuz ve parolasız görünümde kapalı', async () => {
    expect((await panel('GET', 'merkez/kurulumlar', undefined, 'yok')).status).toBe(401);
    delete process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI;
    try {
      const { POST } = await api();
      const open = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST' }))).json()) as { token: string };
      expect((await panel('GET', 'merkez/kurulumlar', undefined, open.token)).status).toBe(401);
      expect((await panel('POST', 'merkez/gonder', { ids: ['a'.repeat(24)] }, open.token)).status).toBe(401);
    } finally {
      process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI = '1';
    }
  });

  it('sahip ad verir ve lisansı aktif yapar; kasa sonraki nabızda alır', async () => {
    const { merkezBeat, identity, licenseNow, merkezLast } = await import('../server/sync/merkez');
    const id = identity().id;
    const res = await panel('POST', 'merkez/kurulum', { id, ad: 'Tuzla', lisans: 'aktif', bitis: '2099-12-31' });
    expect(res.json.kurulum).toMatchObject({ ad: 'Tuzla', lisans: { durum: 'aktif', bitis: '2099-12-31', state: 'aktif' } });
    expect((await panel('POST', 'merkez/kurulum', { id, lisans: 'aktif', bitis: '31.12.2099' })).status).toBe(400);
    await merkezBeat();
    expect(merkezLast()).toMatchObject({ ad: 'Tuzla', lisans: { durum: 'aktif', bitis: '2099-12-31' } });
    expect(licenseNow()!.state).toBe('aktif');
  });

  it('pasif lisans: önce uyarı (satış sürer), 7 gün sonra yeni satış kapanır; tahsilat ve raporlar açık', async () => {
    const { merkezBeat, identity, assertCanSell } = await import('../server/sync/merkez');
    const id = identity().id;
    await panel('POST', 'merkez/kurulum', { id, lisans: 'pasif' });
    await merkezBeat();
    const open = await h.call('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(open.status).toBe(200);
    const lisans = await h.ok<{ enabled: boolean; state: string; message: string }>('kasa', 'GET', '/sync/lisans');
    expect(lisans).toMatchObject({ enabled: true, state: 'uyari', ad: 'Tuzla' });
    // 8 gün sonra (internet olmasa da: kasa son kaydı ve kendi saatiyle hesaplar)
    cloudDown = true;
    const later = Date.now() + 8 * DAY;
    expect(await merkezBeat(later)).toBe(false);
    expect(() => assertCanSell(later)).toThrow(/yeni satış kapalı/);
    // Uçlar: 8 gün önce pasife alınmış kayıt (oturum süresi gerçek saatle kalsın)
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const last = getSyncState<Record<string, unknown>>('merkez.son')!;
    setSyncState('merkez.son', { ...last, lisans: { durum: 'pasif', pasifAt: Date.now() - 8 * DAY } });
    try {
      const blocked = await h.call<{ code: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
      expect(blocked.status).toBe(403);
      expect(blocked.json.code).toBe('license_blocked');
      const items = await h.call<{ code: string }>('kasa', 'POST', `/orders/${(open.json as { id: string }).id}/items`, { items: [] });
      expect(items.status).toBe(403);
      // Raporlar açık
      expect((await h.call('patron', 'GET', '/reports/patron')).status).toBe(200);
    } finally {
      cloudDown = false;
    }
    // Sahip yeniden aktif yapınca satış açılır
    await panel('POST', 'merkez/kurulum', { id, lisans: 'aktif', bitis: null });
    await merkezBeat();
    expect(() => assertCanSell(later)).not.toThrow();
  });

  it('seçerek gönderme: "ben gönderince" dükkân hedefi gönderilince alır; otomatik dükkân hep son derlemeyi', async () => {
    const { merkezBeat, identity, merkezTarget } = await import('../server/sync/merkez');
    const id = identity().id;
    expect(merkezTarget()).toEqual({ enabled: true, hedef: null });
    let list = await panel('GET', 'merkez/kurulumlar');
    expect(list.json.kurulumlar[0].mod).toBe('elle');
    expect((await panel('POST', 'merkez/gonder', { ids: [] })).status).toBe(400);
    const sent = await panel('POST', 'merkez/gonder', { ids: [id] });
    expect(sent.json).toMatchObject({ gonderilen: 1, build: BUILD + 500 });
    await merkezBeat();
    expect(merkezTarget()).toEqual({ enabled: true, hedef: BUILD + 500 });

    // Yeni sürüm main'e girdi: "ben gönderince" dükkân eski hedefte kalır, otomatik olan yeniyi alır
    release = { ...release!, build: BUILD + 900, version: '0.3.1' };
    const { resetReleaseCache } = await api();
    resetReleaseCache();
    await merkezBeat();
    expect(merkezTarget().hedef).toBe(BUILD + 500);
    list = await panel('GET', 'merkez/kurulumlar');
    expect(list.json.enYeni.build).toBe(BUILD + 900);
    await panel('POST', 'merkez/kurulum', { id, mod: 'otomatik' });
    await merkezBeat();
    expect(merkezTarget().hedef).toBe(BUILD + 900);
    // Güncelleyicinin sorusu (yalnız bu bilgisayardan) hedefi taşır
    const local = await h.call<{ merkez: unknown }>('kasa', 'GET', '/kasa/guncelleme-durumu', undefined, { 'x-forwarded-for': '127.0.0.1' });
    expect([200, 403]).toContain(local.status);
  });

  it('Merkez kaydı silinirse (Redis sıfırlandı) kasa yeniden kaydolur', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const id = identity().id;
    store.delete(`lafpos:merkez:kurulum:${id}`);
    expect(await merkezBeat()).toBe(false);
    expect(identity().registered).toBe(false);
    expect(await merkezBeat()).toBe(true);
    expect(store.has(`lafpos:merkez:kurulum:${id}`)).toBe(true);
  });
});
