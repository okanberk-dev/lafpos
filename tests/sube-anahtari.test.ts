import { createHmac } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import { anahtarImzaMetni, imzaMetni, KOMUT_TURLERI, komutDogrula, type KomutKaydi, KONTROL_SURUM, type KontrolPaneli } from '../shared/kontrol';
import { upstashCommand } from './fake-upstash';
import { type Harness, startApp } from './harness';
import { REDIS_ONEKI } from '@shared/eski-adlar';

/**
 * Şube anahtarı (docs/07-UZAKTAN-ERISIM.md §6): Vercel'de `ASILPOS_CLOUD_SECRET_<ŞUBE>`, kasada Bağlantı bilgileri ›
 * AsilPOS Uzaktan › Şube anahtarı. Kendi anahtarı olan şubenin platform anahtarları, restoranının gelen kutusu ve
 * bağlandığı dükkânın özeti, raporu ve yedeği yalnız bu anahtarla imzalı istekle açılır; ortak anahtarı bilen başka şubenin
 * kasası onlara ulaşamaz. Kendi anahtarı olmayan şube ve başlıksız eski kasa eskisi gibi ortak anahtarla çalışır. Kasa şube
 * anahtarını bulut tanımıyorsa ortak anahtarla yineler (geçişte sıra önemsiz).
 */
const CLOUD = 'https://sube-anahtari.test';
const SHARED = 's'.repeat(40);
const K_M = 'm'.repeat(40);
const K_T = 't'.repeat(40);
const WEBHOOK = 'getir-webhook-anahtari-1234';
const store = new Map<string, string>();
const blobs = new Map<string, Buffer>();

vi.mock('@vercel/blob', () => ({
  issueSignedToken: async (o: { pathname: string }) => ({ delegationToken: `d:${o.pathname}`, clientSigningToken: 'c' }),
  presignUrl: async (_t: unknown, o: { operation: string; pathname: string }) => ({ presignedUrl: `https://blob.test/${o.operation}/${o.pathname}` }),
  list: async (o: { prefix: string; mode?: string }) => {
    const keys = [...blobs.keys()].filter((k) => k.startsWith(o.prefix));
    if (o.mode === 'folded') return { blobs: [], folders: [...new Set(keys.map((k) => `${k.split('/').slice(0, 2).join('/')}/`))], hasMore: false };
    return { blobs: keys.map((k) => ({ pathname: k, size: blobs.get(k)!.length, uploadedAt: new Date(0) })), hasMore: false };
  },
  del: async (keys: string[]) => keys.forEach((k) => blobs.delete(k)),
}));

/** Vercel'deki AsilPOS Uzaktan'ın ortamı: kasanın süreç ortamından ayrı (uç çağrılırken yerine konur) */
let vercel: Record<string, string> = {};
const BASE_ENV = { ASILPOS_CLOUD_SECRET: SHARED, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0', BLOB_READ_WRITE_TOKEN: 'rw', GETIR_WEBHOOK_SECRET: WEBHOOK };
async function asVercel<T>(fn: () => Promise<T> | T): Promise<T> {
  const saved = process.env;
  process.env = { ...BASE_ENV, ...vercel };
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}

type Api = typeof import('../api/uzaktan');
let api: Api;
let h: Harness;
/** Kasadan buluta giden istekler (adres, şube başlığı) */
const sent: { path: string; sube: string | null; status: number }[] = [];

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SHARED, cloudSubeSecret: '' });
  api = await import('../api/uzaktan');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u === 'https://redis.test') return new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[]) }));
    if (new URL(u).origin === CLOUD) {
      const req = new Request(u, init);
      const res = await asVercel(() => (req.method === 'GET' ? api.GET(req) : api.POST(req)));
      sent.push({ path: new URL(u).pathname, sube: req.headers.get('x-laf-sube'), status: res.status });
      return res;
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});
beforeEach(async () => {
  vercel = {};
  sent.length = 0;
  (await import('../server/lib/kafe-anahtari')).kafeAnahtariSifirla();
  const { env } = await import('../server/env');
  env.cloudSubeSecret = '';
});

