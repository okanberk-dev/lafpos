/**
 * LafPOS Uzaktan (Vercel işlevi). Kafedeki LafPOS sunucusu canlı özetini imzalı olarak buraya iter
 * (server/sync/cloud.ts); patron parolasıyla giren tarayıcı aynı arayüzü salt okunur görür. Kasa yerelde kalır.
 *
 * Ortam: LAFPOS_CLOUD_SECRET (kafedekiyle aynı, en az 32), LAFPOS_UZAKTAN_PAROLA (en az 10), Upstash Redis
 * (KV_REST_API_URL + KV_REST_API_TOKEN ya da UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).
 * Yemeksepeti aktarıcısı (`/api/yemeksepeti/*`, aşağıda): YEMEKSEPETI_PLUGIN_SECRET (Delivery Hero'nun JWT anahtarı),
 * isteğe bağlı YEMEKSEPETI_REMOTE_ID (yalnız bu restoranın siparişleri). Getir aktarıcısı (`/api/getir/*`):
 * GETIR_WEBHOOK_SECRET (bizim ürettiğimiz, Getir'e x-api-key olarak verilen anahtar, en az 16, öteki anahtarlardan
 * ayrı), isteğe bağlı GETIR_RESTAURANT_ID.
 * Kendi içinde: Vercel her dosyayı ayrı derler, göreli içe aktarma çalışma anında kırılabilir. İmza kuralı
 * server/lib/signature.ts ile aynı (tests/cloud-api.test.ts denetler). Ayrıntı: docs/07-UZAKTAN-ERISIM.md
 */
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bildirim, broadcast } from './_bildirim.js';
import { yedek } from './_yedek.js';
import { merkez, type Release } from './_merkez.js';
import { gunzipSync } from 'node:zlib';
import type { RemoteDayExtra, RemoteDayReport, RemoteReportPush } from '../shared/remote-reports';
import { type CheckRow, crossPayIn, type ItemListRow, mergeChecks, mergeOdenmez, mergePlatforms, mergeRows, prepFrom } from '../shared/remote-calc.js';
import { CSV_TYPES, type CsvType, csvRows, toCsv } from '../shared/report-csv.js';

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

// ─── Üyelik: e-posta ve parola ───────────────────────────────────────────────

/** Üye oturumu 30 gün: patron telefonda her gün yeniden parola yazmaz; parola değişince hepsi düşer */
const MEMBER_DAYS = 30;
const normalizeEmail = (v: unknown) => String(v ?? '').trim().toLowerCase();
/**
 * Üye olabilecek e-postalar (LAFPOS_UYE_EPOSTA, virgülle). Tanımlıysa "Üye girişi" e-posta ve parolayla çalışır ve
 * gerçek veri yalnız üyeye açılır. Parola ortam değişkeninde durmaz: üye ilk girişte kendisi belirler, Redis'te
 * yalnız özeti (scrypt) saklanır. İlk girişte davet kodu (LAFPOS_UYE_DAVET, en az 8) istenir: e-postayı bilen
 * başkası üyeliği sahipten önce açamaz. Kod tanımlı değilse üyelik açılmaz.
 */
export const memberEmails = () => [...new Set(env('LAFPOS_UYE_EPOSTA').split(',').map(normalizeEmail).filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)))];
const memberKey = (email: string) => `lafpos:uye:${email}`;
const inviteCode = () => env('LAFPOS_UYE_DAVET');
/** Davet kodu büyük-küçük harf, boşluk ve tireye bakmadan karşılaştırılır (telefonda elle yazılır) */
const normalizeInvite = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]+/g, '');

export function hashPassword(password: string, salt: Buffer = randomBytes(16)): string {
  return `s1$${salt.toString('base64url')}$${scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 }).toString('base64url')}`;
}

export function passwordMatches(stored: string, given: string): boolean {
  const [kind, salt] = stored.split('$');
  if (kind !== 's1' || !salt) return false;
  return sameText(stored, hashPassword(given, Buffer.from(salt, 'base64url')));
}

/** Üye belirteci: süre.nonce~eposta.imza; imzaya parola özeti girer (parola değişince düşer) */
const memberSig = (key: string, hash: string, body: string) =>
  createHmac('sha256', key).update(`uye:${createHash('sha256').update(hash).digest('hex').slice(0, 16)}:${body}`).digest('base64url');

export function issueMemberToken(key: string, email: string, hash: string, nowMs = Date.now()): string {
  const exp = Math.floor(nowMs / 1000) + MEMBER_DAYS * 86400;
  const body = `${exp}.${randomBytes(9).toString('base64url')}~${Buffer.from(email).toString('base64url')}`;
  return `${body}.${memberSig(key, hash, body)}`;
}

/** Belirteç üye belirteciyse e-postası (imza ayrıca doğrulanır) */
export function memberTokenEmail(token: string): string | null {
  const mark = (token.split('.')[1] ?? '').split('~')[1];
  return mark ? normalizeEmail(Buffer.from(mark, 'base64url').toString('utf8')) : null;
}

