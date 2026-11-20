import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert, CloudDownload, History, Info, RefreshCw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Toggle } from '@/components/ui/Field';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { Card, CARD, CODE, PageHeader, SetupNotes } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { answerText, type DayAnswer, dayLabel, unmatchedCount, unmatchedText } from '@/lib/lafmaliyet';
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
    /** Masa QR kodlarının siteye gidişi; eski sunucu göndermez, anahtar yokken null */
    tablesPush?: { lastSentAt?: number; lastTriedAt?: number; unsupported?: boolean; lastError?: string | null } | null;
  };
  /** Sitedeki karaoke rezervasyonları (§2.4); `on`: anahtar var ve planda oda var */
  karaoke: { on: boolean; date: string | null; pulledAt: number | null; count: number; lastError: string | null; lastErrorAt: number | null; closed: boolean };
  lafmaliyet: {
    configured: boolean;
    url: string | null;
    /** Kurulum modu: günler gönderilmez */
    training: boolean;
    pending: number;
    /** Denenip gidemeyenler; kuyruğa yeni girip sırasını bekleyen gün hata değildir */
    failing: number;
    pendingDays: string[];
    lastError: string | null;
    push: { lastRunAt?: number; sent?: number; failed?: number } | null;
    /** Son gönderilen günün lafmaliyet yanıtı */
    answer: DayAnswer | null;
    /** "Geçmiş günleri gönder"in varsayılanı: lafmaliyet'in geçiş gününden düne */
    backfill: { from: string | null; to: string; unsent: number | null };
    /** Yalnız maliyet yetkisine gelir (`rapor.maliyet`) */
    costsAt?: number | null;
    costsError?: { message: string; at: number | null } | null;
  };
}

/**
 * Durum satırı; ikon sırayla: `error` hata (kırmızı çarpı, yazarkasa sayfasındaki gibi), `idle` bilerek kapalı ya da
 * henüz denenmedi (sakin bilgi), `ok` çalıştığı görüldü (yeşil onay), hiçbiri değilse dikkat (amber). Yeşil ancak
 * karşı taraftan yanıt alınınca: "Henüz eşitlenmedi" onay almaz. Satırda tek durum rengi: dikkat satırının ayrıntısı
 * gri, kırmızı yalnız hata satırında
 */
function Status({ ok, idle, error, children }: { ok?: boolean; idle?: boolean; error?: boolean; children: React.ReactNode }) {
  // Yumuşak durum paneli (pano, 20 Kas 2026): açık gri zemin, köşe 10; ikon durumun renginde küçük beyaz dairede.
  // Zemin hep nötr: renk yalnız ikonda (satırda tek durum rengi kuralı)
  return (
    <div className="flex items-start gap-2.5 rounded-[var(--r-control)] bg-[var(--admin-surface-2)] px-3 py-2.5 text-sm">
      <span aria-hidden="true" className="grid size-6 shrink-0 place-items-center rounded-full bg-[var(--admin-surface)] ring-1 ring-inset ring-[var(--admin-border)] [&>svg]:size-3.5">
        {error ? (
          <XCircle className="text-[var(--admin-danger-ink)]" />
        ) : idle ? (
          <Info className="text-[var(--admin-text-mute)]" />
        ) : ok ? (
          <CheckCircle2 className="text-[var(--admin-success)]" />
        ) : (
          <CircleAlert className="text-[var(--admin-warning)]" />
        )}
      </span>
      <span className="min-w-0 pt-0.5">{children}</span>
    </div>
  );
}

/** Hata satırının ayrıntısı (kırmızı) */
const ERR = 'block text-[var(--admin-danger-ink)] [overflow-wrap:anywhere]';
/** Dikkat satırının ayrıntısı: gri, satırda ikinci bir durum rengi olmasın */
const DETAIL = 'block text-xs text-muted [overflow-wrap:anywhere]';
/** Kartın içindeki bölüm: aynı ayraç ve boşluk */
const SECTION = 'space-y-2 border-t border-[var(--admin-divider)] pt-3';

/** Kart alt başlığındaki adres: uzun adres dar ekranda taşmaz */
const address = (url: string | null | undefined) => (url ? <span className="[overflow-wrap:anywhere]">{url}</span> : undefined);

