import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Tasarım geçişinin incelemesi (4 Kas 2026): ödeme penceresi, masa işlemleri, müşteri ve yazarkasa pencereleri.
 * Sunucunun kuralı süreç içi uygulamayla, ekranın kuralı kaynaktan denetlenir.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  // Türk Kahvesi sitenin kalemi: beklenen tutarlar 140 TL'ye göre
  await h.pinPrice('Türk Kahvesi', 14000);
});
afterAll(() => h.cleanup());

const coffee = (qty = 1) => ({ items: [{ productId: h.boot.products.find((p) => p.name === 'Türk Kahvesi')!.id, qty }] });
const discountAudits = async (orderId: string) =>
  (await h.ok<{ action: string; orderId: string | null; amount: number | null }[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.orderId === orderId && a.action === 'order.discount');

describe('adisyon indirimi', () => {
  it('ara toplamı aşan tutar indirimi ara toplam kadar saklanır; sonra eklenen kalem onaysız indirimli olmaz', async () => {
    // Müdür ₺140'lık adisyona ₺14 yerine ₺1.400 yazar: %100 indirim olarak onaylanır, saklanan tutar ara toplamdır
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, coffee());
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 140000, reason: 'Personel', approverPin: PINS.mudur });
    expect([o.discountType, o.discountValue, o.totals.orderDiscount, o.total]).toEqual(['amount', 14000, 14000, 0]);

    // İndirim yetkisi olmayan kasiyer 3 kahve ekler: indirim ₺140'ta kalır, eklenenler tam fiyat. Eskiden ₺420'lik kahve
    // de saklı ₺1.400'den düşüyordu: onaysız ve denetime yazılmadan
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, coffee(3));
    expect([o.totals.orderDiscount, o.total]).toEqual([14000, 42000]);
    expect((await discountAudits(o.id)).map((a) => a.amount)).toEqual([14000]);

    // Ara toplamın içindeki tutar yazıldığı gibi saklanır
    let p = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/items`, coffee());
    p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/discount`, { type: 'amount', value: 1400, reason: 'Personel', approverPin: PINS.mudur });
    expect([p.discountValue, p.total]).toEqual([1400, 12600]);
  });
});

describe('ekranın kuralları (kaynak)', () => {
  const src = (file: string) => readFileSync(new URL(`../src/pages/order/${file}`, import.meta.url), 'utf8');

  it('adisyon indirimi: tutar da yüzde gibi sınırlı (ara toplamdan fazlası alanda söylenir, Uygula kapanır)', () => {
    const ops = src('TableOps.tsx');
    expect(ops).toMatch(/const overLimit = type === 'percent' \? numeric > 100 : numeric > subtotal;/);
    expect(ops).toMatch(/const ready = numeric > 0 && !overLimit;/);
  });

  it('yazarkasada bekleyen sepet yarım ödemedir; cihazın sonucu Kapat’tan sonra da bu cihazda karşılanır', () => {
    const pay = src('PaymentModal.tsx');
    expect(pay).toMatch(/const dirty = devicePending \|\|/);
    // Dinleyici pencereyle değil adisyon ekranıyla yaşar: pencere kapalıyken yalnız bu cihazın gönderdiği sepet
    expect(pay).toMatch(/if \(!shown && okcSentHere\.current !== order\.id\) return;/);
    expect(pay).toMatch(/onSend=\{\(\) => \{\s*okcSentHere\.current = order\.id;/);
    // Sonuç tek yerde: yazarkasa kutusu pencereyle kapanır, "ödendi"yi kendisi karşılamaz
    expect(src('OkcPanel.tsx')).not.toMatch(/okc\.paid|onCompleted/);
  });

  it('açık hesap sınırını aşan yazım düğmede engellenir; kısmi açık hesap "alındı" değil "yazıldı" der', () => {
    const pay = src('PaymentModal.tsx');
    expect(pay).toMatch(/const valid = [^;]*!cariOver/);
    expect(pay).toMatch(/const payStep = cariOver\s*\? 'Açık hesap sınırı aşılıyor'/);
    expect(pay).toMatch(/açık hesaba yazıldı/);
  });

  it('ödeme iptali bankada iptal edilecek tutarı (bahşiş dahil) söyler', () => {
    expect(src('PaymentModal.tsx')).toMatch(/body: `\$\{p\.methodName\} · \$\{tl\(p\.amount \+ p\.tip\)\}/);
  });

  it('hediye içecekten sonra adisyondaki damga sayısı hemen düşer (düğme ikinci hediyeye açık kalmaz)', () => {
    expect(src('CustomerModal.tsx')).toMatch(/qc\.setQueryData<OrderDTO>\(\['order', order\.id\]/);
  });
});
