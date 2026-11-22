import { afterPaymentPrints, isKasaHost, printOnce } from '@shared/odeme-fisi';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { useAuth } from '@/lib/auth';
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