export function memberTokenValid(key: string, token: string, hash: string, nowMs = Date.now()): boolean {
  const [exp, nonce, sig] = token.split('.');
  if (!exp || !nonce || !sig || Number(exp) * 1000 < nowMs) return false;
  return sameText(sig, memberSig(key, hash, `${exp}.${nonce}`));
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

interface Member {
  /** Parolanın özeti (hashPassword) */
  h: string;
  at: number;
}

/** Üye kaydı; oturum denetiminde bir dakika bellekte tutulur (sayfa 10 sn'de bir yenilenir, her istekte Redis'e gidilmez) */
const memberCache = new Map<string, { at: number; value: Member | null }>();
async function member(email: string, fresh = false): Promise<Member | null> {
  const hit = memberCache.get(email);
  if (!fresh && hit && Date.now() - hit.at < 60_000) return hit.value;
  const raw = (await redis('GET', memberKey(email))) as string | null;
  const value = raw ? (JSON.parse(raw) as Member) : null;
  memberCache.set(email, { at: Date.now(), value });
  return value;
}

/** Güncelleme kanalının son derlemesi (aynı sitenin statik surum.json'u); bir dakika bellekte */
let releaseCache: { at: number; value: Release | null } | null = null;
async function latestRelease(origin: string): Promise<Release | null> {
  if (releaseCache && Date.now() - releaseCache.at < 60_000) return releaseCache.value;
  let value: Release | null = null;
  try {
    const res = await fetch(`${origin}/guncelleme/surum.json`, { signal: AbortSignal.timeout(5000) });
    const m = res.ok ? ((await res.json()) as { version?: unknown; build?: unknown; date?: unknown; not?: unknown }) : null;
    if (m && typeof m.version === 'string' && Number.isInteger(m.build)) {
      value = { version: m.version, build: m.build as number, date: typeof m.date === 'string' ? m.date : '', not: typeof m.not === 'string' ? m.not.slice(0, 300) : null };
    }
  } catch {
    value = null;
  }
  releaseCache = { at: Date.now(), value };
  return value;
}

/** Testler: kanalın önbelleğini boşaltır */
export function resetReleaseCache() {
  releaseCache = null;
}

// ─── Dükkânlar: her kurulumun özeti ve raporları kendi anahtarında ──────────

/**
 * Dükkân kimliği kasanın Merkez kurulum kimliğidir (Merkez'e bağlı olmayan eski kasa: `default`). Kasa itmede
 * `x-laf-dukkan` başlığını gönderir; uzaktan görünüm seçili dükkânı aynı başlıkla ister. `default` özeti eski anahtarda
 * kalır (taşınmadan okunur); dükkânların son itme anı `lafpos:dukkanlar`'da (JSON)
 */
export const SHOP_RE = /^[a-z0-9-]{1,40}$/;
const SHOPS_KEY = 'lafpos:dukkanlar';
export const snapshotKey = (shop: string) => (shop === REPORT_SHOP ? SNAPSHOT_KEY : `${SNAPSHOT_KEY}:${shop}`);
const shopHeader = (req: Request) => {
  const v = (req.headers.get('x-laf-dukkan') ?? '').trim();
  return SHOP_RE.test(v) ? v : null;
};

async function shopMap(): Promise<Record<string, number>> {
  const raw = (await redis('GET', SHOPS_KEY)) as string | null;
  try {
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {};
  }
}

/** Görünümün dükkânı: istenen (başlık) ya da en son veri gönderen; hiç yoksa `default` */
async function viewShop(req: Request): Promise<string> {
  const asked = shopHeader(req);
  if (asked) return asked;
  const map = await shopMap();
  return Object.entries(map).sort((a, b) => b[1] - a[1])[0]?.[0] ?? REPORT_SHOP;
}

async function snapshot(shop: string = REPORT_SHOP): Promise<Snapshot | null> {
  const raw = (await redis('GET', snapshotKey(shop))) as string | null;
  return raw ? (JSON.parse(raw) as Snapshot) : null;
}

// ─── Platform aktarıcıları: gelen kutusu (Yemeksepeti ve Getir ortak) ───────

/**
 * Kasa kafe ağında olduğu için siparişi iten platform (Yemeksepeti, Getir) buraya iter; kayıt Redis listesine girer,
 * kasa listeyi kafe anahtarıyla imzalı olarak çeker (`GET /api/<platform>/inbox`) ve işlediğini siler
 * (`POST /api/<platform>/inbox/ack`). İptal bildirimleri ayrı listede: kasanın beklettiği siparişler (Kapalı) önlerini
 * tıkamasın, önce onlar verilir. Kabul, ret ve aşamalar kasadan platforma gider (server/delivery/*.ts).
 */
/** Sipariş belirteci en çok 512 karakter (Delivery Hero order.yaml; Getir kimliği 24 karakter) */
const INBOX_TOKEN_MAX = 512;
/** Gelen kutusu dolunca kırpılmaz (sipariş sessizce düşmesin): platforma 503 döner, o yeniden dener */
const INBOX_MAX = 500;
const INBOX_TTL_S = 2 * 86400;
const INBOX_ORDER_MAX_BYTES = 256 * 1024;
const INBOX_STATUS_MAX_BYTES = 8 * 1024;
/** Kasanın bir çekimde aldığı en çok kayıt ve bayt (Vercel yanıt sınırının altında) */
const INBOX_PULL_MAX = 50;
const INBOX_PULL_MAX_BYTES = 2 * 1024 * 1024;

/** Kaydın yaşı süreyi aştı mı (`receivedAt`; okunamayan kayıt yaşlı sayılmaz, bozuksa çekimde silinir) */
const aged = (raw: string, maxAgeMs: number | undefined, now: number) => {
  if (!maxAgeMs) return false;
  try {
    const at = (JSON.parse(raw) as { receivedAt?: unknown }).receivedAt;
    return typeof at === 'number' && now - at > maxAgeMs;
  } catch {
    return false;
  }
};

/**
 * Kaydı gelen kutusuna koyar; kutu doluysa koymaz (false): çağıran 503 döner, platform yeniden dener. `maxAgeMs`:
 * kayıt başına saklama süresi: baştaki (en eski) süresi geçmiş kayıtlar önce silinir (çekimde de). Liste süresi
 * (`ttlS`) her itmede yenilendiği için etkinlik yokken bir kaydın en uzun ömrü `maxAgeMs` + `ttlS`'dir
 */
async function inboxPush(item: Record<string, unknown>, key: string, maxAgeMs?: number, ttlS = INBOX_TTL_S): Promise<boolean> {
  if (maxAgeMs) {
    const now = Date.now();
    const head = ((await redis('LRANGE', key, 0, INBOX_PULL_MAX - 1)) as string[] | null) ?? [];
    for (const r of head) {
      if (!aged(r, maxAgeMs, now)) break;
      await redis('LREM', key, 1, r);
    }
  }
  const size = Number(await redis('LLEN', key)) || 0;
  if (size >= INBOX_MAX) return false;
  await redis('RPUSH', key, JSON.stringify(item));
  await redis('EXPIRE', key, ttlS);
  return true;
}

/**
 * Kasanın çekimi ve silmesi (kafe anahtarıyla imzalı, LAFPOS_CLOUD_SECRET): `GET <prefix>/inbox` önce durum (iptal)
 * listesini sonra siparişleri verir (en çok 50 kayıt ve 2 MB; bozuk ya da tek başına sınırı aşan kayıt silinir),
 * `POST <prefix>/inbox/ack` {ids} işlenenleri siler. `maxAgeMs` verilmişse süresi geçmiş kayıt verilmez, silinir. Yol bu
 * ikisinden değilse null
 */
async function inboxRoutes(req: Request, url: URL, path: string, prefix: string, keys: readonly string[], maxAgeMs?: number): Promise<Response | null> {
  if (path !== `${prefix}/inbox` && path !== `${prefix}/inbox/ack`) return null;
  if (!secret() || secret().length < 32) return fail(503, 'LafPOS Uzaktan kurulmamış (LAFPOS_CLOUD_SECRET)', 'not_configured');
  const body = await req.text();
  if (!verifyPush(secret(), req, url, body)) return fail(401, 'İmza geçersiz', 'bad_signature');
  if (path === `${prefix}/inbox` && req.method === 'GET') {
    const items: unknown[] = [];
    let bytes = 0;
    for (const key of keys) {
      const room = INBOX_PULL_MAX - items.length;
      if (room <= 0) break;
      const raw = ((await redis('LRANGE', key, 0, room - 1)) as string[] | null) ?? [];
      for (const r of raw) {
        if (r.length > INBOX_PULL_MAX_BYTES || aged(r, maxAgeMs, Date.now())) {
          await redis('LREM', key, 1, r);
          continue;
        }
        if (bytes + r.length > INBOX_PULL_MAX_BYTES) break;
        try {
          items.push(JSON.parse(r));
          bytes += r.length;
        } catch {
          await redis('LREM', key, 1, r);
        }
      }
    }
    let total = 0;
    for (const key of keys) total += Number(await redis('LLEN', key)) || 0;
    return json({ items, total });
  }
  if (path === `${prefix}/inbox/ack` && req.method === 'POST') {
    let ids: string[] = [];
    try {
      const parsed = JSON.parse(body) as { ids?: unknown };
      ids = Array.isArray(parsed.ids) ? parsed.ids.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return fail(400, 'Gövde okunamadı', 'bad_body');
    }
    let removed = 0;
    for (const key of keys) {
      const raw = ((await redis('LRANGE', key, 0, -1)) as string[] | null) ?? [];
      for (const r of raw) {
        let id: unknown;
        try {
          id = (JSON.parse(r) as { id?: unknown }).id;
        } catch {
          continue;
        }
        if (typeof id === 'string' && ids.includes(id)) removed += Number(await redis('LREM', key, 1, r)) || 0;
      }
    }
    return json({ ok: true, removed });
  }
  return fail(404, 'Yok', 'not_found');
}

// ─── Yemeksepeti aktarıcısı: Delivery Hero POS plugin uçları ────────────────

/**
 * Delivery Hero siparişi buraya iter (plugin.yaml `POST /order/{remoteId}` ve
 * `PUT /remoteId/{remoteId}/remoteOrder/{remoteOrderId}/posOrderStatus`); istek `service: middleware` iddialı, bize
 * verilen anahtarla imzalı bir JWT taşır. Sipariş `remoteOrderId` (= sipariş belirteci) ile saniyeler içinde
 * onaylanır. Kabul ve ret kasadan middleware'e gider (server/delivery/yemeksepeti.ts).
 */
const YS_INBOX_KEY = 'lafpos:ys:inbox';
const YS_STATUS_KEY = 'lafpos:ys:status';

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
  // JSON.parse null, sayı ya da dizi de döndürebilir: nesne değilse geçersiz
  if (!header || typeof header !== 'object' || !payload || typeof payload !== 'object') return false;
  const alg = header.alg === 'HS512' ? 'sha512' : header.alg === 'HS256' ? 'sha256' : null;
  if (!alg || payload.service !== 'middleware') return false;
  if (typeof payload.exp === 'number' && payload.exp * 1000 < nowMs) return false;
  return sameText(createHmac(alg, secret).update(`${h}.${p}`).digest('base64url'), s);
}

