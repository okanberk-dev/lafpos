import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Permission, ROLE_DEFAULTS, type Role } from '@shared/permissions';
import {
  asksNumarator,
  callFor,
  callText,
  DEFAULT_SERVICE_MODE,
  isCounterFirst,
  normalizeNumarator,
  SERVICE_MODE_HINT,
  SERVICE_MODE_LABEL,
  SERVICE_MODES,
  serviceModeOf,
  showsTables,
  ticketHead,
} from '@shared/service-mode';
import type { BootstrapDTO, KitchenTicket, OrderDTO, PickupBoardDTO } from '@shared/types';
import { homePath, navFor, POS_NAV, visibleNav } from '../src/lib/nav';
import { type Harness, startApp } from './harness';

/**
 * Servis modu: masaya servis (varsayılan, bugünkü akış), yarı self (kasada sipariş ve ödeme, masa no /
 * numaratörle masaya servis) ve self servis (kasada sipariş ve ödeme, numara çağrılınca tezgâhtan alınır).
 */
const canAs = (role: Role) => (p: Permission) => ROLE_DEFAULTS[role].includes(p);
const tos = (items: { to: string }[]) => items.map((n) => n.to);

describe('servis modu: saf yardımcılar', () => {
  it('varsayılan masaya servis; tanınmayan ya da eksik ayar bugünkü akışa düşer', () => {
    expect(DEFAULT_SERVICE_MODE).toBe('masa');
    expect(serviceModeOf(undefined)).toBe('masa');
    expect(serviceModeOf({})).toBe('masa');
    expect(serviceModeOf({ serviceMode: 'garip' })).toBe('masa');
    expect(serviceModeOf({ serviceMode: 'self' })).toBe('self');
    expect(serviceModeOf({ serviceMode: 'yari_self' })).toBe('yari_self');
    expect(isCounterFirst('masa')).toBe(false);
    expect(isCounterFirst('self')).toBe(true);
    expect(isCounterFirst('yari_self')).toBe(true);
    expect(serviceModeOf({ serviceMode: 'qr_self' })).toBe('qr_self');
    expect(isCounterFirst('qr_self')).toBe(true);
    expect(asksNumarator('qr_self')).toBe(false);
    expect(showsTables('masa')).toBe(true);
    expect(showsTables('yari_self')).toBe(true);
    expect(showsTables('qr_self')).toBe(true);
    expect(showsTables('self')).toBe(false);
    expect(asksNumarator('yari_self')).toBe(true);
    expect(asksNumarator('self')).toBe(false);
    expect(asksNumarator('masa')).toBe(false);
  });

  it('her modun adı ve tek satırlık açıklaması var; sonda nokta yok', () => {
    for (const m of SERVICE_MODES) {
      expect(SERVICE_MODE_LABEL[m]).toBeTruthy();
      expect(SERVICE_MODE_HINT[m]).toBeTruthy();
      expect(SERVICE_MODE_HINT[m]).not.toMatch(/\.$/);
      expect(SERVICE_MODE_HINT[m]).not.toMatch(/\n/);
    }
    expect(SERVICE_MODE_LABEL).toEqual({ masa: 'Masaya servis', yari_self: 'Yarı self servis', self: 'Self servis', qr_self: 'QR + self servis' });
  });

  it('açılış sayfası: masaya serviste masa planı, self modlarda yeni satış; sipariş almayanlar değişmez', () => {
    expect(homePath(canAs('garson'))).toBe('/masalar');
    expect(homePath(canAs('kasiyer'), 'masa')).toBe('/masalar');
    expect(homePath(canAs('kasiyer'), 'self')).toBe('/satis');
    expect(homePath(canAs('kasiyer'), 'yari_self')).toBe('/satis');
    expect(homePath(canAs('patron'), 'self')).toBe('/satis');
    expect(homePath(canAs('kasiyer'), 'qr_self')).toBe('/satis');
    for (const m of SERVICE_MODES) {
      expect(homePath(canAs('mutfak'), m)).toBe('/mutfak');
      expect(homePath(canAs('kurye'), m)).toBe('/siparisler');
    }
  });

  it('menü: masaya serviste bugünkü menü; yarı selfte Satış başta, Masalar ikinci planda', () => {
    expect(navFor('masa')).toBe(POS_NAV);
    expect(tos(visibleNav(canAs('kasiyer'), 'masa'))).not.toContain('/satis');

    const yari = visibleNav(canAs('kasiyer'), 'yari_self');
    expect(yari[0].to).toBe('/satis');
    expect(yari[0].primary).toBe(true);
    const masalar = yari.find((n) => n.to === '/masalar');
    expect(masalar?.primary).toBe(false);
    // Telefonda ilk dört birincil sekme: Satış, Siparişler, Bar, Kasa (Masalar "Daha"da)
    expect(tos(yari.filter((n) => n.primary).slice(0, 4))).toEqual(['/satis', '/siparisler', '/mutfak', '/kasa']);
    // QR + self: yarı self gibi Satış başta, Masalar hep menüde (QR siparişi masaya düşer) ama ikinci planda
    const qr = visibleNav(canAs('kasiyer'), 'qr_self');
    expect(qr[0].to).toBe('/satis');
    expect(qr.find((n) => n.to === '/masalar')?.primary).toBe(false);
    expect(tos(visibleNav(canAs('kasiyer'), 'qr_self', { tablesInUse: false }))).toContain('/masalar');
  });

  it('self serviste Masalar yalnız masa kullanılıyorsa görünür', () => {
    expect(tos(visibleNav(canAs('kasiyer'), 'self'))).not.toContain('/masalar');
    expect(tos(visibleNav(canAs('kasiyer'), 'self', { tablesInUse: false }))).not.toContain('/masalar');
    const used = visibleNav(canAs('kasiyer'), 'self', { tablesInUse: true });
    expect(tos(used)).toContain('/masalar');
    expect(used.find((n) => n.to === '/masalar')?.primary).toBe(false);
    // Bar ekranı Satış görmez (sipariş alma yetkisi yok)
    expect(tos(visibleNav(canAs('mutfak'), 'self'))).toEqual(['/mutfak']);
  });

  it('masa no / numaratör: 1-6 harf ya da rakam, Türkçe büyük harf; boş temizler, geçersiz undefined', () => {
    expect(normalizeNumarator('12')).toBe('12');
    expect(normalizeNumarator(' 12 ')).toBe('12');
    expect(normalizeNumarator(7)).toBe('7');
    expect(normalizeNumarator('b4')).toBe('B4');
    expect(normalizeNumarator('i-3')).toBe('İ3');
    expect(normalizeNumarator('')).toBeNull();
    expect(normalizeNumarator('   ')).toBeNull();
    expect(normalizeNumarator(null)).toBeNull();
    expect(normalizeNumarator('1234567')).toBeUndefined();
    expect(normalizeNumarator('12;')).toBeUndefined();
    expect(normalizeNumarator({})).toBeUndefined();
  });

  it('çağrı kimliği: numaratör varsa masa, self modlarda tezgâh ve gel-al numarası, masaya serviste yok', () => {
    const counter = { type: 'tezgah', source: 'pos', no: 34, numarator: null };
    expect(callFor(counter, 'masa')).toBeNull();
    expect(callFor(counter, 'self')).toEqual({ kind: 'numara', value: '34' });
    expect(callText(callFor(counter, 'yari_self')!)).toBe('No 34');
    expect(callFor({ ...counter, numarator: '12' }, 'masa')).toEqual({ kind: 'masa', value: '12' });
    expect(callText(callFor({ ...counter, numarator: '12' }, 'yari_self')!)).toBe('Masa 12');
    expect(callFor({ ...counter, type: 'masa' }, 'self')).toBeNull();
    expect(callFor({ ...counter, type: 'paket' }, 'self')).toBeNull();
    expect(callFor({ ...counter, source: 'laffogato' }, 'self')).toBeNull();
  });

  it('bar fişi başlığı: numara tekrar yazılmaz, masada bugünkü etiket', () => {
    const t = { label: 'Tezgâh #34', orderNo: 34, type: 'tezgah', source: 'pos', numarator: null };
    // Etiket numarayı taşıyor: fişte "#34" ikinci kez yazılmaz
    expect(ticketHead(t, 'masa')).toEqual({ call: null, label: 'Tezgâh #34', showNo: false });
    expect(ticketHead(t, 'self')).toEqual({ call: 'No 34', label: 'Tezgâh', showNo: false });
    expect(ticketHead({ ...t, label: 'Masa 12', numarator: '12' }, 'yari_self')).toEqual({ call: 'Masa 12', label: '', showNo: true });
    expect(ticketHead({ ...t, type: 'gelal', label: 'Gel-al · Ayşe' }, 'self')).toEqual({ call: 'No 34', label: 'Gel-al · Ayşe', showNo: false });
    expect(ticketHead({ ...t, type: 'masa', label: 'Salon 3' }, 'self')).toEqual({ call: null, label: 'Salon 3', showNo: true });
  });
});

