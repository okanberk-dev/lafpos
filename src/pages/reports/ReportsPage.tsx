import { keepPreviousData, type UseQueryResult, useIsFetching, useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, BadgePercent, Bike, CircleDollarSign, Clock, CreditCard, Download, FileSpreadsheet, Loader2, Package, Receipt, SearchX, ShoppingBag, Timer, Users, XCircle } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { COMP_LABEL } from '@shared/comp';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { tl, tlShort } from '@shared/money';
import type { PlatformId } from '@shared/platforms';
import type { CompKind } from '@shared/types';
import { BUSINESS_HOURS, businessHourIndex, currentBusinessDate, fmtDateTime, fmtTime } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { AdminShell } from '@/components/admin/AdminShell';
import { PlatformBadge } from '@/components/PlatformBadge';
import { Card, CARD, CODE, KpiStrip, KpiStripSkeleton, PageHeader, Segmented, SetupNotes, StatusTabs, TableSkeleton } from '@/components/admin/ui';
import { Input, SearchInput } from '@/components/ui/Field';
import { EmptyState, ErrorState, ListSkeleton, Notice, Skeleton, Stat } from '@/components/ui/misc';
import { get, getToken } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useDelayed, useLocalPref } from '@/lib/hooks';
import { joinMeta } from '@/lib/text';
import { staleCostsText } from '@/lib/lafmaliyet';
import { byBusinessHour, fmtShortDate, hourTitle, PERIOD_LABELS, type PeriodKey, periodRange, rangeLabel } from '@/lib/period';
import { toast } from '@/lib/toast';
import { lossParts, previousShort } from '@/lib/reportLabels';

type ReportKey = 'ciro' | 'urunler' | 'saatlik' | 'hazirlama' | 'adisyon' | 'platformlar' | 'kayip' | 'happy' | 'personel' | 'aktarim';
type ProductView = 'urun' | 'kategori';
type LossKind = 'iptal' | 'ikram' | 'indirim' | 'iade';

const REPORTS: { key: ReportKey; label: string; hint: string; perm?: 'rapor.maliyet' }[] = [
  { key: 'ciro', label: 'Ciro', hint: 'Gelir özeti, döküm ve önceki dönem' },
  { key: 'urunler', label: 'Ürünler', hint: 'Ürün ve kategori satışları' },
  { key: 'saatlik', label: 'Saatlik', hint: 'Yoğun saatler, gün dilimleri' },
  { key: 'hazirlama', label: 'Hazırlama süresi', hint: 'Bar ve mutfak hızı' },
  { key: 'adisyon', label: 'Adisyonlar', hint: 'Kapanan ve iptal' },
  { key: 'platformlar', label: 'Paket platformları', hint: 'Platform satışı, tahsilat ve kaçan sipariş' },
  { key: 'kayip', label: 'İptal ve indirim', hint: 'İptal, ikram, zayi, indirim, ödeme iptali' },
  { key: 'happy', label: 'Happy hour', hint: 'Kampanya etkisi' },
  { key: 'personel', label: 'Personel', hint: 'Satış, iptal, ikram', perm: 'rapor.maliyet' },
  { key: 'aktarim', label: 'lafmaliyet aktarımı', hint: 'Satışlar listesi' },
];

/** Eski sürümde kaydedilmiş sekme anahtarları: birleşen sekmeler yeni yerine açılır */
const LEGACY: Record<string, { key: ReportKey; product?: ProductView; loss?: LossKind }> = {
  satis: { key: 'urunler', product: 'urun' },
  kategori: { key: 'urunler', product: 'kategori' },
  iptal: { key: 'kayip', loss: 'iptal' },
  ikram: { key: 'kayip', loss: 'ikram' },
  indirim: { key: 'kayip', loss: 'indirim' },
  iade: { key: 'kayip', loss: 'iade' },
};

const LOSS_TABS: { value: LossKind; label: string }[] = [
  { value: 'iptal', label: 'İptaller' },
  { value: 'ikram', label: 'İkram ve zayi' },
  { value: 'indirim', label: 'İndirimler' },
  { value: 'iade', label: 'Ödeme iptalleri' },
];

