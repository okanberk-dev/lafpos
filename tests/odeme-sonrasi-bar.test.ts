import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amountForItems, itemPayLines } from '@shared/order-calc';
import { holdsUntilPaid } from '@shared/service-mode';
import type { FloorStateDTO, KitchenTicket, OrderDTO, PickupBoardDTO } from '@shared/types';
import { cartGroupOf, groupCartItems } from '../src/pages/order/cartGroups';
import { type Harness, PINS, startApp } from './harness';

/**
 * Ödeme alınınca bara (4 Kasım 2026, operatör: "ödemesi alınınca bar tarafına gitsin"): tezgâh satışında "Öde" ile
 * eklenen kalem ödeme bekler (`held`), bar ekranı, çağrı ekranı ve sipariş sayacı onu görmez. Adisyon kapanınca (ödeme,
 * yazarkasa, ciro dışı ya da ₺0) kendiliğinden bara gider: gönderim anı ve fiş numarası o an. Müşteri vazgeçerse bar
 * boşuna hazırlamaz; satış onaysız iptal edilir, fire sayılmaz. "Ödemeden gönder" bekleyeni hemen yollar (denetimde iz).
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const latte = () => h.boot.products.find((p) => p.name === 'Latte')!;
const cash = () => h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
const espresso = () => h.boot.products.find((p) => p.name === 'Espresso')!;
/** "Kalem seç" ödemesi: tutar ekrandaki gibi (seçilenlerin payı, kalanla sınırlı) */
const payItems = async (orderId: string, sel: { lineId: string; qty: number }[]) => {
  const cur = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${orderId}`);
  const amount = Math.min(cur.total - cur.paid, amountForItems(cur.totals, itemPayLines(cur.items, cur.payments), sel));
  return h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${orderId}/payments`, { methodId: cash().id, amount, items: sel.map((x) => ({ itemId: x.lineId, qty: x.qty })) });
};
const ticketsOf = async (orderId: string) => (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).filter((t) => t.orderId === orderId);
const kitchenItemIds = async () => (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).flatMap((t) => t.items.map((i) => i.id));
const counterSale = async (qty = 2) => {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty }], hold: true });
};
const audits = () => h.ok<{ action: string; orderId: string | null; message: string; severity: string }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=200');

