import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowUpRight, BarChart3, CheckCircle2, ChevronRight, RotateCcw } from 'lucide-react';
import { type CSSProperties, Fragment, type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { tl, tlShort } from '@shared/money';
import { businessHourIndex } from '@shared/time';
import type { OffDeviceTotals } from '@shared/order-calc';
import { fmtAgo, fmtDateLong, fmtTime, TZ } from '@shared/time';
import { agoText, cutoffMinute, dayLabel, type PatronStats, statsSource, summaryCompares, todayStats, topCompare } from '@shared/today-stats';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { Button, IconButton } from '@/components/ui/Button';
import { ErrorState, Notice, SizeTag, Skeleton } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useMediaQuery, useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { staleCostsText } from '@/lib/lafmaliyet';
import { hourBars } from '@/lib/period';
import { toast } from '@/lib/toast';
import { fmtClock, REMOTE, remoteFreshness, remotePollMs } from '@/lib/remote';
import { Amount, COMPARE_SHORT, CompareGroup, CumulativeChart, Delta, Faint, Group, PeriodGroup, QuietRow, Row, ROW_BUTTON, ROW_STATIC, ViewTabs, GROUP, PaymentMix } from './TodayStats';
import { UzaktanYonetimKarti } from '@/pages/kontrol/UzaktanYonetimKarti';
import { CompareBars, HeroNumber, KPill, KpiTile, PaymentGaugeCard, PctPill, ThinBars } from './KeelPanel';
import { KiyasDokum } from './KiyasDokum';

export interface PatronData {
  now: number;
  date: string;
  dayOpen: boolean;
  netSales: number;
  orders: number;
  avgCheck: number;
  open: { count: number; total: number };
  compare: { lastWeek: { netSales: number; orders: number; change: number | null }; fourWeeks: { netSales: number; orders: number; change: number | null } };
  yesterday: { netSales: number; receipts: number };
  hourly: number[];
  hourlyLastWeek: number[];
  /** Gün 24 saati aştıysa ertesi günün saatleri (eski sunucu göndermez) */
  hourlyNextDay?: number[];
  hourlyLastWeekNextDay?: number[];
  /** `zField`: Z raporundaki alan (cash, card, meal_card, online, other); eski özette yok (addan anlaşılır) */
  payments: { name: string; zField?: string; amount: number; count: number; share: number }[];
  /**
   * Bugün yazarkasadan geçmeyen kart ve nakit (shared/order-calc.ts `offDeviceTotals`). Yalnız kasa rakamlarını görene
   * (kör kasa); eski sunucu ve uzaktan demo özeti göndermez: satır yazılmaz, ₺0 gösterilmez
   */
  offDevice?: OffDeviceTotals;
  discounts: number;
  complimentary: number;
  /** Eski sunucu ve uzaktan demo özeti (api/demo-ozet.json) göndermez */
  odenmez?: number;
  zayi?: number;
  voided: number;
  online: { orders: number; amount: number };
  top: { key: string; name: string; size: string; qty: number; revenue: number; margin: number | null }[];
  /** "Bugün" kıyaslarının girdisi (shared/today-stats.ts); eski sunucu ve uzaktan demo özeti göndermez */
  stats?: PatronStats;
  /** Maliyetlerin son çekimi; yalnız maliyet yetkisine gelir (eskiyse uyarı) */
  costsAt?: number | null;
  openChecks: { id: string; no: number; place: string; total: number; paid: number; openedAt: number; waiter: string | null; billPrinted: boolean }[];
  alerts: { id: number; at: number; severity: 'uyari' | 'alarm'; action: string; message: string; amount: number | null; orderId: string | null }[];
  anomalies: { level: 'uyari' | 'alarm'; title: string; detail: string }[];
  /**
   * Son gün sonu (yalnız LafPOS Uzaktan özetinde, server/sync/cloud.ts): gün kapalıyken kart. Kasa rakamları yalnız
   * patron rolü kasa rakamlarını görüyorsa (kör kasa)
   */
  lastClose?: {
    date: string;
    zNo: number;
    closedAt: number;
    netSales: number;
    receipts: number;
    payments: { name: string; amount: number; count: number }[];
    /** Eski Z'de ve kör kasada yok */
    offDevice?: OffDeviceTotals;
    cash: { expected: number; counted: number | null; diff: number | null } | null;
  } | null;
}

/** Dikkat isteyenlerde ilk bakışta en çok bu kadar satır; gerisi "Tümünü göster"le aynı kartta açılır */
const ATTENTION_ROWS = 4;

/** Pano yaprağının iç payı: telefonda kart kenara yakın, geniş ekranda biraz içeride */
const PAD = 'px-1 pb-8 pt-1 md:px-2 md:pt-2';
/** Telefonda tek sütunun sırası (`.lp-patron`, index.css): sütun yığınları açılır, kartlar bu sırayla dizilir */
const order = (o: number) => ({ '--o': o }) as CSSProperties;
/** Gruplanmış liste kartının iskeleti (yüklenirken aynı köşe) */
const BONE = 'rounded-[var(--r-group)]';

/**
 * Ayraçlı meta satırı: satır ayraçta kırılır, etiket tutarından ayrılmaz ("ortalama" bir satırda, "₺81" ötekinde
 * kalmaz). Boş ya da false parça düşer.
 */
function Pairs({ parts }: { parts: (string | false | null | undefined)[] }) {
  const kept = parts.filter((p): p is string => !!p);
  return (
    <>
      {kept.map((p, i) => (
        <Fragment key={i}>
          {i > 0 && ' · '}
          <span className="whitespace-nowrap">{p}</span>
        </Fragment>
      ))}
    </>
  );
}

/**
 * Bugünün cirosu (sahibin örneği): ekranın en büyük öğesi, kartsız, zeminde. ₺ işareti soluk, rakam mürekkep; kuruş
 * varsa küçük ve soluk. Boy kabın enine ve rakamın uzunluğuna göre: "₺357" telefonun yarısını doldurur, "₺12.450,50" da
 * taşmaz (rakam başına ~0,64 em, nokta ~0,3 em)
 */
function HeroAmount({ k }: { k: number }) {
  const [, int = '0', frac = ''] = /^\D*([\d.]+)(,\d+)?$/.exec(tl(k)) ?? [];
  const cents = k % 100 !== 0;
  const dots = int.split('.').length - 1;
  const units = 0.64 * (int.length - dots + 1) + 0.3 * dots + (cents ? 0.85 : 0);
  return (
    <p className="tabular whitespace-nowrap font-headline font-medium leading-none tracking-[-0.045em] text-ink" style={{ fontSize: `min(4.75rem, calc(100cqi / ${units.toFixed(2)}))` }}>
      <span className="sr-only">Bugünkü ciro {tl(k)}</span>
      <span aria-hidden="true">
        <span className="text-[var(--k-faint)]">₺</span>
        {int}
        {cents && <span className="text-[var(--k-faint)]">{frac}</span>}
      </span>
    </p>
  );
}

type ChartView = 'birikimli' | 'saatlik' | 'tablo';

export default function PatronPage() {
  const [dokum, setDokum] = useState(false);
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const boot = useBoot();
  const me = useAuth((s) => s.me)!;
  const sizeLabels = boot.settings.sizeLabels;
  const now = useTick(30_000);
  // Telefonda başlık satırı yok (ekranın adı kabuğun şeridinde): tarih ve Z sahnenin alt satırında yalnız geniş ekranda
  const wide = useMediaQuery('(min-width: 48rem)');
  const [view, setView] = useState<ChartView | null>(null);
  const [allAttention, setAllAttention] = useState(false);
  // Uzakta gün açıkken 15 sn, kapalıyken 60 sn; değişmeyen özet 304 (src/lib/remote.ts)
  const poll = (dayOpen: boolean | undefined) => (REMOTE ? remotePollMs(dayOpen) : 60_000);
  const data = useQuery({ queryKey: ['patron'], queryFn: () => get<PatronData>('/reports/patron'), refetchInterval: (q) => poll(q.state.data?.dayOpen) });

  // Satış ve kasa olaylarında yenile; uyarılar anında bildirim olarak düşer
  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'orders' || e.topic === 'cash') qc.invalidateQueries({ queryKey: ['patron'] });
        if (e.topic === 'alerts' && e.message) toast.warn(e.message);
      }),
    [qc],
  );

  // İlk yükleme: sayfanın biçiminde iskelet (iri ciro, kıyas kartı, grafik ve listeler), spinner değil. Izgara içerikle
  // aynı kuraldan (.lp-patron): sayfa yüklenince kaymaz
  if (data.isPending) {
    return (
      <Stage name="Patron paneli" sub={wide ? 'Canlı rakamlar yükleniyor…' : undefined} leafLabel="Patron paneli" float>
        <div role="status" aria-label="Canlı rakamlar yükleniyor…" className={PAD}>
          <div className="lp-patron">
            <div className="lp-patron-col" data-col="a">
              <Skeleton className={cn(BONE, 'h-[212px]')} />
              <Skeleton className={cn(BONE, 'h-[212px]')} />
              <Skeleton className={cn(BONE, 'h-[236px]')} />
            </div>
            <div className="lp-patron-col" data-col="b">
              <Skeleton className={cn(BONE, 'h-[330px]')} />
              <Skeleton className={cn(BONE, 'h-[212px]')} />
            </div>
            <div className="lp-patron-col max-lg:hidden" data-col="c">
              <Skeleton className={cn(BONE, 'h-[160px]')} />
              <Skeleton className={cn(BONE, 'h-[160px]')} />
            </div>
          </div>
        </div>
      </Stage>
    );
  }
  // Rakamlar alınamadıysa ₺0 gösterilmez: patron "satış yok" sanmasın
  if (data.isError && !data.data) {
    return (
      <div className="grid h-full place-items-center p-6">
        <ErrorState title="Canlı rakamlar alınamadı" error={data.error} retrying={data.isFetching} onRetry={() => void data.refetch()} />
      </div>
    );
  }
  const d = data.data;
  if (!d) return null;
  // İş günü sırasıyla (05:00'ten): gece yarısından sonraki satış sabahın değil, günün sonunda; gün uzadıysa ertesi
  // sabahın satışı gecenin ardından
  const visibleHours = hourBars(d);
  /**
   * Kıyasın yolu (shared/today-stats.ts `StatsSource`): `kasa` kasa girdiyi gönderdi; `rapor` eski kasa göndermedi,
   * LafPOS Uzaktan bulutta duran gün raporlarından kurdu (api/uzaktan.ts `withStats`); `ozet` ikisi de yok, kart özetin
   * iki rakamıyla (dünün gün sonu, geçen haftanın bu saati) çizilir. Kıyas özetin anıyla (veri o saattedir)
   */
  const source = statsSource(d);
  const st = d.stats ? todayStats(d, d.stats, d.now) : null;
  const kiyas = st ?? summaryCompares(d);
  // En çok satanların geçen haftası yalnız kasanın girdisinde (ürünün kapanış dakikaları gün raporunda yok)
  const tops: ((typeof d.top)[number] & { prev?: { qty: number; revenue: number } | null; change?: number | null })[] =
    st && source === 'kasa' ? topCompare(d.top, d.stats!, st.cutoffMin, st.compares[1]!.value != null) : d.top.slice(0, 5);
  const charted = visibleHours.some((h) => h.value || h.compare);
  // Geçen haftanın aynı günü satışsızsa kıyas çizgisi, açıklaması ve tablo sütunu yok (eksende düz çizgi kalın bir
  // taban gibi okunuyordu)
  const hasLastWeek = visibleHours.some((h) => h.compare);
  const chartView: ChartView = view === 'birikimli' && !st ? 'saatlik' : (view ?? 'saatlik');

  // "Canlı" yalnız rakamlar tazeyken: yenileme düşerse son veri kalır ama saat verinin saatidir, nokta amber
  // Uzakta ayrıca kafenin kendisi: gün açıkken son itme 10 dakikadan eskiyse kafeden veri gelmiyor
  const clockNow = Math.max(now, Date.now());
  const cafeSilent = REMOTE && remoteFreshness(clockNow, d.now, d.dayOpen) === 'stale';
  const stale = data.isError || cafeSilent || now - data.dataUpdatedAt > 3 * poll(d.dayOpen);
  // Canlılık: "Az önce", "3 dk önce"; eskiyse ya da gün kapalıysa verinin saati
  const ago = stale || !d.dayOpen ? null : agoText(Math.max(0, clockNow - d.now));
  const stamp = REMOTE ? fmtClock(d.now) : fmtTime(d.now);
  const liveText = stale
    ? [`son güncelleme ${stamp}`, cafeSilent ? 'kafeden veri gelmiyor' : data.isError && 'yenilenemedi']
    : d.dayOpen
      ? ['Gün açık', ago ? ago.toLocaleLowerCase('tr-TR') : `son güncelleme ${stamp}`]
      : ['Gün kapalı', dayLabel(d.date), `son güncelleme ${stamp}`];
  // Durumu nokta ve yazı birlikte anlatır; sürekli nabız yok
  const dot = <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', stale ? 'bg-[var(--admin-warning)]' : d.dayOpen ? 'bg-[var(--admin-success)]' : 'bg-muted')} />;
  // Hata durumundaki (ErrorState) yeniden denemeyle aynı düğme
  const retry = data.isError && (
    <Button size="sm" icon={<RotateCcw className="size-4" />} loading={data.isFetching} onClick={() => void data.refetch()}>
      Yeniden dene
    </Button>
  );

  // İndirim ve ikram satırının dökümü: değeri oluşturan yalnız sıfırdan büyük kalemler (ikram ödenmez ve zayi dışı;
  // Raporlar'daki lossParts'la aynı kural ve kısa tutar, iptal ayrı satırda)
  const odenmez = d.odenmez ?? 0;
  const zayi = d.zayi ?? 0;
  const ikram = Math.max(0, d.complimentary - odenmez - zayi);
  const lossParts = [d.discounts > 0 && `indirim ${tlShort(d.discounts)}`, ikram > 0 && `ikram ${tlShort(ikram)}`, odenmez > 0 && `ödenmez ${tlShort(odenmez)}`, zayi > 0 && `zayi ${tlShort(zayi)}`].filter((p): p is string => !!p);
  const loss = d.discounts + d.complimentary;

  // Dikkat isteyenler tek listede: önce günün anomalileri, sonra uyarılar (en yeni üstte). Adisyonu olan satır
  // adisyona, olmayan denetim kaydına götürür (uzaktan görünümde yönetim yok: satır düz kalır)
  const audit = REMOTE ? undefined : '/yonetim/denetim';
  const attention = [
    ...d.anomalies.map((a, i) => ({ key: `an-${i}`, alarm: a.level === 'alarm', title: a.title, meta: a.detail, to: audit })),
    ...d.alerts.map((a) => ({ key: `al-${a.id}`, alarm: a.severity === 'alarm', title: a.message, meta: fmtTime(a.at), to: a.orderId ? `/adisyon/${a.orderId}` : audit })),
  ];
  const shownAttention = allAttention ? attention : attention.slice(0, ATTENTION_ROWS);

  const showCost = can('rapor.maliyet') && d.top.some((t) => t.margin != null);
  const staleCosts = can('rapor.maliyet') ? staleCostsText(d.costsAt, d.now) : null;
  const sizeName = (size: string) => (size === 'M' || size === 'L' ? (sizeLabels?.[size] ?? size) : null);

  // Selamlama (tablet ve bilgisayarda başlık satırı): günün saatine göre, ad ev yeşilinde
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(d.now));
  const greeting = hourNow < 5 ? 'İyi geceler' : hourNow < 11 ? 'Günaydın' : hourNow < 17 ? 'İyi günler' : hourNow < 22 ? 'İyi akşamlar' : 'İyi geceler';
  const firstName = me.name.trim().split(/\s+/)[0] ?? me.name;
  const reportsLink = REMOTE || can('rapor.gor');
  const cmpDun = kiyas.compares.find((c) => c.key === 'dun');
  // Karolar (Keel'in dört karosu): fiş sayısı ve ortalama sepet dünün aynı saatiyle hapta; açık hesap; tahmin ya da hafta
  const dunSame = cmpDun?.change != null && cmpDun.value ? cmpDun.value : null;
  const dunAvg = dunSame && dunSame.receipts > 0 ? dunSame.netSales / dunSame.receipts : null;
  const haftaDonem = st?.periods.find((p) => p.key === 'hafta');
  // Rakamlar yenilenince kayan sayaçla döner (yazı tl/tlShort'un aynısı); anahtar karonun kendisi, etiketteki sayı değil
  const count = (n: number) => n.toLocaleString('tr-TR');
  const roll = (k: number) => <AnimatedCounter value={k} format={tlShort} />;
  const tiles: { id: string; label: string; value: ReactNode; pill?: ReactNode }[] = [
    {
      id: 'fis',
      label: 'Fiş sayısı',
      value: <AnimatedCounter value={d.orders} format={count} />,
      pill: dunSame && d.orders !== dunSame.receipts ? <KPill dir={d.orders > dunSame.receipts ? 'up' : 'down'}>{Math.abs(d.orders - dunSame.receipts)}</KPill> : undefined,
    },
    { id: 'sepet', label: 'Ortalama sepet', value: d.orders > 0 ? roll(d.avgCheck) : '—', pill: d.orders > 0 && dunAvg ? <PctPill value={Math.round(((d.avgCheck - dunAvg) / dunAvg) * 1000) / 10} /> : undefined },
    { id: 'acik', label: d.open.count > 0 ? `Açık hesap · ${d.open.count}` : 'Açık hesap', value: d.open.count > 0 ? roll(d.open.total) : '—' },
    st?.forecast
      ? { id: 'tahmin', label: 'Gün sonu tahmini', value: roll(Math.round(st.forecast.value / 100) * 100) }
      : haftaDonem
        ? { id: 'hafta', label: 'Hafta başından', value: roll(haftaDonem.cur.netSales), pill: <PctPill value={haftaDonem.change} /> }
        : { id: 'kayip', label: 'İndirim ve ikram', value: loss > 0 ? roll(loss) : '—' },
  ];
  // İnce çubuk grafiği: kasa kapanış dakikalarını gönderdiyse 10 dakikalık gerçek dilimler (saat başına altı)
  const hourStart = (key: string) => (key.startsWith('g') ? businessHourIndex(Number(key.slice(1))) : 24 + Number(key.slice(1))) * 60;
  const todayDay = d.stats?.days[d.date];
  const thinBins =
    todayDay && !todayDay.grain
      ? visibleHours.flatMap((h) => {
          const from = hourStart(h.key);
          const six = [0, 0, 0, 0, 0, 0];
          for (const [min, amount] of todayDay.closes) if (min >= from && min < from + 60) six[Math.floor((min - from) / 10)]! += amount;
          return six;
        })
      : null;
  const nowMin = d.dayOpen ? cutoffMinute(d.date, d.now) : null;
  const nowHour = nowMin == null ? null : visibleHours.findIndex((h) => nowMin >= hourStart(h.key) && nowMin < hourStart(h.key) + 60);
  const peak = visibleHours.reduce((best, h, i) => (h.value > (visibleHours[best]?.value ?? 0) ? i : best), 0);
  const canKasa = !REMOTE && (['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor'] as const).some((p) => can(p));
  const canReports = !REMOTE && can('rapor.gor');

  return (
    // Gruplanmış liste (sahibin örneği): en üstte bugünün cirosu iri rakamla, altında Kıyas kartı; sonra aynı dilde
    // grafik, gün içi satırlar, ödeme türleri, hafta ve ay, açık adisyonlar, dikkat isteyenler ve en çok satanlar
    <Stage
      name={<span className="sr-only">Patron paneli</span>}
      actions={retry}
      leafLabel="Patron paneli"
      float
    >
      <div className={PAD}>
        {cafeSilent && (
          <Notice tone="danger" role="alert" title="Kafeden veri gelmiyor" className="mb-3">
            Son veri {fmtClock(d.now)}. Gün açık ama kasa bilgisayarı 10 dakikadır itmedi: internet ya da elektrik kesilmiş, bilgisayar kapanmış olabilir. Rakamlar
            o saattekidir; satış kafede sürer, bağlantı gelince kendiliğinden tazelenir
          </Notice>
        )}
        <div className="lp-patron">
          <div className="lp-patron-col" data-col="a">
            {/*
              * Keel düzeni (DESIGN.md §0): en üstte bugünün cirosu. Etiket, dev rakam (kuruş soluk), yanında mürekkep
              * düğme; altında dört karo. Bilgisayarda zeminde kartsız, telefonda nane ışıklı kartta (Keel'in mobil kartı)
              */}
            <section aria-label="Bugünkü ciro" className="k-hero" style={order(1)}>
              <p className="tabular flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] font-medium uppercase leading-5 tracking-[0.06em] text-muted">
                {dot}
                <span>
                  <Pairs parts={liveText} />
                </span>
                <span aria-hidden="true" className="text-[var(--k-faint)]">
                  ·
                </span>
                <span className="normal-case tracking-normal">{d.dayOpen && boot.day ? `${fmtDateLong(d.date)} · Z ${boot.day.zNo}` : fmtDateLong(d.date)}</span>
              </p>
              <div className="mt-2 flex items-start justify-between gap-3">
                <h2 className="font-headline text-[clamp(1.25rem,1rem+1vw,1.75rem)] font-normal leading-tight tracking-[-0.02em] text-ink">Bugünkü ciro</h2>
                {reportsLink && (
                  <IconButton label="Raporlar" variant="secondary" size="lg" onClick={() => navigate('/raporlar')} className="-mt-1 rounded-full lg:hidden">
                    <ArrowUpRight aria-hidden="true" className="size-[18px]" />
                  </IconButton>
                )}
              </div>
              <div className="mt-1 flex flex-wrap items-end gap-x-6 gap-y-3">
                <div className="@container min-w-0 flex-[1_1_18rem]">
                  <HeroNumber k={d.netSales} label="Bugünkü ciro" />
                </div>
                {(reportsLink || canKasa) && (
                  <div className="flex shrink-0 gap-2 pb-1.5 max-lg:hidden">
                    {reportsLink && (
                      <Button variant="ink" size="lg" ring={false} icon={<BarChart3 aria-hidden="true" className="size-4" />} onClick={() => navigate('/raporlar')}>
                        Raporlar
                      </Button>
                    )}
                    {canKasa && (
                      <Button variant="secondary" size="lg" onClick={() => navigate('/kasa')}>
                        Kasa
                      </Button>
                    )}
                  </div>
                )}
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2 xl:grid-cols-4">
                {tiles.map((t) => (
                  <KpiTile key={t.id} value={t.value} label={t.label} pill={t.pill} />
                ))}
              </div>
            </section>

            <Group
              title="Gün boyu"
              label="Gün boyu ciro"
              flush
              style={order(5)}
              meta={
                (charted || st) && (
                  <ViewTabs
                    label="Görünüm"
                    value={chartView}
                    onChange={setView}
                    options={[{ value: 'saatlik' as const, label: 'Saatlik' }, ...(st ? [{ value: 'birikimli' as const, label: 'Birikimli' }] : []), ...(charted ? [{ value: 'tablo' as const, label: 'Tablo' }] : [])]}
                  />
                )
              }
            >
              {chartView === 'birikimli' && st ? (
                <div className="pt-2">
                  <CumulativeChart s={st} />
                </div>
              ) : chartView === 'tablo' && charted ? (
                <table className="tabular mb-3 mt-1 w-full text-sm">
                  <caption className="sr-only">Bugünün saatlik cirosu{hasLastWeek ? ', geçen haftanın aynı günüyle' : ''}</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th scope="col" className="py-1.5 text-left font-medium">
                        Saat
                      </th>
                      <th scope="col" className="py-1.5 text-right font-medium">
                        Bugün
                      </th>
                      {hasLastWeek && (
                        <th scope="col" className="py-1.5 text-right font-medium">
                          Geçen hafta
                        </th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleHours
                      .filter((h) => h.value || h.compare)
                      .map((h) => (
                        <tr key={h.key} className="border-t border-[var(--admin-divider)]">
                          <td className="py-2 text-muted">{h.title}</td>
                          <td className="py-2 text-right font-semibold">{tl(h.value)}</td>
                          {hasLastWeek && <td className="py-2 text-right text-muted">{tl(h.compare ?? 0)}</td>}
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <div className="pb-3 pt-3">
                  <ThinBars hours={visibleHours} bins={thinBins} nowIndex={nowHour} emptyLabel="Bugün henüz satış yok" />
                </div>
              )}
            </Group>

            {st && (
              <div style={order(4)}>
                <PeriodGroup s={st} today={d.date} />
              </div>
            )}

            {REMOTE && !d.dayOpen && d.lastClose && (
              <div style={order(6)}>
                <DayCloseGroup c={d.lastClose} />
              </div>
            )}
          </div>

          <div className="lp-patron-col" data-col="b">
            {/* Keel'in sağ üst çifti: kıyas kartı (mini grafik ve dün, geçen hafta bugün, geçen ay bugün satırları; kıyas
                yalnız burada) ve yarım halka göstergeli koyu kart; dar sütunda alt alta */}
            <div className="@container" style={order(2)}>
              <div className="grid gap-[var(--grid-gap)] @md:grid-cols-2">
                <CompareGroup
                  compares={kiyas.compares}
                  mode={kiyas.mode}
                  today={d.date}
                  now={d.now}
                  stack
                  onOpen={() => setDokum(true)}
                  chart={<CompareBars today={d.netSales} items={kiyas.compares.map((c) => ({ key: c.key, label: COMPARE_SHORT[c.key], value: c.value ? c.value.netSales : null }))} />}
                />
                <PaymentGaugeCard payments={d.payments} />
              </div>
              <KiyasDokum open={dokum} onClose={() => setDokum(false)} mode={kiyas.mode} now={d.now} today={{ date: d.date, netSales: d.netSales, receipts: d.orders }} compares={kiyas.compares} periods={st?.periods} />
            </div>

            <Group title="Gün içi" style={order(7)}>
              {/* "Açık hesap" kasada müşterinin cari hesabıdır (ödeme türü, Müşteriler); burada ödenmemiş adisyonlar */}
              <Row label="Açık adisyon" sub={d.open.count > 0 ? `${d.open.count} adisyon, tahsil edilecek` : undefined}>
                {d.open.count > 0 ? <Amount k={d.open.total} /> : <Faint>yok</Faint>}
              </Row>
              <Row label="İndirim ve ikram" sub={lossParts.length ? <Pairs parts={lossParts} /> : undefined}>
                {loss > 0 ? <Amount k={loss} /> : <Faint>yok</Faint>}
              </Row>
              <Row label="İptal">{d.voided > 0 ? <Amount k={d.voided} /> : <Faint>yok</Faint>}</Row>
              {d.offDevice && <OffDeviceRow off={d.offDevice} />}
              {d.online.orders > 0 && (
                <Row
                  label={
                    // Online (siteden gelen) sipariş her ekranda mor
                    <span className="inline-flex items-center gap-1.5">
                      <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-violet-ink" />
                      Online sipariş
                    </span>
                  }
                  sub={`${d.online.orders} sipariş, sitede ödendi`}
                >
                  <Amount k={d.online.amount} />
                </Row>
              )}
              {!!st?.guests && (
                <Row label="Masada">
                  <span className="tabular text-[15px] font-semibold text-ink">{st.guests} kişi</span>
                </Row>
              )}
            </Group>
          </div>

          <div className="lp-patron-col" data-col="c">
            <Group title="Açık adisyonlar" meta={d.openChecks.length > 0 && d.openChecks.length} style={order(8)}>
              {d.openChecks.length === 0 ? (
                <QuietRow>Şu an açık adisyon yok</QuietRow>
              ) : (
                d.openChecks.map((o) => {
                  const state = o.billPrinted ? { text: 'Hesap istendi', cls: 'text-signal-ink' } : o.paid > 0 ? { text: 'Kısmen ödendi', cls: 'text-rose-ink' } : { text: 'Açık', cls: 'text-muted' };
                  return (
                    <li key={o.id}>
                      <button type="button" onClick={() => navigate(`/adisyon/${o.id}`)} className={ROW_BUTTON}>
                        <span className="min-w-0">
                          <span className="block truncate text-[15px] font-medium leading-5 text-ink">
                            {o.place} <span className="font-normal text-muted">#{o.no}</span>
                          </span>
                          <span className="mt-0.5 block truncate text-xs leading-4 text-muted">
                            {o.waiter ?? 'Garson yok'} · {fmtAgo(o.openedAt, now)}
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-2">
                          <span className="text-right">
                            <Amount k={o.total - o.paid} />
                            <span className={cn('mt-0.5 block text-xs leading-4', state.cls)}>{state.text}</span>
                          </span>
                          <ChevronRight aria-hidden="true" className="size-4 text-muted" />
                        </span>
                      </button>
                    </li>
                  );
                })
              )}
            </Group>

            <Group
              title="En çok satanlar"
              style={order(9)}
              meta={tops.length > 0 && (st && source === 'kasa' ? `geçen hafta bugüne göre` : 'ciro sırasıyla')}
              footer={staleCosts && <p className="text-xs font-medium text-warning-ink">{staleCosts}</p>}
            >
              {tops.length === 0 ? (
                <QuietRow>Sıralama ilk satışla başlar</QuietRow>
              ) : (
                tops.map((p, i) => {
                  const size = sizeName(p.size);
                  return (
                    <li key={p.key} className={ROW_STATIC}>
                      <span className="flex min-w-0 items-center gap-3">
                        <span aria-hidden="true" className="tabular w-4 shrink-0 text-center text-sm text-muted">
                          {i + 1}
                        </span>
                        <span className="min-w-0">
                          <span className="flex min-w-0 items-center text-[15px] leading-5">
                            <span className="truncate font-medium text-ink" title={p.name}>
                              {p.name}
                            </span>
                            {size && <SizeTag>{size}</SizeTag>}
                          </span>
                          <span className="mt-0.5 block text-xs leading-4 text-muted">
                            {p.qty} adet
                            {p.prev !== undefined && (
                              <>
                                {' · '}
                                <span className="whitespace-nowrap">{!p.prev ? 'geçen hafta veri yok' : p.prev.qty > 0 ? `geçen hafta ${p.prev.qty}` : 'geçen hafta yok'}</span>
                              </>
                            )}
                            {showCost && (
                              <>
                                {' · '}
                                {/* Brüt kâr KDV hariç ciro − reçete maliyeti; indirim ya da maliyet neti aşınca eksi, kırmızı */}
                                <span className={cn('whitespace-nowrap', p.margin != null && p.margin < 0 && 'text-danger-ink')}>{p.margin == null ? 'maliyet yok' : `brüt kâr ${tl(p.margin)}`}</span>
                              </>
                            )}
                          </span>
                        </span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <Amount k={p.revenue} />
                        {p.prev && p.prev.revenue > 0 && p.change != null && <Delta size="sm" value={p.change} />}
                      </span>
                    </li>
                  );
                })
              )}
            </Group>

            {/* Dikkat isteyenler en altta (sahibin sıralaması, 22 Kas 2026): önce rakamlar, sonra uyarılar */}
            <Group
              title="Dikkat isteyenler"
              style={order(10)}
              meta={
                attention.length > 0 && (
                  <span className={cn('tabular inline-flex min-h-6 min-w-6 items-center justify-center rounded-full px-2 text-[13px] font-medium', attention.some((a) => a.alarm) ? 'bg-danger-soft text-danger-ink' : 'bg-warning-soft text-warning-ink')}>
                    {attention.length}
                  </span>
                )
              }
              footer={
                shownAttention.length < attention.length && (
                  <button
                    type="button"
                    onClick={() => setAllAttention(true)}
                    className="-mx-2 flex min-h-11 w-[calc(100%+1rem)] items-center rounded-[var(--r-tile)] px-2 text-left text-sm font-medium text-[var(--admin-primary)] transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press"
                  >
                    Tümünü göster ({attention.length})
                  </button>
                )
              }
            >
              {attention.length === 0 ? (
                <QuietRow>Bugün uyarı yok</QuietRow>
              ) : (
                shownAttention.map((a) => {
                  const to = a.to;
                  const body = (
                    <>
                      <span className="flex min-w-0 items-start gap-3">
                        {a.alarm ? <AlertOctagon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />}
                        <span className="min-w-0">
                          <span className="block text-[15px] font-medium leading-5 text-ink [overflow-wrap:anywhere]">
                            <span className="sr-only">{a.alarm ? 'Alarm: ' : 'Uyarı: '}</span>
                            {a.title}
                          </span>
                          <span className="mt-0.5 block text-xs leading-4 text-muted [overflow-wrap:anywhere]">{a.meta}</span>
                        </span>
                      </span>
                      {to && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />}
                    </>
                  );
                  return (
                    <li key={a.key}>
                      {to ? (
                        <button type="button" onClick={() => navigate(to)} className={ROW_BUTTON}>
                          {body}
                        </button>
                      ) : (
                        <div className={ROW_STATIC}>{body}</div>
                      )}
                    </li>
                  );
                })
              )}
            </Group>
          </div>
        </div>
        {REMOTE && <UzaktanYonetimKarti className="mt-4" />}
      </div>
    </Stage>
  );
}

/**
 * Gün sonu (uzaktan, gün kapalıyken): Z toplamı, adisyon, ödemeler ve kasa farkı (fark: sayılan eksi beklenen; eksi
 * kasada eksik). Kasa rakamları yalnız kör kasa kapalıysa gelir
 */
function DayCloseGroup({ c }: { c: NonNullable<PatronData['lastClose']> }) {
  const diff = c.cash?.diff;
  return (
    <Group title={`Gün sonu · Z ${c.zNo}`} label="Son gün sonu" meta={`${fmtDateLong(c.date)} · ${fmtTime(c.closedAt)}`}>
      <Row label="Z toplamı" sub={`KDV dahil · ${c.receipts} adisyon`}>
        <Amount k={c.netSales} />
      </Row>
      {c.payments.length ? (
        c.payments.map((p) => (
          <Row key={p.name} label={p.name} sub={`${p.count} işlem`}>
            <Amount k={p.amount} />
          </Row>
        ))
      ) : (
        <QuietRow>Ödeme alınmadı</QuietRow>
      )}
      {c.offDevice && <OffDeviceRow off={c.offDevice} />}
      {c.cash && (
        <Row label="Kasa farkı" sub={c.cash.counted == null ? `Sayılmadan kapandı · beklenen nakit ${tl(c.cash.expected)}` : `sayılan ${tl(c.cash.counted)}, beklenen ${tl(c.cash.expected)}`}>
          {c.cash.counted == null ? (
            <Faint>sayılmadı</Faint>
          ) : (
            <span className={cn('tabular whitespace-nowrap text-[15px] font-semibold', diff ? (diff < 0 ? 'text-danger-ink' : 'text-warning-ink') : 'text-success-ink')}>{!diff ? 'yok' : `${tlShort(Math.abs(diff))} ${diff < 0 ? 'eksik' : 'fazla'}`}</span>
          )}
        </Row>
      )}
    </Group>
  );
}

/**
 * Yazarkasadan geçmeyen (gün içi ve gün sonu kartı): mali fişi yazarkasada kesilmeyen kart ve nakit, bahşiş hariç
 * (shared/order-calc.ts `offDeviceTotals`). Dokununca neyi saydığı açılır; ikisi de sıfırsa "yok"
 */
function OffDeviceRow({ off }: { off: OffDeviceTotals }) {
  const total = off.card + off.cash;
  return (
    <Row
      label="Yazarkasadan geçmeyen"
      sub={total > 0 ? <Pairs parts={[`kart ${tlShort(off.card)}`, `nakit ${tlShort(off.cash)}`]} /> : undefined}
      detail="Cihaza gitmeden LafPOS’a yazılan kart ve nakit, bahşiş hariç (kısmi tutar, kişi payı, “Başka yoldan aldım”, yazarkasa kapalıyken alınan); mali fişi yazarkasada ayrıca kesilir"
    >
      {total > 0 ? <Amount k={total} /> : <Faint>yok</Faint>}
    </Row>
  );
}
