import { Check, CheckCircle2, Droplets, Gift, HandCoins, Minus, Plus, Printer, RotateCcw, Users, X } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { COMP_CLOSE_LABEL, COMP_CONFIRM_LABEL, COMP_DONE_TOAST, COMP_HINT, COMP_KINDS, COMP_LABEL, compCloseSubtitle, compReasonsOf } from '@shared/comp';
import { parseTL, suggestCash, tl, tlShort } from '@shared/money';
import { amountForItems, itemPayLines, unpaidLineAmount } from '@shared/order-calc';
import { fmtTime } from '@shared/time';
import type { CompKind, OrderDTO, PaymentMethodDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { ApiError, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { newRequestId } from '@/lib/requestId';
import { BillReceipt, printNow } from '@/lib/print';
import { callFor, numaratorLabel } from '@shared/service-mode';
import { useServiceMode } from '@/lib/serviceMode';
import { OkcPanel } from './OkcPanel';
import { ReasonModal } from './TableOps';

type Mode = 'tutar' | 'kalem' | 'paylas';

/** Ciro dışı kapanış düğmeleri: ikram hediye, ödenmez el, zayi damla (İşlemler menüsüyle aynı) */
const COMP_ICON: Record<CompKind, ReactNode> = { ikram: <Gift className="size-4" />, odenmez: <HandCoins className="size-4" />, zayi: <Droplets className="size-4" /> };

const toInput = (k: number) => (k % 100 === 0 ? String(k / 100) : (k / 100).toFixed(2).replace('.', ','));


/** Innex seçim kartı/çipi: seçili mavi kenar ve açık mavi zemin */
const choice = (on: boolean) =>
  cn('rounded-xl border transition-colors', on ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line bg-surface text-ink hover:border-[var(--admin-border-field)] hover:bg-surface-2');

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
  onDone: (closed: boolean) => void;
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
  const [result, setResult] = useState<{ change: number; closed: boolean; amount: number; method: string; share: string | null } | null>(null);
  /** Ciro dışı kapanış: gerekçe penceresi açık olan tür */
  const [comp, setComp] = useState<CompKind | null>(null);
  /** Süren ödeme denemesi: ekranda görülenler (tür, tutar, pay, kalemler, bahşiş, ödeme listesi) ve kimliği */
  const attempt = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    attempt.current = null;
    // Hesap daha önce bölündüyse pencere doğrudan paylarla açılır
    setMode(order.split ? 'paylas' : 'tutar');
    setAmountText(toInput(Math.max(0, remaining)));
    setMethod(null);
    setGivenText('');
    setTipText('');
    setFocus('tutar');
    setSelection({});
    setPeople(order.split?.people ?? Math.min(30, Math.max(2, order.guests)));
    setResult(null);
    setComp(null);
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

  const amount = Math.min(remaining, mode === 'kalem' ? itemsAmount : mode === 'paylas' ? nextShare : (parseTL(amountText) ?? 0));
  const tip = boot.settings.tipsEnabled ? (parseTL(tipText) ?? 0) : 0;
  const given = parseTL(givenText);
  const change = method?.kind === 'nakit' && given != null ? given - amount - tip : null;
  const cariBlocked = method?.kind === 'cari' && !order.customer;
  // Açık hesapta para alınmaz; bahşiş yazılırsa raporda alınmış görünür (sunucu da reddeder)
  const tipBlocked = method?.kind === 'cari' && tip > 0;
  // Hesap bölünmüş ve ödenmemiş pay varken yalnız Paylaş: pay dışı ödeme payları düşürmez (sunucu da reddeder)
  const splitBlocks = !!split && split.shares.length > 0 && mode !== 'paylas';
  const valid = !!method && amount > 0 && (change == null || change >= 0) && !cariBlocked && !tipBlocked && !splitBlocks;
  // Ciro dışı kapanış (İşlemler menüsüyle aynı kural): ödeme alınmamış, oda sayaçsız, ücretli kalemi olan açık adisyon
  const compable = order.status === 'acik' && order.paid === 0 && !order.room && order.items.some((i) => !i.voided && !i.complimentary);
  const closeComp = async (reason: string) => {
    if (!comp) return;
    const kind = comp;
    const res = await act((pin) => post(`/orders/${order.id}/comp`, { kind, reason, approverPin: pin }), COMP_DONE_TOAST[kind]);
    if (!res) return;
    setComp(null);
    onDone(true);
  };

  const keyTarget = focus === 'verilen' ? [givenText, setGivenText] : focus === 'bahsis' ? [tipText, setTipText] : [amountText, setAmountText];
  const pressKey = (k: string) => {
    if (mode !== 'tutar' && focus === 'tutar') return;
    const [val, set] = keyTarget as [string, (v: string) => void];
    set(applyNumpadKey(val, k, { decimal: true, maxLength: 9 }));
  };

  const setSplit = async (n: number | null) => {
    setBusy(true);
    await act(() => put<OrderDTO>(`/orders/${order.id}/split`, { people: n }), n ? `Hesap ${n} kişiye bölündü` : 'Paylaşım kaldırıldı');
    setBusy(false);
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
    setAmountText(toInput(res.order.total - res.order.paid));
    setSelection({});
    setGivenText('');
    setTipText('');
    setMethod(null);
    setFocus('tutar');
    // Sonuç ekranı sunucunun kaydettiğini gösterir (kör kasada kapanan adisyonun dökümü gelmez)
    const shareLabel = res.share ? `${res.share.no}/${res.share.of}` : null;
    if (res.closed || method.kind === 'nakit') setResult({ change: res.change, closed: res.closed, amount: res.amount, method: method.name, share: shareLabel });
  };

  const refund = async (paymentId: string) => {
    const reason = window.prompt('Ödeme iptalinin nedeni');
    if (!reason?.trim()) return;
    await act((pin) => post(`/orders/${order.id}/payments/${paymentId}/refund`, { reason, approverPin: pin }), 'Ödeme iptal edildi');
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
            <CheckCircle2 className="size-8" />
          </span>
          <h2 className="mt-3 text-lg font-semibold">{result.closed ? 'Adisyon kapandı' : result.share ? `Pay ${result.share} alındı` : 'Ödeme alındı'}</h2>
          <p className="tabular mt-0.5 text-sm text-muted">
            {tl(result.amount)} · {result.method}
          </p>
          {call && (
            <div className="mt-5 rounded-xl border border-line bg-surface-2 p-4">
              <div className="text-[13px] font-medium text-muted">{call.kind === 'masa' ? 'Masaya götürülecek' : 'Sipariş numarası'}</div>
              <div className="tabular text-5xl font-bold tracking-tight">{call.kind === 'masa' ? numaratorLabel(call.value) : call.value}</div>
              {call.kind === 'numara' && <div className="mt-1 text-xs text-muted">Hazır olunca çağrı ekranında görünür</div>}
            </div>
          )}
          {result.change > 0 && (
            <div className="mt-5 rounded-xl bg-[var(--admin-warning-soft)] p-4">
              <div className="text-[13px] font-medium text-[var(--admin-warning)]">Para üstü</div>
              <div className="tabular text-5xl font-bold tracking-tight">{tl(result.change)}</div>
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

  return (
    <Modal open onClose={onClose} size="xl" persistent={!!comp} title={`Ödeme · ${order.tableName ?? (order.numarator ? `${numaratorLabel(order.numarator)} · #${order.no}` : `#${order.no}`)}`} subtitle={`Toplam ${tl(order.total)}${order.paid ? ` · ödenen ${tl(order.paid)}` : ''}`}>
      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        <div className="border-b border-[var(--admin-divider)] p-5 lg:border-b-0 lg:border-r">
          <div className="mb-4 flex items-center justify-between gap-3">
            <Segmented<Mode>
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
            <div className="text-right">
              <div className="text-xs font-medium text-muted">Kalan</div>
              <div className="tabular text-xl font-bold tracking-tight">{tl(remaining)}</div>
            </div>
          </div>

          {mode === 'tutar' && (
            <button
              onClick={() => setFocus('tutar')}
              className={cn('tabular mb-3 w-full rounded-xl border px-4 py-3 text-right text-4xl font-semibold transition', focus === 'tutar' ? 'border-primary ring-4 ring-[var(--admin-primary-soft)]' : 'border-line')}
            >
              {amountText || '0'} ₺
            </button>
          )}

          {mode === 'kalem' && (
            <div className="scroll-thin mb-3 max-h-72 space-y-1.5 overflow-y-auto">
              {unpaidItems.map((i) => {
                const left = i.qty - i.paidQty;
                const sel = selection[i.id] ?? 0;
                return (
                  <div key={i.id} className={cn('flex items-center gap-2 px-3 py-2', choice(sel > 0))}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelection({ ...selection, [i.id]: sel === left ? 0 : left })}>
                      <span className="block truncate text-sm font-medium text-ink">
                        {i.name} {i.size !== 'TEK' && <span className="text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                      </span>
                      <span className="tabular text-xs text-muted">
                        {left} adet · {tl(unpaidLineAmount(order.totals, payLines.find((l) => l.id === i.id) ?? i, remaining))}
                      </span>
                    </button>
                    <div className="flex items-center gap-1">
                      <button aria-label="Azalt" className="grid size-11 place-items-center rounded-lg bg-surface-3 text-ink" onClick={() => setSelection({ ...selection, [i.id]: Math.max(0, sel - 1) })}>
                        <Minus className="size-4" />
                      </button>
                      <span className="tabular w-6 text-center font-semibold text-ink">{sel}</span>
                      <button aria-label="Artır" className="grid size-11 place-items-center rounded-lg bg-surface-3 text-ink" onClick={() => setSelection({ ...selection, [i.id]: Math.min(left, sel + 1) })}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-between px-1 pt-2 text-sm font-semibold">
                <span>Seçilen</span>
                {/* Sunucunun alacağı: ödenecek kalanla sınırlı (ödeme düğmesindeki tutarla aynı) */}
                <span className="tabular">{tl(amount)}</span>
              </div>
            </div>
          )}

          {mode === 'paylas' && (
            <SplitPanel
              order={order}
              people={people}
              setPeople={setPeople}
              busy={busy}
              freeNos={freeNos}
              paidShares={paidShares}
              onSplit={setSplit}
              onPrint={printShare}
            />
          )}

          {(mode === 'tutar' || method?.kind === 'nakit' || focus === 'bahsis') && <Numpad decimal size="md" onKey={pressKey} />}
          {mode === 'tutar' && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              <QuickButton onClick={() => setAmountText(toInput(remaining))}>Tamamı</QuickButton>
              <QuickButton onClick={() => setAmountText(toInput(Math.ceil(remaining / 2)))}>Yarısı</QuickButton>
            </div>
          )}
        </div>

        <div className="space-y-4 p-5">
          <div>
            <div className="mb-2 text-[13px] font-medium text-muted">Ödeme türü</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {boot.paymentMethods.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMethod(m);
                    if (m.kind === 'nakit') setFocus('verilen');
                    else if (focus === 'verilen') setFocus('tutar');
                  }}
                  aria-pressed={method?.id === m.id}
                  className={cn('flex h-14 items-center gap-2 px-3 text-left text-sm font-semibold', choice(method?.id === m.id))}
                >
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: m.color }} />
                  <span className="min-w-0 truncate">{m.name}</span>
                </button>
              ))}
            </div>
            {cariBlocked && <p className="mt-2 text-sm text-[var(--admin-danger-ink)]">Açık hesap için önce adisyona müşteri ekleyin (İşlemler › Müşteri)</p>}
          </div>

          {/* Ciro dışı kapanış: ücret alınmadan kapanır; ikram, ödenmez ve zayi raporda ve Z'de ayrı (shared/comp.ts) */}
          {order.status === 'acik' && order.source === 'pos' && (
            <div>
              <div className="mb-2 text-[13px] font-medium text-muted">Ciro dışı kapat</div>
              <div className="grid grid-cols-3 gap-2">
                {COMP_KINDS.map((k) => (
                  <button key={k} onClick={() => setComp(k)} disabled={!compable} title={COMP_HINT[k]} className={cn('flex h-14 items-center justify-center gap-2 px-3 text-sm font-semibold disabled:opacity-40', choice(false))}>
                    {COMP_ICON[k]}
                    {COMP_LABEL[k]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                {order.paid > 0
                  ? 'Ödeme alınmış adisyon ciro dışı kapanmaz; kalan kalemi hesap listesinden tek tek ikram ya da zayi yazın'
                  : order.room
                    ? 'Oda sayaçlı adisyon ciro dışı kapanmaz; kalemleri hesap listesinden tek tek yazın'
                    : 'Adisyon ücret alınmadan kapanır; ikram, ödenmez ve zayi raporda ve Z\'de ayrı görünür'}
              </p>
            </div>
          )}

          {method?.kind === 'nakit' && (
            <div>
              <div className="mb-2 flex items-center justify-between text-[13px] font-medium text-muted">
                <span>Verilen</span>
                {change != null && change >= 0 && <span className="tabular text-sm font-semibold text-[var(--admin-success)]">Para üstü {tl(change)}</span>}
                {change != null && change < 0 && <span className="tabular text-sm font-semibold text-[var(--admin-danger-ink)]">Eksik {tl(-change)}</span>}
              </div>
              <button
                onClick={() => setFocus('verilen')}
                className={cn('tabular w-full rounded-xl border px-4 py-2.5 text-right text-2xl font-semibold transition', focus === 'verilen' ? 'border-primary ring-4 ring-[var(--admin-primary-soft)]' : 'border-line')}
              >
                {givenText || '—'} ₺
              </button>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <QuickButton onClick={() => setGivenText(toInput(amount + tip))}>Tam</QuickButton>
                {suggestCash(amount + tip, boot.settings.quickCash).map((c) => (
                    <QuickButton key={c} onClick={() => setGivenText(toInput(c))}>
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
                className={cn('min-h-11 px-3 font-medium pointer-fine:min-h-9', choice(focus === 'bahsis'))}
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

          <Button variant="primary" size="xl" block disabled={!valid} loading={busy} onClick={pay}>
            {splitBlocks ? 'Hesap bölünmüş: payları Paylaş\'tan alın' : method ? `${tl(amount)} ${method.name} al` : 'Ödeme türü seçin'}
          </Button>

          <OkcPanel order={order} amount={amount} items={mode === 'kalem' ? picked : null} onCompleted={(closed) => onDone(closed)} />

          {comp && (
            <ReasonModal
              open
              title={COMP_CLOSE_LABEL[comp]}
              subtitle={compCloseSubtitle(comp, tl(order.total))}
              reasons={compReasonsOf(boot.settings, comp)}
              confirmLabel={COMP_CONFIRM_LABEL[comp]}
              onClose={() => setComp(null)}
              onConfirm={(reason) => void closeComp(reason)}
            />
          )}

          {order.payments.length > 0 && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-muted">Alınan ödemeler</div>
              <ul className="divide-y divide-[var(--admin-divider)] rounded-xl border border-line">
                {order.payments.map((p) => (
                  <li key={p.id} className={cn('flex items-center gap-2 px-3 py-2 text-sm', !!p.refundedAt && 'text-muted line-through')}>
                    <span className="min-w-0 flex-1">
                      {p.methodName}
                      {p.shareNo != null && <span className="tabular ml-1.5 rounded-md bg-surface-3 px-1.5 py-0.5 text-xs font-medium text-ink-2">Pay {p.shareNo}/{p.shareOf}</span>}{' '}
                      <span className="text-xs text-muted">
                        {fmtTime(p.createdAt)}
                        {p.userName && ` · ${p.userName}`}
                      </span>
                    </span>
                    <span className="tabular font-semibold">{tl(p.amount)}</span>
                    {!p.refundedAt && (can('odeme.iade') || can('odeme.al')) && (
                      <button aria-label="Ödemeyi iptal et" title="Ödemeyi iptal et" onClick={() => refund(p.id)} className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-[var(--admin-danger-ink)] pointer-coarse:size-11">
                        <RotateCcw className="size-4" />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/**
 * Paylaşımlı hesap: kişi sayısı seçilip hesap bölünür. Her pay ayrı ödenir (nakit, kart, yazarkasa); ödenen pay
 * yeşil, sıradaki seçili. Bölündükten sonra eklenen kalem ya da iptal edilen pay kalanlara kendiliğinden dağılır.
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
  busy: boolean;
  freeNos: number[];
  paidShares: OrderDTO['payments'];
  onSplit: (n: number | null) => void;
  onPrint: (no: number, amount: number) => void;
}) {
  const split = order.split;
  const minPeople = Math.max(2, paidShares.length + 1);
  const stepper = (
    <div className="flex items-center gap-1">
      <button aria-label="Kişi azalt" className="grid size-11 place-items-center rounded-lg bg-surface-3 disabled:opacity-40" disabled={people <= minPeople} onClick={() => setPeople(Math.max(minPeople, people - 1))}>
        <Minus className="size-4" />
      </button>
      <span className="tabular w-10 text-center text-xl font-semibold">{people}</span>
      <button aria-label="Kişi artır" className="grid size-11 place-items-center rounded-lg bg-surface-3 disabled:opacity-40" disabled={people >= 30} onClick={() => setPeople(Math.min(30, people + 1))}>
        <Plus className="size-4" />
      </button>
    </div>
  );

  if (!split) {
    return (
      <div className="mb-3 rounded-xl border border-line p-4">
        <div className="flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2 text-sm font-medium">
            <Users className="size-4 text-muted" /> Kaç kişi ödeyecek?
          </span>
          {stepper}
        </div>
        <p className="tabular mt-3 text-[13px] text-muted">
          Kişi başı yaklaşık <b className="text-ink">{tl(Math.ceil((order.total - order.paid) / people))}</b>; kuruş artığı ilk paylara eklenir
        </p>
        <Button variant="primary" block className="mt-3" loading={busy} onClick={() => onSplit(people)}>
          Hesabı {people} kişiye böl
        </Button>
      </div>
    );
  }

  const changed = people !== split.people;
  return (
    <div className="mb-3 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-semibold">{split.people} kişi</span>
          <span className="text-muted"> · {split.paid} pay ödendi</span>
        </div>
        <div className="flex items-center gap-2">
          {stepper}
          {changed && (
            <Button size="sm" variant="primary" loading={busy} onClick={() => onSplit(people)}>
              Uygula
            </Button>
          )}
          <button aria-label="Paylaşımı kaldır" title="Paylaşımı kaldır" onClick={() => onSplit(null)} className="grid size-11 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink">
            <X className="size-4" />
          </button>
        </div>
      </div>
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {paidShares.map((p) => (
          <li key={p.id} className="rounded-xl border border-success-200 bg-[var(--admin-success-soft)] px-3 py-2.5 dark:border-transparent">
            <div className="flex items-center justify-between text-xs font-medium text-[var(--admin-success)]">
              <span className="tabular">Pay {p.shareNo}</span>
              <Check className="size-4" />
            </div>
            <div className="tabular mt-0.5 text-lg font-bold">{tlShort(p.amount)}</div>
            <div className="truncate text-xs text-ink-2">{p.methodName}</div>
          </li>
        ))}
        {split.shares.map((amount, i) => {
          const no = freeNos[i] ?? i + 1;
          const next = i === 0;
          return (
            <li key={`pay-${no}`} className={cn('relative rounded-xl border px-3 py-2.5', next ? 'border-primary bg-[var(--admin-primary-soft)] ring-4 ring-[var(--admin-primary-soft)]' : 'border-line bg-surface')}>
              <div className={cn('text-xs font-medium', next ? 'text-primary' : 'text-muted')}>{next ? `Pay ${no} · sıradaki` : `Pay ${no}`}</div>
              <div className="tabular mt-0.5 text-lg font-bold">{tlShort(amount)}</div>
              <button aria-label={`Pay ${no} fişini yazdır`} title="Pay fişini yazdır" onClick={() => onPrint(no, amount)} className="absolute right-0.5 top-0.5 grid size-11 place-items-center rounded-lg text-muted hover:text-ink">
                <Printer className="size-4" />
              </button>
            </li>
          );
        })}
      </ul>
      {split.shares.length === 0 && order.total - order.paid > 0 && (
        <p className="rounded-xl bg-[var(--admin-warning-soft)] px-3 py-2 text-[13px] text-[var(--admin-warning)]">
          Bütün paylar ödendi ama {tl(order.total - order.paid)} kaldı (sonradan eklenen kalem). Kişi ekleyin ya da "Tutar" ile alın
        </p>
      )}
    </div>
  );
}

function QuickButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="tabular min-h-11 rounded-lg border border-[var(--admin-border-strong)] bg-surface px-3 text-sm font-semibold transition-colors hover:border-[var(--admin-border-field)] hover:bg-surface-2 pointer-fine:min-h-9">
      {children}
    </button>
  );
}
