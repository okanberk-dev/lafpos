import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Platform anahtarları buluttan (#75 İş 2): sahip Trendyol ve Yemeksepeti değerlerini bir kez Vercel'deki LafPOS Uzaktan
 * projesine girer; kasa `GET /api/uzaktan/anahtarlar` ucundan (LAFPOS_CLOUD_SECRET imzası) çeker. Değişince yerel
 * kopyaya yazar, bağdaştırıcıyı yeniden kurar, denetim kaydına değersiz satır düşer. Bulutta dolu olan yereli ezer.
 * Değerler arayüze, günlüğe, denetim kaydına, veritabanına ve bulut özetine hiç girmez. Uç Redis'e dokunmaz.
 * Şubeye göre: bulutta adlar `<PLATFORM>_<ŞUBE>_<ALAN>` (TRENDYOL_TUZLA_API_KEY); kasa kendi şubesininkileri alır, öneksiz
 * eski adlar ve şubesiz istek hiçbir anahtar almaz (Marina'da Trendyol yok, Tuzla'nınki Marina'ya gitmez). Değerler
 * hangi şube için çekildiyse onunla saklanır; şube değişince eskisininkiler kullanılmaz, kasa hemen yeniden çeker.
 */
const CLOUD = 'https://lafpos-uzak.test';
const SECRET = 'k'.repeat(40);
const API_KEY = 'GIZLI-trendyol-api-anahtari-9f3a';
const API_SECRET = 'GIZLI-trendyol-sir-7c21';
const NEW_KEY = 'GIZLI-yeni-anahtar-55e0';
const TUZLA_KEY = 'GIZLI-tuzla-api-anahtari-31b8';
const TUZLA_SECRET = 'GIZLI-tuzla-sir-a4e7';
const ESKI_KEY = 'GIZLI-oneksiz-eski-8d4c';
const SECRETS = [API_KEY, API_SECRET, NEW_KEY, TUZLA_KEY, TUZLA_SECRET, ESKI_KEY];
let h: Harness;
let redisCalls = 0;
let offline = false;
let dataDir = '';
type Api = typeof import('../api/uzaktan');
let api: Api;

/** Vercel'deki LafPOS Uzaktan'ın ortamı: kasanın süreç ortamından ayrı (uç çağrılırken yerine konur) */
const vercel: Record<string, string> = {};
async function asVercel<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env;
  process.env = { LAFPOS_CLOUD_SECRET: SECRET, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0', ...vercel };
  try {
    return await fn();
  } finally {
    process.env = saved;
  }
}
const cloudGet = (req: Request) => asVercel(() => api.GET(req));

beforeAll(async () => {
  h = await startApp();
  dataDir = process.env.LAFPOS_DATA_DIR!;
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET });
  api = await import('../api/uzaktan');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const u = String(input);
    if (u.startsWith('https://redis.test')) {
      redisCalls++;
      return new Response(JSON.stringify({ result: null }), { status: 200 });
    }
    if (u.startsWith(CLOUD)) {
      if (offline) throw new TypeError('fetch failed');
      return cloudGet(new Request(u, init));
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});
beforeEach(() => {
  offline = false;
  redisCalls = 0;
});

const pull = async () => (await import('../server/sync/platform-anahtar')).pullPlatformKeys();
const adapter = async () => (await import('../server/delivery/registry')).adapterFor('trendyol');
async function audits() {
  const { db, schema } = await import('../server/db/client');
  return db.select().from(schema.auditLog).all().filter((a) => a.action === 'ayar.platform-anahtar');
}

describe('bulut ucu: GET /api/uzaktan/anahtarlar', () => {
  it('imzasız ve yanlış imzalı istek 401, yanıt no-store; Redis’e dokunmaz', async () => {
    vercel.TRENDYOL_MARINA_API_KEY = API_KEY;
    const bare = await cloudGet(new Request(`${CLOUD}/api/uzaktan/anahtarlar`));
    expect(bare.status).toBe(401);
    expect(bare.headers.get('cache-control')).toBe('no-store');
    expect(await bare.text()).not.toContain(API_KEY);
    const { signedHeaders } = await import('../server/lib/signature');
    const url = new URL(`${CLOUD}/api/uzaktan/anahtarlar?sube=marina`);
    const wrong = await cloudGet(new Request(url, { headers: signedHeaders('y'.repeat(40), 'GET', url, '') }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(API_KEY);
    const right = await cloudGet(new Request(url, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(right.status).toBe(200);
    expect(right.headers.get('cache-control')).toBe('no-store');
    // Yalnız dolu olanlar; liste dışı ortam değişkeni (imza anahtarı) hiç dönmez
    expect(await right.json()).toEqual({ anahtarlar: { TRENDYOL_API_KEY: API_KEY } });
    expect(redisCalls).toBe(0);
    delete vercel.TRENDYOL_MARINA_API_KEY;
  });

  it('şube sorgusu imzanın içinde: imzadan sonra değiştirilen ya da şubesiz imzaya eklenen ?sube= 401', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    vercel.TRENDYOL_TUZLA_API_KEY = TUZLA_KEY;
    try {
      const signedMarina = new URL(`${CLOUD}/api/uzaktan/anahtarlar?sube=marina`);
      const swapped = await cloudGet(new Request(`${CLOUD}/api/uzaktan/anahtarlar?sube=tuzla`, { headers: signedHeaders(SECRET, 'GET', signedMarina, '') }));
      expect(swapped.status).toBe(401);
      expect(await swapped.text()).not.toContain(TUZLA_KEY);
      const signedBare = new URL(`${CLOUD}/api/uzaktan/anahtarlar`);
      const added = await cloudGet(new Request(`${CLOUD}/api/uzaktan/anahtarlar?sube=tuzla`, { headers: signedHeaders(SECRET, 'GET', signedBare, '') }));
      expect(added.status).toBe(401);
      expect(await added.text()).not.toContain(TUZLA_KEY);
      // Vercel yönlendirmesiyle (?yol=) de aynı
      const viaYol = await cloudGet(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/anahtarlar&sube=tuzla`, { headers: signedHeaders(SECRET, 'GET', signedMarina, '') }));
      expect(viaYol.status).toBe(401);
      // Doğru imzalı aynı istek geçer
      const signedTuzla = new URL(`${CLOUD}/api/uzaktan/anahtarlar?sube=tuzla`);
      const right = await cloudGet(new Request(signedTuzla, { headers: signedHeaders(SECRET, 'GET', signedTuzla, '') }));
      expect(right.status).toBe(200);
    } finally {
      delete vercel.TRENDYOL_TUZLA_API_KEY;
    }
  });

  it('Vercel’in ?yol= yönlendirmesiyle de imza asıl yola göre doğrulanır', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const url = new URL(`${CLOUD}/api/uzaktan/anahtarlar?sube=marina`);
    vercel.YEMEKSEPETI_MARINA_REMOTE_ID = 'marina-remote';
    try {
      const res = await cloudGet(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/anahtarlar&sube=marina`, { headers: signedHeaders(SECRET, 'GET', url, '') }));
      expect(res.status).toBe(200);
      // Şube sorgusu yönlendirmeden sağ çıkar
      expect(await res.json()).toEqual({ anahtarlar: { YEMEKSEPETI_REMOTE_ID: 'marina-remote' } });
    } finally {
      delete vercel.YEMEKSEPETI_MARINA_REMOTE_ID;
    }
  });
});

describe('şubeye göre: Trendyol yalnız Tuzla’nın', () => {
  async function keysFor(query: string): Promise<{ anahtarlar: Record<string, string>; text: string }> {
    const { signedHeaders } = await import('../server/lib/signature');
    const url = new URL(`${CLOUD}/api/uzaktan/anahtarlar${query}`);
    const res = await cloudGet(new Request(url, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    return { anahtarlar: (JSON.parse(text) as { anahtarlar: Record<string, string> }).anahtarlar, text };
  }

  it('şube adı büyük harf, Türkçe karaktersiz; bulut adı <PLATFORM>_<ŞUBE>_<ALAN>', async () => {
    const { subeEtiketi, subeKeyName } = await import('../shared/baglanti');
    expect(subeEtiketi('marina')).toBe('MARINA');
    expect(subeEtiketi(' Kadıköy-Moda ')).toBe('KADIKOYMODA');
    expect(subeEtiketi('Şişli')).toBe('SISLI');
    for (const bad of ['', '   ', '---', null, undefined, 42]) expect(subeEtiketi(bad)).toBeNull();
    expect(subeKeyName('TRENDYOL_API_KEY', 'TUZLA')).toBe('TRENDYOL_TUZLA_API_KEY');
    expect(subeKeyName('YEMEKSEPETI_REMOTE_ID', 'MARINA')).toBe('YEMEKSEPETI_MARINA_REMOTE_ID');
    expect(() => subeKeyName('LAFPOS_CLOUD_SECRET', 'MARINA')).toThrow();
  });

  it('Marina isteği Tuzla’nın anahtarını almaz, Tuzla isteği alır; öneksiz eski ad ve şubesiz istek hiçbir şey almaz', async () => {
    const set = {
      TRENDYOL_TUZLA_SUPPLIER_ID: '999001',
      TRENDYOL_TUZLA_API_KEY: TUZLA_KEY,
      TRENDYOL_TUZLA_API_SECRET: TUZLA_SECRET,
      TRENDYOL_TUZLA_EXECUTOR_EMAIL: 'tuzla@example.com',
      // Öneksiz eski adlar (PR #86 öncesi): hiçbir kasaya gitmez
      TRENDYOL_SUPPLIER_ID: '111111',
      TRENDYOL_API_KEY: ESKI_KEY,
      TRENDYOL_API_SECRET: ESKI_KEY,
      YEMEKSEPETI_REMOTE_ID: ESKI_KEY,
      YEMEKSEPETI_MARINA_REMOTE_ID: 'marina-remote',
    };
    Object.assign(vercel, set);
    try {
      const marina = await keysFor('?sube=marina');
      expect(marina.anahtarlar).toEqual({ YEMEKSEPETI_REMOTE_ID: 'marina-remote' });
      for (const s of [TUZLA_KEY, TUZLA_SECRET, ESKI_KEY, '999001', '111111']) expect(marina.text).not.toContain(s);

      const tuzla = await keysFor('?sube=tuzla');
      expect(tuzla.anahtarlar).toEqual({ TRENDYOL_SUPPLIER_ID: '999001', TRENDYOL_API_KEY: TUZLA_KEY, TRENDYOL_API_SECRET: TUZLA_SECRET, TRENDYOL_EXECUTOR_EMAIL: 'tuzla@example.com' });
      expect(tuzla.text).not.toContain(ESKI_KEY);
      expect(tuzla.text).not.toContain('marina-remote');
      // Büyük harfle gelen aynı şube
      expect((await keysFor('?sube=Tuzla')).anahtarlar).toEqual(tuzla.anahtarlar);

      // Şubesiz (eski istemci), boş ya da geçersiz şube, tanımsız şube: boş
      for (const q of ['', '?sube=', '?sube=---', '?sube=kadikoy']) {
        const r = await keysFor(q);
        expect(r.anahtarlar, q).toEqual({});
        for (const s of [TUZLA_KEY, TUZLA_SECRET, ESKI_KEY, 'marina-remote']) expect(r.text).not.toContain(s);
      }
      // Şube etiketi tireyi atar: 'tuzla-2' → TUZLA2 (TUZLA değil)
      expect((await keysFor('?sube=tuzla-2')).anahtarlar).toEqual({});
      expect(redisCalls).toBe(0);
    } finally {
      for (const k of Object.keys(set)) delete vercel[k];
    }
  });

  it('şubeli ad boş ya da yalnız boşluksa yanıtta yok', async () => {
    Object.assign(vercel, { TRENDYOL_TUZLA_API_KEY: '', TRENDYOL_TUZLA_API_SECRET: '   ', TRENDYOL_TUZLA_SUPPLIER_ID: '999001' });
    try {
      expect((await keysFor('?sube=tuzla')).anahtarlar).toEqual({ TRENDYOL_SUPPLIER_ID: '999001' });
    } finally {
      for (const k of ['TRENDYOL_TUZLA_API_KEY', 'TRENDYOL_TUZLA_API_SECRET', 'TRENDYOL_TUZLA_SUPPLIER_ID']) delete vercel[k];
    }
  });
});

describe('kasanın çekimi', () => {
  it('değer gelince yerel kopyaya yazılır, bağdaştırıcı yeniden kurulur, denetimde değersiz satır; mod değişmez', async () => {
    const { getSettings } = await import('../server/lib/settings');
    const before = JSON.stringify(getSettings());
    expect((await adapter())!.configured()).toBe(false);
    Object.assign(vercel, { TRENDYOL_MARINA_SUPPLIER_ID: '6734843', TRENDYOL_MARINA_API_KEY: API_KEY, TRENDYOL_MARINA_API_SECRET: API_SECRET, TRENDYOL_MARINA_EXECUTOR_EMAIL: 'patron@example.com' });
    expect(await pull()).toEqual({ changed: ['trendyol'] });
    const first = await adapter();
    expect(first!.configured()).toBe(true);
    const rows = await audits();
    expect(rows.map((r) => r.message)).toEqual(['Trendyol anahtarları buluttan güncellendi']);
    expect(rows[0]!.data).toEqual({ keys: ['TRENDYOL_SUPPLIER_ID', 'TRENDYOL_API_KEY', 'TRENDYOL_API_SECRET', 'TRENDYOL_EXECUTOR_EMAIL'] });
    // Platform Kapalı kalır: ayarlar aynen
    expect(JSON.stringify(getSettings())).toBe(before);
    // Yerel kopya veri klasöründe, yalnız sahibine okunur
    const file = join(dataDir, 'platform-anahtarlari.json');
    expect(existsSync(file)).toBe(true);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o077).toBe(0);

    // Değişmeyen çekim: yeniden kurulum ve yeni satır yok
    expect(await pull()).toEqual({ changed: [] });
    expect(await adapter()).toBe(first);
    expect(await audits()).toHaveLength(1);

    // Bulutta değer değişti: yeniden kurulur, yalnız değişen anahtarın adı yazılır
    vercel.TRENDYOL_MARINA_API_KEY = NEW_KEY;
    expect(await pull()).toEqual({ changed: ['trendyol'] });
    expect(await adapter()).not.toBe(first);
    const after = await audits();
    expect(after).toHaveLength(2);
    expect(after[1]!.data).toEqual({ keys: ['TRENDYOL_API_KEY'] });
  });

  it('internet yokken ya da imza yanlışken son değerlerle sürer', async () => {
    const { cloudKeys, pullState } = await import('../server/lib/platform-anahtar');
    const kept = { ...cloudKeys().values };
    const current = await adapter();
    offline = true;
    expect(await pull()).toEqual({ skipped: 'ulaşılamadı' });
    expect(cloudKeys().values).toEqual(kept);
    expect(await adapter()).toBe(current);
    expect(pullState()).toMatchObject({ ok: false, error: 'Uzaktan’a ulaşılamadı' });
    offline = false;
    const { env } = await import('../server/env');
    env.cloudSecret = 'z'.repeat(40);
    try {
      expect(await pull()).toEqual({ skipped: 'durum 401' });
      expect(pullState().error).toBe('İmza geçersiz');
      expect(cloudKeys().values).toEqual(kept);
      expect((await adapter())!.configured()).toBe(true);
    } finally {
      env.cloudSecret = SECRET;
    }
    // Yeniden açılışta dosyadan okunur
    const { forgetCloudKeys } = await import('../server/lib/platform-anahtar');
    forgetCloudKeys();
    expect(cloudKeys().values).toEqual(kept);
  });

  it('öncelik: bulutta dolu olan yereli ezer, bulutta boşsa yerel kalır', async () => {
    const { platformVars } = await import('../server/lib/platform-anahtar');
    const { connectionView } = await import('../server/lib/ayar-dosyasi');
    const ys = () => connectionView().groups.find((g) => g.id === 'yemeksepeti')!.fields.find((f) => f.key === 'YEMEKSEPETI_REMOTE_ID')!;
    // Kasanın yerel ayarı (süreç ortamı); bulutta yok: yerel
    process.env.YEMEKSEPETI_REMOTE_ID = 'yerel-remote';
    try {
      expect(await pull()).toEqual({ changed: [] });
      expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('yerel-remote');
      expect(ys()).toMatchObject({ set: true, value: 'yerel-remote', source: 'yerel' });

      // Bulutta dolu: ezer, değeri görünümde yok
      vercel.YEMEKSEPETI_MARINA_REMOTE_ID = 'bulut-remote';
      expect(await pull()).toEqual({ changed: ['yemeksepeti'] });
      expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('bulut-remote');
      expect(ys()).toEqual({ key: 'YEMEKSEPETI_REMOTE_ID', set: true, value: null, source: 'bulut' });

      // Buluttan silindi: yerel geri gelir
      delete vercel.YEMEKSEPETI_MARINA_REMOTE_ID;
      expect(await pull()).toEqual({ changed: ['yemeksepeti'] });
      expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('yerel-remote');

      // Bulutta şubeli ad boş ya da yalnız boşluk: yok sayılır, yerel kalır
      for (const blank of ['', '   ']) {
        vercel.YEMEKSEPETI_MARINA_REMOTE_ID = blank;
        expect(await pull()).toEqual({ changed: [] });
        expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('yerel-remote');
        expect(ys()).toMatchObject({ set: true, value: 'yerel-remote', source: 'yerel' });
      }
    } finally {
      delete vercel.YEMEKSEPETI_MARINA_REMOTE_ID;
      delete process.env.YEMEKSEPETI_REMOTE_ID;
    }
  });

  it('Trendyol isteği buluttaki anahtarla ve işlemi yapan e-postayla gider', async () => {
    const { trendyolRequest } = await import('../server/delivery/trendyol');
    const { configFrom } = await import('../server/env-config');
    const { platformVars } = await import('../server/lib/platform-anahtar');
    let seen: Headers | null = null;
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (_i: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('{}', { status: 200 });
    });
    try {
      await trendyolRequest(configFrom(platformVars()).trendyol, 'GET', '/x');
    } finally {
      vi.stubGlobal('fetch', prev);
    }
    expect(seen!.get('authorization')).toBe(`Basic ${btoa(`${NEW_KEY}:${API_SECRET}`)}`);
    expect(seen!.get('x-executor-user')).toBe('patron@example.com');
  });

  it('kasa kendi şubesini gönderir: Marina kasası Tuzla’nın Trendyol anahtarını almaz; şubesiz kasa hiçbir anahtar almaz', async () => {
    const { cloudKeys } = await import('../server/lib/platform-anahtar');
    const { updateSettings } = await import('../server/lib/settings');
    const marina = { ...cloudKeys().values };
    expect(marina.TRENDYOL_API_KEY).toBe(NEW_KEY);
    const set = { TRENDYOL_TUZLA_SUPPLIER_ID: '999001', TRENDYOL_TUZLA_API_KEY: TUZLA_KEY, TRENDYOL_TUZLA_API_SECRET: TUZLA_SECRET, TRENDYOL_API_KEY: ESKI_KEY };
    Object.assign(vercel, set);
    try {
      // Marina (varsayılan şube): değişmez
      expect(await pull()).toEqual({ changed: [] });
      expect(cloudKeys().values).toEqual(marina);
      expect(JSON.stringify(cloudKeys().values)).not.toContain(TUZLA_KEY);
      expect(JSON.stringify(cloudKeys().values)).not.toContain(ESKI_KEY);

      // Tuzla kasası Tuzla'nınkini alır (öneksiz eski ad yine gelmez)
      updateSettings({ branchId: 'tuzla' });
      expect(await pull()).toEqual({ changed: ['trendyol'] });
      expect(cloudKeys().values).toEqual({ TRENDYOL_SUPPLIER_ID: '999001', TRENDYOL_API_KEY: TUZLA_KEY, TRENDYOL_API_SECRET: TUZLA_SECRET });

      // Şubesiz kasa: buluttan hiçbir anahtar; Tuzla'nınki de artık geçerli değil (şube değişti), bağdaştırıcı bırakır
      updateSettings({ branchId: '' });
      expect(await pull()).toEqual({ changed: [] });
      expect(cloudKeys()).toMatchObject({ values: {}, sube: null });
      expect((await adapter())!.configured()).toBe(false);
    } finally {
      for (const k of Object.keys(set)) delete vercel[k];
      updateSettings({ branchId: 'marina' });
    }
    expect(await pull()).toEqual({ changed: ['trendyol'] });
    expect(cloudKeys().values).toEqual(marina);
  });

  it('değerler hangi şube için çekildiyse onunla saklanır; görünüm şube etiketini verir (değeri değil)', async () => {
    const { cloudKeys } = await import('../server/lib/platform-anahtar');
    const { connectionView } = await import('../server/lib/ayar-dosyasi');
    expect(cloudKeys().sube).toBe('MARINA');
    expect(JSON.parse(readFileSync(join(dataDir, 'platform-anahtarlari.json'), 'utf8'))).toMatchObject({ sube: 'MARINA' });
    expect(connectionView().bulut).toEqual({ at: expect.any(Number), ok: true, error: null, sube: 'MARINA', uzaktan: true });
    // Uzaktan kurulu değilse görünüm söyler
    const { env } = await import('../server/env');
    env.cloudUrl = '';
    try {
      expect(connectionView().bulut.uzaktan).toBe(false);
    } finally {
      env.cloudUrl = CLOUD;
    }
  });

  it('şube kimliği değişince eski şubenin anahtarları hemen bırakılır, yenisininkiler beklemeden çekilir', async () => {
    const { cloudKeys, platformVars, pullState } = await import('../server/lib/platform-anahtar');
    const { connectionView } = await import('../server/lib/ayar-dosyasi');
    const { getSettings } = await import('../server/lib/settings');
    const { buildSnapshot } = await import('../server/sync/cloud');
    const source = () => connectionView().groups.find((g) => g.id === 'trendyol')!.fields.find((f) => f.key === 'TRENDYOL_API_KEY')!.source;
    expect(platformVars().TRENDYOL_API_KEY).toBe(NEW_KEY);
    expect((await adapter())!.configured()).toBe(true);
    const set = { TRENDYOL_TUZLA_SUPPLIER_ID: '999001', TRENDYOL_TUZLA_API_KEY: TUZLA_KEY, TRENDYOL_TUZLA_API_SECRET: TUZLA_SECRET };
    Object.assign(vercel, set);
    try {
      // Patron şubeyi Tuzla yapar: kasa beklemeden Tuzla'nınkileri çeker. Günlük, denetim ve bulut özeti değer görmez
      const logs: string[] = [];
      const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))));
      try {
        expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'tuzla' })).status).toBe(200);
        await vi.waitFor(() => expect(cloudKeys().sube).toBe('TUZLA'));
      } finally {
        for (const sp of spies) sp.mockRestore();
      }
      expect(cloudKeys().values).toEqual({ TRENDYOL_SUPPLIER_ID: '999001', TRENDYOL_API_KEY: TUZLA_KEY, TRENDYOL_API_SECRET: TUZLA_SECRET });
      expect(platformVars().TRENDYOL_API_KEY).toBe(TUZLA_KEY);
      expect((await adapter())!.configured()).toBe(true);
      expect(source()).toBe('bulut');
      expect(connectionView().bulut).toMatchObject({ sube: 'TUZLA', ok: true, at: expect.any(Number) });
      const outputs = [['günlük', logs.join('\n')], ['denetim', JSON.stringify(await audits())], ['özet', JSON.stringify(buildSnapshot())], ['görünüm', JSON.stringify(connectionView())]] as const;
      for (const secret of [TUZLA_KEY, TUZLA_SECRET, NEW_KEY]) {
        for (const [where, text] of outputs) expect(text.includes(secret), `${where} değeri içeriyor`).toBe(false);
      }

      // İnternet yokken Marina'ya dönülür: kayıt başarılı; Tuzla'nın anahtarı dosyada kalsa da hemen bırakılır
      offline = true;
      expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'marina' })).status).toBe(200);
      await vi.waitFor(() => expect(pullState().ok).toBe(false));
      expect(getSettings().branchId).toBe('marina');
      expect(cloudKeys().sube).toBe('TUZLA');
      expect(platformVars().TRENDYOL_API_KEY).toBeUndefined();
      expect((await adapter())!.configured()).toBe(false);
      expect(source()).toBeUndefined();
      // Bu şube için hiç çekilmedi: son başarılı çekim yok (kart "Bu şubede tanımlı değil" demez)
      expect(connectionView().bulut).toMatchObject({ sube: 'MARINA', at: null, ok: false });
    } finally {
      offline = false;
      for (const k of Object.keys(set)) delete vercel[k];
    }
    // İnternet gelince bir sonraki çekim Marina'nınkileri getirir
    expect(await pull()).toEqual({ changed: ['trendyol'] });
    expect(cloudKeys().sube).toBe('MARINA');
    expect(platformVars().TRENDYOL_API_KEY).toBe(NEW_KEY);
    expect((await adapter())!.configured()).toBe(true);
  });

  it('Uzaktan tanımlı değilken şube değişimi istek atmaz, kaydı durdurmaz', async () => {
    const { env } = await import('../server/env');
    const { cloudKeys } = await import('../server/lib/platform-anahtar');
    const kept = { ...cloudKeys() };
    let calls = 0;
    const prev = globalThis.fetch;
    vi.stubGlobal('fetch', async (...a: Parameters<typeof fetch>) => {
      if (String(a[0]).startsWith(CLOUD)) calls++;
      return prev(...a);
    });
    env.cloudUrl = '';
    try {
      expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'tuzla' })).status).toBe(200);
      expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'marina' })).status).toBe(200);
      await new Promise((r) => setTimeout(r, 10));
      expect(calls).toBe(0);
      expect(cloudKeys()).toEqual(kept);
    } finally {
      env.cloudUrl = CLOUD;
      vi.stubGlobal('fetch', prev);
    }
    expect((await adapter())!.configured()).toBe(true);
  });

  it('eski dosyada şube yoksa değerler kullanılmaz; bir sonraki çekim düzeltir', async () => {
    const { cloudKeys, forgetCloudKeys, platformVars } = await import('../server/lib/platform-anahtar');
    const { connectionView } = await import('../server/lib/ayar-dosyasi');
    const file = join(dataDir, 'platform-anahtarlari.json');
    writeFileSync(file, JSON.stringify({ values: { TRENDYOL_SUPPLIER_ID: '111111', TRENDYOL_API_KEY: ESKI_KEY, TRENDYOL_API_SECRET: ESKI_KEY }, at: Date.now() }), { mode: 0o600 });
    forgetCloudKeys();
    expect(cloudKeys()).toMatchObject({ sube: null, values: { TRENDYOL_API_KEY: ESKI_KEY } });
    expect(platformVars().TRENDYOL_API_KEY).toBeUndefined();
    expect(connectionView().groups.find((g) => g.id === 'trendyol')!.fields.every((f) => f.source !== 'bulut')).toBe(true);
    expect(connectionView().bulut.at).toBeNull();
    expect(await pull()).toEqual({ changed: ['trendyol'] });
    expect(cloudKeys().sube).toBe('MARINA');
    expect(platformVars().TRENDYOL_API_KEY).toBe(NEW_KEY);
    expect((await adapter())!.configured()).toBe(true);
    expect(readFileSync(file, 'utf8')).not.toContain(ESKI_KEY);
  });
});

