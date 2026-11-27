import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import { anahtarImzaMetni, imzaMetni, KOMUT_TURLERI, type KomutKaydi, KONTROL_SURUM, type KontrolPaneli } from '../shared/kontrol';
import { upstashCommand } from './fake-upstash';
import { type Harness, startApp } from './harness';
import { ESKI_ENV_ONEKI, REDIS_ONEKI, TEL_UZAK_ANAHTAR_ENV } from '@shared/eski-adlar';

/**
 * Anahtar değişimi (docs/07-UZAKTAN-ERISIM.md §7). 27 Kasım 2026 olayı: sahip 26 Kasım'da anahtarları değiştirdi, ladmin
 * yeni değerleri kasalara dağıttı, kasalar gün sonunda uyguladı; ama Vercel'deki değer başka anda değişti ve kasanın
 * bütün istekleri reddedildi, Uzaktan donup kaldı. Artık bulut yeni değerle birlikte önceki değeri de kabul eder
 * (`ASILPOS_CLOUD_SECRET_ONCEKI`, şube için `ASILPOS_CLOUD_SECRET_<ŞUBE>_ONCEKI`): sıra ladmin ve Vercel'e yeni değer,
 * önceki değer _ONCEKI'ye; kasalar gece geçer; birkaç gün sonra _ONCEKI silinir. Hiçbir anda kasa reddedilmez.
 */
const CLOUD = 'https://anahtar-degisimi.test';
const ESKI = 'e'.repeat(40);
const YENI = 'y'.repeat(40);
const K_M = 'm'.repeat(40);
const K_M_YENI = 'n'.repeat(40);
const K_T = 't'.repeat(40);
const PAROLA = 'kahve-parola-123';
/** Vercel'de ad değişikliğinden önceki adlar: şimdiki değer ve önceki değer (shared/eski-adlar.ts) */
const ESKI_ADLA = TEL_UZAK_ANAHTAR_ENV;
const ESKI_ADLA_ONCEKI = `${ESKI_ENV_ONEKI}CLOUD_SECRET_ONCEKI`;
const store = new Map<string, string>();

/** Vercel'deki AsilPOS Uzaktan'ın ortamı: kasanın süreç ortamından ayrı (uç çağrılırken yerine konur) */
let vercel: Record<string, string> = {};
const BASE_ENV = { KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0', ASILPOS_UZAKTAN_PAROLA: PAROLA, ASILPOS_UZAKTAN_PAROLA_GEREKLI: '1' };
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
/** Kasadan buluta giden istekler ve yanıtları */
const sent: { path: string; status: number }[] = [];

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: ESKI, cloudSubeSecret: '' });
  api = await import('../api/uzaktan');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input instanceof Request ? input.url : input);
    if (u === 'https://redis.test') return new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[]) }));
    if (new URL(u).origin === CLOUD) {
      const req = new Request(u, init);
      const res = await asVercel(() => (req.method === 'GET' ? api.GET(req) : api.POST(req)));
      sent.push({ path: new URL(u).pathname, status: res.status });
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
  Object.assign(env, { cloudSecret: ESKI, cloudSubeSecret: '' });
});

/** Kasanın yapacağı gibi imzalı istek (kafeKimligi'ne) */
const istek = (url: URL, key: string, sube?: string) => ({ method: 'POST', headers: new Headers({ ...signedHeaders(key, 'POST', url, 'x'), ...(sube ? { 'x-laf-sube': sube } : {}) }) });

