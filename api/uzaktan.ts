/**
 * LafPOS Uzaktan (Vercel işlevi). Kafedeki LafPOS sunucusu canlı özetini imzalı olarak buraya iter
 * (server/sync/cloud.ts); patron parolasıyla giren tarayıcı aynı arayüzü salt okunur görür. Kasa yerelde kalır.
 *
 * Ortam: LAFPOS_CLOUD_SECRET (kafedekiyle aynı, en az 32), LAFPOS_UZAKTAN_PAROLA (en az 10), Upstash Redis
 * (KV_REST_API_URL + KV_REST_API_TOKEN ya da UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Yemeksepeti aktarıcısı (`/api/yemeksepeti/*`, aşağıda): YEMEKSEPETI_PLUGIN_SECRET (Delivery Hero'nun JWT anahtarı),
 * isteğe bağlı YEMEKSEPETI_REMOTE_ID (yalnız bu restoranın siparişleri).
 * Kendi içinde: Vercel her dosyayı ayrı derler, göreli içe aktarma çalışma anında kırılabilir. İmza kuralı
 * server/lib/signature.ts ile aynı (tests/cloud-api.test.ts denetler). Ayrıntı: docs/07-UZAKTAN-ERISIM.md
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const SNAPSHOT_KEY = 'lafpos:snapshot';
const TOKEN_HOURS = 12;
const LOGIN_LIMIT = 8;
const SKEW_S = 300;

type Json = Record<string, unknown>;
interface Snapshot {
  v: number;
  at: number;
  bootstrap: Json & { me?: unknown };
  patron: Json;
  floor: Json;
  kitchen: unknown[];
  board: Json;
  orders: Record<string, Json>;
}

const env = (k: string) => (process.env[k] ?? '').trim();
const secret = () => env('LAFPOS_CLOUD_SECRET');
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);

// ─── İmza (server/lib/signature.ts ile aynı kural) ───────────────────────────

export function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export function signFor(key: string, timestamp: number, method: string, url: URL, body: string): string {
  const canonical = [String(timestamp), method.toUpperCase(), url.pathname, canonicalQuery(url.searchParams), createHash('sha256').update(body, 'utf8').digest('hex')].join('\n');
  return createHmac('sha256', key).update(canonical).digest('hex');
}

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

export function verifyPush(key: string, req: { method: string; headers: Headers }, url: URL, body: string, nowMs = Date.now()): boolean {
  const ts = Number(req.headers.get('x-laf-timestamp'));
  const sig = req.headers.get('x-laf-signature') ?? '';
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > SKEW_S || !sig.startsWith('v1=')) return false;
  return sameText(sig.slice(3), signFor(key, ts, req.method, url, body));
}

/**
 * İstemcinin istediği asıl adres. vercel.json bütün /api/* isteklerini bu işleve yollar ve yolu ?yol= ile taşır;
 * imza asıl yola göre hesaplandığı için adres geri kurulur.
 */
export function originalUrl(raw: string): URL {
  const u = new URL(raw);
  const yol = u.searchParams.get('yol');
  if (yol == null) return u;
  u.searchParams.delete('yol');
  u.pathname = `/api/${yol.replace(/^\/+/, '')}`;
  return u;
}

// ─── Oturum belirteci: süre.nonce.imza ───────────────────────────────────────

/** İmzaya parolanın özeti de girer: parola değişince bütün uzaktan oturumlar düşer */
const passwordTag = () => createHash('sha256').update(`uzaktan-parola:${env('LAFPOS_UZAKTAN_PAROLA')}`).digest('hex').slice(0, 16);

export function issueToken(key: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + TOKEN_HOURS * 3600;
  const body = `${exp}.${randomBytes(9).toString('base64url')}`;
  return `${body}.${createHmac('sha256', key).update(`uzaktan:${passwordTag()}:${body}`).digest('base64url')}`;
}

export function tokenValid(key: string, token: string, nowMs = Date.now()): boolean {
  const [exp, nonce, sig] = token.split('.');
  if (!exp || !nonce || !sig || Number(exp) * 1000 < nowMs) return false;
  return sameText(sig, createHmac('sha256', key).update(`uzaktan:${passwordTag()}:${exp}.${nonce}`).digest('base64url'));
}

