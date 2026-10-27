import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BadgePercent, CircleDollarSign, Globe, HardDrive, MonitorSmartphone, PlugZap, Receipt, ShieldAlert, ShoppingBag, Utensils } from 'lucide-react';
import { useEffect } from 'react';
import { Link } from 'react-router';
import { tl, tlCompact } from '@shared/money';
import { fmtDateTime, fmtTime } from '@shared/time';
import { Badge, BTN, Card, DefRow, EmptyState, type KpiCell, KpiStrip, PageHeader, type Tone } from '@/components/admin/ui';
import { ColumnChart } from '@/components/charts';
import { PageLoading } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { onLive } from '@/lib/live';
import type { PatronData } from '@/pages/patron/PatronPage';

interface SyncStatus {
  menu: { linked: boolean; auto: boolean; state: { lastSuccessAt?: number; lastCheckAt?: number; lastError?: string | null; lastErrorAt?: number } | null };
  online: { configured: boolean; enabled: boolean; open: number; state: { lastSuccessAt?: number; lastError?: string | null } | null };
  lafmaliyet: { configured: boolean; pending: number; pendingDays: string[]; lastError: string | null; push: { lastRunAt?: number; sent?: number; failed?: number } | null };
  okc: { provider: 'kapali' | 'simulator' | 'tokenx'; mode: string; tokenx: { configured: boolean }; lastError: { message: string; at: number } | null };
}

const pct = (v: number | null) => (v == null ? null : { text: `${v >= 0 ? '▲' : '▼'} %${Math.abs(v).toLocaleString('tr-TR')}`, good: v >= 0 });
const ago = (at?: number) => (at ? fmtDateTime(at) : 'henüz yok');

/**
 * Genel bakış (Innex §3 fikir 5): bugünün rakamları tek şeritte, her biri bir referansla; dikkat isteyenler;
 * sistem sağlığı (site, online sipariş, lafmaliyet, yazarkasa, yedek). Personel ciro görmez: sayfa
 * patron.panel ya da rapor.gor ister, sunucu da aynısını denetler.
 */
