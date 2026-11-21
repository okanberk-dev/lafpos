import { useQuery, useQueryClient } from '@tanstack/react-query';
import { RefreshCw, RotateCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { Badge, Card, DefRow, type Tone } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { toast } from '@/lib/toast';
import { licenseQuery } from '@/components/LicenseStrip';

type UpdateState = 'guncel' | 'indiriliyor' | 'bekliyor' | 'kuruluyor' | 'geri-dondu' | 'hata' | 'kapali';
interface UpdateData {
  installed: { version: string; build: number | null };
  status: {
    durum: UpdateState;
    mesaj: string;
    yeni: { surum: string; build: number } | null;
    sonKontrol: string | null;
    sonBasariliKontrol: string | null;
    sonHata: { mesaj: string; at: string } | null;
    sonKurulum: string | null;
    sonIstek?: string | null;
  } | null;
  /** "Şimdi güncelle" yalnız Windows kurulumunda (bekçinin güncelleyicisi) */
  canRequest?: boolean;
  /** Güncelleyicinin henüz almadığı istek */
  request?: { at: number; simdi: boolean } | null;
  dayOpen?: boolean;
}

const STATE: Record<UpdateState, { label: string; tone: Tone }> = {
  guncel: { label: 'Güncel', tone: 'success' },
  indiriliyor: { label: 'İndiriliyor', tone: 'info' },
  bekliyor: { label: 'Gün kapanınca kurulacak', tone: 'info' },
  kuruluyor: { label: 'Kuruluyor', tone: 'info' },
  'geri-dondu': { label: 'Eski sürüme dönüldü', tone: 'warning' },
  hata: { label: 'Sorun var', tone: 'warning' },
  kapali: { label: 'Kapalı', tone: 'neutral' },
};

/** Derleme numarası HEAD commit'inin zamanıdır: sahibe tarih olarak okunur */
const buildDate = (build: number | null | undefined) => (build ? fmtDateTime(build * 1000) : null);
const at = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? fmtDateTime(Date.parse(iso)) : null);

/** Güncelleyici bir şey yapıyor (istek bekliyor, indiriyor, kuruyor): kart sık yenilenir */
const working = (d: UpdateData | undefined) => !!d && (!!d.request || d.status?.durum === 'indiriliyor' || d.status?.durum === 'kuruluyor');

/**
 * Sürüm ve otomatik güncelleme (Yönetim › Ayarlar ve yedek). Güncellemeyi kafedeki bilgisayarın bekçisi yapar
 * (scripts/kasa/windows/kurulum/guncelle.mjs): yeni sürümü gün kapalıyken kendiliğinden kurar. "Şimdi güncelle" hemen
 * denetletir: gün kapalıysa varsa hemen kurulur; gün açıkken patron onaylarsa hemen (LafPOS bir dakika kadar kapanır),
 * değilse gün sonunda. Kurulum bitince bu sayfa yeni sürümü görür ve yenilemeyi önerir. Git ile çalışan sunucuda durum
 * dosyası yoktur; kart yalnız sürümü söyler
 */
