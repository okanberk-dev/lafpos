import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, BadgePercent, ChevronRight, Globe, HardDrive, Info, MonitorSmartphone, PlugZap, ReceiptText, ShieldAlert, ShoppingBag, TurkishLira, Utensils } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Link } from 'react-router';
import { tl, tlShort } from '@shared/money';
import { fmtDateTime, fmtTime } from '@shared/time';
import { visibleSections } from '@/components/admin/sections';
import { Badge, Card, CARD, EmptyState, type KpiCell, KpiStrip, KpiStripSkeleton, PageHeader, type Tone } from '@/components/admin/ui';
import type { PlatformsData } from '@/components/PlatformInbox';
import { ColumnChart } from '@/components/charts';
import { buttonClass } from '@/components/ui/Button';
import { ErrorState, ListSkeleton, SizeTag, Skeleton } from '@/components/ui/misc';
import { errorMessage, get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { onLive } from '@/lib/live';
import { hourBars } from '@/lib/period';
import { REMOTE } from '@/lib/remote';
import type { PatronData } from '@/pages/patron/PatronPage';

interface SyncStatus {
  menu: { linked: boolean; auto: boolean; state: { lastSuccessAt?: number; lastCheckAt?: number; lastError?: string | null; lastErrorAt?: number } | null };
  online: { configured: boolean; enabled: boolean; open: number; state: { lastSuccessAt?: number; lastError?: string | null } | null; soldOutPush: { pending: number; rejected: number; lastError: string | null } };
  lafmaliyet: { configured: boolean; training: boolean; pending: number; failing: number; pendingDays: string[]; lastError: string | null; push: { lastRunAt?: number; sent?: number; failed?: number } | null };
  okc: { provider: 'kapali' | 'simulator' | 'tokenx'; mode: string; tokenx: { configured: boolean }; lastError: { message: string; at: number } | null };
}

const pct = (v: number | null) => (v == null ? null : { text: `${v >= 0 ? '▲' : '▼'} %${Math.abs(v).toLocaleString('tr-TR')}`, good: v >= 0 });
const ago = (at?: number) => (at ? fmtDateTime(at) : 'henüz yok');

/** Kartın satır listesi: gidilecek yeri olan satır bağlantıdır (üzerinde gri, sağda ›), olmayan düz satır */
const ROW = 'flex gap-3 px-4 py-3 sm:px-5';
function RowLink({ to, children, className }: { to?: string; children: ReactNode; className?: string }) {
  if (!to) return <div className={cn(ROW, className)}>{children}</div>;
  return (
    <Link to={to} className={cn(ROW, 'transition-colors hover:bg-hover active:bg-press focus-visible:-outline-offset-2', className)}>
      {children}
      <ChevronRight aria-hidden="true" className="size-4 shrink-0 self-center text-[var(--admin-text-mute)]" />
    </Link>
  );
}

/**
 * Genel bakış (Innex §3 fikir 5): bugünün rakamları tek şeritte, her biri bir referansla; dikkat isteyenler;
 * sistem sağlığı (site, online sipariş, lafmaliyet, yazarkasa, yedek). Personel ciro görmez: sayfa
 * patron.panel ya da rapor.gor ister, sunucu da aynısını denetler.
 */
export default function OverviewAdmin() {
  const can = useCan();
  const qc = useQueryClient();
  // Boyun ayardaki adı (Orta, Büyük): Raporlar ve Patron'daki gibi
  const sizeLabels = useBoot().settings.sizeLabels;
  const live = useQuery({ queryKey: ['patron'], queryFn: () => get<PatronData>('/reports/patron'), refetchInterval: 60_000, enabled: can('patron.panel') });
  const sync = useQuery({ queryKey: ['sync', 'status'], queryFn: () => get<SyncStatus>('/sync/status'), refetchInterval: 60_000 });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => get<{ files: { name: string; at: number }[] }>('/admin/backups'), enabled: can('ayar.yonet') });
  // Onay bekleyen platform siparişi: üstteki şeridin sorgusu (aynı anahtar ve aynı yetki); yoklamayı şerit yapar,
  // burada ayrı yoklama yok
  const platforms = useQuery({ queryKey: ['platforms'], queryFn: () => get<PlatformsData>('/platforms'), enabled: !REMOTE && can('paket.yonet') });
  // Bağlantı yalnız açılabilecek bölüme (izni olmayan bölüm yönetim listesine döner)
  const reach = new Set(visibleSections(can).map((s) => s.to));
  const to = (path: string) => (reach.has(path) ? path : undefined);

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'orders' || e.topic === 'cash') qc.invalidateQueries({ queryKey: ['patron'] });
      }),
    [qc],
  );

  // İlk yükleme: başlık hemen, rakamlar yerinde iskelet (sayfa veri gelince zıplamasın)
  const livePending = can('patron.panel') && live.isPending;
  const liveFailed = live.isError && !live.data;
  const d = live.data;
  const s = sync.data;

  // İkon tonu Raporlar'la aynı: ciro yeşil, açık adisyon kobalt (dolu masa), indirim ve ikram pembe (kayıp), online mor;
  // kapanan adisyon sayısı durumsuz, nötr
  const cells: KpiCell[] = d
    ? [
        {
          key: 'ciro',
          label: 'Net ciro',
          icon: <TurkishLira />,
          hue: 'green',
          value: tl(d.netSales),
          delta: pct(d.compare.lastWeek.change),
          reference: `Geçen hafta bu saatte ${tl(d.compare.lastWeek.netSales)}`,
        },
        {
          key: 'adisyon',
          // Kısa etiket hücreye sığar ("Kapanan adisyon" bilgisayarda da kesiliyordu); "kapanan" referansta
          label: 'Adisyon',
          icon: <ReceiptText />,
          value: d.orders,
          delta: pct(d.compare.lastWeek.orders ? Math.round(((d.orders - d.compare.lastWeek.orders) / d.compare.lastWeek.orders) * 100) : null),
          reference: d.orders ? `Kapanan · ortalama ${tl(d.avgCheck)} · geçen hafta ${d.compare.lastWeek.orders}` : `Henüz kapanan yok · geçen hafta ${d.compare.lastWeek.orders}`,
        },
        {
          key: 'acik',
          label: 'Açık adisyon',
          icon: <Utensils />,
          hue: 'blue',
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
          hue: 'violet',
          value: d.online.orders,
          reference: d.online.orders ? `${tl(d.online.amount)} sitede ödendi` : 'Bugün sitede sipariş yok',
        },
      ]
    : [];

  // Her satır düzeltileceği yere götürür (`to`); gidecek yeri olmayan (ya da bölümü kapalı) satır düz kalır
  const attention: { key: string; tone: Tone; title: string; detail: string; to?: string }[] = [];
  const audit = to('/yonetim/denetim');
  // Platformun süresi işleyen siparişi en üstte: kabul ve ret üstteki şeritte (her ekranda)
  const waiting = platforms.data?.orders.filter((o) => o.status === 'bekliyor').length ?? 0;
  if (waiting) attention.push({ key: 'platform', tone: 'danger', title: waiting === 1 ? 'Platform siparişi onay bekliyor' : `${waiting} platform siparişi onay bekliyor`, detail: 'Üstteki şeritten kabul edin ya da reddedin; süre dolunca platformda iptal olur' });
  for (const a of d?.anomalies ?? []) attention.push({ key: `an-${a.title}`, tone: a.level === 'alarm' ? 'danger' : 'warning', title: a.title, detail: a.detail, to: audit });
  for (const a of (d?.alerts ?? []).slice(0, 6)) attention.push({ key: `al-${a.id}`, tone: a.severity === 'alarm' ? 'danger' : 'warning', title: a.message, detail: fmtTime(a.at), to: audit });
  // Yalnız denenip gidemeyen gün alarmdır; kuyruğa yeni giren (Geçmiş günleri gönder) sırasını bekler
  const integration = to('/yonetim/entegrasyon');
  if (s?.lafmaliyet.failing) attention.push({ key: 'lm', tone: 'danger', title: `lafmaliyet’e gönderilemeyen ${s.lafmaliyet.failing} gün`, detail: s.lafmaliyet.lastError ?? s.lafmaliyet.pendingDays.join(', '), to: integration });
  if (s?.online.soldOutPush.pending) attention.push({ key: 'site-tukendi', tone: 'warning', title: `Siteye bildirilemeyen Satışta bilgisi: ${s.online.soldOutPush.pending} ürün`, detail: s.online.soldOutPush.lastError ?? 'Yeniden denenecek', to: integration });
  if (s?.online.soldOutPush.rejected) attention.push({ key: 'site-red', tone: 'warning', title: `Sitenin reddettiği Satışta bilgisi: ${s.online.soldOutPush.rejected} ürün`, detail: 'Yeniden denenmeyecek; ürün LafPOS’ta açılınca ya da site aynı duruma gelince kalkar', to: integration });
  if (s?.okc.lastError) attention.push({ key: 'okc', tone: 'warning', title: 'Yazarkasa hatası', detail: `${s.okc.lastError.message} · ${fmtTime(s.okc.lastError.at)}`, to: to('/yonetim/yazarkasa') });
  if (d && !d.dayOpen) attention.push({ key: 'gun', tone: 'neutral', title: 'Gün kapalı', detail: 'Satış için kasadan gün açılmalı', to: can('kasa.gun') ? '/kasa' : undefined });
  // Uyarıların ilk altısı burada; fazlası denetim kaydında
  const moreAlerts = d && d.alerts.length > 6 && audit ? d.alerts.length : 0;

  // İş günü sırasıyla (05:00'ten): gece yarısından sonraki satış günün sonunda
  const hours = d ? hourBars(d, 8) : [];
  // Hiç seri yokken grafik boş durumu çizer: "sütun, gri çizgi" açıklaması orada boşa düşer. Geçen hafta satış yoksa
  // grafik gri çizgiyi çizmez (hep sıfır kıyas): açıklama da onu vaat etmez
  const charted = hours.some((h) => h.value || h.compare);
  const lastWeek = hours.some((h) => (h.compare ?? 0) > 0);
  const lastBackup = backups.data?.files[0];

  const health: { key: string; icon: ReactNode; label: string; tone: Tone; state: string; detail: string; to?: string }[] = s
    ? [
        {
          key: 'menu',
          icon: <Globe className="size-4" />,
          to: integration,
          label: 'Site menüsü',
          tone: !s.menu.linked ? 'neutral' : s.menu.state?.lastError ? 'danger' : s.menu.state?.lastSuccessAt ? 'success' : 'neutral',
          state: !s.menu.linked ? 'Kurulmadı' : s.menu.state?.lastError ? 'Hata' : s.menu.auto ? 'Otomatik' : 'Elle',
          detail: !s.menu.linked ? 'Siteye istek gitmiyor' : (s.menu.state?.lastError ?? `Son eşitleme ${ago(s.menu.state?.lastSuccessAt)}`),
        },
        {
          key: 'online',
          icon: <ShoppingBag className="size-4" />,
          to: integration,
          label: 'Online siparişler',
          // Çekim kapalıyken yeşil değil (sipariş kasaya düşmüyor): Yazarkasa'nın "Kapalı"sı gibi nötr
          tone: !s.online.configured || !s.online.enabled ? 'neutral' : s.online.state?.lastError ? 'danger' : 'success',
          state: !s.menu.linked ? 'Kurulmadı' : !s.online.configured ? 'Anahtar yok' : s.online.enabled ? 'Açık' : 'Kapalı',
          detail: !s.menu.linked ? 'Site bağlantısı kurulmadı' : (s.online.state?.lastError ?? `Son kontrol ${ago(s.online.state?.lastSuccessAt)} · açık ${s.online.open}`),
        },
        {
          key: 'lafmaliyet',
          icon: <PlugZap className="size-4" />,
          to: integration,
          label: 'lafmaliyet',
          tone: !s.lafmaliyet.configured ? 'neutral' : s.lafmaliyet.failing ? 'danger' : s.lafmaliyet.pending || s.lafmaliyet.training ? 'info' : 'success',
          state: !s.lafmaliyet.configured
            ? 'Kurulmadı'
            : s.lafmaliyet.failing
              ? `${s.lafmaliyet.failing} gidemedi`
              : s.lafmaliyet.pending
                ? `${s.lafmaliyet.pending} gün sırada`
                : s.lafmaliyet.training
                  ? 'Kurulum modu'
                  : 'Güncel',
          detail: !s.lafmaliyet.configured
            ? 'Gün sonu gitmiyor; elle aktarım'
            : (s.lafmaliyet.lastError ?? (s.lafmaliyet.training ? 'Kurulum modunda gün lafmaliyet’e gitmez' : `Son gönderim ${ago(s.lafmaliyet.push?.lastRunAt)}`)),
        },
        {
          key: 'okc',
          icon: <MonitorSmartphone className="size-4" />,
          to: to('/yonetim/yazarkasa'),
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
                to: to('/yonetim/ayarlar'),
                label: 'Yedek',
                // Liste yüklenirken ya da alınamazken "Yok" denmez: yedek varken patron yokmuş sanmasın
                tone: (backups.isPending ? 'neutral' : backups.isError ? 'warning' : lastBackup && Date.now() - lastBackup.at < 36 * 3_600_000 ? 'success' : 'warning') as Tone,
                state: backups.isPending ? 'Denetleniyor' : backups.isError ? 'Denetlenemedi' : lastBackup ? 'Var' : 'Yok',
                detail: backups.isPending ? 'Yedek listesi okunuyor' : backups.isError ? errorMessage(backups.error) : lastBackup ? `Son yedek ${fmtDateTime(lastBackup.at)}` : 'Henüz yedek alınmadı',
              },
            ]
          : []),
      ]
    : [];

  return (
    <>
      <PageHeader
        title="Genel bakış"
        description={
          d
            ? `${d.dayOpen ? 'Gün açık' : 'Gün kapalı'} · ${fmtTime(d.now)} · kıyas geçen haftanın aynı günü`
            : liveFailed
              ? 'Canlı rakamlar alınamadı'
              : livePending
                ? 'Bugünün rakamları yükleniyor…'
                : 'Bugünün rakamları için patron paneli yetkisi gerekir'
        }
        actions={
          <>
            <Link to="/raporlar" className={buttonClass('secondary')}>
              Raporlar
            </Link>
            {can('kasa.gun') && (
              <Link to="/kasa" className={buttonClass('primary')}>
                Kasa ve gün sonu
              </Link>
            )}
          </>
        }
      />
      <div className="space-y-4">
        {livePending ? <KpiStripSkeleton /> : cells.length > 0 && <KpiStrip cells={cells} />}
        {liveFailed && <ErrorState className={CARD} title="Bugünün rakamları alınamadı" error={live.error} onRetry={() => void live.refetch()} retrying={live.isFetching} />}

        <div className="grid gap-4 xl:grid-cols-3">
          <div className="min-w-0 space-y-4 xl:col-span-2">
            {livePending && (
              <Card title="Bugün saat saat" subtitle="Sütun bugün, gri çizgi geçen haftanın aynı günü">
                <Skeleton className="h-[220px] rounded-xl" />
              </Card>
            )}
            {d && (
              <Card title="Bugün saat saat" subtitle={charted ? (lastWeek ? 'Sütun bugün, gri çizgi geçen haftanın aynı günü' : 'Geçen haftanın aynı günü satış yoktu') : undefined}>
                <ColumnChart data={hours} format={tl} seriesLabel="Bugün" compareLabel="Geçen hafta" ariaLabel="Bugünün saatlik cirosu" height={220} emptyLabel="Bugün henüz satış yok" emptyHint="İlk adisyon kapanınca saat saat ciro burada çizilir" />
              </Card>
            )}
            {d && (
              <Card title="En çok satanlar" subtitle="Bugün, ciro sırasıyla" flush>
                {d.top.length ? (
                  <ul className="divide-y divide-[var(--admin-divider)]">
                    {d.top.slice(0, 6).map((p) => (
                      <li key={p.key} className="flex items-center gap-3 px-4 py-2.5 text-sm sm:px-5">
                        <span className="min-w-0 flex-1 truncate font-medium">
                          {p.name}
                          {(p.size === 'M' || p.size === 'L') && <SizeTag>{sizeLabels[p.size]}</SizeTag>}
                        </span>
                        <span className="tabular-nums text-[var(--admin-text-mute)]">{p.qty} adet</span>
                        {/* Tutar ₺'yle: adedin yanında ikinci bir sayı gibi okunmasın */}
                        <span className="w-24 text-right font-semibold tabular-nums">{tlShort(p.revenue)}</span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  // Boş günü saatlik grafiğin çizimi zaten söyler: ikinci kez aynı çizim yok, kısa not yeter
                  <p className="px-4 pb-4 text-[13px] text-[var(--admin-text-mute)] sm:px-5">İlk satıştan sonra burada sıralanır</p>
                )}
              </Card>
            )}
          </div>

          <div className="space-y-4">
            <Card
              title="Dikkat isteyenler"
              actions={attention.length ? <Badge tone={attention.some((a) => a.tone === 'danger') ? 'danger' : attention.some((a) => a.tone === 'warning') ? 'warning' : 'neutral'}>{attention.length}</Badge> : undefined}
              flush
              // Satırın üzerine gelme zemini kartın yuvarlak köşesinden taşmasın
              className="overflow-hidden"
            >
              {attention.length ? (
                <>
                  <ul className="divide-y divide-[var(--admin-divider)]">
                    {attention.map((a) => (
                      <li key={a.key}>
                        <RowLink to={a.to}>
                          {/* İkon tona göre: alarm kalkan, uyarı üçgen, bilgi (gün kapalı) sakin "i" */}
                          <span aria-hidden="true" className="pt-0.5">
                            {a.tone === 'danger' ? <ShieldAlert className="size-4 text-[var(--admin-danger)]" /> : a.tone === 'warning' ? <AlertTriangle className="size-4 text-[var(--admin-warning)]" /> : <Info className="size-4 text-[var(--admin-text-mute)]" />}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block text-sm font-medium text-[var(--admin-text)]">{a.title}</span>
                            <span className="block text-xs text-[var(--admin-text-mute)] [overflow-wrap:anywhere]">{a.detail}</span>
                          </span>
                        </RowLink>
                      </li>
                    ))}
                  </ul>
                  {moreAlerts > 0 && (
                    <Link to="/yonetim/denetim" className="flex min-h-11 items-center gap-1 border-t border-[var(--admin-divider)] px-4 text-[13px] font-medium text-[var(--admin-primary)] transition-colors hover:bg-hover focus-visible:-outline-offset-2 sm:px-5 pointer-fine:min-h-10">
                      Denetim kaydında tümü ({moreAlerts})
                      <ChevronRight aria-hidden="true" className="size-4" />
                    </Link>
                  )}
                </>
              ) : livePending || sync.isPending ? (
                // Uyarılar gelmeden "Her şey yolunda" denmez
                <ListSkeleton rows={2} />
              ) : liveFailed || (sync.isError && !sync.data) ? (
                <EmptyState bare icon={<AlertTriangle />} title="Uyarılar şu an denetlenemiyor">
                  Rakamlar ya da bağlantı durumu alınamadı; gelince uyarılar burada görünür
                </EmptyState>
              ) : (
                <EmptyState bare art="favori" title="Her şey yolunda">
                  İptal, ikram ve kasa farkı uyarıları burada görünür
                </EmptyState>
              )}
            </Card>

            <Card title="Sistem sağlığı" subtitle="Bağlantılar ve yedek" flush className="overflow-hidden">
              {sync.isPending && <ListSkeleton rows={4} className="pt-1" />}
              {sync.isError && !sync.data && <ErrorState compact title="Bağlantı durumu alınamadı" error={sync.error} onRetry={() => void sync.refetch()} retrying={sync.isFetching} />}
              {health.length > 0 && (
                <ul className="divide-y divide-[var(--admin-divider)]">
                  {health.map((h) => (
                    <li key={h.key}>
                      {/* Durumu rozet söyler; ikon sakin gri (her satır kobalt olunca durum rengi süse dönüyordu) */}
                      <RowLink to={h.to} className="items-center">
                        <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center text-[var(--admin-text-mute)]">
                          {h.icon}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium text-[var(--admin-text)]">{h.label}</span>
                          <span className="block text-xs text-[var(--admin-text-mute)] [overflow-wrap:anywhere]">{h.detail}</span>
                        </span>
                        <Badge tone={h.tone} dot className="shrink-0">
                          {h.state}
                        </Badge>
                      </RowLink>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
        </div>
      </div>
    </>
  );
}
