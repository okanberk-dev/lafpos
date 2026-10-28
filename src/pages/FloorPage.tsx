import { useMutation, useQuery } from '@tanstack/react-query';
import { Bike, CalendarClock, ChefHat, Globe, LayoutGrid, List, Mic2, Plus, Receipt, ShoppingBag, Store, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { tlShort } from '@shared/money';
import { bookingHours, bookingPayment } from '@shared/karaoke';
import { fmtElapsed } from '@shared/time';
import type { FloorOrderSummary, FloorStateDTO, OrderDTO, SiteKaraokeBookingDTO, TableDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, PageLoading, Tabs } from '@/components/ui/misc';
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
    // Sitede ödenmiş QR siparişi masanın adisyonu değil: masada yalnız o varsa da seçim açılır, garson yeni hesap açabilir
    if (orders.length === 1 && orders[0].source === 'pos') return navigate(`/adisyon/${orders[0].id}`);
    if (orders.length) return setChoose({ table: t, orders });
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
  // Sitedeki bugünkü karaoke rezervasyonları (odayı tutanlar): sitede tek oda var, her oda masasına aittir
  const siteKaraoke = floor.data?.siteKaraoke ?? [];
  const nextKaraoke = siteKaraoke.find((b) => Date.parse(b.endsAt) > now && !b.session?.active);
  /** Masanın kartındaki rezervasyon: yerel (masa) ya da oda için sitedeki sıradaki karaoke */
  const reservationOf = (t: TableDTO) =>
    reservations.find((r) => r.tableId === t.id) ?? (t.kind === 'oda' && nextKaraoke ? { time: String(nextKaraoke.startHour).padStart(2, '0') + ':00', name: nextKaraoke.firstName || 'Karaoke', guests: nextKaraoke.guests, status: 'site' } : undefined);
  const busyTables = tables.filter((t) => (floor.data?.tables[t.id]?.length ?? 0) > 0);
  const billed = busyTables.filter((t) => floor.data?.tables[t.id]?.some((o) => o.billPrintedAt)).length;
  const summary = [`${tables.length} masa`, `${busyTables.length} dolu`, billed ? `${billed} hesap bekliyor` : null].filter(Boolean).join(' · ');

  return (
    // Innex: gri zemin üstünde iki beyaz kart; telefonda kartlar kenara yapışmasın diye zeminde 8 px
    // Telefonda tek kaydırma yüzeyi (masa kartı içinde ayrı kaydırma yok); tablet ve bilgisayarda kartlar kendi içinde kayar
    <div className="flex h-full flex-col gap-3 p-2 max-md:overflow-y-auto md:p-0 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-surface max-md:flex-none">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-divider)] px-4 py-3">
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h1 className="text-lg font-semibold tracking-[-0.01em]">{section?.name ?? 'Masalar'}</h1>
            <p className="text-[13px] text-muted">{summary}</p>
          </div>
          <div className="flex items-center gap-2 max-sm:w-full">
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
            {/* Telefonda Gel-al ve Paket ikon düğmesi; Tezgâh satışı satırın kalanını alır (cn sınıf birleştirmez: gizleme max-sm: ile) */}
            <Button icon={<ShoppingBag className="size-4" strokeWidth={1.75} />} onClick={() => setTakeaway('gelal')} className="max-sm:hidden">
              Gel-al
            </Button>
            <IconButton label="Gel-al" variant="secondary" onClick={() => setTakeaway('gelal')} className="sm:hidden">
              <ShoppingBag className="size-[18px]" strokeWidth={1.75} />
            </IconButton>
            {can('paket.yonet') && (
              <>
                <Button icon={<Bike className="size-4" strokeWidth={1.75} />} onClick={() => setTakeaway('paket')} className="max-sm:hidden">
                  Paket
                </Button>
                <IconButton label="Paket" variant="secondary" onClick={() => setTakeaway('paket')} className="sm:hidden">
                  <Bike className="size-[18px]" strokeWidth={1.75} />
                </IconButton>
              </>
            )}
            <Button variant="primary" className="max-sm:flex-1" icon={<Store className="size-4" strokeWidth={1.75} />} loading={open.isPending && open.variables?.type === 'tezgah'} onClick={() => (boot.day ? open.mutate({ type: 'tezgah' }) : navigate('/kasa'))}>
              Tezgâh satışı
            </Button>
            </>
            )}
          </div>
        </header>

        {boot.sections.length > 1 && (
          <Tabs label="Bölümler" className="px-4 pt-3" value={section?.id ?? ''} onChange={setSectionId} options={boot.sections.map((s) => ({ value: s.id, label: s.name, count: counts.get(s.id) ?? 0 }))} />
        )}

        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4 max-md:overflow-visible">
          {effectiveView === 'plan' ? (
            <div className="relative mx-auto aspect-[16/10] w-full max-w-6xl">
              {tables.map((t) => (
                <TableTile
                  key={t.id}
                  table={t}
                  orders={floor.data?.tables[t.id] ?? []}
                  reservation={reservationOf(t)}
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
                <TableTile key={t.id} table={t} orders={floor.data?.tables[t.id] ?? []} reservation={reservationOf(t)} now={now} onClick={() => tapTable(t)} className="min-h-24 md:h-28" />
              ))}
            </div>
          )}
        </div>
        <footer className="hidden flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--admin-divider)] px-4 py-2.5 text-xs text-muted sm:flex">
          <Legend className="border border-line bg-surface" label="Boş" />
          <Legend className="border border-brand-200 bg-brand-50 dark:border-brand-800 dark:bg-[var(--admin-primary-soft)]" label="Dolu" />
          <Legend className="border border-warn-200 bg-warn-100 dark:border-warn-800 dark:bg-[var(--admin-warning-soft)]" label="Hesap istendi" />
          <Legend className="border border-rose-300 bg-rose-100 dark:border-transparent dark:bg-[var(--admin-hue-rose-soft)]" label="Kısmen ödendi" />
          <Legend className="border border-line bg-surface" dot label="Rezerve" />
        </footer>
      </section>

      <aside className="flex max-h-[40%] flex-col rounded-2xl border border-line bg-surface max-md:max-h-none max-md:flex-none lg:max-h-none lg:w-80">
        <div className="flex min-h-12 items-center gap-2 border-b border-[var(--admin-divider)] px-4 py-2.5">
          <h2 className="flex-1 text-[15px] font-semibold">Masasız siparişler</h2>
          <span className="tabular min-w-5 rounded-md bg-surface-3 px-1.5 py-px text-center text-xs font-medium text-ink-2">{others.length}</span>
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-2">
          {others.length === 0 && (
            <EmptyState compact icon={<Store />} title="Masasız açık sipariş yok">
              Tezgâh, gel-al, paket ve online siparişler burada
            </EmptyState>
          )}
          {others.map((o) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3">
              <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', o.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
                {o.source === 'laffogato' ? <Globe strokeWidth={1.75} /> : o.type === 'paket' ? <Bike strokeWidth={1.75} /> : o.type === 'gelal' ? <ShoppingBag strokeWidth={1.75} /> : <Store strokeWidth={1.75} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{o.label}</span>
                <span className="text-xs text-muted">
                  {fmtElapsed(o.openedAt, now)} · {o.itemCount} ürün
                </span>
              </span>
              {o.itemCount === 0 ? (
                <span className="text-xs text-muted">Boş</span>
              ) : (
                <span className="tabular text-right text-sm font-semibold">
                  {tlShort(o.total)}
                  {o.pendingKitchen > 0 && <span className="block text-xs font-medium text-[var(--admin-warning)]">{o.pendingKitchen} hazırlanıyor</span>}
                </span>
              )}
            </button>
          ))}
          {(reservations.length > 0 || siteKaraoke.length > 0) && (
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
              {siteKaraoke.map((b) => (
                <SiteKaraokeRow key={b.id} booking={b} past={Date.parse(b.endsAt) <= now} />
              ))}
            </div>
          )}
        </div>
      </aside>

      <Modal open={!!choose} onClose={() => setChoose(null)} title={choose ? `${choose.table.name}: hesaplar` : ''} size="sm">
        <div className="space-y-2 p-4">
          {choose?.orders.map((o) => {
            const online = o.source === 'laffogato';
            const checkNo = choose.orders.filter((x) => x.source === 'pos').indexOf(o) + 1;
            return (
              <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-line px-4 text-left transition-colors hover:border-[var(--admin-border-field)] hover:bg-surface-2 active:bg-surface-3">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  {online && <Globe className="size-4 shrink-0 text-[var(--admin-hue-violet)]" strokeWidth={1.75} />}
                  <span className="truncate">
                    {online ? 'Online sipariş' : `Hesap ${checkNo}`} <span className="text-muted">#{o.no}</span>
                  </span>
                </span>
                {online ? <span className="shrink-0 text-xs text-muted">Sitede ödendi</span> : <span className="tabular shrink-0 font-semibold">{tlShort(o.total)}</span>}
              </button>
            );
          })}
          <Button block icon={<Plus className="size-4" />} onClick={() => choose && open.mutate({ type: 'masa', tableId: choose.table.id, newCheck: true })}>
            {choose?.orders.some((o) => o.source === 'pos') ? 'Yeni ayrı hesap aç' : 'Yeni hesap aç'}
          </Button>
        </div>
      </Modal>

      <TakeawayModal kind={takeaway} onClose={() => setTakeaway(null)} onCreate={(body) => open.mutate(body)} busy={open.isPending} />
    </div>
  );
}