// ─── Upstash Redis (REST) ────────────────────────────────────────────────────

async function redis(...cmd: (string | number)[]): Promise<unknown> {
  const url = env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL');
  const token = env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN');
  if (!url || !token) throw new Error('redis_missing');
  const res = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(cmd) });
  const out = (await res.json()) as { result?: unknown; error?: string };
  if (!res.ok || out.error) throw new Error(out.error ?? `redis ${res.status}`);
  return out.result;
}

async function snapshot(): Promise<Snapshot | null> {
  const raw = (await redis('GET', SNAPSHOT_KEY)) as string | null;
  return raw ? (JSON.parse(raw) as Snapshot) : null;
}

// ─── Yemeksepeti aktarıcısı: Delivery Hero POS plugin uçları ────────────────

/**
 * Kasa kafe ağında olduğu için Delivery Hero siparişi buraya iter (plugin.yaml `POST /order/{remoteId}` ve
 * `PUT /remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`); istek `service: middleware` iddialı, bize
 * verilen anahtarla imzalı bir JWT taşır. Kayıt Redis listesine girer ve sipariş `remoteOrderId` (= sipariş belirteci)
 * ile saniyeler içinde onaylanır; kasa listeyi imzalı olarak çeker (`GET /api/yemeksepeti/inbox`) ve işlediğini siler
 * (`POST /api/yemeksepeti/inbox/ack`). Kabul ve ret kasadan middleware'e gider (server/delivery/yemeksepeti.ts).
 */
const YS_INBOX_KEY = 'lafpos:ys:inbox';
const YS_INBOX_MAX = 200;
const YS_INBOX_TTL_S = 2 * 86400;

/** Delivery Hero'nun JWT'si: HS512 (ya da HS256), `service: middleware` iddiası, süresi varsa geçmemiş */
export function verifyMiddlewareJwt(secret: string, authorization: string | null, nowMs = Date.now()): boolean {
  if (!secret) return false;
  const token = (authorization ?? '').replace(/^Bearer\s+/i, '').trim();
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) return false;
  let header: { alg?: string };
  let payload: { service?: string; exp?: number };
  try {
    header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8')) as { alg?: string };
    payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8')) as { service?: string; exp?: number };
  } catch {
    return false;
  }
  const alg = header.alg === 'HS512' ? 'sha512' : header.alg === 'HS256' ? 'sha256' : null;
  if (!alg || payload.service !== 'middleware') return false;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < nowMs) return false;
  return sameText(createHmac(alg, secret).update(`${h}.${p}`).digest('base64url'), s);
}

async function inboxPush(item: Record<string, unknown>) {
  await redis('RPUSH', YS_INBOX_KEY, JSON.stringify(item));
  await redis('LTRIM', YS_INBOX_KEY, -YS_INBOX_MAX, -1);
  await redis('EXPIRE', YS_INBOX_KEY, YS_INBOX_TTL_S);
}