async function yemeksepeti(req: Request, url: URL, path: string): Promise<Response> {
  const pluginSecret = env('YEMEKSEPETI_PLUGIN_SECRET');
  const wantRemote = env('YEMEKSEPETI_REMOTE_ID');
  const now = Date.now();
  // Kasanın çekimi ve silmesi: kafe anahtarıyla imzalı (LAFPOS_CLOUD_SECRET)
  const inbox = await inboxRoutes(req, url, path, 'yemeksepeti', [YS_STATUS_KEY, YS_INBOX_KEY]);
  if (inbox) return inbox;
  // Delivery Hero'nun itmesi: JWT
  if (!pluginSecret) return fail(503, 'Yemeksepeti aktarıcısı kurulmamış (YEMEKSEPETI_PLUGIN_SECRET)', 'not_configured');
  if (!verifyMiddlewareJwt(pluginSecret, req.headers.get('authorization'), now)) return json({ reason: 'TECHNICAL_PROBLEM', message: 'Unauthorized' }, 401);
  const order = /^yemeksepeti\/order\/([^/]+)$/.exec(path);
  if (order && req.method === 'POST') {
    const remoteId = decodeURIComponent(order[1]!);
    if (wantRemote && remoteId !== wantRemote) return json({ reason: 'MENU_ACCOUNT_SETTINGS', message: 'Unknown remoteId' }, 400);
    const body = await req.text();
    if (body.length > INBOX_ORDER_MAX_BYTES) return json({ reason: 'TECHNICAL_PROBLEM', message: 'payload-limit-exceeded' }, 400);
    let dh: { token?: unknown };
    try {
      dh = JSON.parse(body) as { token?: unknown };
    } catch {
      return json({ reason: 'TECHNICAL_PROBLEM', message: 'json-not-readable' }, 400);
    }
    if (typeof dh.token !== 'string' || !dh.token || dh.token.length > INBOX_TOKEN_MAX) return json({ reason: 'TECHNICAL_PROBLEM', message: 'order-validation-error: token' }, 400);
    if (!(await inboxPush({ id: randomBytes(9).toString('base64url'), kind: 'order', remoteId, receivedAt: now, order: dh }, YS_INBOX_KEY))) {
      return json({ reason: 'TECHNICAL_PROBLEM', message: 'inbox-full' }, 503);
    }
    // remoteOrderId: siparişin kasadaki kimliği olarak belirtecin kendisi (tekil); durum bildirimleri bununla gelir
    return json({ remoteResponse: { remoteOrderId: dh.token } });
  }
  const status = /^yemeksepeti\/remoteId\/([^/]+)\/remoteOrder\/([^/]+)\/posOrderStatus$/.exec(path);
  if (status && (req.method === 'PUT' || req.method === 'POST')) {
    const remoteId = decodeURIComponent(status[1]!);
    const remoteOrderId = decodeURIComponent(status[2]!);
    if (remoteOrderId.length > INBOX_TOKEN_MAX) return fail(400, 'remoteOrderId', 'bad_body');
    if (wantRemote && remoteId !== wantRemote) return fail(404, 'Unknown remoteId', 'not_found');
    const text = await req.text();
    if (text.length > INBOX_STATUS_MAX_BYTES) return fail(400, 'payload-limit-exceeded', 'bad_body');
    let dh: { status?: unknown; message?: unknown };
    try {
      dh = JSON.parse(text) as { status?: unknown; message?: unknown };
    } catch {
      return fail(400, 'json-not-readable', 'bad_body');
    }
    if (!dh || typeof dh.status !== 'string') return fail(400, 'status', 'bad_body');
    // Kasa yalnız iptali kullanır; ötekiler (kurye geldi, alındı, uyarılar) kutuyu doldurmasın
    if (dh.status !== 'ORDER_CANCELLED') return json({ ok: true });
    const item = { id: randomBytes(9).toString('base64url'), kind: 'status', remoteId, receivedAt: now, remoteOrderId, status: dh.status, message: typeof dh.message === 'string' ? dh.message.slice(0, 500) : '' };
    if (!(await inboxPush(item, YS_STATUS_KEY))) return fail(503, 'inbox-full', 'inbox_full');
    return json({ ok: true });
  }
  return fail(404, 'Yok', 'not_found');
}

// ─── Getir aktarıcısı: GetirFood webhook uçları ──────────────────────────────

/**
 * Getir siparişi bizim verdiğimiz iki adrese iter (belge "Integration Structure": yeni sipariş ve iptal; ikisinde de
 * bizim belirlediğimiz `x-api-key` başlığı): `POST /api/getir/order` ve `POST /api/getir/cancel`. Anahtar
 * GETIR_WEBHOOK_SECRET (biz üretiriz, Getir'e veririz; en az 16 karakter, LAFPOS_CLOUD_SECRET'ten ve Yemeksepeti
 * anahtarından ayrı), sabit zamanlı karşılaştırılır. Sipariş kaydı yalnız kasanın okuduğu alanlarla (konumsuz; Getir
 * kuryesinde telefonsuz ve adressiz; tek telefon: kasanın kullandığı), iptal kaydı yalnız sipariş kimliği ve nedeniyle
 * (serbest metin not saklanmaz). Kayıt 1 gün sonra verilmez ve silinir, liste 1 gün etkinliksiz kalınca düşer:
 * etkinlik olmasa da hiçbir kayıt 2 günden uzun kalmaz. Kabul, ret ve aşamalar kasadan Getir'e gider
 * (server/delivery/getir.ts).
 */
const GETIR_INBOX_KEY = 'lafpos:getir:inbox';
const GETIR_STATUS_KEY = 'lafpos:getir:status';
const GETIR_SECRET_MIN = 16;
/**
 * Getir kaydı kayıt başına 1 gün (Getir siparişi 5 dk'da yanıt ister; eskisi işe yaramaz), liste süresi de 1 gün:
 * itme ve çekim olmasa da kişisel veri en çok 2 gün kalır
 */
const GETIR_MAX_AGE_MS = 86_400_000;
const GETIR_LIST_TTL_S = 86_400;

/**
 * Getir'e verilen anahtar: en az 16 karakter ve kafenin ana imza anahtarından (LAFPOS_CLOUD_SECRET) ve Yemeksepeti'nin
 * anahtarından ayrı. Üçüncü tarafa verilen değer gelen kutularını okuyup silen, özeti ezen anahtar olamaz: eşitse
 * aktarıcı kurulmamış sayılır (boş döner)
 */
function getirKey(): string {
  const key = env('GETIR_WEBHOOK_SECRET');
  if (key.length < GETIR_SECRET_MIN || key === secret() || key === env('YEMEKSEPETI_PLUGIN_SECRET')) return '';
  return key;
}

type GetirPush = { id?: unknown; deliveryType?: unknown; restaurant?: { id?: unknown }; client?: Record<string, unknown>; courier?: unknown; cancelNote?: unknown; cancelReason?: { messages?: { tr?: unknown; en?: unknown } } };

const filled = (v: unknown) => (typeof v === 'string' && v.trim() ? v : undefined);

/**
 * Saklanacak sipariş: yalnız kasanın okuduğu alanlar. Konum (müşteri ve kurye) ve kurye hiç saklanmaz; Getir
 * kuryesinde (deliveryType 1) müşterinin telefonu ve adresi de (kasa onları kullanmaz). Kendi kuryemizde tek telefon:
 * kasanın seçtiği (iletişim, maskeli, ancak ikisi yoksa maskesiz numara; server/delivery/getir.ts fromGetirOrder)
 */
export function slimGetirOrder(order: GetirPush): Record<string, unknown> {
  const { client, courier: _courier, cancelNote: _note, cancelReason: _reason, ...rest } = order;
  const c = client && typeof client === 'object' ? client : null;
  const phone = c ? (filled(c.contactPhoneNumber) ?? filled(c.clientPhoneNumber) ?? filled(c.clientUnmaskedPhoneNumber)) : undefined;
  const contact = order.deliveryType !== 1 && c ? { contactPhoneNumber: phone, deliveryAddress: c.deliveryAddress } : {};
  return { ...rest, ...(c ? { client: { name: c.name, ...contact } } : {}) };
}

/** Getir'in `x-api-key` başlığı bizim verdiğimiz anahtar mı (sabit zamanlı) */
export function verifyApiKey(expected: string, given: string | null): boolean {
  if (!expected || expected.length < GETIR_SECRET_MIN) return false;
  return sameText((given ?? '').trim(), expected);
}

