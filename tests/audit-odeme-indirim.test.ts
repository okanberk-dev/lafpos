import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Denetim bulguları (26 Eki 2026): ödeme, indirim, iptal onayı, bahşiş, kalem bazlı ödeme ve girdi doğrulama.
 * Her bulgu bir testle; test düzeltmeden önce kırılır, sonra geçer.
 */
let h: Harness;
const MUDUR = PINS.mudur;
let tableNo = 0;

beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

type Line = { name: string; qty?: number; size?: 'M' | 'L' };
type Audit = { action: string; severity: string; amount: number | null; orderId: string | null; message: string; approverName: string | null; data: Record<string, unknown> | null };

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const lines = (items: Line[]) => items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) }));
const getOrder = (id: string) => h.ok<OrderDTO>('patron', 'GET', `/orders/${id}`);
const audits = async (orderId: string, action: string) => (await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.orderId === orderId && a.action === action);

/** Boş bir masada adisyon açıp kalemleri ekler */
async function tableOrder(who: string, items: Line[]) {
  const table = h.boot.tables.filter((t) => t.kind !== 'oda')[tableNo++]!;
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'masa', tableId: table.id });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: lines(items) });
}

async function counterOrder(who: string, items: Line[], extra: Record<string, unknown> = {}) {
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'tezgah', ...extra });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: lines(items) });
}

