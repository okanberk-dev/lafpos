import { BadgePercent, BarChart3, ClipboardList, Coffee, CreditCard, Gauge, LayoutGrid, MonitorSmartphone, PlugZap, Settings2, ShieldCheck, Users, Wifi } from 'lucide-react';
import type { Permission } from '@shared/permissions';
import type { Hue } from './hues';

/** Kenar çubuğu grupları (Innex §3 fikir 1: büyük harfli gruplar) */
export const ADMIN_GROUPS = [
  { key: 'genel', label: 'Genel' },
  { key: 'menu', label: 'Menü' },
  { key: 'salon', label: 'Salon ve kasa' },
  { key: 'ekip', label: 'Ekip' },
  { key: 'baglanti', label: 'Bağlantılar' },
  { key: 'sistem', label: 'Sistem' },
] as const;

export interface AdminSection {
  key: string;
  to: string;
  label: string;
  /** Telefondaki yönetim listesinde ve komut paletinde görünen tek satır */
  desc: string;
  icon: typeof Coffee;
  hue: Hue;
  group: (typeof ADMIN_GROUPS)[number]['key'];
  perm: Permission[];
  /** Komut paletinde bu kelimelerle de bulunur */
  keywords?: string;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'genel', to: '/yonetim/genel', label: 'Genel bakış', desc: 'Bugünün rakamları, dikkat isteyenler, sistem sağlığı', icon: Gauge, hue: 'blue', group: 'genel', perm: ['patron.panel', 'rapor.gor'], keywords: 'pano dashboard özet' },
  { key: 'raporlar', to: '/raporlar', label: 'Raporlar', desc: 'Ciro, ürün, saat, personel ve lafmaliyet aktarımı', icon: BarChart3, hue: 'violet', group: 'genel', perm: ['rapor.gor'], keywords: 'ciro satış z' },
  { key: 'menu', to: '/yonetim/menu', label: 'Ürünler', desc: 'Satışta, tükendi, istasyon, kısa ad, site eşitlemesi', icon: Coffee, hue: 'amber', group: 'menu', perm: ['menu.yonet'], keywords: 'menü ürün fiyat tükendi' },
  { key: 'secenekler', to: '/yonetim/secenekler', label: 'Seçenekler ve happy hour', desc: 'Süt, şurup, shot grupları ve indirim saatleri', icon: BadgePercent, hue: 'rose', group: 'menu', perm: ['menu.yonet'], keywords: 'opsiyon kampanya' },
  { key: 'masa-plani', to: '/yonetim/masa-plani', label: 'Masa planı', desc: 'Bölümler, masalar, karaoke odası', icon: LayoutGrid, hue: 'green', group: 'salon', perm: ['ayar.yonet'], keywords: 'salon bahçe oda' },
  { key: 'odeme', to: '/yonetim/odeme', label: 'Ödeme türleri', desc: 'Nakit, kart, yemek kartları, açık hesap', icon: CreditCard, hue: 'blue', group: 'salon', perm: ['ayar.yonet'], keywords: 'pluxee multinet sodexo' },
  { key: 'personel', to: '/yonetim/personel', label: 'Personel', desc: 'PIN, rol, kişiye özel yetki, indirim sınırı', icon: Users, hue: 'violet', group: 'ekip', perm: ['personel.yonet'], keywords: 'kullanıcı garson kasiyer pin' },
  { key: 'roller', to: '/yonetim/roller', label: 'Roller ve yetkiler', desc: 'Rol başına yetki seti, kör kasa, kasadan tükendi', icon: ShieldCheck, hue: 'rose', group: 'ekip', perm: ['personel.yonet'], keywords: 'pozisyon yetki kasiyer kör kasa' },
  { key: 'yazarkasa', to: '/yonetim/yazarkasa', label: 'Yazarkasa POS', desc: 'TokenX Connect, eğitim cihazı, kısım eşlemesi', icon: MonitorSmartphone, hue: 'amber', group: 'baglanti', perm: ['ayar.yonet'], keywords: 'ökc tokenx fiş' },
  { key: 'entegrasyon', to: '/yonetim/entegrasyon', label: 'Site ve lafmaliyet', desc: 'Menü eşitleme, online siparişler, gün sonu gönderimi', icon: PlugZap, hue: 'green', group: 'baglanti', perm: ['senkron.yonet', 'ayar.yonet'], keywords: 'laffogato senkron' },
  { key: 'ag', to: '/yonetim/ag', label: 'Ağ ve uzaktan erişim', desc: 'Tablet ve telefon adresi, karekod, Tailscale ile dışarıdan canlı erişim', icon: Wifi, hue: 'violet', group: 'baglanti', perm: ['ayar.yonet', 'patron.panel'], keywords: 'tablet telefon ip adres karekod qr tailscale uzaktan internet vpn' },
  { key: 'ayarlar', to: '/yonetim/ayarlar', label: 'Ayarlar ve yedek', desc: 'Servis modu, işletme, kilit, gün sonu, yedekler', icon: Settings2, hue: 'blue', group: 'sistem', perm: ['ayar.yonet'], keywords: 'yedek tema servis modu self servis yarı self numaratör' },
  { key: 'denetim', to: '/yonetim/denetim', label: 'Denetim kaydı', desc: 'İptal, ikram, indirim, kasa ve gün sonu izi', icon: ClipboardList, hue: 'rose', group: 'sistem', perm: ['ayar.yonet', 'patron.panel'], keywords: 'log alarm uyarı' },
];

export function visibleSections(can: (p: Permission) => boolean): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => s.perm.some((p) => can(p)));
}