describe('tezgâh satışında "Öde": ödeme alınınca bara', () => {
  it('bekleyen kalem bar ekranında, çağrı ekranında ve sipariş sayacında yok; ödeme alınınca yeni fişle bara düşer', async () => {
    const o = await counterSale();
    const item = o.items[0];
    expect(item.held).toBe(true);
    expect(await kitchenItemIds()).not.toContain(item.id);
    const floor = await h.ok<FloorStateDTO>('kasa', 'GET', '/floor');
    expect(floor.others.find((x) => x.id === o.id)?.pendingKitchen).toBe(0);
    const board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.some((e) => e.id === o.id)).toBe(false);

    const before = Date.now();
    const paid = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.total });
    expect(paid.closed).toBe(true);
    const after = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    const released = after.items[0];
    expect(released.held).toBe(false);
    expect(released.sentAt).toBeGreaterThanOrEqual(before);
    expect(released.batch).toBeGreaterThan(item.batch);
    const ticket = (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).find((t) => t.orderId === o.id)!;
    expect(ticket.items.map((i) => i.id)).toEqual([item.id]);
    // Fişte "Ödendi": barista ödemesi alınmış siparişi bilir
    expect(ticket.paid).toBe(true);
    expect((await h.ok<PickupBoardDTO>('', 'GET', '/public/board')).preparing.some((e) => e.id === o.id)).toBe(true);
  });

  it('kısmi ödemede bekler; kalan da ödenince gider', async () => {
    const o = await counterSale(2);
    const first = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.total - 1000 });
    expect(first.closed).toBe(false);
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: 1000 });
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });

  it('yazarkasada ödenince (cihaz ödemeyi kendisi bildirir) adisyon kapanır ve kalemler bara gider', async () => {
    const o = await counterSale(1);
    const sent = await h.ok<{ receipt: { id: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    const done = await h.ok<{ status: string }>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: o.total }] });
    expect(done.status).toBe('tamamlandi');
    expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).status).toBe('kapali');
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });

  it('ciro dışı kapanış (personel yemeği) da bara gönderir', async () => {
    const o = await counterSale(1);
    const garson = (await h.ok<{ id: string; name: string }[]>('patron', 'GET', '/admin/users')).find((u) => u.name === 'Garson')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: garson.id }, approverPin: PINS.mudur });
    expect(await kitchenItemIds()).toContain(o.items[0].id);
    // Hesap ciro dışı kapandı: fişte "Ödendi" (barista tahsil edecek bir şey olmadığını bilir)
    const ticket = (await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).find((t) => t.orderId === o.id)!;
    expect(ticket.paid).toBe(true);
  });

  it('müşteri vazgeçerse satış onaysız iptal edilir; bara hiç gitmez, fire sayılmaz', async () => {
    const o = await counterSale(2);
    // Başka kasiyer (müdür değil, iptal yetkisi yok) ve süre geçmiş olsa da: bekleyen kalem bara gitmedi
    const cancelled = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Müşteri vazgeçti' });
    expect(cancelled.status).toBe('iptal');
    const row = (await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).items[0];
    expect(row.voided).toBe(true);
    expect(row.voidAfterSend).toBe(false);
    expect(await kitchenItemIds()).not.toContain(o.items[0].id);
    const log = (await audits()).find((a) => a.action === 'order.cancel' && a.orderId === o.id)!;
    expect(log.severity).toBe('info');
  });

  it('bekleyen kalem tek tek de onaysız silinir; bar uyarılmaz, fire sayılmaz', async () => {
    const o = await counterSale(2);
    // Garson ekledi gibi değil: başka kullanıcı (müdür) da onaysız siler, çünkü kalem bara gitmedi
    const voided = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items[0].id}/void`, { qty: 1, reason: 'Yanlış ürün' });
    const gone = voided.items.find((i) => i.voided)!;
    expect(gone.voidAfterSend).toBe(false);
    expect(voided.items.find((i) => !i.voided)?.held).toBe(true);
  });

  it('"Ödemeden gönder" bekleyenleri hemen yollar ve denetime yazar; bekleyen yoksa 409; fiş "Ödendi" demez', async () => {
    const o = await counterSale(1);
    const r = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/release`, {});
    expect(r.items[0].held).toBe(false);
    expect(await kitchenItemIds()).toContain(o.items[0].id);
    // Ödeme alınmadan gitti: barista fişte "Ödendi" görmez, teslimde tahsil edileceğini bilir
    expect((await h.ok<KitchenTicket[]>('kasa', 'GET', '/kitchen')).find((t) => t.orderId === o.id)?.paid).toBe(false);
    const log = (await audits()).find((a) => a.action === 'order.release' && a.orderId === o.id)!;
    expect(log.message).toMatch(/siparişi ödeme alınmadan bara gönderdi \(1 kalem\)/);
    const again = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/release`, {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('nothing_held');
    // Bar ekranı rolü sipariş alamaz: gönderemez
    await h.login('bar', '3333');
    const o2 = await counterSale(1);
    expect((await h.call('bar', 'POST', `/orders/${o2.id}/release`, {})).status).toBe(403);
  });

  it('masa adisyonuna taşınan bekleyen kalem bara gider (masada ödeme sonda alınır)', async () => {
    const o = await counterSale(2);
    const table = h.boot.tables.find((t) => t.kind === 'masa')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: o.items[0].id, qty: 1 }], tableId: table.id });
    const ids = await kitchenItemIds();
    const src = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    // Kaynakta kalan bekler; taşınan masada bara gitti
    expect(src.items.find((i) => !i.voided)?.held).toBe(true);
    expect(ids).not.toContain(src.items[0].id);
    const floor = await h.ok<FloorStateDTO>('kasa', 'GET', '/floor');
    const moved = floor.tables[table.id]?.[0];
    expect(moved?.pendingKitchen).toBe(1);
  });

  it('"Masa taşı" ile boş masaya oturan satışın bekleyen kalemi bara gider (masada hesap sonda ödenir)', async () => {
    const o = await counterSale(1);
    const table = h.boot.tables.filter((t) => t.kind === 'masa')[6];
    const moved = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/move`, { tableId: table.id });
    expect(moved.type).toBe('masa');
    expect(moved.items[0].held).toBe(false);
    expect(await kitchenItemIds()).toContain(o.items[0].id);
    const floor = await h.ok<FloorStateDTO>('kasa', 'GET', '/floor');
    expect(floor.tables[table.id]?.[0]?.pendingKitchen).toBe(1);
  });

  it('kalemi seçilerek ödenen bekleyen satır hemen bara gider; ödenmeyen bekler, hesap kapanınca o da gider', async () => {
    // İki ayrı satır, ikisi de bara gider (orta ve büyük latte); istasyonsuz kalem zaten beklemez
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }, { productId: latte().id, size: 'L', qty: 1 }], hold: true });
    expect(o.items.every((i) => i.held)).toBe(true);
    const [first, second] = o.items;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.totals.lineNet[first.id], items: [{ itemId: first.id, qty: 1 }] });
    let ids = await kitchenItemIds();
    expect(ids).toContain(first.id);
    expect(ids).not.toContain(second.id);
    // Ödeyenin içeceği fişte "Ödendi" (hesabın kalanı açık olsa da): barista "Ödemeden gönder" fişiyle karıştırmaz
    expect((await ticketsOf(o.id)).find((t) => t.items.some((i) => i.id === first.id))?.paid).toBe(true);
    const mid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(mid.items.find((i) => i.id === second.id)?.held).toBe(true);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: mid.total - mid.paid });
    ids = await kitchenItemIds();
    expect(ids).toContain(second.id);
  });

  it('satırın bir kısmı ödenince satır bölünmez, bekler; kalanı ödenince bütün satır tek fişle gider', async () => {
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 2 }], hold: true });
    const line = o.items[0];
    await payItems(o.id, [{ lineId: line.id, qty: 1 }]);
    const after = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    // Bölmek satır ve adisyon indirimini yeniden yuvarlar (ödenen adedin yazılı tutarı yeni payını tutmaz): satır bütün kalır
    expect(after.items).toHaveLength(1);
    expect([after.items[0].qty, after.items[0].paidQty, after.items[0].held]).toEqual([2, 1, true]);
    expect(after.total).toBe(o.total);
    expect(await kitchenItemIds()).not.toContain(line.id);
    const done = await payItems(o.id, [{ lineId: line.id, qty: 1 }]);
    expect(done.closed).toBe(true);
    const tickets = await ticketsOf(o.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].items.map((i) => [i.id, i.qty])).toEqual([[line.id, 2]]);
  });

  it('indirimli hesapta kalemle kısmi ödeme kuruşu kuruşuna kapanır (satır ve adisyon indirimi)', async () => {
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
      items: [{ productId: latte().id, size: 'M', qty: 3 }, { productId: espresso().id, size: 'M', qty: 1 }],
      hold: true,
    });
    const [lat, esp] = o.items;
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${lat.id}/discount`, { type: 'amount', value: 500, reason: 'Müdavim', approverPin: PINS.mudur });
    await h.ok('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 1000, reason: 'Müdavim', approverPin: PINS.mudur });
    await payItems(o.id, [{ lineId: lat.id, qty: 2 }]);
    const done = await payItems(o.id, [{ lineId: lat.id, qty: 1 }, { lineId: esp.id, qty: 1 }]);
    // Her adet ödendi: 0,01 ₺ açık kalmaz, adisyon kapanır
    expect(done.closed).toBe(true);
    expect(done.order.paid).toBe(done.order.total);
  });

  it('hesabı kapatan kalem ödemesi bekleyenleri tek fişle gönderir (ikram satırı da aynı fişte)', async () => {
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }, { productId: latte().id, size: 'L', qty: 1 }], hold: true });
    const [paidLine, gift] = o.items;
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${gift.id}/comp`, { reason: 'Müdavim', approverPin: PINS.mudur });
    const r = await payItems(o.id, [{ lineId: paidLine.id, qty: 1 }]);
    expect(r.closed).toBe(true);
    const tickets = await ticketsOf(o.id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].items.map((i) => i.id).sort()).toEqual([paidLine.id, gift.id].sort());
    expect(tickets[0].paid).toBe(true);
  });

  describe('ödeme dışı işlem hesapta ödenecek bir şey bırakmazsa bekleyenler hemen gider (adisyon açık kalır)', () => {
    /** İki müşteri tek satırda 2× latte; biri kendi lattesini "Kalem seç" ile öder: satır kısmen ödendi, bekler */
    const halfPaid = async () => {
      let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
      o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 2 }], hold: true });
      await payItems(o.id, [{ lineId: o.items[0].id, qty: 1 }]);
      expect(await kitchenItemIds()).not.toContain(o.items[0].id);
      return { o, line: o.items[0] };
    };

    it('öteki adet iptal edilince ödenen latte bara gider ("Ödendi")', async () => {
      const { o, line } = await halfPaid();
      await h.ok('kasa', 'POST', `/orders/${o.id}/items/${line.id}/void`, { qty: 1, reason: 'Vazgeçti' });
      const tickets = await ticketsOf(o.id);
      expect(tickets.map((t) => t.items.map((i) => i.id))).toEqual([[line.id]]);
      expect(tickets[0].paid).toBe(true);
      expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    });

    it('öteki adet ikram edilince ikisi tek fişle gider; sonra kapatınca ikinci fiş çıkmaz', async () => {
      const { o } = await halfPaid();
      await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/comp`, { qty: 1, reason: 'Müdavim', approverPin: PINS.mudur });
      let tickets = await ticketsOf(o.id);
      expect(tickets).toHaveLength(1);
      expect(tickets[0].items).toHaveLength(2);
      expect(tickets[0].paid).toBe(true);
      await h.ok('kasa', 'POST', `/orders/${o.id}/close`, {});
      tickets = await ticketsOf(o.id);
      expect(tickets).toHaveLength(1);
    });

    it('öteki adet masaya taşınınca ödenen latte de bara gider', async () => {
      const { o, line } = await halfPaid();
      const table = h.boot.tables.filter((t) => t.kind === 'masa')[5];
      await h.ok('kasa', 'POST', `/orders/${o.id}/transfer`, { items: [{ itemId: line.id, qty: 1 }], tableId: table.id });
      expect(await kitchenItemIds()).toContain(line.id);
      expect((await ticketsOf(o.id)).find((t) => t.items.some((i) => i.id === line.id))?.paid).toBe(true);
    });

    it('tutarla kısmi ödemeden sonra indirim kalanı sıfırlarsa bekleyenler gider', async () => {
      const o = await counterSale(1);
      await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: 10000 });
      expect(await kitchenItemIds()).not.toContain(o.items[0].id);
      await h.ok('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: o.total - 10000, reason: 'Müdavim', approverPin: PINS.mudur });
      expect(await kitchenItemIds()).toContain(o.items[0].id);
    });

    it('ödeme alınmamış ₺0 satış (hepsi ikram) eskisi gibi kapanınca gider', async () => {
      const o = await counterSale(1);
      await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items[0].id}/comp`, { reason: 'Müdavim', approverPin: PINS.mudur });
      expect(await kitchenItemIds()).not.toContain(o.items[0].id);
      await h.ok('kasa', 'POST', `/orders/${o.id}/close`, {});
      expect(await kitchenItemIds()).toContain(o.items[0].id);
    });
  });

  it('ödeme bar ekranını hemen tazeler ("Ödendi" 15 saniyelik yoklamayı beklemez; zil çalmaz)', async () => {
    const { bus } = await import('../server/lib/events');
    const table = h.boot.tables.filter((t) => t.kind === 'masa')[6];
    let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 1 });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }] });
    expect((await ticketsOf(o.id))[0].paid).toBe(false);
    const seen: { topic: string; kind: string; orderId?: string }[] = [];
    const listen = (e: { topic: string; kind: string; orderId?: string }) => seen.push(e);
    bus.on('event', listen);
    try {
      await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash().id, amount: o.total });
    } finally {
      bus.off('event', listen);
    }
    expect(seen.some((e) => e.topic === 'kitchen' && e.kind === 'ticket.payment' && e.orderId === o.id)).toBe(true);
    expect(seen.some((e) => e.topic === 'kitchen' && e.kind === 'ticket.new')).toBe(false);
    expect((await ticketsOf(o.id))[0].paid).toBe(true);
  });

  it('yalnız tezgâh satışında: masa siparişinde "hold" reddedilir', async () => {
    const table = h.boot.tables.filter((t) => t.kind === 'masa')[3];
    const o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 1 });
    const r = await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }], hold: true });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe('hold_not_counter');
    expect(holdsUntilPaid({ type: 'tezgah', source: 'pos' })).toBe(true);
    expect(holdsUntilPaid({ type: 'masa', source: 'pos' })).toBe(false);
    expect(holdsUntilPaid({ type: 'tezgah', source: 'laffogato' })).toBe(false);
  });

  it('"Bara gönder" (hold yok) tezgâhta da hemen gider', async () => {
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte().id, size: 'M', qty: 1 }] });
    expect(o.items[0].held).toBe(false);
    expect(await kitchenItemIds()).toContain(o.items[0].id);
  });
});

