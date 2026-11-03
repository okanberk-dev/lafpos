import { useMutation, useQuery } from '@tanstack/react-query';
import { Bike, CalendarClock, ChefHat, Clock3, Globe, LayoutGrid, List, Lock, Mic2, Plus, Receipt, ShoppingBag, Store, Users } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { tlShort } from '@shared/money';
import { bookingHours, bookingPayment } from '@shared/karaoke';
import { fmtAgo, fmtElapsed } from '@shared/time';
import type { FloorOrderSummary, FloorStateDTO, OrderDTO, SiteKaraokeBookingDTO, TableDTO } from '@shared/types';
import { Button, buttonClass, IconButton } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, PageLoading, Tabs } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer, useLocalPref, useMediaQuery, useTick } from '@/lib/hooks';
import { joinMeta } from '@/lib/text';
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
      toast.warn('Gün açılmadı. Önce Kasa ekranından günü açın');
      return navigate('/kasa');
    }
    open.mutate({ type: 'masa', tableId: t.id });
  };

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of boot.tables) if (floor.data?.tables[t.id]?.length) m.set(t.sectionId, (m.get(t.sectionId) ?? 0) + 1);
    return m;
  }, [boot.tables, floor.data]);

  if (floor.isPending) return <PageLoading />;
  if (floor.isError && !floor.data) {
    return (
      <div className="grid h-full place-items-center p-4">
        <ErrorState title="Masalar alınamadı" error={floor.error} retrying={floor.isFetching} onRetry={() => void floor.refetch()} />
      </div>
    );
  }
  const others = floor.data?.others ?? [];
  const reservations = floor.data?.reservations ?? [];
  // Sitedeki bugünkü karaoke rezervasyonları (odayı tutanlar): sitede tek oda var, her oda masasına aittir
  const siteKaraoke = floor.data?.siteKaraoke ?? [];
  const nextKaraoke = siteKaraoke.find((b) => Date.parse(b.endsAt) > now && !b.session?.active);
  /** Masanın kartındaki rezervasyon: yerel (masa) ya da oda için sitedeki sıradaki karaoke */
  const reservationOf = (t: TableDTO) =>
    reservations.find((r) => r.tableId === t.id) ?? (t.kind === 'oda' && nextKaraoke ? { time: String(nextKaraoke.startHour).padStart(2, '0') + ':00', name: nextKaraoke.firstName || 'Karaoke', guests: nextKaraoke.guests, status: 'site' } : undefined);
  // Özet bütün salonun (başlık "Masalar"; bölüm sekmeleri kendi dolu sayısını taşır). Hesabı istenen yalnız kasanın
  // adisyonu: sitede ödenmiş QR siparişinin hesabı yok. Söz açıklama satırı ve masa kartındaki ikonla aynı
  const occupied = boot.tables.filter((t) => (floor.data?.tables[t.id]?.length ?? 0) > 0);
  const billed = occupied.filter((t) => floor.data?.tables[t.id]?.some((o) => o.source === 'pos' && o.billPrintedAt)).length;
  const summary = joinMeta([`${boot.tables.length} masa`, `${occupied.length} dolu`, billed > 0 && `${billed} hesap istendi`]);
  // Her cihazın yeniden kullanılan boş tezgâh satışı (yeni satışın bekleme yeri) bir sipariş değil: listede birikmez.
  // Boş gel-al ve paket kalır (müşterinin adı, adresi var)
  const list = others.filter((o) => !(o.source === 'pos' && o.type === 'tezgah' && o.itemCount === 0));

  return (
    // Innex: gri zemin üstünde iki beyaz kart; telefonda kartlar kenara yapışmasın diye zeminde 8 px
    // Telefonda tek kaydırma yüzeyi (masa kartı içinde ayrı kaydırma yok); tablet ve bilgisayarda kartlar kendi içinde kayar
    <div className="flex h-full flex-col gap-3 p-2 max-md:overflow-y-auto md:p-0 lg:flex-row">
      <section className="flex min-h-0 flex-1 flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] max-md:flex-none">
        <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-divider)] px-4 py-3">
          {/* Başlık ekranın adı (kitin sayfa başlığı ölçeği); seçili bölüm hemen altındaki sekmede. Telefonda üst şerit
              "Masalar" der: başlık yalnız ekran okuyucuda kalır, özet ilk satır olur */}
          <div className="min-w-0 flex-1 basis-full sm:basis-auto">
            <h1 className="text-xl font-bold sm:text-[22px] max-md:sr-only">Masalar</h1>
            <p className="text-[13px] text-pretty text-muted md:mt-0.5">{summary}</p>
          </div>
          <div className="flex items-center gap-2 max-sm:w-full">
            {wide && (
              <div role="radiogroup" aria-label="Görünüm" className="inline-flex rounded-full bg-surface-3 p-[3px]">
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
                      'grid h-9 w-10 place-items-center rounded-full transition-colors duration-150 focus-visible:-outline-offset-2 pointer-coarse:size-11',
                      view === v ? 'bg-surface text-ink shadow-[var(--rim),var(--shadow-lift)] dark:bg-[var(--admin-border-strong)]' : 'text-muted hover:text-ink',
                    )}
                  >
                    <Icon className="size-4" />
                  </button>
                ))}
              </div>
            )}
            {!REMOTE && (
            <>
            {/* Telefonda Gel-al ve Paket ikon düğmesi; Tezgâh satışı satırın kalanını alır */}
            <Button icon={<ShoppingBag className="size-4" />} onClick={() => setTakeaway('gelal')} className="max-sm:hidden">
              Gel-al
            </Button>
            <IconButton label="Gel-al" variant="secondary" onClick={() => setTakeaway('gelal')} className="sm:hidden">
              <ShoppingBag className="size-[18px]" />
            </IconButton>
            {can('paket.yonet') && (
              <>
                <Button icon={<Bike className="size-4" />} onClick={() => setTakeaway('paket')} className="max-sm:hidden">
                  Paket
                </Button>
                <IconButton label="Paket" variant="secondary" onClick={() => setTakeaway('paket')} className="sm:hidden">
                  <Bike className="size-[18px]" />
                </IconButton>
              </>
            )}
            <Button variant="primary" className="max-sm:flex-1" icon={<Store className="size-4" />} loading={open.isPending && open.variables?.type === 'tezgah'} onClick={() => (boot.day ? open.mutate({ type: 'tezgah' }) : navigate('/kasa'))}>
              Tezgâh satışı
            </Button>
            </>
            )}
          </div>
        </header>

        {/* Gün kapalıyken kalıcı şerit: masaya dokununca yalnız toast çıkmasın; renk ikonda, metin mürekkepte */}
        {!boot.day && !REMOTE && (
          <div role="status" className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)] px-4 py-1.5 text-[13px] text-ink">
            <Lock aria-hidden="true" className="size-3.5 shrink-0 text-[var(--admin-warning)]" />
            <span className="min-w-0 flex-1">{can('kasa.gun') ? 'Gün açılmadı. Masa açmak için önce günü açın' : 'Gün açılmadı. Yetkili birinin günü açması gerekiyor'}</span>
            {can('kasa.gun') && (
              <Link to="/kasa" className={buttonClass('secondary', 'sm')}>
                Günü aç
              </Link>
            )}
          </div>
        )}

        {boot.sections.length > 1 && (
          <Tabs label="Bölümler" className="px-4 pt-3" value={section?.id ?? ''} onChange={setSectionId} options={boot.sections.map((s) => ({ value: s.id, label: s.name, count: counts.get(s.id) ?? 0 }))} />
        )}

        <div className="scroll-thin min-h-0 flex-1 overflow-auto p-4 max-md:overflow-visible">
          {tables.length === 0 ? (
            <EmptyState
              icon={<LayoutGrid />}
              title="Masa planı boş"
              action={
                can('ayar.yonet') && (
                  <Link to="/yonetim/masa-plani" className={buttonClass('primary', 'sm')}>
                    Masa planını aç
                  </Link>
                )
              }
            >
              Masaları Yönetim › Masa planı’ndan ekleyin; tezgâh, gel-al ve paket satışı masasız da çalışır
            </EmptyState>
          ) : effectiveView === 'plan' ? (
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
          <Legend className="border border-blue-line bg-blue-soft" label="Dolu" />
          <Legend className="border border-warning-line bg-warning-soft" label="Hesap istendi" />
          <Legend className="border border-rose-line bg-rose-soft" label="Kısmen ödendi" />
          <Legend className="border border-violet-line bg-violet-soft" label="Online" />
          <Legend className="border border-line bg-surface" dot label="Rezerve" />
        </footer>
      </section>

      <aside className="flex max-h-[40%] flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] max-md:max-h-none max-md:flex-none lg:max-h-none lg:w-80">
        <div className="flex min-h-12 items-center gap-2 border-b border-[var(--admin-divider)] px-4 py-2.5">
          <h2 className="flex-1 text-[15px] font-semibold">Masasız siparişler</h2>
          {/* Sayı hapı sıfırsa gizli (kit kuralı) */}
          {list.length > 0 && <span className="tabular min-w-5 rounded-full bg-surface-3 px-2 py-px text-center text-xs font-medium text-ink-2">{list.length}</span>}
        </div>
        <div className="scroll-thin flex-1 overflow-y-auto p-2">
          {list.length === 0 && (
            <EmptyState compact art="fis" title="Masasız açık sipariş yok">
              Tezgâh, gel-al, paket ve online siparişler burada
            </EmptyState>
          )}
          {list.map((o) => (
            <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors duration-150 hover:bg-hover active:bg-press">
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl [&>svg]:size-[18px]', o.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
                {o.source === 'laffogato' ? <Globe /> : o.type === 'paket' ? <Bike /> : o.type === 'gelal' ? <ShoppingBag /> : <Store />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{o.label}</span>
                <span className="text-xs text-muted">{joinMeta([o.itemCount > 0 && `${o.itemCount} ürün`, fmtAgo(o.openedAt, now)])}</span>
              </span>
              {o.itemCount === 0 ? (
                <span className="text-xs text-muted">Boş</span>
              ) : (
                <span className="tabular text-right text-sm font-semibold">
                  {tlShort(o.total)}
                  {/* Sitede ödenen tutar tahsil edilecek gibi okunmasın: mor "Sitede ödendi" (seçim penceresiyle aynı söz) */}
                  {o.source === 'laffogato' && <span className="block text-xs font-medium text-violet-ink">Sitede ödendi</span>}
                  {/* Hazırlanan mavi (bar ekranıyla aynı dil); amber yalnız zamana */}
                  {o.pendingKitchen > 0 && <span className="block text-xs font-medium text-blue-ink">{o.pendingKitchen} barda</span>}
                </span>
              )}
            </button>
          ))}
          {(reservations.length > 0 || siteKaraoke.length > 0) && (
            <div className="mt-2 border-t border-[var(--admin-divider)] px-2 pt-3">
              {/* Mikro etiket Poppins (h3 kendiliğinden Gabarito alır) */}
              <h3 className="flex items-center gap-1.5 pb-1.5 font-sans text-xs font-medium tracking-normal text-muted">
                <CalendarClock className="size-3.5" /> Bugünkü rezervasyonlar
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

      <Modal open={!!choose} onClose={() => setChoose(null)} title={choose ? `${choose.table.name} hesapları` : ''} size="sm">
        <div className="space-y-2 p-4">
          {choose?.orders.map((o) => {
            const online = o.source === 'laffogato';
            const checkNo = choose.orders.filter((x) => x.source === 'pos').indexOf(o) + 1;
            return (
              <button key={o.id} onClick={() => navigate(`/adisyon/${o.id}`)} className="flex min-h-14 w-full items-center justify-between gap-3 rounded-xl border border-line px-4 text-left transition-colors duration-150 hover:border-[var(--admin-border-field)] hover:bg-hover active:bg-press">
                <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                  {online && <Globe className="size-4 shrink-0 text-[var(--admin-hue-violet)]" />}
                  <span className="truncate">
                    {online ? 'Online sipariş' : `Hesap ${checkNo}`} <span className="text-muted">#{o.no}</span>
                  </span>
                </span>
                {online ? <span className="shrink-0 text-xs font-medium text-violet-ink">Sitede ödendi</span> : <span className="tabular shrink-0 font-semibold">{tlShort(o.total)}</span>}
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
        <Mic2 className="size-3.5 shrink-0 text-[var(--admin-hue-violet)]" aria-label="Karaoke odası" />
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
      <span className={cn('relative size-3 rounded-full', className)}>{dot && <span className="absolute inset-[2px] rounded-full bg-[var(--admin-blue-soft)] ring-1 ring-inset ring-[var(--admin-blue)]/50" />}</span>
      {label}
    </span>
  );
}

/**
 * Masa: durum dolguyla değil açık tonla (durum rozeti gibi). Boş beyaz, dolu mavi ton, hesap istendi amber, kısmen
 * ödendi pembe, yalnız sitede ödenmiş siparişi olan masa mor; bara gitmiş ve hazır kalemler küçük hap, hazır olan yeşil
 * ve dikkat çeker. Tutar kartın en büyük yazısı. Yuvarlak masada içerik dairenin ortasında (kenardaki dar kısımda değil).
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
  // Tutar, hesap ve kısmi ödeme yalnız kasanın adisyonlarından: sunucu sitede ödenmiş QR siparişini tutarı kadar ödenmiş
  // yazar; toplama girse yalnız onu olan masa borçlu "Dolu", yanında adisyon olan masa "Kısmen ödendi" görünürdü
  const pos = orders.filter((o) => o.source === 'pos');
  const online = pos.length < orders.length;
  const total = pos.reduce((a, o) => a + o.total, 0);
  const paid = pos.reduce((a, o) => a + o.paid, 0);
  const billed = pos.some((o) => o.billPrintedAt);
  const partial = paid > 0 && paid < total;
  const pending = orders.reduce((a, o) => a + o.pendingKitchen, 0);
  const ready = orders.reduce((a, o) => a + o.readyToServe, 0);
  const openedAt = Math.min(...orders.map((o) => o.openedAt));
  const room = orders.find((o) => o.roomStartedAt)?.roomStartedAt ?? null;
  // Açılmış ama sipariş girilmemiş adisyon "₺0" yazmaz (çalışan oda sayacı boş sayılmaz: ücreti kalemde görünmez)
  const empty = pos.length > 0 && !room && pos.every((o) => o.itemCount === 0);
  const tone = !busy ? 'free' : !pos.length ? 'online' : partial ? 'partial' : billed ? 'billed' : 'busy';
  const round = table.shape === 'round';

  return (
    <button
      onClick={onClick}
      style={style}
      className={cn(
        '@container group flex flex-col overflow-hidden border p-3 text-left transition-[border-color,background-color,transform,box-shadow] duration-150 active:scale-[0.98] motion-reduce:active:scale-100',
        round ? 'items-center justify-center gap-1 rounded-[999px] text-center' : cn('rounded-2xl', busy || reservation ? 'justify-between' : 'justify-start gap-1'),
        tone === 'free' && 'border-line bg-surface shadow-[var(--shadow-card)] hover:border-[var(--admin-border-field)]',
        // Durum çizgisi belirteçleri iki temada da görünür (koyuda dolu, hesap istendi ve kısmen ödendi karışmasın)
        tone === 'busy' && 'border-blue-line bg-blue-soft hover:border-[var(--admin-blue)]',
        tone === 'billed' && 'border-warning-line bg-warning-soft hover:border-[var(--admin-warning)]',
        tone === 'partial' && 'border-rose-line bg-rose-soft hover:border-[var(--admin-hue-rose)]',
        // Online (siteden gelen) sipariş her ekranda mor; kenarı öteki durumlar gibi kendi çizgi belirteci
        tone === 'online' && 'border-violet-line bg-violet-soft hover:border-[var(--admin-hue-violet)]',
        className,
      )}
    >
      <div className={cn('flex w-full items-start gap-1', round && 'justify-center')}>
        {/* Boş masanın adı hafif, dolununki koyu: dolu masa kol mesafesinden seçilir */}
        <span className={cn('truncate text-sm leading-tight @min-[6rem]:text-[15px]', busy ? 'font-semibold text-ink' : 'font-medium text-ink-2')}>{table.name}</span>
        {!round && <span className="flex-1" />}
        <span className="flex gap-1 text-ink-2">
          {billed && <Receipt className="size-4 shrink-0" aria-label="Hesap istendi" />}
          {/* Online her boyda ve mor: adisyonlu masada da sitedeki sipariş görünür kalır */}
          {online && <Globe className="size-4 shrink-0 text-violet-ink" aria-label="Online sipariş" />}
          {table.kind === 'oda' && <Mic2 className="hidden size-4 shrink-0 @min-[6rem]:block" aria-label="Oda" />}
        </span>
      </div>
      {busy ? (
        <div className={cn('w-full', round && 'text-center')}>
          {tone === 'online' ? (
            // Tahsil edilecek bir şey yok: tutar yerine söz
            <div className="text-[13px] font-semibold leading-tight text-violet-ink">Sitede ödendi</div>
          ) : empty ? (
            <div className="text-[13px] font-medium leading-tight text-ink-2">Boş adisyon</div>
          ) : (
            <div className="tabular font-headline text-[17px] font-bold leading-none tracking-[-0.02em] @min-[6rem]:text-[22px]">{tlShort(total)}</div>
          )}
          {/* Kısmen ödendi: renk tek başına taşımaz, kalan tutar yazılır */}
          {partial && <div className="tabular mt-0.5 text-xs font-medium text-[var(--admin-hue-rose)]">{tlShort(total - paid)} kaldı</div>}
          {/* Meta satırı: bir dakikadan kısa süre "az önce" ("0 dk" değil), ayraç joinMeta'nın (eşit boşluk); oda sayacı süre */}
          <div className="mt-1 hidden min-w-0 truncate text-xs text-ink-2 @min-[6.5rem]:block">
            <span className="tabular">{joinMeta([room ? `Oda ${fmtElapsed(room, now)}` : fmtAgo(openedAt, now), !round && pos[0]?.waiterName])}</span>
          </div>
          {(pending > 0 || ready > 0) && (
            <div className={cn('mt-1.5 flex gap-1 text-[11px] font-medium', round && 'justify-center')}>
              {pending > 0 && (
                <span className="tabular inline-flex items-center gap-0.5 rounded-full bg-surface px-2 py-0.5 text-ink-2 ring-1 ring-inset ring-blue-line" title={`${pending} kalem barda`}>
                  <ChefHat className="size-3" />
                  {pending}
                </span>
              )}
              {ready > 0 && <span className="animate-ring tabular rounded-full bg-success-600 px-2 py-0.5 text-white">{ready} hazır</span>}
            </div>
          )}
        </div>
      ) : reservation ? (
        <div className="w-full">
          <span className="tabular inline-flex rounded-full bg-[var(--admin-blue-soft)] px-2 py-0.5 text-xs font-medium text-[var(--admin-blue)]">{reservation.time}</span>
          <div className="mt-0.5 hidden truncate text-xs text-ink-2 @min-[6rem]:block">{reservation.name}</div>
        </div>
      ) : (
        // Odanın ikonu köşede (mikrofon); satırda ücretin türü
        <span className={cn('hidden items-center gap-1 text-[13px] text-ink-2 @min-[5rem]:inline-flex', round && 'justify-center')}>
          {table.kind === 'oda' ? <Clock3 aria-hidden="true" className="size-3.5 shrink-0" /> : <Users aria-hidden="true" className="size-3.5 shrink-0" />}
          {table.kind === 'oda' ? 'Saatlik ücret' : `${table.seats} kişilik`}
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
  const [addressError, setAddressError] = useState<string | null>(null);
  const addressRef = useRef<HTMLTextAreaElement>(null);
  const fine = useFinePointer();
  if (!kind) return null;
  const submit = () => {
    // Paket adressiz açılmaz: düğme sessizce soluk kalmaz, ileti alanın altında
    if (kind === 'paket' && !address.trim()) {
      setAddressError('Adres gerekli');
      addressRef.current?.focus();
      return;
    }
    onCreate({ type: kind, deliveryName: name || null, deliveryPhone: phone || null, deliveryAddress: kind === 'paket' ? address || null : null, note: note || null });
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={kind === 'gelal' ? 'Gel-al siparişi' : 'Paket siparişi'}
      subtitle={kind === 'paket' ? 'Müşteri ve adres bilgisi kurye fişine yazılır' : 'Sipariş hazır olunca bu adla çağrılır'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" loading={busy} onClick={submit}>
            Siparişi aç
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 p-5 sm:grid-cols-2">
        <Field label="Ad">
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ör. Ayşe" autoFocus={fine} autoCapitalize="words" enterKeyHint="next" />
        </Field>
        <Field label="Telefon">
          <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" spellCheck={false} placeholder="Ör. 0532 123 45 67" />
        </Field>
        {kind === 'paket' && (
          <Field label="Adres" className="sm:col-span-2" required error={addressError}>
            <Textarea
              ref={addressRef}
              value={address}
              onChange={(e) => {
                setAddress(e.target.value);
                setAddressError(null);
              }}
              autoComplete="off"
              spellCheck={false}
              placeholder="Ör. mahalle, sokak, bina, daire, tarif"
            />
          </Field>
        )}
        <Field label="Not" className="sm:col-span-2">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ör. 15 dk sonra alacak" />
        </Field>
      </div>
    </Modal>
  );
}
