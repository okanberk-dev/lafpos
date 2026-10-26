import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, Globe, Receipt, Table2, TrendingUp } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { tl } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Card, PageLoading, Stat } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { toast } from '@/lib/toast';

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
  payments: { name: string; amount: number; count: number; share: number }[];
  discounts: number;
  complimentary: number;
  voided: number;
  online: { orders: number; amount: number };
  top: { key: string; name: string; size: string; qty: number; revenue: number; margin: number | null }[];
  openChecks: { id: string; no: number; place: string; total: number; paid: number; openedAt: number; waiter: string | null; billPrinted: boolean }[];
  alerts: { id: number; at: number; severity: 'uyari' | 'alarm'; action: string; message: string; amount: number | null; orderId: string | null }[];
  anomalies: { level: 'uyari' | 'alarm'; title: string; detail: string }[];
}

function Change({ value }: { value: number | null }) {
  if (value == null) return <span className="whitespace-nowrap text-xs text-cream/60">veri yok</span>;
  const up = value >= 0;
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold', up ? 'bg-forest-100 text-forest-700 dark:bg-forest-800 dark:text-forest-100' : 'bg-burgundy-100 text-burgundy-600')}>
      {up ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}%{Math.abs(value).toLocaleString('tr-TR')}
    </span>
  );
}

