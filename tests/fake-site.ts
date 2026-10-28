import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sign } from '../server/lib/signature';

/**
 * Testler için sahte laffogato: LafPOS'un konuştuğu uçlar, sitenin yanıt biçimleriyle. Gövdeler sitenin kendi
 * kodundan üretilmiş fikstürlerdir (laffogato d1de10f): `site-panel-orders.json` `toPanelOrder` ve `sortForPanelOrders`
 * çıktısı (src/lib/panel/orders-feed-core.ts), `site-panel-menu.json` `toPanelMenuItem` ve `sortForPanelMenu` çıktısı
 * (src/lib/panel/menu-link-core.ts); herkese açık menü LafPOS'un `server/db/menu-snapshot.json`'u (sitenin
 * `GET /api/mobile/v1/menu` yanıtının kopyası). `site-panel-karaoke.json` laffogato cc0e40a'nın (F1, #264)
 * `toPanelReservation` ve `sortForPanel` çıktısıdır (src/lib/panel/karaoke-sync-core.ts): beş satır, sitenin
 * okuma kurallarının her biri için bir tane (ödenmiş, köşkte ödenecek, ücretsiz telafi, iptal, ödemesi süren).
 * İmzalı uçlar imzayı sitenin kuralıyla doğrular, yanlışsa 401.
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

type SiteOrdersFixture = { version: number; now: string; complete: boolean; orders: PanelOrderFixture[] };
/**
 * Fikstürün saatleri gerçek saate kaydırılır: sitenin yanıtındaki `now` bu dosya ilk okunduğu ana denk gelir, ödeme ve
 * planlı saatler aynı aralıkla kayar. Sabit tarihli fikstür bar ekranının 12-24 saatlik penceresinden bir gün sonra
 * düşüyordu (28 Ekim 2026). Kayma bir kez hesaplanır: aynı test dosyasındaki her çağrı aynı saatleri görür.
 */
let ordersShift: number | null = null;
const shiftIso = (iso: string, ms: number) => (iso ? new Date(Date.parse(iso) + ms).toISOString() : iso);
export const siteOrdersFixture = (): SiteOrdersFixture => {
  const raw = readJson<SiteOrdersFixture>('tests/fixtures/site-panel-orders.json');
  ordersShift ??= Date.now() - Date.parse(raw.now);
  const ms = ordersShift;
  return { ...raw, now: shiftIso(raw.now, ms), orders: raw.orders.map((o) => ({ ...o, paidAt: shiftIso(o.paidAt, ms), scheduledFor: shiftIso(o.scheduledFor, ms) })) };
};
export const sitePanelMenuFixture = () => readJson<{ version: number; now: string; items: { id: string; isActive: boolean; priceMinor: number; priceMinorL: number }[] }>('tests/fixtures/site-panel-menu.json');
export const siteMenuFixture = () => readJson<SiteMenuFixture>('server/db/menu-snapshot.json');

export interface PanelKaraokeFixture {
  id: string;
  date: string;
  startHour: number;
  hours: number;
  startsAt: string;
  endsAt: string;
  guests: number;
  status: string;
  paymentStatus: string;
  firstName: string;
  note: string;
  totalMinor: number;
  channel: string;
  createdAt: string;
  updatedAt: string;
}
export const siteKaraokeFixture = () => readJson<{ now: string; from: string; to: string; complete: boolean; reservations: PanelKaraokeFixture[] }>('tests/fixtures/site-panel-karaoke.json');

/** Fikstürün satırlarını istenen güne taşır (fikstür 2026-10-27; saatler İstanbul, sabit UTC+3) */
export function karaokeOn(day: string, rows: PanelKaraokeFixture[]): PanelKaraokeFixture[] {
  const shift = Date.parse(`${day}T00:00:00Z`) - Date.parse('2026-10-27T00:00:00Z');
  const move = (iso: string) => new Date(Date.parse(iso) + shift).toISOString();
  return rows.map((r) => ({ ...r, date: day, startsAt: move(r.startsAt), endsAt: move(r.endsAt) }));
}

