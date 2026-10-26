import { BarChart3, CalendarClock, ChefHat, ClipboardList, Gauge, LayoutGrid, Settings, Users, Wallet } from 'lucide-react';
import type { Permission } from '@shared/permissions';

/** Rolüne göre açılış sayfası */
export function homePath(can: (p: Permission) => boolean): string {
  if (can('siparis.al')) return '/masalar';
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

/** Yönetim paneli ve raporlar Innex kabuğunda açılır; kasanın sol menüsü ve üst şeridi orada çizilmez */
export function isAdminArea(pathname: string): boolean {
  return pathname.startsWith('/yonetim') || pathname.startsWith('/raporlar');
}
