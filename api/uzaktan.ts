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
    return json({
      secret: secret().length >= 32,
      password: !passwordRequired() || env('LAFPOS_UZAKTAN_PAROLA').length >= 10,
      redis: redisOk,
      snapshotAt,
      demo: demoAllowed() && snapshotAt == null,
      open: !passwordRequired(),
      yemeksepeti: !!env('YEMEKSEPETI_PLUGIN_SECRET'),
      getir: !!getirKey(),
    });
  }
  // Platform aktarıcıları: makineden makineye, demo ve parola kapısından önce
  if (path.startsWith('yemeksepeti/')) return yemeksepeti(req, url, path);
  if (path.startsWith('getir/')) return getir(req, url, path);
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