export default function ReportsPage() {
  const can = useCan();
  const [saved, setReport] = useLocalPref<ReportKey>('reports.key', 'ciro');
  const legacy = LEGACY[saved];
  const report = legacy?.key ?? saved;
  const [productView, setProductView] = useLocalPref<ProductView>('reports.products', legacy?.product ?? 'urun');
  const [loss, setLoss] = useLocalPref<LossKind>('reports.loss', legacy?.loss ?? 'iptal');
  const open = (key: ReportKey, sub?: { product?: ProductView; loss?: LossKind }) => {
    if (sub?.product) setProductView(sub.product);
    if (sub?.loss) setLoss(sub.loss);
    setReport(key);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };
  const [period, setPeriod] = useLocalPref<PeriodKey>('reports.period', 'bugun');
  const boot = useBoot();
  // "Bugün" açık iş günüdür (gün 05:00'te kapanmadıysa satış ona yazılır); patron paneli ve sunucuyla aynı kural
  const today = currentBusinessDate(boot.day?.date);
  const [custom, setCustom] = useState(() => periodRange('hafta', today));
  const range = period === 'ozel' ? custom : periodRange(period, today);
  const visible = REPORTS.filter((r) => !r.perm || can(r.perm));
  const current = visible.find((r) => r.key === report) ?? visible[0];
  // Dönem değişince seçili hapta küçük gösterge (yerelde çoğu istek 50 ms; kısa yüklemede görünmez)
  const fetching = useDelayed(useIsFetching({ queryKey: ['reports'] }) > 0, 300);

  const exportCsv = async (type: string, path = `/api/reports/export.csv?type=${type}&from=${range.from}&to=${range.to}`) => {
    const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
    if (!res?.ok) {
      // Hata (ör. dönem 400 günden uzun) dosya olarak inmez, sunucunun metniyle bildirilir
      const body = (await res?.json().catch(() => null)) as { error?: string } | null;
      toast.err(body?.error ?? 'CSV alınamadı; bağlantıyı kontrol edip yeniden deneyin');
      return;
    }
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (res.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? `lafpos-${type}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <AdminShell title="Raporlar">
      <PageHeader
        title="Raporlar"
        description={`${current.hint} · ${rangeLabel(range)}`}
        actions={
          <Segmented
            label="Dönem"
            value={period}
            onChange={setPeriod}
            options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => ({
              value: k,
              label: (
                <>
                  {PERIOD_LABELS[k]}
                  {fetching && k === period && <Loader2 aria-hidden="true" className="ml-1.5 size-3.5 animate-spin" />}
                </>
              ),
            }))}
            className="max-lg:w-full max-lg:[&>*]:grow"
          />
        }
      >
        {period === 'ozel' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--admin-text-mute)]">Başlangıç</span>
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="w-auto px-2.5 [[data-area=admin]_&]:pointer-fine:h-9" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--admin-text-mute)]">Bitiş</span>
              <Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="w-auto px-2.5 [[data-area=admin]_&]:pointer-fine:h-9" />
            </label>
          </div>
        )}
      </PageHeader>
      <StatusTabs label="Rapor" value={current.key} onChange={setReport} tabs={visible.map((r) => ({ value: r.key, label: r.label }))} />
      {current.key === 'ciro' && <SummaryReport range={range} today={today} onOpen={open} />}
      {current.key === 'urunler' && (
        <div className="space-y-3">
          <Segmented label="Görünüm" value={productView} onChange={setProductView} options={[{ value: 'urun', label: 'Ürün' }, { value: 'kategori', label: 'Kategori' }]} />
          {productView === 'urun' ? <ProductsReport range={range} onExport={() => exportCsv('urunler')} /> : <CategoryReport range={range} />}
        </div>
      )}
      {current.key === 'saatlik' && <HourlyReport range={range} onExport={() => exportCsv('saatlik')} />}
      {current.key === 'hazirlama' && <PrepReport range={range} />}
      {current.key === 'adisyon' && <ChecksReport range={range} onExport={() => exportCsv('adisyonlar')} />}
      {current.key === 'platformlar' && <PlatformsReport range={range} onExport={() => exportCsv('platformlar')} />}
      {current.key === 'kayip' && (
        <div className="space-y-3">
          <Segmented label="Tür" value={loss} onChange={setLoss} options={LOSS_TABS} className="max-sm:w-full" />
          {/* Tür başına ayrı örnek: önceki türün satırları yeni türün başlığıyla görünmesin */}
          {loss === 'iade' ? <RefundsReport range={range} /> : <ItemsReport key={loss} range={range} kind={loss} onExport={() => exportCsv(loss)} />}
        </div>
      )}
      {current.key === 'happy' && <ItemsReport range={range} kind="happy" />}
      {current.key === 'personel' && <StaffReport range={range} />}
      {current.key === 'aktarim' && <ExportReport range={range} linked={boot.integrations.lafmaliyetPush} onDownload={() => exportCsv('', `/api/sync/lafmaliyet/satislar.csv?from=${range.from}&to=${range.to}`)} />}
    </AdminShell>
  );
}

type Range = { from: string; to: string };
const qs = (r: Range) => `from=${r.from}&to=${r.to}`;

function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted">önceki dönemde satış yoktu</span>;
  const up = value >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', up ? 'text-[var(--admin-success)]' : 'text-[var(--admin-danger-ink)]')}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}%{Math.abs(value).toLocaleString('tr-TR')} önceki döneme göre
    </span>
  );
}

interface Summary {
  netSales: number;
  gross: number;
  discounts: number;
  complimentary: number;
  odenmez: number;
  zayi: number;
  voided: number;
  receipts: number;
  avgCheck: number;
  itemsSold: number;
  tips: number;
  days: number;
  byDay: { date: string; netSales: number; receipts: number }[];
  payments: { name: string; amount: number; count: number; share: number }[];
  types: { type: string; orders: number; amount: number }[];
  online: { orders: number; amount: number };
  previous: { netSales: number; receipts: number; change: number | null; label: string; range?: { from: string; to: string } };
  asOf: number;
  waterfall: { list: number; complimentary: number; discounts: number; service: number; revenue: number; kdv: number; netExKdv: number };
  kdv: { rate: number; gross: number; base: number; kdv: number }[];
  reconciliation: { paidClosed: number; difference: number; paidOpen: number };
  perGuest: number | null;
}

const TYPE_LABEL: Record<string, string> = ORDER_TYPE_LABEL;


/**
 * Rapor sorgusu: dönem değişince önceki dönemin rakamları yeni gelene dek yerinde (soluk) kalır; sayfa spinner'a
 * dönüp yeniden yerleşmez
 */
function useReport<T>(key: unknown[], path: string) {
  return useQuery({ queryKey: ['reports', ...key], queryFn: () => get<T>(path), placeholderData: keepPreviousData });
}

/**
 * Raporun üç durumu tek yerde: ilk yüklemede sayfanın biçiminde iskelet; alınamadıysa sıfır ya da "satış yok"
 * gösterilmez (yanlış rakam gibi okunur), neden ve yeniden dene; arka plan yenilemesi düşerse rakamlar kalır, saati
 * söylenir. Dönem değişirken eski rakamlar soluk ve `aria-busy`
 */
function ReportBody<T>({ q, skeleton, children }: { q: UseQueryResult<T>; skeleton: ReactNode; children: (data: T) => ReactNode }) {
  const slow = useDelayed(q.isPlaceholderData, 150);
  if (q.isPending) return <>{skeleton}</>;
  if (q.data === undefined) return <ErrorState className={CARD} title="Rapor alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  return (
    <div aria-busy={q.isPlaceholderData || undefined} className={cn('transition-opacity duration-150 motion-reduce:transition-none', slow && 'opacity-60')}>
      {q.isError && (
        <Notice tone="warn" role="status" className="mb-3 text-[13px]">
          Rapor yenilenemedi; rakamlar {fmtTime(q.dataUpdatedAt)} itibarıyla. Bağlantı gelince yeniden deneyin
        </Notice>
      )}
      {children(q.data)}
    </div>
  );
}

/** Kart biçiminde iskelet (başlık şeridi ve satırlar) */
function CardSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      <div className="px-4 pt-4">
        <Skeleton className="h-4 w-48" />
      </div>
      <ListSkeleton rows={rows} />
    </div>
  );
}

function SummaryReport({ range, today, onOpen }: { range: Range; today: string; onOpen: (key: ReportKey, sub?: { product?: ProductView; loss?: LossKind }) => void }) {
  const single = range.from === range.to;
  const q = useReport<Summary>(['summary', range], `/reports/summary?${qs(range)}`);
  const hourly = useQuery({ queryKey: ['reports', 'hourly', range], queryFn: () => get<HourlyData>(`/reports/hourly?${qs(range)}`), enabled: single, placeholderData: keepPreviousData });
  const skeleton = (
    <div className="space-y-4">
      <KpiStripSkeleton />
      <div role="status" aria-label="Yükleniyor…" className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Skeleton className="h-[290px] rounded-2xl" />
        <Skeleton className="h-[290px] rounded-2xl" />
      </div>
    </div>
  );
  return (
    <ReportBody q={q} skeleton={skeleton}>
      {(s) => {
        const prev = previousShort(s.previous.label, s.previous.range);
        return (
          <div className="space-y-4">
            {/* Etiket en çok 18, referans en çok 30 karakter; ayrıntı döküm kartlarında ve tıklanınca açılan raporda */}
            <KpiStrip
              cells={[
                {
                  key: 'ciro',
                  label: 'Ciro (KDV dahil)',
                  icon: <CircleDollarSign />,
                  hue: 'blue',
                  value: tl(s.netSales),
                  delta: s.previous.change == null ? null : { text: `${s.previous.change >= 0 ? '▲' : '▼'} %${Math.abs(s.previous.change).toLocaleString('tr-TR')}`, good: s.previous.change >= 0 },
                  // Kıyas döneminde satış yoksa yüzde hesaplanamaz: "veri yok" değil, o dönem satış yoktu
                  reference: <span title={`Kıyas: ${s.previous.label}`}>{s.previous.change == null ? `${prev} satış yoktu` : `${prev}: ${tlShort(s.previous.netSales)}`}</span>,
                },
                {
                  key: 'adisyon',
                  label: 'Adisyon',
                  icon: <Receipt />,
                  hue: 'violet',
                  value: s.receipts.toLocaleString('tr-TR'),
                  reference: (
                    <>
                      <span className="block">
                        Ortalama {tlShort(s.avgCheck)} · önceki {s.previous.receipts}
                      </span>
                      {s.perGuest != null && <span className="block">Kişi başı {tlShort(s.perGuest)}</span>}
                    </>
                  ),
                  onClick: () => onOpen('adisyon'),
                },
                { key: 'urun', label: 'Satılan ürün', icon: <Package />, hue: 'amber', value: s.itemsSold.toLocaleString('tr-TR'), reference: s.days > 1 ? `${s.days} iş günü` : 'Tek iş günü', onClick: () => onOpen('urunler', { product: 'urun' }) },
                // Değer indirim ve bütün ciro dışı kalemler (ikram, ödenmez, zayi): referans hepsini söyler, sıfır olan düşer
                { key: 'indirim', label: 'İndirim ve ikram', icon: <BadgePercent />, hue: 'rose', value: tl(s.discounts + s.complimentary), reference: lossParts(s, tlShort), onClick: () => onOpen('kayip', { loss: s.complimentary > s.discounts ? 'ikram' : 'indirim' }) },
                { key: 'online', label: 'Online', icon: <ShoppingBag />, hue: 'green', value: tl(s.online.amount), reference: `Sitede ödendi · ${s.online.orders} sipariş, ciroya dahil değil` },
              ]}
            />
            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
              <Card flush title={single ? 'Saatlik ciro' : 'Günlük ciro'}>
                <div className="p-4">
                  {!single ? (
                    <ColumnChart data={s.byDay.map((d) => ({ label: fmtShortDate(d.date), value: d.netSales }))} format={tl} seriesLabel="Ciro" ariaLabel="Günlük ciro" />
                  ) : hourly.isPending ? (
                    <Skeleton className="h-[220px] rounded-xl" />
                  ) : hourly.data ? (
                    <ColumnChart data={hourColumns(hourly.data.hours)} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro" emptyLabel={range.from === today ? 'Bugün henüz satış yok' : 'Bu günde satış yok'} />
                  ) : (
                    <ErrorState compact title="Saatlik ciro alınamadı" error={hourly.error} onRetry={() => void hourly.refetch()} retrying={hourly.isFetching} />
                  )}
                </div>
              </Card>
              <Card flush title="Ödeme türleri">
                <div className="p-4">
                  {s.payments.length ? (
                    <BarList items={s.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.count} işlem` }))} format={tl} />
                  ) : (
                    <EmptyState compact icon={<CreditCard />} title="Bu dönemde ödeme yok">
                      Adisyonlar kapandıkça ödeme türleri burada toplanır
                    </EmptyState>
                  )}
                  {s.tips > 0 && <p className="mt-3 text-xs text-muted">Bahşiş {tl(s.tips)} (ciro dışı)</p>}
                </div>
              </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card flush title="Ciro dökümü" subtitle="Kapanmış adisyonlar; iptaller düşülmez, bilgi olarak">
                <dl className="divide-y divide-[var(--admin-divider)] text-sm">
                  {[
                    ['Liste değeri', s.waterfall.list, false],
                    [s.odenmez || s.zayi ? 'Ciro dışı (ikram, ödenmez, zayi)' : 'İkram', -s.waterfall.complimentary, false],
                    ['İndirim', -s.waterfall.discounts, false],
                    ...(s.waterfall.service ? [['Servis ücreti', s.waterfall.service, false] as const] : []),
                    ['Ciro (KDV dahil)', s.waterfall.revenue, true],
                    ['KDV', -s.waterfall.kdv, false],
                    ['Net satış (KDV hariç)', s.waterfall.netExKdv, true],
                  ].map(([label, value, strong]) => (
                    <div key={String(label)} className={cn('flex justify-between px-4 py-2.5', strong === true && 'font-semibold')}>
                      <dt>{label}</dt>
                      <dd className="tabular">{(value as number) < 0 ? `−${tl(-(value as number))}` : tl(value as number)}</dd>
                    </div>
                  ))}
                  <div className="flex justify-between px-4 py-2.5 text-muted">
                    <dt>İptal edilen (bilgi, açık adisyonlar dahil)</dt>
                    <dd className="tabular">{tl(s.voided)}</dd>
                  </div>
                </dl>
              </Card>
              <Card flush title="KDV oranlarına göre" subtitle="Matrah + KDV = ciro">
                {s.kdv.length === 0 ? (
                  <EmptyState compact title="Bu dönemde satış yok" />
                ) : (
                  <dl className="divide-y divide-[var(--admin-divider)] text-sm">
                    {s.kdv.map((k) => (
                      <div key={k.rate} className="grid grid-cols-[4rem_1fr_1fr_1fr] gap-2 px-4 py-2.5">
                        <dt className="font-medium">%{k.rate}</dt>
                        <dd className="tabular text-right text-muted">{tl(k.base)}</dd>
                        <dd className="tabular text-right text-muted">{tl(k.kdv)}</dd>
                        <dd className="tabular text-right font-medium">{tl(k.gross)}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                <div className={cn('mx-4 mb-4 mt-2 rounded-lg px-3 py-2 text-xs', s.reconciliation.difference === 0 ? 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]' : 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]')}>
                  {s.reconciliation.difference === 0
                    ? `Mutabık: kapanmış adisyonların ödemeleri ciroya eşit (${tl(s.reconciliation.paidClosed)})`
                    : `Fark var: ödemeler ${tl(s.reconciliation.paidClosed)}, ciro ${tl(s.waterfall.revenue)}; fark ${tl(s.reconciliation.difference)}`}
                  {s.reconciliation.paidOpen > 0 && ` · açık adisyonlardan alınan ${tl(s.reconciliation.paidOpen)} ayrı`}
                </div>
              </Card>
            </div>
            <p className="text-xs text-muted">{fmtDateTime(s.asOf)} itibarıyla · ciro kapanmış adisyonlardan, adisyonun açıldığı iş gününe göre</p>
            <Card flush title="Satış türleri">
              <div className="p-4">
                {s.types.length ? (
                  <BarList items={s.types.map((t) => ({ key: t.type, label: TYPE_LABEL[t.type] ?? t.type, value: t.amount, sub: `${t.orders} adisyon` }))} format={tl} />
                ) : (
                  <EmptyState compact title="Bu dönemde satış yok" />
                )}
              </div>
            </Card>
          </div>
        );
      }}
    </ReportBody>
  );
}

