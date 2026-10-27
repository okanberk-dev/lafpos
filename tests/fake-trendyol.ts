import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TrendyolPackage } from '../server/delivery/trendyol';

/**
 * Testler için sahte Trendyol Go Yemek API'si: paket listesi (durum ve değişiklik penceresine göre), durum uçları
 * (picked, invoiced, manual-shipped, manual-delivered, unsupplied) ve Basic kimlik denetimi. Çağrılar ve gövdeler
 * kaydedilir; `statusFor` ile bir uca sırayla verilecek durum kodları kuyruklanır (5xx, 429, 401).
 */
export interface FakeTrendyol {
  url: string;
  close: () => Promise<void>;
  packages: TrendyolPackage[];
  /** "GET packages Created" ya da "PUT 123 picked" gibi */
  calls: string[];
  bodies: Record<string, unknown[]>;
  /** Uç adına göre sırayla kullanılacak durum kodları (boşsa 200) */
  statusFor: Record<string, number[]>;
  /** Beklenen Basic başlığı; tutmayan istek 401 */
  expectAuth: string;
  count: (call: string) => number;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export async function startFakeTrendyol(opts: { apiKey: string; apiSecret: string; supplierId: string }): Promise<FakeTrendyol> {
  const site: FakeTrendyol = {
    url: '',
    close: async () => undefined,
    packages: [],
    calls: [],
    bodies: {},
    statusFor: {},
    expectAuth: `Basic ${Buffer.from(`${opts.apiKey}:${opts.apiSecret}`).toString('base64')}`,
    count: (call) => site.calls.filter((c) => c === call).length,
  };
  const base = `/integrator/order/meal/suppliers/${opts.supplierId}/packages`;
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://trendyol.test');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== site.expectAuth) return send(401, { message: 'Unauthorized' });
    if (!url.pathname.startsWith(base)) return send(404, { message: 'not found' });
    const rest = url.pathname.slice(base.length);
    if (req.method === 'GET' && rest === '') {
      const status = url.searchParams.get('packageStatus') ?? '';
      const start = Number(url.searchParams.get('packageModificationStartDate') ?? 0);
      const end = Number(url.searchParams.get('packageModificationEndDate') ?? Number.MAX_SAFE_INTEGER);
      site.calls.push(`GET packages ${status}`);
      const forced = site.statusFor.packages?.shift();
      if (forced && forced !== 200) return send(forced, { message: `forced ${forced}` });
      const content = site.packages.filter((p) => (p.packageStatus ?? 'Created') === status && Number(p.packageModificationDate ?? 0) >= start && Number(p.packageModificationDate ?? 0) <= end);
      return send(200, { content, page: 0, size: 50, totalPages: 1, totalElements: content.length });
    }
    const m = rest.match(/^\/([^/]+)\/(picked|invoiced|manual-shipped|manual-delivered|unsupplied)$/);
    if (req.method === 'PUT' && m) {
      const [, id, action] = m;
      site.calls.push(`PUT ${id} ${action}`);
      (site.bodies[action] ??= []).push(raw ? JSON.parse(raw) : null);
      const forced = site.statusFor[action!]?.shift();
      if (forced && forced !== 200) return send(forced, { message: `forced ${forced}` });
      if (!site.packages.some((p) => String(p.id) === id)) return send(404, { message: 'package not found' });
      return send(200, {});
    }
    return send(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () => new Promise((resolve) => server.close(() => resolve()));
  return site;
}