export default function PatronPage() {
  const can = useCan();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const now = useTick(30_000);
  const [table, setTable] = useState(false);
  const data = useQuery({ queryKey: ['patron'], queryFn: () => get<PatronData>('/reports/patron'), refetchInterval: 60_000 });

  // Satış ve kasa olaylarında yenile; uyarılar anında bildirim olarak düşer
  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'orders' || e.topic === 'cash') qc.invalidateQueries({ queryKey: ['patron'] });
        if (e.topic === 'alerts' && e.message) toast.warn(e.message);
      }),
    [qc],
  );

  if (data.isLoading) return <PageLoading />;
  const d = data.data;
  if (!d) return null;
  const hours = d.hourly.map((v, h) => ({ label: String(h).padStart(2, '0'), value: v, compare: d.hourlyLastWeek[h] }));
  const firstActive = Math.max(0, Math.min(7, ...hours.map((h, i) => (h.value || h.compare ? i : 24))));
  const visibleHours = hours.slice(firstActive);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className={cn('size-2.5 rounded-full', d.dayOpen ? 'animate-pulse bg-forest-500' : 'bg-muted')} />
        <span className="text-sm text-muted">
          {d.dayOpen ? 'Gün açık' : 'Gün kapalı'} · {fmtTime(now)} itibarıyla · canlı
        </span>
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-3xl bg-forest-700 p-6 text-cream shadow-[var(--shadow-card)]">
          <div className="text-sm text-cream/70">Bugünkü ciro</div>
          <div className="mt-1 text-6xl font-semibold tracking-tight">{tl(d.netSales)}</div>
          <div className="mt-1 text-sm text-cream/70">
            {d.orders} adisyon · ortalama {tl(d.avgCheck)}
            {d.open.count > 0 && ` · açıkta ${tl(d.open.total)}`}
          </div>
          <div className="mt-5 grid gap-2 sm:grid-cols-2">
            <CompareRow label="Geçen hafta aynı saat" value={d.compare.lastWeek.netSales} change={d.compare.lastWeek.change} />
            <CompareRow label="4 hafta önce aynı saat" value={d.compare.fourWeeks.netSales} change={d.compare.fourWeeks.change} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Dünkü ciro" value={tl(d.yesterday.netSales)} hint={`${d.yesterday.receipts} adisyon`} />
          <Stat label="Açık hesap" value={String(d.open.count)} hint={tl(d.open.total)} />
          <Stat label="İndirim · ikram" value={tl(d.discounts + d.complimentary)} hint={`ikram ${tl(d.complimentary)}`} />
          <Stat label="İptal" value={tl(d.voided)} />
          {d.online.orders > 0 && <Stat label="Online (sitede ödendi)" value={tl(d.online.amount)} hint={`${d.online.orders} sipariş`} />}
        </div>
      </div>

      {(d.anomalies.length > 0 || d.alerts.length > 0) && (
        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          {d.anomalies.length > 0 && (
            <Card title="Dikkat">
              <ul className="divide-y divide-line">
                {d.anomalies.map((a, i) => (
                  <li key={i} className="flex items-start gap-3 px-4 py-3 text-sm">
                    {a.level === 'alarm' ? <AlertOctagon className="mt-0.5 size-5 shrink-0 text-burgundy-500" /> : <AlertTriangle className="mt-0.5 size-5 shrink-0 text-brass-500" />}
                    <span>
                      <span className="block font-semibold">
                        {a.title} <span className={cn('ml-1 rounded px-1.5 text-[11px]', a.level === 'alarm' ? 'bg-burgundy-100 text-burgundy-600' : 'bg-brass-100 text-brass-700')}>{a.level === 'alarm' ? 'Alarm' : 'Uyarı'}</span>
                      </span>
                      <span className="text-muted">{a.detail}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
          {d.alerts.length > 0 && (
            <Card title="Bugünkü uyarılar">
              <ul className="scroll-thin max-h-72 divide-y divide-line overflow-y-auto">
                {d.alerts.map((a) => (
                  <li key={a.id}>
                    <button onClick={() => a.orderId && navigate(`/adisyon/${a.orderId}`)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
                      {a.severity === 'alarm' ? <AlertOctagon className="mt-0.5 size-4 shrink-0 text-burgundy-500" /> : <AlertTriangle className="mt-0.5 size-4 shrink-0 text-brass-500" />}
                      <span className="min-w-0 flex-1">
                        <span className="block">{a.message}</span>
                        <span className="text-xs text-muted">
                          {fmtTime(a.at)} · {a.severity === 'alarm' ? 'Alarm' : 'Uyarı'}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-4 lg:grid-cols-[1.6fr_1fr]">
        <Card
          title="Saat saat bugün"
          actions={
            <button onClick={() => setTable(!table)} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 hover:bg-surface-2 pointer-fine:min-h-0">
              <Table2 className="size-4" /> {table ? 'Grafik' : 'Tablo'}
            </button>
          }
        >
          <div className="p-4">
            {table ? (
              <table className="tabular w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="py-1 text-left">Saat</th>
                    <th className="py-1 text-right">Bugün</th>
                    <th className="py-1 text-right">Geçen hafta</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleHours
                    .filter((h) => h.value || h.compare)
                    .map((h) => (
                      <tr key={h.label} className="border-t border-line/60">
                        <td className="py-1">{h.label}:00</td>
                        <td className="py-1 text-right font-semibold">{tl(h.value)}</td>
                        <td className="py-1 text-right text-muted">{tl(h.compare ?? 0)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <ColumnChart data={visibleHours} format={tl} seriesLabel="Bugün" compareLabel="Geçen hafta aynı gün" ariaLabel="Bugünün saatlik cirosu, geçen haftayla" />
            )}
          </div>
        </Card>
        <Card title="Ödeme türleri">
          <div className="p-4">
            {d.payments.length ? <BarList items={d.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')}` }))} format={tl} /> : <p className="text-sm text-muted">Henüz ödeme yok</p>}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="En çok satanlar">
          {d.top.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">Henüz satış yok</p>
          ) : (
            <ol className="divide-y divide-line">
              {d.top.map((p, i) => (
                <li key={p.key} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="grid size-7 place-items-center rounded-full bg-surface-3 text-xs font-semibold">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">
                    {p.name} {p.size !== 'TEK' && <span className="text-xs text-muted">{p.size}</span>}
                  </span>
                  <span className="text-muted">{p.qty} adet</span>
                  <span className="tabular w-24 text-right font-semibold">{tl(p.revenue)}</span>
                  {can('rapor.maliyet') && p.margin != null && (
                    <span className="tabular hidden w-24 text-right text-xs text-forest-600 sm:block">
                      <TrendingUp className="mr-0.5 inline size-3" />
                      {tl(p.margin)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <Card title={`Açık hesaplar (${d.openChecks.length})`}>
          {d.openChecks.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted">Şu an açık hesap yok</p>
          ) : (
            <ul className="divide-y divide-line">
              {d.openChecks.map((o) => (
                <li key={o.id}>
                  <button onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-surface-2">
                    {o.billPrinted ? <Receipt className="size-4 text-brass-500" /> : <Globe className="size-4 opacity-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{o.place}</span> <span className="text-muted">#{o.no}</span>
                      <span className="block text-xs text-muted">
                        {fmtElapsed(o.openedAt, now)} · {o.waiter ?? '—'}
                      </span>
                    </span>
                    <span className="tabular font-semibold">{tl(o.total - o.paid)}</span>
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

function CompareRow({ label, value, change }: { label: string; value: number; change: number | null }) {
  return (
    <div className="flex items-center justify-between rounded-2xl bg-cream/10 px-4 py-3">
      <span className="text-sm text-cream/80">{label}</span>
      <span className="flex items-center gap-2">
        <span className="tabular font-semibold">{tl(value)}</span>
        <Change value={change} />
      </span>
    </div>
  );
}
