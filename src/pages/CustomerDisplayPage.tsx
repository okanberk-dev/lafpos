import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useState } from 'react';
import { useSearchParams } from 'react-router';
import type { CustomerDisplaySettings, DisplayConfigDTO, DisplayStateDTO } from '@shared/types';
import { CustomerDisplayView, DISPLAY_DEFAULTS } from '@/components/display/CustomerDisplayView';
import { get } from '@/lib/api';
import { DISPLAY_CONFIG_KEY } from '@/lib/bootDark';
import { useTick } from '@/lib/hooks';
import { useBusinessName } from '@/lib/publicInfo';
import { staleReload } from '@/lib/staleReload';
import { useTheme } from '@/lib/theme';
import { useWakeLock } from '@/lib/wakelock';

/** "Teşekkürler" bu kadar kalır, sonra hoş geldiniz; çağrı numarası varsa müşteri onu okuyabilsin diye biraz daha */
const THANKS_MS = 10_000;
const THANKS_CALL_MS = 15_000;
/** Son görünüm bu cihazda saklanır: sonraki açılışta ilk kare doğru temada (ayar gelmeden; bootDark okur) */
const CONFIG_KEY = DISPLAY_CONFIG_KEY;
/**
 * Bu kadar süre kasadan yanıt gelmezse (bağlantı koptu, sunucu yeniden başladı) sayfa, kasa yeniden yanıt verince
 * sessizce yenilenir (`staleReload`)
 */
const STALE_RELOAD_MS = 90_000;
/** Yenilemeler arası en az süre (kasa yanıt verdiği halde ekranın sorguları düzelmiyorsa ekran sürekli yanıp sönmesin) */
const RELOAD_GAP_MS = 5 * 60_000;
const RELOAD_KEY = 'lafpos.musteri.yenileme';

function reloadPage() {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0);
    if (Date.now() - last < RELOAD_GAP_MS) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    /* depolama yoksa yine yenile */
  }
  window.location.reload();
}

function cachedConfig(): DisplayConfigDTO | undefined {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    return raw ? ({ ...DISPLAY_DEFAULTS, businessName: '', ...JSON.parse(raw) } as DisplayConfigDTO) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Müşteri ekranı (iki ekranlı kasanın ikinci monitörü ya da müşteriye dönük tablet): kasadaki adisyonun kalemleri ve
 * tutarı, ödeme bitince teşekkür, boşta karşılama. Kasa Adisyon › İşlemler › Müşteri ekranı'ndan yansıtır; ekran adı
 * ?ekran=. Personel girişi istemez. Görünüm Yönetim › Müşteri ekranı'ndan (tema, metinler, duyurular, karekod);
 * `?tema=acik` ayarın temasını porselene çevirir (eski kurulum adresleri).
 */
export default function CustomerDisplayPage() {
  const businessName = useBusinessName();
  const now = useTick(2_000);
  const [params] = useSearchParams();
  const code = (params.get('ekran') ?? 'kasa').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'kasa';
  useWakeLock(true);
  const config = useQuery({ queryKey: ['display-config'], queryFn: () => get<DisplayConfigDTO>('/public/display-config'), refetchInterval: 30_000, initialData: cachedConfig, initialDataUpdatedAt: 0 });
  useEffect(() => {
    if (!config.data || !config.dataUpdatedAt) return;
    try {
      localStorage.setItem(CONFIG_KEY, JSON.stringify(config.data));
    } catch {
      /* özel pencere */
    }
  }, [config.data, config.dataUpdatedAt]);
  const settings: CustomerDisplaySettings = { ...DISPLAY_DEFAULTS, ...config.data, ...(params.get('tema') === 'acik' ? { theme: 'porselen' as const } : {}) };
  // Sayfanın kendi teması ekranın temasını izler (kaydırma çubuğu, odak): porselen açık, gece ve yeşil koyu
  const forced = settings.theme === 'porselen' ? 'light' : 'dark';
  const setForce = useTheme((s) => s.setForce);
  useLayoutEffect(() => {
    setForce(forced);
    // Açılışın teması (bootDark.ts) artık sayfanın kendisinde
    useTheme.getState().releaseBootDark();
    return () => setForce(null);
  }, [forced, setForce]);
  // Oturumsuz ekran: canlı bağlantı yok, sık yoklanır (yalnız bellekten okunan küçük bir yanıt)
  const q = useQuery({ queryKey: ['display', code], queryFn: () => get<DisplayStateDTO>(`/public/display/${code}`), refetchInterval: 1_500 });

  // Sağlamlık: yanıt uzun süre gelmezse sayfa ancak kasa yeniden yanıt verince sessizce yenilenir (kasa kapalıyken
  // yenilemek tarayıcının hata sayfasını getirirdi), kasa yeni sürüme geçtiyse hemen; bu arada son durum ve karşılama
  // ekranı görünmeye devam eder (son ayarlar yerelde)
  const health = useQuery({ queryKey: ['display-health'], queryFn: () => get<{ build?: number | null }>('/health'), refetchInterval: 60_000, retry: false });
  const [firstBuild] = useState<{ v: number | null | undefined }>(() => ({ v: undefined }));
  if (health.data && firstBuild.v === undefined) firstBuild.v = health.data.build ?? null;
  const [stale] = useState(() => staleReload(() => get('/health').then(() => true, () => false), reloadPage));
  useEffect(() => {
    const lastOk = Math.max(q.dataUpdatedAt, health.dataUpdatedAt);
    if (lastOk && now - lastOk > STALE_RELOAD_MS) void stale(now);
    const b = health.data?.build;
    if (typeof b === 'number' && typeof firstBuild.v === 'number' && b !== firstBuild.v) reloadPage();
  }, [now, q.dataUpdatedAt, health.dataUpdatedAt, health.data, firstBuild, stale]);

  const raw = q.data;
  // Boş sepet karşılamaya döner: adisyondaki son kalem silinip adisyonda kalınınca eski sipariş görünmeye devam ediyordu
  const s: DisplayStateDTO | undefined = raw?.kind === 'order' && raw.lines.length === 0 ? { kind: 'idle', at: raw.at } : raw;
  // Teşekkürün süresi bu cihazın saatiyle, teşekkürü ilk gördüğü andan sayılır: tablet ile kasanın saati yerel ağda
  // kolayca 15 sn'den fazla kayar (ileride olan ekran teşekkürü hiç göstermiyor, geride olan bir sonraki siparişe dek
  // tutuyordu). Açılışta zaten duran teşekkür (ekran yeniden yüklendi) sunucunun anına göre de eskiyebilir; yine de en
  // çok süresi kadar kalır. Önceki çizimin bilgisi çizim sırasında saklanır (React'in "önceki değeri saklama" kalıbı)
  const [loaded, setLoaded] = useState(false);
  const [seen, setSeen] = useState<{ at: number; localAt: number; initial: boolean } | null>(null);
  if (s && !loaded) setLoaded(true);
  if (s?.kind === 'thanks' && seen?.at !== s.at) setSeen({ at: s.at, localAt: Date.now(), initial: !loaded });
  const thanksAge = s?.kind !== 'thanks' || seen?.at !== s.at ? 0 : seen.initial ? Math.max(now - seen.localAt, now - s.at) : now - seen.localAt;
  const state: DisplayStateDTO = !s || (s.kind === 'thanks' && thanksAge > (s.call ? THANKS_CALL_MS : THANKS_MS)) ? { kind: 'idle', at: 0 } : s;

  return <CustomerDisplayView className="h-full" state={state} config={settings} businessName={config.data?.businessName || businessName} now={now} />;
}
