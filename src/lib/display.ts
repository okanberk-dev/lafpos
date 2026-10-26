import { useEffect, useRef } from 'react';
import type { BootstrapDTO, DisplayLineDTO, DisplayStateDTO, OrderDTO } from '@shared/types';
import { put } from './api';
import { estimateUnit, pendingOptionsText } from './boot';
import type { PendingLine } from './cart';
import { useLocalPref } from './hooks';

type Outgoing = { kind: 'idle' } | Omit<Extract<DisplayStateDTO, { kind: 'order' }>, 'at'> | Omit<Extract<DisplayStateDTO, { kind: 'thanks' }>, 'at'>;

/** Bu cihazın yansıttığı müşteri ekranının adı; boşsa yansıtmaz (cihaz başına, Adisyon › İşlemler'den) */
export function useDisplayCode() {
  return useLocalPref<string>('display.code', '');
}

/** Son gönderilen durum: adisyondan çıkınca yalnız adisyon gösteriliyorsa "hoş geldiniz"e dönülür */
let lastKind: Outgoing['kind'] = 'idle';

export function sendDisplay(code: string, state: Outgoing) {
  if (!code) return;
  lastKind = state.kind;
  void put(`/display/${code}`, state).catch(() => null);
}

/**
 * Açık adisyonu müşteri ekranına yansıtır: kalemler (gönderilmemişler dahil), indirim ve tutar. Adisyondan
 * çıkınca ekran "hoş geldiniz"e döner. Gönderim 300 ms toplanır; ekran yalnız ad, adet ve tutarı görür.
 */
export function useCustomerDisplay(boot: BootstrapDTO, order: OrderDTO | undefined, pending: PendingLine[], label: string, total: number) {
  const [code] = useDisplayCode();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!code || !order || order.status !== 'acik') return;
    const lines: DisplayLineDTO[] = order.items
      .filter((i) => !i.voided)
      .map((i) => ({ name: i.name, size: i.size === 'TEK' ? null : (boot.settings.sizeLabels[i.size as 'M' | 'L'] ?? i.size), qty: i.qty, options: i.optionsText, total: i.complimentary ? 0 : (order.totals.lineNet[i.id] ?? i.unitPrice * i.qty) }));
    for (const l of pending) {
      const p = boot.products.find((x) => x.id === l.productId);
      if (!p) continue;
      const unit = l.priceOverride ?? estimateUnit(boot, p, l.size, l.options);
      lines.push({ name: p.name, size: l.size === 'TEK' ? null : (boot.settings.sizeLabels[l.size as 'M' | 'L'] ?? l.size), qty: l.qty, options: pendingOptionsText(boot, p, l.options), total: unit * l.qty });
    }
    // Boş adisyon (satış sonrası yeni satış) ekrandaki "teşekkürler"i ezmesin
    if (!lines.length) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(
      () => sendDisplay(code, { kind: 'order', label, lines, discount: order.totals.orderDiscount ?? 0, total: Math.max(0, total), paid: order.paid, due: Math.max(0, total - order.paid) }),
      300,
    );
  }, [code, order, pending, boot, label, total]);
  // Adisyondan çıkınca ekran "hoş geldiniz"e döner (kapandıysa "teşekkürler"i ödeme penceresi göndermiştir)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (code && lastKind === 'order') sendDisplay(code, { kind: 'idle' });
    },
    [code],
  );
}
