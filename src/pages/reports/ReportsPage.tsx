import { useQuery } from '@tanstack/react-query';
import { ArrowDownRight, ArrowUpRight, BadgePercent, CircleDollarSign, Download, FileSpreadsheet, Package, Receipt, Search, ShoppingBag } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { tl } from '@shared/money';
import { fmtDateTime, fmtTime } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Button } from '@/components/ui/Button';
import { AdminShell } from '@/components/admin/AdminShell';
import { Card, KpiStrip, PageHeader, Segmented, StatusTabs } from '@/components/admin/ui';
import { EmptyState, PageLoading, Stat } from '@/components/ui/misc';
import { errorMessage, get, getToken } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useLocalPref } from '@/lib/hooks';
import { fmtShortDate, PERIOD_LABELS, type PeriodKey, periodRange, rangeLabel } from '@/lib/period';

type ReportKey = 'ciro' | 'satis' | 'kategori' | 'saatlik' | 'hazirlama' | 'adisyon' | 'iptal' | 'ikram' | 'indirim' | 'happy' | 'iade' | 'personel' | 'aktarim';

const REPORTS: { key: ReportKey; label: string; hint: string; perm?: 'rapor.maliyet' }[] = [
  { key: 'ciro', label: 'Ciro', hint: 'Gelir özeti ve önceki dönem' },
  { key: 'satis', label: 'Satış', hint: 'Ürün bazında' },
  { key: 'kategori', label: 'Kategori', hint: 'Kategori payları' },
  { key: 'saatlik', label: 'Saatlik', hint: 'Yoğun saatler, gün dilimleri' },
  { key: 'hazirlama', label: 'Hazırlama süresi', hint: 'Bar ve mutfak hızı' },
  { key: 'adisyon', label: 'Adisyonlar', hint: 'Kapanan ve iptal' },
  { key: 'iptal', label: 'İptaller', hint: 'Silinen kalemler' },
  { key: 'ikram', label: 'İkramlar', hint: 'Ciro dışı' },
  { key: 'indirim', label: 'İndirimler', hint: 'Kalem ve adisyon' },
  { key: 'happy', label: 'Happy hour', hint: 'Kampanya etkisi' },
  { key: 'iade', label: 'Ödeme iptalleri', hint: 'İade edilen ödemeler' },
  { key: 'personel', label: 'Personel', hint: 'Satış, iptal, ikram', perm: 'rapor.maliyet' },
  { key: 'aktarim', label: 'lafmaliyet aktarımı', hint: 'Satışlar listesi' },
];

export default function ReportsPage() {
  const can = useCan();
  const [report, setReport] = useLocalPref<ReportKey>('reports.key', 'ciro');
  const [period, setPeriod] = useLocalPref<PeriodKey>('reports.period', 'bugun');
  const [custom, setCustom] = useState(() => periodRange('hafta'));
  const range = period === 'ozel' ? custom : periodRange(period);
  const visible = REPORTS.filter((r) => !r.perm || can(r.perm));
  const current = visible.find((r) => r.key === report) ?? visible[0];

  const exportCsv = async (type: string, path = `/api/reports/export.csv?type=${type}&from=${range.from}&to=${range.to}`) => {
    const res = await fetch(path, { headers: { authorization: `Bearer ${getToken()}` } });
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
            options={(Object.keys(PERIOD_LABELS) as PeriodKey[]).map((k) => ({ value: k, label: PERIOD_LABELS[k] }))}
            className="max-sm:w-full"
          />
        }
      >
        {period === 'ozel' && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--admin-text-mute)]">Başlangıç</span>
              <input type="date" value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} className="h-11 rounded-lg border border-line-strong bg-surface px-2 pointer-fine:h-9" />
            </label>
            <label className="flex items-center gap-1.5">
              <span className="text-[var(--admin-text-mute)]">Bitiş</span>
              <input type="date" value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} className="h-11 rounded-lg border border-line-strong bg-surface px-2 pointer-fine:h-9" />
            </label>
          </div>
        )}
      </PageHeader>
      <StatusTabs label="Rapor" value={current.key} onChange={setReport} tabs={visible.map((r) => ({ value: r.key, label: r.label }))} />
      {current.key === 'ciro' && <SummaryReport range={range} />}
      {current.key === 'satis' && <ProductsReport range={range} onExport={() => exportCsv('urunler')} />}
      {current.key === 'kategori' && <CategoryReport range={range} />}
      {current.key === 'saatlik' && <HourlyReport range={range} onExport={() => exportCsv('saatlik')} />}
      {current.key === 'hazirlama' && <PrepReport range={range} />}
      {current.key === 'adisyon' && <ChecksReport range={range} onExport={() => exportCsv('adisyonlar')} />}
      {(current.key === 'iptal' || current.key === 'ikram' || current.key === 'indirim' || current.key === 'happy') && (
        <ItemsReport range={range} kind={current.key} onExport={current.key === 'happy' ? undefined : () => exportCsv(current.key)} />
      )}
      {current.key === 'iade' && <RefundsReport range={range} />}
      {current.key === 'personel' && <StaffReport range={range} />}
      {current.key === 'aktarim' && <ExportReport range={range} onDownload={() => exportCsv('', `/api/sync/lafmaliyet/satislar.csv?from=${range.from}&to=${range.to}`)} />}
    </AdminShell>
  );
}

