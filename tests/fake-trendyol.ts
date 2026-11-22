import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { TrendyolPackage } from '../server/delivery/trendyol';

/**
 * Testler için sahte Trendyol Go Yemek API'si, resmi belgedeki yol ve gövdelerle (developers.tgoapps.com): paket listesi
 * (`packageStatuses` virgüllü; parametre yoksa gerçek API gibi süzgeç yok), tek paket (`GET …/packages/{id}`),
 * `PUT …/packages/picked|invoiced|unsupplied` (paket kimliği gövdede), `PUT …/packages/{id}/manual-shipped|manual-delivered`
 * ve Basic kimlik denetimi. Çağrılar (`PUT <id> picked` biçiminde), gövdeler ve son başlıklar kaydedilir; `statusFor`
 * ile bir uca sırayla verilecek durum kodları kuyruklanır (5xx, 429, 401; tek paket okuma `one`).
 */
export interface FakeTrendyol {
  url: string;
  close: () => Promise<void>;
  packages: TrendyolPackage[];
  /** "GET packages Created", "GET 123" ya da "PUT 123 picked" gibi */
  calls: string[];
  bodies: Record<string, unknown[]>;
  /** Uç adına göre sırayla kullanılacak durum kodları (boşsa 200) */
  statusFor: Record<string, number[]>;
  /** Beklenen Basic başlığı; tutmayan istek 401 */
  expectAuth: string;
  /** Uç adına göre yanıttan önce bekleme (ms): yarış senaryoları */
  delayFor: Record<string, number>;
  /** Uç adına göre yanıttan hemen önce çalışan kanca (platform kabul etti, kasada bir şey değişti) */
  before: Record<string, () => void>;
  count: (call: string) => number;
  /** Son isteğin başlıkları (küçük harf) */
  lastHeaders: Record<string, string | string[] | undefined>;
  /** Tek paket yanıtı sayfa biçiminde (`{ content: [paket] }`) gelsin */
  wrapOne: boolean;
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
    delayFor: {},
    before: {},
    expectAuth: `Basic ${Buffer.from(`${opts.apiKey}:${opts.apiSecret}`).toString('base64')}`,
    count: (call) => site.calls.filter((c) => c === call).length,
    lastHeaders: {},
    wrapOne: false,
  };
  const base = `/integrator/order/meal/suppliers/${opts.supplierId}/packages`;
  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://trendyol.test');
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    site.lastHeaders = { ...req.headers };
    if (req.headers.authorization !== site.expectAuth) return send(401, { message: 'Unauthorized' });
    if (!url.pathname.startsWith(base)) return send(404, { message: 'not found' });
    const rest = url.pathname.slice(base.length);
    if (req.method === 'GET' && rest === '') {
      const status = url.searchParams.get('packageStatuses') ?? '';
      const wanted = status ? status.split(',') : null;
      const start = Number(url.searchParams.get('packageModificationStartDate') ?? 0);
      const end = Number(url.searchParams.get('packageModificationEndDate') ?? Number.MAX_SAFE_INTEGER);
      site.calls.push(`GET packages ${status}`);
      const forced = site.statusFor.packages?.shift();
      if (forced && forced !== 200) return send(forced, { message: `forced ${forced}` });
      const content = site.packages.filter((p) => (!wanted || wanted.includes(p.packageStatus ?? 'Created')) && Number(p.packageModificationDate ?? 0) >= start && Number(p.packageModificationDate ?? 0) <= end);
      return send(200, { content, page: 0, size: 50, totalPages: 1, totalElements: content.length });
    }
    const one = rest.match(/^\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const id = decodeURIComponent(one[1]!);
      site.calls.push(`GET ${id}`);
      const forced = site.statusFor.one?.shift();
      if (forced && forced !== 200) return send(forced, { message: `forced ${forced}` });
      const found = site.packages.find((p) => String(p.id) === id);
      if (!found) return send(404, { message: `Dış sistem ${id} kaynağı bulunamadı. Neden: DomainNotFound.` });
      return send(200, site.wrapOne ? { content: [found], page: 0, size: 50, totalPages: 1 } : found);
    }
    // Kabul, hazır, ret: kimlik gövdede; yolda ve teslim: kimlik yolda
    const byBody = rest.match(/^\/(picked|invoiced|unsupplied)$/);
    const byPath = rest.match(/^\/([^/]+)\/(manual-shipped|manual-delivered)$/);
    if (req.method === 'PUT' && (byBody || byPath)) {
      let parsed: { packageId?: unknown } | null = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        return send(400, { message: 'gövde JSON değil' });
      }
      const id = byPath ? decodeURIComponent(byPath[1]!) : parsed?.packageId != null ? String(parsed.packageId) : '';
      const action = byPath ? byPath[2]! : byBody![1]!;
      if (!id) return send(400, { message: 'packageId zorunlu' });
      site.calls.push(`PUT ${id} ${action}`);
      (site.bodies[action] ??= []).push(parsed);
      const wait = site.delayFor[action!];
      if (wait) await new Promise((r) => setTimeout(r, wait));
      site.before[action!]?.();
      const forced = site.statusFor[action!]?.shift();
      if (forced && forced !== 200) return send(forced, { message: `forced ${forced}` });
      if (!site.packages.some((p) => String(p.id) === id)) return send(404, { message: 'package not found' });
      const cancel = parsed as { itemIdList?: unknown; reasonId?: unknown } | null;
      if (action === 'unsupplied' && (!Array.isArray(cancel?.itemIdList) || !cancel.itemIdList.length || typeof cancel.reasonId !== 'number')) return send(400, { message: 'itemIdList ve reasonId zorunlu' });
      return send(200, {});
    }
    return send(404, { message: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () => new Promise((resolve) => server.close(() => resolve()));
  return site;
}
