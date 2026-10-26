/**
 * LafPOS Uzaktan (Vercel işlevi). Kafedeki LafPOS sunucusu canlı özetini imzalı olarak buraya iter
 * (server/sync/cloud.ts); patron parolasıyla giren tarayıcı aynı arayüzü salt okunur görür. Kasa yerelde kalır.
 *
 * Ortam: LAFPOS_CLOUD_SECRET (kafedekiyle aynı, en az 32), LAFPOS_UZAKTAN_PAROLA (en az 10), Upstash Redis
 * (KV_REST_API_URL + KV_REST_API_TOKEN ya da UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Kendi içinde: Vercel her dosyayı ayrı derler, göreli içe aktarma çalışma anında kırılabilir. İmza kuralı
 * server/lib/signature.ts ile aynı (tests/cloud-api.test.ts denetler). Ayrıntı: docs/07-UZAKTAN-ERISIM.md
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
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
    return json({ secret: secret().length >= 32, password: env('LAFPOS_UZAKTAN_PAROLA').length >= 10, redis: redisOk, snapshotAt });
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

  const auth = req.headers.get('authorization') ?? '';
  if (!tokenValid(secret(), auth.replace(/^Bearer\s+/i, ''))) return fail(401, 'Oturum kapalı. Parolayla yeniden girin', 'unauthorized');
  if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');

  if (path === 'auth/me') return json(ME);
  const snap = await snapshot();
  if (path === 'uzaktan/durum') return json({ at: snap?.at ?? null });
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
