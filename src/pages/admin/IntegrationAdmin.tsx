import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CloudDownload, RefreshCw } from 'lucide-react';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Toggle } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { Card, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { toast } from '@/lib/toast';

interface SyncStatus {
  menu: { auto: boolean; state: { lastCheckAt?: number; lastSuccessAt?: number; lastError?: string | null; lastErrorAt?: number; lastChanges?: number; etag?: string } | null };
  online: { configured: boolean; enabled: boolean; versionSignal: boolean; state: { lastSuccessAt?: number; lastError?: string | null; count?: number } | null; open: number };
  lafmaliyet: { configured: boolean; url: string | null; pending: number; pendingDays: string[]; lastError: string | null; push: { lastRunAt?: number; sent?: number; failed?: number } | null; costsAt: number | null };
}

function Status({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-forest-500" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-brass-500" />}
      <span>{children}</span>
    </div>
  );
}

export default function IntegrationAdmin() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['sync', 'status'], queryFn: () => get<SyncStatus>('/sync/status'), refetchInterval: 30_000 });
  const setting = async (body: Record<string, boolean>) => {
    try {
      await put('/sync/settings', body);
      qc.invalidateQueries({ queryKey: ['sync'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const run = async (path: string, ok: string) => {
    try {
      await post(path);
      toast.ok(ok);
      qc.invalidateQueries({ queryKey: ['sync'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  if (data.isLoading || !data.data) return <PageLoading />;
  const s = data.data;
  const canSync = can('senkron.yonet');

  return (
    <div className="space-y-4">
      <PageHeader title="Site ve lafmaliyet" description="Ürünler siteden gelir, satış ve Z lafmaliyet'e gider. Sözleşme: docs/03-ENTEGRASYON.md" />
      <Card flush title={`laffogato · menü (${boot.integrations.laffogatoUrl})`}>
        <div className="space-y-2 p-4">
          <Status ok={!s.menu.state?.lastError}>
            {s.menu.state?.lastSuccessAt ? `Son başarılı kontrol ${fmtDateTime(s.menu.state.lastSuccessAt)}` : 'Henüz eşitlenmedi'}
            {s.menu.state?.lastError && <span className="block text-burgundy-500">Hata: {s.menu.state.lastError}</span>}
          </Status>
          <p className="text-xs text-muted">Herkese açık menü ucu CDN'den gelir, sitenin veritabanını uyandırmaz; 5 dakikada bir ETag ile kontrol edilir</p>
          <div className="flex flex-wrap items-center gap-3 pt-1">
            <Toggle checked={s.menu.auto} disabled={!canSync} onChange={(v) => setting({ menuAutoSync: v })} label="Otomatik eşitle" />
            <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={() => run('/sync/menu/apply', 'Menü eşitlendi')}>
              Şimdi eşitle
            </Button>
          </div>
        </div>
      </Card>
      <Card flush title="laffogato · online siparişler ve Tükendi">
        <div className="space-y-2 p-4">
          <Status ok={s.online.configured}>{s.online.configured ? 'İmzalı bağlantı açık (LAFFOGATO_SYNC_SECRET)' : 'Anahtar yok: online siparişler gelmez, Tükendi yalnız LafPOS\'ta değişir'}</Status>
          {s.online.configured && (
            <>
              <Status ok={s.online.versionSignal}>{s.online.versionSignal ? 'Sipariş sürüm sinyali çalışıyor: 20 sn içinde düşer' : 'Sürüm sinyali yok (site PR\'ı yayında değil): 5 dk\'da bir kontrol'}</Status>
              <Status ok={!s.online.state?.lastError}>
                {s.online.state?.lastSuccessAt ? `Son çekim ${fmtDateTime(s.online.state.lastSuccessAt)} · ${s.online.open} açık online sipariş` : 'Henüz çekilmedi'}
                {s.online.state?.lastError && <span className="block text-burgundy-500">Hata: {s.online.state.lastError}</span>}
              </Status>
              <Toggle checked={s.online.enabled} disabled={!canSync} onChange={(v) => setting({ onlineOrdersSync: v })} label="Online siparişleri çek" />
            </>
          )}
        </div>
      </Card>
      <Card flush title="lafmaliyet · günlük satış, Z ve maliyet">
        <div className="space-y-2 p-4">
          <Status ok={s.lafmaliyet.configured}>{s.lafmaliyet.configured ? `Bağlı: ${s.lafmaliyet.url}` : 'Anahtar yok (LAFMALIYET_SYNC_SECRET): Satışlar listesi ve Z alanları elle aktarılır (Raporlar › lafmaliyet aktarımı, Kasa › Z)'}</Status>
          {s.lafmaliyet.configured && (
            <>
              <Status ok={!s.lafmaliyet.pending}>
                {s.lafmaliyet.pending ? `Giden kutusunda ${s.lafmaliyet.pending} gün bekliyor (${s.lafmaliyet.pendingDays.join(', ')})` : 'Giden kutusu boş'}
                {s.lafmaliyet.lastError && <span className="block text-burgundy-500">Son hata: {s.lafmaliyet.lastError}</span>}
              </Status>
              <Status ok={!!s.lafmaliyet.costsAt}>{s.lafmaliyet.costsAt ? `Maliyetler ${fmtDateTime(s.lafmaliyet.costsAt)} tarihinde çekildi` : 'Maliyetler henüz çekilmedi'}</Status>
              <Button size="sm" icon={<CloudDownload className="size-4" />} disabled={!canSync} onClick={() => run('/sync/lafmaliyet/costs/pull', 'Maliyetler çekildi')}>
                Maliyetleri çek
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
