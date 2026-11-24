import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { environmentManager, focusManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import { get, setConditionalGets, setShopHeader } from '../src/lib/api';
import { REMOTE_IDLE_POLL_MS, REMOTE_POLL_MS, remotePollMs } from '../src/lib/remote';
import { type UpstashCall, upstashCommand } from './fake-upstash';

/**
 * Uzaktan ekranın Upstash bütçesi (docs/KALANLAR.md: "uzaktan ekran gün boyu açık kalırsa ücretsiz kotaya
 * yaklaşabilir"; docs/07-UZAKTAN-ERISIM.md §4 "Upstash bütçesi"). Sahte Upstash her komutu ve okunan baytı sayar:
 * değişmeyen özette yoklama tek komut ve 304, büyük özet okunmaz; kasanın nabzı değişmeyen özeti yeniden yazmaz ama
 * görünümün saati ilerler; bir saat açık kalan ekranın komut sayısı bütçede; istemci 304'te önbellekteki gövdeyi döner;
 * gizli sekmede yoklama yok.
 */
const CLOUD = 'https://lafpos.vercel.app';
const SECRET = 'k'.repeat(40);
const REDIS = 'https://redis.test';
const store = new Map<string, string>();
const log: UpstashCall[] = [];
const ENV = ['LAFPOS_CLOUD_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA'];
const saved: Record<string, string | undefined> = {};
/** Gerçekçi özet: uzaktan demosunun örnek günü (~90 KB) */
const BASE = JSON.parse(readFileSync(join(__dirname, '../api/demo-ozet.json'), 'utf8')) as { at: number; bootstrap: Record<string, unknown>; patron: Record<string, unknown>; orders: Record<string, unknown> };

const api = () => import('../api/uzaktan');

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  // Varsayılan kurulum: parolasız görünüm, demo açık (kafe bağlanınca biter)
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, KV_REST_API_URL: REDIS, KV_REST_API_TOKEN: 't' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== REDIS) throw new Error(`beklenmeyen istek: ${String(input)}`);
    return new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[], log) }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
beforeEach(async () => {
  store.clear();
  log.length = 0;
  (await api()).statsDayCache.clear();
});


/** Yeni kasanın patron özetindeki kıyas girdisi (shared/today-stats.ts); eski kasa göndermez */
const STATS = { v: 1, guests: 0, days: {}, daily: [], topPrev: [] };

/**
 * Kasanın `at` anındaki özeti; `sales` patron panelinin cirosu (içerik değişikliği). `old`: kıyas girdisi göndermeyen
 * eski kasa (Uzaktan girdiyi gün raporlarından kurar: tests/today-stats-rapor.test.ts)
 */
function snap(at: number, sales = 100_000, old = false) {
  return { ...BASE, at, bootstrap: { ...BASE.bootstrap, serverTime: at }, patron: { ...BASE.patron, now: at, netSales: sales, ...(old ? {} : { stats: STATS }) } };
}

async function push(s: object, shop?: string) {
  const { POST } = await api();
  const body = JSON.stringify({ gz: gzipSync(JSON.stringify(s)).toString('base64') });
  const headers = { ...signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/uzaktan/push`), body), ...(shop ? { 'x-laf-dukkan': shop } : {}) };
  const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/push`, { method: 'POST', body, headers }));
  return (await res.json()) as { ok: boolean; stale?: boolean; unchanged?: boolean };
}

async function login() {
  const { POST } = await api();
  return ((await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: '{}' }))).json()) as { token: string }).token;
}

async function view(token: string, path: string, tag?: string | null) {
  const { GET } = await api();
  const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { headers: { authorization: `Bearer ${token}`, ...(tag ? { 'if-none-match': tag } : {}) } }));
  return { status: res.status, tag: res.headers.get('etag'), body: res.status === 200 ? ((await res.json()) as Record<string, unknown>) : null };
}

const cmds = () => log.map((c) => c.cmd);
const bytes = () => log.reduce((a, c) => a + c.bytes, 0);