type Range = { from: string; to: string };
const qs = (r: Range) => `from=${r.from}&to=${r.to}`;

function Delta({ value }: { value: number | null }) {
  if (value == null) return <span className="text-muted">önceki dönem yok</span>;
  const up = value >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 font-medium', up ? 'text-brand-500' : 'text-danger-500')}>
      {up ? <ArrowUpRight className="size-3.5" /> : <ArrowDownRight className="size-3.5" />}%{Math.abs(value).toLocaleString('tr-TR')} önceki döneme göre
    </span>
  );
}

interface Summary {
  netSales: number;
  gross: number;
  discounts: number;
  complimentary: number;
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
  previous: { netSales: number; receipts: number; change: number | null; label: string };
  asOf: number;
  waterfall: { list: number; complimentary: number; discounts: number; service: number; revenue: number; kdv: number; netExKdv: number };
  kdv: { rate: number; gross: number; base: number; kdv: number }[];
  reconciliation: { paidClosed: number; difference: number; paidOpen: number };
  perGuest: number | null;
}

const TYPE_LABEL: Record<string, string> = ORDER_TYPE_LABEL;

/** Rapor alınamadı: sıfır ya da "satış yok" gösterilmez (yanlış rakam gibi okunur), neden ve yeniden dene */
function ReportError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  return (
    <div role="alert" className="rounded-xl border border-[var(--admin-danger-soft)] bg-[var(--admin-danger-soft)] p-4 text-sm text-[var(--admin-danger-ink)]">
      <p className="font-semibold">Rapor alınamadı; rakamlar gösterilmiyor</p>
      <p className="mt-1">{errorMessage(error)}</p>
      <Button size="sm" className="mt-3" onClick={onRetry}>
        Yeniden dene
      </Button>
    </div>
  );
}