describe('indirim', () => {
  it('auth-53: indirim sınırı toplam etkiye uygulanır; %10 sınırlı kişi kalem ve adisyon indirimini üst üste koyup %19 yapamaz', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'İndirimci', role: 'kasiyer', permGrant: ['siparis.indirim'], maxDiscountPct: 10, pin: '4242' });
    await h.login('ind', '4242');

    // Tek indirimde sınır zaten vardı: %19 onay ister
    let o = await counterOrder('ind', [{ name: 'Türk kahvesi' }]);
    expect((await h.call<{ code: string }>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 19, reason: 'Personel' })).json.code).toBe('approval_required');

    // Kaleme %10 kendi sınırında; üstüne adisyona %10 toplamda %19 eder: yetkili onayı ister
    o = await h.ok<OrderDTO>('ind', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    const stacked = await h.call<{ code: string }>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    expect(stacked.status).toBe(403);
    expect(stacked.json.code).toBe('approval_required');
    expect((await getOrder(o.id)).totals.orderDiscount).toBe(0);
    // Müdür onaylar; denetim kaydı adisyondaki toplam oranı yazar
    o = await h.ok<OrderDTO>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Personel', approverPin: MUDUR });
    expect(o.total).toBe(11340);
    const [rec] = await audits(o.id, 'order.discount');
    expect(rec).toMatchObject({ approverName: 'Müdür' });
    expect(rec!.message).toContain('toplam %19');

    // Ters sıra da aynı: önce adisyona %10, sonra kaleme %10
    let p = await counterOrder('ind', [{ name: 'Türk kahvesi' }]);
    p = await h.ok<OrderDTO>('ind', 'POST', `/orders/${p.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    const lineOnTop = await h.call<{ code: string }>('ind', 'POST', `/orders/${p.id}/items/${p.items[0]!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    expect(lineOnTop.status).toBe(403);
    expect(lineOnTop.json.code).toBe('approval_required');

    // Sınırın içinde kalan birleşim onaysız geçer: kaleme %5, adisyona %4 (toplam %8,8)
    let q = await counterOrder('ind', [{ name: 'Türk kahvesi' }]);
    q = await h.ok<OrderDTO>('ind', 'POST', `/orders/${q.id}/items/${q.items[0]!.id}/discount`, { type: 'percent', value: 5, reason: 'Personel' });
    q = await h.ok<OrderDTO>('ind', 'POST', `/orders/${q.id}/discount`, { type: 'percent', value: 4, reason: 'Personel' });
    expect(q.totals.lineDiscounts + q.totals.orderDiscount).toBe(700 + 532);
  });

  it('money-12: indirimli adisyona başka adisyon birleşir ya da kalem taşınırsa indirim büyür; yetkili onayı ister ve denetime yazılır', async () => {
    // Hedef: 1 kahve, müdür onaylı %50; kaynak: 10 kahvelik başka masa
    let target = await tableOrder('garson', [{ name: 'Türk kahvesi' }]);
    target = await h.ok<OrderDTO>('garson', 'POST', `/orders/${target.id}/discount`, { type: 'percent', value: 50, reason: 'Personel', approverPin: MUDUR });
    const source = await tableOrder('garson', [{ name: 'Türk kahvesi', qty: 10 }]);
    expect([target.total, source.total]).toEqual([7000, 140000]);

    // Garsonun indirim yetkisi yok: birleştirme indirimi 10 kahveye yayacağı için onay ister, hiçbir şey değişmez
    const denied = await h.call<{ code: string; permission: string }>('garson', 'POST', `/orders/${target.id}/merge`, { sourceOrderId: source.id });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'approval_required', permission: 'siparis.indirim' });
    expect((await getOrder(source.id)).status).toBe('acik');
    expect((await getOrder(target.id)).total).toBe(7000);

    // Müdür PIN'iyle birleşir; büyüyen indirim (70.000 kuruş) onaylayanla denetime yazılır
    const merged = await h.ok<OrderDTO>('garson', 'POST', `/orders/${target.id}/merge`, { sourceOrderId: source.id, approverPin: MUDUR });
    expect(merged.total).toBe(77000);
    const grown = (await audits(target.id, 'order.discount')).find((a) => a.amount === 70000);
    expect(grown).toMatchObject({ approverName: 'Müdür', severity: 'uyari' });

    // Kalem taşıma: indirimli adisyona 6 kahve taşımak da onay ister
    const other = await tableOrder('garson', [{ name: 'Türk kahvesi', qty: 6 }]);
    const body = { items: [{ itemId: other.items[0]!.id, qty: 6 }], targetOrderId: target.id };
    const moveDenied = await h.call<{ code: string }>('garson', 'POST', `/orders/${other.id}/transfer`, body);
    expect(moveDenied.status).toBe(403);
    expect(moveDenied.json.code).toBe('approval_required');
    expect((await getOrder(other.id)).total).toBe(84000);
    const moved = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${other.id}/transfer`, { ...body, approverPin: MUDUR });
    expect(moved.target.total).toBe(77000 + 42000);
    expect((await audits(target.id, 'order.discount')).some((a) => a.amount === 42000)).toBe(true);

    // İndirimsiz adisyonlar arasında birleştirme ve taşıma eskisi gibi onaysız
    const a = await tableOrder('garson', [{ name: 'Türk kahvesi' }]);
    const b = await tableOrder('garson', [{ name: 'Türk kahvesi', qty: 2 }]);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${a.id}/merge`, { sourceOrderId: b.id })).total).toBe(42000);
    const c = await tableOrder('garson', [{ name: 'Türk kahvesi', qty: 2 }]);
    const split = await h.ok<{ target: OrderDTO }>('garson', 'POST', `/orders/${c.id}/transfer`, { items: [{ itemId: c.items[0]!.id, qty: 1 }] });
    expect(split.target.total).toBe(14000);

    // Aynı oranlı iki indirimli masa birleşince yüzdenin yuvarlaması (1 kuruş) onay istetmez
    const discounted = async (o: OrderDTO) => {
      await h.ok('garson', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/discount`, { type: 'amount', value: 6, reason: 'Yuvarlama', approverPin: MUDUR });
      return h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Öğrenci', approverPin: MUDUR });
    };
    const d = await discounted(await tableOrder('garson', [{ name: 'Türk kahvesi' }]));
    const e = await discounted(await tableOrder('garson', [{ name: 'Türk kahvesi' }]));
    expect(d.totals.orderDiscount + e.totals.orderDiscount).toBe(2798);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${d.id}/merge`, { sourceOrderId: e.id })).totals.orderDiscount).toBe(2799);
  });
});