async function getir(req: Request, url: URL, path: string): Promise<Response> {
  const now = Date.now();
  // Kasanın çekimi ve silmesi: kafe anahtarıyla imzalı (LAFPOS_CLOUD_SECRET)
  const inbox = await inboxRoutes(req, url, path, 'getir', [GETIR_STATUS_KEY, GETIR_INBOX_KEY], GETIR_MAX_AGE_MS);
  if (inbox) return inbox;
  // Getir'in itmesi: x-api-key
  const key = getirKey();
  if (!key) return fail(503, 'Getir aktarıcısı kurulmamış (GETIR_WEBHOOK_SECRET: en az 16 karakter, öteki anahtarlardan ayrı)', 'not_configured');
  if (!verifyApiKey(key, req.headers.get('x-api-key'))) return fail(401, 'Unauthorized', 'unauthorized');
  if ((path !== 'getir/order' && path !== 'getir/cancel') || req.method !== 'POST') return fail(404, 'Yok', 'not_found');
  const body = await req.text();
  if (body.length > INBOX_ORDER_MAX_BYTES) return fail(400, 'payload-limit-exceeded', 'too_large');
  let order: GetirPush;
  try {
    order = JSON.parse(body) as typeof order;
  } catch {
    return fail(400, 'json-not-readable', 'bad_body');
  }
  if (!order || typeof order !== 'object' || typeof order.id !== 'string' || !order.id || order.id.length > INBOX_TOKEN_MAX) return fail(400, 'order id', 'bad_body');
  const wantRestaurant = env('GETIR_RESTAURANT_ID');
  if (wantRestaurant && order.restaurant?.id !== wantRestaurant) return fail(400, 'Unknown restaurant', 'bad_restaurant');
  const id = randomBytes(9).toString('base64url');
  if (path === 'getir/order') {
    if (!(await inboxPush({ id, kind: 'order', receivedAt: now, order: slimGetirOrder(order) }, GETIR_INBOX_KEY, GETIR_MAX_AGE_MS, GETIR_LIST_TTL_S))) return fail(503, 'inbox-full', 'inbox_full');
    return json({ ok: true });
  }
  const msg = order.cancelReason?.messages;
  const reason = typeof msg?.tr === 'string' ? msg.tr : typeof msg?.en === 'string' ? msg.en : '';
  // Yalnız kimlik ve neden (seçenek metni): müşterinin ya da temsilcinin serbest metin notu kişisel veri taşıyabilir, kasa okumaz
  const item = { id, kind: 'cancel', receivedAt: now, orderId: order.id, reason: reason.slice(0, 500) };
  if (!(await inboxPush(item, GETIR_STATUS_KEY, GETIR_MAX_AGE_MS, GETIR_LIST_TTL_S))) return fail(503, 'inbox-full', 'inbox_full');
  return json({ ok: true });
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

/** Kafeden gerçek veri geldi mi (herhangi bir dükkân; eski kasa yalnız `default`) */
async function realSnapshot(): Promise<boolean> {
  try {
    if (Object.keys(await shopMap()).length) return true;
    return !!(await snapshot());
  } catch {
    return false;
  }
}

// ─── Raporlar: kasanın günlük özetlerinden (server/sync/cloud-reports.ts) ────

/**
 * Kasa her iş gününün rapor özetini iter (`POST /api/uzaktan/rapor`, imzalı, gzip); gün başına bir anahtar, süresi
 * günün kendisinden 420 gün (EXAT). Raporlar sayfasının uçları (`reports/summary`, `hourly`, `products`, `staff`)
 * dönemin günlerini toplar; kural kasadaki server/services/reports.ts ile aynı (tests/uzaktan-raporlar.test.ts iki
 * tarafı aynı veriyle karşılaştırır). Dükkân kimliği anahtarın parçası: Merkez gelince `default` yerine dükkân
 */
export const REPORT_SHOP = 'default';
export const REPORT_MAX_DAYS = 400;
const REPORT_KEEP_DAYS = 420;
const REPORT_PUSH_MAX_DAYS = 31;
const REPORT_DAY_MAX_BYTES = 256 * 1024;
/** Ek sekmelerin günlük verisi (adisyon listesi en büyüğü): Upstash'in değer sınırının altında */
const REPORT_EXTRA_MAX_BYTES = 900 * 1024;
const MGET_CHUNK = 60;
const ROLLOVER_HOUR = 5;
export const reportDayKey = (shop: string, date: string) => `lafpos:rapor:${shop}:gun:${date}`;
export const reportMetaKey = (shop: string) => `lafpos:rapor:${shop}:son`;
export const reportExtraKey = (shop: string, date: string) => `lafpos:rapor:${shop}:ek:${date}`;

type DayRep = RemoteDayReport;
type Range = { from: string; to: string };

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export function isCalendarDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d));
  return y >= 1000 && t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
const dayStartMs = (date: string) => {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d, ROLLOVER_HOUR - 3, 0, 0);
};
const dayCount = (r: Range) => Math.round((Date.parse(`${r.to}T00:00:00Z`) - Date.parse(`${r.from}T00:00:00Z`)) / 86400_000) + 1;
const datesOf = (r: Range) => Array.from({ length: Math.max(0, dayCount(r)) }, (_, i) => addDays(r.from, i));
/** İstanbul'un iş günü (sabit UTC+3, 05:00 kuralı) */
export const businessDateOf = (ms: number) => new Date(ms + 3 * 3600_000 - ROLLOVER_HOUR * 3600_000).toISOString().slice(0, 10);
const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0);
const change = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** server/services/reports.ts `comparison` ile aynı kural (testi iki tarafı karşılaştırır) */
export function remoteComparison(r: Range, nowMs: number, today: string): { range: Range; label: string; cutoffMs: number | null } {
  const len = dayCount(r);
  const [fy, fm, fd] = r.from.split('-').map(Number) as [number, number, number];
  let range: Range;
  let label: string;
  let shiftMs: number;
  if (fd === 1 && len <= 31 && r.to.slice(0, 7) === r.from.slice(0, 7)) {
    const prevMonthStart = new Date(Date.UTC(fy, fm - 2, 1)).toISOString().slice(0, 10);
    const prevMonthDays = new Date(Date.UTC(fy, fm - 1, 0)).getUTCDate();
    range = { from: prevMonthStart, to: addDays(prevMonthStart, Math.min(len, prevMonthDays) - 1) };
    label = 'önceki ayın aynı günleri';
    shiftMs = Date.parse(`${r.from}T00:00:00Z`) - Date.parse(`${prevMonthStart}T00:00:00Z`);
  } else {
    const back = Math.ceil(len / 7) * 7;
    range = { from: addDays(r.from, -back), to: addDays(r.to, -back) };
    label = back === 7 ? 'geçen haftanın aynı günleri' : `${back / 7} hafta önceki aynı günler`;
    shiftMs = back * 86400_000;
  }
  const partial = r.to === today;
  if (partial) label += ', aynı saate kadar';
  return { range, label, cutoffMs: partial ? nowMs - shiftMs : null };
}

/** Günün `cutoffMs`'e kadar kapanan satışı (dakika duyarlılığıyla); cutoff yoksa bütün gün */
export function salesUntil(d: DayRep, cutoffMs: number | null): { netSales: number; receipts: number } {
  if (cutoffMs == null) return { netSales: d.s.rev, receipts: d.s.receipts };
  const start = dayStartMs(d.date);
  let netSales = 0;
  let receipts = 0;
  for (const [m, sales, n] of d.closes) {
    if (start + m * 60_000 > cutoffMs) continue;
    netSales += sales;
    receipts += n;
  }
  return { netSales, receipts };
}

