import { useEffect } from 'react';
import type { BootstrapDTO, DisplayStateDTO, OrderDTO } from '@shared/types';
import { put } from './api';
import type { PendingLine } from './cart';
import { displayOrder } from './estimate';
import { useLocalPref } from './hooks';

type Outgoing = { kind: 'idle' } | Omit<Extract<DisplayStateDTO, { kind: 'order' }>, 'at'> | Omit<Extract<DisplayStateDTO, { kind: 'thanks' }>, 'at'>;

/** Bu cihazın yansıttığı müşteri ekranının adı; boşsa yansıtmaz (cihaz başına, Adisyon › İşlemler'den) */
export function useDisplayCode() {
  return useLocalPref<string>('display.code', KASA_PC ? 'kasa' : '');
}

/**
 * Kasa bilgisayarının kendisi (Windows'ta sunucunun çalıştığı bilgisayardaki kasa penceresi): ikinci ekranda açılan
 * müşteri ekranına (`/musteri-ekrani?ekran=kasa`; kasa-yazici.ps1 açar) kendiliğinden yansıtır. Başka cihazlar
 * (tablet, telefon) eskisi gibi Adisyon › İşlemler'den seçer; kasa da oradan kapatabilir
 */
const KASA_PC = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname) && /Windows/i.test(window.navigator.userAgent) && import.meta.env.MODE !== 'demo';

/** Son gönderilen durum: adisyondan çıkınca yalnız adisyon gösteriliyorsa "hoş geldiniz"e dönülür */
let lastKind: Outgoing['kind'] = 'idle';
/**
 * Gönderilmeyi bekleyen adisyon görüntüsü (300 ms toplanır). Teşekkür ya da hoş geldiniz gidince iptal olur: ödemeden
 * hemen önce kurulan zamanlayıcı teşekkürün ardından ateşlenip ekranı ödenmemiş adisyona döndürüyordu (e2e, 28 Eki 2026)
 */
let pendingOrder: ReturnType<typeof setTimeout> | null = null;
/** Gönderimler sırayla: önce çıkan istek sonra çıkanı (teşekkürü) ezmesin */
let queue: Promise<unknown> = Promise.resolve();

export function sendDisplay(code: string, state: Outgoing) {
  if (pendingOrder) {
    clearTimeout(pendingOrder);
    pendingOrder = null;
  }
  if (!code) return;
  lastKind = state.kind;
  queue = queue.then(() => put(`/display/${code}`, state)).catch(() => null);
}

/**
 * Açık adisyonu müşteri ekranına yansıtır: kalemler (gönderilmemişler dahil), indirim, servis ve tutar
 * (`displayOrder`). Adisyondan çıkınca ekran "hoş geldiniz"e döner. Gönderim 300 ms toplanır; ekran yalnız ad,
 * adet ve tutarı görür.
 */
export function useCustomerDisplay(boot: BootstrapDTO, order: OrderDTO | undefined, pending: PendingLine[], label: string) {
  const [code] = useDisplayCode();
  useEffect(() => {
    if (!code || !order || order.status !== 'acik') return;
    const state = displayOrder(boot, order, pending, label);
    // Boş adisyon (satış sonrası yeni satış) ekrandaki "teşekkürler"i ezmesin
    if (!state) return;
    if (pendingOrder) clearTimeout(pendingOrder);
    pendingOrder = setTimeout(() => sendDisplay(code, state), 300);
  }, [code, order, pending, boot, label]);
  // Adisyondan çıkınca ekran "hoş geldiniz"e döner (kapandıysa "teşekkürler"i ödeme penceresi göndermiştir)
  useEffect(
    () => () => {
      if (pendingOrder) {
        clearTimeout(pendingOrder);
        pendingOrder = null;
      }
      if (code && lastKind === 'order') sendDisplay(code, { kind: 'idle' });
    },
    [code],
  );
}