export default function IntegrationAdmin() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['sync', 'status'], queryFn: () => get<SyncStatus>('/sync/status'), refetchInterval: 30_000 });
  // Elle tetiklenen işlem sürerken düğmesi döner gösterge alır (çift istek gitmesin)
  const [busy, setBusy] = useState<string | null>(null);
  const setting = async (body: Record<string, boolean>) => {
    try {
      await put('/sync/settings', body);
      qc.invalidateQueries({ queryKey: ['sync'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  // Elle tetiklenen işlemden sonra durum her sonuçta yenilenir: sunucu hatayı da kaydeder, kart 30 sn'lik yoklamayı
  // beklemeden onu gösterir (yalnız kaybolan bildirimde kalmaz)
  /** Masa QR kodlarını siteye yeniden gönder (site ucu sonradan açıldıysa 6 saatlik turu beklemeden) */
  const resendTables = async () => {
    setBusy('tables');
    try {
      const r = await post<{ sent: number; failed: number }>('/admin/tables/qr/sync');
      if (r.sent) toast.ok('Masa kodları siteye gönderildi');
      else toast.warn('Site masa kodlarını henüz almıyor; 6 saatte bir yeniden denenecek');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['sync'] });
    }
  };
  const run = async (path: string, ok: string) => {
    setBusy(path);
    try {
      const r = await post<{ warning?: string }>(path);
      if (r?.warning) toast.warn(r.warning);
      else toast.ok(ok);
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['sync'] });
    }
  };
  const header = <PageHeader title="Site ve lafmaliyet" description="Ürünler siteden gelir, satış ve Z lafmaliyet’e gider" />;
  if (!data.data)
    return (
      <div className="space-y-4">
        {header}
        {data.isError ? (
          <ErrorState className={CARD} title="Bağlantı durumu alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="space-y-4">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-36 rounded-2xl" />
            ))}
          </div>
        )}
      </div>
    );
  const s = data.data;
  const canSync = can('senkron.yonet');
  const menu = s.menu.state;
  const orders = s.online.state;
  // Sipariş çekimi anahtar ve "Online siparişleri çek" ikisi açıkken (sunucunun turu kapalıyken sipariş çekmez, yalnız
  // karaoke işaretini okur): kapalıyken kart siparişin düştüğünü söylemez, son çekim yeşil onay almaz
  const pulling = s.online.configured && s.online.enabled;

  return (
    <div className="space-y-4">
      {header}
      {/* Adres kartın alt başlığında (telefonda başlığa sıkışmaz); sağlığı durum satırları söyler */}
      <Card title="laffogato · menü" subtitle={s.menu.linked ? address(boot.integrations.laffogatoUrl) : undefined}>
        <div className="space-y-2">
          {s.menu.linked ? (
            <>
              <Status ok={!!menu?.lastSuccessAt} idle={!menu?.lastSuccessAt} error={!!menu?.lastError}>
                {menu?.lastSuccessAt ? `Son başarılı kontrol ${fmtDateTime(menu.lastSuccessAt)}` : 'Henüz eşitlenmedi'}
                {menu?.lastError && <span className={ERR}>Hata: {menu.lastError}</span>}
              </Status>
              <p className="text-xs text-muted">Gün açıkken 15 dakikada bir kontrol edilir, gece sorulmaz; LafPOS siteye Tükendi yazınca hemen bir kez</p>
              <div className="flex flex-wrap items-center gap-3 pt-1">
                <Toggle checked={s.menu.auto} disabled={!canSync} onChange={(v) => setting({ menuAutoSync: v })} label="Otomatik eşitle" />
                <Button size="sm" icon={<RefreshCw className="size-4" />} loading={busy === '/sync/menu/apply'} onClick={() => void run('/sync/menu/apply', 'Menü eşitlendi')}>
                  Şimdi eşitle
                </Button>
              </div>
            </>
          ) : (
            <Status idle>Site bağlantısı kurulmadı: LafPOS siteye hiç bağlanmaz; menü olduğu gibi kalır, görseller ve online siparişler gelmez</Status>
          )}
        </div>
      </Card>
      <Card title="laffogato · online siparişler ve Tükendi">
        <div className="space-y-2">
          {/* Anahtarın varlığı bağlantının çalıştığını söylemez: ilk başarılı çekime dek sakin. Çekim kapalıysa (anahtar
              tanımlı olsa da) sakin ve kapalı olduğunu söyler */}
          <Status ok={pulling && !!orders?.lastSuccessAt} idle={s.online.configured ? !pulling || !orders?.lastSuccessAt : !s.menu.linked}>
            {s.online.configured
              ? s.online.enabled
                ? 'Anahtar tanımlı, siparişler imzalı bağlantıyla çekilir'
                : 'Online sipariş çekimi kapalı: uygulama ve web siparişleri kasaya düşmez'
              : s.menu.linked
                ? 'Anahtar yok: online siparişler gelmez, Tükendi yalnız LafPOS’ta değişir'
                : 'Site bağlantısı kurulmadı: online siparişler gelmez, Tükendi yalnız LafPOS’ta değişir'}
          </Status>
          {s.online.configured && (
            <>
              {s.online.enabled && (
                <Status ok={s.online.versionSignal && !!orders?.lastSuccessAt} idle={s.online.versionSignal && !orders?.lastSuccessAt}>
                  {s.online.versionSignal
                    ? 'Yeni online sipariş 20 sn içinde kasaya düşer; gün açıkken 15 dakikada bir liste ayrıca yenilenir'
                    : 'Site anlık bildirim göndermiyor: online siparişler 5 dakikada bir kontrol edilir'}
                </Status>
              )}
              {/* Kapalıyken son çekim eski bilgidir: onay almaz */}
              <Status ok={pulling && !!orders?.lastSuccessAt} idle={!pulling || !orders?.lastSuccessAt} error={!!orders?.lastError}>
                {orders?.lastSuccessAt ? `Son çekim ${fmtDateTime(orders.lastSuccessAt)} · ${s.online.open} açık online sipariş` : 'Henüz çekilmedi'}
                {orders?.lastError && <span className={ERR}>Hata: {orders.lastError}</span>}
              </Status>
              {s.online.soldOutPush.pending > 0 && (
                <Status>
                  Satışta bilgisi siteye gidemedi: {s.online.soldOutPush.pending} ürün; yeniden denenecek
                  {s.online.soldOutPush.lastError && <span className={DETAIL}>Son hata: {s.online.soldOutPush.lastError}</span>}
                </Status>
              )}
              {s.online.soldOutPush.rejected > 0 && (
                <Status>
                  Site {s.online.soldOutPush.rejected} ürünün Satışta bilgisini reddetti; ürün LafPOS’ta açılınca ya da sitede aynı duruma gelince kalkar
                  {!s.online.soldOutPush.pending && s.online.soldOutPush.lastError && <span className={DETAIL}>Son hata: {s.online.soldOutPush.lastError}</span>}
                </Status>
              )}
              {s.online.tablesPush?.unsupported && (
                <Status idle>
                  Masa QR kodları siteye gönderildi ama site henüz almıyor: QR’lar menüyü açar, uygulamadan masaya sipariş site güncellenince düşer; 6 saatte bir yeniden denenir.{' '}
                  <button type="button" disabled={busy === 'tables'} aria-busy={busy === 'tables' || undefined} className="min-h-11 font-medium text-primary underline underline-offset-2 disabled:cursor-progress disabled:opacity-60 pointer-fine:min-h-6" onClick={() => void resendTables()}>
                    {busy === 'tables' ? 'Gönderiliyor…' : 'Şimdi yeniden gönder'}
                  </button>
                </Status>
              )}
              {s.online.tablesPush?.lastError && !s.online.tablesPush.unsupported && (
                <Status error>
                  Masa QR kodları siteye gidemedi
                  <span className={ERR}>Hata: {s.online.tablesPush.lastError}</span>
                </Status>
              )}
              {s.online.tablesPush?.lastSentAt && !s.online.tablesPush.lastError && !s.online.tablesPush.unsupported && (
                <Status ok>Masa QR kodları sitede: {fmtDateTime(s.online.tablesPush.lastSentAt)}</Status>
              )}
              <Toggle checked={s.online.enabled} disabled={!canSync} onChange={(v) => setting({ onlineOrdersSync: v })} label="Online siparişleri çek" />
              <KaraokeStatus k={s.karaoke} />
            </>
          )}
        </div>
      </Card>
      <LafmaliyetCard s={s.lafmaliyet} canSync={canSync} canCost={can('rapor.maliyet')} run={run} busy={busy} />
      <SetupNotes>
        <p>
          Kasa bilgisayarının ayarları: site için <code className={CODE}>LAFFOGATO_URL</code> ve <code className={CODE}>LAFFOGATO_SYNC_SECRET</code>, lafmaliyet için <code className={CODE}>LAFMALIYET_URL</code> ve <code className={CODE}>LAFMALIYET_SYNC_SECRET</code> (en az 32 karakter). Adres yoksa o sisteme hiç istek gitmez.
        </p>
        <p>
          Karaoke rezervasyonları sitede <code className={CODE}>LAFPOS_SYNC_SECRET</code> tanımlıysa ve anahtar aynıysa açılır. Masa QR kodları sitenin <code className={CODE}>PUT /api/panel/tables</code> ucuna gider.
        </p>
        <p>Menü ETag ile sorulur; CDN’deki kopya eskiyince istek sitenin veritabanını uyandırır.</p>
        <p>
          Açılış adımları ve sözleşme: <code className={CODE}>docs/03-ENTEGRASYON.md</code> (lafmaliyet §8).
        </p>
      </SetupNotes>
    </div>
  );
}

