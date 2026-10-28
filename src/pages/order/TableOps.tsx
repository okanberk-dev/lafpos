import { useQuery } from '@tanstack/react-query';
import { Minus, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { FloorStateDTO, OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { Tabs } from '@/components/ui/misc';
import { get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { groupTyped, TypedAmount } from './TypedAmount';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;

/** Masa seçici: boş masaya taşı, dolu masayla birleştir. `mode = 'kalem'` iken hedef masa seçer. */
export function MoveModal({ order, open, onClose, act, onMoved }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act; onMoved: (targetOrderId?: string) => void }) {
  const boot = useBoot();
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), enabled: open });
  const [sectionId, setSectionId] = useState(boot.sections[0]?.id);
  if (!open) return null;
  const tables = boot.tables.filter((t) => t.sectionId === sectionId && t.id !== order.tableId);

  // Masadaki kasa adisyonu; sitede ödenmiş online sipariş masayı tutmaz, onunla birleştirilmez
  const checkOn = (tableId: string) => floor.data?.tables[tableId]?.find((o) => o.source === 'pos');
  const pick = async (tableId: string) => {
    const busy = checkOn(tableId);
    if (busy) {
      const ok = await confirmDialog({
        title: `${boot.tables.find((t) => t.id === tableId)?.name ?? 'Masa'} dolu`,
        body: `Bu adisyon oradakiyle birleştirilir (${tl(busy.total)})`,
        confirmLabel: 'Adisyonları birleştir',
        tone: 'primary',
      });
      if (!ok) return;
      const res = await act((pin) => post<OrderDTO>(`/orders/${busy.id}/merge`, { sourceOrderId: order.id, approverPin: pin }), 'Masalar birleştirildi');
      if (res) onMoved(busy.id);
      return;
    }
    const res = await act((pin) => post<OrderDTO>(`/orders/${order.id}/move`, { tableId, approverPin: pin }), 'Masa taşındı');
    if (res) onMoved();
  };

  return (
    <Modal open onClose={onClose} title="Masa taşı / birleştir" subtitle="Boş masaya dokunun: taşınır. Dolu masaya dokunun: birleştirilir" size="lg">
      <div className="p-4">
        {/* Bölüm sekmesi ortak bileşenle: seçili durum ekran okuyucuya söylenir, odak halkası çipin içinde */}
        {boot.sections.length > 1 && <Tabs label="Bölümler" className="mb-3" value={sectionId ?? ''} onChange={setSectionId} options={boot.sections.map((s) => ({ value: s.id, label: s.name }))} />}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2">
          {tables.map((t) => {
            const busy = checkOn(t.id);
            return (
              <button key={t.id} onClick={() => pick(t.id)} className={cn('h-20 rounded-xl border p-2 text-left transition-colors duration-150', busy ? 'border-primary-line bg-primary-soft hover:border-[var(--admin-primary)]' : 'border-line bg-surface hover:border-[var(--admin-border-field)]')}>
                <div className="font-semibold">{t.name}</div>
                <div className="text-xs opacity-80">{busy ? `Dolu · ${tl(busy.total)}` : 'Boş'}</div>
              </button>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Hesap bölme: seçilen kalemleri (adetleriyle) başka masaya ya da ayrı hesaba taşır. */
export function TransferModal({ order, open, onClose, act, onDone }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act; onDone: (targetOrderId: string) => void }) {
  const boot = useBoot();
  const [sel, setSel] = useState<Record<string, number>>({});
  const [target, setTarget] = useState<'ayri' | string>('ayri');
  useEffect(() => {
    if (open) setSel({});
  }, [open]);
  if (!open) return null;
  const items = order.items.filter((i) => !i.voided && i.qty - i.paidQty > 0);
  const chosen = Object.entries(sel).filter(([, q]) => q > 0);
  const submit = async () => {
    const res = await act(
      (pin) =>
        post<{ source: OrderDTO; target: OrderDTO }>(`/orders/${order.id}/transfer`, {
          items: chosen.map(([itemId, qty]) => ({ itemId, qty })),
          tableId: target === 'ayri' ? (order.tableId ?? null) : target,
          approverPin: pin,
        }),
      'Kalemler taşındı',
    );
    if (res) onDone(res.target.id);
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title="Hesabı böl / kalem taşı"
      subtitle="Taşınacak kalemleri ve adetlerini seçin"
      footer={
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Taşınacak yer" className="min-w-0 flex-1 basis-48">
            <option value="ayri">Aynı masada ayrı hesap</option>
            {boot.tables
              .filter((t) => t.id !== order.tableId)
              .map((t) => (
                <option key={t.id} value={t.id}>
                  {boot.sections.find((s) => s.id === t.sectionId)?.name} · {t.name}
                </option>
              ))}
          </Select>
          <Button variant="primary" disabled={!chosen.length} onClick={submit}>
            {chosen.reduce((a, [, q]) => a + q, 0)} kalemi taşı
          </Button>
        </div>
      }
    >
      <div className="space-y-1.5 p-4">
        {items.map((i) => {
          const left = i.qty - i.paidQty;
          const q = sel[i.id] ?? 0;
          return (
            <div key={i.id} className={cn('flex items-center gap-3 rounded-xl border px-3 py-2 transition-colors duration-150', q ? 'border-primary bg-[var(--admin-primary-soft)]' : 'border-line')}>
              <button className="min-w-0 flex-1 text-left" onClick={() => setSel({ ...sel, [i.id]: q ? 0 : left })}>
                <div className="truncate font-medium">
                  {i.name} {i.size !== 'TEK' && <span className="text-sm text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                </div>
                <div className="text-xs text-muted">
                  {left} adet · {tl(i.unitPrice)}
                  {i.optionsText && ` · ${i.optionsText}`}
                </div>
              </button>
              <button aria-label="Azalt" className={STEP} onClick={() => setSel({ ...sel, [i.id]: Math.max(0, q - 1) })}>
                <Minus className="size-4" />
              </button>
              <span className="tabular w-6 text-center font-semibold">{q}</span>
              <button aria-label="Artır" className={STEP} onClick={() => setSel({ ...sel, [i.id]: Math.min(left, q + 1) })}>
                <Plus className="size-4" />
              </button>
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

export function OrderDiscountModal({ order, open, onClose, act }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act }) {
  const boot = useBoot();
  const [type, setType] = useState<'percent' | 'amount'>('percent');
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  useEffect(() => {
    if (!open) return;
    setType(order.discountType ?? 'percent');
    setValue(order.discountValue ? (order.discountType === 'amount' ? String(order.discountValue / 100).replace('.', ',') : String(order.discountValue)) : '');
    setReason(order.discountReason ?? '');
  }, [open, order]);
  if (!open) return null;
  const numeric = type === 'percent' ? Number(value || 0) : (parseTL(value || '0') ?? 0);
  const submit = async (remove = false) => {
    const res = await act(
      (pin) => post(`/orders/${order.id}/discount`, remove ? { type: 'percent', value: 0, reason: '', remove: true, approverPin: pin } : { type, value: numeric, reason, approverPin: pin }),
      remove ? 'İndirim kaldırıldı' : 'İndirim uygulandı',
    );
    if (res) onClose();
  };
  return (
    <Modal open onClose={onClose} size="sm" title="Adisyon indirimi" subtitle={`Ara toplam ${tl(order.totals.gross - order.totals.lineDiscounts)}`}>
      <div className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-2">
          {(['percent', 'amount'] as const).map((k) => (
            <button key={k} aria-pressed={type === k} onClick={() => setType(k)} className={cn('min-h-11 rounded-lg border text-sm font-medium transition-colors duration-150', type === k ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line-strong hover:border-[var(--admin-border-field)] active:bg-press')}>
              {k === 'percent' ? 'Yüzde (%)' : 'Tutar (₺)'}
            </button>
          ))}
        </div>
        {/* İşaret başta, sönük (₺120, %10); klavyeyle de yazılır */}
        <output aria-label={type === 'percent' ? 'İndirim yüzdesi' : 'İndirim tutarı'} aria-live="polite" className="tabular block rounded-2xl border border-line-strong bg-surface-2 px-4 py-3 text-right text-3xl font-semibold">
          {type === 'percent' ? (
            <>
              <span className="mr-0.5 align-baseline text-[0.6em] font-medium text-muted">%</span>
              {groupTyped(value)}
            </>
          ) : (
            <TypedAmount text={value} />
          )}
        </output>
        <Numpad size="md" keyboard decimal={type === 'amount'} onKey={(k) => setValue(applyNumpadKey(value, k, { decimal: type === 'amount', maxLength: type === 'percent' ? 3 : 8 }))} />
        <div className="flex flex-wrap gap-1.5">
          {boot.settings.discountReasons.map((r) => (
            <ReasonChip key={r} on={reason === r} onClick={() => setReason(r)}>
              {r}
            </ReasonChip>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-2">
          {order.discountType ? (
            <Button variant="danger" onClick={() => submit(true)}>
              Kaldır
            </Button>
          ) : (
            <Button onClick={onClose}>Vazgeç</Button>
          )}
          <Button variant="primary" disabled={!reason.trim() || numeric <= 0} onClick={() => submit()}>
            Uygula
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export function GuestsModal({ order, open, onClose, act }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act }) {
  const [n, setN] = useState(order.guests);
  useEffect(() => setN(order.guests), [order.guests, open]);
  if (!open) return null;
  return (
    <Modal open onClose={onClose} size="sm" title="Kişi sayısı">
      <div className="space-y-4 p-5">
        <div className="flex items-center justify-center gap-4">
          <button aria-label="Azalt" className="grid size-14 place-items-center rounded-2xl bg-surface-3 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)]" onClick={() => setN(Math.max(1, n - 1))}>
            <Minus className="size-6" />
          </button>
          <span className="tabular w-16 text-center text-5xl font-semibold">{n}</span>
          <button aria-label="Artır" className="grid size-14 place-items-center rounded-2xl bg-surface-3 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)]" onClick={() => setN(Math.min(99, n + 1))}>
            <Plus className="size-6" />
          </button>
        </div>
        <Button variant="primary" block onClick={async () => (await act(() => patch(`/orders/${order.id}`, { guests: n }))) && onClose()}>
          Kaydet
        </Button>
      </div>
    </Modal>
  );
}

export function ReasonModal({
  open,
  title,
  subtitle,
  reasons,
  confirmLabel,
  danger,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  reasons: string[];
  confirmLabel: string;
  danger?: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [open]);
  if (!open) return null;
  // Neden zorunlu (denetim kaydına yazılır): düğme sessizce soluk kalmaz, ileti alanın altında
  const confirm = () => {
    if (!reason.trim()) {
      setError('Bir neden seçin ya da yazın');
      return;
    }
    onConfirm(reason.trim());
  };
  return (
    <Modal open onClose={onClose} size="sm" title={title} subtitle={subtitle}>
      <div className="space-y-3 p-4">
        <div role="group" aria-label="Hazır nedenler" className="flex flex-wrap gap-1.5">
          {reasons.map((r) => (
            <ReasonChip
              key={r}
              on={reason === r}
              onClick={() => {
                setReason(r);
                setError(null);
              }}
            >
              {r}
            </ReasonChip>
          ))}
        </div>
        <Field error={error}>
          <Input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value.slice(0, 200));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.repeat) confirm();
            }}
            enterKeyHint="done"
            placeholder="Ör. yanlış masa"
            aria-label="Neden"
          />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={confirm}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/** Adet düğmesi: farede 36, dokunmatikte 44 px */
const STEP = 'grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)] pointer-coarse:size-11';

/** Hazır neden çipi: seçili koyu kenar (yazıyla birlikte, renk tek başına değil) */
function ReasonChip({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      className={cn('min-h-11 rounded-lg border bg-surface px-3 text-sm transition-colors duration-150 active:bg-press pointer-fine:min-h-9', on ? 'border-ink font-semibold text-ink' : 'border-line-strong text-ink-2 hover:border-[var(--admin-border-field)]')}
    >
      {children}
    </button>
  );
}
