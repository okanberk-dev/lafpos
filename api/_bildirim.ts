/**
 * Patrona telefon bildirimi (LafPOS Uzaktan, Web Push). api/uzaktan.ts yolu `uzaktan/bildirim` ile başlayan istekleri
 * buraya verir.
 *
 * - Abonelik: patron Uzaktan'da (telefonda, ana ekrana eklenmiş sitede) "Bildirimleri aç"a basar; tarayıcının
 *   aboneliği gerçek oturumla (üye ya da parolalı giriş) saklanır. Parolasız görünümde abonelik açılmaz.
 * - Gönderim: kasa olayı imzalı iter (`POST uzaktan/bildirim`, LAFPOS_CLOUD_SECRET): büyük iptal ya da ikram, kasa
 *   farkı, uzun internet kesintisi, Pavo gün sonu alınamadı. Güncelleme hatasını Merkez nabızdan kendisi görür.
 * - Anahtarlar: VAPID_PUBLIC_KEY ve VAPID_PRIVATE_KEY (Vercel). Yoksa bildirim kapalıdır, hiçbir şey kırılmaz.
 * - Redis: `lafpos:bildirim:aboneler` (JSON, uç → abonelik), `lafpos:bildirim:son` (son 30 bildirim)
 */
import webpush from 'web-push';

export interface Notice {
  kind: string;
  title: string;
  body: string;
  at: number;
  /** Dükkânın adı (birden çok dükkânda başlığa eklenir) */
  shop?: string | null;
}

interface Sub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface BildirimDeps {
  redis: (...cmd: (string | number)[]) => Promise<unknown>;
  /** Gerçek oturum (abone olmak için) */
  admin: () => Promise<boolean>;
  /** Geçerli ama yönetici olmayan oturum (parolasız görünüm): 401 yerine 403, uzaktan oturum düşmez */
  viewer?: () => Promise<boolean>;
  /** Kasanın imzası (gönderim için) */
  signed: (body: string) => boolean;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);
const env = (k: string) => (process.env[k] ?? '').trim();

const SUBS_KEY = 'lafpos:bildirim:aboneler';
const LAST_KEY = 'lafpos:bildirim:son';
const MAX_SUBS = 20;

export const pushConfigured = () => !!env('VAPID_PUBLIC_KEY') && !!env('VAPID_PRIVATE_KEY');

type Sender = (sub: Sub, payload: string) => Promise<{ statusCode: number }>;
let sender: Sender = (sub, payload) => {
  webpush.setVapidDetails('https://lafpos.laffogato.net', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));
  return webpush.sendNotification(sub, payload, { TTL: 6 * 3600, urgency: 'high' });
};
/** Testler: gönderimi yakalar */
export function setPushSender(fn: Sender) {
  sender = fn;
}

async function subs(deps: BildirimDeps): Promise<Record<string, Sub>> {
  const raw = (await deps.redis('GET', SUBS_KEY)) as string | null;
  try {
    return raw ? (JSON.parse(raw) as Record<string, Sub>) : {};
  } catch {
    return {};
  }
}

const validSub = (v: unknown): v is Sub => {
  const s = v as Sub;
  return !!s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 && typeof s.keys?.p256dh === 'string' && typeof s.keys?.auth === 'string';
};

/** Bütün abonelere gönderir; geçersizleşen abonelik (404, 410) silinir. Gönderilen sayısı */
export async function broadcast(deps: BildirimDeps, n: Notice): Promise<number> {
  const last = (await deps.redis('GET', LAST_KEY)) as string | null;
  let list: Notice[] = [];
  try {
    list = last ? (JSON.parse(last) as Notice[]) : [];
  } catch {
    list = [];
  }
  await deps.redis('SET', LAST_KEY, JSON.stringify([n, ...list].slice(0, 30)), 'EX', 30 * 86400);
  if (!pushConfigured()) return 0;
  const all = await subs(deps);
  const payload = JSON.stringify({ title: n.shop ? `${n.title} · ${n.shop}` : n.title, body: n.body, tag: n.kind, url: '/patron' });
  let sent = 0;
  let changed = false;
  for (const [endpoint, sub] of Object.entries(all)) {
    try {
      await sender(sub, payload);
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        delete all[endpoint];
        changed = true;
      }
    }
  }
  if (changed) await deps.redis('SET', SUBS_KEY, JSON.stringify(all));
  return sent;
}

