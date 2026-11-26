import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GetirOrder, InboxItem } from '../server/delivery/getir';

/**
 * Testler için sahte LafPOS Uzaktan gelen kutusu (`/api/getir/inbox`, `/inbox/ack`; imza başlığı aranır) ve sahte
 * GetirFood API'si (`/auth/login`, `/food-orders/periodic/unapproved|cancelled`, `/food-orders/active`,
 * `GET /food-orders/{id}`, `/food-orders/{id}/cancel-options`, `/food-orders/{id}/verify|verify-scheduled|prepare|
 * handover|deliver|cancel`). Çağrılar ve gövdeler kaydedilir; `statusFor` ile bir uca sırayla verilecek durum kodları
 * (ya da Getir hata kodlu 400), `bodyFor` ile 200 gövdeleri kuyruklanır. `strict`: Getir'in akışı (verify → prepare →
 * handover / deliver; sırasız çağrı 400 kod 3) ve `gapMs` aralık kuralı (verify, prepare, deliver arasında; ihlal 400,
 * prepare'de kod 74, deliver'da 62: bağdaştırıcının varsayımı); strict'te `GET /food-orders/{id}` `details`'te yoksa
 * akıştaki duruma göre üretilir (onaylı 350, hazır 550 + prepareDate, kuryede 600 + handoverDate, teslim 900 +
 * deliverDate). `singleToken`: yeni giriş eski jetonları düşürür. Gelen kutusu ortak kutu gibidir (restoran süzgeci
 * yok): kasanın başka restoranın kaydını silmediği burada denetlenir.
 */
