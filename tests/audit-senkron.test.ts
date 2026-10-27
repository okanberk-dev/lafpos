import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PanelOrder } from '../server/sync/laffogato-orders';
import { type Harness, startApp } from './harness';

/**
 * Senkron denetiminin bulguları (27 Eki 2026), her biri bir testle: online siparişlerin sürüm sinyali, bozuk
 * yanıt ve masa eşlemesi. Site sahte: `fetch` sitenin adresinde bu dosyanın yönlendiricisine düşer.
 */
const SITE = 'https://laffogato.test';
const KEY = 's'.repeat(40);
let h: Harness;

type Route = (path: string, init: RequestInit) => Response | Promise<Response> | undefined;
let site: Route = () => undefined;
const calls: string[] = [];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeAll(async () => {
  h = await startApp({ LAFFOGATO_URL: SITE, LAFFOGATO_SYNC_SECRET: KEY, LAFPOS_SESSION_HOURS: '1000000' });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(SITE)) return realFetch(input, init);
    const path = url.slice(SITE.length);
    calls.push(`${init.method ?? 'GET'} ${path}`);
    return (await site(path, init)) ?? json({ error: 'not_found' }, 404);
  });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
});
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h.cleanup();
});

const db = async () => {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return { db, schema, eq };
};

const panelOrder = (id: string, extra: Partial<PanelOrder> = {}): PanelOrder => ({
  id,
  orderNo: Number(id.replace(/\D/g, '')) || 1,
  stage: 'new',
  fulfillment: 'pickup',
  label: 'Gel-al',
  firstName: 'Ece',
  scheduledFor: '',
  note: '',
  paidAt: new Date().toISOString(),
  lines: [{ menuItemId: 'mnu-0001', name: 'Matcha Latte', size: 'single', detail: '', note: '', qty: 1 }],
  totalMinor: 21500,
  ...extra,
});

async function onlineRow(extId: string) {
  const { db: d, schema, eq } = await db();
  const o = d.select().from(schema.orders).where(eq(schema.orders.extId, extId)).get();
  const items = o ? d.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, o.id)).all() : [];
  return o ? { ...o, itemStatus: items.map((i) => i.status) } : undefined;
}

describe('online siparişler', () => {
  it('sürüm değiştikten sonra başarısız çekme 5 dk içinde yeniden denenir; arada siteye yüklenilmez', async () => {
    // Bu test dosyanın ilk online testi olmalı: zamanlayıcının modül durumu (son sürüm, son çekme) temiz
    const { onlineOrdersTick } = await import('../server/sync/laffogato-orders');
    let fail = true;
    let pulls = 0;
    site = (path) => {
      if (path === '/api/pos/orders/version') return json({ version: 'v-yeni-siparis' });
      if (path === '/api/panel/orders') {
        pulls++;
        if (fail) {
          fail = false;
          return json({ error: 'unavailable' }, 503);
        }
        return json({ version: 1, complete: true, orders: [panelOrder('ord-surum')] });
      }
      return undefined;
    };
    const t0 = Date.now();
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // 20 sn'de bir, 6 dakika
      for (let i = 0; i <= 18; i++) {
        offset = i * 20_000;
        await onlineOrdersTick();
        await new Promise((r) => setTimeout(r, 5));
      }
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
    expect(await onlineRow('ord-surum'), 'sitede ödenmiş sipariş bar ekranına düşmeli').toBeTruthy();
    // İlk deneme + 5 dk sonra bir yeniden deneme; her 20 sn'de değil
    expect(pulls).toBe(2);
  });

  it('200 ama siparişsiz ya da bozuk gövde başarısız çekme sayılır; açık online sipariş kapanmaz', async () => {
    const { syncOnlineOrders } = await import('../server/sync/laffogato-orders');
    let reply: () => Response = () => json({ version: 1, complete: true, orders: [panelOrder('ord-bozuk')] });
    site = (path) => (path === '/api/panel/orders' ? reply() : undefined);
    await syncOnlineOrders();
    expect((await onlineRow('ord-bozuk'))?.status).toBe('acik');

    for (const bad of [
      () => new Response('<html>Bakım</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => json({ error: 'x' }),
      () => json({ orders: 'yok' }),
    ]) {
      reply = bad;
      await expect(syncOnlineOrders()).rejects.toThrow();
      const row = await onlineRow('ord-bozuk');
      expect(row?.status).toBe('acik');
      expect(row?.itemStatus).toEqual(['yeni']);
    }

    // Kesik liste (sitenin 200 sınırı aşıldı): listede olmayan açık sipariş kapatılmaz
    reply = () => json({ version: 1, complete: false, orders: [] });
    await syncOnlineOrders();
    expect((await onlineRow('ord-bozuk'))?.status).toBe('acik');
  });

  it('yerelde kapanmış ama sitede hâlâ açık sipariş yeniden açılır; site bitirince kapanır', async () => {
    const { upsertOnlineOrders, onlineStatus } = await import('../server/sync/laffogato-orders');
    upsertOnlineOrders([panelOrder('ord-hayalet')]);
    // Eski sürümün bozuk yanıtla kapattığı sipariş
    upsertOnlineOrders([]);
    expect((await onlineRow('ord-hayalet'))?.status).toBe('kapali');
    const openBefore = onlineStatus().open;

    upsertOnlineOrders([panelOrder('ord-hayalet', { stage: 'preparing' })]);
    const back = await onlineRow('ord-hayalet');
    expect(back?.status).toBe('acik');
    expect(back?.closedAt).toBeNull();
    expect(back?.extStage).toBe('preparing');
    expect(back?.itemStatus).toEqual(['hazirlaniyor']);
    expect(onlineStatus().open).toBe(openBefore + 1);

    upsertOnlineOrders([]);
    const done = await onlineRow('ord-hayalet');
    expect(done?.status).toBe('kapali');
    expect(done?.itemStatus).toEqual(['servis']);
  });

  it('masa siparişi etiketteki masa adıyla da masaya düşer (site masa kodu tanımlı değilken)', async () => {
    const { upsertOnlineOrders } = await import('../server/sync/laffogato-orders');
    const s2 = h.boot.tables.find((t) => t.name === 'S2')!;
    const b3 = h.boot.tables.find((t) => t.name === 'B3')!;
    expect(s2.siteTableCode).toBeNull();
    upsertOnlineOrders([
      panelOrder('ord-masa1', { fulfillment: 'table', label: 'S2' }),
      panelOrder('ord-masa2', { fulfillment: 'table', label: 'Masa b3' }),
      panelOrder('ord-masa3', { fulfillment: 'table', label: 'Masa 99' }),
    ]);
    expect((await onlineRow('ord-masa1'))?.tableId).toBe(s2.id);
    expect((await onlineRow('ord-masa2'))?.tableId).toBe(b3.id);
    expect((await onlineRow('ord-masa3'))?.tableId).toBeNull();
  });
});