/** Bulut ucuna doğrudan imzalı istek (kasanın yapacağı gibi): `sube` verilirse başlıkla */
async function cloud(method: 'GET' | 'POST', path: string, key: string, o: { sube?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const url = new URL(`${CLOUD}/api/${path}`);
  const raw = o.body === undefined ? '' : JSON.stringify(o.body);
  const headers: Record<string, string> = { ...(o.headers ?? {}), ...signedHeaders(key, method, url, raw), ...(o.sube ? { 'x-laf-sube': o.sube } : {}), ...(raw ? { 'content-type': 'application/json' } : {}) };
  const req = new Request(url, { method, headers, body: raw || undefined });
  const res = await asVercel(() => (method === 'GET' ? api.GET(req) : api.POST(req)));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe('bulut: şube anahtarının geçerliliği ve imza', () => {
  it('anahtar yok, geçerli ya da geçersiz (kısa, ortakla aynı, başka şubeyle aynı); geçersiz sessizce ortağa düşmez', async () => {
    const { subeAnahtariDurumu } = await import('../api/_kafe');
    const vars = { ASILPOS_CLOUD_SECRET_MARINA: K_M, ASILPOS_CLOUD_SECRET_KISA: 'kisa', ASILPOS_CLOUD_SECRET_ORTAK: SHARED, ASILPOS_CLOUD_SECRET_A: 'a'.repeat(40), ASILPOS_CLOUD_SECRET_B: 'a'.repeat(40) };
    expect(subeAnahtariDurumu('MARINA', SHARED, vars)).toEqual({ durum: 'gecerli', anahtar: K_M });
    expect(subeAnahtariDurumu('TUZLA', SHARED, vars)).toEqual({ durum: 'yok' });
    expect(subeAnahtariDurumu(null, SHARED, vars)).toEqual({ durum: 'yok' });
    expect(subeAnahtariDurumu('KISA', SHARED, vars)).toMatchObject({ durum: 'gecersiz' });
    expect(subeAnahtariDurumu('ORTAK', SHARED, vars)).toMatchObject({ durum: 'gecersiz', neden: expect.stringContaining('ortak') });
    expect(subeAnahtariDurumu('A', SHARED, vars)).toMatchObject({ durum: 'gecersiz', neden: expect.stringContaining('ASILPOS_CLOUD_SECRET_B') });
  });

  it('imza: başlıksız ortak anahtarla; başlıklı istek şubenin kendi anahtarıyla (yoksa ortak); yanlış anahtar 401', async () => {
    const { kafeKimligi } = await import('../api/_kafe');
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    const url = new URL(`${CLOUD}/api/uzaktan/push`);
    const req = (key: string, sube?: string) => ({ method: 'POST', headers: new Headers({ ...signedHeaders(key, 'POST', url, 'x'), ...(sube ? { 'x-laf-sube': sube } : {}) }) });
    const id = (key: string, sube?: string) => asVercel(() => kafeKimligi(req(key, sube), url, 'x', SHARED, api.verifyPush));
    expect(await id(SHARED)).toEqual({ sube: null, kendi: false });
    expect(await id(K_M, 'MARINA')).toEqual({ sube: 'MARINA', kendi: true });
    expect(await id(K_M, 'marina')).toEqual({ sube: 'MARINA', kendi: true });
    // Kendi anahtarı olan şubeyi ortak anahtarla söylemek, başka şubenin anahtarıyla söylemek: 401
    expect(((await id(SHARED, 'MARINA')) as Response).status).toBe(401);
    expect(((await id(K_M, 'TUZLA')) as Response).status).toBe(401);
    // Kendi anahtarı olmayan şube ortak anahtarla (eskisi gibi)
    expect(await id(SHARED, 'TUZLA')).toEqual({ sube: 'TUZLA', kendi: false });
    // Başlıksız istek şube anahtarıyla tutmaz (bulut hangi şubenin olduğunu bilemez)
    expect(((await id(K_M)) as Response).status).toBe(401);
    expect(((await id(K_M, '***')) as Response).status).toBe(400);
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: SHARED };
    const bad = (await id(SHARED, 'MARINA')) as Response;
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { code: string }).code).toBe('branch_key_invalid');
  });

  it('şubeye ait kaynak: kendi anahtarı olan şube yalnız kendi imzasıyla; şube anahtarı başka şubeyi açmaz; şubesiz kaynak herkese', async () => {
    const { subeErisimi } = await import('../api/_kafe');
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    const code = async (kafe: { sube: string | null; kendi: boolean }, hedef: string | null) => {
      const r = await asVercel(() => subeErisimi(kafe, hedef, SHARED));
      return r ? ((await r.json()) as { code: string }).code : 'acik';
    };
    const ortak = { sube: null, kendi: false };
    const marina = { sube: 'MARINA', kendi: true };
    const tuzlaOrtak = { sube: 'TUZLA', kendi: false };
    expect(await code(ortak, null)).toBe('acik');
    expect(await code(marina, null)).toBe('acik');
    expect(await code(ortak, 'MARINA')).toBe('branch_key_required');
    expect(await code(tuzlaOrtak, 'MARINA')).toBe('branch_key_required');
    expect(await code(marina, 'MARINA')).toBe('acik');
    expect(await code(ortak, 'TUZLA')).toBe('acik');
    expect(await code(marina, 'TUZLA')).toBe('other_branch');
  });
});