export interface FakeSite {
  url: string;
  close: () => Promise<void>;
  /** Herkese açık menü (ETag gövdeden üretilir, If-None-Match tutarsa 304) */
  menu: SiteMenuFixture;
  /** İmzalı panel menüsünde Satışta bilgisi: kimlik → isActive (fikstürde hepsi true) */
  panelActive: Map<string, boolean>;
  orders: { complete: boolean; orders: PanelOrderFixture[] };
  /** Sipariş listesinin biçim sürümü (site 1 gönderir); undefined: alan hiç gönderilmez (eski site) */
  ordersVersion: unknown;
  /** Panel menüsünün biçim sürümü (site 1 gönderir); undefined: alan hiç gönderilmez (eski site) */
  panelMenuVersion: unknown;
  version: string;
  /** Sürüm yanıtındaki karaoke işareti (F1); null: eski site, alan gönderilmez */
  karaokeMarker: string | null;
  /** Sitenin karaoke rezervasyonları; tarih, sorulan güne (`from`) taşınır */
  karaoke: PanelKaraokeFixture[];
  karaokeStatus: number[];
  /** Karaoke listesinin yanıt gecikmesi (yavaş site; ms) */
  karaokeDelayMs: number;
  /** Herkese açık müsaitlik yanıtındaki saat ücreti */
  karaokeHourly: number;
  /** Sırayla kullanılacak durum kodları; boşsa 200 */
  ordersStatus: number[];
  panelMenuStatus: number[];
  /** Verilirse imzalı panel menüsünün yanıtı bu söz çözülene dek bekletilir (yanıt ağdayken olanları denemek için) */
  panelMenuGate: Promise<void> | null;
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
    ordersVersion: 1,
    panelMenuVersion: panelMenu.version,
    version: 'v1',
    karaokeMarker: 'k1',
    karaoke: siteKaraokeFixture().reservations,
    karaokeStatus: [],
    karaokeDelayMs: 0,
    karaokeHourly: 90000,
    ordersStatus: [],
    panelMenuStatus: [],
    panelMenuGate: null,
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
    if (call === 'GET /api/mobile/v1/karaoke/availability') {
      return send(200, { date: url.searchParams.get('date') ?? '2026-10-27', slots: [], hourlyMinor: site.karaokeHourly, capacity: 8, firstHour: 12, closeHour: 24, maxHours: 4 });
    }

    // İmzalı uçlar: sitenin kuralı (zaman damgası penceresi testte saati oynattığımız için denetlenmez)
    const ts = Number(req.headers['x-laf-timestamp']);
    const expected = `v1=${sign(secret, { timestamp: ts, method: req.method ?? 'GET', url, body: raw })}`;
    if (req.headers['x-laf-signature'] !== expected) return send(401, { error: 'unauthorized' });

    if (call === 'GET /api/pos/orders/version') return send(200, site.karaokeMarker === null ? { version: site.version } : { version: site.version, karaoke: site.karaokeMarker });
    if (call === 'GET /api/panel/karaoke') {
      if (site.karaokeDelayMs) await new Promise((r) => setTimeout(r, site.karaokeDelayMs));
      const code = site.karaokeStatus.shift() ?? 200;
      if (code === 503) return send(503, { error: 'not_configured' });
      if (code !== 200) return send(code, { error: code === 403 ? 'forbidden' : code === 401 ? 'unauthorized' : 'unavailable' });
      const from = url.searchParams.get('from') ?? '';
      const to = url.searchParams.get('to') ?? '';
      // LafPOS'un anahtarı yalnız dünden yarına (sitenin `withinLafposKaraokeReach`'i; burada pencere tek gün mü)
      if (!from || from !== to) return send(403, { error: 'forbidden' });
      return send(200, { now: new Date().toISOString(), from, to, complete: true, reservations: karaokeOn(from, site.karaoke) });
    }
    if (call === 'GET /api/panel/orders') {
      const code = site.ordersStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: 'unavailable' });
      return send(200, { version: site.ordersVersion, now: new Date().toISOString(), complete: site.orders.complete, orders: site.orders.orders });
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
      // Site listeyi istek anında okur; yanıt ağda bekleyebilir
      const snapshot = new Map(site.panelActive);
      if (site.panelMenuGate) await site.panelMenuGate;
      const code = site.panelMenuStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: 'unavailable' });
      return send(200, { ...panelMenu, version: site.panelMenuVersion, items: panelMenu.items.map((i) => ({ ...i, isActive: snapshot.get(i.id) ?? i.isActive })) });
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
