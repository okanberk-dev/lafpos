import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, ChefHat, Clock, Globe, Layers, MessageSquareText, MonitorUp, Moon, MoreHorizontal, PackageCheck, PackageX, Sun, Undo2, WifiOff } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { kitchenTotals } from '@shared/kitchen';
import { ticketHead } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { KitchenTicket, KitchenTicketItem } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { EmptyState, Notice, Skeleton, Tabs } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { deliverItems } from '@/lib/handoff';
import { historyHandIds, undoStep } from '@/lib/readyToHand';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref, useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { beep, unlockAudio } from '@/lib/sound';
import { readKdsTheme, setBarTheme, useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';
import { useServiceMode } from '@/lib/serviceMode';
import { appUrl } from '@/lib/demo';

/** Bar ekranının görünümü: hazırlanacak fişler, teslim bekleyen hazırlar (son 30 dk), hazırlanmış olanlar (90 dk) */
type View = 'aktif' | 'hazir' | 'gecmis';
const VIEW_QUERY: Record<View, Record<string, string>> = { aktif: {}, hazir: { ready: '1' }, gecmis: { history: '1' } };

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function KitchenPage() {
  const boot = useBoot();
  const qc = useQueryClient();
  const setForce = useTheme((s) => s.setForce);
  // Bar ekranı cihazın tercihinde açılır (varsayılan koyu; cam önündeki tablette açık), uygulama ya da cihaz teması
  // ne olursa olsun. Kullanıcı menüsü ve komut paleti de aynı tercihi değiştirdiği için görünen durum mağazadan okunur
  const dark = useTheme((s) => s.force === 'dark');
  const [station, setStation] = useLocalPref<string>('kds.station', '');
  const [view, setView] = useState<View>('aktif');
  const history = view === 'gecmis';
  const readyView = view === 'hazir';
  const [soldOut, setSoldOut] = useState(false);
  // Telefonda araç çubuğu tek düğmeye iner: Toplam ve Tükendi bu pencerede (Fişler, Hazır, Geçmiş sekmede)
  const [more, setMore] = useState(false);
  const can = useCan();
  const mode = useServiceMode();
  const [sound, setSound] = useLocalPref<boolean>('kds.sound', true);
  // "Toplam": açık fişlerdeki ürünler toplu (6 latte, 2'si yulaflı); yoğunlukta topluca hazırlamak için
  const [totalsView, setTotalsView] = useLocalPref<boolean>('kds.toplam', false);
  const now = useTick(5_000);

  // Çizimden önce (useLayoutEffect): açık temalı cihazda yeniden yüklemede beyaz kare parlamasın. Açılışın koyusu
  // (initTheme) sayfa kendi tercihini kurunca bırakılır
  useLayoutEffect(() => {
    setBarTheme(readKdsTheme());
    useTheme.getState().releaseBootDark();
    return () => setForce(null);
  }, [setForce]);
  const toggleScreenTheme = () => setBarTheme(dark ? 'acik' : 'koyu');
  // Fiş düğmesi istek sürerken kilitlenir (çift dokunuş iki kez göndermesin)
  const [busy, setBusy] = useState<string | null>(null);

  const ticketsOf = (v: View) => ({
    queryKey: ['kitchen', station, v],
    queryFn: () => get<KitchenTicket[]>(`/kitchen?${new URLSearchParams({ ...(station ? { station } : {}), ...VIEW_QUERY[v] })}`),
    refetchInterval: 15_000,
  });
  const tickets = useQuery(ticketsOf(view));
  // Hazır sekmesinin sayısı her görünümde: teslim bekleyen sipariş barın gözünün önünde kalsın
  const ready = useQuery(ticketsOf('hazir'));

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic !== 'kitchen' || !sound) return;
        if (station && e.stationId && e.stationId !== station) return;
        if (e.kind === 'ticket.new') beep('yeni');
        if (e.kind === 'ticket.void') beep('iptal');
      }),
    [sound, station],
  );

  const setStatus = async (ids: string[], status?: KitchenTicketItem['status'], busyKey?: string) => {
    if (busyKey) setBusy(busyKey);
    try {
      await post('/kitchen/status', { itemIds: ids, status });
      await qc.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      if (busyKey) setBusy(null);
    }
  };
  const onlineStage = async (orderId: string, action: 'preparing' | 'ready', busyKey: string) => {
    setBusy(busyKey);
    try {
      await post(`/sync/online/${orderId}/stage`, { action });
      await qc.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const deliver = async (ids: string[], name: string, busyKey: string) => {
    setBusy(busyKey);
    try {
      await deliverItems(ids, name, () => qc.invalidateQueries({ queryKey: ['kitchen'] }));
    } finally {
      setBusy(null);
    }
  };

  // Geçmiş'in Geri al'ı bir adım geri: teslim edilmiş kalemler "Hazır"a, yoksa hazırlar "Hazırlanıyor"a (`undoStep`)
  const undo = async (items: KitchenTicketItem[], key: string) => {
    const step = undoStep(items);
    if (step) await setStatus(step.ids, step.status, key);
  };

  const list = useMemo(() => tickets.data ?? [], [tickets.data]);
  const totals = useMemo(() => kitchenTotals(list), [list]);
  const showTotals = totalsView && view === 'aktif';
  const counts = useMemo(() => ({ waiting: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'yeni').length, 0), making: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'hazirlaniyor').length, 0) }), [list]);

  const canSoldOut = can('urun.tukendi') || can('menu.yonet');
  const callScreen = REMOTE ? null : (
    <ToolButton onClick={() => window.open(appUrl('/cagri'), 'lafpos-cagri')} title="Çağrı ekranını yeni pencerede aç (televizyon, müşteriye dönük tablet)">
      <MonitorUp className="size-4" /> Çağrı ekranı
    </ToolButton>
  );
  const tools = (
    <>
      {view === 'aktif' && (
        <ToolButton pressed={totalsView} onClick={() => setTotalsView(!totalsView)} title="Açık fişlerdeki ürünleri topla">
          <Layers className="size-4" /> {totalsView ? 'Fişler' : 'Toplam'}
        </ToolButton>
      )}
      {canSoldOut && (
        <ToolButton onClick={() => setSoldOut(true)}>
          <PackageX className="size-4" /> Tükendi
        </ToolButton>
      )}
      <ToolButton onClick={toggleScreenTheme} title="Bu cihazda saklanır: gece koyu, güneş alan tezgâhta açık">
        {dark ? <Sun className="size-4" /> : <Moon className="size-4" />} {dark ? 'Açık ekran' : 'Koyu ekran'}
      </ToolButton>
    </>
  );

  return (
    <div className="flex h-full flex-col gap-3 bg-bg p-2 md:p-0" onPointerDown={unlockAudio}>
      {/* Başlık kartı iki satır: üstte ad, sayaçlar ve araçlar; altta istasyon sekmeleri (telefonda kayar) */}
      <div className="rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
        <div className="flex items-center gap-2 px-3 py-2 md:px-4 md:py-2.5">
          {/* Telefonda ikon yok: başlık ve sayaçlar tek satıra sığsın */}
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 max-sm:hidden">
            <ChefHat className="size-5" />
          </span>
          <h1 className="min-w-0 truncate text-lg font-semibold">Bar ve mutfak</h1>
          <div className="flex-1" />
          {view === 'aktif' && (
            // Renk dili: bekliyor nötr, hazırlanıyor mavi, hazır yeşil; amber yalnız zaman (gecikme, planlı saat)
            <div className="flex shrink-0 gap-1.5 whitespace-nowrap text-[13px] font-medium md:text-sm">
              <span className={cn('tabular inline-flex min-h-6 items-center rounded-full bg-surface-3 px-2.5 md:min-h-7 md:px-3', counts.waiting > 0 ? 'text-ink' : 'text-muted')}>{counts.waiting} bekliyor</span>
              {counts.making > 0 && <span className="tabular inline-flex min-h-6 items-center rounded-full bg-[var(--admin-blue-soft)] px-2.5 text-[var(--admin-blue)] md:min-h-7 md:px-3">{counts.making} hazırlanıyor</span>}
            </div>
          )}
          {/* Araçlar 1024 px üstünde satırda; tablet ve telefonda "Diğer" penceresinde (768 px'te satır taşıyordu) */}
          <div className="hidden items-center gap-1 lg:flex">
            {tools}
            {callScreen}
          </div>
          <IconButton label="Diğer" className="lg:hidden" onClick={() => setMore(true)}>
            <MoreHorizontal className="size-5" />
          </IconButton>
          <button onClick={() => setSound(!sound)} aria-label={sound ? 'Sesi kapat' : 'Sesi aç'} title={sound ? 'Sesi kapat' : 'Sesi aç'} aria-pressed={sound} className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors duration-150 hover:bg-hover active:bg-press">
            {sound ? <Bell className="size-[18px]" /> : <BellOff className="size-[18px] text-muted" />}
          </button>
        </div>
        {/* Görünüm ve istasyon: geniş ekranda tek satır, telefonda alt alta (istasyonlar yatay kayar) */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--admin-divider)] px-2 py-1.5 md:flex-nowrap md:px-3">
          <Tabs<View>
            label="Görünüm"
            className="shrink-0"
            value={view}
            onChange={setView}
            options={[
              { value: 'aktif', label: 'Fişler' },
              { value: 'hazir', label: 'Hazır', count: ready.data?.length },
              { value: 'gecmis', label: 'Geçmiş' },
            ]}
          />
          <span aria-hidden="true" className="h-6 w-px shrink-0 bg-[var(--admin-divider)] max-md:hidden" />
          <Tabs label="İstasyon" className="min-w-0 max-md:basis-full" value={station} onChange={setStation} options={[{ value: '', label: 'Tümü' }, ...boot.stations.map((s) => ({ value: s.id, label: s.name }))]} />
        </div>
      </div>

      <Modal open={more} onClose={() => setMore(false)} title="Bar ekranı" size="sm">
        <div className="grid gap-1.5 p-3 [&_button]:w-full [&_button]:justify-start [&_button]:px-3" onClick={() => setMore(false)}>
          {tools}
          {/* Telefonda çağrı ekranı açılmaz (televizyon ya da müşteriye dönük tablet içindir) */}
          <span className="contents max-md:hidden">{callScreen}</span>
        </div>
      </Modal>

      {/* Fişler ekrandayken bağlantı koparsa: üstte, uzaktan görünür; "sipariş yok" ile karışmasın */}
      {tickets.isError && !!tickets.data && (
        <Notice tone="danger" role="alert" icon={<WifiOff />}>
          Bağlantı koptu · son güncelleme {fmtTime(tickets.dataUpdatedAt)} · yeniden deneniyor
        </Notice>
      )}

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tickets.isPending && (
          <div role="status" aria-label="Fişler yükleniyor…" className="grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-3">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 rounded-2xl" />
            ))}
          </div>
        )}
        {tickets.isError && !tickets.data && (
          <div className="grid h-full place-items-center">
            <EmptyState large icon={<WifiOff />} title="Kasaya bağlanılamıyor">
              Yeni siparişler bu ekrana gelmiyor. Bağlantı gelince fişler kendiliğinden görünür
            </EmptyState>
          </div>
        )}
        {tickets.isSuccess && list.length === 0 && (
          <div className="grid h-full place-items-center">
            <EmptyState large icon={<CheckCheck />} title={history ? 'Son 90 dakikada hazırlanan yok' : readyView ? 'Teslim bekleyen sipariş yok' : 'Bekleyen sipariş yok'}>
              {history
                ? 'Hazır işaretlenen fişler 90 dakika burada kalır'
                : readyView
                  ? 'Hazır olan sipariş alınana dek 30 dakika burada bekler; teslim edince düşer'
                  : 'Yeni sipariş gelince ses çalar ve fiş burada belirir'}
            </EmptyState>
          </div>
        )}
        {showTotals && list.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-3">
            {totals.map((r) => (
              <article key={r.key} className="rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] p-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[19px] font-semibold leading-tight">
                      {r.name}
                      {r.size !== 'TEK' && <span className="ml-1.5 rounded-lg bg-surface-3 px-1.5 text-sm font-semibold">{r.size}</span>}
                    </span>
                    <span className="tabular mt-1 block text-[13px] text-muted">
                      {[r.waiting && `${r.waiting} bekliyor`, r.making && `${r.making} hazırlanıyor`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="tabular font-headline text-4xl font-bold leading-none tracking-tight">×{r.qty}</span>
                </div>
                {r.options.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {r.options.map((o) => (
                      <span key={o.text} className="tabular rounded-lg bg-surface-3 px-2 py-0.5 text-sm font-medium text-ink md:text-base">
                        {o.text} {o.qty}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] items-start gap-3', showTotals && 'hidden')}>
          {list.map((t) => {
            const live = t.items.filter((i) => !i.voided);
            // Hazır sekmesinde süre hazır olduğundan beri (müşteri ne zamandır almadı)
            const age = readyView ? now - Math.max(...live.map((i) => i.readyAt ?? t.sentAt)) : now - t.sentAt;
            const level = age > boot.settings.kitchenAlarmMinutes * 60_000 ? 'alarm' : age > boot.settings.kitchenWarnMinutes * 60_000 ? 'warn' : 'ok';
            const online = t.source === 'laffogato';
            const allStarted = live.every((i) => i.status !== 'yeni');
            // Self modlarda numara, yarı selfte masa no büyük rozet: barista çağıracağı ya da götürüleceği yeri görür
            const head = ticketHead(t, mode);
            const late = history || readyView ? 'ok' : level;
            const name = head.call ?? t.label;
            // Bu fişin bir isteği sürerken fişin öteki düğmeleri de kilitli (çift dokunuş iki kez göndermesin)
            const ticketBusy = !!busy && busy.startsWith(`${t.key}:`);
            return (
              // Fiş: başlık nötr; gecikince süre rozeti ve kenar renklenir (amber uyarı, kırmızı alarm). Alarm 1-2 m'den
              // de görünsün: kırmızı halka, başlık zemini ve dolu süre rozeti (koyuda yumuşak halka zeminde kayboluyordu)
              <article
                key={t.key}
                className={cn(
                  'overflow-hidden rounded-2xl border bg-surface',
                  late === 'alarm' ? 'border-transparent ring-2 ring-[var(--admin-danger)]' : late === 'warn' ? 'border-[var(--admin-warning-line)] ring-1 ring-[var(--admin-warning-line)]' : 'border-line',
                )}
              >
                <header className={cn('flex items-center gap-2 border-b border-[var(--admin-divider)] px-3 py-2.5', late === 'alarm' && 'bg-[var(--admin-danger-soft)]')}>
                  {online && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-[var(--admin-hue-violet-soft)] px-2 py-0.5 text-xs font-medium text-[var(--admin-hue-violet)]">
                      <Globe className="size-3.5" /> Online
                    </span>
                  )}
                  {head.call && (
                    <span className="tabular font-headline shrink-0 rounded-xl bg-[var(--admin-blue-soft)] px-2.5 py-0.5 text-xl font-bold leading-tight text-[var(--admin-blue)] md:px-3 md:text-2xl">{head.call}</span>
                  )}
                  {/* Nereye gideceği en büyük yazı: barın üstündeki tablet 1-2 m'den okunur */}
                  {head.label && <span className={cn('truncate', head.call ? 'text-sm text-ink-2' : 'text-xl font-bold tracking-[-0.01em] md:text-2xl')}>{head.label}</span>}
                  {head.showNo && <span className="tabular shrink-0 text-sm text-muted">#{t.orderNo}</span>}
                  {t.waiterName && <span className="min-w-0 truncate text-sm text-muted">· {t.waiterName}</span>}
                  <span className="flex-1" />
                  <span
                    className={cn(
                      'tabular inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[15px] font-semibold md:min-h-8 md:text-[17px]',
                      history ? 'bg-surface-3 text-muted' : readyView ? 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]' : late === 'alarm' ? 'bg-danger-600 text-white' : late === 'warn' ? 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]' : 'bg-surface-3 text-ink-2',
                    )}
                  >
                    {readyView ? <CheckCheck aria-hidden="true" className="size-4 md:size-[18px]" /> : <Clock aria-hidden="true" className="size-4 md:size-[18px]" />}
                    {readyView && <span className="sr-only">Hazır olalı</span>}
                    {mmss(age)}
                  </span>
                </header>
                {(t.note || t.scheduledFor) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--admin-divider)] px-3 py-2 text-sm md:text-base">
                    {t.scheduledFor && <span className="font-semibold text-[var(--admin-warning)]">Saat {fmtTime(Date.parse(t.scheduledFor))}</span>}
                    {t.note && <NoteChip>{t.note}</NoteChip>}
                  </div>
                )}
                <ul className="divide-y divide-[var(--admin-divider)]">
                  {t.items.map((i) => (
                    <li key={i.id}>
                      <button
                        // Hazır sekmesinde kaleme dokunmak bir şey yapmaz: teslim fişin düğmesiyle, geri alma Geçmiş'ten.
                        // Geçmiş'te bir adım geri: teslim edilmiş kalem "Hazır"a (hazır anı korunur), hazır kalem
                        // "Hazırlanıyor"a
                        disabled={i.voided || online || REMOTE || readyView}
                        onClick={() => setStatus([i.id], history ? (i.status === 'servis' ? 'hazir' : 'hazirlaniyor') : undefined)}
                        className={cn('flex w-full items-start gap-3 px-3 py-3 text-left transition-colors duration-150 md:py-3.5', !i.voided && !online && 'active:bg-press', i.voided && 'bg-[var(--admin-danger-soft)]')}
                      >
                        {/* Uzaktan okunur: adet, ad ve seçenek geniş ekranda büyür (telefonda bugünkü ölçü) */}
                        <span className={cn('tabular min-w-8 rounded-lg px-1.5 py-0.5 text-center text-lg font-bold md:grid md:h-10 md:min-w-10 md:place-items-center md:px-2 md:py-0 md:text-[22px]', i.voided ? 'bg-danger-600 text-white' : 'bg-surface-3')}>{i.qty}</span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-[17px] font-semibold leading-tight md:text-xl', i.voided && 'line-through opacity-70')}>
                            {i.name}
                            {i.size !== 'TEK' && <span className="ml-1.5 rounded-lg bg-surface-3 px-1.5 text-sm font-semibold md:px-2 md:text-base">{i.size}</span>}
                          </span>
                          {i.optionsText && <span className="mt-0.5 block text-sm font-medium text-ink-2 md:text-base">{i.optionsText}</span>}
                          {i.note && (
                            <span className="mt-1 block text-sm md:text-base">
                              <NoteChip>{i.note}</NoteChip>
                            </span>
                          )}
                          {i.voided && <span className="block text-sm font-bold text-[var(--admin-danger-ink)]">İPTAL EDİLDİ, YAPMAYIN</span>}
                        </span>
                        {!i.voided && <StatusDot status={i.status} />}
                      </button>
                    </li>
                  ))}
                </ul>
                <footer className={cn('flex gap-2 border-t border-[var(--admin-divider)] p-2', REMOTE && 'hidden')}>
                  {/* Ortak düğme: istek sürerken kilitli ve yükleniyor; ana eylem 48 px, 16 px yazı (uzaktan okunur) */}
                  {online ? (
                    <>
                      {!allStarted && (
                        <Button size="lg" className={FOOT} disabled={ticketBusy} loading={busy === `${t.key}:start`} onClick={() => onlineStage(t.orderId, 'preparing', `${t.key}:start`)}>
                          Hazırlanıyor
                        </Button>
                      )}
                      <Button variant="success" size="lg" className={FOOT} disabled={ticketBusy} loading={busy === `${t.key}:ready`} onClick={() => onlineStage(t.orderId, 'ready', `${t.key}:ready`)}>
                        Hazır (siteye bildir)
                      </Button>
                    </>
                  ) : readyView ? (
                    <Button variant="primary" size="lg" className={FOOT} icon={<PackageCheck className="size-5" />} disabled={ticketBusy} loading={busy === `${t.key}:deliver`} onClick={() => void deliver(live.filter((i) => i.status === 'hazir').map((i) => i.id), name, `${t.key}:deliver`)}>
                      Teslim edildi
                    </Button>
                  ) : history ? (
                    <>
                      <Button size="lg" className={FOOT} icon={<Undo2 className="size-4" />} disabled={ticketBusy} loading={busy === `${t.key}:undo`} onClick={() => void undo(live, `${t.key}:undo`)}>
                        Geri al
                      </Button>
                      {/* Teslimi geri alınan eski sipariş Hazır sekmesine dönmez (30 dk): Geçmiş'ten yeniden teslim edilir */}
                      {historyHandIds(t).length > 0 && (
                        <Button variant="primary" size="lg" className={FOOT} icon={<PackageCheck className="size-5" />} disabled={ticketBusy} loading={busy === `${t.key}:deliver`} onClick={() => void deliver(historyHandIds(t), name, `${t.key}:deliver`)}>
                          Teslim edildi
                        </Button>
                      )}
                    </>
                  ) : (
                    <>
                      {!allStarted && (
                        <Button size="lg" className={FOOT} disabled={ticketBusy} loading={busy === `${t.key}:start`} onClick={() => setStatus(live.filter((i) => i.status === 'yeni').map((i) => i.id), 'hazirlaniyor', `${t.key}:start`)}>
                          Başla
                        </Button>
                      )}
                      <Button variant="success" size="lg" className={cn(FOOT, 'flex-[2]')} disabled={ticketBusy} loading={busy === `${t.key}:ready`} onClick={() => setStatus(live.map((i) => i.id), 'hazir', `${t.key}:ready`)}>
                        Hepsi hazır
                      </Button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </div>
      <SoldOutDialog open={soldOut} onClose={() => setSoldOut(false)} />
    </div>
  );
}

/** Araç çubuğu düğmesi: Tabs ile aynı dil (basılı gri, renksiz); aria-pressed ile açık/kapalı */
function ToolButton({ pressed, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150 active:bg-press pointer-fine:min-h-9',
        pressed ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-hover hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Fiş düğmesi: 48 px yükseklik, 16 px yazı, satırı paylaşır */
const FOOT = 'h-12 flex-1 text-base';

/** Not (fişin ya da kalemin): renk yerine biçimle ayrılır, gri çip ve konuşma ikonu; amber zamana ayrılmış */
function NoteChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full items-start gap-1 rounded-lg bg-surface-3 px-1.5 py-0.5 font-medium text-ink">
      <MessageSquareText aria-hidden="true" className="mt-[3px] size-4 shrink-0 text-muted" />
      <span className="sr-only">Not:</span>
      <span className="min-w-0 break-words">{children}</span>
    </span>
  );
}

/** Kalem durumu: bekleyen içi boş gri halka (yazısız), hazırlanan dolu mavi, hazır yeşil; dolgu anlatır, nabız yok */
function StatusDot({ status }: { status: KitchenTicketItem['status'] }) {
  const map = {
    yeni: { cls: 'border-2 border-[var(--admin-border-field)]', label: 'Bekliyor' },
    hazirlaniyor: { cls: 'bg-[var(--admin-blue)]', label: 'Hazırlanıyor' },
    hazir: { cls: 'bg-[var(--admin-success)]', label: 'Hazır' },
    servis: { cls: 'bg-muted', label: 'Teslim edildi' },
  }[status];
  return (
    <span className="mt-1 flex shrink-0 flex-col items-center gap-1 text-xs font-medium text-muted" role="img" aria-label={map.label}>
      <span className={cn('size-3.5 rounded-full', map.cls)} />
      {status !== 'yeni' && <span aria-hidden="true">{map.label}</span>}
    </span>
  );
}
