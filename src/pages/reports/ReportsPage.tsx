import { keepPreviousData, type UseQueryResult, useIsFetching, useQuery } from '@tanstack/react-query';
import {
  BadgePercent,
  Bike,
  CalendarDays,
  Clock,
  CreditCard,
  Download,
  FileSpreadsheet,
  Gauge,
  HandPlatter,
  Hourglass,
  Loader2,
  Package,
  ReceiptText,
  SearchX,
  ShoppingBag,
  Timer,
  TurkishLira,
  Users,
  XCircle,
} from 'lucide-react';
import { type ReactNode, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { COMP_LABEL } from '@shared/comp';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { tl, tlShort } from '@shared/money';
import type { PlatformId } from '@shared/platforms';
import type { CompKind, CompPersonKind, OdenmezPersonDTO } from '@shared/types';
import { BUSINESS_HOURS, businessHourIndex, currentBusinessDate, fmtDateTime, fmtTime, istanbulParts } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { AdminShell } from '@/components/admin/AdminShell';
import { ADMIN_SECTIONS } from '@/components/admin/sections';
import { PlatformBadge } from '@/components/PlatformBadge';
import { Badge, Card, CARD, type Column, type KpiCell, KpiStrip, KpiStripSkeleton, PageHeader, Segmented, SetupNotes, StatusTabs, TableSkeleton } from '@/components/admin/ui';
import { Field, Input, SearchInput, Select } from '@/components/ui/Field';
import { EmptyState, ErrorState, ListSkeleton, Notice, SizeTag, Skeleton } from '@/components/ui/misc';
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
import { REMOTE, REMOTE_REPORTS } from '@/lib/remote';

type ReportKey = 'ciro' | 'urunler' | 'saatlik' | 'hazirlama' | 'adisyon' | 'platformlar' | 'kayip' | 'happy' | 'personel' | 'aktarim';
type ProductView = 'urun' | 'kategori';
type LossKind = 'iptal' | 'ikram' | 'indirim' | 'iade';

const REPORTS: { key: ReportKey; label: string; hint: string; perm?: 'rapor.maliyet' }[] = [
  { key: 'ciro', label: 'Ciro', hint: 'Gelir özeti, döküm ve önceki dönem' },
  { key: 'urunler', label: 'Ürünler', hint: 'Ürün ve kategori satışları' },
  { key: 'saatlik', label: 'Saatlik', hint: 'Yoğun saatler, gün dilimleri' },
  { key: 'hazirlama', label: 'Hazırlama süresi', hint: 'Bar ve mutfak hızı' },
  { key: 'adisyon', label: 'Adisyonlar', hint: 'Kapanan ve iptal edilen adisyonlar' },
  { key: 'platformlar', label: 'Paket platformları', hint: 'Platform satışı, tahsilat ve kaçan sipariş' },
  { key: 'kayip', label: 'İptal ve indirim', hint: 'İptal, ikram, zayi, indirim, ödeme iptali' },
  { key: 'happy', label: 'Happy hour', hint: 'İndirimli satılan kalemler' },
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

/** Telefonda kısa ad (dört seçenek 358 px'e sığsın), geniş ekranda tam ad */
const short = (phone: string, full: string) => (
  <>
    <span className="sm:hidden">{phone}</span>
    <span className="max-sm:hidden">{full}</span>
  </>
);

const LOSS_TABS: { value: LossKind; label: ReactNode }[] = [
  { value: 'iptal', label: short('İptal', 'İptaller') },
  { value: 'ikram', label: short('İkram', 'İkram ve zayi') },
  { value: 'indirim', label: short('İndirim', 'İndirimler') },
  { value: 'iade', label: short('Ödeme iptali', 'Ödeme iptalleri') },
];

const PERIOD_KEYS = Object.keys(PERIOD_LABELS) as PeriodKey[];

export default function ReportsPage() {
  const can = useCan();
  const [saved, setReport] = useLocalPref<ReportKey>('reports.key', 'ciro');
  const legacy = LEGACY[saved];
  const report = legacy?.key ?? saved;
  const [productView, setProductView] = useLocalPref<ProductView>('reports.products', legacy?.product ?? 'urun');
  const [loss, setLoss] = useLocalPref<LossKind>('reports.loss', legacy?.loss ?? 'iptal');
  const top = useRef<HTMLDivElement>(null);
  const open = (key: ReportKey, sub?: { product?: ProductView; loss?: LossKind }) => {
    if (REMOTE && !(REMOTE_REPORTS as readonly string[]).includes(key)) return;
    if (sub?.product) setProductView(sub.product);
    if (sub?.loss) setLoss(sub.loss);
    setReport(key);
    // Sayfa pencereyle değil kabuğun iç kabıyla kayar: başa o kap döner
    top.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const [period, setPeriod] = useLocalPref<PeriodKey>('reports.period', 'bugun');
  const boot = useBoot();
  // "Bugün" açık iş günüdür (gün 05:00'te kapanmadıysa satış ona yazılır); patron paneli ve sunucuyla aynı kural
  const today = currentBusinessDate(boot.day?.date);
  const [custom, setCustom] = useState(() => periodRange('hafta', today));
  const range = period === 'ozel' ? custom : periodRange(period, today);
  // Uzaktan (LafPOS Uzaktan): yalnız günlük özetlerden toplanan sekmeler; Personel orada maliyetsiz satış tablosu
  // (patronun görünümü), maliyet ve kâr hiçbir sekmede yok
  const visible = REMOTE ? REPORTS.filter((r) => (REMOTE_REPORTS as readonly string[]).includes(r.key)) : REPORTS.filter((r) => !r.perm || can(r.perm));
  const current = visible.find((r) => r.key === report) ?? visible[0];
  // Dönem değişince açıklamada küçük gösterge (yerelde çoğu istek 50 ms; kısa yüklemede görünmez)
  const fetching = useDelayed(useIsFetching({ queryKey: ['reports'] }) > 0, 300);
  // İnen dosya: düğme istek sürerken kilitli (çift dokunuş iki dosya indirmesin, yavaş bağlantıda ölü görünmesin)
  const [busy, setBusy] = useState<string | null>(null);
  const busyRef = useRef(false);

  const exportCsv = async (key: string, path = `/api/reports/export.csv?type=${key}&from=${range.from}&to=${range.to}`) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(key);
    try {
      const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } }).catch(() => null);
      if (!res?.ok) {
        // Hata (ör. dönem 400 günden uzun) dosya olarak inmez, sunucunun metniyle bildirilir
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        toast.err(body?.error ?? 'CSV alınamadı; bağlantıyı kontrol edip yeniden deneyin');
        return;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = (res.headers.get('content-disposition') ?? '').match(/filename="([^"]+)"/)?.[1] ?? `lafpos-${key}.csv`;
      // Belgeye bağlı bağlantı (Safari ve iOS bağsız bağlantının tıklamasını yok sayabilir); adres indirme başladıktan
      // sonra geri alınır, hemen alınırsa iOS'ta dosya inmez
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } finally {
      busyRef.current = false;
      setBusy(null);
    }
  };

  return (
    <AdminShell title="Raporlar">
      <div ref={top} className="scroll-mt-5" />
      <PageHeader
        title="Raporlar"
        description={
          <>
            {current.hint} · {rangeLabel(range)}
            {fetching && <Loader2 aria-hidden="true" className="ml-1.5 inline size-3.5 animate-spin align-[-2px]" />}
          </>
        }
        actions={
          <>
            {/* Telefonda yedi dönem sığmaz: seçili dönem gizli kaydırıcıda kalmasın diye açılır liste */}
            <Select aria-label="Dönem" value={period} onChange={(e) => setPeriod(e.target.value as PeriodKey)} className="md:hidden">
              {PERIOD_KEYS.map((k) => (
                <option key={k} value={k}>
                  {PERIOD_LABELS[k]}
                </option>
              ))}
            </Select>
            {/* Telefonda sarmalayıcı gizlenir: Segmented'e verilen max-md:hidden'ı derlenmiş CSS'te kitin
                max-sm:flex'i ezer, 640 px altında liste ve yedi dönemlik ray yan yana kalırdı */}
            <div className="max-md:hidden max-lg:w-full">
              <Segmented label="Dönem" value={period} onChange={setPeriod} options={PERIOD_KEYS.map((k) => ({ value: k, label: PERIOD_LABELS[k] }))} className="max-lg:w-full max-lg:[&>*]:grow" />
            </div>
          </>
        }
      >
        {period === 'ozel' && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:items-end sm:gap-3">
            <Field label="Başlangıç">
              <Input type="date" value={custom.from} max={custom.to} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="sm:w-44 [[data-area=admin]_&]:pointer-fine:h-9" />
            </Field>
            <Field label="Bitiş">
              <Input type="date" value={custom.to} min={custom.from} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="sm:w-44 [[data-area=admin]_&]:pointer-fine:h-9" />
            </Field>
          </div>
        )}
      </PageHeader>
      <StatusTabs label="Rapor" value={current.key} onChange={setReport} tabs={visible.map((r) => ({ value: r.key, label: r.label }))} />
      {current.key === 'ciro' && <SummaryReport range={range} today={today} onOpen={open} />}
      {current.key === 'urunler' && (
        <ProductsReport range={range} today={today} view={productView} onView={setProductView} onExport={REMOTE ? undefined : () => void exportCsv('urunler')} exporting={busy === 'urunler'} />
      )}
      {current.key === 'saatlik' && <HourlyReport range={range} today={today} onExport={REMOTE ? undefined : () => void exportCsv('saatlik')} exporting={busy === 'saatlik'} />}
      {current.key === 'hazirlama' && <PrepReport range={range} today={today} />}
      {current.key === 'adisyon' && <ChecksReport range={range} today={today} onExport={() => void exportCsv('adisyonlar')} exporting={busy === 'adisyonlar'} />}
      {current.key === 'platformlar' && <PlatformsReport range={range} today={today} onExport={() => void exportCsv('platformlar')} exporting={busy === 'platformlar'} />}
      {current.key === 'kayip' && (
        <div className="space-y-3">
          <Segmented label="Tür" value={loss} onChange={setLoss} options={LOSS_TABS} className="max-sm:w-full max-sm:[&>*]:grow" />
          {/* Tür başına ayrı örnek: önceki türün satırları yeni türün başlığıyla görünmesin */}
          {loss === 'iade' ? (
            <RefundsReport range={range} today={today} />
          ) : (
            <ItemsReport key={loss} range={range} today={today} kind={loss} onExport={() => void exportCsv(loss)} exporting={busy === loss} />
          )}
        </div>
      )}
      {current.key === 'happy' && <ItemsReport range={range} today={today} kind="happy" />}
      {current.key === 'personel' && <StaffReport range={range} today={today} />}
      {current.key === 'aktarim' && (
        <ExportReport
          range={range}
          linked={boot.integrations.lafmaliyetPush}
          onDownload={() => void exportCsv('lafmaliyet', `/api/sync/lafmaliyet/satislar.csv?from=${range.from}&to=${range.to}`)}
          downloading={busy === 'lafmaliyet'}
        />
      )}
    </AdminShell>
  );
}

