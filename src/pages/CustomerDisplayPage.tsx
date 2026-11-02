import { useQuery } from '@tanstack/react-query';
import { useEffect, useLayoutEffect } from 'react';
import { useSearchParams } from 'react-router';
import type { CustomerDisplaySettings, DisplayConfigDTO, DisplayStateDTO } from '@shared/types';
import { CustomerDisplayView, DISPLAY_DEFAULTS } from '@/components/display/CustomerDisplayView';
import { get } from '@/lib/api';
import { useTick } from '@/lib/hooks';
import { useBusinessName } from '@/lib/publicInfo';
import { useTheme } from '@/lib/theme';
import { useWakeLock } from '@/lib/wakelock';

/** "Teşekkürler" bu kadar kalır, sonra hoş geldiniz; çağrı numarası varsa müşteri onu okuyabilsin diye biraz daha */
const THANKS_MS = 10_000;
const THANKS_CALL_MS = 15_000;
/** Son görünüm bu cihazda saklanır: sonraki açılışta ilk kare doğru temada (ayar gelmeden) */
const CONFIG_KEY = 'lafpos.musteri-ekrani';

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

  const s = q.data;
  const state: DisplayStateDTO = !s || (s.kind === 'thanks' && now - s.at > (s.call ? THANKS_CALL_MS : THANKS_MS)) ? { kind: 'idle', at: 0 } : s;

  return <CustomerDisplayView className="h-full" state={state} config={settings} businessName={config.data?.businessName || businessName} now={now} />;
}
