import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertOctagon, AlertTriangle, ArrowDownRight, ArrowUpRight, Receipt, Table2, TrendingUp, Wallet } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { tl } from '@shared/money';
import { fmtAgo, fmtTime } from '@shared/time';
import { BarList, ColumnChart } from '@/components/charts';
import { Badge, Card, EmptyState, ErrorState, Skeleton, Stat } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
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

/**
 * Değişim yüzdesi. Hesaplanamıyorsa nedeni: kıyas günü satış yoksa "satış yoktu" (rakam yanında, "veri yok" eksik
 * kayıt ya da arıza gibi okunuyordu)
 */
function Change({ value, base }: { value: number | null; base: number }) {
  if (value == null)
    return (
      <span className="whitespace-nowrap text-xs text-muted" title="Yüzde hesaplanamaz">
        {base === 0 ? 'satış yoktu' : 'kıyas yok'}
      </span>
    );
  const up = value >= 0;
  return (
    <span className={cn('tabular inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold', up ? 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]' : 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]')}>
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

  // İlk yükleme: sayfanın biçiminde iskelet (büyük ciro kartı ve dört karo), spinner değil
  if (data.isPending) {
    return (
      <div role="status" aria-label="Canlı rakamlar yükleniyor…" className="h-full overflow-hidden p-4 md:p-6">
        <Skeleton className="mb-4 h-5 w-56" />
        <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
          <Skeleton className="h-[188px] rounded-2xl" />
          <div className="grid grid-cols-2 gap-3">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-[104px] rounded-2xl" />
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

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {/* Durumu nokta ve yazı birlikte anlatır; sürekli nabız yok */}
        <span aria-hidden="true" className={cn('size-2.5 rounded-full', d.dayOpen ? 'bg-[var(--admin-success)]' : 'bg-muted')} />
        <span className="text-[13px] text-muted">
          {d.dayOpen ? 'Gün açık' : 'Gün kapalı'} · {fmtTime(now)} itibarıyla · canlı
        </span>
      </div>

      <div className="grid gap-3 lg:grid-cols-[1.4fr_1fr]">
        <div className="rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] p-5">
          <div className="text-[13px] font-medium text-muted">Bugünkü ciro</div>
          <div className="tabular font-headline mt-2 text-[44px] font-semibold leading-none tracking-[-0.02em] sm:text-[56px]">{tl(d.netSales)}</div>
          <div className="mt-2 text-sm text-muted">{joinMeta([`${d.orders} adisyon`, d.orders > 0 && `ortalama ${tl(d.avgCheck)}`, d.open.count > 0 && `açıkta ${tl(d.open.total)}`])}</div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <CompareRow label="Geçen hafta bu saate kadar" value={d.compare.lastWeek.netSales} change={d.compare.lastWeek.change} />
            <CompareRow label="4 hafta önce bu saate kadar" value={d.compare.fourWeeks.netSales} change={d.compare.fourWeeks.change} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Stat label="Dünkü ciro" value={tl(d.yesterday.netSales)} hint={`${d.yesterday.receipts} adisyon`} />
          <Stat label="Açık hesap" value={String(d.open.count)} hint={tl(d.open.total)} />
          <Stat
            label="İndirim · ikram"
            value={tl(d.discounts + d.complimentary)}
            hint={[`ikram ${tl(d.complimentary - (d.odenmez ?? 0) - (d.zayi ?? 0))}`, (d.odenmez ?? 0) > 0 && `ödenmez ${tl(d.odenmez ?? 0)}`, (d.zayi ?? 0) > 0 && `zayi ${tl(d.zayi ?? 0)}`].filter(Boolean).join(' · ')}
          />
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
                    {a.level === 'alarm' ? <AlertOctagon aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-danger-ink" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning-ink" />}
                    <span>
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-semibold">
                        {a.title} <Badge tone={a.level === 'alarm' ? 'danger' : 'warning'}>{a.level === 'alarm' ? 'Alarm' : 'Uyarı'}</Badge>
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
                    <button onClick={() => a.orderId && navigate(`/adisyon/${a.orderId}`)} className="flex w-full items-start gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-hover active:bg-press">
                      {a.severity === 'alarm' ? <AlertOctagon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger-ink" /> : <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />}
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
            <button onClick={() => setTable(!table)} aria-pressed={table} className="inline-flex min-h-11 items-center gap-1.5 rounded-lg px-2 py-1 text-sm text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-press pointer-fine:min-h-9">
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
                      <tr key={h.key} className="border-t border-line/60">
                        <td className="py-1">{h.title}</td>
                        <td className="py-1 text-right font-semibold">{tl(h.value)}</td>
                        <td className="py-1 text-right text-muted">{tl(h.compare ?? 0)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            ) : (
              <ColumnChart data={visibleHours} format={tl} seriesLabel="Bugün" compareLabel="Geçen hafta aynı gün" ariaLabel="Bugünün saatlik cirosu, geçen haftayla" emptyLabel="Bugün henüz satış yok" />
            )}
          </div>
        </Card>
        <Card title="Ödeme türleri">
          <div className="p-4">
            {d.payments.length ? (
              <BarList items={d.payments.map((p) => ({ key: p.name, label: p.name, value: p.amount, sub: `%${p.share.toLocaleString('tr-TR')}` }))} format={tl} />
            ) : (
              <EmptyState compact icon={<Wallet />} title="Bugün henüz ödeme alınmadı">
                Adisyonlar kapandıkça ödeme türleri burada toplanır
              </EmptyState>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="En çok satanlar">
          {d.top.length === 0 ? (
            <EmptyState compact art="affogato" title="Bugün henüz satış yok">
              İlk adisyon kapanınca en çok satanlar burada sıralanır
            </EmptyState>
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
                    <span className="tabular hidden w-24 text-right text-xs text-success-ink sm:block">
                      <TrendingUp className="mr-0.5 inline size-3" />
                      {tl(p.margin)}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          )}
          {can('rapor.maliyet') && staleCostsText(d.costsAt, d.now) && <p className="px-4 pb-3 text-xs font-medium text-warning-ink">{staleCostsText(d.costsAt, d.now)}</p>}
        </Card>
        <Card title={`Açık hesaplar (${d.openChecks.length})`}>
          {d.openChecks.length === 0 ? (
            <EmptyState compact art="fis" title="Şu an açık hesap yok">
              Açılan adisyonlar ödenene kadar burada görünür
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {d.openChecks.map((o) => (
                <li key={o.id}>
                  <button onClick={() => navigate(`/adisyon/${o.id}`)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm transition-colors duration-150 hover:bg-hover active:bg-press">
                    {/* Hesap istendi: ikon ve ipucu (renk tek başına değil); yoksa aynı genişlikte boşluk */}
                    {o.billPrinted ? <Receipt aria-label="Hesap istendi" className="size-4 shrink-0 text-warning-ink" /> : <span aria-hidden="true" className="size-4 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{o.place}</span> <span className="text-muted">#{o.no}</span>
                      <span className="block text-xs text-muted">{joinMeta([fmtAgo(o.openedAt, now), o.waiter])}</span>
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

/** Kıyas: etiket üstte, tutar ve değişim altta; telefonda da tek satıra sıkışmaz */
function CompareRow({ label, value, change }: { label: string; value: number; change: number | null }) {
  return (
    <div className="flex flex-col gap-1 rounded-xl border border-line bg-surface-2 px-4 py-3">
      <span className="text-xs text-muted">{label}</span>
      <span className="flex items-center justify-between gap-2">
        <span className="tabular text-[15px] font-semibold">{tl(value)}</span>
        <Change value={change} base={value} />
      </span>
    </div>
  );
}
