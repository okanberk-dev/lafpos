import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, BarChart3, CalendarDays, ChevronRight, CreditCard, Receipt, RotateCcw } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { tl, tlShort } from '@shared/money';
import { fmtAgo, fmtDateLong, fmtTime, TZ } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Badge, Card, EmptyState, ErrorState, Notice, SizeTag, Skeleton, Stat } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { staleCostsText } from '@/lib/lafmaliyet';
import { hourBars } from '@/lib/period';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { fmtClock, REMOTE, remoteFreshness } from '@/lib/remote';

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
  payments: { name: string; amount: number; count: number; share: number }[];
  discounts: number;
  complimentary: number;
  /** Eski sunucu ve uzaktan demo özeti (api/demo-ozet.json) göndermez */
  odenmez?: number;
  zayi?: number;
  voided: number;
  online: { orders: number; amount: number };
  top: { key: string; name: string; size: string; qty: number; revenue: number; margin: number | null }[];
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
    cash: { expected: number; counted: number | null; diff: number | null } | null;
  } | null;
}

/** Dikkat isteyenlerde ilk bakışta en çok bu kadar satır; gerisi "Tümünü göster"le aynı kartta açılır */
const ATTENTION_ROWS = 4;

/** Satır listesi ayracı (DESIGN: satır ayracı, kart çizgisinden bir ton açık) */
const ROWS = 'divide-y divide-[var(--admin-divider)]';

/** Pano yaprağının iç payı: kart gölgesi kaydırma kabında kesilmesin diye kenardan biraz içeride */
const PAD = 'px-1 pb-8 pt-1 md:px-2 md:pt-2';
/** Pano kartı (ui/misc Card'ın kabı, başlıksız): köşe 18, zeminde kenarsız ve yumuşak gölgeli */
const PANEL = 'min-w-0 rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface shadow-[var(--card-shadow)]';

/**
 * Ayraçlı meta satırı: satır ayraçta kırılır, etiket tutarından ayrılmaz ("açıkta" bir satırda, "₺2.410,00"
 * ötekinde kalmaz). Boş ya da false parça düşer.
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
 * Değişim yüzdesi (kitin rozeti; yön ok ve gizli yazıyla, renk tek başına değil). Hesaplanamıyorsa nedeni: kıyas
 * günü satış yoksa "satış yoktu" (rakam yanında, "veri yok" eksik kayıt ya da arıza gibi okunuyordu). Sıfır
 * değişim yeşil artış değil, "değişmedi"
 */
function Change({ value, base }: { value: number | null; base: number }) {
  if (value == null)
    return (
      <span className="whitespace-nowrap text-xs text-muted" title="Yüzde hesaplanamaz">
        {base === 0 ? 'satış yoktu' : 'kıyas yok'}
      </span>
    );
  if (value === 0) return <Badge>değişmedi</Badge>;
  const up = value > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <Badge tone={up ? 'success' : 'danger'} className="tabular gap-0.5 font-semibold">
      <Arrow aria-hidden="true" className="size-3" />%{Math.abs(value).toLocaleString('tr-TR')}
      <span className="sr-only">{up ? ' arttı' : ' azaldı'}</span>
    </Badge>
  );
}

/**
 * Pano yerleşimi (20 Kasım 2026, operatör: panonun ölçüleri; .lp-board, index.css). Geniş ekranda (xl) üstte karolar
 * (dünkü ciro, açık adisyon, indirim ve ikram, iptal, online) tek sıra kart; altında üç sütun: solda marka ciro kartı ve
 * geçen haftayla kıyas, ortada saat saat grafik, sağda ödeme türleri. Tablette karolar, sonra ciro ve grafik yan yana,
 * ödeme türleri tam en. Telefonda önce ciro kartı (patronun ilk baktığı rakam), sonra karolar, grafik ve ödemeler. İskelet
 * ve sayfa aynı kuraldan çizer, yüklenince kaymaz.
 */