describe('bulut: platform anahtarları şubenin anahtarıyla', () => {
  beforeEach(() => {
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M, TRENDYOL_MARINA_API_KEY: 'marina-trendyol', TRENDYOL_TUZLA_API_KEY: 'tuzla-trendyol' };
  });

  it('Marina’nınkini yalnız Marina’nın anahtarı alır; Tuzla’nınki (kendi anahtarı yok) ortak anahtarla eskisi gibi', async () => {
    const own = await cloud('GET', 'uzaktan/anahtarlar?sube=marina', K_M, { sube: 'MARINA' });
    expect(own).toEqual({ status: 200, json: { anahtarlar: { TRENDYOL_API_KEY: 'marina-trendyol' } } });
    // Ortak anahtarı bilen (Tuzla'nın kasası, eski kasa): Marina'nınkini alamaz, neden yanıtta
    const shared = await cloud('GET', 'uzaktan/anahtarlar?sube=marina', SHARED);
    expect(shared.status).toBe(403);
    expect(shared.json).toMatchObject({ code: 'branch_key_required', error: expect.stringContaining('ASILPOS_CLOUD_SECRET_MARINA') });
    expect(JSON.stringify(shared.json)).not.toContain('marina-trendyol');
    expect((await cloud('GET', 'uzaktan/anahtarlar?sube=marina', SHARED, { sube: 'TUZLA' })).status).toBe(403);
    // Tuzla ortak anahtarla (eskisi gibi); Marina'nın anahtarı Tuzla'yı açmaz
    expect(await cloud('GET', 'uzaktan/anahtarlar?sube=tuzla', SHARED)).toEqual({ status: 200, json: { anahtarlar: { TRENDYOL_API_KEY: 'tuzla-trendyol' } } });
    expect((await cloud('GET', 'uzaktan/anahtarlar?sube=tuzla', K_M, { sube: 'MARINA' })).json).toMatchObject({ code: 'other_branch' });
  });

  it('hiçbir şubenin anahtarı yoksa her şey eskisi gibi (ortak anahtar, başlıklı ya da başlıksız)', async () => {
    vercel = { TRENDYOL_MARINA_API_KEY: 'marina-trendyol' };
    expect((await cloud('GET', 'uzaktan/anahtarlar?sube=marina', SHARED)).json).toEqual({ anahtarlar: { TRENDYOL_API_KEY: 'marina-trendyol' } });
    expect((await cloud('GET', 'uzaktan/anahtarlar?sube=marina', SHARED, { sube: 'MARINA' })).json).toEqual({ anahtarlar: { TRENDYOL_API_KEY: 'marina-trendyol' } });
  });
});

