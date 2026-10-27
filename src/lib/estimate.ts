import { calcOrder, lineGross, type OrderTotals } from '@shared/order-calc';
import type { BootstrapDTO, DisplayLineDTO, DisplayStateDTO, OrderDTO, Size } from '@shared/types';
import { estimateUnit, pendingOptionsText } from './boot';
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

export type DisplayOrder = Omit<Extract<DisplayStateDTO, { kind: 'order' }>, 'at'>;

/**
 * Müşteri ekranına giden adisyon dökümü. Kalemler menüdeki fiyatla (adet × birim, ikram 0); kalem ve adisyon
 * indirimi tek "İndirim" satırında, servis ayrı satırda: ekrandaki satırlar toplamı verir (kalemler − indirim +
 * servis). Kalemin indirimli payı (`lineNet`) gösterilmez, yoksa indirim iki kez düşülmüş görünür. Gönderilmemiş
 * kalemler tahmini fiyatla; indirim ve servis onları da kapsar. Boş adisyonda null.
 */
export function displayOrder(boot: BootstrapDTO, order: OrderDTO, pending: PendingLine[], label: string, nowMs = Date.now()): DisplayOrder | null {
  const preview = previewTotals(boot, order, pending, nowMs);
  const t = preview ?? order.totals;
  const total = Math.max(0, preview ? preview.total : order.total);
  const sizeLabel = (s: Size) => (s === 'TEK' ? null : (boot.settings.sizeLabels[s] ?? s));
  const lines: DisplayLineDTO[] = order.items
    .filter((i) => !i.voided)
    .map((i) => ({ name: i.name, size: sizeLabel(i.size), qty: i.qty, options: i.optionsText, total: i.complimentary ? 0 : lineGross(i) }));
  for (const l of pending) {
    const p = boot.products.find((x) => x.id === l.productId);
    if (!p) continue;
    const unit = l.priceOverride ?? estimateUnit(boot, p, l.size, l.options, nowMs);
    lines.push({ name: p.name, size: sizeLabel(l.size), qty: l.qty, options: pendingOptionsText(boot, p, l.options), total: lineGross({ qty: l.qty, unitPrice: unit }) });
  }
  if (!lines.length) return null;
  return { kind: 'order', label, lines, discount: t.lineDiscounts + t.orderDiscount, service: t.service, total, paid: order.paid, due: Math.max(0, total - order.paid) };
}