const topGrid = (wide: boolean) => cn('lp-board', wide && 'lp-board-wide');
const tileGrid = (wide: boolean) => cn('grid grid-cols-2 gap-4 [grid-area:tiles] [&>:last-child:nth-child(odd)]:max-md:col-span-2', wide ? 'md:grid-cols-5' : 'md:grid-cols-4');

export default function PatronPage() {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const boot = useBoot();
  const me = useAuth((s) => s.me)!;
  const sizeLabels = boot.settings.sizeLabels;
  const now = useTick(30_000);
  const [table, setTable] = useState(false);
  const [allAttention, setAllAttention] = useState(false);
  const data = useQuery({ queryKey: ['patron'], queryFn: () => get<PatronData>('/reports/patron'), refetchInterval: REMOTE ? 10_000 : 60_000 });

  // Satış ve kasa olaylarında yenile; uyarılar anında bildirim olarak düşer
  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'orders' || e.topic === 'cash') qc.invalidateQueries({ queryKey: ['patron'] });
        if (e.topic === 'alerts' && e.message) toast.warn(e.message);
      }),
    [qc],
  );

  // İlk yükleme: sayfanın biçiminde iskelet (başlık, büyük ciro kartı ve dört karo), spinner değil. Izgara içerikle aynı
  // kuraldan (topGrid, tileGrid): online siparişli günün beşinci karosu veriyle gelir; kurulumun çoğunda (site bağlı değil
  // ya da günün ilk online siparişi gelmedi) dört karo kalır, sayfa yüklenince kaymaz
  if (data.isPending) {
    return (
      <Stage name="Patron paneli" sub="Canlı rakamlar yükleniyor…" leafLabel="Patron paneli" float>
        <div role="status" aria-label="Canlı rakamlar yükleniyor…" className={PAD}>
          <div className={topGrid(false)}>
            <div className={tileGrid(false)}>
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[118px] rounded-[var(--r-card)]" />
              ))}
            </div>
            <Skeleton className="h-[330px] rounded-[var(--r-card)] [grid-area:ciro]" />
            <Skeleton className="h-[330px] rounded-[var(--r-card)] [grid-area:chart]" />
            <Skeleton className="h-[330px] rounded-[var(--r-card)] [grid-area:pay] max-xl:hidden" />
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
  const charted = visibleHours.some((h) => h.value || h.compare);
  // Geçen haftanın aynı günü satışsızsa kıyas çizgisi, açıklaması ve tablo sütunu yok (eksende düz çizgi kalın bir
  // taban gibi okunuyordu)
  const hasLastWeek = visibleHours.some((h) => h.compare);

  // "Canlı" yalnız rakamlar tazeyken: yenileme düşerse son veri kalır ama saat verinin saatidir, nokta amber
  // Uzakta ayrıca kafenin kendisi: gün açıkken son itme 10 dakikadan eskiyse kafeden veri gelmiyor
  const cafeSilent = REMOTE && remoteFreshness(Math.max(now, Date.now()), d.now, d.dayOpen) === 'stale';
  const stale = data.isError || cafeSilent || now - data.dataUpdatedAt > 3 * (REMOTE ? 10_000 : 60_000);
  const statusText = REMOTE
    ? joinMeta([d.dayOpen ? 'Gün açık' : 'Gün kapalı', `son güncelleme ${fmtClock(d.now)}`, cafeSilent ? 'kafeden veri gelmiyor' : data.isError ? 'yenilenemedi' : d.dayOpen && 'canlı'])
    : joinMeta([d.dayOpen ? 'Gün açık' : 'Gün kapalı', stale ? `son güncelleme ${fmtTime(d.now)}` : `${fmtTime(d.now)} itibarıyla`, stale ? data.isError && 'yenilenemedi' : 'canlı']);
  // Durumu nokta ve yazı birlikte anlatır; sürekli nabız yok
  const dot = <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', stale ? 'bg-[var(--admin-warning)]' : d.dayOpen ? 'bg-[var(--admin-success)]' : 'bg-muted')} />;
  // Hata durumundaki (ErrorState) yeniden denemeyle aynı düğme
  const retry = data.isError && (
    <Button size="sm" icon={<RotateCcw className="size-4" />} loading={data.isFetching} onClick={() => void data.refetch()}>
      Yeniden dene
    </Button>
  );

  // İndirim ve ikram karosunun dökümü: değeri oluşturan yalnız sıfırdan büyük kalemler (ikram ödenmez ve zayi dışı;
  // Raporlar'daki lossParts'la aynı kural ve kısa tutar, iptal ayrı karoda)
  const odenmez = d.odenmez ?? 0;
  const zayi = d.zayi ?? 0;
  const ikram = Math.max(0, d.complimentary - odenmez - zayi);
  const lossParts = [d.discounts > 0 && `indirim ${tlShort(d.discounts)}`, ikram > 0 && `ikram ${tlShort(ikram)}`, odenmez > 0 && `ödenmez ${tlShort(odenmez)}`, zayi > 0 && `zayi ${tlShort(zayi)}`]
    .filter((p): p is string => !!p)
    .map((p, i) => (i === 0 ? p.charAt(0).toLocaleUpperCase('tr-TR') + p.slice(1) : p));

  // Karolar: sayıları ızgarayı seçer (tek kalan son karo satırı doldurur, boşluk kalmaz)
  const tiles = [
    <Stat key="dun" label="Dünkü ciro" value={tl(d.yesterday.netSales)} hint={`${d.yesterday.receipts} adisyon`} />,
    // "Açık hesap" kasada müşterinin cari hesabıdır (ödeme türü, Müşteriler); burada ödenmemiş adisyonlar
    <Stat key="acik" label="Açık adisyon" value={String(d.open.count)} hint={d.open.count ? `Tahsil edilecek ${tl(d.open.total)}` : 'Bekleyen tahsilat yok'} />,
    <Stat key="indirim" label="İndirim ve ikram" value={tl(d.discounts + d.complimentary)} hint={lossParts.length ? <Pairs parts={lossParts} /> : undefined} />,
    <Stat key="iptal" label="İptal" value={tl(d.voided)} />,
    d.online.orders > 0 && (
      <Stat
        key="online"
        label={
          // Online (siteden gelen) sipariş her ekranda mor
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-violet-ink" />
            Online sipariş
          </span>
        }
        value={tl(d.online.amount)}
        hint={`${d.online.orders} sipariş · sitede ödendi`}
      />
    ),
  ].filter(Boolean);
  // Beş karo iki sütunda üç satır olur ve ciro kartını uzatırdı: geniş ekranda karolar üç sütun, iki satır; tek kalan
  // son karo iki sütun kaplar (2 + 3 ya da 3 + 1 + 2), ızgarada boş hücre kalmaz
  const wideTiles = tiles.length >= 5;

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

  // Selamlama (panonun "Welcome back, Alex"ı): günün saatine göre, ad ev yeşilinde
  const hourNow = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' }).format(d.now));
  const greeting = hourNow < 5 ? 'İyi geceler' : hourNow < 11 ? 'Günaydın' : hourNow < 17 ? 'İyi günler' : hourNow < 22 ? 'İyi akşamlar' : 'İyi geceler';
  const firstName = me.name.trim().split(/\s+/)[0] ?? me.name;
  const paid = d.payments.reduce((a, p) => a + p.amount, 0);
  // Geçen haftaya göre fark (panonun "Haftalık gelir +3.945" kartı): bu saate kadar ciro farkı ve yüzdesi
  const diff = d.netSales - d.compare.lastWeek.netSales;
  // Ciro eğrisi (kıyas kartındaki küçük çizgi): bugünün saat saat birikimi
  const spark = visibleHours.reduce<number[]>((acc, h) => [...acc, (acc.at(-1) ?? 0) + h.value], []);
  const peak = visibleHours.reduce((best, h, i) => (h.value > (visibleHours[best]?.value ?? 0) ? i : best), 0);
  const canKasa = !REMOTE && (['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor'] as const).some((p) => can(p));
  const canReports = !REMOTE && can('rapor.gor');

  // Tarih (panonun tarih aralığı düğmesi): yalnız bilgi, dokunulmaz
  const dateChip = (
    <span className="inline-flex h-10 items-center gap-2 rounded-xl border border-[var(--card-line)] bg-surface px-3.5 text-sm font-medium text-ink-2 shadow-[var(--card-shadow)] max-sm:hidden">
      <CalendarDays aria-hidden="true" className="size-4 text-muted" />
      <span className="tabular">{fmtDateLong(d.date)}</span>
    </span>
  );

  return (
    // Pano: başlık satırında selamlama (ad ev yeşilinde), canlılık ve tarih; zeminde yüzen kartlar: karolar, marka ciro
    // kartı ve kıyas, saat saat grafik, ödeme türleri, açık adisyonlar, dikkat isteyenler ve en çok satanlar
    <Stage
      name={
        <>
          {greeting}, <span className="text-[var(--admin-primary)]">{firstName}</span>
          <span className="sr-only"> · Patron paneli</span>
        </>
      }
      sub={
        <span className="inline-flex items-center gap-2">
          {dot}
          {statusText}
        </span>
      }
      actions={
        <>
          {retry}
          {dateChip}
        </>
      }
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
        {REMOTE && !d.dayOpen && d.lastClose && <DayCloseCard c={d.lastClose} />}
        <div className={topGrid(wideTiles)}>
          {/* Karolar: tek sıra kart (telefonda iki sütun) */}
          <div className={tileGrid(wideTiles)}>{tiles}</div>

          {/* Marka ciro kartı: zeminde tek başına ev yeşili degrade, beyaz iri rakam (kart içinde kart yok; başlığı kartın
              kendisi söyler) */}
          <section aria-label="Bugünkü ciro" className="flex flex-col gap-4 [grid-area:ciro]">
            <div>
              <div className="@container relative overflow-hidden rounded-[var(--r-card)] bg-[image:var(--brand-card)] p-6 text-white shadow-[0_18px_36px_-20px_rgb(6_74_54/0.75)]">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-headline text-lg font-bold italic tracking-[-0.02em]">L’Affogato</span>
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-white/90">
                    <span aria-hidden="true" className={cn('size-1.5 rounded-full', stale ? 'bg-[#ffe39a]' : 'bg-[#7ff0c0]')} />
                    {stale ? 'Son güncelleme' : 'Canlı'}
                  </span>
                </div>
                <div className="mt-5 text-[13px] text-white/90">Bugünkü ciro · KDV dahil</div>
                <div className="tabular mt-1 whitespace-nowrap font-headline text-[length:min(40px,15cqi)] font-bold leading-none tracking-[-0.035em]">{tl(d.netSales)}</div>
                <div className="mt-5 flex items-center justify-between gap-3 text-[13px] text-white/90">
                  <span className="tabular">{d.orders > 0 ? `${d.orders} adisyon · ortalama ${tlShort(d.avgCheck)}` : 'Henüz kapanan adisyon yok'}</span>
                  <span className="tabular shrink-0">{d.dayOpen && boot.day ? `Z ${boot.day.zNo}` : 'Gün kapalı'}</span>
                </div>
              </div>
            </div>
            {/* Geçen haftayla kıyas (panonun haftalık gelir kartı): fark, değişim rozeti ve günün ciro eğrisi */}
            <div className={cn(PANEL, 'flex items-end justify-between gap-3 p-5')}>
              <div className="min-w-0">
                <div className="text-[13px] font-medium text-muted">Geçen hafta bu saate göre</div>
                <div className="tabular mt-2 whitespace-nowrap font-headline text-[26px] font-bold leading-none tracking-[-0.035em]">
                  {diff > 0 ? '+' : diff < 0 ? '−' : ''}
                  {tl(Math.abs(diff))}
                </div>
                <div className="mt-1.5 text-xs text-muted">
                  <Pairs parts={[`geçen hafta ${tlShort(d.compare.lastWeek.netSales)}`, `4 hafta önce ${tlShort(d.compare.fourWeeks.netSales)}`]} />
                </div>
              </div>
              <div className="flex shrink-0 flex-col items-end gap-2">
                <Change value={d.compare.lastWeek.change} base={d.compare.lastWeek.netSales} />
                <Spark values={spark} />
              </div>
            </div>
          </section>

          <Card
            divided={false}
            title={
              <span className="flex items-center gap-2.5">
                <IconChip>
                  <BarChart3 />
                </IconChip>
                Bugün saat saat
              </span>
            }
            className="flex flex-col [grid-area:chart]"
            actions={
              charted && (
                <Segmented
                  size="sm"
                  label="Görünüm"
                  value={table ? 'tablo' : 'grafik'}
                  onChange={(v) => setTable(v === 'tablo')}
                  options={[
                    { value: 'grafik', label: 'Grafik' },
                    { value: 'tablo', label: 'Tablo' },
                  ]}
                />
              )
            }
          >
            <div className="flex-1 px-5 pb-5 pt-3">
              {table && charted ? (
                <table className="tabular w-full text-sm">
                  <caption className="sr-only">Bugünün saatlik cirosu{hasLastWeek ? ', geçen haftanın aynı günüyle' : ''}</caption>
                  <thead className="text-xs text-muted">
                    <tr>
                      <th scope="col" className="py-1 text-left font-medium">
                        Saat
                      </th>
                      <th scope="col" className="py-1 text-right font-medium">
                        Bugün
                      </th>
                      {hasLastWeek && (
                        <th scope="col" className="py-1 text-right font-medium">
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
                          <td className="py-1.5">{h.title}</td>
                          <td className="py-1.5 text-right font-semibold">{tl(h.value)}</td>
                          {hasLastWeek && <td className="py-1.5 text-right text-muted">{tl(h.compare ?? 0)}</td>}
                        </tr>
                      ))}
                  </tbody>
                </table>
              ) : (
                <ColumnChart
                  data={visibleHours}
                  format={tl}
                  pillFormat={tlShort}
                  highlight={peak}
                  height={292}
                  seriesLabel="Bugün"
                  compareLabel={hasLastWeek ? 'Geçen hafta aynı gün' : undefined}
                  ariaLabel={hasLastWeek ? 'Bugünün saatlik cirosu, geçen haftayla' : 'Bugünün saatlik cirosu'}
                  emptyLabel="Bugün henüz satış yok"
                />
              )}
            </div>
          </Card>

          {/* Ödeme türleri (panonun bakiye kartı): ortada toplam tahsilat, dökümü ve kasaya, raporlara geçiş */}
          <div className={cn(PANEL, 'flex flex-col p-5 [grid-area:pay]')}>
            <PanelHead title="Ödeme türleri" sub="Bugün alınan ödemeler" icon={<CreditCard />} />
            {d.payments.length ? (
              <>
                <div className="mt-4 text-center">
                  <div className="text-[13px] text-muted">Toplam tahsilat</div>
                  <div className="tabular mt-1 font-headline text-[32px] font-bold leading-none tracking-[-0.035em]">{tl(paid)}</div>
                </div>
                <div className="mt-5 rounded-[var(--r-tile)] bg-surface-2 p-4">
                  <BarList items={d.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')}` }))} format={tl} />
                </div>
              </>
            ) : (
              // Satışsız günün çizimi grafikte; burada kısa not
              <EmptyState compact className="flex-1" title="Bugün henüz ödeme alınmadı">
                Adisyonlar kapandıkça ödeme türleri burada toplanır
              </EmptyState>
            )}
            {(canKasa || canReports) && (
              <div className="mt-auto grid grid-cols-2 gap-3 pt-5">
                {canKasa && (
                  <Button variant="primary" block onClick={() => navigate('/kasa')} className={cn(!canReports && 'col-span-2')}>
                    Kasa
                  </Button>
                )}
                {canReports && (
                  <Button variant="soft" block icon={<BarChart3 className="size-4" />} onClick={() => navigate('/raporlar')} className={cn(!canKasa && 'col-span-2')}>
                    Raporlar
                  </Button>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Alt blok (panonun ödeme geçmişi ve sağ sütunu): açık adisyonlar tablosu; dikkat isteyenler ve en çok satanlar */}
        <div className="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2.3fr)_minmax(0,0.95fr)] xl:items-start">
          <Card divided={false} title="Açık adisyonlar" subtitle="Ödenene kadar burada; dokununca adisyon açılır" actions={d.openChecks.length > 0 && <Badge>{d.openChecks.length}</Badge>} className="overflow-hidden">
            {d.openChecks.length === 0 ? (
              <EmptyState compact art="fis" title="Şu an açık adisyon yok">
                Açılan adisyonlar ödenene kadar burada görünür
              </EmptyState>
            ) : (
              <div className="px-3 pb-3 pt-2">
                {/* Sütun başlıkları (panonun tablosu): yer, açılış, durum, kalan; telefonda satır kartı */}
                <div aria-hidden="true" className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_1rem] gap-3 px-3 pb-2 text-xs font-medium text-muted max-md:hidden">
                  <span>Yer</span>
                  <span>Açıldı</span>
                  <span>Durum</span>
                  <span className="text-right">Kalan</span>
                  <span />
                </div>
                <ul className="space-y-1.5">
                  {d.openChecks.map((o) => {
                    const state = o.billPrinted ? { text: 'Hesap istendi', cls: 'text-signal-ink', dot: 'bg-[var(--admin-signal)]' } : o.paid > 0 ? { text: 'Kısmen ödendi', cls: 'text-rose-ink', dot: 'bg-[var(--admin-hue-rose)]' } : { text: 'Açık', cls: 'text-success-ink', dot: 'bg-[var(--admin-success)]' };
                    return (
                      <li key={o.id}>
                        <button
                          type="button"
                          onClick={() => navigate(`/adisyon/${o.id}`)}
                          className="grid min-h-14 w-full grid-cols-[auto_minmax(0,1fr)_auto_1rem] items-center gap-3 rounded-[var(--r-tile)] bg-surface-2 px-3 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-[var(--hover-solid)] focus-visible:-outline-offset-2 active:bg-press md:grid-cols-[minmax(0,1.6fr)_minmax(0,0.8fr)_minmax(0,1fr)_minmax(0,0.9fr)_1rem]"
                        >
                          <span className="flex min-w-0 items-center gap-3 max-md:contents">
                            <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]">
                              <Receipt className="size-[18px]" />
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate font-semibold">
                                {o.place} <span className="font-normal text-muted">#{o.no}</span>
                              </span>
                              <span className="block truncate text-xs text-muted">
                                {o.waiter ?? 'Garson yok'}
                                <span className="md:hidden"> · {fmtAgo(o.openedAt, now)}</span>
                              </span>
                            </span>
                          </span>
                          <span className="tabular text-ink-2 max-md:hidden">{fmtTime(o.openedAt)}</span>
                          <span className={cn('inline-flex items-center gap-1.5 text-[13px] font-medium max-md:hidden', state.cls)}>
                            <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', state.dot)} />
                            {state.text}
                          </span>
                          <span className="tabular text-right font-semibold">
                            {tl(o.total - o.paid)}
                            <span className="block text-xs font-normal text-muted md:hidden">{state.text}</span>
                          </span>
                          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </Card>

          <div className="flex min-w-0 flex-col gap-4">
            <Card
              divided={false}
              title="Dikkat isteyenler"
              actions={attention.length > 0 && <Badge tone={attention.some((a) => a.alarm) ? 'danger' : 'warning'}>{attention.length}</Badge>}
              // Satırın üzerine gelme zemini kartın yuvarlak köşesinden taşmasın
              className="overflow-hidden"
            >
              {attention.length === 0 ? (
                <EmptyState compact art="favori" title="Her şey yolunda">
                  İptal, ikram ve kasa farkı uyarıları burada görünür
                </EmptyState>
              ) : (
                <>
                  <ul className={cn(ROWS, 'pt-1')}>
                    {shownAttention.map((a) => {
                      const to = a.to;
                      const body = (
                        <>
                          {a.alarm ? <AlertOctagon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />}
                          <span className="min-w-0 flex-1">
                            <span className="block font-medium [overflow-wrap:anywhere]">
                              <span className="sr-only">{a.alarm ? 'Alarm: ' : 'Uyarı: '}</span>
                              {a.title}
                            </span>
                            <span className="block text-xs text-muted [overflow-wrap:anywhere]">{a.meta}</span>
                          </span>
                        </>
                      );
                      const row = 'flex min-h-11 w-full items-start gap-3 px-5 py-3 text-left text-sm';
                      return (
                        <li key={a.key}>
                          {to ? (
                            <button type="button" onClick={() => navigate(to)} className={cn(row, 'transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press')}>
                              {body}
                              <ChevronRight aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
                            </button>
                          ) : (
                            <div className={row}>{body}</div>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {shownAttention.length < attention.length && (
                    <button
                      type="button"
                      onClick={() => setAllAttention(true)}
                      className="flex min-h-11 w-full items-center gap-1 border-t border-[var(--admin-divider)] px-5 text-left text-[13px] font-medium text-[var(--admin-primary)] transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press"
                    >
                      Tümünü göster ({attention.length})
                    </button>
                  )}
                </>
              )}
            </Card>

            <Card divided={false} title="En çok satanlar" subtitle={d.top.length ? 'Bugün, ciro sırasıyla' : undefined}>
              {d.top.length === 0 ? (
                <EmptyState compact title="Sıralama ilk satışla başlar">
                  İlk adisyon kapanınca en çok satanlar burada sıralanır
                </EmptyState>
              ) : (
                <ol className={cn(ROWS, 'pt-1')}>
                  {d.top.map((p, i) => {
                    const size = sizeName(p.size);
                    return (
                      <li key={p.key} className="flex items-center gap-3 px-5 py-2.5 text-sm">
                        <span aria-hidden="true" className={cn('tabular grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold', i === 0 ? 'bg-[var(--admin-ink-fill)] text-[var(--admin-on-ink)]' : 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]')}>
                          {i + 1}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-w-0 items-center">
                            <span className="truncate font-medium" title={p.name}>
                              {p.name}
                            </span>
                            {size && <SizeTag>{size}</SizeTag>}
                          </span>
                          <span className="block text-xs text-muted">
                            {p.qty} adet
                            {showCost && (
                              <>
                                {' · '}
                                {/* Brüt kâr KDV hariç ciro − reçete maliyeti; indirim ya da maliyet neti aşınca eksi, kırmızı */}
                                <span className={cn('whitespace-nowrap', p.margin != null && p.margin < 0 && 'text-danger-ink')}>{p.margin == null ? 'maliyet yok' : `brüt kâr ${tl(p.margin)}`}</span>
                              </>
                            )}
                          </span>
                        </span>
                        <span className="tabular shrink-0 font-semibold">{tl(p.revenue)}</span>
                      </li>
                    );
                  })}
                </ol>
              )}
              {staleCosts && <p className="border-t border-[var(--admin-divider)] px-5 py-3 text-xs font-medium text-warning-ink">{staleCosts}</p>}
            </Card>
          </div>
        </div>
      </div>
    </Stage>
  );
}

/** Pano kartının başlığı: başlık ve alt satır solda, sağda yumuşak tonlu dairede ikon (panonun hedef ikonu) */
/**
 * Gün sonu kartı (uzaktan, gün kapalıyken): Z, ciro, adisyon, ödemeler ve kasa farkı (fark: sayılan eksi beklenen; eksi
 * kasada eksik). Kasa rakamları yalnız kör kasa kapalıysa gelir
 */
function DayCloseCard({ c }: { c: NonNullable<PatronData['lastClose']> }) {
  const diff = c.cash?.diff;
  return (
    <section aria-label="Son gün sonu" className={cn(PANEL, 'mb-3 p-5')}>
      <PanelHead title={`Gün sonu · Z ${c.zNo}`} sub={`${fmtDateLong(c.date)} · ${fmtTime(c.closedAt)}`} icon={<Receipt />} />
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <div>
          <div className="text-[13px] text-muted">Z toplamı (ciro, KDV dahil)</div>
          <div className="tabular mt-1 font-headline text-[26px] font-bold leading-none tracking-[-0.035em]">{tl(c.netSales)}</div>
          <div className="mt-1.5 text-xs text-muted">{c.receipts} adisyon</div>
        </div>
        <div className="sm:col-span-2">
          {c.payments.length ? (
            <BarList items={c.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `${p.count} işlem` }))} format={tl} />
          ) : (
            <p className="text-sm text-muted">Ödeme alınmadı</p>
          )}
        </div>
      </div>
      {c.cash && (
        <p className="mt-4 border-t border-[var(--admin-divider)] pt-3 text-sm">
          {c.cash.counted == null ? (
            <>Kasa sayılmadan kapandı · beklenen nakit {tl(c.cash.expected)}</>
          ) : (
            <>
              Kasa farkı{' '}
              <span className={cn('tabular font-semibold', diff ? (diff < 0 ? 'text-danger-ink' : 'text-warning-ink') : 'text-success-ink')}>
                {!diff ? 'yok' : `${tl(Math.abs(diff))} ${diff < 0 ? 'eksik' : 'fazla'}`}
              </span>
              <span className="text-muted"> · sayılan {tl(c.cash.counted)}, beklenen {tl(c.cash.expected)}</span>
            </>
          )}
        </p>
      )}
    </section>
  );
}

function PanelHead({ title, sub, icon }: { title: string; sub?: string; icon: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-base font-semibold leading-6 tracking-[-0.015em]">{title}</h3>
        {sub && <p className="text-[13px] text-muted">{sub}</p>}
      </div>
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--admin-primary-soft)] text-[var(--admin-primary)] [&>svg]:size-[18px]">
        {icon}
      </span>
    </div>
  );
}

/** Kart başlığındaki küçük ikon karosu (panonun takvim karosu) */
function IconChip({ children }: { children: ReactNode }) {
  return (
    <span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-[10px] bg-[var(--admin-primary-soft)] text-[var(--admin-primary)] [&>svg]:size-4">
      {children}
    </span>
  );
}

/** Küçük ciro eğrisi (panonun dalga çizgisi): süs, değerler kartta yazılı */
function Spark({ values }: { values: number[] }) {
  const w = 96;
  const h = 32;
  const max = Math.max(1, ...values);
  if (values.length < 2 || !values.some((v) => v > 0)) return null;
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 3 - (v / max) * (h - 6)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  return (
    <svg aria-hidden="true" width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="overflow-visible">
      <path d={`${line} L${w},${h} L0,${h} Z`} fill="var(--admin-primary-soft)" />
      <path d={line} fill="none" stroke="var(--chart-accent)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
