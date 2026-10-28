import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GetirOrder, InboxItem } from '../server/delivery/getir';

/**
 * Testler için sahte LafPOS Uzaktan gelen kutusu (`/api/getir/inbox`, `/inbox/ack`; imza başlığı aranır) ve sahte
 * GetirFood API'si (`/auth/login`, `/food-orders/periodic/unapproved|cancelled`, `/food-orders/{id}/cancel-options`,
 * `/food-orders/{id}/verify|verify-scheduled|prepare|handover|deliver|cancel`). Çağrılar ve gövdeler kaydedilir;
 * `statusFor` ile bir uca sırayla verilecek durum kodları (ya da Getir hata kodlu 400) kuyruklanır.
 */
export interface FakeGetir {
  url: string;
  close: () => Promise<void>;
  inbox: InboxItem[];
  acked: string[];
  /** Silme isteği gelince, yanıttan önce (kasanın kaydı o an yazılmış mı) */
  beforeAck?: (ids: string[]) => void;
  /** Yedek yoklamanın verdiği onaysız ve iptal edilmiş siparişler */
  unapproved: GetirOrder[];
  cancelledList: GetirOrder[];
  /** `/cancel-options` yanıtı */
  cancelOptions: { id: string; message: string }[];
  /** "POST /auth/login", "GET inbox", "POST ack", "POST unapproved", "POST ord-1 verify" gibi */
  calls: string[];
  bodies: Record<string, unknown[]>;
  /** Uç adına göre sırayla kullanılacak durum kodları; sayı ya da Getir hata kodlu yanıt (boşsa 200) */
  statusFor: Record<string, (number | { status: number; code: number })[]>;
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
    unapproved: [],
    cancelledList: [],
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
      if (!req.headers['x-laf-signature']) return send(401, { error: 'imza' });
      const forced = f.statusFor.inbox?.shift();
      if (forced && forced !== 200) return send(typeof forced === 'number' ? forced : forced.status, { error: 'forced' });
      return send(200, { items: f.inbox.slice(0, 50), total: f.inbox.length });
    }
    if (path === '/api/getir/inbox/ack' && req.method === 'POST') {
      f.calls.push('POST ack');
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
      const body = JSON.parse(raw || '{}') as { appSecretKey?: string; restaurantSecretKey?: string };
      if (body.appSecretKey !== creds.appSecretKey || body.restaurantSecretKey !== creds.restaurantSecretKey) return send(401, { code: 0, error: 'Unauthorized', message: 'bad keys' });
      f.logins++;
      const token = `jeton-${f.logins}`;
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
      return send(200, ok);
    };
    if (path === '/food-orders/periodic/unapproved' && req.method === 'POST') return respond('unapproved', f.unapproved);
    if (path === '/food-orders/periodic/cancelled' && req.method === 'POST') return respond('cancelled', f.cancelledList);
    const m = path.match(/^\/food-orders\/([^/]+)\/(cancel-options|verify-scheduled|verify|prepare|handover|deliver|cancel)$/);
    if (m) {
      const [, id, action] = m;
      if (action === 'cancel-options' && req.method === 'GET') return respond(`${id} cancel-options`, f.cancelOptions);
      if (req.method === 'POST') return respond(`${id} ${action}`, { result: true });
    }
    return send(404, { code: 1, error: 'FoodOrderNotFound', message: 'food order not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise((resolve) => server.close(() => resolve()));
  return f;
}
