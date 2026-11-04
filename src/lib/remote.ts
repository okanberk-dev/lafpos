import { useQuery } from '@tanstack/react-query';
import { get } from './api';

/**
 * LafPOS Uzaktan: Vercel'deki salt okunur görünüm (vercel.json derlemede VITE_LAFPOS_UZAKTAN=1 verir). Veri kafedeki
 * sunucunun ittiği canlı özetten gelir; işlem düğmeleri gizlidir, canlı bağlantı yerine kısa aralıkla yenilenir.
 */
export const REMOTE = import.meta.env.VITE_LAFPOS_UZAKTAN === '1' && import.meta.env.MODE !== 'demo';

/** Uzakta görünen ekranlar */
export const REMOTE_PATHS = ['/patron', '/masalar', '/mutfak'];

/** Uzaktan erişimin kurulum durumu (`GET /api/uzaktan/kurulum`, anahtarsız açık): yalnız var/yok, hiçbir değer dönmez */
export interface RemoteSetup {
  secret: boolean;
  password: boolean;
  redis: boolean;
  snapshotAt: number | null;
  /** Kafe bağlanmadı: örnek gün parolasız açılır */
  demo?: boolean;
  /** Parolasız görünüm (LAFPOS_UZAKTAN_PAROLA_GEREKLI yoksa): gerçek veri de parola sormadan açılır */
  open?: boolean;
}

export const remoteSetupQuery = { queryKey: ['uzaktan', 'kurulum'], queryFn: () => get<RemoteSetup>('/uzaktan/kurulum') };

/** Kurulum tamam mı: ortak anahtar, parola (parolasız görünümde gerekmez; uç o zaman `password: true` döner) ve Redis */
export function remoteSetupReady(s: RemoteSetup): boolean {
  return s.secret && s.password && s.redis;
}

/** Giriş ekranı parola sormadan girer mi: demo ya da kurulumu tamam parolasız görünüm */
export function remoteAutoEnters(s: RemoteSetup): boolean {
  return !!s.demo || (!!s.open && remoteSetupReady(s));
}

/**
 * Uzaktan görünümde "Çıkış" (kullanıcı menüsü, komut paleti, açılış hatası) gösterilsin mi. Giriş ekranı parola
 * sormadan girecekse çıkış aynı oturumu hemen yeniden açar: gösterilmez. Karar giriş ekranının şimdi ne yapacağından
 * verilir, oturumun hangi sekmede nasıl açıldığından değil: jeton localStorage'da 12 saat geçerlidir, yeniden açılan
 * uygulama giriş ekranından geçmeden oturuma döner. Kurulum sorulurken gizli (gelip gitmesin), okunamazsa görünür.
 */
export function remoteSignOutFor(setup: { data?: RemoteSetup; isError: boolean }): boolean {
  return setup.data ? !remoteAutoEnters(setup.data) : setup.isError;
}

/** `remoteSignOutFor` kurulumun güncel durumuyla; kasada ve tarayıcı demosunda hiç (orada Ekranı kilitle var) */
export function useRemoteSignOut(): boolean {
  // Açılışta bir kez okunur (her okuma kafenin özetini Redis'ten çeker); giriş ekranı açılınca kendisi tazeler
  const setup = useQuery({ ...remoteSetupQuery, enabled: REMOTE, staleTime: Infinity, refetchOnWindowFocus: false });
  return REMOTE && remoteSignOutFor(setup);
}