/** Sitedeki karaoke rezervasyonu (yan listede): saat aralığı, ad, kişi, ödeme durumu, not */
function SiteKaraokeRow({ booking: b, past }: { booking: SiteKaraokeBookingDTO; past: boolean }) {
  const pay = bookingPayment(b);
  return (
    <div className={cn('rounded-lg px-1 py-1.5 text-sm', past && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <Mic2 className="size-3.5 shrink-0 text-[var(--admin-hue-violet)]" strokeWidth={1.75} aria-label="Karaoke odası" />
        <span className="tabular font-semibold">{bookingHours(b)}</span>
        <span className="min-w-0 flex-1 truncate">{b.firstName || 'Adsız'}</span>
        <span className="text-xs text-muted">{b.guests} kişi</span>
      </div>
      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 pl-5">
        <Badge tone={pay.tone}>{pay.text}</Badge>
        {b.session?.active && <span className="text-xs text-muted">#{b.session.orderNo} sayaçta</span>}
      </div>
      {b.note && (
        <div className="truncate pl-5 text-xs italic text-ink-2" title={b.note}>
          {b.note}
        </div>
      )}
    </div>
  );
}

/** Açıklama satırı: kutucuk kartın tonuyla aynı; Rezerve, karttaki saat çipinin mavi hapı */
function Legend({ className, dot, label }: { className: string; dot?: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={cn('relative size-3 rounded-[4px]', className)}>{dot && <span className="absolute inset-[2px] rounded-[2px] bg-[var(--admin-primary-soft)] ring-1 ring-inset ring-[var(--admin-primary)]/50" />}</span>
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
        '@container group flex flex-col overflow-hidden border p-2.5 text-left transition-[border-color,background-color,transform] duration-100 active:scale-[0.98] motion-reduce:active:scale-100',
        busy || reservation ? 'justify-between' : 'justify-start gap-1',
        round ? 'items-center rounded-[999px] text-center' : 'rounded-xl',
        tone === 'free' && 'border-line bg-surface hover:border-[var(--admin-border-field)]',
        tone === 'busy' && 'border-brand-200 bg-brand-50 hover:border-brand-300 dark:border-brand-800 dark:bg-[var(--admin-primary-soft)]',
        tone === 'billed' && 'border-warn-200 bg-warn-100 hover:border-warn-300 dark:border-warn-800 dark:bg-[var(--admin-warning-soft)]',
        tone === 'partial' && 'border-rose-300 bg-rose-100 hover:border-rose-500 dark:border-transparent dark:bg-[var(--admin-hue-rose-soft)]',
        className,
      )}
    >
      <div className={cn('flex w-full items-start gap-1', round && 'justify-center')}>
        {/* Boş masanın adı hafif, dolununki koyu: dolu masa kol mesafesinden seçilir */}
        <span className={cn('truncate text-sm leading-tight @min-[6rem]:text-[15px]', busy ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>{table.name}</span>
        {!round && <span className="flex-1" />}
        <span className="flex gap-1 text-ink-2">
          {billed && <Receipt className="size-4 shrink-0" strokeWidth={1.75} aria-label="Hesap istendi" />}
          {online && <Globe className="hidden size-4 shrink-0 @min-[6rem]:block" strokeWidth={1.75} aria-label="Online sipariş" />}
          {table.kind === 'oda' && <Mic2 className="hidden size-4 shrink-0 @min-[6rem]:block" strokeWidth={1.75} aria-label="Oda" />}
        </span>
      </div>
      {busy ? (
        <div className={cn('w-full', round && 'text-center')}>
          <div className="tabular text-sm font-bold leading-none @min-[6rem]:text-lg">{tlShort(total)}</div>
          {/* Kısmen ödendi: renk tek başına taşımaz, kalan tutar yazılır */}
          {partial && <div className="tabular mt-0.5 text-xs font-medium text-[var(--admin-hue-rose)]">{tlShort(total - paid)} kaldı</div>}
          <div className={cn('mt-1 hidden items-center gap-1.5 text-xs text-ink-2 @min-[6.5rem]:flex', round && 'justify-center')}>
            <span className="tabular whitespace-nowrap">{room ? `Oda ${fmtElapsed(room, now)}` : fmtElapsed(openedAt, now)}</span>
            {orders[0]?.waiterName && !round && <span className="truncate">· {orders[0].waiterName}</span>}
          </div>
          {(pending > 0 || ready > 0) && (
            <div className={cn('mt-1.5 flex gap-1 text-[11px] font-medium', round && 'justify-center')}>
              {pending > 0 && (
                <span className="tabular inline-flex items-center gap-0.5 rounded-md bg-surface px-1.5 py-0.5 text-ink-2 ring-1 ring-inset ring-brand-200 dark:bg-surface-3 dark:ring-brand-800" title={`${pending} kalem barda`}>
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
        <span className={cn('hidden items-center gap-1 text-[13px] text-ink-2 @min-[5rem]:inline-flex', round && 'justify-center')}>
          {table.kind === 'oda' ? <Mic2 className="size-3.5 shrink-0" strokeWidth={1.75} /> : <Users className="size-3.5 shrink-0" strokeWidth={1.75} />}
          {table.kind === 'oda' ? 'Saatlik' : `${table.seats} kişilik`}
        </span>
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