describe('bulut: paket gelen kutusu restoranın şubesinin anahtarıyla', () => {
  const push = (restaurant: string, id: string) =>
    asVercel(() => api.POST(new Request(`${CLOUD}/api/getir/order`, { method: 'POST', headers: { 'x-api-key': WEBHOOK, 'content-type': 'application/json' }, body: JSON.stringify({ id, restaurant: { id: restaurant } }) })));
  const ids = (r: { json: Record<string, unknown> }) => ((r.json.items as { order: { id: string } }[] | undefined) ?? []).map((i) => i.order.id).sort();

  it('Marina’nın restoranı yalnız Marina’nın anahtarıyla çekilir ve silinir; Tuzla’nınki ortak anahtarla; eski kasa yalnız açık olanları görür', async () => {
    store.clear();
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M, GETIR_MARINA_RESTAURANT_ID: 'rest-m', GETIR_TUZLA_RESTAURANT_ID: 'rest-t' };
    expect((await push('rest-m', 'ord-m')).status).toBe(200);
    expect((await push('rest-t', 'ord-t')).status).toBe(200);
    // Ortak anahtar Marina'nın kutusunu açamaz, silemez
    const shared = await cloud('GET', 'getir/inbox?restoran=rest-m', SHARED);
    expect(shared.status).toBe(403);
    expect((await cloud('POST', 'getir/inbox/ack?restoran=rest-m', SHARED, { body: { ids: ['x'] } })).status).toBe(403);
    // Marina'nın anahtarı yalnız kendi kutusunu
    expect(ids(await cloud('GET', 'getir/inbox?restoran=rest-m', K_M, { sube: 'MARINA' }))).toEqual(['ord-m']);
    expect((await cloud('GET', 'getir/inbox?restoran=rest-t', K_M, { sube: 'MARINA' })).json).toMatchObject({ code: 'other_branch' });
    // Tuzla (kendi anahtarı yok) eskisi gibi
    expect(ids(await cloud('GET', 'getir/inbox?restoran=rest-t', SHARED))).toEqual(['ord-t']);
    // Sorgusuz eski kasa: ortak listeyle bütün restoranlarınkini görürdü; artık Marina'nınki düşer
    expect(ids(await cloud('GET', 'getir/inbox', SHARED))).toEqual(['ord-t']);
    // Sorgusuz Marina kasası (şube anahtarıyla): kendi restoranı, başka şubeninki değil
    expect(ids(await cloud('GET', 'getir/inbox', K_M, { sube: 'MARINA' }))).toEqual(['ord-m']);
  });

  it('Getir’e verilen anahtar bir şube anahtarıyla aynıysa aktarıcı kurulmamış sayılır', async () => {
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: WEBHOOK.padEnd(40, 'x'), GETIR_WEBHOOK_SECRET: WEBHOOK.padEnd(40, 'x') };
    expect((await push('rest-m', 'ord-x')).status).toBe(503);
  });
});