describe('uzaktan ekran: Upstash komutu', () => {
  it('değişmeyen özette yoklama tek küçük okuma ve 304; özet okunmaz', async () => {
    const T = BASE.at;
    await push(snap(T));
    const token = await login();
    const order = Object.keys(BASE.orders)[0]!;
    for (const path of ['reports/patron', 'floor', 'kitchen', 'kitchen/board', `orders/${order}`, 'bootstrap']) {
      log.length = 0;
      const first = await view(token, path);
      expect(first.status, path).toBe(200);
      expect(first.tag, path).toBeTruthy();
      // İlk okuma: sürüm ve özet
      expect(cmds(), path).toEqual(['HGETALL', 'GET']);
      log.length = 0;
      const again = await view(token, path, first.tag);
      expect(again.status, path).toBe(304);
      expect(cmds(), path).toEqual(['HGETALL']);
      expect(bytes(), path).toBeLessThan(1000);
    }
    // Oturum bilgisi ve bar ekranının boş sekmeleri Redis'e hiç gitmez
    log.length = 0;
    expect((await view(token, 'auth/me')).status).toBe(200);
    expect((await view(token, 'kitchen&ready=1')).body).toEqual([]);
    expect((await view(token, 'kitchen&history=1')).body).toEqual([]);
    expect(cmds()).toEqual([]);
  });

  it('kasanın nabzı değişmeyen özeti yeniden yazmaz; görünümün saati yine ilerler', async () => {
    const T = BASE.at;
    await push(snap(T));
    const token = await login();
    const first = await view(token, 'reports/patron');
    const boot = await view(token, 'bootstrap');

    // Beş dakikalık nabız: içerik aynı, yalnız zaman damgaları ilerledi
    log.length = 0;
    expect(await push(snap(T + 300_000))).toMatchObject({ ok: true, unchanged: true });
    expect(cmds()).toEqual(['HGET', 'HSET']);
    expect((JSON.parse(store.get('lafpos:snapshot')!) as { at: number }).at).toBe(T);
    // Patron paneli yeni sürümü alır; saat nabzın saati (kafe sessiz sayılmaz)
    const beat = await view(token, 'reports/patron', first.tag);
    expect(beat.status).toBe(200);
    expect(beat.tag).not.toBe(first.tag);
    expect(beat.body!.now).toBe(T + 300_000);
    expect(beat.body!.netSales).toBe(100_000);
    expect(((await view(token, 'uzaktan/durum')).body as { at: number }).at).toBe(T + 300_000);
    // Açılış verisi değişmedi: 304
    expect((await view(token, 'bootstrap', boot.tag)).status).toBe(304);

    // Satış: içerik değişti, özet yazılır, görünüm yeni ciroyu alır
    log.length = 0;
    expect(await push(snap(T + 320_000, 125_000))).toEqual({ ok: true });
    expect(cmds()).toEqual(['HGET', 'SET', 'HSET']);
    const sale = await view(token, 'reports/patron', beat.tag);
    expect(sale.body!.netSales).toBe(125_000);
    expect(sale.body!.now).toBe(T + 320_000);

    // Yeniden gönderilen eski özet yenisini ezmez (yalnız sürüm okunur)
    log.length = 0;
    expect(await push(snap(T + 310_000, 90_000))).toMatchObject({ stale: true });
    expect(cmds()).toEqual(['HGET']);
    expect((await view(token, 'reports/patron', sale.tag)).status).toBe(304);
  });

  it('değişmeyen özetin süresi günde bir uzatılır; silinmişse yeniden yazılır, görünüm 503 ile sürümü bırakır', async () => {
    const T = BASE.at;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(T);
      await push(snap(T));
      vi.setSystemTime(T + 25 * 3600_000);
      log.length = 0;
      expect(await push(snap(T + 25 * 3600_000))).toMatchObject({ unchanged: true });
      expect(cmds()).toEqual(['HGET', 'EXPIRE', 'HSET']);

      // Özet bir yolla silindi (süresi doldu): görünüm 503 der, sürümü siler; kasanın ilk itmesi özeti yeniden yazar
      store.delete('lafpos:snapshot');
      const token = await login();
      const gone = await view(token, 'floor');
      expect(gone.status).toBe(503);
      expect(store.has('lafpos:surum')).toBe(false);
      log.length = 0;
      expect(await push(snap(T + 25 * 3600_000 + 300_000))).toEqual({ ok: true });
      expect(cmds()).toEqual(['HGET', 'GET', 'SET', 'HSET']);
      expect((await view(token, 'floor')).status).toBe(200);

      // Uzatma anında anahtar yoksa (EXPIRE 0) yazılır
      store.delete('lafpos:snapshot');
      vi.setSystemTime(T + 50 * 3600_000);
      log.length = 0;
      expect(await push(snap(T + 50 * 3600_000))).toEqual({ ok: true });
      expect(cmds()).toEqual(['HGET', 'EXPIRE', 'SET', 'HSET']);
      expect(store.has('lafpos:snapshot')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bu sürümden önceki kayıt (yalnız eski anahtarlar) okunmaya devam eder; ilk itme sürümü yazar', async () => {
    const T = BASE.at;
    store.set('lafpos:snapshot', JSON.stringify(snap(T)));
    store.set('lafpos:dukkanlar', JSON.stringify({ default: T }));
    const token = await login();
    const old = await view(token, 'reports/patron');
    expect(old.status).toBe(200);
    // Sürüm yok: koşullu yanıt da yok
    expect(old.tag).toBeNull();
    expect(((await view(token, 'uzaktan/kurulum')).body as { snapshotAt: number }).snapshotAt).toBe(T);
    // Eski kasanın yeniden gönderdiği eski özet yine ezmez
    expect(await push(snap(T - 1000))).toMatchObject({ stale: true });
    expect(await push(snap(T + 300_000))).toEqual({ ok: true });
    const now = await view(token, 'reports/patron');
    expect(now.tag).toBeTruthy();
    expect((await view(token, 'reports/patron', now.tag)).status).toBe(304);
  });

  it('kafe bağlanmadan (demo) istek başına iki küçük komut; gerçek jeton demo kapısında Redis sormaz', async () => {
    const { GET, POST } = await api();
    const demo = ((await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: '{}' }))).json()) as { token: string; demo: boolean });
    expect(demo.demo).toBe(true);
    log.length = 0;
    expect((await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/patron`, { headers: { authorization: `Bearer ${demo.token}` } }))).status).toBe(200);
    expect(cmds()).toEqual(['HGETALL', 'MGET']);
    await push(snap(BASE.at));
    const token = await login();
    log.length = 0;
    await view(token, 'auth/me');
    expect(cmds()).toEqual([]);
  });

  it('raporlar: kasanın bugünü ve dönemin günleri tek MGET', async () => {
    await push(snap(BASE.at));
    const token = await login();
    log.length = 0;
    const { GET } = await api();
    const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/summary&from=2026-11-20&to=2026-11-20`, { headers: { authorization: `Bearer ${token}`, 'x-laf-dukkan': 'default' } }));
    expect(res.status).toBe(200);
    // Ciro: bugün, kıyas günü ve kasanın "bugün"ü aynı MGET'te; kasanın son nabzı (sürüm) tek küçük HGET: "bugün" ve
    // "aynı saate kadar" kıyası kasanın şimdiki zamanıyla (denetim bulgu 9)
    expect(cmds()).toEqual(['HGET', 'MGET']);
    log.length = 0;
    // Öteki sekmeler verilen dönemin günleriyle yetinir: tek MGET
    expect((await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/products&from=2026-11-20&to=2026-11-20`, { headers: { authorization: `Bearer ${token}`, 'x-laf-dukkan': 'default' } }))).status).toBe(200);
    expect(cmds()).toEqual(['MGET']);
  });
});

describe('uzaktan ekran: bir saat açık', () => {
  /**
   * Bir saat, gün açık, tek dükkân, Patron paneli görünür (yoklama 15 sn, koşullu). Sakin saat: kasa yalnız 5 dakikalık
   * nabzı iter (içerik aynı). Yoğun saat: her dakika satış (içerik değişir). Önceki sürümün sayıları (10 sn yoklama,
   * istek başına üç komut ve bütün özet) PR'daki tabloda; burada bugünkü bütçe
   */
  async function hour(changeEveryMs: number | null, old = false) {
    const T = BASE.at;
    await push(snap(T, 100_000, old));
    const token = await login();
    let tag: string | null = null;
    let sales = 100_000;
    const viewer: UpstashCall[] = [];
    const kasa: UpstashCall[] = [];
    let requests = 0;
    // Saatin 12 nabzı (5., 10., … 60. dakika) ve 240 yoklaması (0. saniyeden 59:45'e)
    for (let t = 0; t <= 3600_000; t += 5_000) {
      const at = T + t;
      const beat = t > 0 && t % 300_000 === 0;
      const change = changeEveryMs != null && t > 0 && t % changeEveryMs === 0;
      if (beat || change) {
        log.length = 0;
        if (change) sales += 1_000;
        await push(snap(at, sales, old));
        kasa.push(...log);
        requests++;
      }
      if (t < 3600_000 && t % REMOTE_POLL_MS === 0) {
        log.length = 0;
        const r = await view(token, 'reports/patron', tag);
        if (r.status === 200) tag = r.tag;
        viewer.push(...log);
        requests++;
      }
    }
    const full = viewer.filter((c) => c.cmd === 'GET').length;
    return { requests, viewer: viewer.length, kasa: kasa.length, total: viewer.length + kasa.length, full, bytes: [...viewer, ...kasa].reduce((a, c) => a + c.bytes, 0) };
  }

  it('sakin saat (yalnız nabız): 240 yoklama, 252 + 24 komut, özet 12 kez okunur', async () => {
    const h = await hour(null);
    expect(h).toMatchObject({ requests: 240 + 12, viewer: 252, kasa: 24, total: 276, full: 12 });
  });

  it('yoğun saat (her dakika satış): 300 + 180 komut', async () => {
    const h = await hour(60_000);
    expect(h).toMatchObject({ requests: 240 + 60, viewer: 300, kasa: 180, total: 480, full: 60 });
  });

  it('eski kasa (kıyas girdisi göndermez): yoklama aynı, saatte bir örnekte en çok iki ek okuma (gün raporları, yarım saat bellekte)', async () => {
    const h = await hour(60_000, true);
    // Sınamada saat ilerlemez: bellek bir kez dolar (+1 MGET). Gerçekte yarım saatte bir yenilenir
    expect(h).toMatchObject({ requests: 240 + 60, viewer: 301, kasa: 180, full: 60 });
  });
});

describe('uzaktan istemci', () => {
  afterEach(() => {
    setConditionalGets(false);
    setShopHeader(null);
  });

  it('koşullu GET: etiket adresle saklanır, 304 gelince aynı gövde döner; dükkân ayrı', async () => {
    const seen: (string | null)[] = [];
    const body = { netSales: 1 };
    vi.stubGlobal('fetch', async (_: string, init: RequestInit) => {
      const tag = (init.headers as Record<string, string>)['if-none-match'] ?? null;
      seen.push(tag);
      return tag === '"1.default.5"' ? new Response(null, { status: 304 }) : new Response(JSON.stringify(body), { status: 200, headers: { etag: '"1.default.5"' } });
    });
    try {
      setConditionalGets(true);
      const a = await get<typeof body>('/reports/patron');
      const b = await get<typeof body>('/reports/patron');
      expect(b).toBe(a);
      expect(seen).toEqual([null, '"1.default.5"']);
      // Başka dükkân başka kayıt
      setShopHeader('marina');
      await get('/reports/patron');
      expect(seen[2]).toBeNull();
      // Kasada (kapalı) koşullu istek yok
      setShopHeader(null);
      setConditionalGets(false);
      await get('/reports/patron');
      expect(seen[3]).toBeNull();
    } finally {
      vi.unstubAllGlobals();
      vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[], log) })));
    }
  });

  it('aralık: gün açıkken 15 sn, kapalıyken 60 sn; gizli sekmede yoklama yok, görünür olunca bir kez', async () => {
    expect(remotePollMs(true)).toBe(15_000);
    expect(remotePollMs(undefined)).toBe(REMOTE_POLL_MS);
    expect(remotePollMs(false)).toBe(REMOTE_IDLE_POLL_MS);
    vi.useFakeTimers();
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    const client = new QueryClient();
    // Sağlayıcının yaptığı gibi: odak (sekmenin görünürlüğü) dinlenir
    client.mount();
    try {
      let calls = 0;
      const observer = new QueryObserver(client, { queryKey: ['patron'], queryFn: async () => ++calls, refetchInterval: REMOTE_POLL_MS });
      const off = observer.subscribe(() => undefined);
      await vi.advanceTimersByTimeAsync(REMOTE_POLL_MS * 4);
      expect(calls).toBe(5);
      focusManager.setFocused(false);
      await vi.advanceTimersByTimeAsync(3600_000);
      expect(calls).toBe(5);
      focusManager.setFocused(true);
      await vi.advanceTimersByTimeAsync(10);
      expect(calls).toBe(6);
      off();
    } finally {
      focusManager.setFocused(undefined);
      client.unmount();
      client.clear();
      environmentManager.setIsServer(() => wasServer);
      vi.useRealTimers();
    }
  });
});

describe('geçmiş ciro ve patron panelinin etiketi', () => {
  it('sahip geçmiş ciroyu yükleyince patron paneli 304 almaz: etiket geçmişin yükleme anını taşır', async () => {
    expect(await push(snap(BASE.at))).toEqual({ ok: true });
    const token = await login();
    const first = await view(token, 'reports/patron');
    expect(first.status).toBe(200);
    expect((await view(token, 'reports/patron', first.tag)).status).toBe(304);
    // Merkez'e geçmiş yüklendi (api/_merkez.ts): sürüm karmasında dükkânın işareti
    upstashCommand(store, ['HSET', 'lafpos:surum', 'gecmis:default', '42']);
    const after = await view(token, 'reports/patron', first.tag);
    expect(after.status).toBe(200);
    expect(after.tag).not.toBe(first.tag);
    expect((await view(token, 'reports/patron', after.tag)).status).toBe(304);
  });
});
