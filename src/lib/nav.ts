import { BarChart3, CalendarClock, ChefHat, ClipboardList, Gauge, LayoutGrid, Settings, Store, Users, Wallet } from 'lucide-react';
import type { Permission } from '@shared/permissions';
import { DEFAULT_SERVICE_MODE, isCounterFirst, type ServiceMode } from '@shared/service-mode';

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
  label: string;
  /** Komut paletinde görünen uzun ad */
  title: string;
  icon: typeof LayoutGrid;
  perms: Permission[];
  primary?: boolean;
}

/** Kasa ekranları: tablette sol menü, telefonda alt sekmeler, komut paletinde "Ekranlar" */
export const POS_NAV: NavItem[] = [
  { to: '/masalar', label: 'Masalar', title: 'Masalar', icon: LayoutGrid, perms: ['siparis.al'], primary: true },
  { to: '/siparisler', label: 'Siparişler', title: 'Siparişler', icon: ClipboardList, perms: ['siparis.al', 'paket.yonet'], primary: true },
  { to: '/mutfak', label: 'Bar', title: 'Bar ve mutfak ekranı', icon: ChefHat, perms: ['mutfak.ekran'], primary: true },
  { to: '/kasa', label: 'Kasa', title: 'Kasa ve gün sonu', icon: Wallet, perms: ['kasa.gun', 'kasa.hareket', 'odeme.al'], primary: true },
  { to: '/musteriler', label: 'Müşteri', title: 'Müşteriler ve cari', icon: Users, perms: ['cari.yonet'] },
  { to: '/rezervasyon', label: 'Rezerv.', title: 'Rezervasyonlar', icon: CalendarClock, perms: ['rezervasyon.yonet'] },
  { to: '/raporlar', label: 'Rapor', title: 'Raporlar', icon: BarChart3, perms: ['rapor.gor'] },
  { to: '/patron', label: 'Patron', title: 'Patron paneli', icon: Gauge, perms: ['patron.panel'], primary: true },
  { to: '/yonetim', label: 'Yönetim', title: 'Yönetim paneli', icon: Settings, perms: ['menu.yonet', 'ayar.yonet', 'personel.yonet', 'senkron.yonet'] },
];

/** Self ve yarı self serviste ilk sekme: yeni tezgâh satışı */
export const SALE_NAV: NavItem = { to: '/satis', label: 'Satış', title: 'Yeni satış (tezgâh)', icon: Store, perms: ['siparis.al'], primary: true };

/**
 * Servis moduna göre kasa menüsü. Masaya servis bugünkü menü. Yarı self: "Satış" başta, Masalar doluluk için kalır
 * ama telefonda alt sekmeden "Daha"ya iner. Self: Masalar yalnız masada açık adisyon varsa (masa kullanılıyorsa) görünür.
 */
export function navFor(mode: ServiceMode, opts: { tablesInUse?: boolean } = {}): NavItem[] {
  if (!isCounterFirst(mode)) return POS_NAV;
  const out: NavItem[] = [SALE_NAV];
  for (const n of POS_NAV) {
    if (n.to !== '/masalar') out.push(n);
    else if (mode === 'yari_self' || opts.tablesInUse) out.push({ ...n, primary: false });
  }
  return out;
}

/** Kişinin yetkisine göre süzülmüş menü */
export function visibleNav(can: (p: Permission) => boolean, mode: ServiceMode, opts: { tablesInUse?: boolean } = {}): NavItem[] {
  return navFor(mode, opts).filter((n) => n.perms.some((p) => can(p)));
}

/** Yönetim paneli ve raporlar Innex kabuğunda açılır; kasanın sol menüsü ve üst şeridi orada çizilmez */
export function isAdminArea(pathname: string): boolean {
  return pathname.startsWith('/yonetim') || pathname.startsWith('/raporlar');
}
