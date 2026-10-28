import { Check, ChefHat, CircleDot, Droplets, Gift, Minus, Pencil, Percent, Plus, ReceiptText, Trash2, Undo2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COMP_LABEL, compReasonsOf } from '@shared/comp';
import { tl } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { isCounterFirst, serviceModeOf } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { OrderDTO, OrderItemDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { estimateUnit, pendingOptionsText, useBoot } from '@/lib/boot';
import { type PendingLine, useCart } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/hooks';
import { previewTotals } from '@/lib/estimate';
import { parseTL } from '@shared/money';
import { groupTyped, TypedAmount } from './TypedAmount';

// Kalemin bardaki durumu, bar ekranıyla aynı dil: hazırlanıyor mavi, hazır yeşil (amber yalnız zamana); ikon ve yazı da var
const STATUS: Record<OrderItemDTO['status'], { label: string; cls: string }> = {
  yeni: { label: 'Bara gitti', cls: 'text-muted' },
  hazirlaniyor: { label: 'Hazırlanıyor', cls: 'text-primary' },
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
  // Boş adisyon yönergesi ekranın yerleşimine göre: geniş ekranda ürünler solda, telefonda Menü sekmesinde
  const wide = useMediaQuery('(min-width: 768px)');

  const visibleItems = order.items.filter((i) => !i.voided || i.voidAfterSend || Date.now() - (i.createdAt ?? 0) < 3600_000);

  // Yeni eklenen kalem uzun adisyonda da görünsün: gönderilmemişler bloğu görünür alana kayar
  const pendingRef = useRef<HTMLDivElement>(null);
  const pendingQty = pending.reduce((a, l) => a + l.qty, 0);
  useEffect(() => {
    if (!pending.length) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    pendingRef.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
  }, [pending.length, pendingQty]);

  // Ödeme sürerken büyük rakam kalan tutar; kapanmış ya da ödenmemiş adisyonda toplam
  const partlyPaid = order.paid > 0 && !order.extPaid && due > 0 && !preview;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin flex min-h-0 flex-1 flex-col overflow-y-auto">
        {visibleItems.length === 0 && pending.length === 0 && (
          <div className="my-auto flex flex-col items-center px-6 py-10 text-center">
            <span aria-hidden="true" className="grid size-11 place-items-center rounded-xl bg-surface-3 text-muted">
              <ReceiptText className="size-5" />
            </span>
            <p className="mt-3 text-[15px] font-semibold text-ink">Adisyon boş</p>
            <p className="mt-1 max-w-[32ch] text-[13px] text-pretty text-muted">
              {wide ? 'Soldan ürün seçin. ' : 'Menü sekmesinden ürün seçin. '}
              {payFirst ? 'Ödeme alınınca sipariş bara gider' : 'Gönder’e basınca sipariş bara ve mutfağa gider'}
            </p>
          </div>
        )}
        <ul className="divide-y divide-[var(--admin-divider)]">
          {visibleItems.map((i) => (
            <li key={i.id}>
              <button
                onClick={() => !i.voided && !order.extPaid && order.status === 'acik' && setItemSheet(i)}
                className={cn('flex min-h-12 w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-150', !i.voided && order.status === 'acik' && 'hover:bg-hover active:bg-press')}
              >
                <span className={cn('tabular h-6 min-w-7 rounded-md px-1.5 text-center text-[13px] font-semibold leading-6', i.voided ? 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]' : 'bg-surface-3 text-ink')}>
                  {i.qty}
                </span>
                <span className="min-w-0 flex-1">
                  <span className={cn('block text-sm font-medium leading-snug', i.voided && 'text-muted line-through')}>
                    {i.name}
                    {i.size !== 'TEK' && <SizeTag>{boot.settings.sizeLabels[i.size]}</SizeTag>}
                  </span>
                  {i.optionsText && <span className="block text-xs text-ink-2">{i.optionsText}</span>}
                  {i.note && <span className="block text-xs text-ink-2">Not: {i.note}</span>}
                  <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium">
                    {i.voided ? (
                      <span className="text-[var(--admin-danger-ink)]">İptal: {i.voidReason}</span>
                    ) : (
                      <>
                        {i.stationId && (
                          <span className={cn('inline-flex items-center gap-0.5', STATUS[i.status].cls)}>
                            {i.status === 'hazir' ? <Check className="size-3.5" /> : i.status === 'servis' ? <CircleDot className="size-3.5" /> : <ChefHat className="size-3.5" />}
                            {/* Sitenin listesinden kalkan online sipariş servis edildi sayılmaz */}
                            {order.extStage === 'gone' && i.status === 'servis' ? 'Siteden kalktı' : STATUS[i.status].label}
                          </span>
                        )}
                        <span className="tabular font-normal text-muted">{fmtTime(i.sentAt)}</span>
                        {i.complimentary && (
                          <span className={cn('inline-flex items-center gap-0.5', i.compKind === 'zayi' ? 'text-[var(--admin-warning)]' : 'text-[var(--admin-hue-rose)]')}>
                            {i.compKind === 'zayi' ? <Droplets className="size-3.5" /> : <Gift className="size-3.5" />}
                            {COMP_LABEL[i.compKind ?? 'ikram']}
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
          // Gönderilmemişler: amber zemin ve durum çizgisi (iki temada tek tarif, dark: yaması yok)
          <div ref={pendingRef} className="border-y border-warning-line bg-warning-soft">
            <div className="sticky top-0 z-[1] flex items-center gap-1.5 bg-warning-soft px-4 pb-1 pt-2.5 text-xs font-medium text-warning-ink">
              <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
              Gönderilmedi
            </div>
            <ul className="divide-y divide-warning-line">
              {pending.map((l) => {
                const p = boot.products.find((x) => x.id === l.productId);
                if (!p) return null;
                const unit = l.priceOverride ?? estimateUnit(boot, p, l.size, l.options);
                const text = [pendingOptionsText(boot, p, l.options), l.priceOverride != null ? 'elle fiyat' : ''].filter(Boolean).join(' · ');
                return (
                  <li key={l.key} className="animate-in flex items-center gap-2 px-4 py-2">
                    <div className="flex items-center rounded-lg border border-line-strong bg-surface">
                      <button aria-label={l.qty > 1 ? 'Azalt' : 'Kaldır'} className="grid size-9 place-items-center rounded-l-lg transition-colors duration-150 hover:bg-hover active:bg-press pointer-coarse:size-11" onClick={() => (l.qty > 1 ? cart.update(order.id, l.key, { qty: l.qty - 1 }) : cart.remove(order.id, l.key))}>
                        {l.qty > 1 ? <Minus className="size-4" /> : <Trash2 className="size-4 text-[var(--admin-danger-ink)]" />}
                      </button>
                      <span className="tabular w-6 text-center text-sm font-semibold">{l.qty}</span>
                      <button aria-label="Artır" className="grid size-9 place-items-center rounded-r-lg transition-colors duration-150 hover:bg-hover active:bg-press pointer-coarse:size-11" onClick={() => cart.update(order.id, l.key, { qty: Math.min(99, l.qty + 1) })}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                    {/* Satırın kendisi düzenlemeye açar; kalem ikonu yalnız ipucu */}
                    <button className="flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-lg text-left transition-colors duration-150 active:bg-press" onClick={() => onEditPending(l)} aria-label={`${p.shortName || p.name} düzenle`}>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {p.shortName || p.name}
                          {l.size !== 'TEK' && <SizeTag>{boot.settings.sizeLabels[l.size]}</SizeTag>}
                        </span>
                        {(text || l.note) && <span className="block truncate text-xs text-ink-2">{[text, l.note && `Not: ${l.note}`].filter(Boolean).join(' · ')}</span>}
                      </span>
                      <Pencil aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
                    </button>
                    <span className="tabular text-right text-sm font-semibold">{tl(unit * l.qty)}</span>
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
            {/* Yalnız ikram varsa "İkram"; ödenmez ya da zayi de varsa hepsi birlikte "Ciro dışı" */}
            {t.complimentary > 0 && <Row l={order.items.some((i) => i.complimentary && !i.voided && i.compKind && i.compKind !== 'ikram') ? 'Ciro dışı' : 'İkram'} r={tl(t.complimentary)} />}
            {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tl(t.service)} />}
          </div>
        )}
        {partlyPaid && (
          <div className="mb-1 space-y-0.5 text-[13px] text-muted">
            <Row l="Toplam" r={tl(order.total)} />
            <Row l="Ödenen" r={tl(order.paid)} />
          </div>
        )}
        <div className="flex items-baseline justify-between">
          <span className="text-[13px] font-medium text-muted">{partlyPaid ? 'Kalan' : 'Toplam'}</span>
          <span className="tabular text-2xl font-bold tracking-tight">{tl(partlyPaid ? due : preview ? preview.total : order.extPaid ? (order.extTotal ?? 0) : order.total)}</span>
        </div>
        {order.paid > 0 && !order.extPaid && !partlyPaid && (
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

/** Boy etiketi: ürün adına yapışık düz metin yerine küçük çerçeveli çip; seçenek metniyle karışmaz */
const SizeTag = ({ children }: { children: React.ReactNode }) => (
  <span className="ml-1.5 inline-block rounded border border-line px-1 align-[2px] text-[11px] font-medium leading-4 text-ink-2">{children}</span>
);

const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => (
  <div className="flex justify-between">
    <span>{l}</span>
    <span className="tabular">{r}</span>
  </div>
);

/** Gönderilmiş kaleme dokununca: iptal, ikram, zayi, indirim. */
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
  const [mode, setMode] = useState<null | 'iptal' | 'ikram' | 'zayi' | 'indirim'>(null);
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
  const reasons = mode === 'iptal' ? boot.settings.voidReasons : mode === 'indirim' ? boot.settings.discountReasons : mode ? compReasonsOf(boot.settings, mode) : [];

  const submit = async () => {
    const base = `/orders/${order.id}/items/${item.id}`;
    let res: unknown = null;
    if (mode === 'iptal') res = await act((pin) => post(`${base}/void`, { qty, reason, approverPin: pin }), 'Kalem iptal edildi');
    if (mode === 'ikram' || mode === 'zayi') res = await act((pin) => post(`${base}/comp`, { qty, reason, kind: mode, approverPin: pin }), mode === 'zayi' ? 'Zayi yazıldı' : 'İkram edildi');
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
          <SheetButton icon={<XCircle className="size-[18px] text-[var(--admin-danger-ink)]" />} title="İptal et" hint={can('siparis.iptal') ? 'Gerekçe ile' : 'Hazırlanmaya başladıysa yetkili onayı ister'} onClick={() => setMode('iptal')} disabled={unpaid < 1} />
          {item.complimentary ? (
            <SheetButton
              icon={<Undo2 className="size-[18px] text-[var(--admin-hue-rose)]" />}
              title={item.compKind === 'ikram' || !item.compKind ? 'İkramı geri al' : `${COMP_LABEL[item.compKind]} kaydını geri al`}
              onClick={async () => (await act((pin) => post(`/orders/${order.id}/items/${item.id}/comp`, { undo: true, reason: '', approverPin: pin }), `${COMP_LABEL[item.compKind ?? 'ikram']} geri alındı`)) && close()}
            />
          ) : (
            <>
              <SheetButton icon={<Gift className="size-[18px] text-[var(--admin-hue-rose)]" />} title="İkram et" hint="Ücret alınmaz, ikram raporuna girer" onClick={() => setMode('ikram')} disabled={unpaid < 1} />
              <SheetButton icon={<Droplets className="size-[18px] text-[var(--admin-warning)]" />} title="Zayi yaz" hint="Döküldü, yanlış hazırlandı; ciro dışı, zayi raporuna girer" onClick={() => setMode('zayi')} disabled={unpaid < 1} />
            </>
          )}
          <SheetButton icon={<Percent className="size-[18px] text-primary" />} title={item.discount > 0 ? `İndirimi değiştir (${tl(item.discount)})` : 'Kaleme indirim'} onClick={() => setMode('indirim')} disabled={item.complimentary || item.paidQty > 0} />
          {item.paidQty > 0 && <p className="px-1 text-xs text-muted">{item.paidQty} adedin ödemesi alındı; bu adetler değiştirilemez</p>}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {mode !== 'indirim' && unpaid > 1 && (
            <div className="flex items-center justify-between rounded-xl border border-line p-1.5 pl-4">
              <span className="text-sm font-medium">Adet</span>
              <div className="flex items-center gap-1">
                <button aria-label="Azalt" className="grid size-11 place-items-center rounded-lg bg-surface-3 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)]" onClick={() => setQty(Math.max(1, qty - 1))}>
                  <Minus className="size-4" />
                </button>
                <span className="tabular w-10 text-center text-lg font-semibold">{qty}</span>
                <button aria-label="Artır" className="grid size-11 place-items-center rounded-lg bg-surface-3 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)]" onClick={() => setQty(Math.min(unpaid, qty + 1))}>
                  <Plus className="size-4" />
                </button>
              </div>
            </div>
          )}
          {mode === 'indirim' && (
            <div className="space-y-2">
              <div className="grid grid-cols-2 gap-2">
                {(['percent', 'amount'] as const).map((k) => (
                  <button key={k} aria-pressed={discType === k} onClick={() => setDiscType(k)} className={cn('min-h-11 rounded-lg border text-sm font-medium transition-colors duration-150', discType === k ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line-strong hover:border-[var(--admin-border-field)] active:bg-press')}>
                    {k === 'percent' ? 'Yüzde (%)' : 'Tutar (₺)'}
                  </button>
                ))}
              </div>
              {/* İşaret başta, sönük (₺120, %10); klavyeyle de yazılır */}
              <output aria-label={discType === 'percent' ? 'İndirim yüzdesi' : 'İndirim tutarı'} aria-live="polite" className="tabular block rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-right text-3xl font-semibold">
                {discType === 'percent' ? (
                  <>
                    <span className="mr-0.5 align-baseline text-[0.6em] font-medium text-muted">%</span>
                    {groupTyped(discValue)}
                  </>
                ) : (
                  <TypedAmount text={discValue} />
                )}
              </output>
              <Numpad size="md" keyboard decimal={discType === 'amount'} onKey={(k) => setDiscValue(applyNumpadKey(discValue, k, { decimal: discType === 'amount', maxLength: discType === 'percent' ? 3 : 8 }))} />
            </div>
          )}
          <div>
            <div className="mb-2 text-sm font-medium text-ink-2">Neden</div>
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <button key={r} aria-pressed={reason === r} onClick={() => setReason(r)} className={cn('min-h-11 rounded-lg border bg-surface px-3 text-sm transition-colors duration-150 active:bg-press pointer-fine:min-h-9', reason === r ? 'border-ink font-semibold text-ink' : 'border-line-strong text-ink-2 hover:border-[var(--admin-border-field)]')}>
                  {r}
                </button>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} placeholder="Ya da nedeni yazın" aria-label="Neden" className="mt-2" />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setMode(null)}>Geri</Button>
            <Button variant={mode === 'iptal' ? 'danger' : 'primary'} disabled={!reason.trim() && !(mode === 'indirim' && (discValue === '' || discValue === '0'))} onClick={submit}>
              {mode === 'iptal' ? `${qty} adet iptal` : mode === 'ikram' ? `${qty} adet ikram` : mode === 'zayi' ? `${qty} adet zayi` : 'Uygula'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function SheetButton({ icon, title, hint, onClick, disabled }: { icon: React.ReactNode; title: string; hint?: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className="flex min-h-14 items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-colors duration-150 enabled:hover:border-[var(--admin-border-field)] enabled:hover:bg-hover enabled:active:bg-press disabled:cursor-not-allowed disabled:opacity-40">
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3">{icon}</span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}