async function yemeksepeti(req: Request, url: URL, path: string): Promise<Response> {
  const pluginSecret = env('YEMEKSEPETI_PLUGIN_SECRET');
  const wantRemote = env('YEMEKSEPETI_REMOTE_ID');
  const now = Date.now();
  // Kasanın çekimi ve silmesi: kafe anahtarıyla imzalı (LAFPOS_CLOUD_SECRET)
  if (path === 'yemeksepeti/inbox' || path === 'yemeksepeti/inbox/ack') {
    if (!secret() || secret().length < 32) return fail(503, 'LafPOS Uzaktan kurulmamış (LAFPOS_CLOUD_SECRET)', 'not_configured');
    const body = await req.text();
    if (!verifyPush(secret(), req, url, body)) return fail(401, 'İmza geçersiz', 'bad_signature');
    const raw = ((await redis('LRANGE', YS_INBOX_KEY, 0, -1)) as string[] | null) ?? [];
    if (path === 'yemeksepeti/inbox' && req.method === 'GET') {
      const items: unknown[] = [];
      for (const r of raw.slice(0, 50)) {
        try {
          items.push(JSON.parse(r));
        } catch {
          await redis('LREM', YS_INBOX_KEY, 1, r);
        }
      }
      return json({ items, total: raw.length });
    }
    if (path === 'yemeksepeti/inbox/ack' && req.method === 'POST') {
      let ids: string[] = [];
      try {
        const parsed = JSON.parse(body) as { ids?: unknown };
        ids = Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === 'string') : [];
      } catch {
        return fail(400, 'Gövde okunamadı', 'bad_body');
      }
      let removed = 0;
      for (const r of raw) {
        let id: unknown;
        try {
          id = (JSON.parse(r) as { id?: unknown }).id;
        } catch {
          continue;
        }
        if (typeof id === 'string' && ids.includes(id)) removed += Number(await redis('LREM', YS_INBOX_KEY, 1, r)) || 0;
      }
      return json({ ok: true, removed });
    }
    return fail(404, 'Yok', 'not_found');
  }
  // Delivery Hero'nun itmesi: JWT
  if (!pluginSecret) return fail(503, 'Yemeksepeti aktarıcısı kurulmamış (YEMEKSEPETI_PLUGIN_SECRET)', 'not_configured');
  if (!verifyMiddlewareJwt(pluginSecret, req.headers.get('authorization'), now)) return json({ reason: 'TECHNICAL_PROBLEM', message: 'Unauthorized' }, 401);
  const order = /^yemeksepeti\/order\/([^/]+)$/.exec(path);
  if (order && req.method === 'POST') {
    const remoteId = decodeURIComponent(order[1]!);
    if (wantRemote && remoteId !== wantRemote) return json({ reason: 'MENU_ACCOUNT_SETTINGS', message: 'Unknown remoteId' }, 400);
    const body = await req.text();
    if (body.length > 1_000_000) return json({ reason: 'TECHNICAL_PROBLEM', message: 'payload-limit-exceeded' }, 400);
    let dh: { token?: unknown };
    try {
      dh = JSON.parse(body) as { token?: unknown };
    } catch {
      return json({ reason: 'TECHNICAL_PROBLEM', message: 'json-not-readable' }, 400);
    }
    if (typeof dh.token !== 'string' || !dh.token) return json({ reason: 'TECHNICAL_PROBLEM', message: 'order-validation-error: token' }, 400);
    await inboxPush({ id: randomBytes(9).toString('base64url'), kind: 'order', remoteId, receivedAt: now, order: dh });
    // remoteOrderId: siparişin kasadaki kimliği olarak belirtecin kendisi (tekil); durum bildirimleri bununla gelir
    return json({ remoteResponse: { remoteOrderId: dh.token } });
  }
  const status = /^yemeksepeti\/remoteId\/([^/]+)\/remoteOrder\/([^/]+)\/posOrderStatus$/.exec(path);
  if (status && (req.method === 'PUT' || req.method === 'POST')) {
    const remoteId = decodeURIComponent(status[1]!);
    const remoteOrderId = decodeURIComponent(status[2]!);
    if (wantRemote && remoteId !== wantRemote) return fail(404, 'Unknown remoteId', 'not_found');
    let dh: { status?: unknown; message?: unknown };
    try {
      dh = JSON.parse(await req.text()) as { status?: unknown; message?: unknown };
    } catch {
      return fail(400, 'json-not-readable', 'bad_body');
    }
    if (typeof dh.status !== 'string') return fail(400, 'status', 'bad_body');
    await inboxPush({ id: randomBytes(9).toString('base64url'), kind: 'status', remoteId, receivedAt: now, remoteOrderId, status: dh.status, message: typeof dh.message === 'string' ? dh.message.slice(0, 500) : '' });
    return json({ ok: true });
  }
  return fail(404, 'Yok', 'not_found');
}

// ─── Demo ────────────────────────────────────────────────────────────────────

/**
 * Kafe bağlanana kadar (Redis'te kafeden gelmiş özet yokken) örnek gün parolasız gösterilir. Kafe ilk özeti itince
 * demo biter; gerçek veri her zaman parolalıdır. LAFPOS_UZAKTAN_DEMO=0 demoyu kapatır.
 */
const demoAllowed = () => env('LAFPOS_UZAKTAN_DEMO') !== '0' && demoBase() != null;
/**
 * İlk etapta kafe bağlanınca da gerçek görünüm parolasızdır (kullanıcı kararı, 27 Eki 2026): bağlantıyı bilen salt
 * okunur ekranları görür. LAFPOS_UZAKTAN_PAROLA_GEREKLI=1 patron parolasını geri açar.
 */