describe('ekran (kaynak)', () => {
  const page = readFileSync(new URL('../src/pages/order/OrderPage.tsx', import.meta.url), 'utf8');
  const cart = readFileSync(new URL('../src/pages/order/CartPanel.tsx', import.meta.url), 'utf8');

  it('"Öde" tezgâh satışında bekletir, "Bara gönder" hemen gönderir', () => {
    expect(page).toContain('const holdOnPay = holdsUntilPaid(order);');
    expect(page.match(/if \(await send\(holdOnPay\)\) setDialog\('odeme'\);/g)?.length).toBe(2);
    expect(page).toMatch(/const sendOnly = \(\) =>\s*void once\(async \(\) => \{\s*if \(promptNumarator\('send'\)\) return;\s*await send\(\);/);
    // Ödeme bekletme işareti gönderim kaydından (kasaya ulaşamayan gönderim aynı işaretle yeniden gider)
    expect(page).toContain('...(batch.hold ? { hold: true } : {}),');
  });

  it('sepette "Ödeme bekliyor" grubu en üstte; "Ödemeden gönder" sipariş yetkisiyle', () => {
    const items = [{ voided: false, stationId: 'bar', status: 'yeni' as const, held: false }, { voided: false, stationId: 'bar', status: 'yeni' as const, held: true }];
    expect(cartGroupOf(items[1])).toBe('odeme');
    expect(groupCartItems(items).map((g) => g.label)).toEqual(['Ödeme bekliyor', 'Barda']);
    expect(cart).toContain("g.key === 'odeme' && order.status === 'acik' && !REMOTE && can('siparis.al')");
    expect(cart).toContain('post<OrderDTO>(`/orders/${order.id}/release`, {})');
    expect(cart).toContain(": payFirst ? 'Ödeme alınınca sipariş bara gider'");
    // Ödeme alamayan (garson) "Öde" görmez, tek düğmesi hemen gönderir: ona "ödeme alınınca" denmez
    expect(cart).toContain("const payFirst = holdsUntilPaid(order) && can('odeme.al');");
    // Çift dokunuş ikinci isteği yollamaz
    expect(cart).toContain('if (releasing.current) return;');
    expect(cart).toContain('disabled={sendingHeld}');
  });

  it('Siparişler kartı: bekleyen kalem "barda" sayılmaz, "Ödeme bekliyor" rozeti', () => {
    const list = readFileSync(new URL('../src/pages/OrdersPage.tsx', import.meta.url), 'utf8');
    expect(list).toContain("i.stationId && !i.held && (i.status === 'yeni' || i.status === 'hazirlaniyor')");
    expect(list).toContain('{awaitingPay && <Badge tone="warn">Ödeme bekliyor</Badge>}');
    expect(list).toMatch(/const hasBadges = [^;]*awaitingPay/);
  });
});
