import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Platform anahtarları buluttan (#75 İş 2): sahip Trendyol ve Yemeksepeti değerlerini bir kez Vercel'deki LafPOS Uzaktan
 * projesine girer; kasa `GET /api/uzaktan/anahtarlar` ucundan (LAFPOS_CLOUD_SECRET imzası) çeker. Değişince yerel
 * kopyaya yazar, bağdaştırıcıyı yeniden kurar, denetim kaydına değersiz satır düşer. Bulutta dolu olan yereli ezer.
 * Değerler arayüze, günlüğe, denetim kaydına, veritabanına ve bulut özetine hiç girmez. Uç Redis'e dokunmaz.
 */
const CLOUD = 'https://lafpos-uzak.test';
const SECRET = 'k'.repeat(40);
const API_KEY = 'GIZLI-trendyol-api-anahtari-9f3a';
const API_SECRET = 'GIZLI-trendyol-sir-7c21';
const NEW_KEY = 'GIZLI-yeni-anahtar-55e0';
const SECRETS = [API_KEY, API_SECRET, NEW_KEY];
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
    vercel.TRENDYOL_API_KEY = API_KEY;
    const bare = await cloudGet(new Request(`${CLOUD}/api/uzaktan/anahtarlar`));
    expect(bare.status).toBe(401);
    expect(bare.headers.get('cache-control')).toBe('no-store');
    expect(await bare.text()).not.toContain(API_KEY);
    const { signedHeaders } = await import('../server/lib/signature');
    const url = new URL(`${CLOUD}/api/uzaktan/anahtarlar`);
    const wrong = await cloudGet(new Request(url, { headers: signedHeaders('y'.repeat(40), 'GET', url, '') }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).not.toContain(API_KEY);
    const right = await cloudGet(new Request(url, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(right.status).toBe(200);
    expect(right.headers.get('cache-control')).toBe('no-store');
    // Yalnız dolu olanlar; liste dışı ortam değişkeni (imza anahtarı) hiç dönmez
    expect(await right.json()).toEqual({ anahtarlar: { TRENDYOL_API_KEY: API_KEY } });
    expect(redisCalls).toBe(0);
    delete vercel.TRENDYOL_API_KEY;
  });

  it('Vercel’in ?yol= yönlendirmesiyle de imza asıl yola göre doğrulanır', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const url = new URL(`${CLOUD}/api/uzaktan/anahtarlar`);
    const res = await cloudGet(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/anahtarlar`, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(res.status).toBe(200);
  });
});

describe('kasanın çekimi', () => {
  it('değer gelince yerel kopyaya yazılır, bağdaştırıcı yeniden kurulur, denetimde değersiz satır; mod değişmez', async () => {
    const { getSettings } = await import('../server/lib/settings');
    const before = JSON.stringify(getSettings());
    expect((await adapter())!.configured()).toBe(false);
    Object.assign(vercel, { TRENDYOL_SUPPLIER_ID: '6734843', TRENDYOL_API_KEY: API_KEY, TRENDYOL_API_SECRET: API_SECRET, TRENDYOL_EXECUTOR_EMAIL: 'patron@example.com' });
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
    vercel.TRENDYOL_API_KEY = NEW_KEY;
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
      vercel.YEMEKSEPETI_REMOTE_ID = 'bulut-remote';
      expect(await pull()).toEqual({ changed: ['yemeksepeti'] });
      expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('bulut-remote');
      expect(ys()).toEqual({ key: 'YEMEKSEPETI_REMOTE_ID', set: true, value: null, source: 'bulut' });

      // Buluttan silindi: yerel geri gelir
      delete vercel.YEMEKSEPETI_REMOTE_ID;
      expect(await pull()).toEqual({ changed: ['yemeksepeti'] });
      expect(platformVars().YEMEKSEPETI_REMOTE_ID).toBe('yerel-remote');
    } finally {
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
