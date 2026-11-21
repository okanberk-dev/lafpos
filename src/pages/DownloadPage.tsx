import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink, MonitorDown, RefreshCw, ShieldCheck } from 'lucide-react';
import { fmtDateTime } from '@shared/time';
import { buttonClass, Ring } from '@/components/ui/Button';
import { Card, Notice, PageHeader } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { type ChannelManifest, channelVersionQuery, RELEASES_URL, WEB_INSTALLER_NAME, WEB_INSTALLER_PATH } from '@/lib/download';

/** Kurulum adımları: sahibin kafede yapacakları, sade Türkçe */
const STEPS = [
  { title: 'İndirin', text: `${WEB_INSTALLER_NAME} dosyası İndirilenler klasörüne iner. Tarayıcı “sık indirilmiyor” derse Sakla’ya basın.` },
  { title: 'Çift tıklayın', text: 'Windows “Bilgisayarınız korundu” derse Ek bilgi’ye, sonra Yine de çalıştır’a basın. İzin sorusuna Evet deyin.' },
  { title: 'Bekleyin', text: 'Kurulum programı internetten indirip doğrular ve kurar; birkaç dakika sürer. Bitince kasa ekranı açılır.' },
  { title: 'Ayarları girin', text: 'Başlat › LafPOS › LafPOS ayarları. Size verilen satırları yapıştırıp kaydedin (Ctrl+S).' },
];

function VersionLine({ m }: { m: ChannelManifest }) {
  return (
    <p className="mt-2 text-xs text-muted">
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
      <Card title="Siteden kurulum" subtitle="Önerilen: GitHub hesabı ya da anahtar gerekmez">
        <div className="p-5">
          <ol className="space-y-4">
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
          <a href={WEB_INSTALLER_PATH} download={WEB_INSTALLER_NAME} className={buttonClass('primary', 'lg', { ring: true, className: 'mt-6 max-sm:w-full max-sm:justify-between' })}>
            LafPOS’u indir
            <Ring />
          </a>
          {manifest.data && <VersionLine m={manifest.data} />}
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

/** Kafeden henüz veri gelmediğinde (kabuk açılamaz) aynı içerik, kabuksuz */
export function StandaloneDownloadPage({ onBack }: { onBack?: () => void }) {
  return (
    <div className="min-h-full bg-bg p-4 sm:p-6">
      <div className="mx-auto max-w-5xl">
        <div className="flex items-center gap-2 pb-4">
          <Download aria-hidden="true" className="size-5 text-muted" />
          <h1 className="text-xl font-bold sm:text-[22px]">Programı indir</h1>
        </div>
        <Notice tone="info" role="note" className="mb-4">
          Kafeden henüz veri gelmedi; program kurulup ayarlar girilince canlı görünüm başlar
        </Notice>
        <DownloadContent />
        {onBack && (
          <button type="button" onClick={onBack} className={buttonClass('ghost', 'md', { className: 'mt-4' })}>
            Geri dön
          </button>
        )}
      </div>
    </div>
  );
}