describe('bulut: dükkân (özet, rapor, yedek) şubenin anahtarıyla ilk itmede şubeye bağlanır', () => {
  const SHOP = 'dukkan-marina-1';
  const snap = (at: number) => ({ gz: gzipSync(JSON.stringify({ v: 1, at, bootstrap: {}, patron: {}, floor: {}, kitchen: [], board: {}, orders: {} })).toString('base64') });
  const rapor = (at: number) => ({ gz: gzipSync(JSON.stringify({ v: 1, shop: SHOP, today: '2026-11-27', at, days: [] })).toString('base64') });
  const bag = () => (JSON.parse(JSON.parse(store.get(`${REDIS_ONEKI}surum`) ?? '{}')[SHOP] ?? '{}') as { s?: string }).s;

  it('özet: ortak anahtarla bağsız dükkân eskisi gibi; Marina’nın anahtarıyla itilince bağlanır, sonra ortak anahtar ve başka şube yazamaz', async () => {
    store.clear();
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    const d = { headers: { 'x-laf-dukkan': SHOP } };
    expect((await cloud('POST', 'uzaktan/push', SHARED, { ...d, body: snap(1000) })).status).toBe(200);
    expect(bag()).toBeUndefined();
    expect((await cloud('POST', 'uzaktan/push', K_M, { ...d, sube: 'MARINA', body: snap(2000) })).status).toBe(200);
    expect(bag()).toBe('MARINA');
    expect((await cloud('POST', 'uzaktan/push', SHARED, { ...d, body: snap(3000) })).json).toMatchObject({ code: 'branch_key_required' });
    expect((await cloud('POST', 'uzaktan/push', SHARED, { ...d, sube: 'TUZLA', body: snap(3000) })).status).toBe(403);
    // Bağ kalıcı: Marina'nın sonraki itmeleri sürer
    expect((await cloud('POST', 'uzaktan/push', K_M, { ...d, sube: 'MARINA', body: snap(4000) })).status).toBe(200);
    expect(bag()).toBe('MARINA');
    // Sahip Marina'nın anahtarını Vercel'den kaldırırsa (geri dönüş) dükkân yine ortak anahtarla yazılır
    vercel = {};
    expect((await cloud('POST', 'uzaktan/push', SHARED, { ...d, body: snap(5000) })).status).toBe(200);
  });

  it('rapor: aynı kural (bağ rapor kaydında)', async () => {
    store.clear();
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    expect((await cloud('POST', 'uzaktan/rapor', SHARED, { body: rapor(1000) })).status).toBe(200);
    expect((await cloud('POST', 'uzaktan/rapor', K_M, { sube: 'MARINA', body: rapor(2000) })).status).toBe(200);
    expect(JSON.parse(store.get(`${REDIS_ONEKI}rapor:${SHOP}:son`)!)).toMatchObject({ s: 'MARINA', at: 2000 });
    expect((await cloud('POST', 'uzaktan/rapor', SHARED, { body: rapor(3000) })).json).toMatchObject({ code: 'branch_key_required' });
    expect((await cloud('POST', 'uzaktan/rapor', K_M, { sube: 'MARINA', body: rapor(3000) })).status).toBe(200);
  });

  it('yedek: bağlı dükkânın yedeğini başka kasa listeleyemez, indiremez, yükleyemez; listede bağlı dükkân görünmez', async () => {
    store.clear();
    blobs.clear();
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    blobs.set(`yedek/${SHOP}/20261126-230000.lpy`, Buffer.from('x'));
    blobs.set('yedek/dukkan-tuzla-1/20261126-230000.lpy', Buffer.from('y'));
    await cloud('POST', 'uzaktan/push', K_M, { headers: { 'x-laf-dukkan': SHOP }, sube: 'MARINA', body: snap(1000) });
    const tuzla = { headers: { 'x-laf-dukkan': 'dukkan-tuzla-1' } };
    const liste = await cloud('POST', 'uzaktan/yedek/liste', SHARED, tuzla);
    expect(liste.status).toBe(200);
    expect(liste.json.dukkanlar).toEqual(['dukkan-tuzla-1']);
    expect((await cloud('POST', 'uzaktan/yedek/liste', SHARED, { ...tuzla, body: { dukkan: SHOP } })).status).toBe(403);
    expect((await cloud('POST', 'uzaktan/yedek/indir', SHARED, { ...tuzla, body: { pathname: `yedek/${SHOP}/20261126-230000.lpy` } })).status).toBe(403);
    expect((await cloud('POST', 'uzaktan/yedek/yukle', SHARED, { headers: { 'x-laf-dukkan': SHOP }, body: { boyut: 10 } })).status).toBe(403);
    // Marina'nın kasası (yeni bilgisayarda da) kendi dükkânını ve bağsız dükkânları görür
    const own = await cloud('POST', 'uzaktan/yedek/liste', K_M, { headers: { 'x-laf-dukkan': 'yeni-kurulum-1' }, sube: 'MARINA', body: { dukkan: SHOP } });
    expect(own.status).toBe(200);
    expect((own.json.dukkanlar as string[]).sort()).toEqual(['dukkan-tuzla-1', SHOP].sort());
    expect((await cloud('POST', 'uzaktan/yedek/indir', K_M, { sube: 'MARINA', body: { pathname: `yedek/${SHOP}/20261126-230000.lpy` } })).status).toBe(200);
  });
});