interface ProductsData {
  total: number;
  /** Ürüne ait olmayan servis ücreti; ürün cirosu + servis = toplam ciro */
  service: number;
  products: { key: string; name: string; size: string; category: string; qty: number; revenue: number; share: number; avgPrice: number; complimentary: number; voided: number; cost: number | null; margin: number | null }[];
  categories: { name: string; qty: number; revenue: number; share: number }[];
  /** Maliyetlerin son çekimi; yalnız maliyet yetkisine gelir */
  costsAt?: number | null;
}

function ProductsReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const can = useCan();
  const [q, setQ] = useState('');
  const data = useReport<ProductsData>(['products', range], `/reports/products?${qs(range)}`);
  const rows = useMemo(() => (data.data?.products ?? []).filter((p) => p.name.toLocaleLowerCase('tr-TR').includes(q.trim().toLocaleLowerCase('tr-TR'))), [data.data, q]);
  const withCost = can('rapor.maliyet');
  return (
    <ReportBody q={data} skeleton={<TableSkeleton />}>
      {(d) => {
        const max = Math.max(1, ...rows.map((r) => r.revenue));
        return (
          <Card
            flush
            title={`Ürün satışları · ${tl(d.total)}${d.service ? ` · servis ücreti ${tl(d.service)} ayrı` : ''}`}
            actions={
              <div className="flex items-center gap-2">
                {/* Ortak arama alanı: dokunmatikte 44 px, fareyle 36; temizle düğmesi ve Escape */}
                <SearchInput dense value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ara" wrapperClassName="w-40 sm:w-48" />
                {d.products.length > 0 && (
                  <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
                    CSV
                  </Button>
                )}
              </div>
            }
          >
            {rows.length === 0 ? (
              q.trim() && d.products.length ? (
                <EmptyState
                  compact
                  icon={<SearchX />}
                  title={`“${q.trim()}” ile eşleşen ürün yok`}
                  action={
                    <Button size="sm" onClick={() => setQ('')}>
                      Aramayı temizle
                    </Button>
                  }
                />
              ) : (
                <EmptyState compact icon={<Package />} title="Bu dönemde satış yok">
                  Başka bir dönem seçin; açık adisyonlar kapanınca sayılır
                </EmptyState>
              )
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-left text-xs text-muted">
                    <tr className="border-b border-line">
                      <th className="px-4 py-2">#</th>
                      <th className="px-2 py-2">Ürün</th>
                      <th className="px-2 py-2">Kategori</th>
                      <th className="px-2 py-2 text-right">Adet</th>
                      <th className="w-[28%] px-2 py-2">Ciro</th>
                      <th className="px-2 py-2 text-right">Pay</th>
                      <th className="px-2 py-2 text-right">Ort. fiyat</th>
                      {withCost && <th className="px-4 py-2 text-right">Brüt kâr</th>}
                    </tr>
                  </thead>
                  <tbody className="tabular">
                    {rows.map((p, i) => (
                      <tr key={p.key} className="border-b border-line/60 last:border-0">
                        <td className="px-4 py-2 text-muted">{i + 1}</td>
                        <td className="px-2 py-2 font-medium">
                          {p.name} {p.size !== 'TEK' && <span className="text-xs text-muted">{p.size}</span>}
                          {(p.complimentary > 0 || p.voided > 0) && <span className="block text-xs font-normal text-muted">{joinMeta([p.complimentary > 0 && `${p.complimentary} ikram`, p.voided > 0 && `${p.voided} iptal`])}</span>}
                        </td>
                        <td className="px-2 py-2 text-muted">{p.category}</td>
                        <td className="px-2 py-2 text-right">{p.qty}</td>
                        <td className="px-2 py-2">
                          <div className="flex items-center gap-2">
                            <div className="h-2 flex-1 rounded-full" style={{ background: 'var(--chart-track)' }}>
                              <div className="h-2 rounded-full" style={{ width: `${(p.revenue / max) * 100}%`, background: 'var(--chart-accent)' }} />
                            </div>
                            <span className="w-24 text-right font-semibold">{tl(p.revenue)}</span>
                          </div>
                        </td>
                        <td className="px-2 py-2 text-right text-muted">%{p.share.toLocaleString('tr-TR')}</td>
                        <td className="px-2 py-2 text-right">{tl(p.avgPrice)}</td>
                        {withCost && <td className="px-4 py-2 text-right">{p.margin == null ? <span className="text-muted">maliyet yok</span> : tl(p.margin)}</td>}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {withCost && (
              <p className="px-4 pb-3 text-xs text-muted">
                Brüt kâr: KDV hariç ciro − lafmaliyet reçete maliyeti. Maliyetler gün sonunda günde bir kendiliğinden, Yönetim › Site ve lafmaliyet’ten elle çekilir
                {staleCostsText(d.costsAt) && <span className="block font-medium text-[var(--admin-warning)]">{staleCostsText(d.costsAt)}</span>}
              </p>
            )}
          </Card>
        );
      }}
    </ReportBody>
  );
}

function CategoryReport({ range }: { range: Range }) {
  const data = useReport<ProductsData>(['products', range], `/reports/products?${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={<CardSkeleton />}>
      {(d) => (
        <Card flush title="Kategori payları">
          <div className="p-4">
            {d.categories.length ? (
              <BarList items={d.categories.map((c) => ({ key: c.name, label: c.name, value: c.revenue, sub: `%${c.share.toLocaleString('tr-TR')} · ${c.qty} adet` }))} format={tl} />
            ) : (
              <EmptyState compact icon={<Package />} title="Bu dönemde satış yok">
                Başka bir dönem seçin; açık adisyonlar kapanınca sayılır
              </EmptyState>
            )}
          </div>
        </Card>
      )}
    </ReportBody>
  );
}

/**
 * Saat satırı: iş günü sırasıyla (05:00 ilk). Tek günde gün 24 saati aştıysa ertesi günün saatleri sonda (`nextDay`);
 * adisyon, Adisyon kutusuyla aynı ölçütle (₺0 adisyon sayılmaz)
 */
interface HourRow {
  hour: number;
  /** İş gününün 05:00'inden geçen saat */
  offset: number;
  nextDay: boolean;
  revenue: number;
  orders: number;
}

/** Saatlik grafik: sunucunun sırasıyla, ertesi günün saati ipucunda belirtilir */
const hourColumns = (rows: HourRow[]) => rows.map((h) => ({ label: String(h.hour).padStart(2, '0'), title: hourTitle(h.hour, h.nextDay), value: h.revenue }));

interface HourlyData {
  total: number;
  days: number;
  hours: HourRow[];
  parts: { key: string; label: string; revenue: number; orders: number; share: number }[];
  busiest: HourRow | null;
  quietest: HourRow | null;
  peaks: HourRow[];
  /** Haftanın günü (1 pazartesi) × saat, o günün ortalama cirosu */
  week: { weekday: number; days: number; hours: number[] }[];
}

/** Stat ızgarası ve grafik kartı biçiminde iskelet (Saatlik, Hazırlama) */
const STATS_SKELETON = (
  <div role="status" aria-label="Yükleniyor…" className="space-y-4">
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-[104px] rounded-2xl" />
      ))}
    </div>
    <Skeleton className="h-[290px] rounded-2xl" />
  </div>
);

function HourlyReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const data = useReport<HourlyData>(['hourly', range], `/reports/hourly?${qs(range)}`);
  const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return (
    <ReportBody q={data} skeleton={STATS_SKELETON}>
      {(h) => (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Toplam" value={tl(h.total)} hint={`${h.hours.filter((x) => x.orders).length} aktif saat`} />
        <Stat label="En yoğun saat" value={h.busiest ? hh(h.busiest.hour) : '—'} hint={h.busiest ? `${h.busiest.nextDay ? 'Ertesi gün · ' : ''}${tl(h.busiest.revenue)} · ${h.busiest.orders} adisyon` : undefined} />
        <Stat label="En sakin saat" value={h.quietest ? hh(h.quietest.hour) : '—'} hint={h.quietest ? `${h.quietest.nextDay ? 'Ertesi gün · ' : ''}${tl(h.quietest.revenue)} · ${h.quietest.orders} adisyon` : undefined} />
        <Stat label="Gün sayısı" value={String(h.days)} />
      </div>
      <Card
        flush
        title={h.hours.length > 24 ? 'Saat dağılımı · gün 24 saati aştı, ertesi günün saatleri sonda' : '24 saat dağılımı · adisyonun açıldığı saate göre'}
        actions={
          <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
            CSV
          </Button>
        }
      >
        <div className="p-4">
          <ColumnChart data={hourColumns(h.hours)} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro dağılımı" emptyHint="Başka bir dönem seçin; açık adisyonlar kapanınca sayılır" />
        </div>
      </Card>
      {h.days >= 7 && <WeekHeatmap week={h.week} />}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card flush title="Gün dilimleri">
          <div className="p-4">
            <BarList items={h.parts.map((p) => ({ key: p.key, label: p.label, value: p.revenue, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.orders} adisyon` }))} format={tl} />
            <p className="mt-3 text-xs text-muted">Sabah 06-12 · Öğle 12-17 · Akşam 17-22 · Gece 22-06</p>
          </div>
        </Card>
        <Card flush title="Pik saatler">
          {h.peaks.length === 0 ? (
            <EmptyState compact title="Bu dönemde satış yok" />
          ) : (
          <ol className="divide-y divide-line">
            {h.peaks.map((p, i) => (
              <li key={p.offset} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="grid size-7 place-items-center rounded-full bg-surface-3 text-xs font-semibold">{i + 1}</span>
                <span className="tabular flex-1 font-medium">
                  {hh(p.hour)} – {String(p.hour).padStart(2, '0')}:59
                  {p.nextDay && <span className="ml-1.5 text-xs font-normal text-muted">ertesi gün</span>}
                </span>
                <span className="text-muted">{p.orders} adisyon</span>
                <span className="tabular w-24 text-right font-semibold">{tl(p.revenue)}</span>
              </li>
            ))}
          </ol>
          )}
        </Card>
      </div>
    </div>
      )}
    </ReportBody>
  );
}

