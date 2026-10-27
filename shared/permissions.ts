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
  'siparis.odenmez': 'Adisyonu ödenmez kapatma (personel yemeği, zayi, patron hesabı)',
  'siparis.indirim': 'İndirim uygulama',
  'siparis.fiyat': 'Fiyatı elle değiştirme',
  'masa.islem': 'Masa taşıma, birleştirme, bölme',
  'odeme.al': 'Ödeme alma ve adisyon kapatma',
  'odeme.iade': 'Ödeme iptali, kapanmış adisyonu yeniden açma',
  'kasa.gun': 'Gün açma, gün sonu (Z) alma',
  'kasa.rakam': 'Ara rapor (X) ve kasa rakamlarını görme; kapalıysa sayım kör yapılır',
  'kasa.hareket': 'Kasaya para girişi ve çıkışı',
  'cari.yonet': 'Müşteri ve açık hesap (veresiye) işlemleri',
  'paket.yonet': 'Paket servis ve gel-al siparişleri',
  'rezervasyon.yonet': 'Rezervasyon',
  'mutfak.ekran': 'Mutfak / bar ekranı',
  'urun.tukendi': 'Ürünü kasadan ya da bardan tükendi işaretleme, satışa açma',
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
    'kasa.gun',
    'kasa.hareket',
    'cari.yonet',
    'paket.yonet',
    'rezervasyon.yonet',
    'mutfak.ekran',
    'urun.tukendi',
  ],
  garson: ['siparis.al', 'masa.islem', 'rezervasyon.yonet'],
  mutfak: ['mutfak.ekran', 'urun.tukendi'],
  kurye: ['paket.yonet'],
};

/**
 * Yetki grupları (ModPOS'un "Özel Yetkiler" kategorileri gibi): rol ve personel ekranında bu sırayla görünür.
 * Her yetki tam bir grupta (tests/permissions.test.ts).
 */
export const PERMISSION_GROUPS: { key: string; label: string; permissions: Permission[] }[] = [
  { key: 'satis', label: 'Satış işlemleri', permissions: ['siparis.al', 'siparis.iptal', 'siparis.ikram', 'siparis.odenmez', 'siparis.indirim', 'siparis.fiyat', 'masa.islem', 'paket.yonet', 'rezervasyon.yonet'] },
  { key: 'odeme', label: 'Ödeme ve kasa', permissions: ['odeme.al', 'odeme.iade', 'kasa.gun', 'kasa.rakam', 'kasa.hareket', 'cari.yonet'] },
  { key: 'bar', label: 'Bar ve mutfak', permissions: ['mutfak.ekran', 'urun.tukendi'] },
  { key: 'rapor', label: 'Raporlar', permissions: ['rapor.gor', 'rapor.maliyet', 'patron.panel'] },
  { key: 'yonetim', label: 'Yönetim', permissions: ['menu.yonet', 'stok.yonet', 'ayar.yonet', 'personel.yonet', 'senkron.yonet'] },
];

/** Patron rolü her yetkiye sahiptir ve değiştirilemez: kimse kendini paneldan dışarıda bırakamasın */
export const LOCKED_ROLES: Role[] = ['patron'];

/** Rollerin yönetimden düzenlenmiş yetki setleri (ayarlarda `rolePermissions`); olmayan rol varsayılanını kullanır */
export type RoleMatrix = Partial<Record<Role, Permission[]>>;

export function rolePermissions(role: Role, matrix?: RoleMatrix | null): Permission[] {
  if (LOCKED_ROLES.includes(role)) return ALL_PERMISSIONS;
  const custom = matrix?.[role];
  return custom ? custom.filter((p) => p in PERMISSIONS) : (ROLE_DEFAULTS[role] ?? []);
}

export interface PermissionOverrides {
  grant?: Permission[];
  revoke?: Permission[];
}

export function effectivePermissions(role: Role, overrides?: PermissionOverrides | null, matrix?: RoleMatrix | null): Set<Permission> {
  const set = new Set<Permission>(rolePermissions(role, matrix));
  for (const p of overrides?.grant ?? []) if (p in PERMISSIONS) set.add(p);
  for (const p of overrides?.revoke ?? []) set.delete(p);
  return set;
}