describe('bulut: önceki değerin geçerliliği', () => {
  it('ortak anahtarın önceki değeri: kısa, şimdikiyle ya da bir şube anahtarıyla aynıysa yok sayılır; eski adla da okunur', async () => {
    const { ortakOnceki } = await import('../api/_kafe');
    expect(ortakOnceki(YENI, {})).toBeNull();
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: ESKI })).toBe(ESKI);
    // Vercel'deki değişken ad değişikliğinden önceki adla da girilebilir; yeni ad geçer
    expect(ortakOnceki(YENI, { [ESKI_ADLA_ONCEKI]: ESKI })).toBe(ESKI);
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: ` ${ESKI} `, [ESKI_ADLA_ONCEKI]: 'z'.repeat(40) })).toBe(ESKI);
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: 'kisa' })).toBeNull();
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: YENI })).toBeNull();
    // Bir şubenin anahtarıyla aynıysa: o şubenin anahtarıyla imzalı istek başlıksız gelip ortak anahtar sayılmasın
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: K_M, ASILPOS_CLOUD_SECRET_MARINA: K_M })).toBeNull();
    expect(ortakOnceki(YENI, { ASILPOS_CLOUD_SECRET_ONCEKI: K_M, ASILPOS_CLOUD_SECRET_MARINA: K_M_YENI, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBeNull();
  });

  it('ONCEKI şube adı değil: ortak anahtarın önceki değeri şube anahtarı sayılmaz', async () => {
    const { subeAnahtarlari, subeAnahtariDurumu } = await import('../api/_kafe');
    const vars = { ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, ASILPOS_CLOUD_SECRET_MARINA: K_M, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M_YENI };
    expect([...subeAnahtarlari(vars).entries()]).toEqual([['MARINA', K_M]]);
    expect(subeAnahtariDurumu('ONCEKI', YENI, vars)).toEqual({ durum: 'yok' });
  });

  it('şubenin önceki değeri yalnız o şubenin; ortak anahtarın değeri ya da başka şubeninki olamaz, şimdiki anahtar geçerli olmalı', async () => {
    const { subeOncekiAnahtari } = await import('../api/_kafe');
    const base = { ASILPOS_CLOUD_SECRET_MARINA: K_M_YENI, ASILPOS_CLOUD_SECRET_TUZLA: K_T };
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBe(K_M);
    expect(subeOncekiAnahtari('TUZLA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBeNull();
    expect(subeOncekiAnahtari(null, YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBeNull();
    // Bütün kasaların bildiği ortak anahtar (şimdiki ya da önceki) Marina'yı açamaz
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: YENI })).toBeNull();
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: ESKI })).toBeNull();
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, [ESKI_ADLA_ONCEKI]: ESKI, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: ESKI })).toBeNull();
    // Tuzla'nın anahtarı (şimdiki ya da önceki) Marina'yı açamaz
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_T })).toBeNull();
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M, ASILPOS_CLOUD_SECRET_TUZLA_ONCEKI: K_M })).toBeNull();
    expect(subeOncekiAnahtari('MARINA', YENI, { ...base, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: 'kisa' })).toBeNull();
    // Şimdiki anahtarı olmayan (ya da geçersiz) şubenin önceki değeri sayılmaz
    expect(subeOncekiAnahtari('MARINA', YENI, { ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBeNull();
    expect(subeOncekiAnahtari('MARINA', YENI, { ASILPOS_CLOUD_SECRET_MARINA: 'kisa', ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M })).toBeNull();
  });
});