let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
type Audit = { action: string; message: string; data: { from: string; to: string } | null };

describe('servis modu ayarı (sunucu)', () => {
  it('yeni kurulum self serviste açılır (işletme self servis) ve açılış verisinde herkese gider', async () => {
    expect(h.boot.settings.serviceMode).toBe('self');
    const boot = await h.ok<BootstrapDTO>('garson', 'GET', '/bootstrap');
    expect(boot.settings.serviceMode).toBe('self');
  });

  it('yalnız ayar yetkisi olan değiştirir', async () => {
    for (const who of ['kasa', 'garson', 'bar']) {
      const r = await h.call(who, 'PUT', '/admin/settings', { serviceMode: 'masa' });
      expect(r.status, who).toBe(403);
    }
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.serviceMode).toBe('self');
  });

  it('tanınmayan mod reddedilir', async () => {
    const r = await h.call('patron', 'PUT', '/admin/settings', { serviceMode: 'otomat' });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toMatch(/serviceMode/);
  });

  it('değişince açılış verisi, canlı olay ve okunur denetim kaydı; aynı mod yeniden kayıt yazmaz', async () => {
    const { bus } = await import('../server/lib/events');
    const seen: { topic: string; kind: string }[] = [];
    const listen = (e: { topic: string; kind: string }) => seen.push(e);
    bus.on('event', listen);
    const saved = await h.ok<{ serviceMode: string }>('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
    bus.off('event', listen);
    expect(saved.serviceMode).toBe('masa');
    expect(seen.some((e) => e.topic === 'settings')).toBe(true);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.serviceMode).toBe('masa');

    let audit = await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=50');
    const entry = audit.find((a) => a.action === 'settings.servis_modu');
    expect(entry?.message).toBe('Patron servis modunu değiştirdi: Self servis → Masaya servis');
    expect(entry?.data).toEqual({ from: 'self', to: 'masa' });

    // Müdür de ayar yetkisiyle değiştirir; aynı modu yeniden göndermek yeni kayıt yazmaz
    await h.ok('mudur', 'PUT', '/admin/settings', { serviceMode: 'yari_self' });
    await h.ok('mudur', 'PUT', '/admin/settings', { serviceMode: 'yari_self' });
    audit = await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=50');
    const modes = audit.filter((a) => a.action === 'settings.servis_modu');
    expect(modes.map((a) => a.data)).toEqual([
      { from: 'masa', to: 'yari_self' },
      { from: 'self', to: 'masa' },
    ]);
    // Başka ayar değişince servis modu kaydı yazılmaz, mod korunur
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 8 });
    audit = await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.filter((a) => a.action === 'settings.servis_modu')).toHaveLength(2);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.serviceMode).toBe('yari_self');
  });
});

