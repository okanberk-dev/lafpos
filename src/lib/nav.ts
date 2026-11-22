import { BarChart3, CalendarClock, ChefHat, ClipboardList, Gauge, LayoutGrid, Settings, Store, Users, Wallet } from 'lucide-react';
import { useEffect } from 'react';
import { create } from 'zustand';
import type { Permission } from '@shared/permissions';
import { DEFAULT_SERVICE_MODE, isCounterFirst, type ServiceMode, showsTables } from '@shared/service-mode';

/**
 * Rolüne ve servis moduna göre açılış sayfası. Masaya serviste sipariş alan masa planında açar; self ve yarı self
 * serviste doğrudan yeni tezgâh satışında (`/satis` boş satışı açıp adisyona geçer).
 */
export function homePath(can: (p: Permission) => boolean, mode: ServiceMode = DEFAULT_SERVICE_MODE): string {
  if (can('siparis.al')) return isCounterFirst(mode) ? '/satis' : '/masalar';
  if (can('mutfak.ekran')) return '/mutfak';
  if (can('patron.panel')) return '/patron';
  if (can('paket.yonet')) return '/siparisler';
  return '/kasa';
}

export interface NavItem {
  to: string;
  /** Rayda ve alt sekmede görünen kısa ad (68 px'lik sütuna sığar) */
  label: string;
  /** Tam ad: telefonun üst şeridi, "Daha" listesi, komut paleti, rayın ipucu ve ekran okuyucu */
  title: string;
  icon: typeof LayoutGrid;
  perms: Permission[];
  primary?: boolean;
  /** Komut paletinde bu kelimelerle de bulunur */
  keywords?: string;
}

/** Kasa ekranları: tablette sol menü, telefonda alt sekmeler, komut paletinde "Ekranlar" */
export const POS_NAV: NavItem[] = [
  { to: '/masalar', label: 'Masalar', title: 'Masalar', icon: LayoutGrid, perms: ['siparis.al'], primary: true },
  { to: '/siparisler', label: 'Siparişler', title: 'Siparişler', icon: ClipboardList, perms: ['siparis.al', 'paket.yonet'], primary: true },
  { to: '/mutfak', label: 'Bar', title: 'Bar ve mutfak ekranı', icon: ChefHat, perms: ['mutfak.ekran'], primary: true },
  { to: '/kasa', label: 'Kasa', title: 'Kasa ve gün sonu', icon: Wallet, perms: ['kasa.gun', 'kasa.hareket', 'odeme.al'], primary: true },
  // Ekranın adı sayfanın başlığıyla aynı ("Açık hesap" sayfada); palet "açık hesap" ve "cari" ile de bulur
  { to: '/musteriler', label: 'Müşteriler', title: 'Müşteriler', icon: Users, perms: ['cari.yonet'], keywords: 'açık hesap cari veresiye tahsilat damga' },
  { to: '/rezervasyon', label: 'Rezerv.', title: 'Rezervasyonlar', icon: CalendarClock, perms: ['rezervasyon.yonet'] },
  { to: '/raporlar', label: 'Raporlar', title: 'Raporlar', icon: BarChart3, perms: ['rapor.gor'] },
  { to: '/patron', label: 'Patron', title: 'Patron paneli', icon: Gauge, perms: ['patron.panel'], primary: true },
  { to: '/yonetim', label: 'Yönetim', title: 'Yönetim paneli', icon: Settings, perms: ['menu.yonet', 'ayar.yonet', 'personel.yonet', 'senkron.yonet'] },
];

/** Self ve yarı self serviste ilk sekme: yeni tezgâh satışı (masa planındaki düğmeyle aynı ad) */
export const SALE_NAV: NavItem = { to: '/satis', label: 'Satış', title: 'Tezgâh satışı', icon: Store, perms: ['siparis.al'], primary: true, keywords: 'yeni satış' };

/**
 * Servis moduna göre kasa menüsü. Masaya servis bugünkü menü. Yarı self ve QR + self: "Satış" başta, Masalar kalır
 * (doluluk; QR siparişi masaya düşer) ama telefonda alt sekmeden "Daha"ya iner. Self: Masalar yalnız masada açık
 * adisyon varsa (masa kullanılıyorsa) görünür. Bar ekranı ayardan kapalıysa (`bar: false`) Bar menüde yok.
 */
