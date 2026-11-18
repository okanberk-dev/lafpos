import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlarmClock, Ban, Bell, BellOff, CheckCheck, ChefHat, CircleCheck, CircleDashed, Clock, Flame, Globe, Layers, MessageSquareText, MonitorUp, Moon, MoreHorizontal, PackageCheck, PackageX, Sun, Undo2, WifiOff } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { kitchenTotals } from '@shared/kitchen';
import { PLATFORM_COLOR, PLATFORM_LABEL } from '@shared/platforms';
import { ticketHead } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { KitchenTicket, KitchenTicketItem } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, Notice, Skeleton, Tabs } from '@/components/ui/misc';
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
  // Tek istasyonda ray gizli, süzgeç yok (Tümü ile aynı); silinmiş istasyonun kaydı da Tümü'ye düşer: ray gizliyken
  // ekran boş kalmasın
  const activeStation = boot.stations.length > 1 && boot.stations.some((s) => s.id === station) ? station : '';
  // Fiş düğmesi istek sürerken kilitlenir (çift dokunuş iki kez göndermesin)
  const [busy, setBusy] = useState<string | null>(null);

  const ticketsOf = (v: View) => ({
    queryKey: ['kitchen', activeStation, v],
    queryFn: () => get<KitchenTicket[]>(`/kitchen?${new URLSearchParams({ ...(activeStation ? { station: activeStation } : {}), ...VIEW_QUERY[v] })}`),
    refetchInterval: 15_000,
  });
  const tickets = useQuery(ticketsOf(view));
  // Hazır sekmesinin sayısı her görünümde: teslim bekleyen sipariş barın gözünün önünde kalsın
  const ready = useQuery(ticketsOf('hazir'));

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic !== 'kitchen' || !sound) return;
        if (activeStation && e.stationId && e.stationId !== activeStation) return;
        if (e.kind === 'ticket.new') beep('yeni');
        if (e.kind === 'ticket.void') beep('iptal');
      }),
    [sound, activeStation],
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
      // Düğmenin adı kasa fişindeki gibi "Hepsi hazır"; siteye gittiğini bildirim söyler
      if (action === 'ready') toast.ok('Hazır olduğu siteye bildirildi');
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
  // Gecikme: uyarı süresini geçen açık fiş (alarm ayrıca sayılır; şeritte kırmızı)
  const lateCounts = useMemo(() => {
    if (view !== 'aktif') return { late: 0, alarm: 0 };
    const warnMs = boot.settings.kitchenWarnMinutes * 60_000;
    const alarmMs = boot.settings.kitchenAlarmMinutes * 60_000;
    const open = list.filter((t) => t.items.some((i) => !i.voided));
    return { late: open.filter((t) => now - t.sentAt > warnMs).length, alarm: open.filter((t) => now - t.sentAt > alarmMs).length };
  }, [list, view, now, boot.settings.kitchenWarnMinutes, boot.settings.kitchenAlarmMinutes]);

  const canSoldOut = can('urun.tukendi') || can('menu.yonet');
  const callScreen = REMOTE ? null : (
    <ToolButton onClick={() => window.open(appUrl('/cagri'), 'lafpos-cagri')} title="Çağrı ekranını yeni pencerede aç (televizyon, müşteriye dönük tablet)">
      <MonitorUp className="size-4" /> Çağrı ekranı
    </ToolButton>
  );
  const tools = (
    <>
      {view === 'aktif' && (
        // Aç-kapa düğmesi adını değiştirmez (yanındaki "Fişler" sekmesiyle karışıyordu); durumu aria-pressed ve gri zemin
        <ToolButton pressed={totalsView} onClick={() => setTotalsView(!totalsView)} title={totalsView ? 'Fişlere dön' : 'Açık fişlerdeki ürünleri topla'}>
          <Layers className="size-4" /> Toplam
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
    // Kitin sahnesi (Whiteboard düzeni): gri sahnede üstte cam çubuk, altında sayaç şeridi ve fiş ızgarası
    <div className="lp-stage gap-3" onPointerDown={unlockAudio}>
      {/* Cam çubuk iki satır: üstte ad, sayaçlar ve araçlar; altta istasyon sekmeleri (telefonda kayar) */}
      <div className="lp-glass block p-0">
        <div className="flex items-center gap-2 px-3 py-2 md:px-4 md:py-2.5">
          {/* Telefonda ikon yok; Fişler'de başlık da yalnız ekran okuyucuya (alt sekme "Bar" diyor): sayaçların yeri, iki
              sayaç birlikteyken başlık "B…"ya iniyordu */}
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-[var(--admin-ink-fill)] text-[var(--admin-on-ink)] max-sm:hidden">
            <ChefHat className="size-[18px]" />
          </span>
          <h1 className={cn('min-w-0 truncate font-headline text-xl font-bold tracking-[-0.03em]', view === 'aktif' && 'max-sm:sr-only')}>Bar ve mutfak</h1>
          <div className="flex-1" />
          {view === 'aktif' && (
            // Renk dili: bekliyor nötr, hazırlanıyor mavi, hazır yeşil; amber yalnız zaman (gecikme, planlı saat)
            <div className="flex shrink-0 gap-1.5 whitespace-nowrap text-[13px] font-medium max-sm:order-first sm:hidden">
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
          {/* Aç-kapa: adı sabit, durumu aria-pressed; kapsül, yanındaki Diğer ile aynı biçim */}
          <IconButton label="Yeni sipariş sesi" title={sound ? 'Sesi kapat' : 'Sesi aç'} aria-pressed={sound} onClick={() => setSound(!sound)}>
            {sound ? <Bell className="size-5" /> : <BellOff className="size-5 text-muted" />}
          </IconButton>
        </div>
        {/* Görünüm ve istasyon: geniş ekranda tek satır, telefonda alt alta (istasyonlar yatay kayar) */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-[var(--admin-divider)] px-2 py-1.5 md:flex-nowrap md:px-3">
          <Tabs<View>
            label="Görünüm"
            className="shrink-0"
            value={view}
            onChange={(v) => {
              // Seçili Fişler'e yeniden dokunmak Toplam görünümünden fişlere döndürür
              if (v === 'aktif' && view === 'aktif') setTotalsView(false);
              setView(v);
            }}
            options={[
              { value: 'aktif', label: 'Fişler' },
              { value: 'hazir', label: 'Hazır', count: ready.data?.length },
              { value: 'gecmis', label: 'Geçmiş' },
            ]}
          />
          {/* İstasyon rayı yalnız birden çok istasyonda; görünüm rayından adıyla ayrılır (iki gri seçili hap tek grup sanılıyordu) */}
          {boot.stations.length > 1 && (
            <>
              <span aria-hidden="true" className="h-6 w-px shrink-0 bg-[var(--admin-divider)] max-md:hidden" />
              <div className="flex min-w-0 items-center gap-1 max-md:basis-full">
                <span aria-hidden="true" className="shrink-0 pl-1.5 text-xs font-medium text-muted">
                  İstasyon
                </span>
                <Tabs label="İstasyon" className="min-w-0" value={activeStation} onChange={setStation} options={[{ value: '', label: 'Tümü' }, ...boot.stations.map((s) => ({ value: s.id, label: s.name }))]} />
              </div>
            </>
          )}
        </div>
      </div>

      <Modal open={more} onClose={() => setMore(false)} title="Bar ekranı" size="sm">
        {/* Satırlar kabuğun "Diğer ekranlar" sayfası gibi: 56 px, kenarlı, köşe 14 */}
        <div
          className="grid gap-2 p-4 [&_button]:min-h-12 [&_button]:w-full [&_button]:justify-start [&_button]:gap-3 [&_button]:rounded-xl [&_button]:border [&_button]:border-line [&_button]:px-3 [&_button]:text-[15px] [&_svg]:size-[18px]"
          onClick={() => setMore(false)}
        >
          {tools}
          {/* Telefonda çağrı ekranı açılmaz (televizyon ya da müşteriye dönük tablet içindir) */}
          <span className="contents max-md:hidden">{callScreen}</span>
        </div>
      </Modal>

      {/* Sayaç şeridi (tek çerçeve, ince bölmeler): bekleyen ve hazırlanan kalem, teslim bekleyen sipariş, geciken fiş bir
          bakışta. Telefonda başlıktaki hap sayaçlar yeter */}
      {/* Veriye bağlı (durum değil): bağlantı kopunca eski fişler ekranda kalırken sayaçlar da kalır */}
      {view === 'aktif' && !!tickets.data && (
        <dl className="grid shrink-0 grid-cols-4 overflow-hidden rounded-2xl border border-line bg-surface max-sm:hidden">
          <Count icon={<CircleDashed />} label="Bekliyor" value={counts.waiting} tone="neutral" />
          <Count icon={<Flame />} label="Hazırlanıyor" value={counts.making} tone="blue" />
          <Count icon={<CheckCheck />} label="Teslim bekliyor" value={ready.data?.length ?? 0} tone="green" />
          <Count icon={<AlarmClock />} label="Geciken" value={lateCounts.late} tone={lateCounts.alarm ? 'red' : 'amber'} />
        </dl>
      )}

      {/* Fişler ekrandayken bağlantı koparsa: üstte, uzaktan görünür; "sipariş yok" ile karışmasın */}
      {tickets.isError && !!tickets.data && (
        <Notice tone="danger" role="alert" icon={<WifiOff />}>
          Bağlantı koptu · son güncelleme {fmtTime(tickets.dataUpdatedAt)} · yeniden deneniyor
        </Notice>
      )}

      {/* Izgara kabın genişliğine göre 1-5 sütun (container query): fişler satır satır hizalı, aynı satırdakiler eşit boyda */}
      <div className="@container scroll-thin min-h-0 flex-1 overflow-y-auto">
        {tickets.isPending && (
          <div role="status" aria-label="Fişler yükleniyor…" className={GRID}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-48 rounded-2xl" />
            ))}
          </div>
        )}
        {tickets.isError && !tickets.data && (
          <div className="grid h-full place-items-center">
            <ErrorState large title="Kasaya bağlanılamıyor" error={tickets.error} retrying={tickets.isFetching} onRetry={() => void tickets.refetch()}>
              Yeni siparişler bu ekrana gelmiyor; bağlantı gelince fişler kendiliğinden görünür
            </ErrorState>
          </div>
        )}
        {tickets.isSuccess && list.length === 0 && (
          <div className="grid h-full place-items-center">
            <EmptyState large art="espresso" title={history ? 'Son 90 dakikada hazırlanan sipariş yok' : readyView ? 'Teslim bekleyen sipariş yok' : 'Bekleyen sipariş yok'}>
              {history
                ? 'Hazır işaretlenen fişler 90 dakika burada kalır'
                : readyView
                  ? 'Hazır olan sipariş alınana dek 30 dakika burada bekler; teslim edince düşer'
                  : sound
                    ? 'Yeni sipariş gelince ses çalar ve fiş burada belirir'
                    : 'Yeni sipariş gelince fiş burada belirir'}
            </EmptyState>
          </div>
        )}
        {showTotals && list.length > 0 && (
          <div className={GRID}>
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
        <div className={cn(GRID, showTotals && 'hidden')}>
          {list.map((t) => {
            const live = t.items.filter((i) => !i.voided);
            // Gönderildikten sonra kalemlerin hepsi iptal edildi: sunucu fişi 10 dakika gösterir (iptal bildirimi). Yapılacak
            // iş yok: alarm, süre ve düğme de yok ("Hepsi hazır" boş listeyle reddediliyordu)
            const cancelled = live.length === 0;
            // Hazır sekmesinde süre hazır olduğundan beri (müşteri ne zamandır almadı)
            const age = readyView ? now - Math.max(...live.map((i) => i.readyAt ?? t.sentAt)) : now - t.sentAt;
            const level = age > boot.settings.kitchenAlarmMinutes * 60_000 ? 'alarm' : age > boot.settings.kitchenWarnMinutes * 60_000 ? 'warn' : 'ok';
            const online = t.source === 'laffogato';
            const allStarted = live.every((i) => i.status !== 'yeni');
            // Paket platformu: kurye ve müşteri platformun kodunu söyler ("0761"); kod büyük yazılır, platformun adı yanında
            // küçük (dar kartta kırpılan ad, kod değil). LafPOS'un çağrı numarası ve kabul eden kişi platform fişinde yok
            const platformName = t.platform ? PLATFORM_LABEL[t.platform] : '';
            const platformCode = t.platform && t.label.startsWith(platformName) ? t.label.slice(platformName.length).trim() : '';
            // Self modlarda numara, yarı selfte masa no büyük rozet: barista çağıracağı ya da götürüleceği yeri görür
            const head = t.platform ? { call: null, label: platformCode || t.label, showNo: false } : ticketHead(t, mode);
            const late = history || readyView || cancelled ? 'ok' : level;
            const making = live.some((i) => i.status === 'hazirlaniyor');
            // Durum çizgisi: gri bekliyor, mavi hazırlanıyor, yeşil hazır, amber ve kırmızı gecikme (iptal kırmızı, geçmiş sakin)
            const accent = cancelled
              ? 'bg-[var(--admin-danger)]'
              : history
                ? 'bg-[var(--admin-border)]'
                : readyView
                  ? 'bg-[var(--admin-success)]'
                  : late === 'alarm'
                    ? 'bg-[var(--admin-danger)]'
                    : late === 'warn'
                      ? 'bg-[var(--admin-warning)]'
                      : making
                        ? 'bg-[var(--admin-blue)]'
                        : 'bg-[var(--admin-border-field)]';
            const name = head.call ?? t.label;
            // Platform siparişinin notu etiketle başlar ("Getir Yemek 0761 · Kapıda Pluxee"): başlıktaki kod notta yinelenmez
            const note = t.platform && t.note?.startsWith(t.label) ? t.note.slice(t.label.length).replace(/^\s*·\s*/, '') || null : t.note;
            // Bu fişin bir isteği sürerken fişin öteki düğmeleri de kilitli (çift dokunuş iki kez göndermesin)
            const ticketBusy = !!busy && busy.startsWith(`${t.key}:`);
            return (
              // Fiş: başlık nötr; gecikince süre rozeti ve kenar renklenir (amber uyarı, kırmızı alarm). Alarm 1-2 m'den
              // de görünsün: kırmızı halka, başlık zemini ve dolu süre rozeti (koyuda yumuşak halka zeminde kayboluyordu)
              <article
                key={t.key}
                className={cn(
                  'flex flex-col overflow-hidden rounded-2xl border bg-surface',
                  late === 'alarm' ? 'border-transparent ring-2 ring-[var(--admin-danger)]' : late === 'warn' ? 'border-[var(--admin-warning-line)] ring-1 ring-[var(--admin-warning-line)]' : 'border-line',
                )}
              >
                <span aria-hidden="true" className={cn('h-1 shrink-0', accent)} />
                <header className={cn('flex items-start gap-2 border-b border-[var(--admin-divider)] px-3 pb-2 pt-2', late === 'alarm' && 'bg-[var(--admin-danger-soft)]')}>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      {/* Online (siteden gelen) her ekranda mor: kitin rozeti */}
                      {online && (
                        <Badge tone="violet" className="shrink-0">
                          <Globe aria-hidden="true" className="size-3.5" />
                          Online
                        </Badge>
                      )}
                      {/* Çağrı numarası nötr hap: bu ekranda mavi "hazırlanıyor" demek (kalemleri bekleyen No 9 da işte görünüyordu) */}
                      {head.call && (
                        <span className="tabular font-headline shrink-0 rounded-full bg-surface-3 px-3 py-0.5 text-xl font-bold leading-tight text-ink md:px-3.5 md:text-2xl">{head.call}</span>
                      )}
                      {/* Nereye gideceği en büyük yazı: barın üstündeki tablet 1-2 m'den okunur */}
                      {head.label && <span className={cn(head.call ? 'text-sm text-ink-2' : 'text-xl font-bold tracking-[-0.01em] md:text-2xl', platformCode ? 'shrink-0' : 'truncate')}>{head.label}</span>}
                      {t.platform && platformCode && (
                        <span className="flex min-w-0 items-center gap-1.5 text-sm text-ink-2">
                          <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[t.platform] }} />
                          <span className="truncate">{platformName}</span>
                        </span>
                      )}
                    </div>
                    {/* Künye ikinci satırda: numara, garson, gönderim saati; ödemesi alınmış sipariş "Ödendi" (tezgâhta ödeme
                        alınınca bara düşer) */}
                    <div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-muted">
                      {head.showNo && <span className="tabular">#{t.orderNo}</span>}
                      {t.waiterName && !t.platform && <span className="min-w-0 truncate">{t.waiterName}</span>}
                      <span className="tabular">{fmtTime(t.sentAt)}</span>
                      {t.paid && !online && !history && (
                        <span className="inline-flex items-center gap-1 rounded-full bg-[var(--admin-success-soft)] px-2 py-px text-xs font-semibold text-[var(--admin-success)]">
                          <CircleCheck aria-hidden="true" className="size-3.5" />
                          Ödendi
                        </span>
                      )}
                    </div>
                  </div>
                  {cancelled ? (
                    <span className={cn(PILL, 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]')}>
                      <Ban aria-hidden="true" className="size-4 md:size-[18px]" />
                      İptal edildi
                    </span>
                  ) : (
                    <span
                      className={cn(
                        PILL,
                        history ? 'bg-surface-3 text-muted' : readyView ? 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]' : late === 'alarm' ? 'bg-danger-600 text-white' : late === 'warn' ? 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]' : 'bg-surface-3 text-ink-2',
                      )}
                    >
                      {readyView ? <CheckCheck aria-hidden="true" className="size-4 md:size-[18px]" /> : <Clock aria-hidden="true" className="size-4 md:size-[18px]" />}
                      {readyView && <span className="sr-only">Hazır olalı</span>}
                      {mmss(age)}
                    </span>
                  )}
                </header>
                {(note || t.scheduledFor) && (
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--admin-divider)] px-3 py-2 text-sm md:text-base">
                    {t.scheduledFor && <span className="font-semibold text-[var(--admin-warning)]">Saat {fmtTime(Date.parse(t.scheduledFor))}</span>}
                    {note && <NoteChip>{note}</NoteChip>}
                  </div>
                )}
                <ul className="flex-1 divide-y divide-[var(--admin-divider)]">
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
                          {i.voided && <span className="block text-sm font-bold text-[var(--admin-danger-ink)]">İptal edildi, yapmayın</span>}
                        </span>
                        {!i.voided && <StatusDot status={i.status} />}
                      </button>
                    </li>
                  ))}
                </ul>
                <footer className={cn('mt-auto flex gap-2 border-t border-[var(--admin-divider)] p-2', (REMOTE || cancelled) && 'hidden')}>
                  {/* Ortak düğme: istek sürerken kilitli ve yükleniyor; ana eylem 48 px, 16 px yazı (uzaktan okunur). Site
                      siparişinde de kasa fişinin sözü ve oranı: 322 px kartta "Hazır (siteye bildir)" kırpılıyordu, nereye
                      bildirildiğini başlıktaki mor Online ve bildirim söyler */}
                  {online ? (
                    <>
                      {!allStarted && (
                        <Button size="lg" className={FOOT} disabled={ticketBusy} loading={busy === `${t.key}:start`} onClick={() => onlineStage(t.orderId, 'preparing', `${t.key}:start`)}>
                          Başla
                        </Button>
                      )}
                      <Button variant="success" size="lg" className={cn(FOOT, 'flex-[2]')} title="Hazır olduğu siteye ve uygulamaya bildirilir" disabled={ticketBusy} loading={busy === `${t.key}:ready`} onClick={() => onlineStage(t.orderId, 'ready', `${t.key}:ready`)}>
                        Hepsi hazır
                      </Button>
                    </>
                  ) : readyView ? (
                    // Barın adımları tek yeşil ailede: koyuda da "Hepsi hazır" gibi derin yeşil (primary nane blok en parlak öğeydi)
                    <Button variant="success" size="lg" className={FOOT} icon={<PackageCheck className="size-5" />} disabled={ticketBusy} loading={busy === `${t.key}:deliver`} onClick={() => void deliver(live.filter((i) => i.status === 'hazir').map((i) => i.id), name, `${t.key}:deliver`)}>
                      Teslim edildi
                    </Button>
                  ) : history ? (
                    <>
                      <Button size="lg" className={FOOT} icon={<Undo2 className="size-4" />} disabled={ticketBusy} loading={busy === `${t.key}:undo`} onClick={() => void undo(live, `${t.key}:undo`)}>
                        Geri al
                      </Button>
                      {/* Teslimi geri alınan eski sipariş Hazır sekmesine dönmez (30 dk): Geçmiş'ten yeniden teslim edilir */}
                      {historyHandIds(t).length > 0 && (
                        <Button variant="success" size="lg" className={FOOT} icon={<PackageCheck className="size-5" />} disabled={ticketBusy} loading={busy === `${t.key}:deliver`} onClick={() => void deliver(historyHandIds(t), name, `${t.key}:deliver`)}>
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

/** Araç çubuğu düğmesi: Tabs ile aynı dil (kapsül, basılı gri, renksiz); aria-pressed ile açık/kapalı */
function ToolButton({ pressed, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm transition-colors duration-150 active:bg-press pointer-fine:min-h-9',
        pressed ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-hover hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Fiş ızgarası: kabın genişliğine göre 1 (telefon), 2 (tablet dikey), 3 (bilgisayar), 4-5 (geniş ekran) sütun. Aynı
 * satırdaki fişler eşit boyda (kartın düğmeleri dipte hizalı); yükleme iskeleti ve Toplam aynı ızgarada
 */
const GRID = 'grid grid-cols-1 gap-3 @[38rem]:grid-cols-2 @[58rem]:grid-cols-3 @[80rem]:grid-cols-4 @[104rem]:grid-cols-5';

/**
 * Sayaç şeridinin hücresi: etiket ve Gabarito rakam, sıfırken sakin gri. dt ve dd hücrenin doğrudan çocukları (geçerli
 * tanım listesi: ekran okuyucu "Bekliyor, 3" diye eşler); ikon kutusu dt'nin içinde, yalnız geniş ekranda (tablet dikeyde
 * etiket sığsın)
 */
function Count({ icon, label, value, tone }: { icon: React.ReactNode; label: string; value: number; tone: 'neutral' | 'blue' | 'green' | 'amber' | 'red' }) {
  const color = { neutral: 'text-ink', blue: 'text-[var(--admin-blue)]', green: 'text-[var(--admin-success)]', amber: 'text-[var(--admin-warning)]', red: 'text-[var(--admin-danger-ink)]' }[tone];
  return (
    <div className="relative min-w-0 border-l border-[var(--admin-divider)] px-3 py-3 first:border-l-0 lg:pl-16 lg:pr-4">
      <dt className="truncate text-[13px] font-medium text-muted">
        <span aria-hidden="true" className={cn('absolute left-4 top-1/2 hidden size-9 -translate-y-1/2 place-items-center rounded-xl bg-surface-3 lg:grid [&>svg]:size-[18px]', value > 0 ? color : 'text-muted')}>
          {icon}
        </span>
        {label}
      </dt>
      <dd className={cn('tabular mt-1 font-headline text-[34px] font-bold leading-none tracking-[-0.045em]', value > 0 ? color : 'text-muted')}>{value}</dd>
    </div>
  );
}

/** Fiş düğmesi: 48 px yükseklik, 16 px yazı, satırı paylaşır */
const FOOT = 'h-11 flex-1 text-[15px] pointer-coarse:h-12';

/** Fiş başlığının sağındaki durum hapı (süre, hazır olalı, iptal): uzaktan okunur, 15-17 px */
const PILL = 'tabular inline-flex min-h-7 shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-[15px] font-semibold md:min-h-8 md:text-[17px]';

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