describe('masa no / numaratör (yarı self servis)', () => {
  it('tezgâh satışında saklanır; bar fişi, masasız liste, çağrı ekranı ve hazır uyarısı masayı yazar', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(o.numarator).toBeNull();
    const set = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: ' 12 ' });
    expect(set.numarator).toBe('12');
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    expect(sent.numarator).toBe('12');

    const tickets = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen');
    const ticket = tickets.find((t) => t.orderId === o.id);
    expect(ticket?.numarator).toBe('12');
    expect(ticket?.label).toBe('Masa 12');

    const floor = await h.ok<{ others: { id: string; label: string }[] }>('kasa', 'GET', '/floor');
    expect(floor.others.find((x) => x.id === o.id)?.label).toBe('Masa 12');

    let board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.find((e) => e.id === o.id)).toMatchObject({ no: o.no, table: '12' });

    // Ödeme kuralları değişmez: tutar ödenince adisyon kapanır
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    const paid = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: sent.total });
    expect(paid.closed).toBe(true);
    expect(paid.order.numarator).toBe('12');

    // Ödemeden sonra da düzeltilir (sipariş barda hazırlanırken müşteri başka masaya oturdu)
    const fixed = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '7' });
    expect(fixed.status).toBe('kapali');
    expect(fixed.numarator).toBe('7');

    const { bus } = await import('../server/lib/events');
    const seen: { kind: string; message?: string }[] = [];
    const listen = (e: { kind: string; message?: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: sent.items.map((i) => i.id), status: 'hazir' });
    bus.off('event', listen);
    expect(seen.find((e) => e.kind === 'items.ready')?.message).toBe('Masa 7 · 1 ürün hazır');
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.find((e) => e.id === o.id)).toMatchObject({ table: '7' });

    const cleared = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: null });
    expect(cleared.numarator).toBeNull();
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.find((e) => e.id === o.id)?.table).toBeNull();
  });

  it('numaratör yazılınca bar ekranı ve masalar yenilensin diye olay düşer', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Ayşe' });
    const { bus } = await import('../server/lib/events');
    const seen: { topic: string; kind: string; orderId?: string }[] = [];
    const listen = (e: { topic: string; kind: string; orderId?: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: 'b4' });
    bus.off('event', listen);
    expect(seen.filter((e) => e.orderId === o.id).map((e) => e.topic).sort()).toEqual(['kitchen', 'orders', 'tables']);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).numarator).toBe('B4');
  });

  it('geçersiz değer, masadaki adisyon, online sipariş ve yetkisiz kişi reddedilir', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '1234567' })).status).toBe(400);
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '1 2;' })).status).toBe(400);
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/numarator`, {})).status).toBe(422);
    // Bar ekranı sipariş almaz, ödeme de almaz
    expect((await h.call('bar', 'PUT', `/orders/${o.id}/numarator`, { numarator: '3' })).status).toBe(403);

    const table = h.boot.tables.find((t) => t.kind !== 'oda')!;
    const dine = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id });
    expect((await h.call('garson', 'PUT', `/orders/${dine.id}/numarator`, { numarator: '3' })).status).toBe(400);

    const cancelled = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Can' });
    await h.ok('kasa', 'POST', `/orders/${cancelled.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    await h.ok('mudur', 'POST', `/orders/${cancelled.id}/cancel`, { reason: 'Müşteri vazgeçti' });
    expect((await h.call('kasa', 'PUT', `/orders/${cancelled.id}/numarator`, { numarator: '3' })).status).toBe(409);

    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.orders).set({ source: 'laffogato', extPaid: true }).where(eq(schema.orders.id, o.id)).run();
    expect((await h.call('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '3' })).status).toBe(409);
  });

  it('numaratörlü boş tezgâh adisyonu yeni satış diye yeniden kullanılmaz', async () => {
    const first = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const again = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: first.id });
    expect(again.id).toBe(first.id);
    await h.ok('kasa', 'PUT', `/orders/${first.id}/numarator`, { numarator: '5' });
    const fresh = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: first.id });
    expect(fresh.id).not.toBe(first.id);
    expect(fresh.numarator).toBeNull();
  });

  it('masaya servis ve self serviste masadaki akış aynı kalır: masa açılır, bara gider, sonda ödenir', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { serviceMode: 'self' });
    const table = h.boot.tables.filter((t) => t.kind !== 'oda')[3]!;
    const dine = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id });
    const sent = await h.ok<OrderDTO>('garson', 'POST', `/orders/${dine.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 2 }] });
    expect(sent.items[0].stationId).toBeTruthy();
    const card = h.boot.paymentMethods.find((m) => m.kind === 'kart')!;
    const res = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${dine.id}/payments`, { methodId: card.id, amount: sent.total });
    expect(res.closed).toBe(true);
    await h.ok('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
  });

  // Gözden geçirme bulguları (servis modu, 27 Eki 2026)
  it('masa no\'lu tezgâh satışı masaya taşınınca masa no kalkar: adisyon masanın adıyla görünür', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    await h.ok('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '12' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    const table = h.boot.tables.filter((t) => t.kind !== 'oda')[5]!;
    const moved = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/move`, { tableId: table.id });
    expect(moved.type).toBe('masa');
    expect(moved.numarator).toBeNull();
    const tickets = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen');
    expect(tickets.find((t) => t.orderId === o.id)?.label).toBe(table.name);
    const board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.find((e) => e.id === o.id)?.table ?? null).not.toBe('12');
  });

  it('"Ayrı hesap" ile bölünen kalemler masa no\'yu taşır: ikisi de aynı masaya gider', async () => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    await h.ok('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: 'B4' });
    const full = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 2 }] });
    const split = await h.ok<{ source: OrderDTO; target: OrderDTO }>('mudur', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: full.items[0].id, qty: 1 }] });
    expect(split.target.id).not.toBe(o.id);
    expect(split.target.type).toBe('tezgah');
    expect(split.target.numarator).toBe('B4');
    expect(split.source.numarator).toBe('B4');
    const tickets = await h.ok<KitchenTicket[]>('bar', 'GET', '/kitchen');
    expect(tickets.find((t) => t.orderId === split.target.id)?.label).toBe('Masa B4');
  });

  it('ödenmiş adisyonun masa no\'su değişince denetime yazılır; kapanmış günün adisyonunda değişmez', async () => {
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    await h.ok('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '3' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: sent.total });
    await h.ok('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '9' });
    type Audit = { action: string; orderId: string | null; message: string };
    const audits = (await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.orderId === o.id && a.action === 'order.numarator');
    expect(audits.map((a) => a.message)).toEqual([expect.stringContaining('Masa 3 → Masa 9')]);

    // Gün kapanmış (eski gün): Z'si yazılmış adisyonun masa no'su değişmez
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, sent.dayId)).get()!;
    db.update(schema.businessDays).set({ closedAt: Date.now() }).where(eq(schema.businessDays.id, day.id)).run();
    try {
      const r = await h.call<{ code: string }>('kasa', 'PUT', `/orders/${o.id}/numarator`, { numarator: '5' });
      expect([r.status, r.json.code]).toEqual([409, 'day_closed']);
      expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).numarator).toBe('9');
    } finally {
      db.update(schema.businessDays).set({ closedAt: null }).where(eq(schema.businessDays.id, day.id)).run();
    }
  });
});
