import { calcOrder, type OrderTotals } from '@shared/order-calc';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { estimateUnit } from './boot';
import type { PendingLine } from './cart';

/**
 * Gönderilmemiş kalemlerle tahmini tutarlar (kasanın "Öde" düğmesi, adisyon toplamı, müşteri ekranı). Saf
 * fonksiyonlar: hesap `shared/order-calc` ile, kesin tutar kalemler gönderilince sunucudan gelir.
 */

/** Gönderilmemiş kalemlerle birlikte tahmini toplam (gösterim için; kesin tutar gönderince sunucudan gelir) */
export function previewTotals(boot: BootstrapDTO, order: OrderDTO, pending: PendingLine[], nowMs = Date.now()): OrderTotals | null {
  if (pending.length === 0) return null;
  const pendingTotal = pending.reduce((a, l) => {
    const p = boot.products.find((x) => x.id === l.productId);
    return a + (p ? (l.priceOverride ?? estimateUnit(boot, p, l.size, l.options, nowMs)) * l.qty : 0);
  }, 0);
  return calcOrder({
    lines: [
      ...order.items.map((i) => ({ id: i.id, qty: i.qty, unitPrice: i.unitPrice, kdvRate: i.kdvRate, discount: i.discount, complimentary: i.complimentary, voided: i.voided })),
      { id: '__pending', qty: 1, unitPrice: pendingTotal, kdvRate: 10, discount: 0, complimentary: false, voided: false },
    ],
    discount: order.discountType && order.discountValue != null ? { type: order.discountType, value: order.discountValue } : null,
    serviceRate: order.serviceRate,
  });
}
