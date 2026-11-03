import { BadgePercent, BarChart3, Bike, ClipboardList, Clock3, Coffee, CreditCard, Gauge, LayoutGrid, MonitorPlay, MonitorSmartphone, PlugZap, Settings2, ShieldCheck, Users, Wifi } from 'lucide-react';
import type { Permission } from '@shared/permissions';

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
  group: (typeof ADMIN_GROUPS)[number]['key'];
  perm: Permission[];
  /** Komut paletinde bu kelimelerle de bulunur */
  keywords?: string;
}

export const ADMIN_SECTIONS: AdminSection[] = [
  { key: 'genel', to: '/yonetim/genel', label: 'Genel bakış', desc: 'Bugünün rakamları, dikkat isteyenler, sistem sağlığı', icon: Gauge, group: 'genel', perm: ['patron.panel', 'rapor.gor'], keywords: 'pano dashboard özet' },
  { key: 'raporlar', to: '/raporlar', label: 'Raporlar', desc: 'Ciro, ürün, saat, personel ve lafmaliyet aktarımı', icon: BarChart3, group: 'genel', perm: ['rapor.gor'], keywords: 'ciro satış z' },
  { key: 'menu', to: '/yonetim/menu', label: 'Ürünler', desc: 'Satışta, tükendi, istasyon, kısa ad, site eşitlemesi', icon: Coffee, group: 'menu', perm: ['menu.yonet'], keywords: 'menü ürün fiyat tükendi varyant boy' },
  { key: 'secenekler', to: '/yonetim/secenekler', label: 'Seçenek ve happy hour', desc: 'Süt, şurup, shot grupları ve indirim saatleri', icon: BadgePercent, group: 'menu', perm: ['menu.yonet'], keywords: 'seçenekler opsiyon varyant kampanya happy hour indirim saati' },
  { key: 'masa-plani', to: '/yonetim/masa-plani', label: 'Masa planı', desc: 'Bölümler, masalar, karaoke odası', icon: LayoutGrid, group: 'salon', perm: ['ayar.yonet'], keywords: 'salon bahçe oda' },
  { key: 'musteri-ekrani', to: '/yonetim/musteri-ekrani', label: 'Müşteri ekranı', desc: 'Tema, karşılama ve teşekkür metni, duyurular, karekod', icon: MonitorPlay, group: 'salon', perm: ['ayar.yonet'], keywords: 'ikinci ekran müşteri ekranı monitör tablet duyuru karekod tema' },
  { key: 'odeme', to: '/yonetim/odeme', label: 'Ödeme türleri', desc: 'Nakit, kart, yemek kartları, açık hesap', icon: CreditCard, group: 'salon', perm: ['ayar.yonet'], keywords: 'pluxee multinet sodexo' },
  { key: 'personel', to: '/yonetim/personel', label: 'Personel', desc: 'PIN, rol, kişiye özel yetki, indirim sınırı', icon: Users, group: 'ekip', perm: ['personel.yonet'], keywords: 'kullanıcı garson kasiyer pin' },
  { key: 'mesai', to: '/yonetim/mesai', label: 'Mesai çizelgesi', desc: 'Giriş-çıkış, kişi başına süre, unutulan çıkış, düzeltme ve CSV', icon: Clock3, group: 'ekip', perm: ['mesai.yonet'], keywords: 'mesai vardiya giriş çıkış puantaj çalışma saati' },
  { key: 'roller', to: '/yonetim/roller', label: 'Roller ve yetkiler', desc: 'Rol başına yetki seti, kör kasa, kasadan tükendi', icon: ShieldCheck, group: 'ekip', perm: ['personel.yonet'], keywords: 'pozisyon yetki kasiyer kör kasa' },
  { key: 'yazarkasa', to: '/yonetim/yazarkasa', label: 'Yazarkasa POS', desc: 'TokenX Connect, eğitim cihazı, kısım eşlemesi', icon: MonitorSmartphone, group: 'baglanti', perm: ['ayar.yonet'], keywords: 'ökc tokenx fiş' },
  { key: 'entegrasyon', to: '/yonetim/entegrasyon', label: 'Site ve lafmaliyet', desc: 'Menü eşitleme, online siparişler, gün sonu gönderimi', icon: PlugZap, group: 'baglanti', perm: ['senkron.yonet', 'ayar.yonet'], keywords: 'laffogato senkron' },
  { key: 'platformlar', to: '/yonetim/platformlar', label: 'Paket platformları', desc: 'Yemeksepeti, Getir, Trendyol Go, Migros ve hazırlık süresi', icon: Bike, group: 'baglanti', perm: ['senkron.yonet', 'ayar.yonet'], keywords: 'yemeksepeti getir trendyol uber eats migros paket kurye deneme siparişi' },
  { key: 'ag', to: '/yonetim/ag', label: 'Ağ ve uzaktan erişim', desc: 'Tablet ve telefon adresi, karekod, Tailscale ile dışarıdan canlı erişim', icon: Wifi, group: 'baglanti', perm: ['ayar.yonet', 'patron.panel'], keywords: 'tablet telefon ip adres karekod qr tailscale uzaktan internet vpn' },
  { key: 'ayarlar', to: '/yonetim/ayarlar', label: 'Ayarlar ve yedek', desc: 'Servis modu, işletme, kilit, gün sonu, yedekler', icon: Settings2, group: 'sistem', perm: ['ayar.yonet'], keywords: 'yedek tema servis modu self servis yarı self numaratör' },
  { key: 'denetim', to: '/yonetim/denetim', label: 'Denetim kaydı', desc: 'İptal, ikram, indirim, kasa ve gün sonu izi', icon: ClipboardList, group: 'sistem', perm: ['ayar.yonet', 'patron.panel'], keywords: 'log alarm uyarı' },
];

export function visibleSections(can: (p: Permission) => boolean): AdminSection[] {
  return ADMIN_SECTIONS.filter((s) => s.perm.some((p) => can(p)));
}