const KINDS = new Set(['iptal', 'ikram', 'kasa-farki', 'internet', 'guncelleme', 'pavo', 'deneme']);

export async function bildirim(req: Request, path: string, deps: BildirimDeps): Promise<Response> {
  // Sayfanın sorusu: bildirim kurulu mu, açık anahtar (gizli değil)
  if (path === 'uzaktan/bildirim/anahtar' && req.method === 'GET') return json({ ready: pushConfigured(), publicKey: env('VAPID_PUBLIC_KEY') || null });

  // Kasanın olayı: imzalı
  if (path === 'uzaktan/bildirim' && req.method === 'POST') {
    const body = await req.text();
    if (body.length > 4000) return fail(413, 'Bildirim çok uzun', 'too_large');
    if (!deps.signed(body)) return fail(401, 'İmza geçersiz', 'bad_signature');
    let n: Partial<Notice>;
    try {
      n = JSON.parse(body) as Partial<Notice>;
    } catch {
      return fail(400, 'Bildirim okunamadı', 'bad_body');
    }
    if (!KINDS.has(String(n.kind)) || typeof n.title !== 'string' || typeof n.body !== 'string') return fail(400, 'Bildirim biçimi geçersiz', 'bad_body');
    const notice: Notice = { kind: String(n.kind), title: n.title.slice(0, 80), body: n.body.slice(0, 240), at: typeof n.at === 'number' ? n.at : Date.now(), shop: typeof n.shop === 'string' ? n.shop.slice(0, 60) : null };
    return json({ ok: true, sent: await broadcast(deps, notice) });
  }

  // Abonelik: gerçek oturumla
  if (!(await deps.admin())) {
    if (await deps.viewer?.()) return fail(403, 'Bildirimler için üye girişi gerekir', 'remote_admin');
    return fail(401, 'Bildirimler için üye girişi gerekir', 'unauthorized');
  }
  if (path === 'uzaktan/bildirim/abone' && req.method === 'POST') {
    if (!pushConfigured()) return fail(503, 'Bildirim anahtarı tanımlı değil (VAPID_PUBLIC_KEY)', 'not_configured');
    const sub = ((await req.json().catch(() => ({}))) as { abonelik?: unknown }).abonelik;
    if (!validSub(sub)) return fail(400, 'Abonelik anlaşılamadı', 'bad_body');
    const all = await subs(deps);
    all[sub.endpoint] = { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
    // En eski abonelikler düşer (her telefon ve tarayıcı bir abonelik)
    const trimmed = Object.fromEntries(Object.entries(all).slice(-MAX_SUBS));
    await deps.redis('SET', SUBS_KEY, JSON.stringify(trimmed));
    return json({ ok: true, count: Object.keys(trimmed).length });
  }
  if (path === 'uzaktan/bildirim/birak' && req.method === 'POST') {
    const endpoint = String(((await req.json().catch(() => ({}))) as { endpoint?: unknown }).endpoint ?? '');
    const all = await subs(deps);
    if (all[endpoint]) {
      delete all[endpoint];
      await deps.redis('SET', SUBS_KEY, JSON.stringify(all));
    }
    return json({ ok: true });
  }
  if (path === 'uzaktan/bildirim/son' && req.method === 'GET') {
    const raw = (await deps.redis('GET', LAST_KEY)) as string | null;
    return json(raw ? JSON.parse(raw) : []);
  }
  if (path === 'uzaktan/bildirim/dene' && req.method === 'POST') {
    const sent = await broadcast(deps, { kind: 'deneme', title: 'LafPOS bildirimi', body: 'Bildirimler bu telefonda açık', at: Date.now() });
    return json({ ok: true, sent });
  }
  return fail(404, 'Bildirimde böyle bir uç yok', 'not_found');
}
