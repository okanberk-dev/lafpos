import { useEffect, useRef } from 'react';
import type { BootstrapDTO, DisplayStateDTO, OrderDTO } from '@shared/types';
import { put } from './api';
import type { PendingLine } from './cart';
import { displayOrder } from './estimate';
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
 * Açık adisyonu müşteri ekranına yansıtır: kalemler (gönderilmemişler dahil), indirim, servis ve tutar
 * (`displayOrder`). Adisyondan çıkınca ekran "hoş geldiniz"e döner. Gönderim 300 ms toplanır; ekran yalnız ad,
 * adet ve tutarı görür.
 */
export function useCustomerDisplay(boot: BootstrapDTO, order: OrderDTO | undefined, pending: PendingLine[], label: string) {
  const [code] = useDisplayCode();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!code || !order || order.status !== 'acik') return;
    const state = displayOrder(boot, order, pending, label);
    // Boş adisyon (satış sonrası yeni satış) ekrandaki "teşekkürler"i ezmesin
    if (!state) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => sendDisplay(code, state), 300);
  }, [code, order, pending, boot, label]);
  // Adisyondan çıkınca ekran "hoş geldiniz"e döner (kapandıysa "teşekkürler"i ödeme penceresi göndermiştir)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (code && lastKind === 'order') sendDisplay(code, { kind: 'idle' });
    },
    [code],
  );
}