const passwordRequired = () => env('LAFPOS_UZAKTAN_PAROLA_GEREKLI') === '1';
/** Demo jetonunun anahtarı gizli değildir: yalnız örnek güne açılır, gerçek özet hiçbir zaman demo jetonuyla verilmez */
const demoKey = () => 'lafpos-uzaktan-demo';

/**
 * Demo özeti ilk gerektiğinde diskten okunur (vercel.json includeFiles). JSON import'u Vercel'in Node ESM'inde
 * öznitelik ister ve açılışta işlevi düşürür; okunamazsa yalnız demo kapanır.
 */
let demoCache: Snapshot | null | undefined;
function demoBase(): Snapshot | null {
  if (demoCache === undefined) {
    try {
      demoCache = JSON.parse(readFileSync(join(process.cwd(), 'api/demo-ozet.json'), 'utf8')) as Snapshot;
    } catch {
      demoCache = null;
    }
  }
  return demoCache;
}

/** Demo özetinin zaman damgaları şimdiye kaydırılır (süreler ve saatler taze görünsün) */
function demoNow(): Snapshot | null {
  const base = demoBase();
  if (!base) return null;
  const delta = Date.now() - base.at;
  const shift = (v: unknown): unknown => {
    if (typeof v === 'number') return v > 1.6e12 && v < 2.2e12 ? v + delta : v;
    if (Array.isArray(v)) return v.map(shift);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shift(x)]));
    return v;
  };
  return shift(base) as Snapshot;
}

async function realSnapshot(): Promise<Snapshot | null> {
  try {
    return await snapshot();
  } catch {
    return null;
  }
}

// ─── Uçlar ───────────────────────────────────────────────────────────────────

const ME = {
  id: 'uzaktan',
  name: 'Patron (uzaktan)',
  role: 'patron',
  color: '#0c0e1b',
  permissions: ['patron.panel', 'siparis.al', 'mutfak.ekran'],
  maxDiscountPct: 0,
};

