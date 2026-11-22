import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformOrderPayload } from '@shared/platforms';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Oturum denetiminin kasa bulguları:
 * - müdür patronun telefon bildirimlerini kapatamaz ya da eşiği yükseltemez; değişiklik eski ve yeni değerle kayıtta
 * - adisyonun toptan iptali de büyük iptal bildirimi (az önce girilmiş adisyon hariç)
 * - bildirim kuyruğu: boşaltma sürerken gelen bildirim kaybolmaz, eşzamanlı boşaltma çift göndermez
 * - lisans kapalıyken platform siparişi de yeni satış (kabul edilmez, otomatik kabul bekletir); kalem taşıma sürer
 */
const CLOUD = 'https://denetim-kasa.test';
const SECRET = 'k'.repeat(40);
const sent: string[] = [];
let mode: 'up' | 'down' | 'hang' = 'up';
let hangGate: Promise<void> | null = null;
let hung = 0;
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET, merkezUrl: '' });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (!url.startsWith(CLOUD)) return realFetch(input, init);
    if (!url.endsWith('/api/uzaktan/bildirim')) return new Response('{}', { status: 404 });
    if (mode === 'down') throw new TypeError('fetch failed');
    if (mode === 'hang') {
      // İlk istek takılır (bağlantı kopukken süren TCP), sonrakiler hemen düşer
      if (hung++ === 0) await hangGate;
      else throw new TypeError('fetch failed');
    }
    sent.push((JSON.parse(String(init!.body)) as { title: string }).title);
    return Response.json({ ok: true, sent: 1 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const lastAudit = async (action: string) => {
  const { db, schema } = await import('../server/db/client');
  const { desc, eq } = await import('drizzle-orm');
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).orderBy(desc(schema.auditLog.at)).get()!;
};

describe('telefon bildirimi ayarı', () => {
  it('müdür bildirimi kapatamaz ve eşiği yükseltemez; düşürebilir (kayıtta uyarı, eski ve yeni değer)', async () => {
    expect((await h.call('mudur', 'PUT', '/sync/bildirim', { enabled: false })).status).toBe(403);
    expect((await h.call('mudur', 'PUT', '/sync/bildirim', { voidMin: 100_000_000, cashDiffMin: 100_000_000 })).status).toBe(403);
    expect((await h.call('mudur', 'PUT', '/sync/bildirim', { pavo: false })).status).toBe(403);
    const lower = await h.call<{ settings: { voidMin: number } }>('mudur', 'PUT', '/sync/bildirim', { voidMin: 30_000 });
    expect(lower.status).toBe(200);
    const row = await lastAudit('ayar');
    expect(row).toMatchObject({ severity: 'uyari' });
    expect(row.message).toMatch(/iptal eşiği ₺500.*→ ₺300/);
    // Patron kapatabilir (bilgi önemiyle)
    expect((await h.call('patron', 'PUT', '/sync/bildirim', { enabled: false })).status).toBe(200);
    expect(await lastAudit('ayar')).toMatchObject({ severity: 'info' });
    expect((await h.call('patron', 'PUT', '/sync/bildirim', { enabled: true, voidMin: 50_000 })).status).toBe(200);
  });
});

describe('adisyon iptali bildirimi', () => {
  it('hazırlanmış büyük adisyonun toptan iptali patrona gider; az önce girilen adisyonunki gitmez', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    sent.length = 0;
    // Az önce girilmiş, hazırlanmamış: onaysız kapanır, bildirim yok
    let fresh = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    fresh = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${fresh.id}/items`, { items: [{ productId: product('Latte').id, qty: 20 }] });
    await h.ok('kasa', 'POST', `/orders/${fresh.id}/cancel`, { reason: 'Yanlış adisyon' });
    // Büyük adisyon: kalemler bir saat önce gönderilmiş
    let big = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    big = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${big.id}/items`, { items: [{ productId: product('Latte').id, qty: 20 }] });
    db.update(schema.orderItems).set({ sentAt: Date.now() - 3600_000 }).where(eq(schema.orderItems.orderId, big.id)).run();
    await h.ok('kasa', 'POST', `/orders/${big.id}/cancel`, { reason: 'Müşteri gitti', approverPin: PINS.mudur });
    await new Promise((r) => setTimeout(r, 50));
    const notices = sent.filter((t) => t.startsWith('Büyük iptal'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatch(/^Büyük iptal: ₺/);
  });
});

describe('bildirim kuyruğu', () => {
  it('boşaltma sürerken gelen bildirim kaybolmaz; iki boşaltma aynı bildirimi iki kez göndermez', async () => {
    const { flushNotices, notify, pendingNotices } = await import('../server/sync/bildirim');
    sent.length = 0;
    mode = 'down';
    await notify({ kind: 'deneme', title: 'A', body: 'a' });
    expect(pendingNotices()).toBe(1);
    let open!: () => void;
    hangGate = new Promise<void>((r) => (open = r));
    hung = 0;
    mode = 'hang';
    const first = flushNotices();
    const second = flushNotices();
    await new Promise((r) => setTimeout(r, 20));
    // Bağlantı kopuk: yeni bildirim hemen düşer, kuyruğa girer
    await notify({ kind: 'deneme', title: 'B', body: 'b' });
    mode = 'up';
    open();
    await Promise.all([first, second]);
    expect(sent.filter((t) => t === 'A')).toHaveLength(1);
    // B ya gitti ya kuyrukta: kaybolmadı
    expect(sent.filter((t) => t === 'B').length + pendingNotices()).toBe(1);
    await flushNotices();
    expect(sent.filter((t) => t === 'B')).toHaveLength(1);
    expect(pendingNotices()).toBe(0);
  });
});

describe('lisans kapalıyken platform siparişi', () => {
  it('kabul edilmez (adisyon açılmaz), otomatik kabul "lisans kapalı" der; kalem taşıma sürer', async () => {
    const { env } = await import('../server/env');
    const { setSyncState } = await import('../server/lib/settings');
    const { db, schema, tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    const service = await import('../server/delivery/service');
    const { autoAcceptBlocker } = await import('../server/delivery/live');
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
    // Önce açık adisyon (lisans açıkken)
    let open = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    open = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${open.id}/items`, { items: [{ productId: product('Latte').id, qty: 2 }] });
    const payload: PlatformOrderPayload = { platform: 'yemeksepeti', simulated: true, externalId: `ys-${Math.random()}`, code: 'LIS1', placedAt: Date.now(), scheduledFor: null, courier: 'platform', platformCollects: true, paymentLabel: 'Online kart', customer: { name: 'Deniz A.', phone: null, address: null }, note: null, lines: [{ externalId: 'l', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: [], note: null }], subtotal: 19000, restaurantDiscount: 0, platformDiscount: 0, customerTotal: 19000 };
    const fx = new Effects();
    const row = tx((t) => service.ingestPlatformOrder(t, fx, payload)).row;
    fx.flush();
    Object.assign(env, { merkezUrl: CLOUD });
    setSyncState('merkez.son', { ad: 'Marina', lisans: { durum: 'pasif', pasifAt: Date.now() - 8 * 86_400_000 }, mod: 'elle', hedef: null, at: Date.now() });
    try {
      const before = db.select().from(schema.orders).all().length;
      const res = await h.call<{ code: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
      expect(res.status).toBe(403);
      expect(res.json.code).toBe('license_blocked');
      expect(db.select().from(schema.orders).all().length).toBe(before);
      expect(autoAcceptBlocker(service.getPlatformOrder(db, row.id))).toBe('lisans kapalı');
      // Açık adisyonun kalemi ayrı hesaba taşınabilir (hesap bölme yeni satış değil)
      const moved = await h.call('kasa', 'POST', `/orders/${open.id}/transfer`, { items: [{ itemId: open.items[0]!.id, qty: 1 }], approverPin: PINS.mudur });
      expect(moved.status).toBe(200);
    } finally {
      Object.assign(env, { merkezUrl: '' });
    }
  });
});