describe('bulut: imzalı istek önceki değerle de tutar', () => {
  const url = new URL(`${CLOUD}/api/uzaktan/push`);
  const id = async (key: string, sube?: string) => {
    const { kafeKimligi } = await import('../api/_kafe');
    // Bulutun şimdiki anahtarı api/uzaktan.ts'teki gibi: yeni ad, yoksa eski ad
    return asVercel(() => kafeKimligi(istek(url, key, sube), url, 'x', process.env.ASILPOS_CLOUD_SECRET || process.env[ESKI_ADLA] || '', api.verifyPush));
  };

  it('ortak anahtar: _ONCEKI yokken eski anahtar 401 (27 Kasım olayı); varken tutar, işaretli; yeni anahtar her zaman', async () => {
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect(((await id(ESKI)) as Response).status).toBe(401);
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI };
    expect(await id(YENI)).toEqual({ sube: null, kendi: false });
    expect(await id(ESKI)).toEqual({ sube: null, kendi: false, onceki: true });
    // Kendi anahtarı olmayan şubenin başlıklı isteği de
    expect(await id(ESKI, 'TUZLA')).toEqual({ sube: 'TUZLA', kendi: false, onceki: true });
    expect(((await id('x'.repeat(40))) as Response).status).toBe(401);
    // Vercel'de bugünkü gibi ad değişikliğinden önceki adlarla
    vercel = { [ESKI_ADLA]: YENI, [ESKI_ADLA_ONCEKI]: ESKI };
    expect(await id(ESKI)).toEqual({ sube: null, kendi: false, onceki: true });
    // _ONCEKI silinince eski anahtar yeniden 401
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect(((await id(ESKI)) as Response).status).toBe(401);
  });

  it('şube anahtarı: önceki değeri yalnız o şubeyi açar; ortak anahtarın önceki değeri kendi anahtarı olan şubeyi açmaz', async () => {
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, ASILPOS_CLOUD_SECRET_MARINA: K_M_YENI, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M };
    expect(await id(K_M_YENI, 'MARINA')).toEqual({ sube: 'MARINA', kendi: true });
    expect(await id(K_M, 'MARINA')).toEqual({ sube: 'MARINA', kendi: true, onceki: true });
    expect(((await id(ESKI, 'MARINA')) as Response).status).toBe(401);
    expect(((await id(K_M, 'TUZLA')) as Response).status).toBe(401);
    expect(((await id(K_M)) as Response).status).toBe(401);
    // Geçersiz şube anahtarının nedeni eski ortak anahtarla imzalayan kasaya da söylenir
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, ASILPOS_CLOUD_SECRET_MARINA: 'kisa' };
    const bad = (await id(ESKI, 'MARINA')) as Response;
    expect(bad.status).toBe(503);
    expect(((await bad.json()) as { code: string }).code).toBe('branch_key_invalid');
  });

  it('platform anahtarları ucu: eski ortak anahtarla imzalı çekim _ONCEKI varken 200', async () => {
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, TRENDYOL_TUZLA_API_KEY: 'anahtar-1' };
    const u = new URL(`${CLOUD}/api/uzaktan/anahtarlar?sube=tuzla`);
    const get = (key: string) => asVercel(() => api.GET(new Request(u, { headers: signedHeaders(key, 'GET', u, '') })));
    const res = await get(ESKI);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { anahtarlar: Record<string, string> }).anahtarlar).toEqual({ TRENDYOL_API_KEY: 'anahtar-1' });
    expect((await get('x'.repeat(40))).status).toBe(401);
  });
});