export default function OverviewAdmin() {
  const can = useCan();
  const qc = useQueryClient();
  const live = useQuery({ queryKey: ['patron'], queryFn: () => get<PatronData>('/reports/patron'), refetchInterval: 60_000, enabled: can('patron.panel') });
  const sync = useQuery({ queryKey: ['sync', 'status'], queryFn: () => get<SyncStatus>('/sync/status'), refetchInterval: 60_000 });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => get<{ files: { name: string; at: number }[] }>('/admin/backups'), enabled: can('ayar.yonet') });

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'orders' || e.topic === 'cash') qc.invalidateQueries({ queryKey: ['patron'] });
      }),
    [qc],
  );

  if (live.isLoading || sync.isLoading) return <PageLoading />;
  const d = live.data;
  const s = sync.data;

  const cells: KpiCell[] = d
    ? [
        {
          key: 'ciro',
          label: 'Net ciro',
          icon: <CircleDollarSign />,
          hue: 'blue',
          value: tl(d.netSales),
          delta: pct(d.compare.lastWeek.change),
          reference: `Geçen hafta bu saate kadar ${tl(d.compare.lastWeek.netSales)}`,
        },
        {
          key: 'adisyon',
          label: 'Kapanan adisyon',
          icon: <Receipt />,
          hue: 'violet',
          value: d.orders,
          delta: pct(d.compare.lastWeek.orders ? Math.round(((d.orders - d.compare.lastWeek.orders) / d.compare.lastWeek.orders) * 100) : null),
          reference: `Ortalama ${tl(d.avgCheck)} · geçen hafta ${d.compare.lastWeek.orders}`,
        },
        {
          key: 'acik',
          label: 'Açık adisyon',
          icon: <Utensils />,
          hue: 'amber',
          value: d.open.count,
          reference: d.open.count ? `Tahsil edilecek ${tl(d.open.total)}` : 'Bekleyen tahsilat yok',
        },
        {
          key: 'indirim',
          label: 'İndirim ve ikram',
          icon: <BadgePercent />,
          hue: 'rose',
          value: tl(d.discounts + d.complimentary),
          reference: `İptal edilen ${tl(d.voided)}`,
        },
        {
          key: 'online',
          label: 'Online sipariş',
          icon: <ShoppingBag />,
          hue: 'green',
          value: d.online.orders,
          reference: d.online.orders ? `${tl(d.online.amount)} sitede ödendi` : 'Bugün sitede sipariş yok',
        },
      ]
    : [];

  const attention: { key: string; tone: Tone; title: string; detail: string }[] = [];
  for (const a of d?.anomalies ?? []) attention.push({ key: `an-${a.title}`, tone: a.level === 'alarm' ? 'danger' : 'warning', title: a.title, detail: a.detail });
  for (const a of (d?.alerts ?? []).slice(0, 6)) attention.push({ key: `al-${a.id}`, tone: a.severity === 'alarm' ? 'danger' : 'warning', title: a.message, detail: fmtTime(a.at) });
  if (s?.lafmaliyet.pending) attention.push({ key: 'lm', tone: 'danger', title: `lafmaliyet'e gönderilemeyen ${s.lafmaliyet.pending} gün`, detail: s.lafmaliyet.lastError ?? s.lafmaliyet.pendingDays.join(', ') });
  if (s?.okc.lastError) attention.push({ key: 'okc', tone: 'warning', title: 'Yazarkasa hatası', detail: `${s.okc.lastError.message} · ${fmtTime(s.okc.lastError.at)}` });
  if (d && !d.dayOpen) attention.push({ key: 'gun', tone: 'neutral', title: 'Gün kapalı', detail: 'Satış için kasadan gün açılmalı' });

  const hours = d ? d.hourly.map((v, h) => ({ label: String(h).padStart(2, '0'), value: v, compare: d.hourlyLastWeek[h] })) : [];
  const first = Math.max(0, Math.min(8, ...hours.map((h, i) => (h.value || h.compare ? i : 24))));
  const lastBackup = backups.data?.files[0];

  const health: { key: string; icon: React.ReactNode; label: string; tone: Tone; state: string; detail: string }[] = s
    ? [
        {
          key: 'menu',
          icon: <Globe className="size-4" />,
          label: 'Site menüsü',
          tone: !s.menu.linked ? 'neutral' : s.menu.state?.lastError ? 'danger' : s.menu.state?.lastSuccessAt ? 'success' : 'neutral',
          state: !s.menu.linked ? 'Kurulmadı' : s.menu.state?.lastError ? 'Hata' : s.menu.auto ? 'Otomatik' : 'Elle',
          detail: !s.menu.linked ? 'LAFFOGATO_URL yok: siteye istek gitmez' : (s.menu.state?.lastError ?? `Son eşitleme ${ago(s.menu.state?.lastSuccessAt)}`),
        },
        {
          key: 'online',
          icon: <ShoppingBag className="size-4" />,
          label: 'Online siparişler',
          tone: !s.online.configured ? 'neutral' : s.online.state?.lastError ? 'danger' : 'success',
          state: !s.menu.linked ? 'Kurulmadı' : !s.online.configured ? 'Anahtar yok' : s.online.enabled ? 'Açık' : 'Kapalı',
          detail: !s.menu.linked ? 'Site bağlantısı kurulmadı' : (s.online.state?.lastError ?? `Son kontrol ${ago(s.online.state?.lastSuccessAt)} · açık ${s.online.open}`),
        },
        {
          key: 'lafmaliyet',
          icon: <PlugZap className="size-4" />,
          label: 'lafmaliyet',
          tone: !s.lafmaliyet.configured ? 'neutral' : s.lafmaliyet.pending ? 'danger' : 'success',
          state: !s.lafmaliyet.configured ? 'Anahtar yok' : s.lafmaliyet.pending ? `${s.lafmaliyet.pending} bekliyor` : 'Güncel',
          detail: s.lafmaliyet.lastError ?? `Son gönderim ${ago(s.lafmaliyet.push?.lastRunAt)}`,
        },
        {
          key: 'okc',
          icon: <MonitorSmartphone className="size-4" />,
          label: 'Yazarkasa',
          tone: s.okc.provider === 'kapali' ? 'neutral' : s.okc.lastError ? 'warning' : s.okc.provider === 'simulator' ? 'info' : 'success',
          state: s.okc.provider === 'kapali' ? 'Kapalı' : s.okc.provider === 'simulator' ? 'Eğitim cihazı' : 'TokenX',
          detail: s.okc.lastError ? s.okc.lastError.message : s.okc.provider === 'tokenx' ? `${s.okc.mode === 'liste' ? 'Liste' : 'Anlık'} sepet` : 'Fişler gerçek cihaza gitmiyor',
        },
        ...(can('ayar.yonet')
          ? [
              {
                key: 'yedek',
                icon: <HardDrive className="size-4" />,
                label: 'Yedek',
                tone: (lastBackup && Date.now() - lastBackup.at < 36 * 3_600_000 ? 'success' : 'warning') as Tone,
                state: lastBackup ? 'Var' : 'Yok',
                detail: lastBackup ? `Son yedek ${fmtDateTime(lastBackup.at)}` : 'Henüz yedek alınmadı',
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Genel bakış"
        description={d ? `${d.dayOpen ? 'Gün açık' : 'Gün kapalı'} · ${fmtTime(d.now)} itibarıyla · rakamlar geçen haftanın aynı günü aynı saatiyle karşılaştırılır` : 'Bugünün rakamları için patron paneli yetkisi gerekir'}
        actions={
          <>
            <Link to="/raporlar" className={BTN.ghost}>
              Raporlar
            </Link>
            {can('kasa.gun') && (
              <Link to="/kasa" className={BTN.primary}>
                Kasa ve gün sonu
              </Link>
            )}
          </>
        }
      />
      <div className="space-y-4">
        {cells.length > 0 && <KpiStrip cells={cells} />}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="space-y-4 xl:col-span-2">
            {d && (
              <Card title="Bugün saat saat" subtitle="Sütun bugün, gri çizgi geçen haftanın aynı günü">
                <ColumnChart data={hours.slice(first)} format={tl} seriesLabel="Bugün" compareLabel="Geçen hafta" ariaLabel="Bugünün saatlik cirosu" height={220} />
              </Card>
            )}
            {d && (
              <Card title="En çok satanlar" subtitle="Bugün, adet sırasıyla" flush>
                {d.top.length ? (
                  <ul className="divide-y divide-[var(--admin-divider)]">
                    {d.top.slice(0, 6).map((p) => (
                      <li key={p.key} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {p.name}
                          {p.size && p.size !== 'TEK' ? <span className="text-[var(--admin-text-mute)]"> · {p.size}</span> : null}
                        </span>
                        <span className="tabular-nums text-[var(--admin-text-mute)]">{p.qty} adet</span>
                        <span className="w-24 text-right font-semibold tabular-nums">{tlCompact(p.revenue)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="px-5 pb-5 text-sm text-[var(--admin-text-mute)]">Bugün henüz satış yok</p>
                )}
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card title="Dikkat isteyenler" subtitle={attention.length ? `${attention.length} konu` : 'Her şey yolunda'} flush>
              {attention.length ? (
                <ul className="divide-y divide-[var(--admin-divider)]">
                  {attention.map((a) => (
                    <li key={a.key} className="flex gap-3 px-4 py-3 sm:px-5">
                      <span className="pt-0.5">{a.tone === 'danger' ? <ShieldAlert className="size-4 text-[var(--admin-danger)]" /> : <AlertTriangle className="size-4 text-[var(--admin-warning)]" />}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium">{a.title}</span>
                        <span className="block text-xs text-[var(--admin-text-mute)]">{a.detail}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <EmptyState bare title="Dikkat isteyen bir şey yok">
                  İptal, ikram ve kasa farkı uyarıları burada görünür
                </EmptyState>
              )}
            </Card>

            <Card title="Sistem sağlığı" subtitle="Bağlantılar ve yedek">
              <div className="-my-1">
                {health.map((h) => (
                  <DefRow
                    key={h.key}
                    label={
                      <span className="inline-flex items-center gap-2 text-[var(--admin-text-soft)]">
                        {h.icon}
                        {h.label}
                      </span>
                    }
                  >
                    <Badge tone={h.tone} dot>
                      {h.state}
                    </Badge>
                    <span className="mt-0.5 block max-w-[13rem] truncate text-xs font-normal text-[var(--admin-text-mute)]" title={h.detail}>
                      {h.detail}
                    </span>
                  </DefRow>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