describe('Yemeksepeti aktarıcısı: şubeli restoran kimlikleri', () => {
  const PLUGIN = 'dh-plugin-secret-ornek-456';
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = `${b64({ typ: 'JWT', alg: 'HS512' })}.${b64({ service: 'middleware' })}`;
  const auth = { authorization: `Bearer ${head}.${createHmac('sha512', PLUGIN).update(head).digest('base64url')}`, 'content-type': 'application/json' };
  const push = (remoteId: string) => asVercel(() => api.POST(new Request(`${CLOUD}/api/uzaktan?yol=yemeksepeti/order/${remoteId}`, { method: 'POST', body: JSON.stringify({ token: `tok-${remoteId}` }), headers: auth })));
  const status = (remoteId: string) =>
    asVercel(() => api.PUT(new Request(`${CLOUD}/api/uzaktan?yol=yemeksepeti/remoteId/${remoteId}/remoteOrder/tok-1/posOrderStatus`, { method: 'PUT', body: JSON.stringify({ status: 'ORDER_CANCELLED' }), headers: auth })));
  const ids = () => asVercel(async () => [...api.yemeksepetiRemoteIds()].sort());
  const NAMES = ['YEMEKSEPETI_PLUGIN_SECRET', 'YEMEKSEPETI_REMOTE_ID', 'YEMEKSEPETI_MARINA_REMOTE_ID', 'YEMEKSEPETI_TUZLA_REMOTE_ID'];

  it('süzgeç: öneksiz ad ve her şubenin YEMEKSEPETI_<ŞUBE>_REMOTE_ID’si; boşlar atılır, hiçbiri yoksa süzgeç yok', async () => {
    // Sahip yeni kurala göre yalnız şubeli adı girer: süzgeç onu tanır (eskiden öneksiz ad boş kalınca süzgeç boştu)
    Object.assign(vercel, { YEMEKSEPETI_PLUGIN_SECRET: PLUGIN, YEMEKSEPETI_MARINA_REMOTE_ID: 'POS_M', YEMEKSEPETI_TUZLA_REMOTE_ID: '   ', YEMEKSEPETI_REMOTE_ID: '' });
    try {
      expect(await ids()).toEqual(['POS_M']);
      expect((await push('POS_M')).status).toBe(200);
      const wrong = await push('BASKA');
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({ reason: 'MENU_ACCOUNT_SETTINGS' });
      expect((await status('BASKA')).status).toBe(404);
      expect((await status('POS_M')).status).toBe(200);

      // Eski öneksiz ad da sayılır; iki şube birlikte
      Object.assign(vercel, { YEMEKSEPETI_REMOTE_ID: 'POS_ESKI', YEMEKSEPETI_TUZLA_REMOTE_ID: ' POS_T ' });
      expect(await ids()).toEqual(['POS_ESKI', 'POS_M', 'POS_T']);
      for (const id of ['POS_M', 'POS_T', 'POS_ESKI']) expect((await push(id)).status, id).toBe(200);
      expect((await push('BASKA')).status).toBe(400);

      // Hiçbiri yok ya da hepsi boş: süzgeç yok (eski davranış)
      Object.assign(vercel, { YEMEKSEPETI_REMOTE_ID: ' ', YEMEKSEPETI_MARINA_REMOTE_ID: '', YEMEKSEPETI_TUZLA_REMOTE_ID: '' });
      expect(await ids()).toEqual([]);
      expect((await push('BASKA')).status).toBe(200);
    } finally {
      for (const k of NAMES) delete vercel[k];
    }
  });
});