describe('bulut: uzaktan yönetim komutu ve açık anahtar kasanın şubesinin anahtarıyla', () => {
  const ID = 'kurulummarina0000000001';
  const durum = (sube: string | undefined, key: string) => ({
    v: KONTROL_SURUM,
    at: Date.now(),
    acik: true,
    turler: [...KOMUT_TURLERI],
    anahtar: 'ACIK-ANAHTAR',
    anahtarImza: createHmac('sha256', key).update(anahtarImzaMetni(ID, 'ACIK-ANAHTAR')).digest('base64url'),
    personel: [],
    roller: [],
    servisModu: 'masa',
    ...(sube ? { sube } : {}),
  });
  async function panel(d: unknown) {
    const kstore = new Map<string, string>([[`${REDIS_ONEKI}kontrol:durum:${ID}`, JSON.stringify(d)]]);
    const { kontrol } = await import('../api/_kontrol');
    const { kafeAnahtari } = await import('../api/_kafe');
    const deps = {
      redis: async (...cmd: (string | number)[]) => upstashCommand(kstore, cmd.map(String)),
      oturum: async () => ({ eposta: 'sahip@ornek.test', rol: 'sahip' as const }),
      demo: false,
      dukkan: async () => ID,
      secret: SHARED,
      sahipler: ['sahip@ornek.test'],
      anahtar: (sube: string | undefined) => kafeAnahtari(sube, SHARED),
    };
    const run = (r: Request) => asVercel(() => kontrol(r, new URL(r.url), r.url.includes('/komut') ? 'kontrol/komut' : 'kontrol/durum', deps));
    const durumRes = (await (await run(new Request(`${CLOUD}/api/kontrol/durum`))).json()) as KontrolPaneli;
    const res = await run(new Request(`${CLOUD}/api/kontrol/komut`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tur: 'ayar.servis', veri: { mod: 'self' } }) }));
    expect(res.status).toBe(200);
    const komut = JSON.parse(Object.values(JSON.parse(kstore.get(`${REDIS_ONEKI}kontrol:komut:${ID}`)!) as Record<string, string>)[0]!) as KomutKaydi;
    return { anahtar: durumRes.durum?.anahtar, komut };
  }
  const imza = (k: KomutKaydi, key: string) => createHmac('sha256', key).update(imzaMetni(k)).digest('base64url');

  it('kasa şubesini söylüyorsa (şube anahtarıyla çalışıyor) komut ve açık anahtar o şubenin anahtarıyla; söylemiyorsa ortak', async () => {
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    const own = await panel(durum('MARINA', K_M));
    expect(own.anahtar).toBe('ACIK-ANAHTAR');
    expect(own.komut.imza).toBe(imza(own.komut, K_M));
    // Ortak anahtarla imzalı açık anahtar Marina için tutmaz: Redis'e yazabilen ortak anahtarlı biri anahtarı değiştiremez
    expect((await panel(durum('MARINA', SHARED))).anahtar).toBe('');
    const shared = await panel(durum(undefined, SHARED));
    expect(shared.anahtar).toBe('ACIK-ANAHTAR');
    expect(shared.komut.imza).toBe(imza(shared.komut, SHARED));
    // Şubenin anahtarı Vercel'de yoksa (henüz girilmedi) ortak anahtar
    vercel = {};
    const yok = await panel(durum('MARINA', SHARED));
    expect(yok.komut.imza).toBe(imza(yok.komut, SHARED));
  });
});