const WEEKDAY_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const WEEKDAY_LONG = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
/** Tek renk, açıktan koyuya 5 basamak (sıfır boş kalır); koyu temada da aynı token'dan */
const HEAT_STEPS = [16, 32, 50, 70, 92];

/** Haftanın günü × saat ısı haritası: personel planı için hangi gün hangi saat yoğun (sütunlar iş günü sırasıyla) */
function WeekHeatmap({ week }: { week: HourlyData['week'] }) {
  const all = week.flatMap((w) => w.hours);
  const max = Math.max(0, ...all);
  if (max === 0) return null;
  const used = all.map((v, i) => (v > 0 ? businessHourIndex(i % 24) : -1)).filter((x) => x >= 0);
  const cols = BUSINESS_HOURS.slice(Math.min(...used), Math.max(...used) + 1);
  const step = (v: number) => (v <= 0 ? -1 : Math.min(HEAT_STEPS.length - 1, Math.floor((v / max) * HEAT_STEPS.length)));
  return (
    <Card flush title="Haftanın günü × saat · günlük ortalama ciro">
      <div className="overflow-x-auto p-4">
        <table className="w-full border-separate border-spacing-[3px] text-[11px]" aria-label="Haftanın günlerine ve saatlere göre ortalama ciro">
          <thead>
            <tr>
              <th className="w-10" />
              {cols.map((c) => (
                <th key={c} scope="col" className="tabular font-medium text-muted">
                  {String(c).padStart(2, '0')}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {week.map((w, wi) => (
              <tr key={w.weekday}>
                <th scope="row" className="pr-1 text-left font-medium text-muted">
                  {WEEKDAY_SHORT[wi]}
                </th>
                {cols.map((c) => {
                  const v = w.hours[c] ?? 0;
                  const k = step(v);
                  const label = `${WEEKDAY_LONG[wi]} ${String(c).padStart(2, '0')}:00 · ${v > 0 ? tl(v) : 'satış yok'}${w.days > 1 ? ` (${w.days} günün ortalaması)` : ''}`;
                  return (
                    <td
                      key={c}
                      title={label}
                      className="h-7 min-w-7 rounded-[4px]"
                      style={{ background: k < 0 ? 'var(--admin-surface-2)' : `color-mix(in oklab, var(--admin-primary) ${HEAT_STEPS[k]}%, var(--admin-surface))` }}
                    >
                      <span className="sr-only">{label}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-3 flex items-center gap-1.5 text-xs text-muted" aria-hidden>
          <span>Az</span>
          {HEAT_STEPS.map((p) => (
            <span key={p} className="size-3.5 rounded-[3px]" style={{ background: `color-mix(in oklab, var(--admin-primary) ${p}%, var(--admin-surface))` }} />
          ))}
          <span>Çok · en yüksek {tl(max)}</span>
        </div>
      </div>
    </Card>
  );
}

interface PrepStats {
  count: number;
  avg: number;
  median: number;
  p90: number;
  max: number;
}
interface PrepData {
  overall: PrepStats;
  /** Hazırdan teslime (Teslim edildi); eski sunucu göndermez */
  handoff?: PrepStats;
  products: (PrepStats & { name: string; size: string })[];
  hours: (PrepStats & { hour: number })[];
  slowest: { orderNo: number; name: string; size: string; sentAt: number; sec: number }[];
}

/** Saniye → "3 dk 20 sn" */
function dur(sec: number): string {
  if (sec < 60) return `${sec} sn`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : s ? `${m} dk ${s} sn` : `${m} dk`;
}

/** Bar ve mutfakta hazırlama süresi: gönderilmesinden "Hazır"a. Ortalama ve en yavaş %10 (p90) */
function PrepReport({ range }: { range: Range }) {
  const data = useReport<PrepData>(['prep', range], `/reports/prep?${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={STATS_SKELETON}>
      {(p) =>
        !p.overall.count ? (
          <EmptyState className={CARD} icon={<Timer />} title="Bu dönemde hazırlanan kalem yok">
            Bar ve mutfak ekranında “Hazır”a basılan kalemler burada sayılır
          </EmptyState>
        ) : (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Ortalama" value={dur(p.overall.avg)} hint={`${p.overall.count} kalem`} />
        <Stat label="Ortanca" value={dur(p.overall.median)} hint="Kalemlerin yarısı bundan kısa" />
        <Stat label="En yavaş %10" value={dur(p.overall.p90)} hint="Bu süreyi aşan her 10 kalemden biri" />
        <Stat label="En uzun" value={dur(p.overall.max)} />
        {/* Müşterinin hazır siparişi ne kadar sürede aldığı: bar ekranında ya da kasada "Teslim edildi" */}
        <Stat
          className="max-lg:col-span-2"
          label="Hazırdan teslime"
          value={p.handoff?.count ? dur(p.handoff.median) : '—'}
          hint={p.handoff?.count ? `Ortanca · ${p.handoff.count} teslim` : 'Sayılmadı · bu dönemde teslim işaretlenmedi'}
        />
      </div>
      <Card flush title="Saate göre ortalama süre">
        <div className="p-4">
          <ColumnChart data={byBusinessHour(p.hours).map((x) => ({ label: String(x.hour).padStart(2, '0'), value: x.avg }))} format={dur} seriesLabel="Ortalama süre" ariaLabel="Saate göre ortalama hazırlama süresi" emptyLabel="Bu dönemde hazırlanan kalem yok" />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card flush title="Ürünler (en yavaş önce)">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">Ürün</th>
                  <th className="px-2 py-2 text-right font-medium">Adet</th>
                  <th className="px-2 py-2 text-right font-medium">Ortalama</th>
                  <th className="px-4 py-2 text-right font-medium">En yavaş %10</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {p.products.map((r) => (
                  <tr key={`${r.name}|${r.size}`}>
                    <td className="px-4 py-2 font-medium">
                      {r.name}
                      {r.size !== 'TEK' && <span className="ml-1.5 rounded-md bg-surface-3 px-1.5 text-xs font-semibold">{r.size}</span>}
                    </td>
                    <td className="tabular px-2 py-2 text-right text-muted">{r.count}</td>
                    <td className="tabular px-2 py-2 text-right">{dur(r.avg)}</td>
                    <td className="tabular px-4 py-2 text-right font-semibold">{dur(r.p90)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
        <Card flush title="En uzun bekleyen 10 kalem">
          <ol className="divide-y divide-line">
            {p.slowest.map((s, i) => (
              <li key={`${s.orderNo}-${s.sentAt}-${i}`} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="tabular w-12 text-muted">#{s.orderNo}</span>
                <span className="min-w-0 flex-1 truncate font-medium">
                  {s.name} {s.size !== 'TEK' && <span className="text-muted">{s.size}</span>}
                </span>
                <span className="tabular text-muted">{fmtTime(s.sentAt)}</span>
                <span className="tabular w-24 text-right font-semibold">{dur(s.sec)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
        )
      }
    </ReportBody>
  );
}

interface ChecksData {
  /** Dönemin bütün adisyonları; `rows` en yenileriyle sınırlı */
  count: number;
  rows: { id: string; no: number; status: string; type: string; place: string | null; openedAt: number; closedAt: number | null; waiter: string | null; qty: number; total: number; methods: string[] }[];
}

function ChecksReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const can = useCan();
  const data = useReport<ChecksData>(['checks', range], `/reports/checks?${qs(range)}`);
  // Garsona göre adisyon listesi personel tutarıdır: maliyet yetkisi olmayana sunucu garsonu göndermez
  const withWaiter = can('rapor.maliyet');
  return (
    <ReportBody q={data} skeleton={<TableSkeleton />}>
      {({ rows, count }) => (
    <Card
      flush
      title={count ? `Adisyonlar (${count.toLocaleString('tr-TR')})` : 'Adisyonlar'}
      subtitle={rows.length < count ? `En yeni ${rows.length.toLocaleString('tr-TR')} adisyon gösteriliyor; hepsi CSV’de` : undefined}
      actions={
        count > 0 ? (
          <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
            CSV
          </Button>
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <EmptyState compact icon={<Receipt />} title="Bu dönemde adisyon yok">
          Başka bir dönem seçin; açık adisyonlar kapanınca sayılır
        </EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2">No</th>
                <th className="px-2 py-2">Yer</th>
                <th className="px-2 py-2">Saat</th>
                {withWaiter && <th className="px-2 py-2">Garson</th>}
                <th className="px-2 py-2 text-right">Adet</th>
                <th className="px-2 py-2">Ödeme</th>
                <th className="px-4 py-2 text-right">Tutar</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">
                    #{o.no} {o.status === 'iptal' && <span className="ml-1 rounded bg-[var(--admin-danger-soft)] px-1.5 text-xs text-[var(--admin-danger-ink)]">iptal</span>}
                  </td>
                  <td className="px-2 py-2">{o.place ?? TYPE_LABEL[o.type] ?? o.type}</td>
                  <td className="px-2 py-2 text-muted">
                    {fmtTime(o.openedAt)}
                    {o.closedAt && ` – ${fmtTime(o.closedAt)}`}
                  </td>
                  {withWaiter && <td className="px-2 py-2">{o.waiter ?? '—'}</td>}
                  <td className="px-2 py-2 text-right">{o.qty}</td>
                  <td className="px-2 py-2 text-muted">{o.methods.join(', ') || '—'}</td>
                  <td className="px-4 py-2 text-right font-semibold">{tl(o.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
      )}
    </ReportBody>
  );
}

interface PlatformRow {
  platform: PlatformId;
  label: string;
  /** Tutarı olan kapanmış adisyon */
  orders: number;
  /** Ciro, KDV dahil */
  revenue: number;
  avgBasket: number;
  /** Toplam cirodaki payı */
  share: number;
  discounts: number;
  platformDiscount: number;
  collectedByPlatform: number;
  collectedAtCounter: number;
  open: { orders: number; amount: number };
  /** `unrecorded`: platformda (tablette) kabul edilmiş, 3 saat içinde kasaya alınmamış */
  missed: { orders: number; amount: number; rejected: number; expired: number; cancelled: number; unrecorded: number };
  /** Yalnız maliyet yetkisine gelir: bugünkü oran ve onunla tahmin */
  commissionPct?: number;
  commission?: number;
}
interface PlatformsData {
  netSales: number;
  revenue: number;
  orders: number;
  avgBasket: number;
  share: number;
  open: { orders: number; amount: number };
  missed: { orders: number; amount: number };
  pending: number;
  commission?: number;
  platforms: PlatformRow[];
}

/** Kaçan siparişin nedenleri: "2 ret · 1 süre doldu · 1 iptal", sıfır olan düşer */
const missedParts = (m: PlatformRow['missed']) =>
  joinMeta([m.rejected > 0 && `${m.rejected} ret`, m.expired > 0 && `${m.expired} süre doldu`, m.cancelled > 0 && `${m.cancelled} iptal`, m.unrecorded > 0 && `${m.unrecorded} kasaya alınmadı`]);

/** Platform satırının bir rakamı: küçük etiket, rakam, altında ipucu */
function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string | null }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular font-medium">
        {value}
        {hint && <span className="block text-xs font-normal text-muted">{hint}</span>}
      </dd>
    </div>
  );
}

/**
 * Paket platformları: platform başına ciro (Ciro raporunun kuralıyla), kampanyalar, tahsilatın yeri, açık ve kaçan
 * siparişler. Tahmini komisyon yalnız maliyet yetkisine gelir (sunucu göndermez), bugünkü oranla
 */
function PlatformsReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const can = useCan();
  const withCost = can('rapor.maliyet');
  const data = useReport<PlatformsData>(['platforms', range], `/reports/platforms?${qs(range)}`);
  const skeleton = (
    <div className="space-y-4">
      <KpiStripSkeleton count={withCost ? 5 : 4} />
      <CardSkeleton rows={3} />
    </div>
  );
  return (
    <ReportBody q={data} skeleton={skeleton}>
      {(d) => {
        if (!d.platforms.length)
          return (
            <EmptyState className={CARD} icon={<Bike />} title="Bu dönemde platform siparişi yok">
              {d.pending > 0 ? `${d.pending} sipariş onay bekliyor; kabul edilip kapanınca burada sayılır` : 'Yemeksepeti, Getir Yemek ve Trendyol Go siparişleri kapandıkça burada toplanır'}
            </EmptyState>
          );
        const max = Math.max(1, ...d.platforms.map((p) => p.revenue));
        const showCost = withCost && d.commission != null;
        return (
          <div className="space-y-4">
            <KpiStrip
              cells={[
                { key: 'ciro', label: 'Platform cirosu', icon: <Bike />, hue: 'blue', value: tl(d.revenue), reference: `Toplam ciroda pay %${d.share.toLocaleString('tr-TR')}` },
                { key: 'siparis', label: 'Sipariş', icon: <Receipt />, hue: 'violet', value: d.orders.toLocaleString('tr-TR'), reference: d.orders ? `Ortalama sepet ${tlShort(d.avgBasket)}` : 'Kapanan sipariş yok' },
                ...(showCost ? [{ key: 'komisyon', label: 'Komisyon', icon: <BadgePercent />, hue: 'amber' as const, value: tl(d.commission!), reference: 'Bugünkü oranla tahmin' }] : []),
                { key: 'acik', label: 'Açık sipariş', icon: <Clock />, hue: 'green', value: d.open.orders.toLocaleString('tr-TR'), reference: d.open.orders ? `${tlShort(d.open.amount)} · ciroya girmedi` : 'Hepsi kapandı' },
                { key: 'kacan', label: 'Kaçan sipariş', icon: <XCircle />, hue: 'rose', value: d.missed.orders.toLocaleString('tr-TR'), reference: d.missed.orders ? `Müşteri tutarı ${tlShort(d.missed.amount)}` : 'Ret, süre ya da iptal yok' },
              ]}
            />
            <Card
              flush
              title="Platformlara göre"
              subtitle="Kapanmış siparişler, KDV dahil"
              actions={
                <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
                  CSV
                </Button>
              }
            >
              <ul className="divide-y divide-[var(--admin-divider)]">
                {d.platforms.map((p) => (
                  <li key={p.platform} className="px-4 py-3.5 sm:px-5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <PlatformBadge platform={p.platform} />
                      <span className="tabular text-sm text-muted">
                        <span className="text-base font-semibold text-ink">{tl(p.revenue)}</span> · ciroda %{p.share.toLocaleString('tr-TR')}
                      </span>
                    </div>
                    <div aria-hidden="true" className="mt-2 h-2 rounded-full" style={{ background: 'var(--chart-track)' }}>
                      <div className="h-2 rounded-full" style={{ width: `${p.revenue > 0 ? Math.max(1, (p.revenue / max) * 100) : 0}%`, background: 'var(--chart-accent)' }} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-3 xl:grid-cols-4">
                      <Metric label="Sipariş" value={p.orders.toLocaleString('tr-TR')} hint={p.orders ? `ortalama ${tlShort(p.avgBasket)}` : null} />
                      <Metric label="Restoranın indirimi" value={tl(p.discounts)} />
                      <Metric label="Platformun kampanyası" value={tl(p.platformDiscount)} hint="Ciroyu düşürmez" />
                      <Metric label="Platformda tahsil" value={tl(p.collectedByPlatform)} />
                      <Metric label="Kasada tahsil" value={tl(p.collectedAtCounter)} hint="Kapıda alınan" />
                      {showCost && <Metric label="Tahmini komisyon" value={p.commissionPct ? tl(p.commission ?? 0) : '—'} hint={p.commissionPct ? `%${p.commissionPct.toLocaleString('tr-TR')}, bugünkü oranla` : 'Oran girilmedi'} />}
                      {p.open.orders > 0 && <Metric label="Açık" value={`${p.open.orders} · ${tl(p.open.amount)}`} hint="Ciroya girmedi" />}
                      <Metric label="Kaçan" value={p.missed.orders ? `${p.missed.orders} · ${tl(p.missed.amount)}` : '0'} hint={p.missed.orders ? missedParts(p.missed) : null} />
                    </dl>
                  </li>
                ))}
              </ul>
            </Card>
            <p className="text-xs text-muted">
              Rakamlar Ciro sekmesiyle aynı kuralla: kapanmış adisyonlar, adisyonun açıldığı iş gününe göre. Tahsilatı platform da yapsa kasa da yapsa sipariş platformun satışıdır. Kaçan sipariş reddedilen, süresi dolan ya da iptal
              edilen siparişlerdir: geldiği iş gününe yazılır, tutarı müşterinin ödeyeceğidir, ciroya girmez.
              {d.pending > 0 && ` Şu an ${d.pending} sipariş onay bekliyor; hiçbir rakama girmedi.`}
              {showCost && ' Komisyon tahminidir: Yönetim › Paket platformları’ndaki bugünkü oranla KDV dahil cirodan hesaplanır, oran değişirse geçmiş dönemin tahmini de değişir. Gerçek tutar platformun hesap kesimindedir.'}
            </p>
          </div>
        );
      }}
    </ReportBody>
  );
}

interface ItemsData {
  total: number;
  count: number;
  rows: { id: string; at: number; orderNo: number; place: string; name: string; size: string; qty: number; value: number; reason: string | null; compKind: CompKind | null; by: string | null; approvedBy: string | null; afterSend: boolean; billPrinted: boolean }[];
}

const ITEM_TITLES = { iptal: 'İptal edilen kalemler', ikram: 'İkram, ödenmez ve zayi kalemleri', indirim: 'İndirimler', happy: 'Happy hour satışları' };
/** Boş dönemde türü söyleyen tek cümle (başlıkta "0 kayıt · ₺0,00" tekrarlanmaz) */
const ITEM_EMPTY = { iptal: 'Bu dönemde iptal edilen kalem yok', ikram: 'Bu dönemde ikram, ödenmez ya da zayi yok', indirim: 'Bu dönemde indirim yok', happy: 'Bu dönemde happy hour satışı yok' };

function ItemsReport({ range, kind, onExport }: { range: Range; kind: 'iptal' | 'ikram' | 'indirim' | 'happy'; onExport?: () => void }) {
  const data = useReport<ItemsData>(['items', kind, range], `/reports/items?kind=${kind}&${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={<TableSkeleton rows={6} />}>
      {(d) => (
    <Card
      flush
      title={d.count ? `${ITEM_TITLES[kind]} · ${d.count} kayıt · ${tl(d.total)}` : ITEM_TITLES[kind]}
      actions={
        onExport && d.count > 0 ? (
          <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
            CSV
          </Button>
        ) : undefined
      }
    >
      {d.rows.length === 0 ? (
        <EmptyState compact icon={kind === 'happy' ? <BadgePercent /> : <Receipt />} title={ITEM_EMPTY[kind]} />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2">Zaman</th>
                <th className="px-2 py-2">Adisyon</th>
                <th className="px-2 py-2">Ürün</th>
                <th className="px-2 py-2">Neden</th>
                <th className="px-2 py-2">Yapan</th>
                <th className="px-4 py-2 text-right">{kind === 'happy' ? 'İndirim' : 'Tutar'}</th>
              </tr>
            </thead>
            <tbody>
              {d.rows.map((r) => (
                <tr key={r.id} className="border-b border-line/60 last:border-0">
                  <td className="tabular px-4 py-2 text-muted">{fmtDateTime(r.at)}</td>
                  <td className="px-2 py-2">
                    #{r.orderNo} <span className="text-muted">{r.place}</span>
                  </td>
                  <td className="px-2 py-2 font-medium">
                    {r.qty}× {r.name}
                    {r.compKind && r.compKind !== 'ikram' && <span className="ml-1.5 rounded bg-[var(--admin-warning-soft)] px-1.5 text-xs text-[var(--admin-warning)]">{COMP_LABEL[r.compKind].toLocaleLowerCase('tr-TR')}</span>}
                    {kind === 'iptal' && (r.afterSend || r.billPrinted) && (
                      <span className="ml-1.5 rounded bg-[var(--admin-danger-soft)] px-1.5 text-xs text-[var(--admin-danger-ink)]">{r.billPrinted ? 'hesap sonrası' : 'hazırlandıktan sonra'}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 text-ink-2">{r.reason ?? '—'}</td>
                  <td className="px-2 py-2">
                    {r.by ?? '—'}
                    {r.approvedBy && <span className="block text-xs text-muted">onay: {r.approvedBy}</span>}
                  </td>
                  <td className="tabular px-4 py-2 text-right font-semibold">{tl(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
      )}
    </ReportBody>
  );
}

function RefundsReport({ range }: { range: Range }) {
  const data = useReport<{ total: number; count: number; rows: { id: string; at: number; orderNo: number | null; method: string; amount: number; reason: string | null; by: string | null }[] }>(['refunds', range], `/reports/refunds?${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={<CardSkeleton rows={4} />}>
      {(d) => (
        <Card flush title={d.count ? `Ödeme iptalleri · ${d.count} · ${tl(d.total)}` : 'Ödeme iptalleri'}>
          {d.rows.length === 0 ? (
            <EmptyState compact icon={<CreditCard />} title="Bu dönemde ödeme iptali yok" />
          ) : (
            <ul className="divide-y divide-line">
              {d.rows.map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="tabular w-36 shrink-0 text-muted">{fmtDateTime(r.at)}</span>
                  <span className="min-w-0 flex-1">
                    {joinMeta([r.orderNo != null && `#${r.orderNo}`, r.method, r.reason])}
                    {r.by && <span className="text-muted"> ({r.by})</span>}
                  </span>
                  <span className="tabular font-semibold">{tl(r.amount)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </ReportBody>
  );
}

function StaffReport({ range }: { range: Range }) {
  const data = useReport<{ staff: { userId: string; name: string; orders: number; revenue: number; voids: number; voidValue: number; comps: number; compValue: number; discounts: number }[] }>(['staff', range], `/reports/staff?${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={<TableSkeleton rows={5} />}>
      {({ staff: rows }) => (
    <Card flush title="Personel">
      {rows.length === 0 ? (
        <EmptyState compact icon={<Users />} title="Bu dönemde personel satışı yok">
          Başka bir dönem seçin; açık adisyonlar kapanınca sayılır
        </EmptyState>
      ) : (
      <div className="overflow-x-auto">
        <table className="tabular w-full text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2">Personel</th>
              <th className="px-2 py-2 text-right">Adisyon</th>
              <th className="px-2 py-2 text-right">Ciro</th>
              <th className="px-2 py-2 text-right">Ortalama</th>
              <th className="px-2 py-2 text-right">İndirim</th>
              <th className="px-2 py-2 text-right">İptal</th>
              <th className="px-4 py-2 text-right">İkram</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.userId} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-2 py-2 text-right">{r.orders}</td>
                <td className="px-2 py-2 text-right font-semibold">{tl(r.revenue)}</td>
                <td className="px-2 py-2 text-right">{r.orders ? tl(Math.round(r.revenue / r.orders)) : '—'}</td>
                <td className="px-2 py-2 text-right">{tl(r.discounts)}</td>
                <td className="px-2 py-2 text-right">
                  {r.voids} · {tl(r.voidValue)}
                </td>
                <td className="px-4 py-2 text-right">
                  {r.comps} · {tl(r.compValue)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}
    </Card>
      )}
    </ReportBody>
  );
}

/**
 * Elle yedek: lafmaliyet Satışlar ekranına yüklenen liste. Bağlantı kuruluyken günler gün sonunda gider; liste
 * yalnız bağlantı yokken ya da lafmaliyet'teki geçiş gününden önceki aylar için (yoksa aynı satış iki kez sayılır)
 */
function ExportReport({ range, linked, onDownload }: { range: Range; linked: boolean; onDownload: () => void }) {
  return (
    <div className="space-y-4">
      <Card flush title="lafmaliyet aktarımı">
        <div className="space-y-3 p-5 text-sm">
          <p>
            Seçili dönemin ürün satış listesi lafmaliyet’in <b>Satışlar</b> ekranının okuduğu biçimde iner (Ürün; Adet; Tutar, KDV dahil). İkram, iptal ve sitede ödenmiş online siparişler listeye girmez; ekstra shot, şurup ve alternatif süt ayrı satır olarak çıkar.
          </p>
          {linked && (
            <Notice tone="warn">
              lafmaliyet bağlantısı kurulu: günler gün sonunda kendiliğinden gidiyor. Bu liste yalnız bağlantı yokken ya da lafmaliyet’teki geçiş gününden önceki aylar için; geçiş gününden sonraki günleri Satışlar’a yüklemeyin, aynı satış iki kez sayılır
            </Notice>
          )}
          <Button variant="primary" icon={<FileSpreadsheet className="size-4" />} onClick={onDownload}>
            Satış listesini indir ({rangeLabel(range)})
          </Button>
          {!linked && <p className="text-xs text-muted">lafmaliyet bağlantısı kurulunca günlük Z ve satış verisi gün sonunda kendiliğinden gider</p>}
        </div>
      </Card>
      {!linked && (
        <SetupNotes>
          <p>
            Bağlantının açılış adımları <code className={CODE}>docs/03-ENTEGRASYON.md</code> belgesinde.
          </p>
        </SetupNotes>
      )}
    </div>
  );
}
