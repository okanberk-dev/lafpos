import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, ChevronRight, RotateCcw } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { tl, tlShort } from '@shared/money';
import { fmtAgo, fmtTime } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Badge, Card, EmptyState, ErrorState, PageHeader, SizeTag, Skeleton, Stat } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { staleCostsText } from '@/lib/lafmaliyet';
import { hourBars } from '@/lib/period';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';

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
}

/** Dikkat isteyenlerde ilk bakışta en çok bu kadar satır; gerisi "Tümünü göster"le aynı kartta açılır */
const ATTENTION_ROWS = 4;

/** Satır listesi ayracı (DESIGN: satır ayracı, kart çizgisinden bir ton açık) */
const ROWS = 'divide-y divide-[var(--admin-divider)]';

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
 * Üst blok: ciro kartı ve karolar. Beş karo (online siparişli gün) iki sütunda üç satır olup ciro kartını uzatırdı: geniş
 * ızgarada karolar tablette ve geniş ekranda üç sütun, ciro kartı daralır. İskelet ve sayfa aynı kuraldan çizer.
 */
const topGrid = (wide: boolean) => cn('grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]', wide && 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]');
const tileGrid = (wide: boolean) => cn('grid grid-cols-2 gap-3 [&>:last-child:nth-child(odd)]:col-span-2', wide && 'md:grid-cols-3 lg:grid-cols-2 xl:grid-cols-3');