async function handle(req: Request): Promise<Response> {
  const url = originalUrl(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  // Kurulum durumu (giriş ekranı gösterir): yalnız var/yok, hiçbir değer dönmez; anahtar olmadan da açıktır
  if (path === 'uzaktan/kurulum') {
    const redisSet = !!((env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL')) && (env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN')));
    let snapshotAt: number | null = null;
    let redisOk = false;
    if (redisSet) {
      try {
        snapshotAt = (await snapshot())?.at ?? null;
        redisOk = true;
      } catch {
        redisOk = false;
      }
    }
    return json({ secret: secret().length >= 32, password: !passwordRequired() || env('LAFPOS_UZAKTAN_PAROLA').length >= 10, redis: redisOk, snapshotAt, demo: demoAllowed() && snapshotAt == null, open: !passwordRequired(), yemeksepeti: !!env('YEMEKSEPETI_PLUGIN_SECRET') });
  }
  // Yemeksepeti aktarıcısı: makineden makineye, demo ve parola kapısından önce
  if (path.startsWith('yemeksepeti/')) return yemeksepeti(req, url, path);
  // Kafe bağlanmadıysa demo: anahtar ve parola gerekmez, yalnız örnek gün açılır (kafe itmesi aşağıda, anahtarla)
  if (path !== 'uzaktan/push' && demoAllowed() && !(await realSnapshot())) {
    if (path === 'health') return json({ ok: true, remote: true, demo: true, time: Date.now() });
    if (path === 'uzaktan/giris' && req.method === 'POST') return json({ token: issueToken(demoKey()), me: ME, demo: true });
    const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (!tokenValid(demoKey(), auth)) return fail(401, 'Oturum kapalı. Yeniden girin', 'unauthorized');
    if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');
    return serve(demoNow(), path, url, true);
  }
  if (!secret() || secret().length < 32) return fail(503, 'LafPOS Uzaktan kurulmamış (LAFPOS_CLOUD_SECRET)', 'not_configured');

  if (path === 'health') return json({ ok: true, remote: true, time: Date.now() });

  // Kafedeki sunucunun itmesi: imza, sonra gzip açılır ve saklanır
  if (path === 'uzaktan/push' && req.method === 'POST') {
    const body = await req.text();
    if (body.length > 4_000_000) return fail(413, 'Özet çok büyük', 'too_large');
    if (!verifyPush(secret(), req, url, body)) return fail(401, 'İmza geçersiz', 'bad_signature');
    let snap: Snapshot;
    try {
      snap = JSON.parse(gunzipSync(Buffer.from((JSON.parse(body) as { gz: string }).gz, 'base64')).toString('utf8')) as Snapshot;
    } catch {
      return fail(400, 'Özet okunamadı', 'bad_body');
    }
    // Eski (yeniden gönderilen) özet yenisini ezmez
    const current = await snapshot();
    if (current && typeof snap.at === 'number' && snap.at <= current.at) return json({ ok: true, stale: true });
    await redis('SET', SNAPSHOT_KEY, JSON.stringify(snap), 'EX', 7 * 86400);
    return json({ ok: true });
  }

  // Parolasız görünüm (varsayılan): giriş parola sormadan salt okunur oturum açar
  if (path === 'uzaktan/giris' && req.method === 'POST' && !passwordRequired()) return json({ token: issueToken(secret()), me: ME });

  // Patron girişi: parola, IP başına 15 dakikada en çok 8 deneme
  if (path === 'uzaktan/giris' && req.method === 'POST') {
    const password = env('LAFPOS_UZAKTAN_PAROLA');
    if (password.length < 10) return fail(503, 'Uzaktan parola tanımlı değil (LAFPOS_UZAKTAN_PAROLA)', 'not_configured');
    const ip = (req.headers.get('x-forwarded-for') ?? 'yok').split(',')[0]!.trim();
    const key = `lafpos:giris:${ip}`;
    const tries = Number(await redis('INCR', key));
    if (tries === 1) await redis('EXPIRE', key, 900);
    if (tries > LOGIN_LIMIT) return fail(429, 'Çok fazla deneme; 15 dakika sonra yeniden deneyin', 'rate_limited');
    const given = String(((await req.json().catch(() => ({}))) as { parola?: unknown }).parola ?? '');
    if (!sameText(createHash('sha256').update(given).digest('hex'), createHash('sha256').update(password).digest('hex'))) {
      return fail(401, 'Parola yanlış', 'bad_password');
    }
    await redis('DEL', key);
    return json({ token: issueToken(secret()), me: ME });
  }

  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!tokenValid(secret(), auth)) return fail(401, 'Oturum kapalı. Parolayla yeniden girin', 'unauthorized');
  if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');
  return serve(await snapshot(), path, url, false);
}

/** Salt okunur uçlar: kafeden gelen ya da demo özetinden */
function serve(snap: Snapshot | null, path: string, url: URL, demo: boolean): Response {
  if (path === 'auth/me') return json(ME);
  if (path === 'uzaktan/durum') return json({ at: snap?.at ?? null, demo });
  if (!snap) return fail(503, 'Kafeden henüz veri gelmedi; kasa bilgisayarı açık ve LAFPOS_CLOUD_URL tanımlı mı?', 'no_snapshot');
  if (path === 'bootstrap') return json({ ...snap.bootstrap, me: ME });
  if (path === 'reports/patron') return json(snap.patron);
  if (path === 'floor') return json(snap.floor);
  if (path === 'kitchen') return json(url.searchParams.get('history') === '1' ? [] : snap.kitchen);
  if (path === 'kitchen/board') return json(snap.board);
  const order = /^orders\/([A-Za-z0-9]+)$/.exec(path);
  if (order) return snap.orders[order[1]!] ? json(snap.orders[order[1]!]) : fail(404, 'Adisyon kapanmış ya da yok', 'not_found');
  return fail(404, 'Uzaktan görünümde yok', 'not_found');
}

async function safe(req: Request): Promise<Response> {
  try {
    return await handle(req);
  } catch (e) {
    const missing = e instanceof Error && e.message === 'redis_missing';
    return fail(503, missing ? 'Upstash Redis bağlı değil (Vercel › Storage)' : 'Uzaktan görünüm şu an yanıt veremiyor', missing ? 'redis_missing' : 'internal');
  }
}

export const GET = safe;
export const POST = safe;
export const PUT = safe;
export const PATCH = safe;
export const DELETE = safe;
