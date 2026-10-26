import { useMutation, useQuery } from '@tanstack/react-query';
import { Bike, CalendarClock, ChefHat, Globe, LayoutGrid, List, Mic2, Plus, Receipt, ShoppingBag, Store } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { tlShort } from '@shared/money';
import { fmtElapsed } from '@shared/time';
import type { FloorOrderSummary, FloorStateDTO, OrderDTO, TableDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { PageLoading } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref, useMediaQuery, useTick } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';
import { openCounterSale } from '@/lib/counter';

export default function FloorPage() {
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const wide = useMediaQuery('(min-width: 768px)');
  const [sectionId, setSectionId] = useLocalPref<string>('floor.section', boot.sections[0]?.id ?? '');
  const [view, setView] = useLocalPref<'plan' | 'liste'>('floor.view', 'plan');
  const [choose, setChoose] = useState<{ table: TableDTO; orders: FloorOrderSummary[] } | null>(null);
  const [takeaway, setTakeaway] = useState<null | 'gelal' | 'paket'>(null);
  const now = useTick(30_000);
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), refetchInterval: REMOTE ? 10_000 : 60_000 });

  const section = boot.sections.find((s) => s.id === sectionId) ?? boot.sections[0];
  const tables = boot.tables.filter((t) => t.sectionId === section?.id);
  const effectiveView = wide ? view : 'liste';

  const open = useMutation({
    mutationFn: (body: Record<string, unknown>) => (body.type === 'tezgah' ? openCounterSale() : post<OrderDTO>('/orders', body)),
    onSuccess: (o) => navigate(`/adisyon/${o.id}`),
    onError: (e) => toast.err(errorMessage(e)),
  });

  const tapTable = (t: TableDTO) => {
    const orders = floor.data?.tables[t.id] ?? [];
    if (orders.length === 1) return navigate(`/adisyon/${orders[0].id}`);
    if (orders.length > 1) return setChoose({ table: t, orders });
    if (!boot.day) {
      toast.warn('Gün açılmamış. Önce Kasa ekranından günü açın');
      return navigate('/kasa');
    }
    open.mutate({ type: 'masa', tableId: t.id });
  };

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of boot.tables) if (floor.data?.tables[t.id]?.length) m.set(t.sectionId, (m.get(t.sectionId) ?? 0) + 1);
    return m;
  }, [boot.tables, floor.data]);

  if (floor.isLoading) return <PageLoading />;
  const others = floor.data?.others ?? [];
  const reservations = floor.data?.reservations ?? [];
  const busyTables = tables.filter((t) => (floor.data?.tables[t.id]?.length ?? 0) > 0);
  const billed = busyTables.filter((t) => floor.data?.tables[t.id]?.some((o) => o.billPrintedAt)).length;
  const summary = [`${tables.length} masa`, `${busyTables.length} dolu`, billed ? `${billed} hesap bekliyor` : null].filter(Boolean).join(' · ');

  return (
    // Innex: gri zemin üstünde iki beyaz kart; telefonda kartlar kenara yapışmasın diye zeminde 8 px
    <div className="flex h-full flex-col gap-2 p-2 md:p-0 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-surface">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-divider)] px-4 py-3">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h1 className="text-lg font-semibold tracking-[-0.01em]">{section?.name ?? 'Masalar'}</h1>
            <p className="text-[13px] text-muted">{summary}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {wide && (
              <div role="radiogroup" aria-label="Görünüm" className="inline-flex rounded-lg bg-surface-3 p-0.5">
                {(
                  [
                    ['plan', 'Plan görünümü', LayoutGrid],
                    ['liste', 'Liste görünümü', List],
                  ] as const
                ).map(([v, label, Icon]) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    aria-label={label}
                    title={label}
                    onClick={() => setView(v)}
                    className={cn(
                      'grid size-9 place-items-center rounded-md transition-colors pointer-coarse:size-11',
                      view === v ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08),0_0_0_1px_rgb(12_14_27/0.04)]' : 'text-muted hover:text-ink',
                    )}
                  >
                    <Icon className="size-4" strokeWidth={1.75} />
                  </button>
                ))}
              </div>
            )}
            {!REMOTE && (
            <>
            <Button icon={<ShoppingBag className="size-4" strokeWidth={1.75} />} onClick={() => setTakeaway('gelal')} className="hidden sm:inline-flex">
              Gel-al
            </Button>
            {can('paket.yonet') && (
              <Button icon={<Bike className="size-4" strokeWidth={1.75} />} onClick={() => setTakeaway('paket')} className="hidden sm:inline-flex">
                Paket
              </Button>
            )}
            <Button variant="primary" icon={<Store className="size-4" strokeWidth={1.75} />} loading={open.isPending && open.variables?.type === 'tezgah'} onClick={() => (boot.day ? open.mutate({ type: 'tezgah' }) : navigate('/kasa'))}>
              Tezgâh satışı
            </Button>
            </>
            )}
          </div>
        </header>

        {boot.sections.length > 1 && (
          <div role="tablist" aria-label="Bölümler" className="no-scrollbar flex gap-1.5 overflow-x-auto px-4 pt-3">
            {boot.sections.map((s) => {
              const on = s.id === section?.id;
              return (
                <button
                  key={s.id}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  onClick={() => setSectionId(s.id)}
                  className={cn(
                    'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-surface px-3 text-sm whitespace-nowrap transition-[color,border-color] pointer-fine:min-h-9',
                    on ? 'border-ink font-semibold text-ink' : 'border-line font-medium text-ink-2 hover:border-[var(--admin-border-field)] hover:text-ink',
                  )}
                >
                  {s.name}
                  {!!counts.get(s.id) && (
                    <span className={cn('tabular min-w-5 rounded-md px-1.5 py-px text-center text-xs font-medium', on ? 'bg-ink text-surface' : 'bg-surface-3 text-ink-2')}>{counts.get(s.id)}</span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
          {effectiveView === 'plan' ? (
            <div className="relative mx-auto aspect-[16/10] w-full max-w-6xl">
              {tables.map((t) => (
                <TableTile
                  key={t.id}
                  table={t}
                  orders={floor.data?.tables[t.id] ?? []}
                  reservation={reservations.find((r) => r.tableId === t.id)}
                  now={now}
                  onClick={() => tapTable(t)}
                  style={{ left: `${t.x}%`, top: `${t.y}%`, width: `${t.w}%`, height: `${t.h}%` }}
                  className="absolute"
                />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2.5">
              {tables.map((t) => (
                <TableTile key={t.id} table={t} orders={floor.data?.tables[t.id] ?? []} reservation={reservations.find((r) => r.tableId === t.id)} now={now} onClick={() => tapTable(t)} className="h-28" />
              ))}
            </div>
          )}
        </div>
        <footer className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--admin-divider)] px-4 py-2.5 text-xs text-muted">
          <Legend className="border border-line bg-surface" label="Boş" />
          <Legend className="border border-brand-200 bg-brand-50" label="Dolu" />
          <Legend className="border border-warn-200 bg-warn-100" label="Hesap istendi" />
          <Legend className="border border-rose-300 bg-rose-100" label="Kısmen ödendi" />
          <Legend className="border border-line bg-surface" dot="bg-brand-600" label="Rezerve" />
        </footer>
      </section>

      <aside className="flex max-h-[40%] flex-col rounded-2xl border border-line bg-surface lg:max-h-none lg:w-80">
        <div className="flex min-h-12 items-center gap-2 border-b border-[var(--admin-divider)] px-4 py-2.5">
          <h2 className="flex-1 text-[15px] font-semibold">Masasız siparişler</h2>
          <span className="tabular min-w-5 rounded-md bg-surface-3 px-1.5 py-px text-center text-xs font-medium text-ink-2">{others.length}</span>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-2">
          {others.length === 0 && <p className="px-3 py-6 text-center text-sm text-muted">Açık tezgâh, gel-al, paket ya da online sipariş yok</p>}
          {others.map((o) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-surface-2">
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', o.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
                {o.source === 'laffogato' ? <Globe strokeWidth={1.75} /> : o.type === 'paket' ? <Bike strokeWidth={1.75} /> : o.type === 'gelal' ? <ShoppingBag strokeWidth={1.75} /> : <Store strokeWidth={1.75} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{o.label}</span>
                <span className="text-xs text-muted">
                  #{o.no} · {fmtElapsed(o.openedAt, now)} · {o.itemCount} ürün
                </span>
              </span>
              <span className="tabular text-right text-sm font-semibold">
                {tlShort(o.total)}
                {o.pendingKitchen > 0 && <span className="block text-xs font-medium text-[var(--admin-warning)]">{o.pendingKitchen} hazırlanıyor</span>}
              </span>
            </button>
          ))}
          {reservations.length > 0 && (
            <div className="mt-2 border-t border-[var(--admin-divider)] px-2 pt-3">
              <h3 className="flex items-center gap-1.5 pb-1.5 text-xs font-medium text-muted">
                <CalendarClock className="size-3.5" strokeWidth={1.75} /> Bugünkü rezervasyonlar
              </h3>
              {reservations.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-sm">
                  <span className="tabular font-semibold">{r.time}</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="text-xs text-muted">{r.guests} kişi</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <Modal open={!!choose} onClose={() => setChoose(null)} title={choose ? `${choose.table.name}: ayrı hesaplar` : ''} size="sm">
        <div className="space-y-2 p-4">
          {choose?.orders.map((o, i) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex min-h-14 w-full items-center justify-between rounded-xl border border-line px-4 transition-colors hover:border-[var(--admin-border-field)] hover:bg-surface-2">
              <span className="text-sm font-medium">
                Hesap {i + 1} <span className="text-muted">#{o.no}</span>
              </span>
              <span className="tabular font-semibold">{tlShort(o.total)}</span>
            </button>
          ))}
          <Button block icon={<Plus className="size-4" />} onClick={() => choose && open.mutate({ type: 'masa', tableId: choose.table.id, newCheck: true })}>
            Yeni ayrı hesap aç
          </Button>
        </div>
      </Modal>

      <TakeawayModal kind={takeaway} onClose={() => setTakeaway(null)} onCreate={(body) => open.mutate(body)} busy={open.isPending} />
    </div>
  );
}

function Legend({ className, dot, label }: { className: string; dot?: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('relative size-3 rounded-[4px]', className)}>{dot && <span className={cn('absolute -right-0.5 -top-0.5 size-1.5 rounded-full', dot)} />}</span>
      {label}
    </span>
  );
}

/**
 * Masa: durum dolguyla değil açık tonla (Innex durum rozeti gibi). Boş beyaz, dolu mavi ton, hesap istendi amber,
 * kısmen ödendi pembe; bara gitmiş ve hazır kalemler küçük rozet, hazır olan yeşil ve dikkat çeker.
 */
function TableTile({
  table,
  orders,
  reservation,
  now,
  onClick,
  className,
  style,
}: {
  table: TableDTO;
  orders: FloorOrderSummary[];
  reservation?: { time: string; name: string; guests: number; status: string };
  now: number;
  onClick: () => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const busy = orders.length > 0;
  const total = orders.reduce((a, o) => a + o.total, 0);
  const paid = orders.reduce((a, o) => a + o.paid, 0);
  const billed = orders.some((o) => o.billPrintedAt);
  const partial = paid > 0 && paid < total;
  const pending = orders.reduce((a, o) => a + o.pendingKitchen, 0);
  const ready = orders.reduce((a, o) => a + o.readyToServe, 0);
  const openedAt = Math.min(...orders.map((o) => o.openedAt));
  const online = orders.some((o) => o.source === 'laffogato');
  const room = orders.find((o) => o.roomStartedAt)?.roomStartedAt ?? null;
  const tone = !busy ? 'free' : partial ? 'partial' : billed ? 'billed' : 'busy';
  const round = table.shape === 'round';

  return (
    <button
      onClick={onClick}
      style={style}
      className={cn(
        '@container group flex flex-col justify-between overflow-hidden border p-2.5 text-left transition-[border-color,background-color,transform] active:scale-[0.98]',
        round ? 'items-center rounded-[999px] text-center' : 'rounded-xl',
        tone === 'free' && 'border-line bg-surface hover:border-[var(--admin-border-field)]',
        tone === 'busy' && 'border-brand-200 bg-brand-50 hover:border-brand-300 dark:border-brand-800 dark:bg-[var(--admin-primary-soft)]',
        tone === 'billed' && 'border-warn-200 bg-warn-100 hover:border-warn-300 dark:border-warn-800 dark:bg-[var(--admin-warning-soft)]',
        tone === 'partial' && 'border-rose-300 bg-rose-100 hover:border-rose-500 dark:border-transparent dark:bg-[var(--admin-hue-rose-soft)]',
        className,
      )}
    >
      <div className={cn('flex w-full items-start gap-1', round && 'justify-center')}>
        <span className="truncate text-sm font-semibold leading-tight @min-[6rem]:text-[15px]">{table.name}</span>
        {!round && <span className="flex-1" />}
        <span className="hidden gap-1 text-ink-2 @min-[6rem]:flex">
          {billed && <Receipt className="size-4 shrink-0" strokeWidth={1.75} />}
          {online && <Globe className="size-4 shrink-0" strokeWidth={1.75} />}
          {table.kind === 'oda' && <Mic2 className="size-4 shrink-0" strokeWidth={1.75} />}
        </span>
      </div>
      {busy ? (
        <div className={cn('w-full', round && 'text-center')}>
          <div className="tabular text-sm font-bold leading-none @min-[6rem]:text-lg">{tlShort(total)}</div>
          <div className={cn('mt-1 hidden items-center gap-1.5 text-xs text-ink-2 @min-[6.5rem]:flex', round && 'justify-center')}>
            <span className="tabular whitespace-nowrap">{room ? `Oda ${fmtElapsed(room, now)}` : fmtElapsed(openedAt, now)}</span>
            {orders[0]?.waiterName && !round && <span className="truncate">· {orders[0].waiterName}</span>}
          </div>
          {(pending > 0 || ready > 0) && (
            <div className={cn('mt-1.5 flex gap-1 text-[11px] font-medium', round && 'justify-center')}>
              {pending > 0 && (
                <span className="tabular inline-flex items-center gap-0.5 rounded-md bg-surface/80 px-1.5 py-0.5 text-ink-2 dark:bg-surface-3">
                  <ChefHat className="size-3" strokeWidth={1.75} />
                  {pending}
                </span>
              )}
              {ready > 0 && <span className="animate-ring tabular rounded-md bg-success-600 px-1.5 py-0.5 text-white">{ready} hazır</span>}
            </div>
          )}
        </div>
      ) : reservation ? (
        <div className="w-full">
          <span className="tabular inline-flex rounded-md bg-[var(--admin-primary-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--admin-primary)]">{reservation.time}</span>
          <div className="mt-0.5 hidden truncate text-xs text-ink-2 @min-[6rem]:block">{reservation.name}</div>
        </div>
      ) : (
        <div className="hidden text-xs text-muted @min-[5rem]:block">{table.kind === 'oda' ? 'Oda · saatlik' : `${table.seats} kişilik`}</div>
      )}
    </button>
  );
}

function TakeawayModal({
  kind,
  onClose,
  onCreate,
  busy,
}: {
  kind: null | 'gelal' | 'paket';
  onClose: () => void;
  onCreate: (body: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [note, setNote] = useState('');
  if (!kind) return null;
  const submit = () => {
    onCreate({ type: kind, deliveryName: name || null, deliveryPhone: phone || null, deliveryAddress: kind === 'paket' ? address || null : null, note: note || null });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'gelal' ? 'Gel-al siparişi' : 'Paket sipariş'}
      subtitle={kind === 'paket' ? 'Müşteri ve adres bilgisi kurye fişine yazılır' : 'İsim, hazır olunca çağırmak için'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={busy} disabled={kind === 'paket' && !address.trim()} onClick={submit}>
            Siparişi aç
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 p-5 sm:grid-cols-2">
        <Field label="Ad">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Müşteri adı" autoFocus />
        </Field>
        <Field label="Telefon">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="05xx xxx xx xx" />
        </Field>
        {kind === 'paket' && (
          <Field label="Adres" className="sm:col-span-2">
            <Textarea value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Mahalle, sokak, bina, daire, tarif" />
          </Field>
        )}
        <Field label="Not" className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ör. 15 dk sonra alacak" />
        </Field>
      </div>
    </Modal>
  );
}