/**
 * Sitedeki karaoke rezervasyonlarının okunması (§2.4): siparişlerle aynı sürüm sinyalinden, "Online siparişleri çek"
 * kapalıyken de. Planda oda yoksa hiç okunmaz
 */
function KaraokeStatus({ k }: { k: SyncStatus['karaoke'] }) {
  if (!k.on) {
    return (
      <div className={SECTION}>
        <Status idle>Karaoke rezervasyonları okunmuyor: masa planında karaoke odası (oda türünde masa) yok</Status>
      </div>
    );
  }
  return (
    <div className={SECTION}>
      <Status ok={!!k.pulledAt} idle={k.closed || !k.pulledAt} error={!!k.lastError && !k.closed}>
        {k.closed
          ? 'Site karaoke rezervasyonlarını LafPOS’a açmadı: sitedeki anahtar eksik ya da farklı'
          : k.pulledAt
            ? `Karaoke rezervasyonları: son çekim ${fmtDateTime(k.pulledAt)} · ${k.count} rezervasyon (${k.date})`
            : 'Karaoke rezervasyonları henüz çekilmedi: gün açılınca ya da oda adisyonu açılınca'}
        {k.lastError && !k.closed && <span className={ERR}>Hata: {k.lastError}</span>}
      </Status>
      <p className="text-xs text-muted">Gün açıkken site rezervasyon değişince, en sık 5 dakikada bir; oda adisyonu açılınca ve elle. “Online siparişleri çek” kapalıyken de okunur</p>
    </div>
  );
}

