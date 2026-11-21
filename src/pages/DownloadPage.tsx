import { useQuery } from '@tanstack/react-query';
import { ExternalLink, MonitorDown, RefreshCw, ShieldCheck } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { fmtDateTime } from '@shared/time';
import { LafTile } from '@/components/LafMark';
import { Button, buttonClass, Ring } from '@/components/ui/Button';
import { Card, Notice, PageHeader } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { type ChannelManifest, channelVersionQuery, RELEASES_URL, WEB_INSTALLER_NAME, WEB_INSTALLER_PATH } from '@/lib/download';
import { useRemoteSignOut } from '@/lib/remote';

/** Kurulum adımları: sahibin kafede yapacakları, sade Türkçe */
const STEPS = [
  { title: 'İndirin', text: `${WEB_INSTALLER_NAME} dosyası İndirilenler klasörüne iner. Tarayıcı “sık indirilmiyor” derse Sakla’ya basın.` },
  { title: 'Çift tıklayın', text: 'Windows “Bilgisayarınız korundu” derse Ek bilgi’ye, sonra Yine de çalıştır’a basın. İzin sorusuna Evet deyin.' },
  { title: 'Bekleyin', text: 'Kurulum programı internetten indirip doğrular ve kurar; birkaç dakika sürer. Bitince kasa ekranı açılır.' },
  { title: 'Bilgileri girin', text: 'Patron PIN’iyle girin, Yönetim › Bağlantı bilgileri’nde size verilen satırları yapıştırıp kaydedin. Pavo’yu Yönetim › Yazarkasa POS’tan eşleştirin.' },
];

function VersionLine({ m }: { m: ChannelManifest }) {
  return (
    <p className="text-xs text-muted">
      Son sürüm {m.version} · {fmtDateTime(Date.parse(m.date))}
    </p>
  );
}

/** İndirme içeriği: kabuğun içinde (Stage) ya da kafeden veri gelmediğinde kabuksuz aynı kartlar */
export function DownloadContent() {
  // Güncelleme kanalının dosyası (statik, herkese açık): sürüm ve tarih yazılır; okunamazsa satır görünmez
  const manifest = useQuery({ ...channelVersionQuery, retry: false });
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <Card title="Siteden kurulum" subtitle="Önerilen yol: hesap ya da anahtar gerekmez">
        <div className="p-5">
          {/* Ana eylem kartın başında: önce indirilir, adımlar sonrasını anlatır */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <a href={WEB_INSTALLER_PATH} download={WEB_INSTALLER_NAME} className={buttonClass('primary', 'lg', { ring: true, className: 'max-sm:w-full max-sm:justify-between' })}>
              LafPOS’u indir
              <Ring />
            </a>
            {manifest.data && <VersionLine m={manifest.data} />}
          </div>
          <ol className="mt-5 space-y-4 border-t border-line pt-5">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--admin-primary-soft)] text-sm font-semibold text-[var(--admin-primary)]">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="font-semibold">{s.title}</p>
                  <p className="mt-0.5 text-pretty text-sm text-muted">{s.text}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </Card>
      <div className="grid content-start gap-4">
        <Card title="Bilmeniz gerekenler">
          <ul className="space-y-3 p-5 text-sm">
            <li className="flex gap-2.5">
              <MonitorDown aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="text-pretty">64 bit Windows 10 ya da 11 ve internet bağlantısı gerekir; kurulum yönetici izni ister.</span>
            </li>
            <li className="flex gap-2.5">
              <ShieldCheck aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="text-pretty">Her parça indirilince doğrulanır; dosyada parola ya da anahtar yoktur.</span>
            </li>
            <li className="flex gap-2.5">
              <RefreshCw aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted" />
              <span className="text-pretty">Yeniden çalıştırmak onarır ya da son sürüme günceller. Veriler ve ayarlar kalır.</span>
            </li>
          </ul>
        </Card>
        <Card title="Kurulum dosyası (GitHub)" subtitle="Alternatif: depoya erişimi olan GitHub hesabıyla">
          <div className="p-5">
            <p className="text-pretty text-sm text-muted">Tek dosyalık LafPOS-Kurulum.exe, internet beklemeden kurar. GitHub’a girip sayfadaki Assets altından indirin.</p>
            <a href={RELEASES_URL} target="_blank" rel="noreferrer" className={buttonClass('secondary', 'md', { className: 'mt-4 max-sm:w-full' })}>
              <ExternalLink aria-hidden="true" className="size-4" />
              GitHub’da aç
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}

/** LafPOS Uzaktan › İndir: girişten sonra; Windows programını siteden kurar (docs/07-UZAKTAN-ERISIM.md) */
export default function DownloadPage() {
  return (
    <Stage leafLabel="Programı indir" float>
      <div className="lp-leaf-pad">
        <PageHeader title="Programı indir" subtitle="LafPOS’u kafedeki Windows bilgisayara kurun; sonraki sürümler kendiliğinden gelir" />
        <DownloadContent />
      </div>
    </Stage>
  );
}

/**
 * Kabuksuz İndir: kafe henüz bağlanmadıysa (özet yok, kabuk açılamaz) üyenin girişten sonra gördüğü ilk sayfa. Açılış
 * verisini kendisi sormaz (yeni gözlemci hatalı sorguyu yeniden başlatır, ekran bekleme ekranına dönerdi): durumu
 * kabuktan alır. Kafe bağlandı mı diye yarım dakikada bir hafif uca bakar; bağlanınca (yok → var) canlı görünüm açılır
 */
export function StandaloneDownloadPage({ waiting, retrying, onRetry }: { waiting: boolean; retrying: boolean; onRetry: () => void }) {
  const signOut = useRemoteSignOut();
  const status = useQuery({ queryKey: ['uzaktan', 'durum', 'bekle'], queryFn: () => get<{ at: number | null }>('/uzaktan/durum'), enabled: waiting, refetchInterval: 30_000, retry: false });
  // Yalnız geçiş sayılır: sayfa açıldığında zaten var olan özet yeniden denemeyi tetiklemez (döngü olmaz)
  const firstAt = useRef<number | null | undefined>(undefined);
  const at = status.data?.at;
  useEffect(() => {
    if (at === undefined) return;
    if (firstAt.current === undefined) firstAt.current = at;
    else if (firstAt.current == null && at != null) onRetry();
  }, [at, onRetry]);

  return (
    <div className="min-h-full bg-bg px-4 py-6 sm:px-8 sm:py-10">
      <div className="mx-auto max-w-5xl">
        <header className="flex items-center gap-3 pb-6">
          <LafTile size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-medium text-muted">LafPOS Uzaktan</p>
            <h1 className="text-[22px] font-bold leading-tight tracking-[-0.03em] sm:text-[28px]">Programı indir</h1>
          </div>
          {signOut && (
            <Button size="md" variant="ghost" onClick={() => void useAuth.getState().logout()}>
              Çıkış
            </Button>
          )}
        </header>
        {waiting ? (
          <Notice tone="info" role="status" className="mb-4" title="Kafe henüz bağlanmadı">
            Program kurulup ayarlar girilince canlı görünüm burada kendiliğinden açılır
          </Notice>
        ) : (
          <Notice
            tone="warn"
            role="status"
            className="mb-4"
            title="Canlı görünüm şu an açılamadı"
            action={
              <Button size="sm" variant="secondary" loading={retrying} onClick={onRetry}>
                Yeniden dene
              </Button>
            }
          >
            Program yine de buradan indirilebilir
          </Notice>
        )}
        <DownloadContent />
      </div>
    </div>
  );
}
