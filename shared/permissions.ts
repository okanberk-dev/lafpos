/**
 * Rol ve yetki modeli. Her rolün varsayılan yetkileri vardır; kullanıcı bazında ek yetki verilebilir ya da
 * geri alınabilir. Yetkisi olmayan bir işlem, yetkili birinin PIN'iyle o an onaylatılabilir ("yetkili onayı");
 * iki kişi de denetim kaydına yazılır.
 *
 * KVKK ve iç kontrol kuralı (lafmaliyet ile aynı): maliyet, kâr ve personel performans tutarları yalnız
 * `rapor.maliyet` yetkisi olanlara görünür. Personel rolleri bu yetkiyi varsayılan olarak almaz.
 */

export const ROLES = ['patron', 'mudur', 'kasiyer', 'garson', 'mutfak', 'kurye'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  patron: 'Patron',
  mudur: 'Müdür',
  kasiyer: 'Kasiyer / Barista',
  garson: 'Garson',
  mutfak: 'Mutfak / Bar',
  kurye: 'Kurye',
};

export const PERMISSIONS = {
  'siparis.al': 'Masa açma, ürün ekleme, mutfağa gönderme',
  'siparis.iptal': 'Gönderilmiş kalemi iptal etme',
  'siparis.ikram': 'İkram etme',
  'siparis.indirim': 'İndirim uygulama',
  'siparis.fiyat': 'Fiyatı elle değiştirme',
  'masa.islem': 'Masa taşıma, birleştirme, bölme',
  'odeme.al': 'Ödeme alma ve adisyon kapatma',
  'odeme.iade': 'Ödeme iptali, kapanmış adisyonu yeniden açma',
  'kasa.gun': 'Gün açma, gün sonu (Z) alma',
  'kasa.hareket': 'Kasaya para girişi ve çıkışı',
  'cari.yonet': 'Müşteri ve açık hesap (veresiye) işlemleri',
  'paket.yonet': 'Paket servis ve gel-al siparişleri',
  'rezervasyon.yonet': 'Rezervasyon',
  'mutfak.ekran': 'Mutfak / bar ekranı',
  'rapor.gor': 'Satış raporları',
  'rapor.maliyet': 'Maliyet, kâr ve personel tutarları',
  'menu.yonet': 'Menü, fiyat ve seçenek yönetimi',
  'stok.yonet': 'Stok, reçete, sayım ve zayi',
  'ayar.yonet': 'Masa planı, yazıcı ve genel ayarlar',
  'personel.yonet': 'Personel ve yetkiler',
  'senkron.yonet': 'laffogato / lafmaliyet bağlantısı',
  'patron.panel': 'Patron paneli ve uyarılar',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const ROLE_DEFAULTS: Record<Role, Permission[]> = {
  patron: ALL_PERMISSIONS,
  mudur: ALL_PERMISSIONS.filter((p) => p !== 'personel.yonet'),
  kasiyer: [
    'siparis.al',
    'siparis.ikram',
    'masa.islem',
    'odeme.al',
    'kasa.hareket',
    'cari.yonet',
    'paket.yonet',
    'rezervasyon.yonet',
    'mutfak.ekran',
  ],
  garson: ['siparis.al', 'masa.islem', 'rezervasyon.yonet'],
  mutfak: ['mutfak.ekran'],
  kurye: ['paket.yonet'],
};

export interface PermissionOverrides {
  grant?: Permission[];
  revoke?: Permission[];
}

export function effectivePermissions(role: Role, overrides?: PermissionOverrides | null): Set<Permission> {
  const set = new Set<Permission>(ROLE_DEFAULTS[role] ?? []);
  for (const p of overrides?.grant ?? []) if (p in PERMISSIONS) set.add(p);
  for (const p of overrides?.revoke ?? []) set.delete(p);
  return set;
}
