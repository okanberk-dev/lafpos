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
 * Masa çağrıları (`calls`, laffogato 6 Kas 2026) sitenin `toPanelTableCalls` biçiminde (`panelCall`): site alanı her
 * zaman gönderir, yoksa `[]`; `POST /api/panel/calls/ack` sitenin `parsePanelCallAck` kuralıyla gövdeyi tam `{id,
 * actor}` ister, yanıtlanan çağrı listeden düşer. İmzalı uçlar imzayı sitenin kuralıyla doğrular, yanlışsa 401.
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
  lines: { menuItemId: string; name: string; size: 'M' | 'L' | 'single'; detail: string; note: string; qty: number; index?: number }[];
  totalMinor: number;
  path: string;
  /** Kasada ödendi (sözleşmeye sonradan eklenen alan; sitenin bugünkü fikstürü göndermez) */
  paidAtTill?: boolean;
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
/** Sitenin `calls` satırı (laffogato `PanelTableCall`): masa ve sebep, misafir yok */
export interface PanelCallFixture {
  id: string;
  tableCode: string;
  label: string;
  reason: string;
  createdAt: string;
}

/** Açık bir masa çağrısı: varsayılan "Masa S4", garson, bir dakika önce */
export const panelCall = (c: Partial<PanelCallFixture> & { id: string }): PanelCallFixture => ({
  tableCode: '',
  label: 'Masa S4',
  reason: 'waiter',
  createdAt: new Date(Date.now() - 60_000).toISOString(),
  ...c,
});

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
  /** İnternet yok: her istek yanıtsız kapanır (fetch "fetch failed" verir, LafPOS ağ hatası sayar) */
  offline: boolean;
  /** İnternet yokken gelen, yanıtsız kapanan istekler: "POST /api/panel/menu" gibi */
  dropped: string[];
  /** Herkese açık menü (ETag gövdeden üretilir, If-None-Match tutarsa 304) */
  menu: SiteMenuFixture;
  /** İmzalı panel menüsünde Satışta bilgisi: kimlik → isActive (fikstürde hepsi true) */
  panelActive: Map<string, boolean>;
  /** İmzalı panel menüsünde fiyat: kimlik → fiyat (yoksa fikstürdeki) */
  panelPrices: Map<string, { priceMinor: number; priceMinorL: number }>;
  /**
   * Panel menüsünün en üstüne eklenen alanlar: şube fiyatlı sitenin `nextPriceAt`'i (laffogato #301, şubenin bir sonraki
   * fiyat anı, yoksa null). Boşsa alan gönderilmez (şube fiyatı öncesi site)
   */
  panelTop: Record<string, unknown>;
  /**
   * Şubeli sitenin `onMenu`'su: kimlik → site kalemi menüden kaldırdı mı (false). Boşsa alan gönderilmez (şube öncesi
   * site). Menüden kalkmış kalemi açma isteği 409 `site_closed` alır (laffogato src/app/api/panel/menu/route.ts)
   */
  panelOnMenu: Map<string, boolean>;
  /** Sipariş listesinin `closed` alanı (akıştan çıkan siparişin sonucu); null: alan gönderilmez (bugünkü site) */
  closedOrders: { id: string; outcome: string }[] | null;
  /**
   * Sitenin yanıtlarda söylediği şube (`branch`, laffogato #279): null ise isteğin `?branch=`'i (şubeli site), undefined
   * ise alan hiç gönderilmez (eski site). Bir değer verilirse site her zaman o şubeyi söyler (yanlış şube denemesi)
   */
  answerBranch: string | null | undefined;
  /** Aşama ve çağrı yanıtında 409 geldiğinde hata: `stale` (sitenin bugünkü) ya da `wrong_branch` (başka şubenin) */
  conflictError: 'stale' | 'wrong_branch';
  /** İmzalı GET'lerin sorgusu: "GET /api/panel/orders?branch=marina" gibi */
  queries: string[];
  orders: { complete: boolean; orders: PanelOrderFixture[] };
  /** Sipariş listesinin `calls` alanı (açık masa çağrıları); null: alan hiç gönderilmez (eski site) */
  tableCalls: PanelCallFixture[] | null;
  /** Çağrı yanıtı (`POST /api/panel/calls/ack`) için sırayla durum kodları; boşsa sitenin kuralı (200 ya da 404) */
  callAckStatus: number[];
  callAcks: { id: string; actor: string }[];
  /** Sipariş listesinin biçim sürümü (site 1 gönderir); undefined: alan hiç gönderilmez (eski site) */
  ordersVersion: unknown;
  /** Panel menüsünün biçim sürümü (site 1 gönderir); undefined: alan hiç gönderilmez (eski site) */
  panelMenuVersion: unknown;
  version: string;
  /** Sürüm yanıtındaki karaoke işareti (F1); null: eski site, alan gönderilmez */
  karaokeMarker: string | null;
  /** Menü işareti (pub:menu); null: eski site, alan yok */
  menuMarker: string | null;
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
  menuPosts: { id: string; isActive?: boolean; actor: string; branch?: string }[];
  stagePosts: { id: string; action: string; from: string; actor: string; branch?: string }[];
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
    offline: false,
    dropped: [],
    menu: siteMenuFixture(),
    panelActive: new Map(panelMenu.items.map((i) => [i.id, i.isActive])),
    panelPrices: new Map(),
    panelTop: {},
    panelOnMenu: new Map(),
    closedOrders: null,
    answerBranch: undefined,
    conflictError: 'stale',
    queries: [],
    orders: (({ complete, orders }) => ({ complete, orders }))(siteOrdersFixture()),
    tableCalls: [],
    callAckStatus: [],
    callAcks: [],
    ordersVersion: 1,
    panelMenuVersion: panelMenu.version,
    version: 'v1',
    karaokeMarker: 'k1',
    menuMarker: null,
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
    if (site.offline) {
      site.dropped.push(`${req.method} ${new URL(req.url ?? '/', 'http://site.test').pathname}`);
      return req.socket.destroy();
    }
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
    if (req.method === 'GET') site.queries.push(`${call}${url.search}`);
    // Yanıttaki şube: eski site göndermez, şubeli site isteğinkini (yoksa LafPOS'un varsayılanı marina) söyler
    const branchField = () =>
      site.answerBranch === undefined ? {} : { branch: site.answerBranch ?? url.searchParams.get('branch') ?? 'marina' };

    if (call === 'GET /api/pos/orders/version')
      return send(200, { version: site.version, ...(site.karaokeMarker === null ? {} : { karaoke: site.karaokeMarker }), ...(site.menuMarker === null ? {} : { menu: site.menuMarker }) });
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
      return send(200, {
        version: site.ordersVersion,
        now: new Date().toISOString(),
        complete: site.orders.complete,
        orders: site.orders.orders,
        ...(site.tableCalls === null ? {} : { calls: site.tableCalls }),
        ...(site.closedOrders === null ? {} : { closed: site.closedOrders }),
        ...branchField(),
      });
    }
    if (call === 'POST /api/panel/calls/ack') {
      // Sitenin kuralı: katı JSON, tam olarak `{id, actor}`, ad 1-80 karakter
      let ack: { id?: unknown; actor?: unknown };
      try {
        ack = JSON.parse(raw) as typeof ack;
      } catch {
        return send(400, { error: 'invalid', field: 'body' });
      }
      // `branch` isteğe bağlı (laffogato #279)
      const extra = Object.keys(ack).find((k) => k !== 'id' && k !== 'actor' && k !== 'branch');
      if (extra) return send(400, { error: 'invalid', field: extra });
      if (typeof ack.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ack.id)) return send(400, { error: 'invalid', field: 'id' });
      const actor = typeof ack.actor === 'string' ? ack.actor.trim() : '';
      if (!actor || actor.length > 80) return send(400, { error: 'invalid', field: 'actor' });
      // Daha önce yanıtlanmış çağrı yine 200 (site ikinci kez yazmaz); hiç olmayan 404
      const known = !!site.tableCalls?.some((c) => c.id === ack.id) || site.callAcks.some((a) => a.id === ack.id);
      site.callAcks.push({ id: ack.id, actor });
      const code = site.callAckStatus.shift();
      if (code && code !== 200) return send(code, { error: code === 404 ? 'not_found' : code === 409 ? site.conflictError : 'unavailable' });
      if (!known && !code) return send(404, { error: 'not_found' });
      // Yanıtlanan çağrı açık listeden düşer
      if (site.tableCalls) site.tableCalls = site.tableCalls.filter((c) => c.id !== ack.id);
      return send(200, { ok: true, call: { id: ack.id, status: 'acked' } });
    }
    if (call === 'POST /api/panel/orders/stage') {
      const change = JSON.parse(raw) as FakeSite['stagePosts'][number];
      site.stagePosts.push(change);
      const code = site.stageStatus.shift() ?? 200;
      if (code === 404) return send(404, { error: 'not_found' });
      if (code === 409) return send(409, { error: site.conflictError, order: null });
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
      return send(200, {
        ...panelMenu,
        ...branchField(),
        ...site.panelTop,
        version: site.panelMenuVersion,
        items: panelMenu.items.map((i) => ({
          ...i,
          isActive: snapshot.get(i.id) ?? i.isActive,
          ...(site.panelOnMenu.size ? { onMenu: site.panelOnMenu.get(i.id) ?? true } : {}),
          ...(site.panelPrices.get(i.id) ?? {}),
        })),
      });
    }
    if (call === 'POST /api/panel/menu') {
      const change = JSON.parse(raw) as FakeSite['menuPosts'][number];
      site.menuPosts.push(change);
      const code = site.menuPostStatus.shift() ?? 200;
      if (code !== 200) return send(code, { error: code === 404 ? 'not_found' : 'unavailable' });
      if (change.isActive === true && site.panelOnMenu.get(change.id) === false) return send(409, { error: 'site_closed' });
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
