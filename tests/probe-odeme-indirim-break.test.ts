import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

let h: Harness;
type Audit = { action: string; severity: string; amount: number | null; orderId: string | null; message: string; approverName: string | null };

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  // %10 indirim sınırlı garson (auth-53 testindeki "İndirimci" gibi; garsonun ikram yetkisi yok)
  await h.ok('patron', 'POST', '/admin/users', { name: 'Sınırlı', role: 'garson', permGrant: ['siparis.indirim'], maxDiscountPct: 10, pin: '5151' });
  await h.login('sinirli', '5151');
});
afterAll(() => h.cleanup());

const coffee = () => h.boot.products.find((p) => p.name === 'Türk kahvesi')!;
const pct = (o: OrderDTO) => Math.round(((o.totals.lineDiscounts + o.totals.orderDiscount) * 10000) / o.totals.gross) / 100;
const audits = async (orderId: string) => (await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.orderId === orderId);

describe('auth-53 kırma: sınır yalnız indirim anında, seyreltici kalem onaysız iptal edilince toplam etki sınırı aşar', () => {
  it('yüzde: kaleme %10 + adisyona %9 (toplam %9,9 iken), 9 kahvelik kukla satır "yanlış giriş" diye iptal edilir', async () => {
    let o = await h.ok<OrderDTO>('sinirli', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/items`, { items: [{ productId: coffee().id, qty: 1 }, { productId: coffee().id, qty: 9 }] });
    const [a, dummy] = o.items;
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/items/${a!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 9, reason: 'Personel' });
    console.log('[yüzde] kukla iptalden önce toplam indirim %', pct(o), 'toplam', o.total);
    const v = await h.call<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/items/${dummy!.id}/void`, { reason: 'Yanlış giriş' });
    console.log('[yüzde] kukla iptal (onaysız)', v.status);
    o = v.json;
    console.log('[yüzde] kalan: brüt', o.totals.gross, 'kalem ind.', o.totals.lineDiscounts, 'adisyon ind.', o.totals.orderDiscount, 'toplam', o.total, '→ etkin indirim %', pct(o));
    console.log('[yüzde] denetim', (await audits(o.id)).map((x) => `${x.action}:${x.severity}:${x.approverName ?? '-'}:${x.message}`));
    expect(pct(o)).toBeLessThanOrEqual(10);
  });

  it('tutar: 140.000 kuruşluk adisyona 14.000 kuruş (%10) indirim, kukla satır iptal edilince kahve bedava kapanır', async () => {
    let o = await h.ok<OrderDTO>('sinirli', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/items`, { items: [{ productId: coffee().id, qty: 1 }, { productId: coffee().id, qty: 9 }] });
    const dummy = o.items[1]!;
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 14000, reason: 'Personel' });
    console.log('[tutar] indirim %', pct(o), 'toplam', o.total);
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/items/${dummy.id}/void`, { reason: 'Yanlış giriş' });
    const closed = await h.call<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/close`);
    console.log('[tutar] kukla iptalden sonra: brüt', o.totals.gross, 'indirim', o.totals.orderDiscount, 'toplam', o.total, '→ etkin indirim %', pct(o), '| kapat', closed.status, closed.json.status);
    expect(pct(o)).toBeLessThanOrEqual(10);
  });
});