type Range = { from: string; to: string };
const qs = (r: Range) => `from=${r.from}&to=${r.to}`;
const fmtN = (n: number) => n.toLocaleString('tr-TR');

/**
 * Boş durumun başlığı ekranın zamanıyla (grafiğin `emptyLabel`ıyla aynı söz): "Bugün henüz satış yok", "Bu günde satış
 * yok", "Bu dönemde satış yok". Kayıp listelerinde "henüz" yazılmaz (iptal beklenen bir şey değil)
 */
function emptyTitle(r: Range, today: string, what: string, yet = true): string {
  const when = r.from !== r.to ? 'Bu dönemde' : r.from !== today ? 'Bu günde' : yet ? 'Bugün henüz' : 'Bugün';
  return `${when} ${what} yok`;
}

/** Boş durumun ikinci satırı: geçmiş dönemde başka dönem önerilir, bugünü içeren dönemde nasıl dolacağı söylenir */
const emptyHint = (r: Range, today: string, filling: string) => (r.to < today ? 'Başka bir dönem seçin' : filling);

/** Satırın zamanı: tek günde saat ("13:11"), çok günde gün ve saat ("26 Eki 13:11"), yılı değişen dönemde yılıyla */
function stamper(r: Range): (ms: number) => string {
  if (r.from === r.to) return fmtTime;
  const years = r.from.slice(0, 4) !== r.to.slice(0, 4);
  return (ms) => {
    const date = istanbulParts(ms).date;
    return `${fmtShortDate(date)}${years ? ` ${date.slice(0, 4)}` : ''} ${fmtTime(ms)}`;
  };
}

/** Önceki döneme göre değişim (sunucunun `change` kuralı: önceki dönem sıfırsa yüzde hesaplanmaz) */
const changeOf = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
const deltaOf = (c: number | null): KpiCell['delta'] => (c == null ? null : { text: `${c >= 0 ? '▲' : '▼'} %${Math.abs(c).toLocaleString('tr-TR')}`, good: c >= 0 });

/** KPI tutarı: milyondan sonra kuruş düşer (28 px rakam hücreye sığsın); tam tutar ipucunda ve Ciro dökümünde */
function KpiAmount({ value }: { value: number }) {
  return Math.abs(value) >= 100_000_000 ? <span title={tl(value)}>{tlShort(Math.round(value / 100) * 100)}</span> : <>{tl(value)}</>;
}

/** Boyun ayardaki adı (Orta, Büyük); tek boylu üründe null */
function useSizeName() {
  const labels = useBoot().settings.sizeLabels;
  return (size: string) => (size === 'M' || size === 'L' ? labels[size] : null);
}

const Dash = () => <span className="text-muted">—</span>;

const alignCls = (a?: 'left' | 'right' | 'center') => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
const hideCls = (c: { hideBelow?: 'lg' | 'xl' }) => (c.hideBelow === 'lg' ? 'hidden lg:table-cell' : c.hideBelow === 'xl' ? 'hidden xl:table-cell' : '');

/** Tablonun göründüğü (satır kartının gizlendiği) kırılım: Tailwind sınıfları derlemede bulunsun diye tam yazılır */
const TABLE_FROM = { md: 'md:block', lg: 'lg:block', xl: 'xl:block' } as const;
const CARDS_UNTIL = { md: 'md:hidden', lg: 'lg:hidden', xl: 'xl:hidden' } as const;

/**
 * Rapor kartındaki tablo: kitin DataTable'ıyla aynı görünüm (13 px başlık, zemini `--table-head-bg`, başlık çizgisi, satır
 * ayracı, telefonda satır kartı)
 * ama kendi kartı yok; başlıklı rapor kartının (CSV, arama, açıklama) içinde durur. Rapor satırının çekmecesi yok: tablette
 * (lg altında) gizlenecek sütunu olan tablo o genişliğe dek satır kartıdır, gizli sütunun değeri kartın meta satırında
 * (`phoneMeta`). İlk ve son görünen sütun kart başlığıyla aynı hizada (20 px). Kitin DataTable'ı kartsız (`bare`)
 * çizebilince ona döner.
 */
function ReportTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  phoneTitle,
  phoneMeta,
  phoneAside,
  foot,
  stackBelow,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  phoneTitle: (row: T) => ReactNode;
  phoneMeta?: (row: T) => ReactNode;
  phoneAside?: (row: T) => ReactNode;
  /** Toplam satırı: sütun anahtarına göre hücreler (ilk sütun yoksa "Toplam"); telefonda son satır kartı */
  foot?: { cells: Partial<Record<string, ReactNode>>; phoneMeta?: ReactNode; phoneAside?: ReactNode };
  /**
   * Satır kartından tabloya geçiş (yarım genişlikteki kartta geniş ekrana dek satır kartı). Verilmezse tablette (md)
   * tablo; lg altında gizlenecek sütun varsa lg'ye dek kart: tablette o sütun hiçbir yerde görünmezdi
   */
  stackBelow?: 'md' | 'lg' | 'xl';
}) {
  const stack = stackBelow ?? (columns.some((c) => c.hideBelow === 'lg') ? 'lg' : 'md');
  const shown = (c: Column<T>, bp: 'md' | 'lg' | 'xl') => !c.hideBelow || (c.hideBelow === 'lg' ? bp !== 'md' : bp === 'xl');
  const lastAt = (bp: 'md' | 'lg' | 'xl') => columns.reduce((a, c, i) => (shown(c, bp) ? i : a), -1);
  const last = [lastAt('md'), lastAt('lg'), lastAt('xl')];
  // Kenar boşluğu kart başlığıyla aynı (20 px), sütun arası 24 px; tablette gizlenen sütundan önceki sütun o genişlikte son olur
  const pad = (i: number) =>
    cn(
      i === 0 ? 'pl-5' : 'pl-3',
      last.every((l) => l === i) ? 'pr-5' : cn('pr-3', last[0] === i && 'max-lg:pr-5', last[1] === i && 'lg:max-xl:pr-5', last[2] === i && 'xl:pr-5'),
    );
  const phoneRow = 'flex flex-col gap-0.5 px-4 py-3 sm:px-5';
  return (
    <>
      <div className={cn('relative hidden overflow-x-auto', TABLE_FROM[stack])} data-overflow-ok>
        <table className="tabular w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {/* Başlık şeridi kitin DataTable'ı gibi: kasada kuyuda, kurumsal yüzeyde zeminsiz; altında başlık çizgisi */}
            <tr className="border-b border-[var(--admin-border)] bg-[var(--table-head-bg)]">
              {columns.map((c, i) => (
                <th key={c.key} scope="col" style={c.width ? { width: c.width } : undefined} className={cn('h-10 text-[13px] font-medium whitespace-nowrap text-[var(--admin-text-mute)]', pad(i), alignCls(c.align), hideCls(c), c.className)}>
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} className="border-t border-[var(--admin-divider)] transition-colors hover:bg-[var(--hover-solid)]">
                {columns.map((c, i) => (
                  <td key={c.key} className={cn('py-3 align-middle pointer-fine:[[data-density=compact]_&]:py-2', pad(i), alignCls(c.align), hideCls(c), c.className)}>
                    {c.cell(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {foot && (
            <tfoot>
              <tr className="border-t border-[var(--admin-border)] bg-[var(--admin-surface-2)] font-semibold">
                {columns.map((c, i) =>
                  i === 0 ? (
                    <th key={c.key} scope="row" className={cn('py-3 text-left', pad(i), hideCls(c), c.className)}>
                      {foot.cells[c.key] ?? 'Toplam'}
                    </th>
                  ) : (
                    <td key={c.key} className={cn('py-3', pad(i), alignCls(c.align), hideCls(c), c.className)}>
                      {foot.cells[c.key]}
                    </td>
                  ),
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <ul aria-label={caption} className={cn('divide-y divide-[var(--admin-divider)] text-sm', CARDS_UNTIL[stack])}>
        {rows.map((r) => (
          <li key={rowKey(r)} className={phoneRow}>
            <span className="flex items-start gap-3">
              <span className="min-w-0 flex-1 font-medium text-[var(--admin-text)]">{phoneTitle(r)}</span>
              {phoneAside && <span className="tabular shrink-0 font-semibold whitespace-nowrap">{phoneAside(r)}</span>}
            </span>
            {phoneMeta && <span className="tabular text-xs text-[var(--admin-text-mute)]">{phoneMeta(r)}</span>}
          </li>
        ))}
        {foot && (
          <li className={cn(phoneRow, 'bg-[var(--admin-surface-2)]')}>
            <span className="flex items-start gap-3 font-semibold">
              <span className="min-w-0 flex-1">Toplam</span>
              {foot.phoneAside && <span className="tabular shrink-0 whitespace-nowrap">{foot.phoneAside}</span>}
            </span>
            {foot.phoneMeta && <span className="tabular text-xs text-[var(--admin-text-mute)]">{foot.phoneMeta}</span>}
          </li>
        )}
      </ul>
    </>
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
      <div className="px-4 pt-4 sm:px-5">
        <Skeleton className="h-4 w-48" />
      </div>
      <ListSkeleton rows={rows} />
    </div>
  );
}

/** KPI şeridi ve grafik kartı biçiminde iskelet (Saatlik, Hazırlama) */
const stripSkeleton = (count: number) => (
  <div className="space-y-4">
    <KpiStripSkeleton count={count} />
    <Skeleton className="h-[290px] rounded-[var(--r-card)]" />
  </div>
);

function SummaryReport({ range, today, onOpen }: { range: Range; today: string; onOpen: (key: ReportKey, sub?: { product?: ProductView; loss?: LossKind }) => void }) {
  const single = range.from === range.to;
  const q = useReport<Summary>(['summary', range], `/reports/summary?${qs(range)}`);
  const hourly = useQuery({ queryKey: ['reports', 'hourly', range], queryFn: () => get<HourlyData>(`/reports/hourly?${qs(range)}`), enabled: single, placeholderData: keepPreviousData });
  const noSales = emptyTitle(range, today, 'satış');
  const skeleton = (
    <div className="space-y-4">
      <KpiStripSkeleton />
      <div role="status" aria-label="Yükleniyor…" className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Skeleton className="h-[290px] rounded-[var(--r-card)]" />
        <Skeleton className="h-[290px] rounded-[var(--r-card)]" />
      </div>
    </div>
  );
  return (
    <ReportBody q={q} skeleton={skeleton}>
      {(s) => {
        const prev = previousShort(s.previous.label, s.previous.range);
        const compared = `Kıyas: ${s.previous.label}`;
        // Etiket en çok 18, referans en çok 30 karakter; ayrıntı döküm kartlarında ve tıklanınca açılan raporda. Renk anlam
        // taşır: ciro yeşil (grafik serisi), online mor (her ekranda), kayıp pembe, durumsuz sayılar nötr
        const cells: KpiCell[] = [
          {
            key: 'ciro',
            label: 'Ciro (KDV dahil)',
            icon: <TurkishLira />,
            hue: 'green',
            value: <KpiAmount value={s.netSales} />,
            delta: deltaOf(s.previous.change),
            // Kıyas döneminde satış yoksa yüzde hesaplanamaz: "veri yok" değil, o dönem satış yoktu
            reference: <span title={compared}>{s.previous.change == null ? `${prev} satış yoktu` : `${prev}: ${tlShort(s.previous.netSales)}`}</span>,
          },
          {
            key: 'adisyon',
            label: 'Adisyon',
            icon: <ReceiptText />,
            value: fmtN(s.receipts),
            delta: deltaOf(changeOf(s.receipts, s.previous.receipts)),
            reference: (
              <>
                <span className="block" title={compared}>
                  {s.previous.receipts ? `${prev}: ${fmtN(s.previous.receipts)}` : `${prev} adisyon yoktu`}
                </span>
                {s.receipts > 0 && <span className="block">{joinMeta([`Ortalama ${tlShort(s.avgCheck)}`, s.perGuest != null && `kişi başı ${tlShort(s.perGuest)}`])}</span>}
              </>
            ),
            // Uzakta adisyon listesi yok: karo dokunulmaz
            onClick: REMOTE ? undefined : () => onOpen('adisyon'),
          },
          {
            key: 'urun',
            label: 'Satılan ürün',
            icon: <Package />,
            value: fmtN(s.itemsSold),
            reference: s.days > 1 ? `${s.days} iş günü` : s.days === 1 ? 'Tek iş günü' : 'Gün açılmadı',
            onClick: () => onOpen('urunler', { product: 'urun' }),
          },
          // Değer indirim ve bütün ciro dışı kalemler (ikram, ödenmez, zayi): referans hepsini söyler, sıfır olan düşer
          {
            key: 'indirim',
            label: 'İndirim ve ikram',
            icon: <BadgePercent />,
            hue: 'rose',
            value: <KpiAmount value={s.discounts + s.complimentary} />,
            reference: s.discounts + s.complimentary + s.voided ? lossParts(s, tlShort) : 'İndirim ve ikram yok',
            onClick: REMOTE ? undefined : () => onOpen('kayip', { loss: s.complimentary > s.discounts ? 'ikram' : 'indirim' }),
          },
          {
            key: 'online',
            label: 'Online',
            icon: <ShoppingBag />,
            hue: 'violet',
            value: <KpiAmount value={s.online.amount} />,
            reference: s.online.orders ? `${fmtN(s.online.orders)} sipariş sitede ödendi · ciroya dahil değil` : 'Sitede sipariş yok',
          },
        ];
        return (
          <div className="space-y-4">
            <KpiStrip cells={cells} />
            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
              <Card flush title={single ? 'Saatlik ciro' : 'Günlük ciro'}>
                <div className="p-4 sm:px-5">
                  {!single ? (
                    <ColumnChart data={s.byDay.map((d) => ({ label: fmtShortDate(d.date), value: d.netSales }))} format={tl} seriesLabel="Ciro" ariaLabel="Günlük ciro" emptyLabel={noSales} />
                  ) : hourly.isPending ? (
                    <Skeleton className="h-[220px] rounded-[var(--r-tile)]" />
                  ) : hourly.data ? (
                    <ColumnChart data={hourColumns(hourly.data.hours)} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro" emptyLabel={noSales} />
                  ) : (
                    <ErrorState compact title="Saatlik ciro alınamadı" error={hourly.error} onRetry={() => void hourly.refetch()} retrying={hourly.isFetching} />
                  )}
                </div>
              </Card>
              <Card flush title="Ödeme türleri">
                <div className="p-4 sm:px-5">
                  {s.payments.length ? (
                    <BarList items={s.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.count} işlem` }))} format={tl} />
                  ) : (
                    <EmptyState compact icon={<CreditCard />} title={emptyTitle(range, today, 'ödeme')}>
                      Adisyonlar kapandıkça ödeme türleri burada toplanır
                    </EmptyState>
                  )}
                  {s.tips > 0 && <p className="mt-3 text-xs text-muted">Bahşiş {tl(s.tips)} (ciro dışı)</p>}
                </div>
              </Card>
            </div>
            <div className="grid gap-4 lg:grid-cols-2">
              <Card flush title="Ciro dökümü" subtitle="Kapanmış adisyonlar; iptaller düşülmez, bilgi olarak">
                {/* Gelir tablosu gibi: düşülen kalem (ikram, indirim, KDV) ikincil tonda, ara toplam ve sonuç açık gri
                    şeritte ve kalın; iptal yalnız bilgi, en altta soluk. Rakamlar aynı, yalnız görünüm */}
                <dl className="divide-y divide-[var(--admin-divider)] pb-1.5 text-sm">
                  {(
                    [
                      ['Liste değeri', s.waterfall.list, 'base'],
                      [s.odenmez || s.zayi ? 'Ciro dışı (ikram, ödenmez, zayi)' : 'İkram', -s.waterfall.complimentary, 'minus'],
                      ['İndirim', -s.waterfall.discounts, 'minus'],
                      ...(s.waterfall.service ? [['Servis ücreti', s.waterfall.service, 'base'] as const] : []),
                      ['Ciro (KDV dahil)', s.waterfall.revenue, 'total'],
                      ['KDV', -s.waterfall.kdv, 'minus'],
                      ['Net satış (KDV hariç)', s.waterfall.netExKdv, 'total'],
                    ] as const
                  ).map(([label, v, kind]) => (
                    <div
                      key={label}
                      className={cn(
                        'flex items-baseline justify-between gap-3 px-4 py-2.5 sm:px-5',
                        kind === 'total' && 'bg-[var(--admin-surface-2)] font-semibold text-[var(--admin-text)]',
                        kind === 'minus' && 'text-[var(--admin-text-soft)]',
                      )}
                    >
                      <dt>{label}</dt>
                      {/* Sıfır eksi işaretsiz (-0 da sıfırdır); düşülen tutar matematik eksisiyle */}
                      <dd className={cn('tabular whitespace-nowrap', kind === 'total' && 'text-[15px]')}>{v === 0 ? tl(0) : v < 0 ? `−${tl(-v)}` : tl(v)}</dd>
                    </div>
                  ))}
                  <div className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-muted sm:px-5">
                    <dt>İptal edilen (bilgi, açık adisyonlar dahil)</dt>
                    <dd className="tabular whitespace-nowrap">{tl(s.voided)}</dd>
                  </div>
                </dl>
              </Card>
              <div className="space-y-4">
                <Card flush title="Satış türleri">
                  <div className="p-4 sm:px-5">
                    {s.types.length ? (
                      <BarList items={s.types.map((t) => ({ key: t.type, label: TYPE_LABEL[t.type] ?? t.type, value: t.amount, sub: `${t.orders} adisyon` }))} format={tl} />
                    ) : (
                      <EmptyState compact icon={<ShoppingBag />} title={noSales} />
                    )}
                  </div>
                </Card>
                <Card flush title="KDV oranlarına göre" subtitle="KDV dahil ciro, oranlara göre" className="overflow-hidden">
                  {s.kdv.length === 0 ? (
                    <EmptyState compact icon={<ReceiptText />} title={noSales} />
                  ) : (
                    <ReportTable
                      caption="KDV oranlarına göre"
                      rows={s.kdv}
                      rowKey={(k) => String(k.rate)}
                      stackBelow="xl"
                      columns={[
                        { key: 'oran', header: 'Oran', cell: (k) => <span className="font-medium">%{k.rate}</span> },
                        { key: 'matrah', header: 'Matrah', align: 'right', className: 'whitespace-nowrap', cell: (k) => <span className="text-ink-2">{tl(k.base)}</span> },
                        { key: 'kdv', header: 'KDV', align: 'right', className: 'whitespace-nowrap', cell: (k) => <span className="text-ink-2">{tl(k.kdv)}</span> },
                        { key: 'ciro', header: 'Ciro', align: 'right', className: 'whitespace-nowrap', cell: (k) => <span className="font-medium">{tl(k.gross)}</span> },
                      ]}
                      phoneTitle={(k) => `%${k.rate}`}
                      phoneMeta={(k) => `Matrah ${tl(k.base)} · KDV ${tl(k.kdv)}`}
                      phoneAside={(k) => tl(k.gross)}
                    />
                  )}
                  {/* Satışsız günde "mutabık (₺0,00)" yazılmaz; ödeme ya da fark varsa her zaman */}
                  {(s.receipts > 0 || s.reconciliation.difference !== 0 || s.reconciliation.paidOpen > 0) && (
                    <Notice tone={s.reconciliation.difference === 0 ? 'success' : 'danger'} className="mx-4 mb-4 mt-3 text-[13px] sm:mx-5">
                      {s.reconciliation.difference === 0
                        ? `Mutabık: kapanmış adisyonların ödemeleri ciroya eşit (${tl(s.reconciliation.paidClosed)})`
                        : `Fark var: ödemeler ${tl(s.reconciliation.paidClosed)}, ciro ${tl(s.waterfall.revenue)}; fark ${tl(s.reconciliation.difference)}`}
                      {s.reconciliation.paidOpen > 0 && ` · açık adisyonlardan alınan ${tl(s.reconciliation.paidOpen)} ayrı`}
                    </Notice>
                  )}
                </Card>
              </div>
            </div>
            <p className="text-xs text-muted">{fmtDateTime(s.asOf)} itibarıyla · ciro kapanmış adisyonlardan, adisyonun açıldığı iş gününe göre</p>
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
type ProductRow = ProductsData['products'][number];

/**
 * Ürünler: görünüm, arama ve CSV tek araç çubuğunda (kartın üstünde); kart yalnız tablo. Sıra numarası ürünün dönemdeki
 * ciro sırası (aramada da değişmez), çubuk dönemin en çok satanına göre
 */
function ProductsReport({
  range,
  today,
  view,
  onView,
  onExport,
  exporting,
}: {
  range: Range;
  today: string;
  view: ProductView;
  onView: (v: ProductView) => void;
  /** CSV yok (uzaktan görünüm) */
  onExport?: () => void;
  exporting: boolean;
}) {
  const can = useCan();
  const withCost = can('rapor.maliyet');
  const sizeName = useSizeName();
  const [q, setQ] = useState('');
  const data = useReport<ProductsData>(['products', range], `/reports/products?${qs(range)}`);
  const hasRows = !!data.data?.products.length;
  const needle = q.trim().toLocaleLowerCase('tr-TR');
  const rows = useMemo(() => (data.data?.products ?? []).filter((p) => p.name.toLocaleLowerCase('tr-TR').includes(needle)), [data.data, needle]);
  const noSales = (
    <EmptyState compact icon={<Package />} title={emptyTitle(range, today, 'satış')}>
      {emptyHint(range, today, 'Açık adisyonlar kapanınca burada sayılır')}
    </EmptyState>
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented label="Görünüm" value={view} onChange={onView} options={[{ value: 'urun', label: 'Ürün' }, { value: 'kategori', label: 'Kategori' }]} />
        {view === 'urun' && hasRows && (
          <>
            {/* Ortak arama alanı: dokunmatikte 44 px, fareyle 36; temizle düğmesi ve Escape. Telefonda kendi satırında */}
            <SearchInput dense value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ara" wrapperClassName="order-last basis-full sm:order-none sm:max-w-xs sm:flex-1 sm:basis-auto" />
            {onExport && (
              <Button size="sm" icon={<Download className="size-4" />} loading={exporting} onClick={onExport} className="ml-auto">
                CSV
              </Button>
            )}
          </>
        )}
      </div>
      <ReportBody q={data} skeleton={view === 'urun' ? <TableSkeleton /> : <CardSkeleton />}>
        {(d) => {
          if (view === 'kategori')
            return (
              <Card flush title="Kategori payları" subtitle={d.categories.length ? `Toplam ${tl(d.total)}` : undefined}>
                <div className="p-4 sm:px-5">
                  {d.categories.length ? (
                    <BarList items={d.categories.map((c) => ({ key: c.name, label: c.name, value: c.revenue, sub: `%${c.share.toLocaleString('tr-TR')} · ${c.qty} adet` }))} format={tl} />
                  ) : (
                    noSales
                  )}
                </div>
              </Card>
            );
          const rank = new Map(d.products.map((p, i) => [p.key, i + 1]));
          const top = Math.max(1, ...d.products.map((p) => p.revenue));
          const stale = withCost ? staleCostsText(d.costsAt) : null;
          const costCol: Column<ProductRow> = {
            key: 'kar',
            header: 'Brüt kâr',
            align: 'right',
            hideBelow: 'lg',
            className: 'whitespace-nowrap',
            // Sözcük rakamın yerine yazılmaz: maliyeti olmayan ya da hiç satılmayan (hepsi ikram) üründe —
            cell: (p) => (p.margin == null || !p.qty ? <span className="text-muted" title={p.margin == null ? 'Reçete maliyeti girilmemiş' : undefined}>—</span> : tl(p.margin)),
          };
          const columns: Column<ProductRow>[] = [
            { key: 'sira', header: '#', width: '3rem', cell: (p) => <span className="text-muted">{rank.get(p.key)}</span> },
            {
              key: 'urun',
              header: 'Ürün',
              cell: (p) => {
                const extra = joinMeta([p.complimentary > 0 && `${p.complimentary} ikram`, p.voided > 0 && `${p.voided} iptal`]);
                return (
                  <>
                    <span className="font-medium">{p.name}</span>
                    <SizeTag>{sizeName(p.size)}</SizeTag>
                    {extra && <span className="block text-xs text-muted">{extra}</span>}
                  </>
                );
              },
            },
            { key: 'kategori', header: 'Kategori', hideBelow: 'lg', cell: (p) => <span className="text-muted">{p.category || '—'}</span> },
            { key: 'adet', header: 'Adet', align: 'right', cell: (p) => fmtN(p.qty) },
            {
              key: 'ciro',
              header: 'Ciro',
              width: '26%',
              cell: (p) => (
                <div className="flex items-center gap-3">
                  <div aria-hidden="true" className="h-2 min-w-10 flex-1 rounded-[var(--r-track)]" style={{ background: 'var(--chart-track)' }}>
                    <div className="h-2 rounded-[var(--r-track)]" style={{ width: `${p.revenue > 0 ? Math.max(1, (p.revenue / top) * 100) : 0}%`, background: 'var(--chart-accent)' }} />
                  </div>
                  <span className="min-w-24 shrink-0 text-right font-semibold whitespace-nowrap">{tl(p.revenue)}</span>
                </div>
              ),
            },
            { key: 'pay', header: 'Pay', align: 'right', hideBelow: 'lg', cell: (p) => <span className="text-muted">%{p.share.toLocaleString('tr-TR')}</span> },
            { key: 'ort', header: 'Ort. fiyat', align: 'right', hideBelow: 'xl', className: 'whitespace-nowrap', cell: (p) => (p.qty ? tl(p.avgPrice) : <Dash />) },
            ...(withCost ? [costCol] : []),
          ];
          return (
            <Card flush title="Ürün satışları" subtitle={d.products.length ? joinMeta([`Toplam ${tl(d.total)}`, d.service > 0 && `servis ücreti ${tl(d.service)} ayrı`]) : undefined} className="overflow-hidden">
              {rows.length === 0 ? (
                needle && d.products.length ? (
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
                  noSales
                )
              ) : (
                <ReportTable
                  caption="Ürün satışları"
                  rows={rows}
                  rowKey={(p) => p.key}
                  columns={columns}
                  phoneTitle={(p) => (
                    <>
                      {p.name}
                      <SizeTag>{sizeName(p.size)}</SizeTag>
                    </>
                  )}
                  phoneMeta={(p) =>
                    joinMeta([
                      `${fmtN(p.qty)} adet`,
                      p.category,
                      `%${p.share.toLocaleString('tr-TR')}`,
                      p.complimentary > 0 && `${p.complimentary} ikram`,
                      p.voided > 0 && `${p.voided} iptal`,
                      // Tablonun Brüt kâr sütunu ve alttaki açıklamayla aynı: maliyeti girilmemiş üründe —
                      withCost && p.qty > 0 && `brüt kâr ${p.margin == null ? '—' : tl(p.margin)}`,
                    ])
                  }
                  phoneAside={(p) => tl(p.revenue)}
                />
              )}
              {withCost && rows.length > 0 && (
                <p className="border-t border-[var(--admin-divider)] px-4 py-3 text-xs text-muted sm:px-5">
                  Brüt kâr: KDV hariç ciro − lafmaliyet reçete maliyeti (maliyeti girilmemiş üründe —). Maliyetler gün sonunda günde bir kendiliğinden, Yönetim › Site ve lafmaliyet’ten elle çekilir
                  {stale && <span className="block font-medium text-[var(--admin-warning)]">{stale}</span>}
                </p>
              )}
            </Card>
          );
        }}
      </ReportBody>
    </div>
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

const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;

function HourlyReport({ range, today, onExport, exporting }: { range: Range; today: string; onExport?: () => void; exporting: boolean }) {
  const data = useReport<HourlyData>(['hourly', range], `/reports/hourly?${qs(range)}`);
  return (
    <ReportBody q={data} skeleton={stripSkeleton(4)}>
      {(h) => {
        // Satışsız dönemde dört ayrı "yok" yerine tek boş durum (Hazırlama ve Platformlar gibi)
        if (!h.total)
          return (
            <EmptyState className={CARD} icon={<Clock />} title={emptyTitle(range, today, 'satış')}>
              {emptyHint(range, today, 'Adisyonlar kapandıkça saat saat ciro burada toplanır')}
            </EmptyState>
          );
        const active = h.hours.filter((x) => x.orders).length;
        const hourRef = (r: HourRow) => `${r.nextDay ? 'Ertesi gün · ' : ''}${tlShort(r.revenue)} · ${r.orders} adisyon`;
        // Tek saatte satış varsa en yoğun ve en sakin aynı saat: ikinci kez yazılmaz. Ölçüt Toplam'daki aktif saat sayısı;
        // saatlerin cirosu eşit diye "yalnız bir saatte" denmez
        const oneHour = active === 1;
        const cells: KpiCell[] = [
          { key: 'toplam', label: 'Toplam', icon: <TurkishLira />, hue: 'green', value: <KpiAmount value={h.total} />, reference: `${active} aktif saat` },
          { key: 'yogun', label: 'En yoğun saat', icon: <Clock />, value: h.busiest ? hh(h.busiest.hour) : '—', reference: h.busiest ? hourRef(h.busiest) : 'Sayılmadı' },
          {
            key: 'sakin',
            label: 'En sakin saat',
            icon: <Clock />,
            value: h.quietest && !oneHour ? hh(h.quietest.hour) : '—',
            reference: oneHour ? 'Satış yalnız bir saatte' : h.quietest ? hourRef(h.quietest) : 'Sayılmadı',
          },
          h.days > 1
            ? { key: 'gunluk', label: 'Gün başına', icon: <CalendarDays />, hue: 'green', value: <KpiAmount value={Math.round(h.total / h.days)} />, reference: `${h.days} iş gününün ortalaması` }
            : { key: 'saatbasi', label: 'Saat başına', icon: <Gauge />, hue: 'green', value: <KpiAmount value={Math.round(h.total / Math.max(1, active))} />, reference: 'Aktif saatlerin ortalaması' },
        ];
        return (
          <div className="space-y-4">
            <KpiStrip cells={cells} />
            <Card
              flush
              title="Saat dağılımı"
              subtitle={h.hours.length > 24 ? 'Gün 24 saati aştı; ertesi günün saatleri sonda' : 'Adisyonun açıldığı saate göre'}
              actions={
                onExport && (
                  <Button size="sm" icon={<Download className="size-4" />} loading={exporting} onClick={onExport}>
                    CSV
                  </Button>
                )
              }
            >
              <div className="p-4 sm:px-5">
                <ColumnChart data={hourColumns(h.hours)} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro dağılımı" emptyLabel={emptyTitle(range, today, 'satış')} />
              </div>
            </Card>
            {h.days >= 7 && <WeekHeatmap week={h.week} />}
            <div className="grid gap-4 lg:grid-cols-2">
              <Card flush title="Gün dilimleri">
                <div className="p-4 sm:px-5">
                  <BarList items={h.parts.map((p) => ({ key: p.key, label: p.label, value: p.revenue, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.orders} adisyon` }))} format={tl} />
                  <p className="mt-3 text-xs text-muted">Sabah 06-12 · Öğle 12-17 · Akşam 17-22 · Gece 22-06</p>
                </div>
              </Card>
              <Card flush title="Pik saatler" subtitle="En çok ciro yapan saatler">
                {/* Genel bakışın en çok satanlarıyla aynı satır: solda sıra dairesi (birinci dolu ev yeşili), saat ve altında
                    adisyon sayısı, sağda tutar */}
                <ol className="divide-y divide-[var(--admin-divider)] pb-1.5">
                  {h.peaks.map((p, i) => (
                    <li key={p.offset} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                      <span
                        aria-hidden="true"
                        className={cn(
                          'tabular grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold',
                          i === 0 ? 'bg-[var(--admin-ink-fill)] text-[var(--admin-on-ink)]' : 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="tabular block font-medium text-[var(--admin-text)]">
                          {hh(p.hour)} – {String(p.hour).padStart(2, '0')}:59
                          {p.nextDay && <span className="ml-1.5 text-xs font-normal text-muted">ertesi gün</span>}
                        </span>
                        <span className="tabular block text-xs text-muted">{p.orders} adisyon</span>
                      </span>
                      <span className="tabular shrink-0 text-right font-semibold whitespace-nowrap text-[var(--admin-text)]">{tl(p.revenue)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        );
      }}
    </ReportBody>
  );
}

const WEEKDAY_SHORT = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
const WEEKDAY_LONG = ['Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi', 'Pazar'];
/** Tek renk, açıktan koyuya 5 basamak (sıfır boş kalır); en açık basamak koyu temada da boş hücreden ayrılır */
const HEAT_STEPS = [24, 40, 58, 76, 94];
const heat = (pct: number) => `color-mix(in oklab, var(--chart-accent) ${pct}%, var(--admin-surface))`;

/**
 * Haftanın günü × saat ısı haritası: personel planı için hangi gün hangi saat yoğun (sütunlar iş günü sırasıyla). Gün
 * adları kayarken yerinde kalır; hücrenin değeri fareyle ipucunda, dokunmatikte dokununca lejantın altında (hücre
 * dokunmatikte 44 px, harita yana kayar)
 */
function WeekHeatmap({ week }: { week: HourlyData['week'] }) {
  // Seçilen hücre yeriyle (gün sırası, saat) tutulur, yazısı her çizimde o anki veriden: dönem değişince ya da veri
  // yenilenince altta önceki dönemin rakamı kalmaz
  const [picked, setPicked] = useState<{ wi: number; hour: number } | null>(null);
  const all = week.flatMap((w) => w.hours);
  const max = Math.max(0, ...all);
  if (max === 0) return null;
  const used = all.map((v, i) => (v > 0 ? businessHourIndex(i % 24) : -1)).filter((x) => x >= 0);
  const cols = BUSINESS_HOURS.slice(Math.min(...used), Math.max(...used) + 1);
  const step = (v: number) => (v <= 0 ? -1 : Math.min(HEAT_STEPS.length - 1, Math.floor((v / max) * HEAT_STEPS.length)));
  const labelOf = (wi: number, hour: number) => {
    const w = week[wi];
    const v = w.hours[hour] ?? 0;
    return `${WEEKDAY_LONG[wi]} ${String(hour).padStart(2, '0')}:00 · ${v > 0 ? tl(v) : 'satış yok'}${w.days > 1 ? ` (${w.days} günün ortalaması)` : ''}`;
  };
  // Yeni dönemin haritasında o saat sütunu yoksa seçim de yazısı da görünmez
  const shown = picked && week[picked.wi] && cols.includes(picked.hour) ? picked : null;
  return (
    <Card flush title="Gün ve saat" subtitle="Haftanın günlerine göre saatlik ortalama ciro">
      {/* relative: hücrelerin gizli etiketi (sr-only, mutlak konumlu) kayan kutuda kalsın, telefonda sayfayı genişletmesin */}
      <div className="relative overflow-x-auto px-4 pb-4 pt-1 sm:px-5" data-overflow-ok>
        <table
          className="w-full border-separate border-spacing-[3px] text-[11px]"
          aria-label="Haftanın günlerine ve saatlere göre ortalama ciro"
          onClick={(e) => {
            const cell = (e.target as HTMLElement).closest<HTMLElement>('td[data-hour]');
            setPicked(cell ? { wi: Number(cell.dataset.wi), hour: Number(cell.dataset.hour) } : null);
          }}
        >
          <thead>
            <tr>
              <th className="sticky left-0 z-[1] w-10 bg-[var(--admin-surface)]" />
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
                <th scope="row" className="sticky left-0 z-[1] bg-[var(--admin-surface)] pr-1 text-left font-medium text-muted">
                  {WEEKDAY_SHORT[wi]}
                </th>
                {cols.map((c) => {
                  const k = step(w.hours[c] ?? 0);
                  const label = labelOf(wi, c);
                  return (
                    <td
                      key={c}
                      title={label}
                      data-wi={wi}
                      data-hour={c}
                      className={cn(
                        // Dokunmatikte dokunulan hedef 44 px (genişlik tablo hücresinde en az genişlik olarak işler)
                        'h-7 min-w-7 rounded-[4px] pointer-coarse:h-11 pointer-coarse:w-11 pointer-coarse:min-w-11',
                        k < 0 && 'shadow-[inset_0_0_0_1px_var(--admin-divider)]',
                        shown?.wi === wi && shown.hour === c && 'shadow-[inset_0_0_0_2px_var(--admin-text)]',
                      )}
                      style={{ background: k < 0 ? 'var(--admin-surface-2)' : heat(HEAT_STEPS[k]) }}
                    >
                      <span className="sr-only">{label}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {/* Lejant görsel: ekran okuyucu her hücrenin değerini kendi metninden okur */}
        <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            Az
            {HEAT_STEPS.map((p) => (
              <span key={p} className="size-3.5 rounded-[3px]" style={{ background: heat(p) }} />
            ))}
            Çok
          </span>
          <span className="tabular">En yüksek {tl(max)}</span>
          <span className="pointer-fine:hidden">Değer için hücreye dokunun</span>
        </div>
        {shown && (
          <p aria-live="polite" className="tabular mt-2 text-xs font-medium text-ink-2">
            {labelOf(shown.wi, shown.hour)}
          </p>
        )}
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

/** Süre ekseni dakikayla (ham değer saniye): 0, 2 dk, 4 dk… */
const minuteTick = (sec: number) => (sec ? `${(sec / 60).toLocaleString('tr-TR')} dk` : '0');

/** Uzun ürün listesinde ilk bu kadar satır; gerisi düğmeyle açılır (yan kart boşuna uzamasın) */
const PREP_PRODUCTS = 10;

/** Bar ve mutfakta hazırlama süresi: gönderilmesinden "Hazır"a. Ortalama ve en yavaş %10 (p90) */
function PrepReport({ range, today }: { range: Range; today: string }) {
  const sizeName = useSizeName();
  const [all, setAll] = useState(false);
  const data = useReport<PrepData>(['prep', range], `/reports/prep?${qs(range)}`);
  const at = stamper(range);
  return (
    <ReportBody q={data} skeleton={stripSkeleton(5)}>
      {(p) => {
        if (!p.overall.count)
          return (
            <EmptyState className={CARD} art="saat" title={emptyTitle(range, today, 'hazırlanan kalem')}>
              Bar ve mutfak ekranında “Hazır”a basılan kalemler burada sayılır
            </EmptyState>
          );
        const products = all ? p.products : p.products.slice(0, PREP_PRODUCTS);
        // Süre durum değil, nötr; amber yalnız yavaşlığı söyleyen iki hücrede (zaman uyarısı)
        const cells: KpiCell[] = [
          { key: 'ortalama', label: 'Ortalama', icon: <Timer />, value: dur(p.overall.avg), reference: `${fmtN(p.overall.count)} kalem` },
          { key: 'ortanca', label: 'Ortanca', icon: <Timer />, value: dur(p.overall.median), reference: 'Kalemlerin yarısı bundan kısa' },
          { key: 'p90', label: 'En yavaş %10', icon: <Hourglass />, hue: 'amber', value: dur(p.overall.p90), reference: 'Her 10 kalemden biri daha uzun' },
          { key: 'enuzun', label: 'En uzun', icon: <Hourglass />, hue: 'amber', value: dur(p.overall.max), reference: 'Tek kalemde' },
          // Müşterinin hazır siparişi ne kadar sürede aldığı: bar ekranında ya da kasada "Teslim edildi"
          {
            key: 'teslim',
            label: 'Hazırdan teslime',
            icon: <HandPlatter />,
            value: p.handoff?.count ? dur(p.handoff.median) : '—',
            reference: p.handoff?.count ? `Ortanca · ${fmtN(p.handoff.count)} teslim` : 'Sayılmadı · teslim işaretlenmedi',
          },
        ];
        return (
          <div className="space-y-4">
            <KpiStrip cells={cells} />
            <Card flush title="Saate göre ortalama süre" subtitle="Kalemin bara gönderildiği saate göre">
              <div className="p-4 sm:px-5">
                {/* Değerler saniye: eksen dakikayla; birkaç saniyelik ortalama sıfıra yuvarlansa da grafik boş sayılmaz */}
                <ColumnChart
                  data={byBusinessHour(p.hours).map((x) => ({ label: String(x.hour).padStart(2, '0'), title: hh(x.hour), value: x.avg }))}
                  format={dur}
                  seriesLabel="Ortalama süre"
                  ariaLabel="Saate göre ortalama hazırlama süresi"
                  unitDivisor={60}
                  tickFormat={minuteTick}
                  empty={!p.hours.length}
                  emptyLabel={emptyTitle(range, today, 'hazırlanan kalem')}
                />
              </div>
            </Card>
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              <Card flush title="En yavaş ürünler" subtitle="En yavaş %10’a göre sıralı" className="overflow-hidden">
                <ReportTable
                  caption="En yavaş ürünler"
                  rows={products}
                  rowKey={(r) => `${r.name}|${r.size}`}
                  columns={[
                    {
                      key: 'urun',
                      header: 'Ürün',
                      cell: (r) => (
                        <>
                          <span className="font-medium">{r.name}</span>
                          <SizeTag>{sizeName(r.size)}</SizeTag>
                        </>
                      ),
                    },
                    { key: 'kalem', header: 'Kalem', align: 'right', cell: (r) => <span className="text-muted">{fmtN(r.count)}</span> },
                    { key: 'ortalama', header: 'Ortalama', align: 'right', className: 'whitespace-nowrap', cell: (r) => dur(r.avg) },
                    { key: 'p90', header: 'En yavaş %10', align: 'right', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold">{dur(r.p90)}</span> },
                  ]}
                  phoneTitle={(r) => (
                    <>
                      {r.name}
                      <SizeTag>{sizeName(r.size)}</SizeTag>
                    </>
                  )}
                  phoneMeta={(r) => `${fmtN(r.count)} kalem · ortalama ${dur(r.avg)}`}
                  phoneAside={(r) => dur(r.p90)}
                />
                {p.products.length > PREP_PRODUCTS && (
                  <div className="flex justify-center border-t border-[var(--admin-divider)] px-2 py-1.5 sm:px-3">
                    <Button variant="ghost" size="sm" aria-expanded={all} onClick={() => setAll((v) => !v)}>
                      {all ? 'Daha az göster' : `Tümünü göster (${fmtN(p.products.length)})`}
                    </Button>
                  </div>
                )}
              </Card>
              <Card flush title="En uzun bekleyen 10 kalem" subtitle="Gönderilmesinden “Hazır”a">
                <ol className="divide-y divide-[var(--admin-divider)]">
                  {p.slowest.map((s, i) => (
                    <li key={`${s.orderNo}-${s.sentAt}-${i}`} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">
                          {s.name}
                          <SizeTag>{sizeName(s.size)}</SizeTag>
                        </span>
                        <span className="tabular block text-xs text-muted">
                          #{s.orderNo} · {at(s.sentAt)}
                        </span>
                      </span>
                      <span className="tabular shrink-0 font-semibold whitespace-nowrap">{dur(s.sec)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            </div>
          </div>
        );
      }}
    </ReportBody>
  );
}

interface ChecksData {
  /** Dönemin bütün adisyonları; `rows` en yenileriyle sınırlı */
  count: number;
  rows: { id: string; no: number; status: string; type: string; place: string | null; openedAt: number; closedAt: number | null; waiter: string | null; qty: number; total: number; methods: string[] }[];
}
type CheckRow = ChecksData['rows'][number];

function ChecksReport({ range, today, onExport, exporting }: { range: Range; today: string; onExport: () => void; exporting: boolean }) {
  const can = useCan();
  const data = useReport<ChecksData>(['checks', range], `/reports/checks?${qs(range)}`);
  // Garsona göre adisyon listesi personel tutarıdır: maliyet yetkisi olmayana sunucu garsonu göndermez
  const withWaiter = can('rapor.maliyet');
  const at = stamper(range);
  // Çok günlü dönemde numaralar her gün baştan başlar: açılış günüyle ayrılır ("26 Eki 23:46 – 00:36")
  const span = (o: CheckRow) => `${at(o.openedAt)}${o.closedAt ? ` – ${fmtTime(o.closedAt)}` : ''}`;
  const place = (o: CheckRow) => o.place ?? TYPE_LABEL[o.type] ?? o.type;
  const waiterCol: Column<CheckRow> = { key: 'garson', header: 'Garson', hideBelow: 'lg', cell: (o) => o.waiter ?? <Dash /> };
  const columns: Column<CheckRow>[] = [
    {
      key: 'no',
      header: 'No',
      className: 'whitespace-nowrap',
      cell: (o) => (
        <span className="inline-flex items-center gap-1.5 font-medium">
          #{o.no}
          {o.status === 'iptal' && <Badge tone="danger">İptal</Badge>}
        </span>
      ),
    },
    { key: 'yer', header: 'Yer', cell: place },
    { key: 'saat', header: range.from === range.to ? 'Saat' : 'Zaman', className: 'whitespace-nowrap', cell: (o) => <span className="text-muted">{span(o)}</span> },
    ...(withWaiter ? [waiterCol] : []),
    { key: 'adet', header: 'Adet', align: 'right', hideBelow: 'lg', cell: (o) => fmtN(o.qty) },
    { key: 'odeme', header: 'Ödeme', cell: (o) => <span className="text-muted">{o.methods.join(', ') || '—'}</span> },
    { key: 'tutar', header: 'Tutar', align: 'right', className: 'whitespace-nowrap', cell: (o) => <span className="font-semibold">{tl(o.total)}</span> },
  ];
  return (
    <ReportBody q={data} skeleton={<TableSkeleton />}>
      {({ rows, count }) => (
        <Card
          flush
          title="Adisyonlar"
          subtitle={count ? (rows.length < count ? `${fmtN(count)} adisyon · ekranda en yeni ${fmtN(rows.length)}, hepsi CSV’de` : `${fmtN(count)} adisyon`) : undefined}
          actions={
            count > 0 ? (
              <Button size="sm" icon={<Download className="size-4" />} loading={exporting} onClick={onExport}>
                CSV
              </Button>
            ) : undefined
          }
          className="overflow-hidden"
        >
          {rows.length === 0 ? (
            <EmptyState compact icon={<ReceiptText />} title={emptyTitle(range, today, 'adisyon')}>
              {emptyHint(range, today, 'Açık adisyonlar kapanınca burada sayılır')}
            </EmptyState>
          ) : (
            <ReportTable
              caption="Adisyonlar"
              rows={rows}
              rowKey={(o) => o.id}
              columns={columns}
              phoneTitle={(o) => (
                <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-1">
                  #{o.no} · {place(o)}
                  {o.status === 'iptal' && <Badge tone="danger">İptal</Badge>}
                </span>
              )}
              phoneMeta={(o) => joinMeta([span(o), `${fmtN(o.qty)} adet`, o.methods.join(', '), withWaiter && o.waiter])}
              phoneAside={(o) => tl(o.total)}
            />
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

/**
 * Platform satırının bir rakamı kartın içindeki karoda (köşe 12, soluk zemin): küçük etiket, rakam (15/600), altında
 * ipucu. Sekiz rakam telefonda da birbirine karışmaz
 */
function Metric({ label, value, hint }: { label: string; value: ReactNode; hint?: string | null }) {
  return (
    <div className="min-w-0 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] px-3 py-2.5">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="tabular mt-0.5 text-[15px] font-semibold text-[var(--admin-text)]">
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
function PlatformsReport({ range, today, onExport, exporting }: { range: Range; today: string; onExport: () => void; exporting: boolean }) {
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
            <EmptyState className={CARD} icon={<Bike />} title={emptyTitle(range, today, 'platform siparişi')}>
              {d.pending > 0 ? `${d.pending} sipariş onay bekliyor; kabul edilip kapanınca burada sayılır` : 'Yemeksepeti, Getir Yemek ve Trendyol Go siparişleri kapandıkça burada toplanır'}
            </EmptyState>
          );
        const max = Math.max(1, ...d.platforms.map((p) => p.revenue));
        const showCost = withCost && d.commission != null;
        const commission: KpiCell = { key: 'komisyon', label: 'Komisyon', icon: <BadgePercent />, value: <KpiAmount value={d.commission ?? 0} />, reference: 'Bugünkü oranla tahmin' };
        // Ciro yeşil, durumsuz sayılar nötr, bekleyen amber (zaman), kaçan pembe (kayıp)
        const cells: KpiCell[] = [
          { key: 'ciro', label: 'Platform cirosu', icon: <Bike />, hue: 'green', value: <KpiAmount value={d.revenue} />, reference: `Toplam ciroda pay %${d.share.toLocaleString('tr-TR')}` },
          { key: 'siparis', label: 'Sipariş', icon: <ReceiptText />, value: fmtN(d.orders), reference: d.orders ? `Ortalama sepet ${tlShort(d.avgBasket)}` : 'Kapanan sipariş yok' },
          ...(showCost ? [commission] : []),
          { key: 'acik', label: 'Açık sipariş', icon: <Clock />, hue: 'amber', value: fmtN(d.open.orders), reference: d.open.orders ? `${tlShort(d.open.amount)} · ciroya girmedi` : 'Hepsi kapandı' },
          { key: 'kacan', label: 'Kaçan sipariş', icon: <XCircle />, hue: 'rose', value: fmtN(d.missed.orders), reference: d.missed.orders ? `Müşteri tutarı ${tlShort(d.missed.amount)}` : 'Ret, süre, iptal ya da kasaya alınmayan yok' },
        ];
        return (
          <div className="space-y-4">
            <KpiStrip cells={cells} />
            {d.pending > 0 && (
              <Notice tone="info" role="status" className="text-[13px]">
                Şu an {d.pending} sipariş onay bekliyor; hiçbir rakama girmedi
              </Notice>
            )}
            <Card
              flush
              title="Platformlara göre"
              subtitle="Kapanmış siparişler, KDV dahil"
              actions={
                <Button size="sm" icon={<Download className="size-4" />} loading={exporting} onClick={onExport}>
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
                    <div aria-hidden="true" className="mt-2 h-2 rounded-[var(--r-track)]" style={{ background: 'var(--chart-track)' }}>
                      <div className="h-2 rounded-[var(--r-track)]" style={{ width: `${p.revenue > 0 ? Math.max(1, (p.revenue / max) * 100) : 0}%`, background: 'var(--chart-accent)' }} />
                    </div>
                    <dl className="mt-3 grid grid-cols-2 gap-2 text-sm sm:grid-cols-3 xl:grid-cols-4">
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
            {/* Sayım kuralları ana akıştan çıkar, açan okur (kitin kurulum notu kalıbı) */}
            <SetupNotes summary="Rakamlar nasıl sayılır">
              <p>Ciro sekmesiyle aynı kural: kapanmış adisyonlar, adisyonun açıldığı iş gününe göre. Tahsilatı platform da yapsa kasa da yapsa sipariş platformun satışıdır.</p>
              <p>
                Kaçan sipariş reddedilen, süresi dolan, iptal edilen ya da platformda kabul edilip 3 saatte kasaya alınmayan siparişlerdir: geldiği iş gününe yazılır, tutarı müşterinin ödeyeceğidir, ciroya
                girmez.
              </p>
              {showCost && (
                <p>
                  Komisyon tahminidir: Yönetim › Paket platformları’ndaki bugünkü oranla KDV dahil cirodan hesaplanır; oran değişirse geçmiş dönemin tahmini de değişir. Gerçek tutar platformun hesap
                  kesimindedir.
                </p>
              )}
            </SetupNotes>
          </div>
        );
      }}
    </ReportBody>
  );
}

interface ItemsData {
  total: number;
  count: number;
  /**
   * `afterBill`: iptal anında hesap yazdırılmıştı (adisyonun hesabının sonradan yazdırılması saymaz). `person`: ödenmezin
   * kimin adına yazıldığı (personel adı maliyet yetkisi olmayana "Personel")
   */
  rows: {
    id: string;
    at: number;
    orderNo: number;
    place: string;
    name: string;
    size: string;
    qty: number;
    value: number;
    reason: string | null;
    compKind: CompKind | null;
    person: { kind: CompPersonKind; name: string } | null;
    by: string | null;
    approvedBy: string | null;
    afterSend: boolean;
    afterBill: boolean;
  }[];
  /** Kişi bazında ödenmez (yalnız ikram listesinde): kişi, adet, tutar */
  odenmezPeople: OdenmezPersonDTO[];
}

/** Ödenmez kişisinin türü sözle: tablo ve satır kartı */
const personKindLabel = (kind: CompPersonKind | null) => (kind === 'customer' ? 'Müşteri' : kind === 'user' ? 'Personel' : 'Eski kayıt');
type ItemRow = ItemsData['rows'][number];
type ItemKind = 'iptal' | 'ikram' | 'indirim' | 'happy';

const ITEM_TITLES: Record<ItemKind, string> = { iptal: 'İptal edilen kalemler', ikram: 'İkram, ödenmez ve zayi kalemleri', indirim: 'İndirimler', happy: 'Happy hour satışları' };
/** Boş dönemde türü söyleyen tek cümlenin öznesi ("Bu dönemde iptal edilen kalem yok"); başlıkta "0 kayıt" tekrarlanmaz */
const ITEM_EMPTY: Record<ItemKind, string> = { iptal: 'iptal edilen kalem', ikram: 'ikram, ödenmez ya da zayi', indirim: 'indirim', happy: 'happy hour satışı' };

/** Kalemin adı ve türü: ikramın türü (ödenmez, zayi) nötr, geç iptal kırmızı rozetle, adın altında */
function ItemName({ r, kind, size }: { r: ItemRow; kind: ItemKind; size: string | null }) {
  const comp = r.compKind && r.compKind !== 'ikram' ? COMP_LABEL[r.compKind] : null;
  const late = kind === 'iptal' && (r.afterSend || r.afterBill) ? (r.afterBill ? 'Hesaptan sonra' : 'Hazırlandıktan sonra') : null;
  return (
    <>
      <span className="font-medium">
        {r.qty}× {r.name}
      </span>
      <SizeTag>{size}</SizeTag>
      {(comp || late) && (
        <span className="mt-1 flex flex-wrap items-center gap-1">
          {comp && <Badge tone="neutral">{comp}</Badge>}
          {/* Ödenmezin kişisi: "Garson adına" */}
          {r.person && <span className="text-xs text-ink-2">{r.person.name} adına</span>}
          {late && <Badge tone="danger">{late}</Badge>}
        </span>
      )}
    </>
  );
}

/** Kişi bazında ödenmez: kimin adına kaç adet, ne tutarda (personel yemeği, patron hesabı, müşteri) */
function OdenmezPeopleCard({ rows }: { rows: OdenmezPersonDTO[] }) {
  const sum = rows.reduce((a, r) => ({ qty: a.qty + r.qty, amount: a.amount + r.amount }), { qty: 0, amount: 0 });
  const columns: Column<OdenmezPersonDTO>[] = [
    { key: 'kisi', header: 'Kişi', cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'tur', header: 'Tür', cell: (r) => <span className="text-ink-2">{personKindLabel(r.kind)}</span> },
    { key: 'adet', header: 'Adet', align: 'right', cell: (r) => fmtN(r.qty) },
    { key: 'tutar', header: 'Tutar', align: 'right', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold">{tl(r.amount)}</span> },
  ];
  return (
    <Card flush title="Kişi bazında ödenmez" subtitle={`${rows.length} kişi · ${fmtN(sum.qty)} adet · ${tl(sum.amount)}`} className="overflow-hidden">
      <ReportTable
        caption="Kişi bazında ödenmez"
        rows={rows}
        rowKey={(r) => `${r.kind ?? 'yok'}:${r.id ?? r.name}`}
        columns={columns}
        foot={rows.length > 1 ? { cells: { kisi: 'Toplam', adet: fmtN(sum.qty), tutar: tl(sum.amount) }, phoneMeta: `${fmtN(sum.qty)} adet`, phoneAside: tl(sum.amount) } : undefined}
        phoneTitle={(r) => r.name}
        phoneMeta={(r) => joinMeta([personKindLabel(r.kind), `${fmtN(r.qty)} adet`])}
        phoneAside={(r) => tl(r.amount)}
      />
    </Card>
  );
}

function ItemsReport({ range, today, kind, onExport, exporting }: { range: Range; today: string; kind: ItemKind; onExport?: () => void; exporting?: boolean }) {
  const sizeName = useSizeName();
  const data = useReport<ItemsData>(['items', kind, range], `/reports/items?kind=${kind}&${qs(range)}`);
  const at = stamper(range);
  // Happy hour'da neden hep "Happy hour" (sütun düşer), kişi kalemi satan, tutar verilen indirim
  const happy = kind === 'happy';
  const reasonCol: Column<ItemRow> = { key: 'neden', header: 'Neden', cell: (r) => <span className="text-ink-2">{r.reason ?? '—'}</span> };
  const columns: Column<ItemRow>[] = [
    { key: 'zaman', header: range.from === range.to ? 'Saat' : 'Zaman', className: 'whitespace-nowrap', cell: (r) => <span className="text-muted">{at(r.at)}</span> },
    {
      key: 'adisyon',
      header: 'Adisyon',
      hideBelow: 'lg',
      className: 'whitespace-nowrap',
      cell: (r) => (
        <>
          #{r.orderNo} <span className="text-muted">{r.place}</span>
        </>
      ),
    },
    { key: 'urun', header: 'Ürün', cell: (r) => <ItemName r={r} kind={kind} size={sizeName(r.size)} /> },
    ...(happy ? [] : [reasonCol]),
    {
      key: 'yapan',
      header: happy ? 'Satan' : 'Yapan',
      cell: (r) => (
        <>
          {r.by ?? '—'}
          {r.approvedBy && <span className="block text-xs text-muted">onay: {r.approvedBy}</span>}
        </>
      ),
    },
    { key: 'tutar', header: happy ? 'İndirim' : 'Tutar', align: 'right', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold">{tl(r.value)}</span> },
  ];
  return (
    <ReportBody q={data} skeleton={<TableSkeleton rows={6} />}>
      {(d) => (
        <div className="space-y-3">
          <Card
            flush
            title={ITEM_TITLES[kind]}
            subtitle={d.count ? (happy ? `${fmtN(d.count)} kalem · verilen indirim ${tl(d.total)}` : `${fmtN(d.count)} kayıt · ${tl(d.total)}`) : undefined}
            actions={
              onExport && d.count > 0 ? (
                <Button size="sm" icon={<Download className="size-4" />} loading={exporting} onClick={onExport}>
                  CSV
                </Button>
              ) : undefined
            }
            className="overflow-hidden"
          >
            {d.rows.length === 0 ? (
              <EmptyState compact icon={happy ? <BadgePercent /> : <ReceiptText />} title={emptyTitle(range, today, ITEM_EMPTY[kind], false)} />
            ) : (
              <ReportTable
                caption={ITEM_TITLES[kind]}
                rows={d.rows}
                rowKey={(r) => r.id}
                columns={columns}
                phoneTitle={(r) => <ItemName r={r} kind={kind} size={sizeName(r.size)} />}
                phoneMeta={(r) => joinMeta([at(r.at), `#${r.orderNo} ${r.place}`, !happy && r.reason, r.by && (r.approvedBy ? `${r.by} (onay: ${r.approvedBy})` : r.by)])}
                phoneAside={(r) => tl(r.value)}
              />
            )}
          </Card>
          {kind === 'ikram' && d.odenmezPeople.length > 0 && <OdenmezPeopleCard rows={d.odenmezPeople} />}
        </div>
      )}
    </ReportBody>
  );
}

interface RefundsData {
  total: number;
  count: number;
  rows: { id: string; at: number; orderNo: number | null; method: string; amount: number; reason: string | null; by: string | null }[];
}

/** Ödeme iptalleri: kardeş sekmeleriyle (iptal, ikram, indirim) aynı tablo */
function RefundsReport({ range, today }: { range: Range; today: string }) {
  const data = useReport<RefundsData>(['refunds', range], `/reports/refunds?${qs(range)}`);
  const at = stamper(range);
  return (
    <ReportBody q={data} skeleton={<TableSkeleton rows={4} />}>
      {(d) => (
        <Card flush title="Ödeme iptalleri" subtitle={d.count ? `${fmtN(d.count)} ödeme · ${tl(d.total)}` : undefined} className="overflow-hidden">
          {d.rows.length === 0 ? (
            <EmptyState compact icon={<CreditCard />} title={emptyTitle(range, today, 'ödeme iptali', false)} />
          ) : (
            <ReportTable
              caption="Ödeme iptalleri"
              rows={d.rows}
              rowKey={(r) => r.id}
              columns={[
                { key: 'zaman', header: range.from === range.to ? 'Saat' : 'Zaman', className: 'whitespace-nowrap', cell: (r) => <span className="text-muted">{at(r.at)}</span> },
                { key: 'adisyon', header: 'Adisyon', className: 'whitespace-nowrap', cell: (r) => (r.orderNo != null ? `#${r.orderNo}` : <Dash />) },
                { key: 'odeme', header: 'Ödeme türü', cell: (r) => r.method },
                { key: 'neden', header: 'Neden', cell: (r) => <span className="text-ink-2">{r.reason ?? '—'}</span> },
                { key: 'yapan', header: 'Yapan', hideBelow: 'lg', cell: (r) => r.by ?? <Dash /> },
                { key: 'tutar', header: 'Tutar', align: 'right', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold">{tl(r.amount)}</span> },
              ]}
              phoneTitle={(r) => `${r.method}${r.orderNo != null ? ` · #${r.orderNo}` : ''}`}
              phoneMeta={(r) => joinMeta([at(r.at), r.reason, r.by])}
              phoneAside={(r) => tl(r.amount)}
            />
          )}
        </Card>
      )}
    </ReportBody>
  );
}

interface StaffRow {
  userId: string;
  name: string;
  orders: number;
  revenue: number;
  voids: number;
  voidValue: number;
  comps: number;
  compValue: number;
  discounts: number;
  /** Çalışanın adına yazılan ödenmez (personel yemeği, patron hesabı): adet ve menü değeri */
  odenmez: number;
  odenmezValue: number;
}

/** Tutar önde, adet altında (sunucu iptal ve ikramı adetle sayar: İptal ve indirim sekmesindeki kayıt sayısından farklı) */
const valueWithUnits = (value: number, units: number) =>
  value ? (
    <>
      {tl(value)}
      <span className="block text-xs font-normal text-muted">{fmtN(units)} adet</span>
    </>
  ) : (
    <Dash />
  );

function StaffReport({ range, today }: { range: Range; today: string }) {
  const data = useReport<{ staff: StaffRow[] }>(['staff', range], `/reports/staff?${qs(range)}`);
  const avg = (r: { orders: number; revenue: number }) => (r.orders ? tl(Math.round(r.revenue / r.orders)) : <Dash />);
  // Satır kartı (telefon ve tablet) tablonun bütün tutarlarını taşır: ortalama ve indirim de
  const cardMeta = (r: Omit<StaffRow, 'userId' | 'name'>) =>
    joinMeta([
      `${fmtN(r.orders)} adisyon`,
      r.orders > 0 && `ortalama ${tl(Math.round(r.revenue / r.orders))}`,
      r.voidValue > 0 && `iptal ${tl(r.voidValue)}`,
      r.compValue > 0 && `ikram ve zayi ${tl(r.compValue)}`,
      r.discounts > 0 && `indirim ${tl(r.discounts)}`,
      r.odenmezValue > 0 && `adına ödenmez ${tl(r.odenmezValue)}`,
    ]);
  const columns: Column<StaffRow>[] = [
    { key: 'ad', header: 'Personel', cell: (r) => <span className="font-medium">{r.name}</span> },
    { key: 'adisyon', header: 'Adisyon', align: 'right', cell: (r) => fmtN(r.orders) },
    { key: 'ciro', header: 'Ciro', align: 'right', className: 'whitespace-nowrap', cell: (r) => <span className="font-semibold">{tl(r.revenue)}</span> },
    { key: 'ortalama', header: 'Ortalama', align: 'right', hideBelow: 'lg', className: 'whitespace-nowrap', cell: avg },
    { key: 'indirim', header: 'İndirim', align: 'right', hideBelow: 'lg', className: 'whitespace-nowrap', cell: (r) => (r.discounts ? tl(r.discounts) : <Dash />) },
    { key: 'iptal', header: 'İptal', align: 'right', className: 'whitespace-nowrap', cell: (r) => valueWithUnits(r.voidValue, r.voids) },
    { key: 'ikram', header: 'İkram ve zayi', align: 'right', className: 'whitespace-nowrap', cell: (r) => valueWithUnits(r.compValue, r.comps) },
    { key: 'odenmez', header: 'Adına ödenmez', align: 'right', className: 'whitespace-nowrap', cell: (r) => valueWithUnits(r.odenmezValue, r.odenmez) },
  ];
  return (
    <ReportBody q={data} skeleton={<TableSkeleton rows={5} />}>
      {({ staff: rows }) => {
        const sum = rows.reduce(
          (a, r) => ({
            orders: a.orders + r.orders,
            revenue: a.revenue + r.revenue,
            voids: a.voids + r.voids,
            voidValue: a.voidValue + r.voidValue,
            comps: a.comps + r.comps,
            compValue: a.compValue + r.compValue,
            discounts: a.discounts + r.discounts,
            odenmez: a.odenmez + r.odenmez,
            odenmezValue: a.odenmezValue + r.odenmezValue,
          }),
          { orders: 0, revenue: 0, voids: 0, voidValue: 0, comps: 0, compValue: 0, discounts: 0, odenmez: 0, odenmezValue: 0 },
        );
        return (
          <Card flush title="Personel" subtitle={rows.length ? 'Ciro ve indirim garsona, iptal ve ikram işlemi yapana, ödenmez adına yazılana' : undefined} className="overflow-hidden">
            {rows.length === 0 ? (
              <EmptyState compact icon={<Users />} title={emptyTitle(range, today, 'personel satışı')}>
                {emptyHint(range, today, 'Açık adisyonlar kapanınca burada sayılır')}
              </EmptyState>
            ) : (
              <ReportTable
                caption="Personel"
                rows={rows}
                rowKey={(r) => r.userId}
                columns={columns}
                foot={
                  rows.length > 1
                    ? {
                        cells: {
                          adisyon: fmtN(sum.orders),
                          ciro: tl(sum.revenue),
                          ortalama: avg(sum),
                          indirim: sum.discounts ? tl(sum.discounts) : <Dash />,
                          iptal: valueWithUnits(sum.voidValue, sum.voids),
                          ikram: valueWithUnits(sum.compValue, sum.comps),
                          odenmez: valueWithUnits(sum.odenmezValue, sum.odenmez),
                        },
                        phoneMeta: cardMeta(sum),
                        phoneAside: tl(sum.revenue),
                      }
                    : undefined
                }
                phoneTitle={(r) => r.name}
                phoneMeta={cardMeta}
                phoneAside={(r) => tl(r.revenue)}
              />
            )}
          </Card>
        );
      }}
    </ReportBody>
  );
}

const SETUP = ADMIN_SECTIONS.find((s) => s.key === 'entegrasyon');

/**
 * Elle yedek: lafmaliyet Satışlar ekranına yüklenen liste. Bağlantı kuruluyken günler gün sonunda gider; liste
 * yalnız bağlantı yokken ya da lafmaliyet'teki geçiş gününden önceki aylar için (yoksa aynı satış iki kez sayılır)
 */
function ExportReport({ range, linked, onDownload, downloading }: { range: Range; linked: boolean; onDownload: () => void; downloading: boolean }) {
  const can = useCan();
  // Kurulum belge yolu değil, bağlantının kurulduğu ekran: yalnız o ekranı açabilene bağlantı
  const setup = SETUP && SETUP.perm.some((p) => can(p)) ? SETUP : null;
  return (
    <Card
      title="lafmaliyet aktarımı"
      subtitle={
        <>
          Seçili dönemin ürün satış listesi, lafmaliyet’in <span className="font-medium text-[var(--admin-text-soft)]">Satışlar</span> ekranının okuduğu biçimde iner
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {/* Listenin biçimi bir bakışta: dönem, sütunlar, girmeyenler, ayrı satır; ince kenarlı karoda (köşe 12), geniş
            ekranda etiket solda sabit sütunda, telefonda değerin üstünde */}
        <dl className="divide-y divide-[var(--admin-divider)] rounded-[var(--r-tile)] border border-line">
          {[
            ['Dönem', rangeLabel(range)],
            ['Sütunlar', 'Ürün; Adet; Tutar (KDV dahil)'],
            ['Listeye girmez', 'İkram, iptal ve sitede ödenmiş online siparişler'],
            ['Ayrı satır', 'Ekstra shot, şurup ve alternatif süt'],
          ].map(([term, text]) => (
            <div key={term} className="grid gap-0.5 px-3 py-2.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-3 sm:px-4">
              <dt className="text-[13px] text-muted">{term}</dt>
              <dd className="text-[var(--admin-text)]">{text}</dd>
            </div>
          ))}
        </dl>
        {linked && (
          <Notice tone="warn">
            lafmaliyet bağlantısı kurulu: günler gün sonunda kendiliğinden gidiyor. Bu liste yalnız bağlantı yokken ya da lafmaliyet’teki geçiş gününden önceki aylar için; geçiş gününden sonraki günleri Satışlar’a yüklemeyin, aynı satış iki kez sayılır
          </Notice>
        )}
        {/* Dönem düğmenin adında kalır (ekran okuyucu), görünürde yukarıdaki satırda: uzun dönem adı telefonda düğmeyi
            karttan taşırıyordu. Telefonda düğme tam genişlikte, halka sağda */}
        <Button variant="primary" icon={<FileSpreadsheet className="size-4" />} loading={downloading} onClick={onDownload} className="max-sm:w-full max-sm:justify-between">
          Satış listesini indir<span className="sr-only"> ({rangeLabel(range)})</span>
        </Button>
        {!linked && (
          <p className="text-xs text-muted">
            lafmaliyet bağlantısı kurulunca günlük Z ve satış verisi gün sonunda kendiliğinden gider
            {setup && (
              <>
                ; bağlantı{' '}
                <Link to={setup.to} className="font-medium text-[var(--admin-primary)] underline-offset-2 hover:underline">
                  Yönetim › {setup.label}
                </Link>
                ’ten kurulur
              </>
            )}
          </p>
        )}
      </div>
    </Card>
  );
}