export function navFor(mode: ServiceMode, opts: { tablesInUse?: boolean; bar?: boolean } = {}): NavItem[] {
  const pos = opts.bar === false ? POS_NAV.filter((n) => n.to !== '/mutfak') : POS_NAV;
  if (!isCounterFirst(mode)) return pos;
  const out: NavItem[] = [SALE_NAV];
  for (const n of pos) {
    if (n.to !== '/masalar') out.push(n);
    else if (showsTables(mode) || opts.tablesInUse) out.push({ ...n, primary: false });
  }
  return out;
}

/** Ekran kişiye açık mı: yetki istemeyen ekran (uzakta Merkez ve İndir; oturum yeter) herkese. Menü ve palet aynı kural */
export const navAllowed = (n: NavItem, can: (p: Permission) => boolean) => n.perms.length === 0 || n.perms.some((p) => can(p));

/** Kişinin yetkisine göre süzülmüş menü */
export function visibleNav(can: (p: Permission) => boolean, mode: ServiceMode, opts: { tablesInUse?: boolean; bar?: boolean } = {}): NavItem[] {
  return navFor(mode, opts).filter((n) => navAllowed(n, can));
}

/**
 * Telefonun alt sekmeleri (beş yer). Ekran az ise hepsi sekmedir, "Daha" yok (garsonun üç ekranı). Çoksa dört sekme
 * ve "Daha": önce birincil ekranlar, eksik kalan yer menü sırasıyla dolar. Patron panelini görebilende (patron,
 * müdür) Patron sekmesi Bar'ın yerini alır: dışarıdayken telefonda baktığı ekran o, bar ekranı bar tabletinin.
 */
export function phoneTabs(items: NavItem[]): { tabs: NavItem[]; more: NavItem[] } {
  if (items.length <= 5) return { tabs: items, more: [] };
  let pick = items.filter((n) => n.primary);
  if (pick.some((n) => n.to === '/patron')) pick = pick.filter((n) => n.to !== '/mutfak');
  pick = [...pick, ...items.filter((n) => !pick.includes(n))].slice(0, 4);
  const tabs = items.filter((n) => pick.includes(n));
  return { tabs, more: items.filter((n) => !pick.includes(n)) };
}

/**
 * Ekran okuyucunun ve sesle kullanımın adı: tam ad görünen kısa adla başlıyorsa tam ad ("Rezerv." → "Rezervasyonlar",
 * "Bar" → "Bar ve mutfak ekranı"); başlamıyorsa görünen ad kalır (WCAG 2.5.3: söylenen etiket adın başında).
 */
export function navAriaLabel(n: NavItem): string | undefined {
  const short = n.label.replace(/\.$/, '').toLocaleLowerCase('tr-TR');
  return n.title !== n.label && n.title.toLocaleLowerCase('tr-TR').startsWith(short) ? n.title : undefined;
}

/** Adisyonun geldiği ekran: rayda ve alt sekmede o ekran etkin görünür */
export const useNavOrigin = create<{ to: string | null }>(() => ({ to: null }));

/** Sayfa açıkken geldiği ekranı (`useNavOrigin`) bildirir; sayfa kapanınca boşalır */
export function useSetNavOrigin(to: string | null) {
  useEffect(() => {
    useNavOrigin.setState({ to });
    return () => useNavOrigin.setState({ to: null });
  }, [to]);
}

/**
 * Menüde olmayan ekranın menüdeki yeri: Eğitim cihazı Kasa'dan açılır, adisyon geldiği ekranın (`origin`; bilinmiyorsa
 * hiçbir öğe etkin değil). Menüdeki ekranlar için null: onları adres zaten eşler
 */
export function navAlias(pathname: string, origin: string | null): string | null {
  if (pathname === '/cihaz') return '/kasa';
  if (pathname.startsWith('/adisyon/')) return origin;
  return null;
}

/** Menüde olmayan ekranların telefon üst şeridindeki adı */
export const EXTRA_TITLES: Record<string, string> = { '/cihaz': 'Eğitim cihazı' };

/** Yönetim paneli ve raporlar Innex kabuğunda açılır; kasanın sol menüsü ve üst şeridi orada çizilmez */
export function isAdminArea(pathname: string): boolean {
  return pathname.startsWith('/yonetim') || pathname.startsWith('/raporlar');
}