/** Raporlar › Ciro (`summaryReport`) günlük özetlerden. `prev`: kıyas döneminin günleri */
export function sumSummary(range: Range, days: DayRep[], prevDays: DayRep[], nowMs: number, today: string) {
  const sum = (f: (d: DayRep) => number) => days.reduce((a, d) => a + f(d), 0);
  const netSales = sum((d) => d.s.rev);
  const receipts = sum((d) => d.s.receipts);
  const pays = new Map<string, { name: string; zField: string; amount: number; count: number }>();
  const types = new Map<string, { type: string; orders: number; amount: number }>();
  const kdv = new Map<number, { rate: number; gross: number; base: number; kdv: number }>();
  for (const d of days) {
    for (const [name, zField, amount, count] of d.pay) {
      const row = pays.get(name) ?? { name, zField, amount: 0, count: 0 };
      row.amount += amount;
      row.count += count;
      pays.set(name, row);
    }
    for (const [type, orders, amount] of d.types) {
      const row = types.get(type) ?? { type, orders: 0, amount: 0 };
      row.orders += orders;
      row.amount += amount;
      types.set(type, row);
    }
    for (const [rate, gross, base, k] of d.kdv) {
      const row = kdv.get(rate) ?? { rate, gross: 0, base: 0, kdv: 0 };
      row.gross += gross;
      row.base += base;
      row.kdv += k;
      kdv.set(rate, row);
    }
  }
  const totalPaid = [...pays.values()].reduce((a, p) => a + p.amount, 0);
  const kdvTotal = [...kdv.values()].reduce((a, k) => a + k.kdv, 0);
  // Gün aşırı ödemeler: adisyonun günü döneme düşüyorsa kapanmış adisyonların ödemesidir (kasada dönem tek seferde okunur)
  const cross = crossPayIn(days.flatMap((d) => d.xpay ?? []), range.from, range.to).closed;
  const paidClosed = sum((d) => d.s.paidClosed) + cross;
  const guests = sum((d) => d.s.guests);
  const tableSales = sum((d) => d.s.tableSales);
  const cmp = remoteComparison(range, nowMs, today);
  const prev = prevDays.map((d) => salesUntil(d, cmp.cutoffMs));
  const prevNet = prev.reduce((a, p) => a + p.netSales, 0);
  const prevReceipts = prev.reduce((a, p) => a + p.receipts, 0);
  const byAmount = <T extends { amount: number }>(a: T, b: T) => b.amount - a.amount;
  return {
    range,
    asOf: nowMs,
    waterfall: { list: sum((d) => d.s.list), complimentary: sum((d) => d.s.comp), discounts: sum((d) => d.s.disc), service: sum((d) => d.s.svc), revenue: netSales, kdv: kdvTotal, netExKdv: netSales - kdvTotal },
    kdv: [...kdv.values()].sort((a, b) => a.rate - b.rate),
    reconciliation: { paidClosed, difference: paidClosed - netSales, paidOpen: sum((d) => d.s.paidOpen) - cross },
    tableSales,
    perGuest: guests ? Math.round(tableSales / guests) : null,
    days: sum((d) => d.n),
    netSales,
    gross: sum((d) => d.s.gross),
    discounts: sum((d) => d.s.disc),
    complimentary: sum((d) => d.s.comp),
    odenmez: sum((d) => d.s.odenmez),
    zayi: sum((d) => d.s.zayi),
    voided: sum((d) => d.s.voided),
    receipts,
    avgCheck: receipts ? Math.round(netSales / receipts) : 0,
    guests,
    itemsSold: sum((d) => d.s.items),
    tips: sum((d) => d.s.tips),
    byDay: days.map((d) => ({ date: d.date, netSales: d.s.rev, receipts: d.s.receipts, z: d.z, closed: d.closed })),
    payments: [...pays.values()].sort(byAmount).map((p) => ({ ...p, share: pct(p.amount, totalPaid) })),
    types: [...types.values()].sort(byAmount),
    online: { orders: sum((d) => d.s.onlineOrders), amount: sum((d) => d.s.onlineAmount) },
    previous: { range: cmp.range, label: cmp.label, netSales: prevNet, receipts: prevReceipts, change: change(netSales, prevNet) },
  };
}

const PARTS = [
  { key: 'sabah', label: 'Sabah', from: 6, to: 12 },
  { key: 'ogle', label: 'Öğle', from: 12, to: 17 },
  { key: 'aksam', label: 'Akşam', from: 17, to: 22 },
  { key: 'gece', label: 'Gece', from: 22, to: 30 },
];

/** Raporlar › Saatlik (`hourlyReport`): tek günde gün başından geçen saat (ertesi gün sonda), çok günde 24 saat */
export function sumHourly(range: Range, days: DayRep[]) {
  const single = range.from === range.to;
  const offsets = new Map<number, { revenue: number; orders: number }>();
  for (const d of days) {
    for (const [raw, revenue, orders] of d.hours) {
      const off = single ? raw : raw % 24;
      const row = offsets.get(off) ?? { revenue: 0, orders: 0 };
      row.revenue += revenue;
      row.orders += orders;
      offsets.set(off, row);
    }
  }
  const length = [...offsets.keys()].reduce((a, x) => Math.max(a, x + 1), 24);
  const hours = Array.from({ length }, (_, offset) => ({ hour: (offset + ROLLOVER_HOUR) % 24, offset, nextDay: offset >= 24, revenue: offsets.get(offset)?.revenue ?? 0, orders: offsets.get(offset)?.orders ?? 0 }));
  const total = hours.reduce((a, h) => a + h.revenue, 0);
  const active = hours.filter((h) => h.orders > 0);
  const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
  const week = Array.from({ length: 7 }, (_, i) => ({ weekday: i + 1, days: 0, hours: Array.from({ length: 24 }, () => 0) }));
  for (const d of days) {
    const w = week[weekdayOf(d.date) - 1]!;
    w.days += d.n;
    for (const [hour, v] of d.clock) w.hours[hour] = (w.hours[hour] ?? 0) + v;
  }
  for (const w of week) if (w.days > 1) w.hours = w.hours.map((v) => Math.round(v / w.days));
  const parts = PARTS.map((p) => {
    const hs = hours.filter((h) => (h.hour >= p.from && h.hour < p.to) || (p.to > 24 && h.hour < p.to - 24));
    const revenue = hs.reduce((a, h) => a + h.revenue, 0);
    return { key: p.key, label: p.label, revenue, orders: hs.reduce((a, h) => a + h.orders, 0), share: pct(revenue, total) };
  });
  return {
    range,
    total,
    days: days.reduce((a, d) => a + d.n, 0),
    hours,
    parts,
    busiest: active.length ? active.reduce((a, b) => (b.revenue > a.revenue ? b : a)) : null,
    quietest: active.length ? active.reduce((a, b) => (b.revenue <= a.revenue ? b : a)) : null,
    peaks: [...active].sort((a, b) => b.revenue - a.revenue).slice(0, 5),
    week,
  };
}

/** Raporlar › Ürünler (`productReport`, maliyetsiz): kategori ve personel adı en yeni günden */
export function sumProducts(range: Range, days: DayRep[], cat?: Record<string, string>) {
  const rows = new Map<string, { key: string; name: string; size: string; category: string; qty: number; revenue: number; complimentary: number; voided: number }>();
  for (const d of days) {
    for (const [key, name, size, category, qty, revenue, comp, voided] of d.prod) {
      const row = rows.get(key) ?? { key, name, size, category, qty: 0, revenue: 0, complimentary: 0, voided: 0 };
      // Kategori kasadaki gibi bugünkü (ürün kimliği anahtarın başı); eski kasanın itmesinde harita yoksa günün kendisi
      row.category = cat ? (cat[key.slice(0, key.lastIndexOf('|'))] ?? '') : category;
      row.qty += qty;
      row.revenue += revenue;
      row.complimentary += comp;
      row.voided += voided;
      rows.set(key, row);
    }
  }
  const list = [...rows.values()].filter((r) => r.qty > 0 || r.complimentary > 0 || r.voided > 0);
  const total = list.reduce((a, r) => a + r.revenue, 0);
  const cats = new Map<string, { name: string; qty: number; revenue: number }>();
  for (const r of list) {
    const k = r.category || 'Diğer';
    const c = cats.get(k) ?? { name: k, qty: 0, revenue: 0 };
    c.qty += r.qty;
    c.revenue += r.revenue;
    cats.set(k, c);
  }
  return {
    range,
    total,
    service: days.reduce((a, d) => a + d.s.svc, 0),
    products: list
      .sort((a, b) => b.revenue - a.revenue)
      .map((r) => ({ ...r, share: pct(r.revenue, total), avgPrice: r.qty ? Math.round(r.revenue / r.qty) : 0, cost: null, margin: null })),
    categories: [...cats.values()].sort((a, b) => b.revenue - a.revenue).map((c) => ({ ...c, share: pct(c.revenue, total) })),
  };
}

/** Raporlar › Personel (`staffReport`) */
export function sumStaff(range: Range, days: DayRep[]) {
  const rows = new Map<string, { userId: string; name: string; orders: number; revenue: number; voids: number; voidValue: number; comps: number; compValue: number; discounts: number; odenmez: number; odenmezValue: number }>();
  for (const d of days) {
    for (const [userId, name, orders, revenue, voids, voidValue, comps, compValue, discounts, odenmez, odenmezValue] of d.staff) {
      const r = rows.get(userId) ?? { userId, name, orders: 0, revenue: 0, voids: 0, voidValue: 0, comps: 0, compValue: 0, discounts: 0, odenmez: 0, odenmezValue: 0 };
      r.name = name;
      r.orders += orders;
      r.revenue += revenue;
      r.voids += voids;
      r.voidValue += voidValue;
      r.comps += comps;
      r.compValue += compValue;
      r.discounts += discounts;
      r.odenmez += odenmez;
      r.odenmezValue += odenmezValue;
      rows.set(userId, r);
    }
  }
  return { range, staff: [...rows.values()].sort((a, b) => b.revenue - a.revenue) };
}