function SummaryReport({ range }: { range: Range }) {
  const q = useQuery({ queryKey: ['reports', 'summary', range], queryFn: () => get<Summary>(`/reports/summary?${qs(range)}`) });
  const hourly = useQuery({ queryKey: ['reports', 'hourly', range], queryFn: () => get<HourlyData>(`/reports/hourly?${qs(range)}`), enabled: range.from === range.to });
  if (q.isLoading) return <PageLoading />;
  if (q.isError) return <ReportError error={q.error} onRetry={() => void q.refetch()} />;
  const s = q.data;
  if (!s) return null;
  return (
    <div className="space-y-4">
      <KpiStrip
        cells={[
          {
            key: 'ciro',
            label: 'Ciro (KDV dahil)',
            icon: <CircleDollarSign />,
            hue: 'blue',
            value: tl(s.netSales),
            delta: s.previous.change == null ? null : { text: `${s.previous.change >= 0 ? '▲' : '▼'} %${Math.abs(s.previous.change).toLocaleString('tr-TR')}`, good: s.previous.change >= 0 },
            reference: s.previous.change == null ? `Kıyas (${s.previous.label}) satışsız` : `${s.previous.label}: ${tl(s.previous.netSales)}`,
          },
          { key: 'adisyon', label: 'Adisyon', icon: <Receipt />, hue: 'violet', value: s.receipts.toLocaleString('tr-TR'), reference: `Ortalama ${tl(s.avgCheck)}${s.perGuest != null ? ` · kişi başı ${tl(s.perGuest)}` : ''} · önceki ${s.previous.receipts}` },
          { key: 'urun', label: 'Satılan ürün', icon: <Package />, hue: 'amber', value: s.itemsSold.toLocaleString('tr-TR'), reference: s.days > 1 ? `${s.days} iş günü` : 'Tek iş günü' },
          { key: 'indirim', label: 'İndirim ve ikram', icon: <BadgePercent />, hue: 'rose', value: tl(s.discounts + s.complimentary), reference: `İndirim ${tl(s.discounts)} · ikram ${tl(s.complimentary)} · iptal ${tl(s.voided)}` },
          { key: 'online', label: 'Online (sitede ödendi)', icon: <ShoppingBag />, hue: 'green', value: tl(s.online.amount), reference: `${s.online.orders} sipariş, ciroya dahil değil` },
        ]}
      />
      <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card flush title={range.from === range.to ? 'Saatlik ciro' : 'Günlük ciro'}>
          <div className="p-4">
            {range.from === range.to ? (
              hourly.data && <ColumnChart data={hourly.data.hours.map((h) => ({ label: String(h.hour).padStart(2, '0'), value: h.revenue }))} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro" />
            ) : (
              <ColumnChart data={s.byDay.map((d) => ({ label: fmtShortDate(d.date), value: d.netSales }))} format={tl} seriesLabel="Ciro" ariaLabel="Günlük ciro" />
            )}
          </div>
        </Card>
        <Card flush title="Ödeme türleri">
          <div className="p-4">
            {s.payments.length ? <BarList items={s.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.count} işlem` }))} format={tl} /> : <p className="text-sm text-muted">Ödeme yok</p>}
            {s.tips > 0 && <p className="mt-3 text-xs text-muted">Bahşiş {tl(s.tips)} (ciro dışı)</p>}
          </div>
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card flush title="Ciro dökümü" subtitle="Kapanmış adisyonlar; iptaller düşülmez, bilgi olarak">
          <dl className="divide-y divide-[var(--admin-divider)] text-sm">
            {[
              ['Liste değeri', s.waterfall.list, false],
              ['İkram', -s.waterfall.complimentary, false],
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
              <dt>İptal edilen (bilgi)</dt>
              <dd className="tabular">{tl(s.voided)}</dd>
            </div>
          </dl>
        </Card>
        <Card flush title="KDV oranlarına göre" subtitle="Matrah + KDV = ciro">
          <dl className="divide-y divide-[var(--admin-divider)] text-sm">
            {s.kdv.length === 0 && <p className="px-4 py-3 text-muted">Bu dönemde satış yok</p>}
            {s.kdv.map((k) => (
              <div key={k.rate} className="grid grid-cols-[4rem_1fr_1fr_1fr] gap-2 px-4 py-2.5">
                <dt className="font-medium">%{k.rate}</dt>
                <dd className="tabular text-right text-muted">{tl(k.base)}</dd>
                <dd className="tabular text-right text-muted">{tl(k.kdv)}</dd>
                <dd className="tabular text-right font-medium">{tl(k.gross)}</dd>
              </div>
            ))}
          </dl>
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
          <BarList items={s.types.map((t) => ({ key: t.type, label: TYPE_LABEL[t.type] ?? t.type, value: t.amount, sub: `${t.orders} adisyon` }))} format={tl} />
        </div>
      </Card>
    </div>
  );
}

interface ProductsData {
  total: number;
  /** Ürüne ait olmayan servis ücreti; ürün cirosu + servis = toplam ciro */
  service: number;
  products: { key: string; name: string; size: string; category: string; qty: number; revenue: number; share: number; avgPrice: number; complimentary: number; voided: number; cost: number | null; margin: number | null }[];
  categories: { name: string; qty: number; revenue: number; share: number }[];
}

function ProductsReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const can = useCan();
  const [q, setQ] = useState('');
  const data = useQuery({ queryKey: ['reports', 'products', range], queryFn: () => get<ProductsData>(`/reports/products?${qs(range)}`) });
  const rows = useMemo(() => (data.data?.products ?? []).filter((p) => p.name.toLocaleLowerCase('tr-TR').includes(q.toLocaleLowerCase('tr-TR'))), [data.data, q]);
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const max = Math.max(1, ...rows.map((r) => r.revenue));
  const withCost = can('rapor.maliyet');
  return (
    <Card flush
      title={`Ürün satışları · ${tl(data.data?.total ?? 0)}${data.data?.service ? ` · servis ücreti ${tl(data.data.service)} ayrı` : ''}`}
      actions={
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara" className="h-9 w-40 rounded-lg border border-line bg-surface pl-8 pr-2 text-sm" />
          </div>
          <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>
            CSV
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="Bu dönemde satış yok" />
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
                    {(p.complimentary > 0 || p.voided > 0) && (
                      <span className="block text-xs font-normal text-muted">
                        {p.complimentary > 0 && `${p.complimentary} ikram `}
                        {p.voided > 0 && `${p.voided} iptal`}
                      </span>
                    )}
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
      {withCost && <p className="px-4 pb-3 text-xs text-muted">Brüt kâr: KDV hariç ciro − lafmaliyet reçete maliyeti. Maliyetler Yönetim › Entegrasyon'dan çekilir</p>}
    </Card>
  );
}

function CategoryReport({ range }: { range: Range }) {
  const data = useQuery({ queryKey: ['reports', 'products', range], queryFn: () => get<ProductsData>(`/reports/products?${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const cats = data.data?.categories ?? [];
  return (
    <Card flush title="Kategori payları">
      <div className="p-4">
        {cats.length ? <BarList items={cats.map((c) => ({ key: c.name, label: c.name, value: c.revenue, sub: `%${c.share.toLocaleString('tr-TR')} · ${c.qty} adet` }))} format={tl} /> : <p className="text-sm text-muted">Bu dönemde satış yok</p>}
      </div>
    </Card>
  );
}

interface HourlyData {
  total: number;
  days: number;
  hours: { hour: number; revenue: number; orders: number }[];
  parts: { key: string; label: string; revenue: number; orders: number; share: number }[];
  busiest: { hour: number; revenue: number; orders: number } | null;
  quietest: { hour: number; revenue: number; orders: number } | null;
  peaks: { hour: number; revenue: number; orders: number }[];
}

function HourlyReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const data = useQuery({ queryKey: ['reports', 'hourly', range], queryFn: () => get<HourlyData>(`/reports/hourly?${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const h = data.data;
  if (!h) return null;
  const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Toplam" value={tl(h.total)} hint={`${h.hours.filter((x) => x.orders).length} aktif saat`} />
        <Stat label="En yoğun saat" value={h.busiest ? hh(h.busiest.hour) : '—'} hint={h.busiest ? `${tl(h.busiest.revenue)} · ${h.busiest.orders} adisyon` : undefined} />
        <Stat label="En sakin saat" value={h.quietest ? hh(h.quietest.hour) : '—'} hint={h.quietest ? `${tl(h.quietest.revenue)} · ${h.quietest.orders} adisyon` : undefined} />
        <Stat label="Gün sayısı" value={String(h.days)} />
      </div>
      <Card flush title="24 saat dağılımı · adisyonun açıldığı saate göre" actions={<Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>CSV</Button>}>
        <div className="p-4">
          <ColumnChart data={h.hours.map((x) => ({ label: String(x.hour).padStart(2, '0'), value: x.revenue }))} format={tl} seriesLabel="Ciro" ariaLabel="Saatlik ciro dağılımı" />
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card flush title="Gün dilimleri">
          <div className="p-4">
            <BarList items={h.parts.map((p) => ({ key: p.key, label: p.label, value: p.revenue, sub: `%${p.share.toLocaleString('tr-TR')} · ${p.orders} adisyon` }))} format={tl} />
            <p className="mt-3 text-xs text-muted">Sabah 06-12 · Öğle 12-17 · Akşam 17-22 · Gece 22-06</p>
          </div>
        </Card>
        <Card flush title="Pik saatler">
          <ol className="divide-y divide-line">
            {h.peaks.map((p, i) => (
              <li key={p.hour} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                <span className="grid size-7 place-items-center rounded-full bg-surface-3 text-xs font-semibold">{i + 1}</span>
                <span className="tabular flex-1 font-medium">
                  {hh(p.hour)} – {String(p.hour).padStart(2, '0')}:59
                </span>
                <span className="text-muted">{p.orders} adisyon</span>
                <span className="tabular w-24 text-right font-semibold">{tl(p.revenue)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </div>
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
  const data = useQuery({ queryKey: ['reports', 'prep', range], queryFn: () => get<PrepData>(`/reports/prep?${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const p = data.data;
  if (!p) return null;
  if (!p.overall.count) return <EmptyState title="Bu dönemde hazırlanan kalem yok">Bar ve mutfak ekranında "Hazır"a basılan kalemler burada sayılır</EmptyState>;
  const hh = (n: number) => `${String(n).padStart(2, '0')}:00`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Ortalama" value={dur(p.overall.avg)} hint={`${p.overall.count} kalem`} />
        <Stat label="Ortanca" value={dur(p.overall.median)} hint="Kalemlerin yarısı bundan kısa" />
        <Stat label="En yavaş %10" value={dur(p.overall.p90)} hint="Bu süreyi aşan her 10 kalemden biri" />
        <Stat label="En uzun" value={dur(p.overall.max)} />
      </div>
      <Card flush title="Saate göre ortalama süre">
        <div className="p-4">
          <ColumnChart data={p.hours.map((x) => ({ label: String(x.hour).padStart(2, '0'), value: x.avg }))} format={dur} seriesLabel="Ortalama süre" ariaLabel="Saate göre ortalama hazırlama süresi" />
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
  );
}

interface ChecksData {
  rows: { id: string; no: number; status: string; type: string; place: string | null; openedAt: number; closedAt: number | null; waiter: string | null; qty: number; total: number; methods: string[] }[];
}

function ChecksReport({ range, onExport }: { range: Range; onExport: () => void }) {
  const data = useQuery({ queryKey: ['reports', 'checks', range], queryFn: () => get<ChecksData>(`/reports/checks?${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const rows = data.data?.rows ?? [];
  return (
    <Card flush title={`Adisyonlar (${rows.length})`} actions={<Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>CSV</Button>}>
      {rows.length === 0 ? (
        <EmptyState title="Bu dönemde adisyon yok" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2">No</th>
                <th className="px-2 py-2">Yer</th>
                <th className="px-2 py-2">Saat</th>
                <th className="px-2 py-2">Garson</th>
                <th className="px-2 py-2 text-right">Adet</th>
                <th className="px-2 py-2">Ödeme</th>
                <th className="px-4 py-2 text-right">Tutar</th>
              </tr>
            </thead>
            <tbody className="tabular">
              {rows.map((o) => (
                <tr key={o.id} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">
                    #{o.no} {o.status === 'iptal' && <span className="ml-1 rounded bg-danger-100 px-1.5 text-xs text-danger-600">iptal</span>}
                  </td>
                  <td className="px-2 py-2">{o.place ?? TYPE_LABEL[o.type] ?? o.type}</td>
                  <td className="px-2 py-2 text-muted">
                    {fmtTime(o.openedAt)}
                    {o.closedAt && ` – ${fmtTime(o.closedAt)}`}
                  </td>
                  <td className="px-2 py-2">{o.waiter ?? '—'}</td>
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
  );
}

interface ItemsData {
  total: number;
  count: number;
  rows: { id: string; at: number; orderNo: number; place: string; name: string; size: string; qty: number; value: number; reason: string | null; by: string | null; approvedBy: string | null; afterSend: boolean; billPrinted: boolean }[];
}

const ITEM_TITLES = { iptal: 'İptal edilen kalemler', ikram: 'İkram edilen kalemler', indirim: 'İndirimler', happy: 'Happy hour satışları' };

function ItemsReport({ range, kind, onExport }: { range: Range; kind: 'iptal' | 'ikram' | 'indirim' | 'happy'; onExport?: () => void }) {
  const data = useQuery({ queryKey: ['reports', 'items', kind, range], queryFn: () => get<ItemsData>(`/reports/items?kind=${kind}&${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const d = data.data;
  if (!d) return null;
  return (
    <Card flush title={`${ITEM_TITLES[kind]} · ${d.count} kayıt · ${tl(d.total)}`} actions={onExport && <Button size="sm" icon={<Download className="size-4" />} onClick={onExport}>CSV</Button>}>
      {d.rows.length === 0 ? (
        <EmptyState title="Bu dönemde kayıt yok" />
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
                    {kind === 'iptal' && (r.afterSend || r.billPrinted) && (
                      <span className="ml-1.5 rounded bg-danger-100 px-1.5 text-xs text-danger-600">{r.billPrinted ? 'hesap sonrası' : 'hazırlandıktan sonra'}</span>
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
  );
}

function RefundsReport({ range }: { range: Range }) {
  const data = useQuery({ queryKey: ['reports', 'refunds', range], queryFn: () => get<{ total: number; count: number; rows: { id: string; at: number; orderNo: number | null; method: string; amount: number; reason: string | null; by: string | null }[] }>(`/reports/refunds?${qs(range)}`) });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const d = data.data;
  if (!d) return null;
  return (
    <Card flush title={`Ödeme iptalleri · ${d.count} · ${tl(d.total)}`}>
      {d.rows.length === 0 ? (
        <EmptyState title="Bu dönemde ödeme iptali yok" />
      ) : (
        <ul className="divide-y divide-line">
          {d.rows.map((r) => (
            <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
              <span className="tabular w-36 text-muted">{fmtDateTime(r.at)}</span>
              <span className="flex-1">
                #{r.orderNo ?? '—'} · {r.method} · {r.reason ?? ''} <span className="text-muted">({r.by ?? '—'})</span>
              </span>
              <span className="tabular font-semibold">{tl(r.amount)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function StaffReport({ range }: { range: Range }) {
  const data = useQuery({
    queryKey: ['reports', 'staff', range],
    queryFn: () => get<{ staff: { userId: string; name: string; orders: number; revenue: number; voids: number; voidValue: number; comps: number; compValue: number; discounts: number }[] }>(`/reports/staff?${qs(range)}`),
  });
  if (data.isLoading) return <PageLoading />;
  if (data.isError) return <ReportError error={data.error} onRetry={() => void data.refetch()} />;
  const rows = data.data?.staff ?? [];
  return (
    <Card flush title="Personel">
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
    </Card>
  );
}

function ExportReport({ range, onDownload }: { range: Range; onDownload: () => void }) {
  return (
    <Card flush title="lafmaliyet aktarımı">
      <div className="space-y-3 p-5 text-sm">
        <p>
          Seçili dönemin ürün satış listesi lafmaliyet'in <b>Satışlar</b> ekranının okuduğu biçimde iner (Ürün; Adet; Tutar, KDV dahil). İkram, iptal ve sitede ödenmiş online siparişler listeye girmez; ekstra shot, şurup ve alternatif süt ayrı satır olarak çıkar.
        </p>
        <Button variant="primary" icon={<FileSpreadsheet className="size-4" />} onClick={onDownload}>
          Satış listesini indir ({rangeLabel(range)})
        </Button>
        <p className="text-xs text-muted">Günlük Z ve satış verisi lafmaliyet bağlantısı kurulunca gün sonunda kendiliğinden gider (Kasa › Geçmiş günler › Gönder)</p>
      </div>
    </Card>
  );
}
