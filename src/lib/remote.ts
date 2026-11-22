import { useQuery } from '@tanstack/react-query';
import { get, setConditionalGets, setShopHeader } from './api';
import { DOWNLOAD_NAV, DOWNLOAD_PATH, MERKEZ_NAV, MERKEZ_PATH } from './download';
import type { NavItem } from './nav';

/**
 * LafPOS Uzaktan: Vercel'deki salt okunur görünüm (vercel.json derlemede VITE_LAFPOS_UZAKTAN=1 verir). Veri kafedeki
 * sunucunun ittiği canlı özetten gelir; işlem düğmeleri gizlidir, canlı bağlantı yerine kısa aralıkla yenilenir.
 */
export const REMOTE = import.meta.env.VITE_LAFPOS_UZAKTAN === '1' && import.meta.env.MODE !== 'demo';

/**
 * Uzaktaki canlı ekranların yoklama aralığı. Kasa değişikliği en sık 15 sn'de bir iter (server/sync/cloud.ts
 * MIN_INTERVAL_MS): daha sık sormak yeni veri getirmez. Satıştan ekrana en geç ~30 sn. Gün kapalıyken (gece kasa
 * 15 dk'da bir iter) 60 sn. Sekme gizliyken hiç sorulmaz (TanStack Query `refetchIntervalInBackground` kapalı, görünür
 * olunca bir kez yenilenir). Her yoklama koşulludur (`setConditionalGets`): özet değişmediyse sunucu 304 döner, Redis'te
 * yalnız küçük sürüm kaydı okunur (docs/07-UZAKTAN-ERISIM.md §4 "Upstash bütçesi")
 */
export const REMOTE_POLL_MS = 15_000;
export const REMOTE_IDLE_POLL_MS = 60_000;
/** Ağır değişen veri uzakta 5 dk'da bir: açılış verisi (menü, masa planı, gün) ve menüdeki Masalar; değişmediyse 304 */
export const REMOTE_SLOW_POLL_MS = 5 * 60_000;
export const remotePollMs = (dayOpen: boolean | undefined) => (dayOpen === false ? REMOTE_IDLE_POLL_MS : REMOTE_POLL_MS);

// ─── Dükkân seçici (Merkez'e bağlı birden çok kasa) ─────────────────────────

const SHOP_STORE = 'lafpos.dukkan';
export interface RemoteShop {
  id: string;
  ad: string | null;
  at: number;
}

export function storedShop(): string | null {
  try {
    return localStorage.getItem(SHOP_STORE);
  } catch {
    return null;
  }
}

/** Seçimi saklar ve isteklere ekler; null: en son veri gönderen dükkân */
export function chooseShop(id: string | null) {
  try {
    if (id) localStorage.setItem(SHOP_STORE, id);
    else localStorage.removeItem(SHOP_STORE);
  } catch {
    /* depolama kapalı: seçim yalnız bu sekmede */
  }
  setShopHeader(id);
}

if (REMOTE) {
  setShopHeader(storedShop());
  setConditionalGets(true);
}

export const remoteShopsQuery = { queryKey: ['uzaktan', 'dukkanlar'], queryFn: () => get<RemoteShop[]>('/uzaktan/dukkanlar'), staleTime: 5 * 60_000 };

/** Uzakta görünen ekranlar; İndir (siteden kurulum) yalnız uzakta ve yalnız oturumda */
export const REMOTE_PATHS = ['/patron', '/masalar', '/mutfak', '/raporlar', MERKEZ_PATH, DOWNLOAD_PATH];

/**
 * Uzaktan görünümün menüsü: kişinin menüsünden uzakta açılan ekranlar, sonunda İndir (yetki istemez, oturum yeter).
 * Kasada menü aynen kalır
 */
export function remoteNav(items: NavItem[], remote = REMOTE): NavItem[] {
  if (!remote) return items;
  return [...items.filter((n) => REMOTE_PATHS.includes(n.to)), MERKEZ_NAV, DOWNLOAD_NAV];
}

/**
 * Uzakta açılan rapor sekmeleri: kasanın günlük özetlerinden toplananlar (api/uzaktan.ts, shared/remote-calc.ts). Yalnız
 * lafmaliyet aktarımı kafede (maliyet ve gönderim kasanın işi)
 */
export const REMOTE_REPORTS = ['ciro', 'urunler', 'saatlik', 'hazirlama', 'adisyon', 'platformlar', 'kayip', 'happy', 'personel'] as const;

/** Gün açıkken kafeden bu kadar süredir veri gelmediyse "kafeden veri gelmiyor" (kasa nabzı 5 dk'da bir iter) */
export const REMOTE_STALE_MS = 10 * 60_000;

/**
 * Uzaktaki canlı rakamların durumu: `live` taze; `stale` gün açık ama kafenin son itmesi 10 dakikadan eski (internet,
 * elektrik ya da kasa bilgisayarı); gün kapalıyken boşta itme 15 dk'da bir olduğundan eskilik sayılmaz (`closed`)
 */
export function remoteFreshness(nowMs: number, dataAt: number, dayOpen: boolean): 'live' | 'stale' | 'closed' {
  if (!dayOpen) return 'closed';
  return nowMs - dataAt > REMOTE_STALE_MS ? 'stale' : 'live';
}

const clockFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', hour: '2-digit', minute: '2-digit', second: '2-digit' });
/** Saniyeli saat ("14:05:09"): uzaktaki "son güncelleme" */
export const fmtClock = (ms: number) => clockFmt.format(new Date(ms));

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
  /** Üyelik açık (LAFPOS_UYE_EPOSTA): 'new' üye ilk girişte parolasını belirler, 'ready' e-posta ve parolayla girer */
  member?: 'new' | 'ready';
}

export const remoteSetupQuery = { queryKey: ['uzaktan', 'kurulum'], queryFn: () => get<RemoteSetup>('/uzaktan/kurulum') };

/** Kurulum tamam mı: ortak anahtar, parola (parolasız görünümde gerekmez; uç o zaman `password: true` döner) ve Redis */
export function remoteSetupReady(s: RemoteSetup): boolean {
  return s.secret && s.password && s.redis;
}

/** Giriş ekranı parola sormadan girer mi: demo ya da kurulumu tamam parolasız görünüm; üyelik açıksa hiç (form görünür) */
export function remoteAutoEnters(s: RemoteSetup): boolean {
  if (s.member) return false;
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