/** İstenen dönem: kasadaki gibi (varsayılan bugün, ters verilirse çevrilir, en çok 400 gün); hatalıysa yanıt */
export function reportRange(url: URL, today: string): Range | Response {
  const from = url.searchParams.get('from') ?? today;
  const to = url.searchParams.get('to') ?? today;
  if (!isCalendarDate(from) || !isCalendarDate(to)) return fail(422, 'Tarih geçersiz', 'validation');
  const r = from <= to ? { from, to } : { from: to, to: from };
  if (dayCount(r) > REPORT_MAX_DAYS) return fail(422, `Rapor dönemi en çok ${REPORT_MAX_DAYS} gün olabilir; daha kısa bir aralık seçin`, 'range_too_long');
  return r;
}

/** Dönemin günleri, Redis'ten parça parça MGET (gün yoksa atlanır; iş günü açılmamış tarih) */
async function loadDays(shop: string, r: Range): Promise<DayRep[]> {
  const dates = datesOf(r);
  const out: DayRep[] = [];
  for (let i = 0; i < dates.length; i += MGET_CHUNK) {
    const keys = dates.slice(i, i + MGET_CHUNK).map((d) => reportDayKey(shop, d));
    const raw = ((await redis('MGET', ...keys)) as (string | null)[] | null) ?? [];
    for (const x of raw) {
      if (!x) continue;
      try {
        out.push(JSON.parse(x) as DayRep);
      } catch {
        /* bozuk kayıt atlanır */
      }
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Gelen günün biçimi: dizi alanları ve sayılar (kasa kendi biçimini yazar; bozuk kayıt saklanmaz) */
function validDay(d: unknown): d is DayRep {
  if (!d || typeof d !== 'object') return false;
  const x = d as Partial<DayRep>;
  return (
    x.v === 1 &&
    typeof x.date === 'string' &&
    isCalendarDate(x.date) &&
    typeof x.at === 'number' &&
    typeof x.n === 'number' &&
    !!x.s &&
    typeof x.s.rev === 'number' &&
    ['pay', 'types', 'kdv', 'closes', 'prod', 'hours', 'clock', 'staff', 'z'].every((k) => Array.isArray((x as Record<string, unknown>)[k]))
  );
}

/** Kasanın itmesi: imzalı, gzip; eski özet (aynı günün daha önce kurulmuşu) yenisini ezmez */
async function storeReports(body: string): Promise<Response> {
  let push: RemoteReportPush;
  try {
    push = JSON.parse(gunzipSync(Buffer.from((JSON.parse(body) as { gz: string }).gz, 'base64')).toString('utf8')) as RemoteReportPush;
  } catch {
    return fail(400, 'Rapor okunamadı', 'bad_body');
  }
  if (!push || push.v !== 1 || !/^[a-z0-9-]{1,40}$/.test(String(push.shop)) || !isCalendarDate(String(push.today)) || typeof push.at !== 'number' || !Array.isArray(push.days)) {
    return fail(400, 'Rapor biçimi geçersiz', 'bad_body');
  }
  if (push.days.length > REPORT_PUSH_MAX_DAYS) return fail(413, 'Bir itmede en çok 31 gün', 'too_large');
  // Ek sekmelerin verisi ayrı anahtarda (Ciro ve Ürünler her açılışta onu okumaz)
  const extras = new Map<string, RemoteDayExtra>();
  const days = push.days
    .filter(validDay)
    .map((d) => {
      const { x, ...rest } = d;
      if (x && typeof x === 'object' && JSON.stringify(x).length <= REPORT_EXTRA_MAX_BYTES) extras.set(d.date, x);
      return rest as DayRep;
    })
    .filter((d) => JSON.stringify(d).length <= REPORT_DAY_MAX_BYTES);
  const nowS = Math.floor(Date.now() / 1000);
  const keys = days.map((d) => reportDayKey(push.shop, d.date));
  const existing = keys.length ? (((await redis('MGET', ...keys)) as (string | null)[] | null) ?? []) : [];
  let stored = 0;
  for (const [i, d] of days.entries()) {
    const expireAt = Math.floor(dayStartMs(addDays(d.date, REPORT_KEEP_DAYS)) / 1000);
    if (expireAt <= nowS) continue;
    const old = existing[i];
    if (old) {
      try {
        if ((JSON.parse(old) as DayRep).at > d.at) continue;
      } catch {
        /* bozuksa üzerine yazılır */
      }
    }
    await redis('SET', keys[i]!, JSON.stringify(d), 'EXAT', expireAt);
    const x = extras.get(d.date);
    if (x) await redis('SET', reportExtraKey(push.shop, d.date), JSON.stringify(x), 'EXAT', expireAt);
    stored += 1;
  }
  const meta = (await redis('GET', reportMetaKey(push.shop))) as string | null;
  const prevAt = meta ? ((JSON.parse(meta) as { at?: number }).at ?? 0) : 0;
  const cat = push.cat && typeof push.cat === 'object' ? push.cat : undefined;
  if (push.at >= prevAt) await redis('SET', reportMetaKey(push.shop), JSON.stringify({ today: push.today, at: push.at, ...(cat ? { cat } : {}) }), 'EX', REPORT_KEEP_DAYS * 86400);
  return json({ ok: true, stored, skipped: push.days.length - stored });
}

/** Raporlar sayfasının uçları; null: rapor yolu değil */
/** Gerçek oturumun salt okunur uçları: seçili dükkânın raporları, özeti ve dükkân listesi */
async function viewer(req: Request, path: string, url: URL): Promise<Response> {
  if (path === 'uzaktan/dukkanlar') return json(await shopList());
  const shop = await viewShop(req);
  return (await serveReports(path, url, null, shop)) ?? serve(await snapshot(shop), path, url, false);
}

/** Dükkân seçicinin listesi: veri gönderen dükkânlar, Merkez'deki adlarıyla (anahtar ya da kimlik bilgisi dönmez) */
async function shopList(): Promise<{ id: string; ad: string | null; at: number }[]> {
  const map = await shopMap();
  const ids = Object.keys(map);
  if (!ids.length) return [];
  const raws = (await redis('MGET', ...ids.map((id) => `lafpos:merkez:kurulum:${id}`))) as (string | null)[];
  return ids
    .map((id, i) => {
      let ad: string | null = null;
      try {
        ad = raws[i] ? ((JSON.parse(raws[i]!) as { ad?: string | null }).ad ?? null) : null;
      } catch {
        ad = null;
      }
      return { id, ad, at: map[id]! };
    })
    .sort((a, b) => (a.ad ?? '\uffff').localeCompare(b.ad ?? '\uffff', 'tr'));
}

async function serveReports(path: string, url: URL, demo: Snapshot | null, shop: string = REPORT_SHOP): Promise<Response | null> {
  const kind = /^reports\/(summary|hourly|products|staff|prep|items|checks|refunds|platforms|export\.csv)$/.exec(path)?.[1];
  if (!kind) return null;
  const meta = demo ? null : (((await redis('GET', reportMetaKey(shop))) as string | null) ?? null);
  const live = meta ? (JSON.parse(meta) as { today: string; at: number; cat?: Record<string, string> }) : null;
  const today = demo ? String((demo.patron as { date?: string }).date ?? businessDateOf(demo.at)) : (live?.today ?? businessDateOf(Date.now()));
  const r = reportRange(url, today);
  if (r instanceof Response) return r;
  const days = demo ? demoDays(demo).filter((d) => d.date >= r.from && d.date <= r.to) : await loadDays(shop, r);
  const nowMs = demo ? demo.at : (live?.at ?? Date.now());
  if (kind === 'summary') {
    const cmp = remoteComparison(r, nowMs, today);
    const prev = demo ? [] : await loadDays(shop, cmp.range);
    return json(sumSummary(r, days, prev, nowMs, today));
  }
  if (kind === 'hourly') return json(sumHourly(r, days));
  if (kind === 'products') return json(sumProducts(r, days, live?.cat));
  if (kind === 'staff') return json(sumStaff(r, days));
  const extras = demo ? [] : await loadExtras(shop, r);
  return serveExtra(kind, url, r, days, extras, live?.cat);
}

/** Ek sekmelerin günlük verisi (ayrı anahtarlar), tarih sırasıyla */
async function loadExtras(shop: string, r: Range): Promise<RemoteDayExtra[]> {
  const dates = datesOf(r);
  const out: RemoteDayExtra[] = [];
  for (let i = 0; i < dates.length; i += MGET_CHUNK) {
    const raw = ((await redis('MGET', ...dates.slice(i, i + MGET_CHUNK).map((d) => reportExtraKey(shop, d)))) as (string | null)[] | null) ?? [];
    for (const x of raw) {
      if (!x) continue;
      try {
        out.push(JSON.parse(x) as RemoteDayExtra);
      } catch {
        /* bozuk kayıt atlanır */
      }
    }
  }
  return out;
}

const PLATFORM_ORDER = ['yemeksepeti', 'getir', 'trendyol', 'migros'];
const istanbulHourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Istanbul', hour: '2-digit', hourCycle: 'h23' });
const istanbulHour = (ms: number) => Number(istanbulHourFmt.format(new Date(ms))) % 24;

/**
 * Ek sekmeler (hazırlama, kalem listeleri, adisyonlar, iadeler, platformlar, CSV): günlük veri shared/remote-calc.ts
 * ile kasadaki dönem raporunun kuralıyla birleşir. Eski kasanın günlerinde ek veri yoksa o günler boş sayılır
 */
function serveExtra(kind: string, url: URL, r: Range, days: DayRep[], extras: RemoteDayExtra[], cat?: Record<string, string>): Response {
  const items = (k: 'iptal' | 'ikram' | 'indirim' | 'happy') => {
    const rows = mergeRows<ItemListRow>(extras.map((x) => x.lists?.[k] ?? []));
    return { range: r, total: rows.reduce((a, x) => a + x.value, 0), count: rows.length, rows, odenmezPeople: k === 'ikram' ? mergeOdenmez(extras.map((x) => x.odenmez ?? [])) : [] };
  };
  const checks = (limit: number | null) => ({ range: r, ...mergeChecks(extras.map((x) => (x.checks ?? []) as CheckRow[]), limit, days.flatMap((d) => d.xpay ?? [])) });
  const platforms = () => {
    const cross = crossPayIn(days.flatMap((d) => d.xpay ?? []), r.from, r.to).byPlatform;
    const lists = extras.map((x) => x.plat?.rows ?? []);
    // Gün aşırı tahsilat (adisyon başka günde, dönemin içinde): platformun ya da kasanın tahsilatına eklenir
    const extra = [...cross.entries()].map(([platform, v]) => {
      const label = lists.flat().find((x) => x.platform === platform)?.label ?? platform;
      return { platform, label, orders: 0, revenue: 0, discounts: 0, platformDiscount: 0, collectedByPlatform: v.platform, collectedAtCounter: v.counter, open: { orders: 0, amount: 0 }, missed: { orders: 0, amount: 0, rejected: 0, expired: 0, cancelled: 0, unrecorded: 0 } };
    });
    const netSales = days.reduce((a, d) => a + d.s.rev, 0);
    const pending = extras.reduce((a, x) => a + (x.plat?.pending ?? 0), 0);
    return { range: r, ...mergePlatforms([...lists, extra], netSales, pending, PLATFORM_ORDER) };
  };
  if (kind === 'prep') {
    const done = extras.flatMap((x) => x.prep?.done ?? []);
    return json({ range: r, ...prepFrom(done, extras.flatMap((x) => x.prep?.hand ?? []), istanbulHour) });
  }
  if (kind === 'items') {
    const k = url.searchParams.get('kind');
    if (k !== 'iptal' && k !== 'ikram' && k !== 'indirim' && k !== 'happy') return fail(400, 'Liste türü anlaşılamadı', 'bad_query');
    return json(items(k));
  }
  if (kind === 'checks') return json(checks(300));
  if (kind === 'refunds') {
    const rows = mergeRows<RemoteDayExtra['refunds'][number]>(extras.map((x) => x.refunds ?? []));
    return json({ range: r, total: rows.reduce((a, x) => a + x.amount, 0), count: rows.length, rows });
  }
  if (kind === 'platforms') return json(platforms());
  // CSV: kasadaki satırlar (shared/report-csv.ts); maliyet ve komisyon yok
  const type = url.searchParams.get('type') ?? '';
  if (!(CSV_TYPES as readonly string[]).includes(type)) return fail(400, 'CSV türü anlaşılamadı', 'bad_query');
  const t = type as CsvType;
  const rep = t === 'urunler' ? sumProducts(r, days, cat) : t === 'adisyonlar' ? checks(null) : t === 'saatlik' ? sumHourly(r, days) : t === 'platformlar' ? platforms() : items(t);
  return new Response(toCsv(csvRows(t, rep, false)), {
    headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="lafpos-${t}-${r.from}_${r.to}.csv"`, 'cache-control': 'no-store' },
  });
}

/** Demo: örnek günün patron panelinden tek günlük özet (kafe bağlanınca gerçek günler) */
function demoDays(snap: Snapshot): DayRep[] {
  const p = snap.patron as { date?: string; netSales?: number; orders?: number; hourly?: number[]; payments?: { name: string; amount: number; count: number }[]; top?: { key: string; name: string; size: string; category: string; qty: number; revenue: number; complimentary: number; voided: number }[]; discounts?: number; complimentary?: number; voided?: number };
  if (!p.date) return [];
  const rev = p.netSales ?? 0;
  return [
    {
      v: 1,
      date: p.date,
      at: snap.at,
      n: 1,
      closed: false,
      z: [],
      s: { list: rev + (p.discounts ?? 0) + (p.complimentary ?? 0), gross: rev + (p.discounts ?? 0), comp: p.complimentary ?? 0, disc: p.discounts ?? 0, svc: 0, rev, odenmez: 0, zayi: 0, voided: p.voided ?? 0, receipts: p.orders ?? 0, items: (p.top ?? []).reduce((a, x) => a + x.qty, 0), tips: 0, guests: 0, tableSales: 0, paidClosed: rev, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
      pay: (p.payments ?? []).map((x) => [x.name, '', x.amount, x.count]),
      types: [],
      kdv: [],
      closes: [],
      prod: (p.top ?? []).map((x) => [x.key, x.name, x.size, x.category, x.qty, x.revenue, x.complimentary, x.voided]),
      hours: (p.hourly ?? []).flatMap((v, hour) => (v ? [[(hour - ROLLOVER_HOUR + 24) % 24, v, 0] as [number, number, number]] : [])),
      clock: (p.hourly ?? []).flatMap((v, hour) => (v ? [[hour, v] as [number, number]] : [])),
      staff: [],
    },
  ];
}

// ─── Uçlar ───────────────────────────────────────────────────────────────────

const ME = {
  id: 'uzaktan',
  name: 'Patron (uzaktan)',
  role: 'patron',
  color: '#0c0e1b',
  permissions: ['patron.panel', 'siparis.al', 'mutfak.ekran', 'rapor.gor'],
  maxDiscountPct: 0,
};

async function handle(req: Request): Promise<Response> {
  const url = originalUrl(req.url);
  const path = url.pathname.replace(/^\/api\/?/, '').replace(/\/+$/, '');
  const members = memberEmails();
  const memberMode = members.length > 0;
  // Kurulum durumu (giriş ekranı gösterir): yalnız var/yok, hiçbir değer dönmez; anahtar olmadan da açıktır
  if (path === 'uzaktan/kurulum') {
    const redisSet = !!((env('KV_REST_API_URL') || env('UPSTASH_REDIS_REST_URL')) && (env('KV_REST_API_TOKEN') || env('UPSTASH_REDIS_REST_TOKEN')));
    let snapshotAt: number | null = null;
    let redisOk = false;
    let memberExists = false;
    if (redisSet) {
      try {
        snapshotAt = (await snapshot(await viewShop(req)))?.at ?? null;
        for (const e of members) memberExists ||= !!(await member(e, true));
        redisOk = true;
      } catch {
        redisOk = false;
      }
    }
    return json({
      secret: secret().length >= 32,
      password: memberMode || !passwordRequired() || env('LAFPOS_UZAKTAN_PAROLA').length >= 10,
      redis: redisOk,
      snapshotAt,
      demo: demoAllowed() && snapshotAt == null,
      open: !memberMode && !passwordRequired(),
      // Üyelik açıksa: 'new' ilk giriş (üye parolasını belirler), 'ready' e-posta ve parolayla giriş
      ...(memberMode ? { member: memberExists ? 'ready' : 'new' } : {}),
      yemeksepeti: !!env('YEMEKSEPETI_PLUGIN_SECRET'),
      getir: !!getirKey(),
    });
  }
  // Platform aktarıcıları: makineden makineye, demo ve parola kapısından önce
  if (path.startsWith('yemeksepeti/')) return yemeksepeti(req, url, path);
  if (path.startsWith('getir/')) return getir(req, url, path);
  // Kafe bağlanmadıysa demo: anahtar ve parola gerekmez, yalnız örnek gün açılır (kafe itmesi aşağıda, anahtarla)
  const auth = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '');
  const loginPost = req.method === 'POST' && (path === 'uzaktan/giris' || path === 'uzaktan/uye');
  const login = loginPost ? ((await req.json().catch(() => ({}))) as { eposta?: unknown; parola?: unknown; davet?: unknown }) : null;
  // Üyelik açıkken üyenin girişi ve oturumu demoya düşmez (kafe bağlanmadan da girer: İndir sayfası için)
  const memberRequest = memberMode && (path === 'uzaktan/uye' || !!login?.eposta || memberTokenEmail(auth) != null);
  /** Gerçek oturum (üye ya da parolalı giriş): Merkez paneli ve bildirim aboneliği. Parolasız görünümde hiç */
  const admin = async () => {
    if (secret().length < 32) return false;
    if (memberMode) {
      const email = memberTokenEmail(auth);
      const record = email && members.includes(email) ? await member(email) : null;
      return !!record && memberTokenValid(secret(), auth, record.h);
    }
    return passwordRequired() && tokenValid(secret(), auth);
  };
  const bildirimDeps = { redis, admin, signed: (body: string) => secret().length >= 32 && verifyPush(secret(), req, url, body) };
  // Patrona telefon bildirimi (Web Push): kasanın imzalı olayı ve aboneliği
  if (path.startsWith('uzaktan/bildirim')) return bildirim(req, path, bildirimDeps);
  // Bulut yedeği: kasanın imzalı istekleri (yükleme ve indirme adresi, liste)
  if (path.startsWith('uzaktan/yedek/')) return yedek(req, path, { signed: bildirimDeps.signed, shop: shopHeader(req) ?? REPORT_SHOP });
  // Merkez: kasanın kaydı ve imzalı nabzı (kendi anahtarıyla), panel (gerçek oturumla); demo ve salt okunur kapısından önce
  if (path.startsWith('merkez/')) {
    const panel = path === 'merkez/kurulumlar' || path === 'merkez/kurulum' || path === 'merkez/gonder';
    const demo = panel && !memberRequest && demoAllowed() && !(await realSnapshot()) && tokenValid(demoKey(), auth);
    return merkez(req, url, path, {
      redis,
      verify: (key: string, r: Request, u: URL, body: string) => verifyPush(key, r, u, body),
      admin,
      demo,
      fetchRelease: () => latestRelease(url.origin),
      notify: (n) => broadcast(bildirimDeps, n).then(() => undefined),
    });
  }
  if (path !== 'uzaktan/push' && !memberRequest && demoAllowed() && !(await realSnapshot())) {
    if (path === 'health') return json({ ok: true, remote: true, demo: true, time: Date.now() });
    if (path === 'uzaktan/giris' && req.method === 'POST') return json({ token: issueToken(demoKey()), me: ME, demo: true });
    if (!tokenValid(demoKey(), auth)) return fail(401, 'Oturum kapalı. Yeniden girin', 'unauthorized');
    if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');
    const demoSnap = demoNow();
    return (await serveReports(path, url, demoSnap)) ?? serve(demoSnap, path, url, true);
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
    const shop = shopHeader(req) ?? REPORT_SHOP;
    const current = await snapshot(shop);
    if (current && typeof snap.at === 'number' && snap.at <= current.at) return json({ ok: true, stale: true });
    await redis('SET', snapshotKey(shop), JSON.stringify(snap), 'EX', 7 * 86400);
    const map = await shopMap();
    // Dükkânlar listesi yalnız yeni dükkânda ya da saatte bir yazılır (her itmede değil)
    if (!map[shop] || Date.now() - map[shop] > 3600_000) await redis('SET', SHOPS_KEY, JSON.stringify({ ...map, [shop]: Date.now() }));
    return json({ ok: true });
  }

  // Kasanın günlük rapor özetleri: imzalı
  if (path === 'uzaktan/rapor' && req.method === 'POST') {
    const body = await req.text();
    if (body.length > 4_000_000) return fail(413, 'Rapor çok büyük', 'too_large');
    if (!verifyPush(secret(), req, url, body)) return fail(401, 'İmza geçersiz', 'bad_signature');
    return storeReports(body);
  }

  // Üyelik: ilk girişte üye parolasını belirler (yalnız izinli e-posta, yalnız bir kez), sonra e-posta ve parola
  if (memberMode && login) {
    const ip = (req.headers.get('x-forwarded-for') ?? 'yok').split(',')[0]!.trim();
    const key = `lafpos:giris:${ip}`;
    const tries = Number(await redis('INCR', key));
    if (tries === 1) await redis('EXPIRE', key, 900);
    if (tries > LOGIN_LIMIT) return fail(429, 'Çok fazla deneme; 15 dakika sonra yeniden deneyin', 'rate_limited');
    const email = normalizeEmail(login.eposta);
    const password = String(login.parola ?? '');
    if (!email || !password) return fail(400, 'E-posta ve parolayı girin', 'bad_body');
    if (path === 'uzaktan/uye') {
      const invite = normalizeInvite(inviteCode());
      if (invite.length < 8) return fail(503, 'Üyelik davet kodu tanımlı değil (LAFPOS_UYE_DAVET)', 'not_configured');
      const given = createHash('sha256').update(normalizeInvite(login.davet)).digest('hex');
      // E-posta ve kod birlikte denetlenir: yanıt hangisinin yanlış olduğunu söylemez
      if (!sameText(given, createHash('sha256').update(invite).digest('hex')) || !members.includes(email)) return fail(403, 'E-posta ya da davet kodu yanlış', 'not_allowed');
      if (password.length < 10 || password.length > 200) return fail(400, 'Parola en az 10 karakter olmalı', 'weak_password');
      const record: Member = { h: hashPassword(password), at: Date.now() };
      if ((await redis('SET', memberKey(email), JSON.stringify(record), 'NX')) !== 'OK') return fail(409, 'Bu üyelik zaten açılmış; e-posta ve parolanızla girin', 'member_exists');
      memberCache.delete(email);
      await redis('DEL', key);
      return json({ token: issueMemberToken(secret(), email, record.h), me: ME });
    }
    const record = members.includes(email) ? await member(email, true) : null;
    // Üye yokken de özet hesaplanır: yanıt süresi e-postanın kayıtlı olup olmadığını söylemez
    if (!passwordMatches(record?.h ?? hashPassword('yok', Buffer.alloc(16)), password) || !record) return fail(401, 'E-posta ya da parola yanlış', 'bad_password');
    await redis('DEL', key);
    return json({ token: issueMemberToken(secret(), email, record.h), me: ME });
  }
  if (memberMode) {
    const email = memberTokenEmail(auth);
    const record = email && members.includes(email) ? await member(email) : null;
    if (!record || !memberTokenValid(secret(), auth, record.h)) return fail(401, 'Oturum kapalı. E-posta ve parolanızla yeniden girin', 'unauthorized');
    if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');
    return viewer(req, path, url);
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
    const given = String(login?.parola ?? '');
    if (!sameText(createHash('sha256').update(given).digest('hex'), createHash('sha256').update(password).digest('hex'))) {
      return fail(401, 'Parola yanlış', 'bad_password');
    }
    await redis('DEL', key);
    return json({ token: issueToken(secret()), me: ME });
  }

  if (!tokenValid(secret(), auth)) return fail(401, 'Oturum kapalı. Parolayla yeniden girin', 'unauthorized');
  if (req.method !== 'GET') return fail(403, 'Uzaktan görünüm salt okunur: işlemler kafedeki kasadan yapılır', 'remote_readonly');
  return viewer(req, path, url);
}

/** Salt okunur uçlar: kafeden gelen ya da demo özetinden */
function serve(snap: Snapshot | null, path: string, url: URL, demo: boolean): Response {
  if (path === 'auth/me') return json(ME);
  if (path === 'uzaktan/durum') return json({ at: snap?.at ?? null, demo });
  // Örnek günde dükkân seçici yok
  if (path === 'uzaktan/dukkanlar') return json([]);
  if (!snap) return fail(503, 'Kafeden henüz veri gelmedi; kasa bilgisayarı açık ve LAFPOS_CLOUD_URL tanımlı mı?', 'no_snapshot');
  if (path === 'bootstrap') return json({ ...snap.bootstrap, me: ME });
  if (path === 'reports/patron') return json(snap.patron);
  if (path === 'floor') return json(snap.floor);
  // Özet yalnız aktif fişleri taşır: Geçmiş ve Hazır sekmesi uzaktan boş
  if (path === 'kitchen') return json(url.searchParams.get('history') === '1' || url.searchParams.get('ready') === '1' ? [] : snap.kitchen);
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