export default function PatronPage() {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const sizeLabels = useBoot().settings.sizeLabels;
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
      <div role="status" aria-label="Canlı rakamlar yükleniyor…" className="h-full overflow-hidden p-4 md:p-6">
        <div className="max-md:hidden">
          <PageHeader title="Patron paneli" subtitle="Canlı rakamlar yükleniyor…" />
        </div>
        <Skeleton className="mb-4 h-5 w-56 md:hidden" />
        <div className={topGrid(false)}>
          <Skeleton className="h-[236px] rounded-2xl" />
          <div className={tileGrid(false)}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[112px] rounded-2xl" />
            ))}
          </div>
        </div>
      </div>
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
  const stale = data.isError || now - data.dataUpdatedAt > 3 * (REMOTE ? 10_000 : 60_000);
  const statusText = joinMeta([d.dayOpen ? 'Gün açık' : 'Gün kapalı', stale ? `son güncelleme ${fmtTime(d.now)}` : `${fmtTime(d.now)} itibarıyla`, stale ? data.isError && 'yenilenemedi' : 'canlı']);
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

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      {/* Telefonda ekranın adı üst şeritte: burada yalnız durum satırı (başlık ekran okuyucuya) */}
      <div className="max-md:hidden">
        <PageHeader
          title="Patron paneli"
          subtitle={
            <span className="inline-flex items-center gap-2">
              {dot}
              {statusText}
            </span>
          }
          actions={retry}
        />
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1 md:hidden">
        <h1 className="sr-only">Patron paneli</h1>
        {dot}
        <span className="text-[13px] text-muted">{statusText}</span>
        {retry}
      </div>

      <div className={topGrid(wideTiles)}>
        {/* Kart boyu karolarla uzarsa boşluk kıyasların üstünde kalır, altında değil */}
        <div className="@container flex flex-col rounded-2xl border border-line bg-surface p-5 shadow-[var(--shadow-card)]">
          <div className="text-[13px] font-medium text-muted">Bugünkü ciro</div>
          <div className="tabular mt-2 whitespace-nowrap font-headline text-[length:min(44px,14cqi)] font-extrabold leading-none tracking-[-0.035em] sm:text-[length:min(56px,14cqi)]">{tl(d.netSales)}</div>
          <p className="mt-2 text-sm text-muted">
            <Pairs parts={[d.orders > 0 ? `${d.orders} adisyon kapandı` : 'Henüz kapanan adisyon yok', d.orders > 0 && `ortalama ${tl(d.avgCheck)}`, d.open.count > 0 && `açıkta ${tl(d.open.total)}`]} />
          </p>
          <div className="mt-auto grid gap-2 pt-4 sm:grid-cols-2">
            <CompareRow label="Geçen hafta bu saate kadar" value={d.compare.lastWeek.netSales} change={d.compare.lastWeek.change} />
            <CompareRow label="4 hafta önce bu saate kadar" value={d.compare.fourWeeks.netSales} change={d.compare.fourWeeks.change} />
          </div>
        </div>
        {/* Tek kalan son karo satırı doldurur (boş hücre bırakmaz); beş karo tablette ve geniş ekranda üç sütun */}
        <div className={tileGrid(wideTiles)}>{tiles}</div>
      </div>

      <Card
        title="Dikkat isteyenler"
        actions={attention.length > 0 && <Badge tone={attention.some((a) => a.alarm) ? 'danger' : 'warning'}>{attention.length}</Badge>}
        // Satırın üzerine gelme zemini kartın yuvarlak köşesinden taşmasın
        className="mt-3 overflow-hidden"
      >
        {attention.length === 0 ? (
          <EmptyState compact art="favori" title="Her şey yolunda">
            İptal, ikram ve kasa farkı uyarıları burada görünür
          </EmptyState>
        ) : (
          <>
            <ul className={ROWS}>
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
                const row = 'flex min-h-11 w-full items-start gap-3 px-4 py-3 text-left text-sm';
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
                className="flex min-h-11 w-full items-center gap-1 border-t border-[var(--admin-divider)] px-4 text-left text-[13px] font-medium text-[var(--admin-primary)] transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press"
              >
                Tümünü göster ({attention.length})
              </button>
            )}
          </>
        )}
      </Card>

      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card
          title="Bugün saat saat"
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
          <div className="p-4">
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
                seriesLabel="Bugün"
                compareLabel={hasLastWeek ? 'Geçen hafta aynı gün' : undefined}
                ariaLabel={hasLastWeek ? 'Bugünün saatlik cirosu, geçen haftayla' : 'Bugünün saatlik cirosu'}
                emptyLabel="Bugün henüz satış yok"
              />
            )}
          </div>
        </Card>
        {/* Boş durum kartın ortasında: kart grafikle aynı boya uzar */}
        <Card title="Ödeme türleri" className="flex flex-col">
          {d.payments.length ? (
            <div className="p-4">
              <BarList items={d.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')}` }))} format={tl} />
            </div>
          ) : (
            // Satışsız günün çizimi grafikte; burada kısa not
            <EmptyState compact className="flex-1" title="Bugün henüz ödeme alınmadı">
              Adisyonlar kapandıkça ödeme türleri burada toplanır
            </EmptyState>
          )}
        </Card>
      </div>

      {/* Son satırda kartlar kendi boyunda: kısa liste uzun listenin boyuna uzayıp boş beyaz bırakmaz */}
      <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2 lg:items-start">
        <Card title="En çok satanlar" subtitle={d.top.length ? 'Bugün, ciro sırasıyla' : undefined}>
          {d.top.length === 0 ? (
            <EmptyState compact title="Sıralama ilk satışla başlar">
              İlk adisyon kapanınca en çok satanlar burada sıralanır
            </EmptyState>
          ) : (
            <ol className={ROWS}>
              {d.top.map((p, i) => {
                const size = sizeName(p.size);
                return (
                  <li key={p.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span aria-hidden="true" className="tabular grid size-7 shrink-0 place-items-center rounded-full bg-surface-3 text-xs font-semibold">
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
          {staleCosts && <p className="border-t border-[var(--admin-divider)] px-4 py-3 text-xs font-medium text-warning-ink">{staleCosts}</p>}
        </Card>
        <Card title="Açık adisyonlar" actions={d.openChecks.length > 0 && <Badge>{d.openChecks.length}</Badge>} className="overflow-hidden">
          {d.openChecks.length === 0 ? (
            <EmptyState compact art="fis" title="Şu an açık adisyon yok">
              Açılan adisyonlar ödenene kadar burada görünür
            </EmptyState>
          ) : (
            <ul className={ROWS}>
              {d.openChecks.map((o) => (
                <li key={o.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/adisyon/${o.id}`)}
                    className="flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press"
                  >
                    <span className="min-w-0 flex-1">
                      {/* Masa kartındaki durumlar yazıyla: hesap istendi amber, kısmen ödendi pembe */}
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <span className="font-medium">{o.place}</span>
                        <span className="text-muted">#{o.no}</span>
                        {o.billPrinted && <Badge tone="warning">Hesap istendi</Badge>}
                        {o.paid > 0 && <Badge tone="pink">Kısmen ödendi</Badge>}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted">{joinMeta([fmtAgo(o.openedAt, now), o.waiter])}</span>
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="tabular block font-semibold">{tl(o.total - o.paid)}</span>
                      {o.paid > 0 && <span className="block text-xs text-muted">kalan</span>}
                    </span>
                    <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

/**
 * Kıyas: telefonda tek satır (etiket solda, tutar ve değişim sağda; uzun etiket kırılır, kesilmez), geniş ekranda
 * etiket üstte, tutar ve değişim altta
 */
function CompareRow({ label, value, change }: { label: string; value: number; change: number | null }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-2.5 sm:flex-col sm:items-stretch sm:gap-1 sm:py-3">
      <span className="min-w-0 text-balance text-xs text-muted">{label}</span>
      <span className="flex shrink-0 items-center gap-2 sm:justify-between">
        <span className="tabular text-[15px] font-semibold">{tl(value)}</span>
        <Change value={change} base={value} />
      </span>
    </div>
  );
}
