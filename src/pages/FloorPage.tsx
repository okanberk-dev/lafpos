import { useMutation, useQuery } from '@tanstack/react-query';
import { Bike, CalendarClock, ChefHat, Globe, LayoutGrid, List, Mic2, Plus, Receipt, ShoppingBag, Store } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { tlCompact } from '@shared/money';
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
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), refetchInterval: 60_000 });

  const section = boot.sections.find((s) => s.id === sectionId) ?? boot.sections[0];
  const tables = boot.tables.filter((t) => t.sectionId === section?.id);
  const effectiveView = wide ? view : 'liste';

  const open = useMutation({
    mutationFn: (body: Record<string, unknown>) => post<OrderDTO>('/orders', body),
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

  return (
    <div className="flex h-full flex-col lg:flex-row">
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
          <div className="no-scrollbar flex w-full gap-1.5 overflow-x-auto xl:w-auto xl:flex-1">
            {boot.sections.map((s) => (
              <button
                key={s.id}
                onClick={() => setSectionId(s.id)}
                className={cn(
                  'flex shrink-0 items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition pointer-coarse:min-h-11',
                  s.id === section?.id ? 'bg-forest-700 text-cream' : 'bg-surface-2 text-ink-2 hover:bg-surface-3',
                )}
              >
                {s.name}
                {!!counts.get(s.id) && <span className={cn('rounded-full px-1.5 text-xs', s.id === section?.id ? 'bg-cream/20' : 'bg-forest-100 text-forest-700')}>{counts.get(s.id)}</span>}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2 xl:flex-nowrap">
            {wide && (
              <div className="flex rounded-xl border border-line bg-surface-2 p-1">
                <button aria-label="Plan görünümü" aria-pressed={view === 'plan'} onClick={() => setView('plan')} className={cn('grid size-7 place-items-center rounded-lg pointer-coarse:size-11', view === 'plan' && 'bg-surface shadow-sm')}>
                  <LayoutGrid className="size-4" />
                </button>
                <button aria-label="Liste görünümü" aria-pressed={view === 'liste'} onClick={() => setView('liste')} className={cn('grid size-7 place-items-center rounded-lg pointer-coarse:size-11', view === 'liste' && 'bg-surface shadow-sm')}>
                  <List className="size-4" />
                </button>
              </div>
            )}
            <Button variant="primary" icon={<Store className="size-4" />} loading={open.isPending && open.variables?.type === 'tezgah'} onClick={() => (boot.day ? open.mutate({ type: 'tezgah' }) : navigate('/kasa'))}>
              Tezgâh satışı
            </Button>
            <Button icon={<ShoppingBag className="size-4" />} onClick={() => setTakeaway('gelal')} className="hidden sm:inline-flex">
              Gel-al
            </Button>
            {can('paket.yonet') && (
              <Button icon={<Bike className="size-4" />} onClick={() => setTakeaway('paket')} className="hidden sm:inline-flex">
                Paket
              </Button>
            )}
          </div>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4">
          {effectiveView === 'plan' ? (
            <div className="relative mx-auto aspect-[16/10] w-full max-w-6xl rounded-3xl border border-line bg-[radial-gradient(circle_at_1px_1px,var(--line)_1px,transparent_0)] bg-[length:24px_24px] bg-surface/60">
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
            <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-3">
              {tables.map((t) => (
                <TableTile key={t.id} table={t} orders={floor.data?.tables[t.id] ?? []} reservation={reservations.find((r) => r.tableId === t.id)} now={now} onClick={() => tapTable(t)} className="h-32" />
              ))}
            </div>
          )}
          <div className="mt-4 flex flex-wrap items-center gap-4 text-xs text-muted">
            <Legend className="border-2 border-dashed border-line-strong bg-surface" label="Boş" />
            <Legend className="bg-forest-600" label="Dolu" />
            <Legend className="bg-brass-500" label="Hesap istendi" />
            <Legend className="bg-rose-500" label="Kısmen ödendi" />
            <Legend className="border-2 border-rose-500 bg-surface" label="Rezerve" />
          </div>
        </div>
      </div>

      <aside className="flex max-h-[40%] flex-col border-t border-line bg-surface lg:max-h-none lg:w-80 lg:border-l lg:border-t-0">
        <div className="flex items-center justify-between px-4 py-3">
          <h2 className="font-semibold">Masasız siparişler</h2>
          <span className="text-sm text-muted">{others.length}</span>
        </div>
        <div className="scroll-thin flex-1 space-y-2 overflow-y-auto px-3 pb-3">
          {others.length === 0 && <p className="px-2 py-6 text-center text-sm text-muted">Açık tezgâh, gel-al, paket ya da online sipariş yok</p>}
          {others.map((o) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-3 text-left hover:bg-surface-2">
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', o.source === 'laffogato' ? 'bg-rose-100 text-rose-700' : 'bg-forest-100 text-forest-700')}>
                {o.source === 'laffogato' ? <Globe className="size-5" /> : o.type === 'paket' ? <Bike className="size-5" /> : o.type === 'gelal' ? <ShoppingBag className="size-5" /> : <Store className="size-5" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{o.label}</span>
                <span className="text-xs text-muted">
                  #{o.no} · {fmtElapsed(o.openedAt, now)} · {o.itemCount} ürün
                </span>
              </span>
              <span className="tabular text-right font-semibold">
                {tlCompact(o.total)} ₺{o.pendingKitchen > 0 && <span className="block text-xs font-normal text-brass-600">{o.pendingKitchen} hazırlanıyor</span>}
              </span>
            </button>
          ))}
          {reservations.length > 0 && (
            <div className="pt-3">
              <h3 className="flex items-center gap-1.5 px-1 pb-2 text-sm font-semibold">
                <CalendarClock className="size-4" /> Bugünkü rezervasyonlar
              </h3>
              {reservations.map((r) => (
                <div key={r.id} className="flex items-center gap-2 rounded-xl px-2 py-1.5 text-sm">
                  <span className="tabular font-semibold">{r.time}</span>
                  <span className="flex-1 truncate">{r.name}</span>
                  <span className="text-muted">{r.guests} kişi</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>

      <Modal open={!!choose} onClose={() => setChoose(null)} title={choose ? `${choose.table.name}: ayrı hesaplar` : ''} size="sm">
        <div className="space-y-2 p-4">
          {choose?.orders.map((o, i) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center justify-between rounded-2xl border border-line p-4 hover:bg-surface-2">
              <span className="font-medium">
                Hesap {i + 1} <span className="text-sm text-muted">#{o.no}</span>
              </span>
              <span className="tabular font-semibold">{tlCompact(o.total)} ₺</span>
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

function Legend({ className, label }: { className: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('size-3 rounded', className)} />
      {label}
    </span>
  );
}

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
        '@container group flex flex-col justify-between overflow-hidden p-2 text-left transition active:scale-[0.97]',
        round ? 'items-center rounded-[999px] text-center' : 'rounded-2xl',
        tone === 'free' && (reservation ? 'border-2 border-rose-500 bg-surface' : 'border-2 border-dashed border-line-strong bg-surface hover:border-forest-400'),
        tone === 'busy' && 'bg-forest-600 text-white shadow-[var(--shadow-card)]',
        tone === 'billed' && 'bg-brass-500 text-espresso shadow-[var(--shadow-card)]',
        tone === 'partial' && 'bg-rose-500 text-white shadow-[var(--shadow-card)]',
        className,
      )}
    >
      <div className={cn('flex w-full items-start gap-1', round && 'justify-center')}>
        <span className="truncate text-sm font-semibold leading-tight @min-[6rem]:text-base">{table.name}</span>
        {!round && <span className="flex-1" />}
        <span className="hidden gap-1 @min-[6rem]:flex">
          {billed && <Receipt className="size-4 shrink-0 opacity-80" />}
          {online && <Globe className="size-4 shrink-0 opacity-80" />}
          {table.kind === 'oda' && <Mic2 className="size-4 shrink-0 opacity-80" />}
        </span>
      </div>
      {busy ? (
        <div className={cn('w-full', round && 'text-center')}>
          <div className="tabular text-sm font-semibold leading-none @min-[6rem]:text-lg">{tlCompact(total)} ₺</div>
          <div className={cn('mt-1 hidden items-center gap-1.5 text-[11px] opacity-90 @min-[6.5rem]:flex', round && 'justify-center')}>
            <span className="whitespace-nowrap">{room ? `Oda ${fmtElapsed(room, now)}` : fmtElapsed(openedAt, now)}</span>
            {orders[0]?.waiterName && !round && <span className="truncate">· {orders[0].waiterName}</span>}
          </div>
          {(pending > 0 || ready > 0) && (
            <div className={cn('mt-1 flex gap-1 text-[11px] font-semibold', round && 'justify-center')}>
              {pending > 0 && (
                <span className="inline-flex items-center gap-0.5 rounded-full bg-black/20 px-1.5 py-0.5">
                  <ChefHat className="size-3" />
                  {pending}
                </span>
              )}
              {ready > 0 && <span className="animate-ring rounded-full bg-white px-1.5 py-0.5 text-forest-700">{ready} hazır</span>}
            </div>
          )}
        </div>
      ) : reservation ? (
        <div className="w-full text-xs text-rose-700">
          <div className="font-semibold">{reservation.time}</div>
          <div className="hidden truncate @min-[6rem]:block">{reservation.name}</div>
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