/**
 * lafmaliyet kartı: bağlantı, kurulum modu kapısı, giden kutusu, son günün lafmaliyet'teki durumu (geçiş günü,
 * eşleşmeyen ürünler), geçmiş günler ve maliyet. Bağlantı yokken sakin dil (sahibin kararı: varsayılan kapalı)
 */
function LafmaliyetCard({ s, canSync, canCost, run, busy }: { s: SyncStatus['lafmaliyet']; canSync: boolean; canCost: boolean; run: (path: string, ok: string) => Promise<void>; busy: string | null }) {
  const qc = useQueryClient();
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [sending, setSending] = useState(false);
  const from = range?.from ?? s.backfill.from ?? '';
  const to = range?.to ?? s.backfill.to;
  const answer = s.answer ? answerText(s.answer) : null;
  const unmatched = s.answer ? unmatchedCount(s.answer) : 0;
  // Son başarılı çekimden sonraki hata (gün sonundaki kendiliğinden çekim de yazar)
  const costsError = s.costsError && (!s.costsAt || (s.costsError.at ?? 0) > s.costsAt) ? s.costsError.message : null;
  const backfill = async () => {
    setSending(true);
    try {
      const r = await post<{ queued: number; training?: number }>('/sync/lafmaliyet/backfill', { from, to });
      // Kurulum modunda kapanan günler hiç gitmez (eğitim günü)
      const training = r.training ? `; ${r.training} eğitim günü (kurulum modunda kapandı) gönderilmez` : '';
      if (r.queued) toast.ok(`${r.queued} gün kuyruğa alındı, gönderim başladı${training}`);
      else toast.info(`Bu aralıkta gönderilecek kapanmış gün yok${training}`);
      setRange(null);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSending(false);
      // Başarısız istekte de: giden kutusu ve hata kartta hemen görünür
      void qc.invalidateQueries({ queryKey: ['sync'] });
    }
  };

  return (
    // Adres alt başlıkta; bağlantının sağlığını giden kutusu satırı söyler (adresin tanımlı olması "bağlı" demek değil)
    <Card title="lafmaliyet · günlük satış, Z ve maliyet" subtitle={s.configured ? address(s.url) : undefined}>
      <div className="space-y-2">
        {!s.configured ? (
          <Status idle>
            {s.url ? `lafmaliyet bağlantısı yarım: adres var (${s.url}), anahtar eksik ya da kısa.` : 'lafmaliyet bağlantısı kurulmadı.'} Gün sonu gitmez; satış listesi ve Z elle aktarılır (Raporlar › lafmaliyet aktarımı, Kasa › Z)
          </Status>
        ) : (
          <>
            {s.training && (
              <Status idle>
                Kurulum modu: günler lafmaliyet’e gönderilmez (örnek PIN’ler açık ya da yazarkasa eğitim simülatöründe). Bu modda kapanan gün eğitim günüdür, kurulum modu kapansa da hiç gitmez.{canCost ? ' Bağlantıyı denemek için “Maliyetleri çek” yeterli.' : ''} Gerçek ilk gün kurulum modu kapandıktan sonra açılıp kapanınca gider
              </Status>
            )}
            <Status ok={!s.failing} idle={!!s.pending && !s.failing} error={!!s.failing}>
              {!s.pending
                ? 'Giden kutusu boş'
                : s.failing
                  ? `Giden kutusunda ${s.pending} gün, ${s.failing} gün gönderilemedi (${s.pendingDays.join(', ')})`
                  : `Giden kutusunda ${s.pending} gün sırasını bekliyor, dakikada 20 gün gider (${s.pendingDays.join(', ')})`}
              {s.lastError && <span className={ERR}>Son hata: {s.lastError}</span>}
            </Status>
            {answer && (
              <Status ok idle={answer.tone === 'idle'}>
                {answer.text}
              </Status>
            )}
            {s.answer && unmatched > 0 && (
              <Status>
                lafmaliyet’te eşleşmeyen {unmatched} ürün ({dayLabel(s.answer.date)}){s.answer.unmatched?.length ? `: ${unmatchedText(s.answer.unmatched, unmatched)}` : ''}
                <span className={DETAIL}>lafmaliyet Ayarlar › LafPOS (kasa) bölümünde Bağla ya da Ürünler › Site menüsü; kayıtlı günler yeniden gönderilmeden bağlanır</span>
              </Status>
            )}

            <div className={SECTION}>
              <h3 className="text-[13px] font-semibold">Geçmiş günler</h3>
              <p className="text-xs text-muted">
                {!s.backfill.from
                  ? 'lafmaliyet’in geçiş günü henüz bilinmiyor (seçilmedi ya da hiç gün gönderilmedi). Bağlantı sonradan kurulduysa gönderilecek aralığı seçin'
                  : s.backfill.from > s.backfill.to
                    ? `lafmaliyet’teki geçiş günü ${dayLabel(s.backfill.from)}: o güne kadar gönderilecek geçmiş gün yok`
                    : s.backfill.unsent
                      ? `Geçiş günü ${dayLabel(s.backfill.from)}: o günden düne kadar gönderilmemiş ${s.backfill.unsent} kapanmış gün var`
                      : `Geçiş günü ${dayLabel(s.backfill.from)}: o günden bu yana gönderilmemiş kapanmış gün yok`}
                . Daha önce gitmiş gün yeniden gitmez; tek günü yeniden göndermek için Kasa › Geçmiş günler › Z › Gönder
              </p>
              {/* Telefonda iki tarih yan yana, düğme altta tam genişlik; genişte tek satır */}
              <div className="grid grid-cols-2 items-end gap-2 sm:flex sm:flex-wrap">
                <Field label="Başlangıç" className="sm:w-40">
                  <Input type="date" value={from} max={to} onChange={(e) => setRange({ from: e.target.value, to })} />
                </Field>
                <Field label="Bitiş" className="sm:w-40">
                  <Input type="date" value={to} min={from || undefined} onChange={(e) => setRange({ from, to: e.target.value })} />
                </Field>
                <Button size="sm" className="col-span-2 sm:col-auto" icon={<History className="size-4" />} loading={sending} disabled={!canSync || s.training || !from || !to || from > to} onClick={backfill}>
                  Geçmiş günleri gönder
                </Button>
              </div>
            </div>

            {/* Maliyet yalnız maliyet yetkisine: personel maliyetin varlığını da görmez (sunucu tarihi de göndermez) */}
            {canCost && (
              <div className={SECTION}>
                <Status ok={!!s.costsAt} idle={!s.costsAt} error={!!costsError}>
                  {s.costsAt ? `Maliyetler ${fmtDateTime(s.costsAt)} tarihinde çekildi; her gün sonunda kendiliğinden yenilenir` : 'Maliyetler henüz çekilmedi; ilk gün sonunda kendiliğinden çekilir'}
                  {costsError && <span className={ERR}>Son deneme: {costsError}</span>}
                </Status>
                <Button size="sm" icon={<CloudDownload className="size-4" />} loading={busy === '/sync/lafmaliyet/costs/pull'} disabled={!canSync} onClick={() => void run('/sync/lafmaliyet/costs/pull', 'Maliyetler çekildi')}>
                  Maliyetleri çek
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
