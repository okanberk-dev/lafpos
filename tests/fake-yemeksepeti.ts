import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { InboxItem } from '../server/delivery/yemeksepeti';

/**
 * Testler için sahte LafPOS Uzaktan gelen kutusu (`/api/yemeksepeti/inbox`, `/inbox/ack`; imza başlığı aranır) ve
 * sahte Delivery Hero middleware'i (`/v2/login`, `/v2/order/status/{token}`, `/v2/orders/{token}/preparation-completed`
 * ve siparişin `callbackUrls` adresleri `/cb/{ne}/{token}`). Çağrılar ve gövdeler kaydedilir.
 */
export interface FakeYemeksepeti {
  url: string;
  close: () => Promise<void>;
  inbox: InboxItem[];
  acked: string[];
  /** Silme isteği gelince, yanıttan önce (kasanın kaydı o an yazılmış mı) */
  beforeAck?: (ids: string[]) => void;
  /** "POST /v2/login", "POST /cb/accepted/tok-1" gibi */
  calls: string[];
  bodies: Record<string, unknown[]>;
  /** Sırayla kullanılacak durum kodları (uç başına) */
  statusFor: Record<string, number[]>;
  /** Geçerli jeton(lar); giriş her seferinde yeni jeton üretir */
  tokens: Set<string>;
  logins: number;
  count: (call: string) => number;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export async function startFakeYemeksepeti(creds: { username: string; password: string }): Promise<FakeYemeksepeti> {
  const f: FakeYemeksepeti = { url: '', close: async () => undefined, inbox: [], acked: [], calls: [], bodies: {}, statusFor: {}, tokens: new Set(), logins: 0, count: (c) => f.calls.filter((x) => x === c).length };
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://ys.test');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname;
    // Aktarıcı (kafe anahtarıyla imzalı)
    if (path === '/api/yemeksepeti/inbox' && req.method === 'GET') {
      f.calls.push('GET inbox');
      if (!req.headers['x-laf-signature']) return send(401, { error: 'imza' });
      const forced = f.statusFor.inbox?.shift();
      if (forced && forced !== 200) return send(forced, { error: 'forced' });
      return send(200, { items: f.inbox.slice(0, 50), total: f.inbox.length });
    }
    if (path === '/api/yemeksepeti/inbox/ack' && req.method === 'POST') {
      f.calls.push('POST ack');
      if (!req.headers['x-laf-signature']) return send(401, { error: 'imza' });
      const ids = (JSON.parse(raw) as { ids: string[] }).ids;
      f.beforeAck?.(ids);
      f.acked.push(...ids);
      f.inbox = f.inbox.filter((i) => !ids.includes(i.id));
      return send(200, { ok: true, removed: ids.length });
    }
    // Middleware
    if (path === '/v2/login' && req.method === 'POST') {
      f.calls.push('POST /v2/login');
      const form = new URLSearchParams(raw);
      if (form.get('username') !== creds.username || form.get('password') !== creds.password || form.get('grant_type') !== 'client_credentials') return send(401, { code: 'POS_ERROR', message: 'bad credentials' });
      f.logins++;
      const token = `jeton-${f.logins}`;
      f.tokens.add(token);
      return send(200, { access_token: token, expires_in: 1800, token_type: 'bearer' });
    }
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (!f.tokens.has(bearer)) return send(401, { code: 'AUTHORIZATION_ERROR', message: 'token' });
    const key = path.startsWith('/cb/') ? path.split('/')[2]! : path.includes('preparation-completed') ? 'prepared' : path.startsWith('/v2/order/status/') ? 'status' : 'other';
    f.calls.push(`${req.method} ${path}`);
    (f.bodies[key] ??= []).push(raw ? JSON.parse(raw) : null);
    const forced = f.statusFor[key]?.shift();
    if (forced && forced !== 200) return send(forced, { code: forced === 409 ? 'INVALID_REQUEST' : 'INTERNAL_ERROR', message: `forced ${forced}` });
    return send(200, { message: 'Order status successfully changed.' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  f.close = () => new Promise((resolve) => server.close(() => resolve()));
  return f;
}
