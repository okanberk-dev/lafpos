import { useEffect, useRef } from 'react';
import { COMP_LABEL } from '@shared/comp';
import { afterPaymentPrints, isKasaHost, printOnce } from '@shared/odeme-fisi';
import type { BootstrapDTO, CompKind, OrderDTO } from '@shared/types';
import { ApiError, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { onLive, useLive } from '@/lib/live';
import { BankEodReceipt, type BankEodSlip, BillReceipt, printEach, StoreCopyReceipt, ZReceipt } from '@/lib/print';
import { type ClaimedStoreCopy, type StoreCopyApi, storeCopyQueue } from '@/lib/store-copies';

/** Bu sekmede basılmış LafPOS ödemeleri (ödeme kimliği): aynı ödeme ikinci kez basılmaz */
const once = printOnce();

const DOC_LABEL: Record<string, string> = { okc_fis: 'fiş', bilgi_fisi: 'bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

const plannedPrints = (boot: BootstrapDTO, viaDevice: boolean) =>
  afterPaymentPrints({
    settings: boot.settings,
    printer: !!boot.integrations.receiptPrinter,
    kasaScreen: isKasaHost(window.location.hostname),
    provider: boot.integrations.okc.provider,
    viaDevice,
  });

/**
 * Bu ekran cihaz ödemesinin işyeri nüshasını basar mı (kasa ekranı, fiş yazıcısı, ayar açık). Sepet cihaza
 * gönderilirken sunucuya söylenir (`storeCopy`): cihaz ödeyince nüsha sunucuda bekler, bir kasa ekranı tam bir kez basar
 */
export function deviceCopyHere(boot: BootstrapDTO): boolean {
  return plannedPrints(boot, true).storeCopy;
}

/**
 * LafPOS'ta alınan ödemeden sonra fiş yazıcısından çıkanlar (yalnız ödemeyi alan ekranda çağrılır): kısa işyeri nüshası
 * ve yazarkasasız kurulumda müşteriye bilgi fişi. Kasa ekranı değilse ya da yazıcı yoksa sessizce hiçbir şey olmaz.
 * `key` her ödeme için tektir (ödeme kimlikleri). Cihaz ödemesinin nüshası ayrı yoldan: `useDeviceCopies`
 */
export function printAfterPayment(opts: { key: string; boot: BootstrapDTO; order: OrderDTO; paymentIds: string[] }) {
  const { boot, order } = opts;
  const plan = plannedPrints(boot, false);
  if (!plan.storeCopy && !plan.infoSlip) return;
  if (!once(opts.key)) return;
  const payments = order.payments.filter((p) => opts.paymentIds.includes(p.id));
  const cashier = payments.find((p) => p.userName)?.userName ?? useAuth.getState().me?.name ?? null;
  const sizeLabel = (s: string) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s;
  // Önce müşteri nüshası (büyük sipariş no), sonra işyeri nüshası (kalem dökümü; bar için): ayrı kâğıtlar
  void printEach([
    ...(plan.infoSlip ? [<BillReceipt key="m" order={order} boot={boot} sizeLabel={sizeLabel} copy />] : []),
    ...(plan.storeCopy ? [<StoreCopyReceipt key="i" order={order} boot={boot} payments={payments} cashier={cashier} />] : []),
  ]).catch(() => undefined);
}

/**
 * Ciro dışı kapanıştan (ikram, ödenmez, zayi) sonra fiş yazıcısından ödemedeki gibi iki ayrı kâğıt: müşteri nüshası ve
 * kalemli işyeri nüshası (bar için; altta kapanış türü). Ödeme sonrası fiş ayarlarına bağlı, kasa ekranında ve yazıcı varken
 */
export function printAfterComp(opts: { boot: BootstrapDTO; order: OrderDTO; kind: CompKind }) {
  const { boot, order } = opts;
  const plan = plannedPrints(boot, false);
  if (!plan.storeCopy && !plan.infoSlip) return;
  if (!once(`ciro-disi:${order.id}:${order.closedAt ?? ''}`)) return;
  const cashier = useAuth.getState().me?.name ?? null;
  const sizeLabel = (s: string) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s;
  void printEach([
    ...(plan.infoSlip ? [<BillReceipt key="m" order={order} boot={boot} sizeLabel={sizeLabel} copy />] : []),
    ...(plan.storeCopy ? [<StoreCopyReceipt key="i" order={order} boot={boot} payments={[]} cashier={cashier} comp={COMP_LABEL[opts.kind]} />] : []),
  ]).catch(() => undefined);
}

/**
 * Sunucudan alınan cihaz ödemesi nüshaları tek yazdırmada (aralarında kâğıt kesilir). Fiş ve Z no'su cihazdan, saat
 * ödemenin anı (nüsha geç basılsa da), kasiyer ödemeyi alan kişi (görünmüyorsa bu ekrandaki kişi)
 */
export function printStoreCopies(boot: BootstrapDTO, copies: ClaimedStoreCopy[]): Promise<void> {
  const me = useAuth.getState().me?.name ?? null;
  const info = plannedPrints(boot, true).infoSlip;
  // Her nüsha ayrı yazdırma işi: yazıcı her birinin sonunda keser (müşteri nüshası, sonra işyeri nüshası)
  return printEach(
    copies.flatMap((c) => [
      ...(info ? [<BillReceipt key={`${c.receiptId}-m`} order={c.order} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} copy />] : []),
      <StoreCopyReceipt
        key={`${c.receiptId}-i`}
        order={c.order}
        boot={boot}
        payments={c.payments}
        device={{ receiptNo: c.device.receiptNo, zNo: c.device.zNo, docId: c.device.docId, docLabel: c.device.docKind ? (DOC_LABEL[c.device.docKind] ?? null) : null }}
        cashier={c.payments.find((p) => p.userName)?.userName ?? me}
        at={c.at}
      />,
    ]),
  );
}

/** Nüshanın sunucu uçları (server/routes/okc.ts › store-copies) */
const storeCopyApi: StoreCopyApi = {
  pending: () => get<{ id: string }[]>('/okc/store-copies'),
  claim: async (id) => {
    try {
      return await post<ClaimedStoreCopy>(`/okc/store-copies/${encodeURIComponent(id)}/claim`);
    } catch (e) {
      // Başka ekran aldı, basıldı ya da artık basılmayacak
      if (e instanceof ApiError && (e.code === 'copy_taken' || e.status === 404)) return null;
      throw e;
    }
  },
  printed: async (id, claim) => {
    try {
      await post(`/okc/store-copies/${encodeURIComponent(id)}/printed`, { claim });
    } catch (e) {
      // Nüsha bu arada başka ekrana verildi: onay yeniden denenmez
      if (e instanceof ApiError && (e.code === 'copy_taken' || e.status === 404)) return;
      throw e;
    }
  },
};

/**
 * Uygulama düzeyinde (AppShell) cihaz ödemelerinin işyeri nüshası: yalnız nüsha basan kasa ekranında ve ödeme alabilen
 * kişide. Ödeme penceresi ya da adisyon ekranı kapanmış olsa da basılır; olay kaçtıysa (ekran kapalı, yenileniyor,
 * kilitli ya da canlı bağlantı kopuk) açılışta ve bağlantı yeniden kurulunca (`src/lib/store-copies.ts`)
 */
export function useDeviceCopies(boot: BootstrapDTO) {
  const canTake = useAuth((s) => !!s.me?.permissions.includes('odeme.al'));
  const active = canTake && deviceCopyHere(boot);
  const ref = useRef(boot);
  useEffect(() => {
    ref.current = boot;
  });
  useEffect(() => {
    if (!active) return;
    // Görünmeyen sekme (simge durumunda, arkada) yazdıramaz: nüsha almaz, görünür olunca sorar
    const visible = () => document.visibilityState === 'visible';
    const queue = storeCopyQueue(storeCopyApi, (copies) => printStoreCopies(ref.current, copies), { ready: visible });
    void queue.sync();
    const offLive = onLive((e) => void queue.onEvent(e));
    // Canlı bağlantı yeniden kuruldu: kopukken ödenenlerin nüshası
    const offStatus = useLive.subscribe((s, prev) => {
      if (s.status === 'canli' && prev.status !== 'canli') void queue.sync();
    });
    const onVisible = () => {
      if (visible()) void queue.sync();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offLive();
      offStatus();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active]);
}

/**
 * Pavo'da banka gün sonu alınınca (gün kapanınca ya da elle) fiş yazıcısından gün sonu kâğıdı: işyeri nüshası basan
 * kasa ekranında. Sunucu kâğıdı batch başına bir kez, ilk soran ekrana verir; olay kaçtıysa açılışta, bağlantı yeniden
 * kurulunca ve sekme görünür olunca sorulur. Ayar: Yönetim › Yazarkasa POS › "Gün sonu kâğıdı fiş yazıcısından da çıksın"
 */
export function useBankEodSlip(boot: BootstrapDTO) {
  const canTake = useAuth((s) => !!s.me?.permissions.includes('odeme.al'));
  const active = canTake && deviceCopyHere(boot);
  const ref = useRef(boot);
  useEffect(() => {
    ref.current = boot;
  });
  useEffect(() => {
    if (!active) return;
    const visible = () => document.visibilityState === 'visible';
    let busy = false;
    const ask = async () => {
      if (busy || !visible()) return;
      busy = true;
      try {
        const { slip } = await post<{ slip: BankEodSlip | null }>('/okc/eod/slip', {});
        // Kayıt için iki kâğıt: önce LafPOS Z'si, sonra banka gün sonu ve kıyası (Pavo kendi slibini ayrıca basar)
        if (slip) {
          const b = ref.current;
          await printEach([
            ...(slip.z ? [<ZReceipt key="z" boot={b} date={slip.z.date} zNo={slip.z.zNo} s={slip.z.summary} closedAt={slip.z.closedAt} />] : []),
            <BankEodReceipt key="b" boot={b} slip={slip} />,
          ]);
        }
      } catch {
        // Sessiz: cihazın kendi slibi var, gün sonu sonucu Yönetim › Yazarkasa POS'ta
      } finally {
        busy = false;
      }
    };
    void ask();
    const offLive = onLive((e) => {
      if (e.topic === 'okc' && e.kind === 'okc.eod') void ask();
    });
    const offStatus = useLive.subscribe((s, prev) => {
      if (s.status === 'canli' && prev.status !== 'canli') void ask();
    });
    const onVisible = () => void ask();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      offLive();
      offStatus();
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [active]);
}