export function UpdateCard() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const q = useQuery({
    queryKey: ['admin', 'guncelleme'],
    queryFn: () => get<UpdateData>('/admin/guncelleme'),
    refetchInterval: (query) => (working(query.state.data) ? 3000 : 60_000),
    retry: 6,
  });
  const d = q.data;
  const st = d?.status;
  const state = st ? STATE[st.durum] : null;
  const [sending, setSending] = useState(false);
  // Sayfa açıldığında kurulu derleme: değişirse (güncelleme kuruldu) ekran eski koddadır, yenilenmeli
  const firstBuild = useRef<number | null | undefined>(undefined);
  if (firstBuild.current === undefined && d) firstBuild.current = d.installed.build;
  const updated = d && firstBuild.current != null && d.installed.build != null && d.installed.build !== firstBuild.current;
  // Merkez (dükkânlar, lisans): kapalıysa satır yok
  const lic = useQuery(licenseQuery).data;

  const request = async () => {
    if (!d || sending) return;
    let simdi = false;
    if (d.dayOpen && me?.role === 'patron') {
      simdi = await confirmDialog({
        title: 'Gün açık: şimdi mi güncellensin',
        body: 'Yeni sürüm varsa hemen kurulur: LafPOS bir dakika kadar kapanır, tabletler bekler, açık adisyonlar kaybolmaz. Vazgeçerseniz gün sonundan sonra kendiliğinden kurulur',
        confirmLabel: 'Şimdi güncelle',
        tone: 'primary',
      });
      if (!simdi) return;
    }
    setSending(true);
    try {
      const next = await post<UpdateData>('/admin/guncelleme', { simdi });
      qc.setQueryData(['admin', 'guncelleme'], next);
      toast.ok(next.dayOpen && !simdi ? 'Yeni sürüm denetleniyor; varsa gün sonunda kurulur' : 'Yeni sürüm denetleniyor; varsa hemen kurulur');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Card
      title="Sürüm ve güncelleme"
      subtitle="Yeni sürüm kendiliğinden iner, gün kapalıyken kurulur; beklemek istemezseniz Şimdi güncelle"
      actions={state ? <Badge tone={state.tone} dot>{state.label}</Badge> : undefined}
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError && !d ? (
        <ErrorState compact title="Sürüm bilgisi alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : d ? (
        <div className="text-sm">
          {updated && (
            <Notice
              tone="success"
              title="Yeni sürüm kuruldu"
              className="mb-3"
              action={
                <Button size="sm" variant="soft" icon={<RotateCw className="size-4" />} onClick={() => window.location.reload()}>
                  Yenile
                </Button>
              }
            >
              Bu ekran eski sürümde açık; yenileyince yeni sürüm gelir
            </Notice>
          )}
          <DefRow label="Kurulu sürüm">
            {d.installed.version || 'Bilinmiyor'}
            {buildDate(d.installed.build) && <span className="font-normal text-[var(--admin-text-mute)]"> · {buildDate(d.installed.build)}</span>}
          </DefRow>
          {st ? (
            <>
              <DefRow label="Durum">{d.request ? 'İstek gönderildi; güncelleyici birkaç saniye içinde bakar' : st.mesaj || state?.label}</DefRow>
              {st.yeni && (
                <DefRow label="Yeni sürüm">
                  {st.yeni.surum} <span className="font-normal text-[var(--admin-text-mute)]">· {buildDate(st.yeni.build)}</span>
                </DefRow>
              )}
              <DefRow label="Son denetim">{at(st.sonBasariliKontrol) ?? 'Henüz yok'}</DefRow>
              {st.sonKurulum && <DefRow label="Son güncelleme">{at(st.sonKurulum)}</DefRow>}
              {st.sonHata && (
                <p className="mt-2 text-[13px] leading-5 text-[var(--admin-text-mute)] [overflow-wrap:anywhere]">
                  {at(st.sonHata.at) ? `${at(st.sonHata.at)} · ` : ''}
                  {st.sonHata.mesaj}
                </p>
              )}
            </>
          ) : (
            <p className="mt-2 text-[13px] leading-5 text-[var(--admin-text-mute)]">
              {d.canRequest ? 'Güncelleyici ilk denetimini yapınca durum burada görünür' : 'Otomatik güncelleme yalnız Windows kurulumunda çalışır; bu sunucu elle güncellenir'}
            </p>
          )}
          {lic?.enabled && (
            <>
              <DefRow label="Lisans">{lic.message}</DefRow>
              <DefRow label="Merkez">
                {lic.ad ? `${lic.ad} · ` : ''}
                {lic.sonGorusme ? `son bağlantı ${fmtDateTime(lic.sonGorusme)}` : 'Henüz bağlanmadı; internet gelince kendini bildirir'}
              </DefRow>
            </>
          )}
          {d.canRequest && (
            <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>button]:grow">
              <Button variant="primary" icon={<RefreshCw className="size-4" />} loading={sending} disabled={working(d) || st?.durum === 'kuruluyor'} onClick={() => void request()}>
                Şimdi güncelle
              </Button>
              {working(d) && <span className="text-xs text-muted">{st?.durum === 'kuruluyor' ? 'Kuruluyor; LafPOS bir dakika içinde yeniden açılır' : 'Denetleniyor…'}</span>}
            </div>
          )}
        </div>
      ) : null}
    </Card>
  );
}