describe('kasa: şube anahtarıyla istek, bulut tanımıyorsa ortak anahtarla', () => {
  const pull = async () => (await import('../server/sync/platform-anahtar')).pullPlatformKeys();
  const view = async () => (await import('../server/lib/kafe-anahtari')).subeAnahtariGorunumu();
  const setSube = async (v: string) => {
    (await import('../server/env')).env.cloudSubeSecret = v;
  };

  it('bulut tanımıyorsa ortakla yineler ve 10 dakika ortakla sürer; tanıyınca şube anahtarıyla ve başlıkla', async () => {
    vercel = { TRENDYOL_MARINA_API_KEY: 'marina-trendyol' };
    await setSube(K_M);
    expect((await view()).durum).toBe('denenmedi');
    await pull();
    expect(sent.map((s) => [s.sube, s.status])).toEqual([
      ['MARINA', 401],
      [null, 200],
    ]);
    expect(await view()).toEqual({ durum: 'bulutta-yok', ad: 'ASILPOS_CLOUD_SECRET_MARINA' });
    sent.length = 0;
    await pull();
    expect(sent.map((s) => [s.sube, s.status])).toEqual([[null, 200]]);
    // 10 dakika sonra şube anahtarı yeniden denenir
    const { kafeAnahtari, GERI_DONUS_MS } = await import('../server/lib/kafe-anahtari');
    expect(kafeAnahtari().sube).toBeNull();
    expect(kafeAnahtari(Date.now() + GERI_DONUS_MS + 1)).toEqual({ key: K_M, sube: 'MARINA' });
    // Sahip Vercel'e girdi: kasa şube anahtarıyla
    (await import('../server/lib/kafe-anahtari')).kafeAnahtariSifirla();
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M, TRENDYOL_MARINA_API_KEY: 'marina-trendyol' };
    sent.length = 0;
    await pull();
    expect(sent.map((s) => [s.sube, s.status])).toEqual([['MARINA', 200]]);
    expect((await view()).durum).toBe('kullaniliyor');
  });

  it('kasada şube anahtarı yokken bulutta varsa: şubenin kaynakları açılmaz, Bağlantı bilgileri nedeni söyler', async () => {
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M, TRENDYOL_MARINA_API_KEY: 'marina-trendyol' };
    await pull();
    expect(sent.map((s) => [s.sube, s.status])).toEqual([[null, 403]]);
    const { pullState } = await import('../server/lib/platform-anahtar');
    expect(pullState()).toMatchObject({ ok: false, error: expect.stringContaining('Şube anahtarı') });
  });

  it('şube anahtarı kullanılmaz: ortak anahtarla aynıysa, kısaysa ya da şube belli değilse', async () => {
    await setSube(SHARED);
    expect((await view()).durum).toBe('ortakla-ayni');
    await setSube('kisa');
    expect((await view()).durum).toBe('kisa');
    await setSube('');
    expect((await view()).durum).toBe('yok');
    const { kafeAnahtari } = await import('../server/lib/kafe-anahtari');
    expect(kafeAnahtari()).toEqual({ key: SHARED, sube: null });
  });

  it('uzaktan yönetim: şube anahtarıyla çalışırken özet şubeyi söyler, komutu o anahtarla doğrular; ortak anahtarlı komut tutmaz', async () => {
    vercel = { ASILPOS_CLOUD_SECRET_MARINA: K_M };
    await setSube(K_M);
    const k = await import('../server/sync/kontrol');
    const { identity } = await import('../server/sync/merkez');
    const d = k.kontrolDurumu();
    expect(d.sube).toBe('MARINA');
    expect(d.anahtarImza).toBe(createHmac('sha256', K_M).update(anahtarImzaMetni(identity().id, d.anahtar)).digest('base64url'));
    const komut = (key: string, n: number) => {
      const v = komutDogrula('ayar.servis', { mod: n % 2 ? 'self' : 'masa' });
      if (!v.ok) throw new Error(v.hata);
      const base = { id: `k_sube${String(n).padStart(4, '0')}abcdefghijklm`, tur: v.tur, veri: v.veri, at: Date.now(), kim: 'sahip@ornek.test', kurulum: identity().id, rol: 'sahip' as const };
      return { ...base, ozet: 'x', imza: createHmac('sha256', key).update(imzaMetni(base)).digest('base64url') } as KomutKaydi;
    };
    const a = komut(K_M, 1);
    const b = komut(SHARED, 2);
    await k.kontrolYaniti({ durumIste: false, komutlar: [a, b] });
    expect(k.komutDurumu(a.id)).toBe('uygulandi');
    expect(k.komutDurumu(b.id)).toBe('reddedildi');
    // Bulut şube anahtarını tanımıyorsa (ret): ortak anahtar geçerli, özet şubesiz
    vercel = {};
    await pull();
    expect(k.kontrolDurumu().sube).toBeUndefined();
    const c = komut(SHARED, 3);
    await k.kontrolYaniti({ durumIste: false, komutlar: [c] });
    expect(k.komutDurumu(c.id)).toBe('uygulandi');
  });

  it('bulut yedeği şube anahtarıyla şifrelenir; çözerken önce şube anahtarı, sonra ortak (eski yedekler)', async () => {
    await setSube(K_M);
    const y = await import('../server/sync/yedek');
    const { yedekAnahtari, yedekCozmeAnahtarlari } = await import('../server/lib/kafe-anahtari');
    const db = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100, 1)]);
    expect(yedekAnahtari()).toBe(K_M);
    const yeni = await y.sealBackupAsync(db, yedekAnahtari());
    const eski = await y.sealBackupAsync(db, SHARED);
    expect(() => y.openBackup(yeni, SHARED)).toThrow(/başka bir anahtarla/);
    expect(y.openBackupAny(yeni, yedekCozmeAnahtarlari()).equals(db)).toBe(true);
    expect(y.openBackupAny(eski, yedekCozmeAnahtarlari()).equals(db)).toBe(true);
    const baska = await y.sealBackupAsync(db, K_T);
    expect(() => y.openBackupAny(baska, yedekCozmeAnahtarlari())).toThrow(/başka bir anahtarla/);
  });

  it('Bağlantı bilgileri: şube anahtarı ayrı, isteğe bağlı satır; yapıştırılır; ladmin’in dağıtımı ona dokunmaz', async () => {
    const { connField, parseEnvLines } = await import('../shared/baglanti');
    expect(connField('ASILPOS_CLOUD_SUBE_SECRET')).toMatchObject({ kind: 'secret', optional: true, minLength: 32 });
    expect(parseEnvLines(`ASILPOS_CLOUD_SUBE_SECRET=${K_M}`).values).toEqual({ ASILPOS_CLOUD_SUBE_SECRET: K_M });
    const { dagitimFarki, DAGITILAN_ANAHTARLAR } = await import('../server/sync/baglanti-dagitim');
    expect(DAGITILAN_ANAHTARLAR).not.toContain('ASILPOS_CLOUD_SUBE_SECRET');
    const diff = dagitimFarki(
      { ok: true, surum: 'ab12', baglanti: { ASILPOS_CLOUD_URL: CLOUD, ASILPOS_CLOUD_SECRET: 'n'.repeat(40), ASILPOS_CLOUD_SUBE_SECRET: 'z'.repeat(40) } },
      { ASILPOS_CLOUD_URL: CLOUD, ASILPOS_CLOUD_SECRET: SHARED, ASILPOS_CLOUD_SUBE_SECRET: K_M },
    );
    expect(diff?.edits).toEqual({ ASILPOS_CLOUD_SECRET: 'n'.repeat(40) });
  });
});
