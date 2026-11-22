import { useEffect, useRef } from 'react';
import { afterPaymentPrints, isKasaHost, printOnce } from '@shared/odeme-fisi';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { deviceCopyListener } from '@/lib/device-copies';
import { onLive } from '@/lib/live';
import { BillReceipt, printNow, PrintCut, StoreCopyReceipt } from '@/lib/print';

/** Bu sekmede basılmış ödemeler (cihaz sepeti ya da ödeme kimliği): aynı ödeme ikinci kez basılmaz */
const once = printOnce();

const DOC_LABEL: Record<string, string> = { okc_fis: 'fiş', bilgi_fisi: 'bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

/** Bu ekranda ödemeden sonra bir şey basılır mı (basılmayacaksa cihaz fişi için sunucuya sorulmaz) */
export function printsAfterPayment(boot: BootstrapDTO, viaDevice: boolean): boolean {
  const plan = plannedPrints(boot, viaDevice);
  return plan.storeCopy || plan.infoSlip;
}

const plannedPrints = (boot: BootstrapDTO, viaDevice: boolean) =>
  afterPaymentPrints({
    settings: boot.settings,
    printer: !!boot.integrations.receiptPrinter,
    kasaScreen: isKasaHost(window.location.hostname),
    provider: boot.integrations.okc.provider,
    viaDevice,
  });

/**
 * Ödemeden sonra fiş yazıcısından çıkanlar (yalnız ödemeyi alan ekranda çağrılır): kısa işyeri nüshası ve yazarkasasız
 * kurulumda müşteriye bilgi fişi. Kasa ekranı değilse ya da yazıcı yoksa sessizce hiçbir şey olmaz. `key` her ödeme
 * için tektir (cihaz sepeti ya da ödeme kimliği)
 */
export function printAfterPayment(opts: {
  key: string;
  boot: BootstrapDTO;
  order: OrderDTO;
  paymentIds: string[];
  device?: { receiptNo: number | null; zNo: number | null; docKind: string | null; docId: string | null } | null;
}) {
  const { boot, order } = opts;
  const plan = plannedPrints(boot, !!opts.device);
  if (!plan.storeCopy && !plan.infoSlip) return;
  if (!once(opts.key)) return;
  const payments = order.payments.filter((p) => opts.paymentIds.includes(p.id));
  const cashier = payments.find((p) => p.userName)?.userName ?? useAuth.getState().me?.name ?? null;
  const sizeLabel = (s: string) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s;
  const device = opts.device ? { receiptNo: opts.device.receiptNo, zNo: opts.device.zNo, docId: opts.device.docId, docLabel: opts.device.docKind ? (DOC_LABEL[opts.device.docKind] ?? null) : null } : null;
  printNow(
    <>
      {plan.storeCopy && <StoreCopyReceipt order={order} boot={boot} payments={payments} device={device} cashier={cashier} />}
      {plan.storeCopy && plan.infoSlip && <PrintCut />}
      {plan.infoSlip && <BillReceipt order={order} boot={boot} sizeLabel={sizeLabel} />}
    </>,
  );
}

type DeviceReceipt = { id: string; status: string; paymentIds?: string[]; receiptNo: number | null; zNo: number | null; docKind: string | null; docId: string | null };

/**
 * Cihazda ödenen sepetin işyeri nüshası: sepetin fiş ve Z no'su ile adisyonun güncel hâli sunucudan okunur. Yazdırma
 * ödemeyi bozmaz (hata sessiz); her cihaz fişi bir kez (`printAfterPayment`)
 */
export async function printDeviceCopy(boot: BootstrapDTO, orderId: string) {
  if (!printsAfterPayment(boot, true)) return;
  try {
    const [receipts, order] = await Promise.all([get<DeviceReceipt[]>(`/okc/orders/${orderId}/receipts`), get<OrderDTO>(`/orders/${orderId}`)]);
    const r = receipts.find((x) => x.status === 'tamamlandi');
    if (!r) return;
    printAfterPayment({ key: `okc:${r.id}`, boot, order, paymentIds: r.paymentIds ?? [], device: { receiptNo: r.receiptNo, zNo: r.zNo, docKind: r.docKind, docId: r.docId } });
  } catch {
    // Fiş basılamadı: ödeme yine alınmıştır
  }
}

/**
 * Uygulama düzeyinde (AppShell) cihaz ödemelerinin nüshası: sepeti bu sekme gönderdiyse ödeme penceresi ya da adisyon
 * ekranı kapanmış olsa da basılır (`markDeviceSent`)
 */
export function useDeviceCopies(boot: BootstrapDTO) {
  const ref = useRef(boot);
  useEffect(() => {
    ref.current = boot;
  });
  useEffect(() => onLive(deviceCopyListener((orderId) => void printDeviceCopy(ref.current, orderId))), []);
}
