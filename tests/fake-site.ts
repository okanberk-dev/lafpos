import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from '../server/lib/signature';

/**
 * Testler için sahte laffogato: LafPOS'un konuştuğu beş uç, sitenin yanıt biçimleriyle. Gövdeler sitenin kendi
 * kodundan üretilmiş fikstürlerdir (laffogato d1de10f): `site-panel-orders.json` `toPanelOrder` ve `sortForPanelOrders`
 * çıktısı (src/lib/panel/orders-feed-core.ts), `site-panel-menu.json` `toPanelMenuItem` ve `sortForPanelMenu` çıktısı
 * (src/lib/panel/menu-link-core.ts); herkese açık menü LafPOS'un `server/db/menu-snapshot.json`'u (sitenin
 * `GET /api/mobile/v1/menu` yanıtının kopyası). İmzalı uçlar imzayı sitenin kuralıyla doğrular, yanlışsa 401.
 */

const root = fileURLToPath(new URL('..', import.meta.url));
const readJson = <T>(p: string): T => JSON.parse(readFileSync(join(root, p), 'utf8')) as T;

export interface PanelOrderFixture {
  id: string;
  orderNo: number;
  stage: 'new' | 'preparing' | 'ready';
  fulfillment: 'table' | 'pickup' | 'delivery';
  label: string;
  firstName: string;
  scheduledFor: string;
  note: string;
  paidAt: string;
  lines: { menuItemId: string; name: string; size: 'M' | 'L' | 'single'; detail: string; note: string; qty: number }[];
  totalMinor: number;
  path: string;
}

export interface SiteMenuFixture {
  categories: { key: string; title: string; items: { id: string; name: string; priceMinor: number; priceLargeMinor: number | null; image?: string | null }[] }[];
  customization: unknown;
  updatedAt?: string;
}

export const siteOrdersFixture = () => readJson<{ version: number; now: string; complete: boolean; orders: PanelOrderFixture[] }>('tests/fixtures/site-panel-orders.json');
export const sitePanelMenuFixture = () => readJson<{ version: number; now: string; items: { id: string; isActive: boolean; priceMinor: number; priceMinorL: number }[] }>('tests/fixtures/site-panel-menu.json');
export const siteMenuFixture = () => readJson<SiteMenuFixture>('server/db/menu-snapshot.json');

export interface FakeSite {
  url: string;
  close: () => Promise<void>;
  /** Herkese açık menü (ETag gövdeden üretilir, If-None-Match tutarsa 304) */
  menu: SiteMenuFixture;
  /** İmzalı panel menüsünde Satışta bilgisi: kimlik → isActive (fikstürde hepsi true) */
  panelActive: Map<string, boolean>;
  orders: { complete: boolean; orders: PanelOrderFixture[] };
  version: string;
  /** Sırayla kullanılacak durum kodları; boşsa 200 */
  ordersStatus: number[];
  panelMenuStatus: number[];
  menuPostStatus: number[];
  stageStatus: number[];
  /** Gelen istekler: "GET /api/panel/orders" gibi */
  calls: string[];
  menuPosts: { id: string; isActive?: boolean; actor: string }[];
  stagePosts: { id: string; action: string; from: string; actor: string }[];
  count: (call: string) => number;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw;
}

export async function startFakeSite(secret: string): Promise<FakeSite> {
  const panelMenu = sitePanelMenuFixture();
  const site: FakeSite = {
    url: '',
    close: async () => undefined,
    menu: siteMenuFixture(),
    panelActive: new Map(panelMenu.items.map((i) => [i.id, i.isActive])),
    orders: (({ complete, orders }) => ({ complete, orders }))(siteOrdersFixture()),
    version: 'v1',
    ordersStatus: [],
    panelMenuStatus: [],
    menuPostStatus: [],
    stageStatus: [],
    calls: [],
    menuPosts: [],
    stagePosts: [],
    count: (call) => site.calls.filter((c) => c === call).length,
  };

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    const url = new URL(req.url ?? '/', 'http://site.test');
    const call = `${req.method} ${url.pathname}`;
    site.calls.push(call);
    const send = (code: number, body?: unknown, headers: Record<string, string> = {}) => {
      res.writeHead(code, { 'content-type': 'application/json', ...headers });
      res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    if (call === 'GET /api/mobile/v1/menu') {
      const body = JSON.stringify(site.menu);
      const etag = `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
      if (req.headers['if-none-match'] === etag) return send(304, undefined, { etag });
      res.writeHead(200, { 'content-type': 'application/json', etag });
      return res.end(body);
    }

    // İmzalı uçlar: sitenin kuralı (zaman damgası penceresi testte saati oynattığımız için denetlenmez)
    const ts = Number(req.headers['x-laf-timestamp']);
    const expected = `v1=${sign(secret, { timestamp: ts, method: req.method ?? 'GET', url, body: raw })}`;
    if (req.headers['x-laf-signature'] !== expected) return send(401, { error: 'unauthorized' });

    if (call === 'GET /api/pos/orders/version') return send(200, { version: site.version });
    if (call === 'GET /api/panel/orders') {
      const code = site.ordersStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: 'unavailable' });
      return send(200, { version: 1, now: new Date().toISOString(), complete: site.orders.complete, orders: site.orders.orders });
    }
    if (call === 'POST /api/panel/orders/stage') {
      const change = JSON.parse(raw) as FakeSite['stagePosts'][number];
      site.stagePosts.push(change);
      const code = site.stageStatus.shift() ?? 200;
      if (code === 404) return send(404, { error: 'not_found' });
      if (code === 409) return send(409, { error: 'stale', order: null });
      if (code !== 200) return send(code, { error: 'unavailable' });
      const order = site.orders.orders.find((o) => o.id === change.id) ?? null;
      return send(200, { order: order && change.action === 'preparing' ? { ...order, stage: 'preparing' } : null });
    }
    if (call === 'GET /api/panel/menu') {
      const code = site.panelMenuStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: 'unavailable' });
      return send(200, { ...panelMenu, items: panelMenu.items.map((i) => ({ ...i, isActive: site.panelActive.get(i.id) ?? i.isActive })) });
    }
    if (call === 'POST /api/panel/menu') {
      const change = JSON.parse(raw) as FakeSite['menuPosts'][number];
      site.menuPosts.push(change);
      const code = site.menuPostStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: code === 404 ? 'not_found' : 'unavailable' });
      if (change.isActive !== undefined) site.panelActive.set(change.id, change.isActive);
      const item = panelMenu.items.find((i) => i.id === change.id);
      return send(200, { item: { ...item, isActive: site.panelActive.get(change.id) } });
    }
    return send(404, { error: 'not_found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  site.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  site.close = () => new Promise<void>((r) => server.close(() => r()));
  return site;
}
