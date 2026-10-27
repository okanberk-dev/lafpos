import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { percentOf } from '@shared/money';
import { happyHourPercentAt, happyHourUnit } from '@shared/order-calc';
import { istanbulParts } from '@shared/time';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { estimateUnit, menuUnit } from '../src/lib/boot';
import type { PendingLine } from '../src/lib/cart';
import { previewTotals } from '../src/lib/estimate';
import { type Harness, startApp } from './harness';

/**
 * Kasa arayüzünün tahminleri sunucuyla aynı hesabı yapar: gönderilmemiş kalemin fiyatı (happy hour dahil),
 * müşteri ekranının dökümü, gün sonu föyündeki slip karşılaştırması ve "Kalem seç"teki kalan tutar.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (boot: BootstrapDTO, name: string) => boot.products.find((p) => p.name === name)!;
const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

describe('happy hour: istemci tahmini sunucunun fiyatı', () => {
  it('etkin happy hour gönderilmemiş kalemin tahminine de uygulanır; kapsam ve en yüksek oran sunucuyla aynı', async () => {
    // Şu anı ortalayan aralık (saat kaç olursa olsun etkin; gece yarısını aşabilir)
    const p = istanbulParts(Date.now());
    const minute = p.hour * 60 + p.minute;
    const start = hm((minute - 120 + 1440) % 1440);
    const end = hm((minute + 120) % 1440);
    const days = [1, 2, 3, 4, 5, 6, 7];
    const tk0 = product(h.boot, 'Türk kahvesi');
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Hepsi', days, start, end, percent: 20 });
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Türk kahvesi', days, start, end, percent: 30, categoryIds: [tk0.categoryId] });
    await h.ok('patron', 'POST', '/admin/happy-hours', { name: 'Kapalı', days, start, end, percent: 50, active: false });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');

    for (const name of ['Türk kahvesi', 'Latte']) {
      const pr = product(boot, name);
      const size = pr.priceL != null ? ('M' as const) : ('TEK' as const);
      const pending: PendingLine[] = [{ key: 'k1', productId: pr.id, size, qty: 2, options: [], note: '' }];
      const order = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
      // "Öde · ₺X", adisyon toplamı, "Ekle · ₺X" ve müşteri ekranı bu tahminden
      const estimate = estimateUnit(boot, pr, size, []);
      const preview = previewTotals(boot, order, pending)!;
      const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${order.id}/items`, { items: pending.map(({ key: _k, ...l }) => l) });
      expect(sent.items[0].happyHour).toBe(true);
      expect(estimate).toBe(sent.items[0].unitPrice);
      expect(preview.total).toBe(sent.total);
      // Elle fiyatın karşılaştırıldığı menü fiyatı happy hour öncesi
      expect(menuUnit(boot, pr, size, [])).toBe(sent.items[0].basePrice);
    }
  });

  it('kural eşleşmesi: gece yarısını aşan aralık önceki güne ait, kapsam ve kapalı kural', () => {
    // 2026-10-30 Cuma, 2026-10-31 Cumartesi (İstanbul UTC+3)
    const at = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);
    const rule = { days: [5], start: '22:00', end: '02:00', percent: 20, categoryIds: [], productIds: [], active: true };
    const prod = { id: 'p1', categoryId: 'c1' };
    expect(happyHourPercentAt([rule], prod, at('2026-10-30', '23:30'))).toBe(20);
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '01:59'))).toBe(20); // Cumartesi 01:59 Cuma gecesinin devamı
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '02:00'))).toBe(0);
    expect(happyHourPercentAt([rule], prod, at('2026-10-31', '23:30'))).toBe(0); // Cumartesi kuralda yok
    expect(happyHourPercentAt([rule], prod, at('2026-10-30', '01:00'))).toBe(0); // Perşembe gecesi
    expect(happyHourPercentAt([{ ...rule, active: false }], prod, at('2026-10-30', '23:30'))).toBe(0);
    expect(happyHourPercentAt([{ ...rule, categoryIds: ['c2'] }], prod, at('2026-10-30', '23:30'))).toBe(0);
    expect(happyHourPercentAt([{ ...rule, productIds: ['p1'] }, { ...rule, percent: 35, categoryIds: ['c1'] }], prod, at('2026-10-30', '23:30'))).toBe(35);
    expect(happyHourUnit(14000, 20)).toBe(11200);
    expect(happyHourUnit(14500, 15)).toBe(14500 - percentOf(14500, 15));
    expect(happyHourUnit(14000, 0)).toBe(14000);
  });
});
