import { Check, ChefHat, CircleDot, Gift, Minus, Pencil, Percent, Plus, ReceiptText, Trash2, Undo2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { isCounterFirst, serviceModeOf } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { OrderDTO, OrderItemDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { estimateUnit, pendingOptionsText, useBoot } from '@/lib/boot';
import { type PendingLine, useCart } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { previewTotals } from '@/lib/estimate';
import { parseTL } from '@shared/money';

// Kalemin bardaki durumu: yalnız anlam taşıyan renk (hazırlanıyor amber, hazır yeşil)
const STATUS: Record<OrderItemDTO['status'], { label: string; cls: string }> = {
  yeni: { label: 'Bara gitti', cls: 'text-muted' },
  hazirlaniyor: { label: 'Hazırlanıyor', cls: 'text-[var(--admin-warning)]' },
  hazir: { label: 'Hazır', cls: 'text-[var(--admin-success)]' },
  servis: { label: 'Serviste', cls: 'text-muted' },
};

export function CartPanel({
  order,
  pending,
  onEditPending,
  act,
}: {
  order: OrderDTO;
  pending: PendingLine[];
  onEditPending: (line: PendingLine) => void;
  act: <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const boot = useBoot();
  const cart = useCart();
  // Self ve yarı self servis: tezgâh satışında önce ödeme
  const payFirst = isCounterFirst(serviceModeOf(boot.settings)) && order.type === 'tezgah' && order.source === 'pos';
  const [itemSheet, setItemSheet] = useState<OrderItemDTO | null>(null);
  const t = order.totals;
  const due = order.total - order.paid;

  const preview = previewTotals(boot, order, pending);

  const visibleItems = order.items.filter((i) => !i.voided || i.voidAfterSend || Date.now() - (i.createdAt ?? 0) < 3600_000);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {visibleItems.length === 0 && pending.length === 0 && (
          <div className="flex flex-col items-center px-6 py-14 text-center">
            <span aria-hidden="true" className="grid size-12 place-items-center rounded-2xl bg-surface-3 text-muted">
              <ReceiptText className="size-6" strokeWidth={1.5} />
            </span>
            <p className="mt-3 text-sm font-semibold text-ink">Adisyon boş</p>
            <p className="mt-1 max-w-[30ch] text-[13px] text-muted">
              {payFirst ? 'Ürüne dokunun; "Öde" ödemeyi alır ve siparişi bara gönderir' : 'Ürüne dokunun; "Gönder"e basınca bara ve mutfağa gider'}
            </p>
          </div>
        )}
        <ul className="divide-y divide-[var(--admin-divider)]">
          {visibleItems.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => !i.voided && !order.extPaid && order.status === 'acik' && setItemSheet(i)}
                className={cn('flex min-h-12 w-full items-start gap-3 px-4 py-2.5 text-left', !i.voided && order.status === 'acik' && 'hover:bg-surface-2')}
              >
                <span className={cn('tabular mt-px min-w-7 rounded-md px-1.5 py-0.5 text-center text-[13px] font-semibold', i.voided ? 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]' : 'bg-surface-3 text-ink')}>
                  {i.qty}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium leading-snug', i.voided && 'text-muted line-through')}>
                    {i.name}
                    {i.size !== 'TEK' && <span className="ml-1 text-sm font-normal text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                  </span>
                  {i.optionsText && <span className="block text-xs text-ink-2">{i.optionsText}</span>}
                  {i.note && <span className="block text-xs italic text-[var(--admin-warning)]">"{i.note}"</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] font-medium">
                    {i.voided ? (
                      <span className="text-[var(--admin-danger-ink)]">İptal: {i.voidReason}</span>
                    ) : (
                      <>
                        {i.stationId && (
                          <span className={cn('inline-flex items-center gap-0.5', STATUS[i.status].cls)}>
                            {i.status === 'hazir' ? <Check className="size-3" /> : i.status === 'servis' ? <CircleDot className="size-3" /> : <ChefHat className="size-3" />}
                            {STATUS[i.status].label}
                          </span>
                        )}
                        <span className="tabular font-normal text-muted">{fmtTime(i.sentAt)}</span>
                        {i.complimentary && (
                          <span className="inline-flex items-center gap-0.5 text-[var(--admin-hue-rose)]">
                            <Gift className="size-3" />
                            {i.compKind === 'odenmez' ? 'Ödenmez' : 'İkram'}
                          </span>
                        )}
                        {i.discount > 0 && <span className="tabular text-primary">−{tl(i.discount)}</span>}
                        {i.happyHour && <span className="text-[var(--admin-warning)]">Happy hour</span>}
                        {i.paidQty > 0 && <span className="text-[var(--admin-success)]">{i.paidQty === i.qty ? 'Ödendi' : `${i.paidQty} ödendi`}</span>}
                      </>
                    )}
                  </span>
                </span>
                <span className={cn('tabular whitespace-nowrap text-right text-sm font-semibold', (i.voided || i.complimentary) && 'text-muted line-through')}>{tl(i.qty * i.unitPrice)}</span>
              </button>
            </li>
          ))}
        </ul>

        {pending.length > 0 && (
          <div className="border-y border-warn-200 bg-warn-50 dark:border-warn-800 dark:bg-[var(--admin-warning-soft)]">
            <div className="flex items-center gap-1.5 px-4 pt-2.5 text-xs font-medium text-[var(--admin-warning)]">
              <span className="size-1.5 rounded-full bg-current" />
              Gönderilmedi
            </div>
            <ul>
              {pending.map((l) => {
                const p = boot.products.find((x) => x.id === l.productId);
                if (!p) return null;
                const unit = l.priceOverride ?? estimateUnit(boot, p, l.size, l.options);
                const text = [pendingOptionsText(boot, p, l.options), l.priceOverride != null ? 'elle fiyat' : ''].filter(Boolean).join(' · ');
                return (
                  <li key={l.key} className="flex items-center gap-2 px-3 py-2">
                    <div className="flex items-center rounded-lg border border-[var(--admin-border-strong)] bg-surface">
                      <button aria-label="Azalt" className="grid size-9 place-items-center rounded-l-lg hover:bg-surface-2 pointer-coarse:size-11" onClick={() => (l.qty > 1 ? cart.update(order.id, l.key, { qty: l.qty - 1 }) : cart.remove(order.id, l.key))}>
                        {l.qty > 1 ? <Minus className="size-4" /> : <Trash2 className="size-4 text-[var(--admin-danger-ink)]" />}
                      </button>
                      <span className="tabular w-6 text-center text-sm font-semibold">{l.qty}</span>
                      <button aria-label="Artır" className="grid size-9 place-items-center rounded-r-lg hover:bg-surface-2 pointer-coarse:size-11" onClick={() => cart.update(order.id, l.key, { qty: Math.min(99, l.qty + 1) })}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                    <button className="min-w-0 flex-1 text-left" onClick={() => onEditPending(l)}>
                      <span className="block truncate text-sm font-medium">
                        {p.shortName || p.name}
                        {l.size !== 'TEK' && <span className="ml-1 text-sm font-normal text-muted">{boot.settings.sizeLabels[l.size]}</span>}
                      </span>
                      {(text || l.note) && <span className="block truncate text-xs text-ink-2">{[text, l.note && `"${l.note}"`].filter(Boolean).join(' · ')}</span>}
                    </button>
                    <span className="tabular text-right text-sm font-semibold">{tl(unit * l.qty)}</span>
                    <button aria-label="Düzenle" className="grid size-9 place-items-center rounded-lg text-muted hover:bg-surface-3 hover:text-ink pointer-coarse:size-11" onClick={() => onEditPending(l)}>
                      <Pencil className="size-4" />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>

      <div className="border-t border-[var(--admin-divider)] px-4 py-3 text-sm">
        {(t.lineDiscounts + t.orderDiscount > 0 || t.complimentary > 0 || t.service > 0) && (
          <div className="mb-1.5 space-y-0.5 text-[13px] text-muted">
            <Row l="Ara toplam" r={tl(t.gross)} />
            {t.lineDiscounts + t.orderDiscount > 0 && <Row l={`İndirim${order.discountReason ? ` (${order.discountReason})` : ''}`} r={`−${tl(t.lineDiscounts + t.orderDiscount)}`} />}
            {t.complimentary > 0 && <Row l="İkram" r={tl(t.complimentary)} />}
            {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tl(t.service)} />}
          </div>
        )}
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-muted">Toplam</span>
          <span className="tabular text-2xl font-bold tracking-tight">{tl(preview ? preview.total : order.extPaid ? (order.extTotal ?? 0) : order.total)}</span>
        </div>
        {order.paid > 0 && !order.extPaid && (
          <div className="mt-1 space-y-0.5 text-[13px]">
            <Row l="Ödenen" r={tl(order.paid)} />
            <Row l={<b>Kalan</b>} r={<b>{tl(due)}</b>} />
          </div>
        )}
        {preview && <div className="mt-1 text-xs text-[var(--admin-warning)]">Gönderilmemiş {pending.reduce((a, l) => a + l.qty, 0)} ürün dahil, tahmini</div>}
      </div>

      <ItemSheet item={itemSheet} order={order} onClose={() => setItemSheet(null)} act={act} />
    </div>
  );
}

const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => (
  <div className="flex justify-between">
    <span>{l}</span>
    <span className="tabular">{r}</span>
  </div>
);

/** Gönderilmiş kaleme dokununca: iptal, ikram, indirim. */
function ItemSheet({
  item,
  order,
  onClose,
  act,
}: {
  item: OrderItemDTO | null;
  order: OrderDTO;
  onClose: () => void;
  act: <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const boot = useBoot();
  const can = useCan();
  const [mode, setMode] = useState<null | 'iptal' | 'ikram' | 'indirim'>(null);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [discType, setDiscType] = useState<'percent' | 'amount'>('percent');
  const [discValue, setDiscValue] = useState('');

  if (!item) return null;
  const unpaid = item.qty - item.paidQty;
  const close = () => {
    setMode(null);
    setReason('');
    setDiscValue('');
    setQty(1);
    onClose();
  };
  const reasons = mode === 'iptal' ? boot.settings.voidReasons : mode === 'ikram' ? boot.settings.compReasons : boot.settings.discountReasons;

  const submit = async () => {
    const base = `/orders/${order.id}/items/${item.id}`;
    let res: unknown = null;
    if (mode === 'iptal') res = await act((pin) => post(`${base}/void`, { qty, reason, approverPin: pin }), 'Kalem iptal edildi');
    if (mode === 'ikram') res = await act((pin) => post(`${base}/comp`, { qty, reason, approverPin: pin }), 'İkram edildi');
    if (mode === 'indirim') {
      const value = discType === 'percent' ? Number(discValue.replace(',', '.')) : (parseTL(discValue) ?? 0);
      res = await act((pin) => post(`${base}/discount`, { type: discType, value, reason, approverPin: pin }), value > 0 ? 'İndirim uygulandı' : 'İndirim kaldırıldı');
    }
    if (res) close();
  };

  return (
    <Modal
      open
      onClose={close}
      size="sm"
      title={`${item.qty}× ${item.name}${item.size !== 'TEK' ? ` ${boot.settings.sizeLabels[item.size]}` : ''}`}
      subtitle={[item.optionsText, tl(item.qty * item.unitPrice)].filter(Boolean).join(' · ')}
    >
      {!mode ? (
        <div className="grid gap-2 p-4">
          <SheetButton icon={<XCircle className="size-[18px] text-[var(--admin-danger-ink)]" strokeWidth={1.75} />} title="İptal et" hint={can('siparis.iptal') ? 'Gerekçe ile' : 'Hazırlanmaya başladıysa yetkili onayı ister'} onClick={() => setMode('iptal')} disabled={unpaid < 1} />
          {item.complimentary ? (
            <SheetButton icon={<Undo2 className="size-[18px] text-[var(--admin-hue-rose)]" strokeWidth={1.75} />} title="İkramı geri al" onClick={async () => (await act((pin) => post(`/orders/${order.id}/items/${item.id}/comp`, { undo: true, reason: '', approverPin: pin }), 'İkram geri alındı')) && close()} />
          ) : (
            <SheetButton icon={<Gift className="size-[18px] text-[var(--admin-hue-rose)]" strokeWidth={1.75} />} title="İkram et" hint="Ücret alınmaz, ikram raporuna girer" onClick={() => setMode('ikram')} disabled={unpaid < 1} />
          )}
          <SheetButton icon={<Percent className="size-[18px] text-primary" strokeWidth={1.75} />} title={item.discount > 0 ? `İndirimi değiştir (${tl(item.discount)})` : 'Kaleme indirim'} onClick={() => setMode('indirim')} disabled={item.complimentary || item.paidQty > 0} />
          {item.paidQty > 0 && <p className="px-1 text-xs text-muted">{item.paidQty} adedin ödemesi alındı; bu adetler değiştirilemez</p>}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {mode !== 'indirim' && unpaid > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-line p-1.5 pl-4">
              <span className="text-sm font-medium">Adet</span>
              <div className="flex items-center gap-1">
                <button aria-label="Azalt" className="grid size-11 place-items-center rounded-lg bg-surface-3" onClick={() => setQty(Math.max(1, qty - 1))}>
                  <Minus className="size-4" />
                </button>
                <span className="tabular w-10 text-center text-lg font-semibold">{qty}</span>
                <button aria-label="Artır" className="grid size-11 place-items-center rounded-lg bg-surface-3" onClick={() => setQty(Math.min(unpaid, qty + 1))}>
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
          )}
          {mode === 'indirim' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {(['percent', 'amount'] as const).map((k) => (
                  <button key={k} onClick={() => setDiscType(k)} className={cn('min-h-11 rounded-lg border text-sm font-medium transition-colors', discType === k ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line hover:border-[var(--admin-border-field)]')}>
                    {k === 'percent' ? 'Yüzde (%)' : 'Tutar (₺)'}
                  </button>
                ))}
              </div>
              <div className="tabular rounded-xl border border-line bg-surface-2 px-4 py-3 text-right text-3xl font-semibold">
                {discValue || '0'} {discType === 'percent' ? '%' : '₺'}
              </div>
              <Numpad size="md" decimal={discType === 'amount'} onKey={(k) => setDiscValue(applyNumpadKey(discValue, k, { decimal: discType === 'amount', maxLength: discType === 'percent' ? 3 : 8 }))} />
            </div>
          )}
          <div>
            <div className="mb-2 text-sm font-medium text-ink-2">Neden</div>
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <button key={r} onClick={() => setReason(r)} className={cn('min-h-11 rounded-lg border bg-surface px-3 text-sm transition-colors pointer-fine:min-h-9', reason === r ? 'border-ink font-semibold text-ink' : 'border-line text-ink-2 hover:border-[var(--admin-border-field)]')}>
                  {r}
                </button>
              ))}
            </div>
            <input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} placeholder="ya da yazın" className="mt-2 h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 outline-none focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)]" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setMode(null)}>Geri</Button>
            <Button variant={mode === 'iptal' ? 'danger' : 'primary'} disabled={!reason.trim() && !(mode === 'indirim' && (discValue === '' || discValue === '0'))} onClick={submit}>
              {mode === 'iptal' ? `${qty} adet iptal` : mode === 'ikram' ? `${qty} adet ikram` : 'Uygula'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SheetButton({ icon, title, hint, onClick, disabled }: { icon: React.ReactNode; title: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className="flex min-h-14 items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-colors hover:border-[var(--admin-border-field)] hover:bg-surface-2 disabled:opacity-40">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}
