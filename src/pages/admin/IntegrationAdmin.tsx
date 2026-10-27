import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CloudDownload, History, Info, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Toggle } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { Card, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { answerText, type DayAnswer, dayLabel, unmatchedText } from '@/lib/lafmaliyet';
import { toast } from '@/lib/toast';

interface SyncStatus {
  menu: { linked: boolean; auto: boolean; state: { lastCheckAt?: number; lastSuccessAt?: number; lastError?: string | null; lastErrorAt?: number; lastChanges?: number; etag?: string } | null };
  online: {
    configured: boolean;
    enabled: boolean;
    versionSignal: boolean;
    state: { lastSuccessAt?: number; lastError?: string | null; count?: number } | null;
    open: number;
    soldOutPush: { pending: number; rejected: number; lastError: string | null };
  };
  lafmaliyet: {
    configured: boolean;
    url: string | null;
    /** Kurulum modu: günler gönderilmez */
    training: boolean;
    pending: number;
    pendingDays: string[];
    lastError: string | null;
    push: { lastRunAt?: number; sent?: number; failed?: number } | null;
    /** Son gönderilen günün lafmaliyet yanıtı */
    answer: DayAnswer | null;
    /** "Geçmiş günleri gönder"in varsayılanı: lafmaliyet'in geçiş gününden düne */
    backfill: { from: string | null; to: string; unsent: number | null };
    costsAt: number | null;
    costsError: { message: string; at: number | null } | null;
  };
}

/** `idle`: bağlantı bilerek kapalı (kurulmadı); hata değil, sakin gösterilir */
function Status({ ok, idle, children }: { ok: boolean; idle?: boolean; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 text-sm">
      {idle ? (
        <Info className="mt-0.5 size-4 shrink-0 text-muted" />
      ) : ok ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-500" />
      ) : (
        <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn-500" />
      )}
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
      const r = await post<{ warning?: string }>(path);
      if (r?.warning) toast.warn(r.warning);
      else toast.ok(ok);
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
      <Card flush title={s.menu.linked ? `laffogato · menü (${boot.integrations.laffogatoUrl})` : 'laffogato · menü'}>
        <div className="space-y-2 p-4">
          {s.menu.linked ? (
            <>
              <Status ok={!s.menu.state?.lastError}>
                {s.menu.state?.lastSuccessAt ? `Son başarılı kontrol ${fmtDateTime(s.menu.state.lastSuccessAt)}` : 'Henüz eşitlenmedi'}
                {s.menu.state?.lastError && <span className="block text-danger-500">Hata: {s.menu.state.lastError}</span>}
              </Status>
              <p className="text-xs text-muted">
                Gün açıkken 15 dakikada bir ETag ile kontrol edilir, gece sorulmaz; LafPOS siteye Tükendi yazınca hemen bir kez. CDN'deki kopya eskiyince istek sitenin veritabanını uyandırır
              </p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Toggle checked={s.menu.auto} disabled={!canSync} onChange={(v) => setting({ menuAutoSync: v })} label="Otomatik eşitle" />
                <Button size="sm" icon={<RefreshCw className="size-4" />} onClick={() => run('/sync/menu/apply', 'Menü eşitlendi')}>
                  Şimdi eşitle
                </Button>
              </div>
            </>
          ) : (
            <Status ok={false} idle>
              Site bağlantısı kurulmadı: kasa bilgisayarının ayarlarında LAFFOGATO_URL yok. LafPOS siteye hiç bağlanmaz; menü olduğu gibi kalır, görseller ve online siparişler gelmez. Açılış adımları docs/03-ENTEGRASYON.md'de
            </Status>
          )}
        </div>
      </Card>
      <Card flush title="laffogato · online siparişler ve Tükendi">
        <div className="space-y-2 p-4">
          <Status ok={s.online.configured} idle={!s.menu.linked}>
            {s.online.configured
              ? 'İmzalı bağlantı açık (LAFFOGATO_SYNC_SECRET)'
              : s.menu.linked
                ? 'Anahtar yok: online siparişler gelmez, Tükendi yalnız LafPOS\'ta değişir'
                : 'Site bağlantısı kurulmadı: online siparişler gelmez, Tükendi yalnız LafPOS\'ta değişir'}
          </Status>
          {s.online.configured && (
            <>
              <Status ok={s.online.versionSignal}>{s.online.versionSignal ? 'Sipariş sürüm sinyali çalışıyor: 20 sn içinde düşer; gün açıkken 15 dk\'da bir ayrıca tam çekim' : 'Sürüm sinyali yok (site PR\'ı yayında değil): 5 dk\'da bir kontrol'}</Status>
              <Status ok={!s.online.state?.lastError}>
                {s.online.state?.lastSuccessAt ? `Son çekim ${fmtDateTime(s.online.state.lastSuccessAt)} · ${s.online.open} açık online sipariş` : 'Henüz çekilmedi'}
                {s.online.state?.lastError && <span className="block text-danger-500">Hata: {s.online.state.lastError}</span>}
              </Status>
              {s.online.soldOutPush.pending > 0 && (
                <Status ok={false}>
                  Siteye bildirilemeyen Satışta bilgisi: {s.online.soldOutPush.pending} ürün (porsiyon sayacı; yeniden denenecek)
                  {s.online.soldOutPush.lastError && <span className="block text-danger-500">Son hata: {s.online.soldOutPush.lastError}</span>}
                </Status>
              )}
              {s.online.soldOutPush.rejected > 0 && (
                <Status ok={false}>
                  Sitenin reddettiği Satışta bilgisi: {s.online.soldOutPush.rejected} ürün (yeniden denenmeyecek; ürün LafPOS'ta açılınca ya da site aynı duruma gelince kalkar)
                  {!s.online.soldOutPush.pending && s.online.soldOutPush.lastError && <span className="block text-danger-500">Son hata: {s.online.soldOutPush.lastError}</span>}
                </Status>
              )}
              <Toggle checked={s.online.enabled} disabled={!canSync} onChange={(v) => setting({ onlineOrdersSync: v })} label="Online siparişleri çek" />
            </>
          )}
        </div>
      </Card>
      <LafmaliyetCard s={s.lafmaliyet} canSync={canSync} run={run} />
    </div>
  );
}

/**
 * lafmaliyet kartı: bağlantı, kurulum modu kapısı, giden kutusu, son günün lafmaliyet'teki durumu (geçiş günü,
 * eşleşmeyen ürünler), geçmiş günler ve maliyet. Bağlantı yokken sakin dil (sahibin kararı: varsayılan kapalı)
 */
function LafmaliyetCard({ s, canSync, run }: { s: SyncStatus['lafmaliyet']; canSync: boolean; run: (path: string, ok: string) => Promise<void> }) {
  const qc = useQueryClient();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [sending, setSending] = useState(false);
  const from = range?.from ?? s.backfill.from ?? '';
  const to = range?.to ?? s.backfill.to;
  const answer = s.answer ? answerText(s.answer) : null;
  // Son başarılı çekimden sonraki hata (gün sonundaki kendiliğinden çekim de yazar)
  const costsError = s.costsError && (!s.costsAt || (s.costsError.at ?? 0) > s.costsAt) ? s.costsError.message : null;
  const backfill = async () => {
    setSending(true);
    try {
      const r = await post<{ queued: number }>('/sync/lafmaliyet/backfill', { from, to });
      if (r.queued) toast.ok(`${r.queued} gün kuyruğa alındı; gönderim başladı`);
      else toast.info('Bu aralıkta gönderilmemiş kapanmış gün yok');
      setRange(null);
      qc.invalidateQueries({ queryKey: ['sync'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card flush title="lafmaliyet · günlük satış, Z ve maliyet">
      <div className="space-y-2 p-4">
        {!s.configured ? (
          <Status ok={false} idle>
            lafmaliyet bağlantısı kurulmadı: kasa bilgisayarının ayarlarında LAFMALIYET_URL ve LAFMALIYET_SYNC_SECRET yok. Gün sonu gitmez; satış listesi ve Z elle aktarılır (Raporlar › lafmaliyet aktarımı, Kasa › Z). Açılış adımları docs/03-ENTEGRASYON.md'de
          </Status>
        ) : (
          <>
            <Status ok>Bağlı: {s.url}</Status>
            {s.training && (
              <Status ok={false} idle>
                Kurulum modu: günler lafmaliyet'e gönderilmez (örnek PIN'ler açık ya da yazarkasa eğitim simülatöründe). İmzayı sınamak için "Maliyetleri çek" yeterli; gerçek ilk gün kurulum modu kapanınca gider
              </Status>
            )}
            <Status ok={!s.pending}>
              {s.pending ? `Giden kutusunda ${s.pending} gün bekliyor (${s.pendingDays.join(', ')})` : 'Giden kutusu boş'}
              {s.lastError && <span className="block text-danger-500">Son hata: {s.lastError}</span>}
            </Status>
            {answer && (
              <Status ok idle={answer.tone === 'idle'}>
                {answer.text}
              </Status>
            )}
            {!!s.answer?.unmatched?.length && (
              <Status ok={false}>
                lafmaliyet'te eşleşmeyen {s.answer.unmatched.length} ürün ({dayLabel(s.answer.date)}): {unmatchedText(s.answer.unmatched)}
                <span className="block text-xs text-muted">lafmaliyet Ayarlar › LafPOS (kasa)'da Bağla ya da Ürünler › Site menüsü; kayıtlı günler yeniden gönderilmeden bağlanır</span>
              </Status>
            )}

            <div className="space-y-2 border-t border-line pt-3">
              <p className="text-sm font-medium">Geçmiş günler</p>
              <p className="text-xs text-muted">
                {!s.backfill.from
                  ? "lafmaliyet'in geçiş günü henüz bilinmiyor (seçilmedi ya da hiç gün gönderilmedi). Bağlantı sonradan kurulduysa gönderilecek aralığı seçin"
                  : s.backfill.from > s.backfill.to
                    ? `lafmaliyet'teki geçiş günü ${dayLabel(s.backfill.from)}: o güne kadar gönderilecek geçmiş gün yok`
                    : s.backfill.unsent
                      ? `Geçiş günü ${dayLabel(s.backfill.from)}: o günden düne kadar gönderilmemiş ${s.backfill.unsent} kapanmış gün var`
                      : `Geçiş günü ${dayLabel(s.backfill.from)}: o günden bu yana gönderilmemiş kapanmış gün yok`}
                . Daha önce gitmiş gün yeniden gitmez; tek günü yeniden göndermek için Kasa › Geçmiş günler › Z › Gönder
              </p>
              <div className="flex flex-wrap items-end gap-2">
                <Field label="Başlangıç" className="w-40">
                  <Input type="date" value={from} max={to} onChange={(e) => setRange({ from: e.target.value, to })} />
                </Field>
                <Field label="Bitiş" className="w-40">
                  <Input type="date" value={to} min={from || undefined} onChange={(e) => setRange({ from, to: e.target.value })} />
                </Field>
                <Button size="sm" icon={<History className="size-4" />} loading={sending} disabled={!canSync || s.training || !from || !to || from > to} onClick={backfill}>
                  Geçmiş günleri gönder
                </Button>
              </div>
            </div>

            <div className="space-y-2 border-t border-line pt-3">
              <Status ok={!!s.costsAt && !costsError} idle={!s.costsAt && !costsError}>
                {s.costsAt ? `Maliyetler ${fmtDateTime(s.costsAt)} tarihinde çekildi; gün sonunda günde bir kendiliğinden yenilenir` : 'Maliyetler henüz çekilmedi; ilk gün sonunda kendiliğinden çekilir'}
                {costsError && <span className="block text-danger-500">Son deneme: {costsError}</span>}
              </Status>
              <Button size="sm" icon={<CloudDownload className="size-4" />} disabled={!canSync} onClick={() => run('/sync/lafmaliyet/costs/pull', 'Maliyetler çekildi')}>
                Maliyetleri çek
              </Button>
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
