import { CheckCircle2, Minus, Plus, Printer, RotateCcw, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parseTL, splitEven, tl, tlCompact } from '@shared/money';
import { amountForItems } from '@shared/order-calc';
import { fmtTime } from '@shared/time';
import type { OrderDTO, PaymentMethodDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { BillReceipt, printNow } from '@/lib/print';
import { OkcPanel } from './OkcPanel';

type Mode = 'tutar' | 'kalem' | 'kisi';

const toInput = (k: number) => (k % 100 === 0 ? String(k / 100) : (k / 100).toFixed(2).replace('.', ','));

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
  const remaining = order.total - order.paid;
  const [mode, setMode] = useState<Mode>('tutar');
  const [amountText, setAmountText] = useState('');
  const [method, setMethod] = useState<PaymentMethodDTO | null>(null);
  const [givenText, setGivenText] = useState('');
  const [tipText, setTipText] = useState('');
  const [focus, setFocus] = useState<'tutar' | 'verilen' | 'bahsis'>('tutar');
  const [selection, setSelection] = useState<Record<string, number>>({});
  const [people, setPeople] = useState(2);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ change: number; closed: boolean; amount: number; method: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('tutar');
    setAmountText(toInput(Math.max(0, remaining)));
    setMethod(null);
    setGivenText('');
    setTipText('');
    setFocus('tutar');
    setSelection({});
    setResult(null);
    // Yalnız pencere açılınca sıfırla
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const unpaidItems = order.items.filter((i) => !i.voided && !i.complimentary && i.qty - i.paidQty > 0 && (order.totals.lineNet[i.id] ?? 0) > 0);
  const itemsAmount = useMemo(
    () =>
      amountForItems(
        order.totals,
        order.items.map((i) => ({ id: i.id, qty: i.qty, paidQty: i.paidQty })),
        Object.entries(selection).map(([lineId, qty]) => ({ lineId, qty })),
      ),
    [order, selection],
  );
  const share = splitEven(Math.max(0, remaining), Math.max(1, people))[0] ?? 0;
  const amount = Math.min(remaining, mode === 'kalem' ? itemsAmount : mode === 'kisi' ? share : (parseTL(amountText) ?? 0));
  const tip = parseTL(tipText) ?? 0;
  const given = parseTL(givenText);
  const change = method?.kind === 'nakit' && given != null ? given - amount - tip : null;
  const cariBlocked = method?.kind === 'cari' && !order.customer;
  const valid = !!method && amount > 0 && (change == null || change >= 0) && !cariBlocked;

  const keyTarget = focus === 'verilen' ? [givenText, setGivenText] : focus === 'bahsis' ? [tipText, setTipText] : [amountText, setAmountText];
  const pressKey = (k: string) => {
    if (mode !== 'tutar' && focus === 'tutar') return;
    const [val, set] = keyTarget as [string, (v: string) => void];
    set(applyNumpadKey(val, k, { decimal: true, maxLength: 9 }));
  };

  const pay = async () => {
    if (!method || !valid) return;
    setBusy(true);
    const res = await act((pin) =>
      post<{ order: OrderDTO; closed: boolean; change: number }>(`/orders/${order.id}/payments`, {
        methodId: method.id,
        amount,
        tip,
        given: method.kind === 'nakit' && given != null ? given : null,
        items: mode === 'kalem' ? Object.entries(selection).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty })) : null,
        approverPin: pin,
      }),
    );
    setBusy(false);
    if (!res) return;
    if (res.closed || method.kind === 'nakit') setResult({ change: res.change, closed: res.closed, amount, method: method.name });
    else {
      // Parçalı ödeme sürüyor: kalan tutara dön
      setAmountText(toInput(res.order.total - res.order.paid));
      setSelection({});
      setGivenText('');
      setTipText('');
      setMethod(null);
    }
  };

  const refund = async (paymentId: string) => {
    const reason = window.prompt('Ödeme iptalinin nedeni');
    if (!reason?.trim()) return;
    await act((pin) => post(`/orders/${order.id}/payments/${paymentId}/refund`, { reason, approverPin: pin }), 'Ödeme iptal edildi');
  };

  if (!open) return null;

  if (result) {
    return (
      <Modal open onClose={() => onDone(result.closed)} size="sm" persistent>
        <div className="p-6 text-center">
          <CheckCircle2 className="mx-auto size-14 text-forest-500" />
          <h2 className="mt-3 text-xl font-semibold">{result.closed ? 'Adisyon kapandı' : 'Ödeme alındı'}</h2>
          <p className="mt-1 text-muted">
            {tl(result.amount)} · {result.method}
          </p>
          {result.change > 0 && (
            <div className="mt-5 rounded-3xl bg-brass-100 p-5 text-espresso">
              <div className="text-sm font-medium">Para üstü</div>
              <div className="tabular text-5xl font-semibold">{tl(result.change)}</div>
            </div>
          )}
          <div className="mt-6 grid gap-2">
            <Button variant="primary" size="lg" onClick={() => onDone(result.closed)}>
              {result.closed ? 'Tamam' : 'Kalanı al'}
            </Button>
            <Button icon={<Printer className="size-4" />} onClick={() => printNow(<BillReceipt order={order} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} />)}>
              Fiş yazdır
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal open onClose={onClose} size="xl" title={`Ödeme · ${order.tableName ?? `#${order.no}`}`} subtitle={`Toplam ${tl(order.total)}${order.paid ? ` · ödenen ${tl(order.paid)}` : ''}`}>
      <div className="grid gap-0 lg:grid-cols-[1.1fr_1fr]">
        <div className="border-b border-line p-5 lg:border-b-0 lg:border-r">
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
                { value: 'kisi', label: 'Kişi başı' },
              ]}
            />
            <div className="text-right">
              <div className="text-xs text-muted">Kalan</div>
              <div className="tabular text-xl font-semibold">{tl(remaining)}</div>
            </div>
          </div>

          {mode === 'tutar' && (
            <button onClick={() => setFocus('tutar')} className={cn('tabular mb-3 w-full rounded-2xl border-2 px-4 py-3 text-right text-4xl font-semibold', focus === 'tutar' ? 'border-forest-600' : 'border-line')}>
              {amountText || '0'} ₺
            </button>
          )}
          {mode === 'kalem' && (
            <div className="scroll-thin mb-3 max-h-72 space-y-1 overflow-y-auto">
              {unpaidItems.map((i) => {
                const left = i.qty - i.paidQty;
                const sel = selection[i.id] ?? 0;
                return (
                  <div key={i.id} className={cn('flex items-center gap-2 rounded-xl border px-3 py-2', sel ? 'border-forest-600 bg-forest-50 dark:bg-forest-800' : 'border-line')}>
                    <button className="min-w-0 flex-1 text-left" onClick={() => setSelection({ ...selection, [i.id]: sel === left ? 0 : left })}>
                      <span className="block truncate font-medium">
                        {i.name} {i.size !== 'TEK' && <span className="text-sm text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                      </span>
                      <span className="text-xs text-muted">
                        {left} adet · {tl(order.totals.lineNet[i.id] ?? 0)}
                      </span>
                    </button>
                    <div className="flex items-center gap-1">
                      <button aria-label="Azalt" className="grid size-9 place-items-center rounded-lg bg-surface-2" onClick={() => setSelection({ ...selection, [i.id]: Math.max(0, sel - 1) })}>
                        <Minus className="size-4" />
                      </button>
                      <span className="tabular w-6 text-center font-semibold">{sel}</span>
                      <button aria-label="Artır" className="grid size-9 place-items-center rounded-lg bg-surface-2" onClick={() => setSelection({ ...selection, [i.id]: Math.min(left, sel + 1) })}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="flex justify-between px-1 pt-2 font-semibold">
                <span>Seçilen</span>
                <span className="tabular">{tl(itemsAmount)}</span>
              </div>
            </div>
          )}
          {mode === 'kisi' && (
            <div className="mb-3 rounded-2xl border border-line p-4">
              <div className="flex items-center justify-between">
                <span className="inline-flex items-center gap-2 font-medium">
                  <Users className="size-4" /> Kişi sayısı
                </span>
                <div className="flex items-center gap-1">
                  <button aria-label="Azalt" className="grid size-10 place-items-center rounded-xl bg-surface-2" onClick={() => setPeople(Math.max(1, people - 1))}>
                    <Minus className="size-4" />
                  </button>
                  <span className="tabular w-10 text-center text-xl font-semibold">{people}</span>
                  <button aria-label="Artır" className="grid size-10 place-items-center rounded-xl bg-surface-2" onClick={() => setPeople(Math.min(30, people + 1))}>
                    <Plus className="size-4" />
                  </button>
                </div>
              </div>
              <div className="mt-3 flex items-baseline justify-between">
                <span className="text-sm text-muted">Bu kişinin payı</span>
                <span className="tabular text-3xl font-semibold">{tl(share)}</span>
              </div>
              <p className="mt-1 text-xs text-muted">Her ödemeden sonra kalan tutar kalan kişilere yeniden bölünür</p>
            </div>
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
            <div className="mb-2 text-sm font-medium text-ink-2">Ödeme türü</div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {boot.paymentMethods.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setMethod(m);
                    if (m.kind === 'nakit') setFocus('verilen');
                    else if (focus === 'verilen') setFocus('tutar');
                  }}
                  className={cn(
                    'h-14 rounded-2xl border-2 px-3 text-left text-sm font-semibold transition',
                    method?.id === m.id ? 'border-transparent text-white shadow-[var(--shadow-card)]' : 'border-line bg-surface text-ink hover:bg-surface-2',
                  )}
                  style={method?.id === m.id ? { background: m.color } : undefined}
                >
                  {m.name}
                </button>
              ))}
            </div>
            {cariBlocked && <p className="mt-2 text-sm text-burgundy-500">Açık hesap için önce adisyona müşteri ekleyin (İşlemler › Müşteri)</p>}
          </div>

          {method?.kind === 'nakit' && (
            <div>
              <div className="mb-2 flex items-center justify-between text-sm font-medium text-ink-2">
                <span>Verilen</span>
                {change != null && change >= 0 && <span className="tabular text-base text-forest-600">Para üstü {tl(change)}</span>}
                {change != null && change < 0 && <span className="text-base text-burgundy-500">Eksik {tl(-change)}</span>}
              </div>
              <button onClick={() => setFocus('verilen')} className={cn('tabular w-full rounded-2xl border-2 px-4 py-2.5 text-right text-2xl font-semibold', focus === 'verilen' ? 'border-forest-600' : 'border-line')}>
                {givenText || '—'} ₺
              </button>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <QuickButton onClick={() => setGivenText(toInput(amount + tip))}>Tam</QuickButton>
                {boot.settings.quickCash.filter((c) => c >= amount + tip).slice(0, 4).map((c) => (
                  <QuickButton key={c} onClick={() => setGivenText(toInput(c))}>
                    {tlCompact(c)} ₺
                  </QuickButton>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between text-sm">
            <button onClick={() => setFocus(focus === 'bahsis' ? 'tutar' : 'bahsis')} className={cn('rounded-xl border px-3 py-1.5', focus === 'bahsis' ? 'border-forest-600 text-forest-600' : 'border-line text-ink-2')}>
              Bahşiş {tip > 0 ? tl(tip) : 'ekle'}
            </button>
            <span className="text-muted">Bahşiş ciroya girmez, ayrı raporlanır</span>
          </div>

          <Button variant="primary" size="xl" block disabled={!valid} loading={busy} onClick={pay}>
            {method ? `${tl(amount)} ${method.name} al` : 'Ödeme türü seçin'}
          </Button>

          <OkcPanel order={order} amount={amount} items={mode === 'kalem' ? Object.entries(selection).filter(([, q]) => q > 0).map(([itemId, qty]) => ({ itemId, qty })) : null} onCompleted={(closed) => onDone(closed)} />

          {order.payments.length > 0 && (
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink-2">Alınan ödemeler</div>
              <ul className="divide-y divide-line rounded-2xl border border-line">
                {order.payments.map((p) => (
                  <li key={p.id} className={cn('flex items-center gap-2 px-3 py-2 text-sm', !!p.refundedAt && 'text-muted line-through')}>
                    <span className="flex-1">
                      {p.methodName} <span className="text-xs text-muted">{fmtTime(p.createdAt)} · {p.userName}</span>
                    </span>
                    <span className="tabular font-semibold">{tl(p.amount)}</span>
                    {!p.refundedAt && (can('odeme.iade') || can('odeme.al')) && (
                      <button aria-label="Ödemeyi iptal et" title="Ödemeyi iptal et" onClick={() => refund(p.id)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-burgundy-500">
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

function QuickButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className="rounded-xl border border-line bg-surface px-3 py-2 text-sm font-semibold hover:bg-surface-2">
      {children}
    </button>
  );
}