export interface FakeGetir {
  url: string;
  close: () => Promise<void>;
  inbox: InboxItem[];
  acked: string[];
  /** Silme isteği gelince, yanıttan önce (kasanın kaydı o an yazılmış mı) */
  beforeAck?: (ids: string[]) => void;
  /** Gelen kutusu isteklerinin (çekim ve silme) imzalı `restoran` sorgusu, sırayla; sorgusuz istekte null */
  restoran: (string | null)[];
  /** Yedek yoklamanın verdiği onaysız ve iptal edilmiş siparişler */
  unapproved: GetirOrder[];
  cancelledList: GetirOrder[];
  /** `/food-orders/active` (Getir'de onaylı siparişler) */
  active: GetirOrder[];
  /** `GET /food-orders/{id}` yanıtları */
  details: Record<string, GetirOrder>;
  /** `/cancel-options` yanıtı */
  cancelOptions: { id: string; message: string }[];
  /** "POST /auth/login", "GET inbox", "POST ack", "POST unapproved", "POST ord-1 verify" gibi */
  calls: string[];
  bodies: Record<string, unknown[]>;
  /** Uç adına göre sırayla kullanılacak durum kodları; sayı ya da Getir hata kodlu yanıt (boşsa 200) */
  statusFor: Record<string, (number | { status: number; code: number })[]>;
  /** Uç adına göre sırayla kullanılacak 200 gövdeleri (boşsa uç kendi gövdesini verir) */
  bodyFor: Record<string, unknown[]>;
  /** Getir'in akış ve aralık kuralı (yukarıda) */
  strict: boolean;
  gapMs: number;
  /** Sipariş → Getir'deki durum ve son akış çağrısı (strict) */
  flow: Map<string, { stage: 'new' | 'verified' | 'prepared' | 'handed' | 'delivered'; at: number }>;
  /** Yeni giriş eski jetonları düşürür */
  singleToken: boolean;
  /** Uç adına göre yanıttan önce bekleme (ms) */
  delayFor: Record<string, number>;
  /** Uç adına göre yanıttan hemen önce çalışan kanca */
  before: Record<string, () => void>;
  /** Geçerli jeton(lar); giriş her seferinde yeni jeton üretir */
  tokens: Set<string>;
  logins: number;
  restaurantId: string;
  count: (call: string) => number;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export async function startFakeGetir(creds: { appSecretKey: string; restaurantSecretKey: string }, restaurantId = 'rest-1'): Promise<FakeGetir> {
  const f: FakeGetir = {
    url: '',
    close: async () => undefined,
    inbox: [],
    acked: [],
    restoran: [],
    unapproved: [],
    cancelledList: [],
    active: [],
    details: {},
    cancelOptions: [
      { id: 'cr-1', message: 'Ürün stokta yok' },
      { id: 'cr-2', message: 'Restoran çok yoğun' },
      { id: 'cr-3', message: 'Restoran kapanıyor' },
      { id: 'cr-4', message: 'Adres teslimat alanı dışında' },
      { id: 'cr-9', message: 'Diğer' },
    ],
    calls: [],
    bodies: {},
    statusFor: {},
    bodyFor: {},
    strict: false,
    gapMs: 0,
    flow: new Map(),
    singleToken: false,
    delayFor: {},
    before: {},
    tokens: new Set(),
    logins: 0,
    restaurantId,
    count: (c) => f.calls.filter((x) => x === c).length,
  };
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://getir.test');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname;
    // Aktarıcı (kafe anahtarıyla imzalı)
    if (path === '/api/getir/inbox' && req.method === 'GET') {
      f.calls.push('GET inbox');
      f.restoran.push(url.searchParams.get('restoran'));
      if (!req.headers['x-laf-signature']) return send(401, { error: 'imza' });
      const forced = f.statusFor.inbox?.shift();
      if (forced && forced !== 200) return send(typeof forced === 'number' ? forced : forced.status, { error: 'forced' });
      return send(200, { items: f.inbox.slice(0, 50), total: f.inbox.length });
    }
    if (path === '/api/getir/inbox/ack' && req.method === 'POST') {
      f.calls.push('POST ack');
      f.restoran.push(url.searchParams.get('restoran'));
      if (!req.headers['x-laf-signature']) return send(401, { error: 'imza' });
      const ids = (JSON.parse(raw) as { ids: string[] }).ids;
      f.beforeAck?.(ids);
      f.acked.push(...ids);
      f.inbox = f.inbox.filter((i) => !ids.includes(i.id));
      return send(200, { ok: true, removed: ids.length });
    }
    // GetirFood API
    if (path === '/auth/login' && req.method === 'POST') {
      f.calls.push('POST /auth/login');
      const forcedLogin = f.statusFor.login?.shift();
      if (forcedLogin && forcedLogin !== 200) {
        if (typeof forcedLogin === 'number') return send(forcedLogin, { statusCode: forcedLogin, error: 'Forced', message: `forced ${forcedLogin}` });
        return send(forcedLogin.status, { code: forcedLogin.code, error: 'ServiceError', message: `forced code ${forcedLogin.code}` });
      }
      const body = JSON.parse(raw || '{}') as { appSecretKey?: string; restaurantSecretKey?: string };
      if (body.appSecretKey !== creds.appSecretKey || body.restaurantSecretKey !== creds.restaurantSecretKey) return send(401, { code: 0, error: 'Unauthorized', message: 'bad keys' });
      f.logins++;
      const token = `jeton-${f.logins}`;
      if (f.singleToken) f.tokens.clear();
      f.tokens.add(token);
      return send(200, { restaurantId: f.restaurantId, token });
    }
    const token = String(req.headers.token ?? '');
    if (!f.tokens.has(token)) return send(401, { statusCode: 401, error: 'Unauthorized', message: 'token' });
    const respond = async (key: string, ok: unknown) => {
      f.calls.push(`${req.method} ${key}`);
      const action = key.split(' ').at(-1)!;
      (f.bodies[action] ??= []).push(raw ? JSON.parse(raw) : null);
      const wait = f.delayFor[action];
      if (wait) await new Promise((r) => setTimeout(r, wait));
      f.before[action]?.();
      const forced = f.statusFor[action]?.shift();
      if (forced && forced !== 200) {
        if (typeof forced === 'number') return send(forced, { statusCode: forced, error: 'Forced', message: `forced ${forced}` });
        return send(forced.status, { code: forced.code, error: 'ServiceError', message: `forced code ${forced.code}` });
      }
      const body = f.bodyFor[action]?.length ? f.bodyFor[action]!.shift() : ok;
      if (typeof body === 'string') {
        res.writeHead(200, { 'content-type': 'text/html' });
        return res.end(body);
      }
      return send(200, body);
    };
    /** Getir'in akış kuralı (strict): sırasız çağrı kod 3, aralık ihlali 74 / 62; geçerse durum ilerler */
    const flowError = (id: string, action: string): { code: number } | null => {
      if (!f.strict || !['verify', 'verify-scheduled', 'prepare', 'handover', 'deliver'].includes(action)) return null;
      const cur = f.flow.get(id) ?? { stage: 'new' as const, at: 0 };
      const need: Record<string, string[]> = { verify: ['new'], 'verify-scheduled': ['new'], prepare: ['verified'], handover: ['prepared'], deliver: ['prepared'] };
      if (action.startsWith('verify') && cur.stage !== 'new') return { code: 2 };
      if (!need[action]!.includes(cur.stage)) return { code: 3 };
      const gapped = action !== 'handover';
      if (gapped && f.gapMs && cur.at && Date.now() - cur.at < f.gapMs) return { code: action === 'deliver' ? 62 : 74 };
      const next = { verify: 'verified', 'verify-scheduled': 'verified', prepare: 'prepared', handover: 'handed', deliver: 'delivered' }[action] as 'verified';
      f.flow.set(id, { stage: next, at: gapped ? Date.now() : cur.at });
      return null;
    };
    if (path === '/food-orders/periodic/unapproved' && req.method === 'POST') return respond('unapproved', f.unapproved);
    if (path === '/food-orders/periodic/cancelled' && req.method === 'POST') return respond('cancelled', f.cancelledList);
    if (path === '/food-orders/active' && req.method === 'POST') return respond('active', f.active);
    const one = path.match(/^\/food-orders\/([^/]+)$/);
    if (one && req.method === 'GET') {
      const st = f.strict ? f.flow.get(one[1]!) : undefined;
      const at = st ? new Date(st.at || Date.now()).toISOString() : '';
      const synth: GetirOrder | undefined = st
        ? {
            id: one[1]!,
            status: { new: 400, verified: 350, prepared: 550, handed: 600, delivered: 900 }[st.stage],
            ...(st.stage === 'prepared' || st.stage === 'handed' || st.stage === 'delivered' ? { prepareDate: at } : {}),
            ...(st.stage === 'handed' ? { handoverDate: at } : {}),
            ...(st.stage === 'delivered' ? { deliverDate: at } : {}),
          }
        : undefined;
      const o = f.details[one[1]!] ?? synth;
      if (!o) {
        f.calls.push(`GET ${one[1]} order`);
        return send(404, { code: 1, error: 'FoodOrderNotFound', message: 'food order not found' });
      }
      return respond(`${one[1]} order`, o);
    }
    const m = path.match(/^\/food-orders\/([^/]+)\/(cancel-options|verify-scheduled|verify|prepare|handover|deliver|cancel)$/);
    if (m) {
      const [, id, action] = m;
      if (action === 'cancel-options' && req.method === 'GET') return respond(`${id} cancel-options`, f.cancelOptions);
      if (req.method === 'POST') {
        const bad = action === 'cancel' || f.statusFor[action!]?.length ? null : flowError(id!, action!);
        if (bad) {
          (f.statusFor[action!] ??= []).unshift({ status: 400, code: bad.code });
        }
        return respond(`${id} ${action}`, action === 'cancel' ? {} : { result: true });
      }
    }
    return send(404, { code: 1, error: 'FoodOrderNotFound', message: 'food order not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise((resolve) => server.close(() => resolve()));
  return f;
}