describe('kasa ve bulut birlikte: değişimin her anında Uzaktan çalışır', () => {
  it('Vercel ve ladmin yeni değerde, kasa gün kapanana dek eskiyle: özet gider; kasa geçince yeniyle; _ONCEKI silinince eski reddedilir', async () => {
    const cloud = await import('../server/sync/cloud');
    const { env } = await import('../server/env');
    const it_ = async () => {
      cloud.resetCloudSync();
      return cloud.pushSnapshot();
    };
    // Olaydaki durum: önceki değer tanımlı değil, kasanın bütün itmeleri 401
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect(await it_()).toBe('failed');
    expect(sent.at(-1)).toMatchObject({ path: '/api/uzaktan/push', status: 401 });
    // Yeni sıra: Vercel'de yeni değer şimdiki, eski değer _ONCEKI
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI };
    expect(await it_()).toBe('sent');
    // Kasa gün sonunda ladmin'in yeni değerini uyguladı
    env.cloudSecret = YENI;
    expect(await it_()).toBe('sent');
    // Birkaç gün sonra _ONCEKI silinir: yeni değerli kasa sürer, eski değerle kalan reddedilir
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect(await it_()).toBe('sent');
    env.cloudSecret = ESKI;
    expect(await it_()).toBe('failed');
  });

  it('sahibin uzaktan oturumu anahtar değişince düşmez (_ONCEKI varken); yeni oturum yeni anahtarla verilir', async () => {
    const cloud = await import('../server/sync/cloud');
    vercel = { ASILPOS_CLOUD_SECRET: ESKI };
    cloud.resetCloudSync();
    expect(await cloud.pushSnapshot()).toBe('sent');
    const giris = async () => {
      const res = await asVercel(() => api.POST(new Request(`${CLOUD}/api/uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PAROLA }), headers: { 'x-forwarded-for': '7.7.7.7' } })));
      return ((await res.json()) as { token: string }).token;
    };
    const boot = async (token: string) => (await asVercel(() => api.GET(new Request(`${CLOUD}/api/bootstrap`, { headers: { authorization: `Bearer ${token}` } })))).status;
    const eskiJeton = await giris();
    expect(await boot(eskiJeton)).toBe(200);
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI };
    expect(await boot(eskiJeton)).toBe(200);
    const yeniJeton = await giris();
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect(await boot(yeniJeton)).toBe(200);
    expect(await boot(eskiJeton)).toBe(401);
  });
});

describe('bulut: uzaktan yönetim komutu kasanın kullandığı anahtarla imzalanır', () => {
  const ID = 'kurulumdegisim000000001';
  const durum = (key: string, sube?: string) => ({
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
    const { kafeAnahtari, kafeOncekiAnahtari } = await import('../api/_kafe');
    const secret = () => process.env.ASILPOS_CLOUD_SECRET ?? '';
    const deps = {
      redis: async (...cmd: (string | number)[]) => upstashCommand(kstore, cmd.map(String)),
      oturum: async () => ({ eposta: 'sahip@ornek.test', rol: 'sahip' as const }),
      demo: false,
      dukkan: async () => ID,
      get secret() {
        return secret();
      },
      sahipler: ['sahip@ornek.test'],
      anahtar: (sube: string | undefined) => kafeAnahtari(sube, secret()),
      onceki: (sube: string | undefined) => kafeOncekiAnahtari(sube, secret()),
    };
    const run = (r: Request) => asVercel(() => kontrol(r, new URL(r.url), r.url.includes('/komut') ? 'kontrol/komut' : 'kontrol/durum', deps));
    const durumRes = (await (await run(new Request(`${CLOUD}/api/kontrol/durum`))).json()) as KontrolPaneli;
    const res = await run(new Request(`${CLOUD}/api/kontrol/komut`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tur: 'ayar.servis', veri: { mod: 'self' } }) }));
    expect(res.status).toBe(200);
    const komut = JSON.parse(Object.values(JSON.parse(kstore.get(`${REDIS_ONEKI}kontrol:komut:${ID}`)!) as Record<string, string>)[0]!) as KomutKaydi;
    return { anahtar: durumRes.durum?.anahtar, komut };
  }
  const imza = (k: KomutKaydi, key: string) => createHmac('sha256', key).update(imzaMetni(k)).digest('base64url');

  it('kasa henüz eski anahtarla: açık anahtarı görünür, komut eski anahtarla; kasa geçince yeniyle; tanınmayan imzada yeni anahtar', async () => {
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI };
    const eski = await panel(durum(ESKI));
    expect(eski.anahtar).toBe('ACIK-ANAHTAR');
    expect(eski.komut.imza).toBe(imza(eski.komut, ESKI));
    const yeni = await panel(durum(YENI));
    expect(yeni.anahtar).toBe('ACIK-ANAHTAR');
    expect(yeni.komut.imza).toBe(imza(yeni.komut, YENI));
    // Bilinmeyen anahtarla imzalı açık anahtar verilmez (Redis'e yazabilen biri değiştiremez); komut şimdiki anahtarla
    const yabanci = await panel(durum('x'.repeat(40)));
    expect(yabanci.anahtar).toBe('');
    expect(yabanci.komut.imza).toBe(imza(yabanci.komut, YENI));
    // _ONCEKI silinince eski anahtarlı kasanın açık anahtarı da tutmaz
    vercel = { ASILPOS_CLOUD_SECRET: YENI };
    expect((await panel(durum(ESKI))).anahtar).toBe('');
  });

  it('şube anahtarıyla çalışan kasa: şubenin önceki değeri; ortak anahtarın önceki değeri o şubede tutmaz', async () => {
    vercel = { ASILPOS_CLOUD_SECRET: YENI, ASILPOS_CLOUD_SECRET_ONCEKI: ESKI, ASILPOS_CLOUD_SECRET_MARINA: K_M_YENI, ASILPOS_CLOUD_SECRET_MARINA_ONCEKI: K_M };
    const eski = await panel(durum(K_M, 'MARINA'));
    expect(eski.anahtar).toBe('ACIK-ANAHTAR');
    expect(eski.komut.imza).toBe(imza(eski.komut, K_M));
    const yeni = await panel(durum(K_M_YENI, 'MARINA'));
    expect(yeni.komut.imza).toBe(imza(yeni.komut, K_M_YENI));
    expect((await panel(durum(ESKI, 'MARINA'))).anahtar).toBe('');
  });
});
