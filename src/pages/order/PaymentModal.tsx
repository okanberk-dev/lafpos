import { Check, CheckCircle2, Droplets, Gift, HandCoins, Printer, RotateCcw, UserPlus, Users } from 'lucide-react';
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from 'react';
import { COMP_CLOSE_LABEL, COMP_CONFIRM_LABEL, COMP_DONE_TOAST, COMP_HINT, COMP_KINDS, COMP_LABEL, compCloseSubtitle, compReasonsOf } from '@shared/comp';
import { parseTL, splitEven, suggestCash, tl, tlShort } from '@shared/money';
import { amountForItems, itemPayLines, unpaidLineAmount } from '@shared/order-calc';
import { fmtTime } from '@shared/time';
import type { CompKind, OrderDTO, PaymentMethodDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad, useNumpadKeys } from '@/components/ui/Numpad';
import { Badge, Notice } from '@/components/ui/misc';
import { typeOverPrefill } from '@/lib/numpad';
import { promptDialog } from '@/components/ui/Confirm';
import { ApiError, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { newRequestId } from '@/lib/requestId';
import { BillReceipt, printNow } from '@/lib/print';
import { toast } from '@/lib/toast';
import { callFor, numaratorLabel } from '@shared/service-mode';
import { useServiceMode } from '@/lib/serviceMode';
import { CustomerModal } from './CustomerModal';
import { OkcPanel, useOkcReceipts } from './OkcPanel';
import { QtyStepper, ReasonModal } from './TableOps';
import { TypedAmount } from './TypedAmount';

type Mode = 'tutar' | 'kalem' | 'paylas';

/** Ciro dışı kapanış düğmeleri: ikram hediye, ödenmez el, zayi damla (İşlemler menüsüyle aynı) */
const COMP_ICON: Record<CompKind, ReactNode> = { ikram: <Gift className="size-4" />, odenmez: <HandCoins className="size-4" />, zayi: <Droplets className="size-4" /> };

const toInput = (k: number) => (k % 100 === 0 ? String(k / 100) : (k / 100).toFixed(2).replace('.', ','));

/** Seçim kartı (ödeme türü, kalem satırı): seçili yeşil kenar ve açık yeşil zemin; dinlenmede ince kenar */
const choice = (on: boolean) =>
  cn('rounded-xl border transition-colors duration-150', on ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line bg-surface text-ink hover:border-[var(--admin-border-field)] hover:bg-hover active:bg-press');

/** Tuş takımıyla yazılan alan (Tutar, Verilen): düğme görünümünde, rakam Gabarito; seçili olan yeşil kenar ve halka */
const typedField = (on: boolean) =>
  cn('tabular w-full rounded-xl border px-4 text-right font-headline font-semibold transition-[border-color,box-shadow] duration-150', on ? 'border-primary ring-4 ring-[var(--admin-primary-soft)]' : 'border-line-strong hover:border-[var(--admin-border-field)]');

/** Bölüm etiketi (Ödeme türü, Verilen, Ciro dışı kapat): 13 px, gri */
const SECTION = 'mb-2 text-[13px] font-medium text-muted';

/**
 * Ödeme penceresi. Telefonda tek sütun; tablet ve bilgisayarda solda tutar (tuş takımı, kalem seçimi ya da paylar) ve
 * altında yazarkasa ile alınan ödemeler, sağda ödeme türü, verilen ve bahşiş. Ödeme düğmesi pencerenin alt şeridinde:
 * kaydırınca kaybolmaz, para üstü ve bahşiş yanında yazar.
 */
export function PaymentModal({
  order,
  open,
  onClose,
  onDone,
  act,
}: {
  order: OrderDTO;
  open: boolean;
  onClose: () => void;
  /** `comp`: adisyon ödeme alınmadan ciro dışı kapandı (müşteri ekranına teşekkür ve tutar gitmez) */
  onDone: (closed: boolean, opts?: { comp?: CompKind }) => void;
  act: <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const boot = useBoot();
  const can = useCan();
  const serviceMode = useServiceMode();
  const remaining = order.total - order.paid;
  const split = order.split;
  const [mode, setMode] = useState<Mode>('tutar');
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethodDTO | null>(null);
  const [givenText, setGivenText] = useState('');
  const [tipText, setTipText] = useState('');
  const [focus, setFocus] = useState<'tutar' | 'verilen' | 'bahsis'>('tutar');
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [people, setPeople] = useState(2);
  const [busy, setBusy] = useState(false);
  /** Hesabı bölme ya da paylaşımı kaldırma sürüyor (ödeme düğmesinin göstergesinden ayrı) */
  const [splitBusy, setSplitBusy] = useState<'set' | 'clear' | null>(null);
  const [result, setResult] = useState<{ change: number; closed: boolean; amount: number; tip: number; method: string; share: string | null } | null>(null);
  /** Ciro dışı kapanış: gerekçe penceresi açık olan tür */
  const [comp, setComp] = useState<CompKind | null>(null);
  /** Açık hesap için müşteri bu pencerenin içinden eklenir (İşlemler menüsü pencerenin arkasında kalır) */
  const [customerOpen, setCustomerOpen] = useState(false);
  const methodsId = useId();
  /** Fiziksel klavye dinleyicisinin kökü: üstte onay ya da gerekçe penceresi açıkken tuşlar ona gider */
  const panelRef = useRef<HTMLDivElement>(null);
  /** Tutar alanı ve Verilen alanı: tür ya da hızlı tutar seçilince odak buraya döner, Enter ödemeyi alır */
  const amountRef = useRef<HTMLButtonElement>(null);
  const givenRef = useRef<HTMLButtonElement>(null);
  /**
   * Tutar alanındaki değer pencerenin önceden doldurduğu (kalan, Tamamı, Yarısı): seçili metin gibi, ilk rakam onun
   * yerine geçer ("250" üstüne 100 yazılınca 100 olur, 250100 değil)
   */
  const [prefilled, setPrefilled] = useState(true);
  /** Süren ödeme denemesi: ekranda görülenler (tür, tutar, pay, kalemler, bahşiş, ödeme listesi) ve kimliği */
  const attempt = useRef<{ key: string; id: string } | null>(null);
  // Yazarkasada bekleyen sepet: sunucu bu adisyonda ödemeyi, ciro dışı kapanışı ve ödeme iptalini reddeder (okc_pending)
  const okc = useOkcReceipts(order, open);
  const devicePending = !!okc.pending;
  /** Sepet cihaza gidince durumu ve iptali en üstte: telefonda gönder düğmesi aşağıdaydı, kutu görünür yere gelsin */
  const pendingRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (devicePending) pendingRef.current?.scrollIntoView({ block: 'nearest' });
  }, [devicePending]);

  useEffect(() => {
    if (!open) return;
    attempt.current = null;
    // Hesap daha önce bölündüyse pencere doğrudan paylarla açılır
    setMode(order.split ? 'paylas' : 'tutar');
    setAmountText(toInput(Math.max(0, remaining)));
    setPrefilled(true);
    setMethod(null);
    setGivenText('');
    setTipText('');
    setFocus('tutar');
    setSelection({});
    setPeople(order.split?.people ?? Math.min(30, Math.max(2, order.guests)));
    setResult(null);
    setComp(null);
    setCustomerOpen(false);
    // Yalnız pencere açılınca sıfırla
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const unpaidItems = order.items.filter((i) => !i.voided && !i.complimentary && i.qty - i.paidQty > 0 && (order.totals.lineNet[i.id] ?? 0) > 0);
  // Seçim yalnız ödenebilir kalemlerden gider: başka cihazda ikram ya da iptal edilen kalem seçimde kalmasın
  const picked = useMemo(
    () =>
      Object.entries(selection)
        .filter(([id, q]) => q > 0 && unpaidItems.some((i) => i.id === id))
        .map(([itemId, qty]) => ({ itemId, qty })),
    // unpaidItems order'dan türer
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [order, selection],
  );
  const payLines = useMemo(() => itemPayLines(order.items, order.payments), [order]);
  const itemsAmount = useMemo(
    () =>
      amountForItems(
        order.totals,
        payLines,
        picked.map((s) => ({ lineId: s.itemId, qty: s.qty })),
      ),
    [order, payLines, picked],
  );

  // Paylar: ödenenler ödemelerdeki pay numarasından, ödenmeyenler sunucunun hesabından (split.shares)
  const paidShares = order.payments.filter((p) => !p.refundedAt && p.shareNo != null).sort((a, b) => (a.shareNo ?? 0) - (b.shareNo ?? 0));
  const freeNos = useMemo(() => {
    if (!split) return [];
    const used = new Set(paidShares.map((p) => p.shareNo));
    return Array.from({ length: split.people }, (_, i) => i + 1).filter((n) => !used.has(n));
  }, [split, paidShares]);
  const nextShare = split?.shares[0] ?? 0;

  // Tutar kipinde yazılan kalana kırpılmaz: fazlası reddedilir (bankanın POS'undan çekilenle LafPOS'a yazılan ayrışmasın).
  // Kalem ve pay kiplerinde tutar sunucunun hesabıdır, kalanla sınırlı
  const typed = parseTL(amountText) ?? 0;
  const overRemaining = mode === 'tutar' && typed > remaining;
  const amount = mode === 'tutar' ? typed : Math.min(remaining, mode === 'kalem' ? itemsAmount : nextShare);
  const tip = boot.settings.tipsEnabled ? (parseTL(tipText) ?? 0) : 0;
  const given = parseTL(givenText);
  const change = method?.kind === 'nakit' && given != null ? given - amount - tip : null;
  const cariBlocked = method?.kind === 'cari' && !order.customer;
  // Açık hesapta para alınmaz; bahşiş yazılırsa raporda alınmış görünür (sunucu da reddeder)
  const tipBlocked = method?.kind === 'cari' && tip > 0;
  // Hesap bölünmüş ve ödenmemiş pay varken yalnız Paylaş: pay dışı ödeme payları düşürmez (sunucu da reddeder)
  const splitBlocks = !!split && split.shares.length > 0 && mode !== 'paylas';
  const valid = !!method && amount > 0 && !overRemaining && (change == null || change >= 0) && !cariBlocked && !tipBlocked && !splitBlocks && !devicePending;
  // Ciro dışı kapanış (İşlemler menüsüyle aynı kural): ödeme alınmamış, oda sayaçsız, ücretli kalemi olan açık adisyon
  const compable = order.status === 'acik' && order.paid === 0 && !order.room && order.items.some((i) => !i.voided && !i.complimentary);
  const closeComp = async (reason: string) => {
    if (!comp) return;
    const kind = comp;
    const res = await act((pin) => post(`/orders/${order.id}/comp`, { kind, reason, approverPin: pin }), COMP_DONE_TOAST[kind]);
    if (!res) return;
    setComp(null);
    onDone(true, { comp: kind });
  };

  const keyTarget = focus === 'verilen' ? [givenText, setGivenText] : focus === 'bahsis' ? [tipText, setTipText] : [amountText, setAmountText];
  const pressKey = (k: string) => {
    if (mode !== 'tutar' && focus === 'tutar') return;
    const [val, set] = keyTarget as [string, (v: string) => void];
    if (focus === 'tutar') {
      set(typeOverPrefill(val, k, prefilled, { decimal: true, maxLength: 9 }));
      setPrefilled(false);
      return;
    }
    set(applyNumpadKey(val, k, { decimal: true, maxLength: 9 }));
  };
  /** Tutarı pencere doldurur (kalan, Tamamı, Yarısı): sonraki ilk tuş onun yerine geçer */
  const prefillAmount = (k: number) => {
    setAmountText(toInput(k));
    setPrefilled(true);
  };
  /** Fareyle tür ya da hızlı tutar seçildikten sonra odak yazılan alana döner: Enter o düğmeyi yeniden basmaz, ödemeyi alır */
  const focusTyped = (target: 'tutar' | 'verilen') => {
    requestAnimationFrame(() => {
      const el = target === 'verilen' ? givenRef.current : amountRef.current;
      (el ?? panelRef.current)?.focus({ preventScroll: true });
    });
  };

  // Kasa bilgisayarında tutar ve verilen nakit klavyeyle de yazılır: rakam, virgül, Backspace, Delete; Enter ödemeyi
  // alır. Hedef ekrandaki seçili alan (Tab ile Tutar ve Verilen arasında geçilir)
  useNumpadKeys({
    enabled: open && !result,
    root: panelRef,
    decimal: true,
    onKey: pressKey,
    onEnter: () => {
      if (valid && !busy && !splitBusy) void pay();
    },
  });

  const setSplit = async (n: number | null) => {
    if (splitBusy) return;
    setSplitBusy(n ? 'set' : 'clear');
    await act(() => put<OrderDTO>(`/orders/${order.id}/split`, { people: n }), n ? `Hesap ${n} kişiye bölündü` : 'Paylaşım kaldırıldı');
    setSplitBusy(null);
  };

  const pay = async () => {
    if (!method || !valid) return;
    setBusy(true);
    const sharing = mode === 'paylas' && !!split;
    const items = mode === 'kalem' ? picked : null;
    // Aynı ekranda aynı girdilerle yeniden basılan "Öde" aynı denemedir (yanıtı kaybolan istek ikinci kez yazılmaz).
    // Ekranın gösterdiği tutar, pay ya da ödeme listesi değiştiyse yeni denemedir: yanıtı kaybolan pay 1'den sonra
    // ekran pay 2'yi ya da adedin yeni tutarını gösterir, iptal edilen ödemenin kimliği yeniden gitmez
    const shown = order.payments.map((p) => `${p.id}:${p.refundedAt ?? ''}`).join(',');
    const key = JSON.stringify([mode, method.id, amount, sharing ? freeNos[0] : null, items, tip, shown]);
    if (attempt.current?.key !== key) attempt.current = { key, id: newRequestId() };
    const requestId = attempt.current.id;
    const res = await act(async (pin) => {
      try {
        return await post<{ order: OrderDTO; closed: boolean; change: number; amount: number; share: { no: number; of: number } | null }>(`/orders/${order.id}/payments`, {
          methodId: method.id,
          amount,
          tip,
          given: method.kind === 'nakit' && given != null ? given : null,
          items,
          // Pay: ekrandaki tutar ve numara gider; sunucunun hesabı tutmazsa 409 split_changed, ekran yenilenir
          ...(sharing ? { share: true, shareNo: freeNos[0] } : {}),
          requestId,
          approverPin: pin,
        });
      } catch (e) {
        // Kimlik başka bir ödemeye (ya da iptal edilen ödemeye) ait: sonraki basış yeni deneme olur
        if (e instanceof ApiError && (e.code === 'request_reused' || e.code === 'request_refunded')) attempt.current = null;
        throw e;
      }
    });
    setBusy(false);
    if (!res) return;
    attempt.current = null;
    // Parçalı ödeme sürüyorsa pencere açık kalır: kalan tutara (ya da sıradaki paya) dönülür
    prefillAmount(res.order.total - res.order.paid);
    setSelection({});
    setGivenText('');
    setTipText('');
    setMethod(null);
    setFocus('tutar');
    // Sonuç ekranı sunucunun kaydettiğini gösterir (kör kasada kapanan adisyonun dökümü gelmez)
    const shareLabel = res.share ? `${res.share.no}/${res.share.of}` : null;
    if (res.closed || method.kind === 'nakit') {
      setResult({ change: res.change, closed: res.closed, amount: res.amount, tip, method: method.name, share: shareLabel });
      return;
    }
    // Kartla alınan kısmi ödeme ve pay sonuç ekranı açmaz: alındığı bildirilir (sıfırlanan alan dokunuş boşa gitti
    // sanılıp ödeme ikinci kez alınmasın)
    toast.ok(res.share ? `Pay ${res.share.no}/${res.share.of} alındı · ${method.name}` : `${tl(res.amount + tip)} alındı · ${method.name}${tip > 0 ? ` · ${tl(tip)} bahşiş dahil` : ''}`);
  };

  const refund = async (p: OrderDTO['payments'][number]) => {
    const reason = await promptDialog({
      title: 'Ödeme iptali',
      body: `${p.methodName} · ${tl(p.amount)}. İptal denetim kaydına yazılır`,
      label: 'Neden',
      placeholder: 'Ör. yanlış tutar girildi',
      maxLength: 200,
      required: true,
      confirmLabel: 'Ödemeyi iptal et',
    });
    if (!reason) return;
    await act((pin) => post(`/orders/${order.id}/payments/${p.id}/refund`, { reason, approverPin: pin }), 'Ödeme iptal edildi');
  };

  // Pay fişi de hesap yazdırmadır: sunucuya işlenir (denetim kaydı, masada "hesap istendi", sonraki iptal alarmı)
  const printShare = async (no: number, shareAmount: number) => {
    if (!split) return;
    const billed = await act(() => post<OrderDTO>(`/orders/${order.id}/bill`));
    if (billed) printNow(<BillReceipt order={billed} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} share={{ no, of: split.people, amount: shareAmount }} />);
  };
  const printBill = async () => {
    // Açık adisyonun hesabı yazdırılırken sunucuya işlenir; kapanmışın fişi doğrudan
    const billed = order.status === 'acik' ? await act(() => post<OrderDTO>(`/orders/${order.id}/bill`)) : order;
    if (billed) printNow(<BillReceipt order={billed} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} />);
  };

  if (!open) return null;

  if (result) {
    // Self ve yarı self servis: müşteriye söylenecek numara ya da personelin götüreceği masa sonuç ekranında büyük
    const call = result.closed ? callFor(order, serviceMode) : null;
    return (
      <Modal open onClose={() => (result.closed ? onDone(true) : setResult(null))} size="sm" persistent>
        <div className="p-6 text-center">
          <span className="mx-auto grid size-14 place-items-center rounded-full bg-[var(--admin-success-soft)] text-[var(--admin-success)]">
            <CheckCircle2 aria-hidden="true" className="size-8" />
          </span>
          <h2 className="mt-3 text-lg font-semibold">{result.closed ? 'Adisyon kapandı' : result.share ? `Pay ${result.share} alındı` : 'Ödeme alındı'}</h2>
          <p className="tabular mt-0.5 text-sm text-muted">
            {tl(result.amount + result.tip)} · {result.method}
            {result.tip > 0 && ` · ${tl(result.tip)} bahşiş dahil`}
          </p>
          {/* Para üstü kasiyerin ilk işi: en üstte, nötr kutuda mürekkep kenarla (amber zamanın rengidir) */}
          {result.change > 0 && (
            <div className="mt-5 rounded-xl border border-[var(--admin-ink-fill)] bg-surface p-4">
              <div className="text-[13px] font-medium text-ink-2">Para üstü</div>
              <div className="tabular font-headline text-5xl font-bold tracking-tight">{tl(result.change)}</div>
            </div>
          )}
          {call && (
            <div className={cn('rounded-xl border border-line bg-surface-2 p-4', result.change > 0 ? 'mt-3' : 'mt-5')}>
              <div className="text-[13px] font-medium text-muted">{call.kind === 'masa' ? 'Masaya götürülecek' : 'Sipariş numarası'}</div>
              <div className="tabular font-headline text-5xl font-bold tracking-tight">{call.kind === 'masa' ? numaratorLabel(call.value) : call.value}</div>
              {call.kind === 'numara' && <div className="mt-1 text-xs text-muted">Hazır olunca çağrı ekranında görünür</div>}
            </div>
          )}
          <div className="mt-6 grid gap-2">
            <Button variant="primary" size="lg" onClick={() => (result.closed ? onDone(true) : setResult(null))}>
              {result.closed ? (order.type === 'tezgah' ? 'Yeni satış' : 'Tamam') : result.share ? 'Sıradaki pay' : 'Kalanı al'}
            </Button>
            <Button icon={<Printer className="size-4" />} onClick={() => void printBill()}>
              Fiş yazdır
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  // Ödeme düğmesi ne yapacağını söyler: hazır değilse eksik adımı, açık hesapta "yaz" (para alınmaz); tutar bahşişi
  // de içerir (bankanın POS'una girilen ve gün sonunda kart slipiyle karşılaştırılan tutar)
  const payStep = splitBlocks
    ? 'Payları Paylaş’tan alın'
    : mode === 'paylas' && !split
      ? 'Önce hesabı bölün'
      : mode === 'paylas' && !nextShare
        ? 'Kalanı Tutar’dan alın'
        : mode === 'kalem' && !picked.length
          ? 'Ödenecek kalemleri seçin'
          : mode === 'tutar' && typed <= 0
            ? 'Tutar girin'
            : !method
              ? 'Ödeme türü seçin'
              : null;
  const payLabel = payStep ?? (method?.kind === 'cari' ? `${tl(amount)} açık hesaba yaz` : `${tl(amount + tip)} ${method?.name ?? ''} al`);
  // Para üstü ve bahşiş notu yalnız düğme tutarı gösterirken (eksik adım varken "Para üstü" yanıltır)
  const changeNote = !payStep && change != null && change !== 0 ? change : null;
  const tipNote = !payStep && tip > 0 && method?.kind !== 'cari';

  // Yazarkasa kutusu: ayar açık ve yetki varsa (OkcPanel'in kendi kuralı); sepet beklerken pencerenin en üstünde
  const okcOn = boot.integrations.okc.provider !== 'kapali' && can('odeme.al');
  const okcPanel = <OkcPanel order={order} amount={amount} items={mode === 'kalem' ? picked : null} onCompleted={(closed) => onDone(closed)} />;
  const hasLower = (okcOn && !devicePending) || order.payments.length > 0;
  const cust = order.customer;
  const cariAfter = cust ? cust.balance + amount : 0;
  const overLimit = !!cust && cust.creditLimit != null && cariAfter > cust.creditLimit;
  const compNote = devicePending
    ? 'Sepet yazarkasada beklerken adisyon ciro dışı kapanmaz'
    : order.paid > 0
      ? 'Ödeme alınmış adisyon ciro dışı kapanmaz; kalan kalemi hesap listesinden tek tek ikram ya da zayi yazın'
      : order.room
        ? 'Oda sayaçlı adisyon ciro dışı kapanmaz; kalemleri hesap listesinden tek tek yazın'
        : !compable
          ? 'Adisyonda ücretli kalem yok'
          : null;
  // Yarım kalan ödeme arka plana dokununca kaybolmasın: yazılan tutar, seçilen tür, verilen, bahşiş, seçili kalem ya da
  // süren istek varken yalnız Kapat kapatır
  const dirty = busy || !!splitBusy || !!comp || !!method || givenText !== '' || tipText !== '' || !prefilled || picked.length > 0;

  const footer = devicePending ? (
    <p role="status" className="py-2 text-center text-sm font-medium text-ink-2">
      Sepet yazarkasada: ödemeyi cihazdan alın ya da sepeti iptal edin
    </p>
  ) : (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      {(changeNote != null || tipNote) && (
        <div className="min-w-0 sm:flex-1">
          {changeNote != null && changeNote > 0 && (
            <p className="text-sm text-ink-2">
              Para üstü <span className="tabular font-headline text-lg font-bold text-ink">{tl(changeNote)}</span>
            </p>
          )}
          {changeNote != null && changeNote < 0 && (
            <p className="text-sm text-[var(--admin-danger-ink)]">
              Eksik <span className="tabular font-headline text-lg font-bold">{tl(-changeNote)}</span>
            </p>
          )}
          {tipNote && <p className="tabular text-xs text-muted">{tl(tip)} bahşiş dahil, ciroya girmez</p>}
        </div>
      )}
      <Button
        variant="ink"
        size="xl"
        block
        className="whitespace-normal leading-tight sm:ml-auto sm:w-auto sm:min-w-[22rem]"
        disabled={!valid || !!splitBusy}
        loading={busy}
        onClick={() => void pay()}
      >
        {payLabel}
      </Button>
    </div>
  );

  // Sepet yazarkasada beklerken ödeme iptal edilmez (sunucu da reddeder)
  const refundable = (p: OrderDTO['payments'][number]) => !p.refundedAt && !devicePending && (can('odeme.iade') || can('odeme.al'));
  const anyRefundable = order.payments.some(refundable);
  const payments = order.payments.length > 0 && (
    <div>
      <div className="mb-1.5 text-[13px] font-medium text-muted">Alınan ödemeler</div>
      <ul className="divide-y divide-[var(--admin-divider)] rounded-xl border border-line">
        {order.payments.map((p) => (
          <li key={p.id} className={cn('flex items-center gap-2 py-1.5 pl-3 pr-1.5 text-sm', !!p.refundedAt && 'text-muted line-through')}>
            <span className="min-w-0 flex-1 py-0.5">
              {p.methodName}
              {p.shareNo != null && (
                <Badge className="tabular ml-1.5">
                  Pay {p.shareNo}/{p.shareOf}
                </Badge>
              )}{' '}
              <span className="tabular text-xs text-muted">
                {fmtTime(p.createdAt)}
                {p.userName && ` · ${p.userName}`}
                {p.tip > 0 && ` · ${tl(p.tip)} bahşiş`}
              </span>
            </span>
            <span className={cn('tabular font-semibold', !anyRefundable && 'pr-1.5')}>{tl(p.amount)}</span>
            {/* İptal düğmesi olmayan satırda boşluk: tutarlar alt alta hizalı kalır */}
            {refundable(p) ? (
              <button
                aria-label="Ödemeyi iptal et"
                title="Ödemeyi iptal et"
                onClick={() => void refund(p)}
                className="grid size-9 shrink-0 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-[var(--admin-danger-soft)] hover:text-[var(--admin-danger-ink)] active:bg-[var(--admin-danger-soft)] active:text-[var(--admin-danger-ink)] pointer-coarse:size-11"
              >
                <RotateCcw aria-hidden="true" className="size-4" />
              </button>
            ) : (
              anyRefundable && <span aria-hidden="true" className="size-9 shrink-0 pointer-coarse:size-11" />
            )}
          </li>
        ))}
      </ul>
    </div>
  );

  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      persistent={dirty}
      title={`Ödeme · ${order.tableName ?? (order.numarator ? `${numaratorLabel(order.numarator)} · #${order.no}` : `#${order.no}`)}`}
      subtitle={`Toplam ${tl(order.total)}${order.paid ? ` · ödenen ${tl(order.paid)}` : ''}`}
      footer={footer}
    >
      <div ref={panelRef} tabIndex={-1} className="outline-none">
        {/* Sepet yazarkasada: durumu ve iptali en üstte (telefonda da ilk görülen), ödeme alınamaz */}
        {devicePending && (
          <div ref={pendingRef} className="border-b border-[var(--admin-divider)] px-5 py-4">
            {okcPanel}
          </div>
        )}
        {/* Sütunlar içerikle genişlemez (minmax 0): uzun, kırılmayan bir yazı telefonda pencereyi ekrandan taşırmasın.
            Sıra tutar → ödeme türü → yazarkasa ve ödemeler (telefonda alt alta, Tab sırası da bu); geniş ekranda yazarkasa
            ve ödemeler sol sütunda tutarın altında */}
        <div className="grid grid-cols-[minmax(0,1fr)] md:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] md:grid-rows-[auto_1fr]">
          <div className={cn('border-b border-[var(--admin-divider)] p-5 md:col-start-1 md:row-start-1 md:border-b-0 md:border-r', !hasLower && 'md:row-span-2')}>
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <Segmented<Mode>
                label="Ödeme yolu"
                value={mode}
                onChange={(m) => {
                  setMode(m);
                  setFocus('tutar');
                }}
                options={[
                  { value: 'tutar', label: 'Tutar' },
                  { value: 'kalem', label: 'Kalem seç' },
                  { value: 'paylas', label: 'Paylaş' },
                ]}
              />
              <div className="ml-auto text-right">
                <div className="text-xs font-medium text-muted">Kalan</div>
                <div className="tabular font-headline text-xl font-bold tracking-tight">{tl(remaining)}</div>
              </div>
            </div>

            {mode === 'tutar' && (
              <>
                <button
                  ref={amountRef}
                  onClick={() => setFocus('tutar')}
                  onFocus={() => setFocus('tutar')}
                  data-numpad-enter=""
                  aria-label={`Alınacak tutar: ${amountText || '0'}`}
                  aria-pressed={focus === 'tutar'}
                  aria-invalid={overRemaining || undefined}
                  aria-describedby={overRemaining ? 'odeme-tutar-fazla' : undefined}
                  className={cn(typedField(focus === 'tutar'), 'py-3 text-4xl', overRemaining ? 'mb-1 border-[var(--admin-danger)]' : 'mb-3', prefilled && focus === 'tutar' && 'text-ink-2')}
                >
                  <TypedAmount text={amountText} />
                </button>
                {overRemaining && (
                  <p id="odeme-tutar-fazla" role="alert" className="mb-3 text-sm text-[var(--admin-danger-ink)]">
                    Kalandan fazla: en çok {tl(remaining)} alınır
                  </p>
                )}
              </>
            )}

            {mode === 'kalem' && (
              <div className="mb-3">
                {/* Telefon ve tablette liste pencereyle birlikte kayar (iç içe kaydırma parmağı tutmaz); bilgisayarda kendi
                    kaydırıcısı, Seçilen toplamı hep altında görünür */}
                <div className="scroll-thin space-y-1.5 lg:max-h-72 lg:overflow-y-auto">
                  {unpaidItems.length === 0 && <p className="py-6 text-center text-sm text-muted">Ödenecek kalem kalmadı</p>}
                  {unpaidItems.map((i) => {
                    const left = i.qty - i.paidQty;
                    const sel = selection[i.id] ?? 0;
                    return (
                      <div key={i.id} className={cn('flex items-center gap-2 py-1 pl-3 pr-1', choice(sel > 0))}>
                        <button aria-pressed={sel > 0} className="min-h-11 min-w-0 flex-1 text-left" onClick={() => setSelection({ ...selection, [i.id]: sel === left ? 0 : left })}>
                          <span className="block truncate text-sm font-medium text-ink">
                            {i.name} {i.size !== 'TEK' && <span className="font-normal text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                          </span>
                          <span className="tabular block text-xs text-muted">
                            {left} adet · {tl(unpaidLineAmount(order.totals, payLines.find((l) => l.id === i.id) ?? i, remaining))}
                          </span>
                        </button>
                        <QtyStepper value={sel} max={left} onChange={(v) => setSelection({ ...selection, [i.id]: v })} />
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between px-1 pt-3 text-sm font-semibold">
                  <span>Seçilen</span>
                  {/* Sunucunun alacağı: ödenecek kalanla sınırlı (ödeme düğmesindeki tutarla aynı) */}
                  <span className="tabular font-headline text-base">{tl(amount)}</span>
                </div>
              </div>
            )}

            {mode === 'paylas' && (
              <SplitPanel order={order} people={people} setPeople={setPeople} busy={splitBusy} freeNos={freeNos} paidShares={paidShares} onSplit={setSplit} onPrint={printShare} />
            )}

            {(mode === 'tutar' || method?.kind === 'nakit' || focus === 'bahsis') && <Numpad decimal size="md" onKey={pressKey} />}
            {mode === 'tutar' && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                <QuickButton
                  onClick={() => {
                    prefillAmount(remaining);
                    setFocus('tutar');
                    focusTyped('tutar');
                  }}
                >
                  Tamamı
                </QuickButton>
                <QuickButton
                  onClick={() => {
                    // Yarısı sunucunun bölüşüyle (shared/money splitEven): tek kuruş artığı bu yarıya
                    prefillAmount(splitEven(remaining, 2)[0] ?? 0);
                    setFocus('tutar');
                    focusTyped('tutar');
                  }}
                >
                  Yarısı
                </QuickButton>
              </div>
            )}
          </div>

          <div className="@container space-y-5 p-5 md:col-start-2 md:row-span-2 md:row-start-1">
            <div>
              <div id={methodsId} className={SECTION}>
                Ödeme türü
              </div>
              <div role="group" aria-labelledby={methodsId} className="grid grid-cols-2 gap-2 @sm:grid-cols-3">
                {boot.paymentMethods.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setMethod(m);
                      if (m.kind === 'nakit') setFocus('verilen');
                      else if (focus === 'verilen') setFocus('tutar');
                      // Bahşiş yazılırken kart seçmek bahşiş girişini kesmez: DOM odağı tutar alanına gitse onFocus
                      // odağı 'tutar'a çeker, bahşiş diye yazılan rakam ödeme tutarının yerine geçerdi
                      if (m.kind !== 'nakit' && focus === 'bahsis') requestAnimationFrame(() => panelRef.current?.focus({ preventScroll: true }));
                      else focusTyped(m.kind === 'nakit' ? 'verilen' : 'tutar');
                    }}
                    aria-pressed={method?.id === m.id}
                    className={cn('flex h-14 min-w-0 items-center gap-2 px-3 text-left text-sm font-semibold', choice(method?.id === m.id))}
                  >
                    <span aria-hidden="true" className="size-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/25" style={{ background: m.color }} />
                    <span className="min-w-0 truncate">{m.name}</span>
                  </button>
                ))}
              </div>
              {/* Açık hesap: müşteri yoksa eksik adım ve eylemi (pencere kapanmadan eklenir); varsa kimin hesabına ne yazılacağı */}
              {method?.kind === 'cari' &&
                (cust ? (
                  <p className={cn('tabular mt-2 text-[13px]', overLimit ? 'text-[var(--admin-warning)]' : 'text-ink-2')}>
                    <span className="font-semibold">{cust.name}</span> · açık hesap {tl(cust.balance)} → {tl(cariAfter)}
                    {cust.creditLimit != null && ` · sınır ${tl(cust.creditLimit)}${overLimit ? ' aşılır' : ''}`}
                  </p>
                ) : (
                  <Notice
                    tone="info"
                    className="mt-2"
                    action={
                      <Button size="sm" icon={<UserPlus className="size-4" />} onClick={() => setCustomerOpen(true)}>
                        Müşteri ekle
                      </Button>
                    }
                  >
                    Açık hesap için adisyona müşteri ekleyin
                  </Notice>
                ))}
            </div>

            {method?.kind === 'nakit' && (
              <div>
                <div className={SECTION}>Verilen</div>
                <button
                  ref={givenRef}
                  onClick={() => setFocus('verilen')}
                  onFocus={() => setFocus('verilen')}
                  data-numpad-enter=""
                  aria-label={`Verilen nakit: ${givenText || '0'}`}
                  aria-pressed={focus === 'verilen'}
                  className={cn(typedField(focus === 'verilen'), 'py-2.5 text-2xl')}
                >
                  <TypedAmount text={givenText} />
                </button>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <QuickButton
                    onClick={() => {
                      setGivenText(toInput(amount + tip));
                      setFocus('verilen');
                      focusTyped('verilen');
                    }}
                  >
                    Tam
                  </QuickButton>
                  {suggestCash(amount + tip, boot.settings.quickCash).map((c) => (
                    <QuickButton
                      key={c}
                      onClick={() => {
                        setGivenText(toInput(c));
                        setFocus('verilen');
                        focusTyped('verilen');
                      }}
                    >
                      {tlShort(c)}
                    </QuickButton>
                  ))}
                </div>
              </div>
            )}

            {/* İşletme bahşiş almıyorsa (varsayılan) alan yok */}
            {boot.settings.tipsEnabled && (
              <div className="flex items-center justify-between gap-3 text-[13px]">
                <button
                  onClick={() => setFocus(focus === 'bahsis' ? 'tutar' : 'bahsis')}
                  aria-pressed={focus === 'bahsis'}
                  className={cn('tabular min-h-11 shrink-0 px-4 font-medium pointer-fine:min-h-9', choice(focus === 'bahsis'), 'rounded-full')}
                >
                  Bahşiş {tip > 0 ? tl(tip) : 'ekle'}
                </button>
                {tipBlocked ? (
                  <span className="text-right text-[var(--admin-danger-ink)]">Açık hesaba bahşiş yazılmaz</span>
                ) : (
                  <span className="text-right text-muted">Bahşiş ciroya girmez, ayrı raporlanır</span>
                )}
              </div>
            )}

            {/* Ciro dışı kapanış seyrek ve denetime yazılır: ödeme adımlarının ardında, sakin düğmelerle. Ücret alınmadan
                kapanır; ikram, ödenmez ve zayi raporda ve Z'de ayrı (shared/comp.ts) */}
            {order.status === 'acik' && order.source === 'pos' && (
              <div className="border-t border-[var(--admin-divider)] pt-4">
                <div className={SECTION}>Ciro dışı kapat</div>
                {/* Açıklama düğmenin ipucunda ve gerekçe penceresinin alt satırında (tutar ve nereye düştüğü) */}
                {compNote ? (
                  <p className="text-xs text-muted">{compNote}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {COMP_KINDS.map((k) => (
                      <Button key={k} size="sm" icon={COMP_ICON[k]} title={COMP_HINT[k]} onClick={() => setComp(k)}>
                        {COMP_LABEL[k]}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {hasLower && (
            <div className="space-y-4 border-t border-[var(--admin-divider)] p-5 md:col-start-1 md:row-start-2 md:border-r md:border-t-0 md:pt-0">
              {okcOn && !devicePending && okcPanel}
              {payments}
            </div>
          )}
        </div>
      </div>

      {comp && (
        <ReasonModal
          open
          title={COMP_CLOSE_LABEL[comp]}
          subtitle={compCloseSubtitle(comp, tl(order.total))}
          reasons={compReasonsOf(boot.settings, comp)}
          confirmLabel={COMP_CONFIRM_LABEL[comp]}
          onClose={() => setComp(null)}
          onConfirm={closeComp}
        />
      )}
      <CustomerModal
        order={order}
        open={customerOpen}
        onClose={() => {
          setCustomerOpen(false);
          // Müşteri eklenince "Müşteri ekle" düğmesi kalkar: odak sayfaya düşmesin, ödeme penceresine dönsün
          requestAnimationFrame(() => {
            if (!panelRef.current?.closest('[role=dialog]')?.contains(document.activeElement)) panelRef.current?.focus({ preventScroll: true });
          });
        }}
        act={act}
      />
    </Modal>
  );
}

/**
 * Paylaşımlı hesap: kişi sayısı seçilip hesap bölünür. Her pay ayrı ödenir (nakit, kart, yazarkasa); ödenen pay
 * yeşil, sıradaki mürekkep kenarlı. Bölündükten sonra eklenen kalem ya da iptal edilen pay kalanlara kendiliğinden dağılır.
 */
function SplitPanel({
  order,
  people,
  setPeople,
  busy,
  freeNos,
  paidShares,
  onSplit,
  onPrint,
}: {
  order: OrderDTO;
  people: number;
  setPeople: (n: number) => void;
  busy: 'set' | 'clear' | null;
  freeNos: number[];
  paidShares: OrderDTO['payments'];
  onSplit: (n: number | null) => void;
  onPrint: (no: number, amount: number) => void;
}) {
  const split = order.split;
  const minPeople = Math.max(2, paidShares.length + 1);
  const stepper = <QtyStepper label="Kişi" value={people} min={minPeople} max={30} onChange={setPeople} />;

  if (!split) {
    // Önizleme sunucunun bölüşüyle aynı (shared/money splitEven, order-calc splitState): kuruş artığı baştaki paylara
    const preview = splitEven(order.total - order.paid, Math.max(1, people - paidShares.length));
    const lo = preview[preview.length - 1] ?? 0;
    const hi = preview[0] ?? 0;
    const extra = preview.filter((s) => s > lo).length;
    return (
      <div className="mb-3 rounded-xl border border-line p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            <Users aria-hidden="true" className="size-4 text-muted" /> Kaç kişi ödeyecek?
          </span>
          {stepper}
        </div>
        <p className="tabular mt-3 text-[13px] text-muted">
          Kişi başı <b className="font-semibold text-ink">{tl(lo)}</b>
          {extra > 0 && (
            <>
              {' '}
              · ilk {extra > 1 ? `${extra} pay` : 'pay'} <b className="font-semibold text-ink">{tl(hi)}</b>
            </>
          )}
        </p>
        <Button variant="primary" block className="mt-3" loading={busy === 'set'} disabled={!!busy} onClick={() => onSplit(people)}>
          Hesabı {people} kişiye böl
        </Button>
      </div>
    );
  }

  const changed = people !== split.people;
  return (
    <div className="@container mb-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold">{split.people} kişi</span>
          <span className="text-muted"> · {split.paid} pay ödendi</span>
        </div>
        <div className="flex items-center gap-2">
          {stepper}
          {changed && (
            <Button size="sm" variant="primary" loading={busy === 'set'} disabled={!!busy} onClick={() => onSplit(people)}>
              Uygula
            </Button>
          )}
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-2 @md:grid-cols-3">
        {paidShares.map((p) => (
          <li key={p.id} className="rounded-xl border border-success-line bg-success-soft px-3 py-2.5">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--admin-success)]">
              <span className="tabular">
                Pay {p.shareNo}
                <span className="sr-only"> ödendi</span>
              </span>
              <Check className="size-4" />
            </div>
            <div className="tabular mt-0.5 font-headline text-lg font-bold">{tl(p.amount)}</div>
            <div className="truncate text-xs text-ink-2">{p.methodName}</div>
          </li>
        ))}
        {split.shares.map((amount, i) => {
          const no = freeNos[i] ?? i + 1;
          const next = i === 0;
          return (
            // Sıradaki pay seçili (mürekkep kenar, taş halka); yeşil yalnız ödenen pay: "2'si ödendi" diye okunmasın
            <li key={`pay-${no}`} className={cn('relative rounded-xl border py-2.5 pl-3 pr-10', next ? 'border-[var(--admin-text)] bg-surface ring-4 ring-[var(--admin-panel)]' : 'border-line bg-surface')}>
              <div className={cn('text-xs font-medium', next ? 'font-semibold text-ink' : 'text-muted')}>{next ? `Pay ${no} · sıradaki` : `Pay ${no}`}</div>
              <div className="tabular mt-0.5 font-headline text-lg font-bold">{tl(amount)}</div>
              <button
                aria-label={`Pay ${no} fişini yazdır`}
                title="Pay fişini yazdır"
                onClick={() => onPrint(no, amount)}
                className="absolute right-0.5 top-0.5 grid size-11 place-items-center rounded-full text-muted transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-press"
              >
                <Printer aria-hidden="true" className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
      {split.shares.length === 0 && order.total - order.paid > 0 && (
        <Notice tone="warn">
          Bütün paylar ödendi ama {tl(order.total - order.paid)} kaldı (sonradan eklenen kalem). Kişi ekleyin ya da “Tutar” ile alın
        </Notice>
      )}
      <Button size="sm" variant="ghost" className="-ml-2" loading={busy === 'clear'} disabled={!!busy} onClick={() => onSplit(null)}>
        Paylaşımı kaldır
      </Button>
    </div>
  );
}

/** Hızlı tutar (Tamamı, Yarısı, Tam, ₺200): kitin küçük ikincil düğmesi, rakam hizalı */
function QuickButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <Button size="sm" className="tabular" onClick={onClick}>
      {children}
    </Button>
  );
}
