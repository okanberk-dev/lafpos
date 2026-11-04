import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { FloorStateDTO, OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Chip, Field, Input, Label, Segmented, Select, Stepper } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { EmptyState, ErrorState, Skeleton, Tabs } from '@/components/ui/misc';
import { get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { groupTyped } from '@/lib/numpad';
import { TypedAmount } from './TypedAmount';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;

/**
 * Masa seçici: boş masaya taşı, dolu masayla birleştir. Açılınca adisyonun kendi bölümü seçili gelir. Masaların
 * doluluğu gelmeden masa "Boş" yazmaz ve dokunulmaz (dolu masaya taşıma isteği gitmesin); alınamazsa yeniden denenir.
 */
export function MoveModal({ order, open, onClose, act, onMoved }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act; onMoved: (targetOrderId?: string) => void }) {
  const boot = useBoot();
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), enabled: open });
  const homeSection = boot.tables.find((t) => t.id === order.tableId)?.sectionId ?? boot.sections[0]?.id;
  const [sectionId, setSectionId] = useState(homeSection);
  useEffect(() => {
    if (open) setSectionId(homeSection);
    // Yalnız pencere açılınca: açıkken başka bölüme geçilebilir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const tables = boot.tables.filter((t) => t.sectionId === sectionId && t.id !== order.tableId);
  const loading = floor.isPending;
  const failed = floor.isError && !floor.data;

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
      <div className="px-5 py-4">
        {/* Bölüm sekmesi ortak bileşenle: seçili durum ekran okuyucuya söylenir, odak halkası çipin içinde */}
        {boot.sections.length > 1 && <Tabs label="Bölümler" className="mb-3" value={sectionId ?? ''} onChange={setSectionId} options={boot.sections.map((s) => ({ value: s.id, label: s.name }))} />}
        {failed ? (
          <ErrorState compact title="Masalar alınamadı" error={floor.error} retrying={floor.isFetching} onRetry={() => void floor.refetch()} />
        ) : tables.length === 0 ? (
          <EmptyState compact title="Bu bölümde başka masa yok" />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-2" aria-busy={loading || undefined}>
            {tables.map((t) => {
              const busy = checkOn(t.id);
              return (
                <button
                  key={t.id}
                  disabled={loading}
                  onClick={() => void pick(t.id)}
                  className={cn(
                    'min-h-20 min-w-0 rounded-xl border p-2.5 text-left transition-[background-color,border-color,filter] duration-150 disabled:cursor-progress',
                    busy ? 'border-blue-line bg-blue-soft hover:border-[var(--admin-blue)] active:brightness-95' : 'border-line bg-surface enabled:hover:border-[var(--admin-border-field)] enabled:active:bg-press',
                  )}
                >
                  <div className="truncate font-semibold">{t.name}</div>
                  {loading ? (
                    <Skeleton className="mt-1.5 h-3 w-14" />
                  ) : (
                    <div className={cn('tabular truncate text-xs', busy ? 'text-blue-ink' : 'text-muted')}>{busy ? `Dolu · ${tl(busy.total)}` : 'Boş'}</div>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Hesap bölme: seçilen kalemleri (adetleriyle) başka masaya ya da ayrı hesaba taşır. */
export function TransferModal({
  order,
  open,
  initial,
  onClose,
  act,
  onDone,
}: {
  order: OrderDTO;
  open: boolean;
  /** Kalem işlemlerinden "Taşı": pencere bu kalem ve adediyle seçili açılır */
  initial?: { itemId: string; qty: number } | null;
  onClose: () => void;
  act: Act;
  onDone: (targetOrderId: string) => void;
}) {
  const boot = useBoot();
  const [sel, setSel] = useState<Record<string, number>>({});
  const [target, setTarget] = useState<'ayri' | string>('ayri');
  // Tek seferlik taşıma: ikinci basış kaynakta kalan adedi ikinci bir yeni hesaba taşımasın
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    if (open) setSel(initial && initial.qty > 0 ? { [initial.itemId]: initial.qty } : {});
  }, [open, initial]);
  if (!open) return null;
  const items = order.items.filter((i) => !i.voided && i.qty - i.paidQty > 0);
  const chosen = Object.entries(sel).filter(([, q]) => q > 0);
  const count = chosen.reduce((a, [, q]) => a + q, 0);
  const submit = async () => {
    if (busyRef.current || !chosen.length) return;
    busyRef.current = true;
    setBusy(true);
    try {
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
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      persistent={busy}
      title="Hesabı böl / kalem taşı"
      subtitle="Taşınacak kalemleri ve adetlerini seçin"
      footer={
        // Telefonda yer seçimi tam genişlikte, düğme altında; geniş ekranda yan yana
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Taşınacak yer" className="min-w-0 flex-1">
            <Select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Taşınacak yer">
              <option value="ayri">Aynı masada ayrı hesap</option>
              {boot.tables
                .filter((t) => t.id !== order.tableId)
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {boot.sections.find((s) => s.id === t.sectionId)?.name} · {t.name}
                  </option>
                ))}
            </Select>
          </Field>
          <Button variant="primary" className="max-sm:w-full sm:min-w-40" disabled={!chosen.length} loading={busy} onClick={() => void submit()}>
            {count ? `${count} kalemi taşı` : 'Kalem seçin'}
          </Button>
        </div>
      }
    >
      <div className="space-y-1.5 px-5 py-4">
        {items.length === 0 && <EmptyState compact title="Taşınacak kalem yok">Adisyonun bütün kalemleri ödenmiş ya da iptal edilmiş</EmptyState>}
        {items.map((i) => {
          const left = i.qty - i.paidQty;
          const q = sel[i.id] ?? 0;
          return (
            <div
              key={i.id}
              className={cn(
                'flex items-center gap-3 rounded-xl border py-1.5 pl-3 pr-1.5 transition-colors duration-150',
                q ? 'border-primary bg-[var(--admin-primary-soft)]' : 'border-line hover:border-[var(--admin-border-field)] active:bg-press',
              )}
            >
              <button aria-pressed={q > 0} className="min-h-11 min-w-0 flex-1 text-left" onClick={() => setSel({ ...sel, [i.id]: q ? 0 : left })}>
                <span className="block truncate font-medium">
                  {i.name} {i.size !== 'TEK' && <span className="text-sm font-normal text-muted">{boot.settings.sizeLabels[i.size]}</span>}
                </span>
                {/* Birim fiyat: "2 × ₺195,00" (ödeme penceresindeki "2 adet · ₺390,00" satır tutarıdır) */}
                <span className="tabular block truncate text-xs text-muted">
                  {left} × {tl(i.unitPrice)}
                  {i.optionsText && ` · ${i.optionsText}`}
                </span>
              </button>
              <Stepper value={q} max={left} label={`${i.name} adedi`} onChange={(v) => setSel({ ...sel, [i.id]: v })} />
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apply' | 'remove' | null>(null);
  useEffect(() => {
    if (!open) return;
    setType(order.discountType ?? 'percent');
    setValue(order.discountValue ? (order.discountType === 'amount' ? String(order.discountValue / 100).replace('.', ',') : String(order.discountValue)) : '');
    setReason(order.discountReason ?? '');
    setError(null);
    // Yalnız pencere açılınca: açıkken gelen adisyon yenilemesi yazılan tutarı ve nedeni silmesin
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  if (!open) return null;
  const numeric = type === 'percent' ? Number(value || 0) : (parseTL(value || '0') ?? 0);
  // İndirim kalem indirimlerinden sonraki ara toplama uygulanır (sunucuyla aynı)
  const subtotal = order.totals.gross - order.totals.lineDiscounts;
  // Sunucu yüzdeyi 100'e, tutarı ara toplama kırpar: %150 ya da ₺19,50 yerine yazılan ₺1.950 sessizce %100 olmasın, alan söyler
  const overLimit = type === 'percent' ? numeric > 100 : numeric > subtotal;
  const ready = numeric > 0 && !overLimit;
  const submit = async (remove = false) => {
    if (busy) return;
    if (!remove) {
      if (!ready) return;
      // Neden zorunlu (denetim kaydına yazılır): düğme sessizce soluk kalmaz, ileti alanın altında
      if (!reason.trim()) {
        setError('Bir neden seçin ya da yazın');
        return;
      }
    }
    setBusy(remove ? 'remove' : 'apply');
    const res = await act(
      (pin) => post(`/orders/${order.id}/discount`, remove ? { type: 'percent', value: 0, reason: '', remove: true, approverPin: pin } : { type, value: numeric, reason: reason.trim(), approverPin: pin }),
      remove ? 'İndirim kaldırıldı' : 'İndirim uygulandı',
    );
    setBusy(null);
    if (res) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      persistent={!!busy}
      title="Adisyon indirimi"
      subtitle={`Ara toplam ${tl(subtotal)}`}
      footer={
        <div className="grid grid-cols-2 gap-2">
          {order.discountType ? (
            <Button variant="dangerOutline" disabled={!!busy} loading={busy === 'remove'} onClick={() => void submit(true)}>
              Kaldır
            </Button>
          ) : (
            <Button disabled={!!busy} onClick={onClose}>
              Vazgeç
            </Button>
          )}
          <Button variant="primary" disabled={!ready || busy === 'remove'} loading={busy === 'apply'} onClick={() => void submit()}>
            Uygula
          </Button>
        </div>
      }
    >
      <div className="space-y-3 px-5 py-4">
        <Segmented<'percent' | 'amount'>
          label="İndirim türü"
          value={type}
          onChange={setType}
          options={[
            { value: 'percent', label: 'Yüzde (%)' },
            { value: 'amount', label: 'Tutar (₺)' },
          ]}
        />
        {/* İşaret başta, sönük (₺120, %10); klavyeyle de yazılır */}
        <div>
          <output
            aria-label={type === 'percent' ? 'İndirim yüzdesi' : 'İndirim tutarı'}
            aria-live="polite"
            aria-invalid={overLimit || undefined}
            aria-describedby={overLimit ? 'indirim-fazla' : undefined}
            className={cn('tabular font-headline block rounded-2xl border bg-surface-2 px-4 py-3 text-right text-3xl font-semibold', overLimit ? 'border-[var(--admin-danger)]' : 'border-line-strong')}
          >
            {type === 'percent' ? (
              <>
                <span className="mr-0.5 align-baseline text-[0.6em] font-medium text-muted">%</span>
                {groupTyped(value)}
              </>
            ) : (
              <TypedAmount text={value} />
            )}
          </output>
          {overLimit && (
            <p id="indirim-fazla" role="alert" className="mt-1.5 text-[13px] text-[var(--admin-danger-ink)]">
              {type === 'percent' ? 'Yüzde en çok 100 olur' : `İndirim ara toplamdan (${tl(subtotal)}) fazla olamaz`}
            </p>
          )}
        </div>
        {/* Enter, Uygula etkinse indirimi uygular; değilse hiçbir şey yapmaz (odaktaki rakamı yinelemez) */}
        <Numpad
          size="md"
          keyboard
          decimal={type === 'amount'}
          onEnter={() => ready && void submit()}
          onKey={(k) => setValue(applyNumpadKey(value, k, { decimal: type === 'amount', maxLength: type === 'percent' ? 3 : 8 }))}
        />
        <div>
          <Label hint="zorunlu">Neden</Label>
          {boot.settings.discountReasons.length > 0 && (
            <div role="group" aria-label="Hazır nedenler" className="mb-2 flex flex-wrap gap-1.5">
              {boot.settings.discountReasons.map((r) => (
                <Chip
                  key={r}
                  tone="ink"
                  on={reason === r}
                  onClick={() => {
                    setReason(r);
                    setError(null);
                  }}
                >
                  {r}
                </Chip>
              ))}
            </div>
          )}
          {/* Ayarlarda hazır neden yoksa ya da hiçbiri uymuyorsa elle yazılır */}
          <Field error={error}>
            <Input
              value={reason}
              onChange={(e) => {
                setReason(e.target.value.slice(0, 200));
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.repeat) void submit();
              }}
              enterKeyHint="done"
              placeholder={boot.settings.discountReasons.length ? 'Ya da başka bir neden yazın' : 'Nedeni yazın'}
              aria-label="Neden"
            />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

export function GuestsModal({ order, open, onClose, act }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act }) {
  const [n, setN] = useState(order.guests);
  const [busy, setBusy] = useState(false);
  useEffect(() => setN(order.guests), [order.guests, open]);
  if (!open) return null;
  const save = async () => {
    if (busy) return;
    setBusy(true);
    const res = await act(() => patch(`/orders/${order.id}`, { guests: n }));
    setBusy(false);
    if (res) onClose();
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      title="Kişi sayısı"
      footer={
        <Button variant="primary" block loading={busy} onClick={() => void save()}>
          Kaydet
        </Button>
      }
    >
      <div className="flex justify-center px-5 py-6">
        <Stepper size="lg" label="Kişi" value={n} min={1} max={99} onChange={setN} />
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
  placeholder,
  onClose,
  onConfirm,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  reasons: string[];
  confirmLabel: string;
  danger?: boolean;
  /** Alanın örneği; verilmezse hazır neden varken "Ya da başka bir neden yazın" */
  placeholder?: string;
  onClose: () => void;
  /** Söz dönerse yanıt gelene dek ikinci Enter ya da dokunuş yok sayılır (iptal, ciro dışı kapanış iki kez gitmesin) */
  onConfirm: (reason: string) => unknown;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    setReason('');
    setError(null);
  }, [open]);
  if (!open) return null;
  // Neden zorunlu (denetim kaydına yazılır): düğme sessizce soluk kalmaz, ileti alanın altında
  const confirm = async () => {
    if (busyRef.current) return;
    if (!reason.trim()) {
      setError('Bir neden seçin ya da yazın');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      await onConfirm(reason.trim());
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  // Düğmeler onay ve metin isteme pencereleriyle (confirmDialog, promptDialog) aynı yerde: altta, eşit iki sütun
  const footer = (
    <div className="grid grid-cols-2 gap-2">
      <Button onClick={onClose} disabled={busy}>
        Vazgeç
      </Button>
      <Button variant={danger ? 'danger' : 'primary'} className="whitespace-normal leading-tight" loading={busy} onClick={() => void confirm()}>
        {confirmLabel}
      </Button>
    </div>
  );
  return (
    <Modal open onClose={onClose} size="sm" persistent={busy} title={title} subtitle={subtitle} footer={footer}>
      <div className="px-5 py-4">
        <Label hint="zorunlu">Neden</Label>
        {reasons.length > 0 && (
          <div role="group" aria-label="Hazır nedenler" className="mb-2 flex flex-wrap gap-1.5">
            {reasons.map((r) => (
              <Chip
                key={r}
                tone="ink"
                on={reason === r}
                onClick={() => {
                  setReason(r);
                  setError(null);
                }}
              >
                {r}
              </Chip>
            ))}
          </div>
        )}
        <Field error={error}>
          <Input
            value={reason}
            onChange={(e) => {
              setReason(e.target.value.slice(0, 200));
              setError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.repeat) void confirm();
            }}
            enterKeyHint="done"
            placeholder={placeholder ?? (reasons.length ? 'Ya da başka bir neden yazın' : 'Nedeni yazın')}
            aria-label="Neden"
          />
        </Field>
      </div>
    </Modal>
  );
}