describe('gizlilik: değer hiçbir çıktıya sızmaz', () => {
  it('Yönetim görünümü, denetim kaydı, veritabanı, bulut özeti ve günlük', async () => {
    const logs: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void logs.push(a.map(String).join(' '))));
    offline = true;
    await pull();
    offline = false;
    await pull();
    for (const s of spies) s.mockRestore();

    const view = await h.call('patron', 'GET', '/admin/baglanti');
    expect(view.status).toBe(200);
    const viewText = JSON.stringify(view.json);
    const ty = (view.json as { groups: { id: string; fields: { key: string; source?: string }[] }[] }).groups.find((g) => g.id === 'trendyol')!;
    expect(ty.fields.find((f) => f.key === 'TRENDYOL_API_KEY')!.source).toBe('bulut');
    expect((view.json as { bulut: { at: number | null } }).bulut.at).toEqual(expect.any(Number));

    const { db } = await import('../server/db/client');
    const { sql } = await import('drizzle-orm');
    const tables = db.all<{ name: string }>(sql.raw("SELECT name FROM sqlite_master WHERE type='table'")).map((t) => t.name);
    expect(tables).toContain('audit_log');
    const dbText = tables.map((t) => JSON.stringify(db.all(sql.raw(`SELECT * FROM "${t}"`)))).join('\n');
    const { buildSnapshot } = await import('../server/sync/cloud');
    const snapText = JSON.stringify(buildSnapshot());
    const auditText = JSON.stringify(await audits());

    for (const s of SECRETS) {
      for (const [where, text] of [['görünüm', viewText], ['denetim', auditText], ['veritabanı', dbText], ['özet', snapText], ['günlük', logs.join('\n')]] as const) {
        expect(text.includes(s), `${where} değeri içeriyor`).toBe(false);
      }
    }
    // Yerel kopya değeri taşır (bağdaştırıcı için), ama yalnız veri klasöründe
    expect(readFileSync(join(dataDir, 'platform-anahtarlari.json'), 'utf8')).toContain(NEW_KEY);
  });
});
