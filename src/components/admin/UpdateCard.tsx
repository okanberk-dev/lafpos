import { useQuery } from '@tanstack/react-query';
import { fmtDateTime } from '@shared/time';
import { Badge, Card, DefRow, type Tone } from '@/components/admin/ui';
import { ErrorState, Skeleton } from '@/components/ui/misc';
import { get } from '@/lib/api';

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
  } | null;
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

/**
 * Sürüm ve otomatik güncelleme (Yönetim › Ayarlar ve yedek; salt okunur). Güncellemeyi kafedeki bilgisayarın bekçisi
 * yapar (scripts/kasa/windows/kurulum/guncelle.mjs): yeni sürümü gün kapalıyken kurar. Git ile çalışan sunucuda durum
 * dosyası yoktur; kart yalnız sürümü söyler
 */
export function UpdateCard() {
  const q = useQuery({ queryKey: ['admin', 'guncelleme'], queryFn: () => get<UpdateData>('/admin/guncelleme'), refetchInterval: 60_000 });
  const d = q.data;
  const st = d?.status;
  const state = st ? STATE[st.durum] : null;
  return (
    <Card
      title="Sürüm ve güncelleme"
      subtitle="Yeni sürüm kendiliğinden iner, gün kapalıyken kurulur"
      actions={state ? <Badge tone={state.tone} dot>{state.label}</Badge> : undefined}
    >
      {q.isPending ? (
        <Skeleton className="h-24" />
      ) : q.isError && !d ? (
        <ErrorState compact title="Sürüm bilgisi alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : d ? (
        <div className="text-sm">
          <DefRow label="Kurulu sürüm">
            {d.installed.version || 'Bilinmiyor'}
            {buildDate(d.installed.build) && <span className="font-normal text-[var(--admin-text-mute)]"> · {buildDate(d.installed.build)}</span>}
          </DefRow>
          {st ? (
            <>
              <DefRow label="Durum">{st.mesaj || state?.label}</DefRow>
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
            <p className="mt-2 text-[13px] leading-5 text-[var(--admin-text-mute)]">Otomatik güncelleme yalnız Windows kurulumunda çalışır; bu sunucu elle güncellenir</p>
          )}
        </div>
      ) : null}
    </Card>
  );
}
