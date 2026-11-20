import { eq } from 'drizzle-orm';
import type { Permission, Role, RoleMatrix } from '@shared/permissions';
import { PLATFORM_DEFAULTS, type PlatformId, type PlatformSettings } from '@shared/platforms';
import { DEFAULT_SERVICE_MODE } from '@shared/service-mode';
import type { PublicSettings } from '@shared/types';
import { type DB, db, schema, type Tx, tx } from '../db/client';

/** Arayüze giden ayarlar (herkes görür) */
export const PUBLIC_DEFAULTS: PublicSettings = {
  businessName: "L'Affogato",
  businessAddress: 'Tuzla, İstanbul',
  businessPhone: '',
  receiptHeader: "L'Affogato · Since 1897, Bologna",
  receiptFooter: 'Bizi tercih ettiğiniz için teşekkürler\nlaffogato.net',
  serviceRate: 0,
  autoLockMinutes: 0,
  keepAwake: true,
  productImages: true,
  // Şeker gibi zorunlu seçim kasada sorulsun; Latte gibi isteğe bağlı seçenekli ürün boy düğmesiyle hemen eklenir
  askOptions: 'zorunlu',
  voidReasons: ['Yanlış giriş', 'Müşteri vazgeçti', 'Ürün bitti', 'Geç kaldı', 'Hatalı hazırlandı'],
  compReasons: ['Müdavim', 'Doğum günü', 'Gecikme özrü', 'Personel', 'Tadım'],
  odenmezReasons: ['Personel yemeği', 'Patron hesabı', 'Müşteri şikâyeti', 'Deneme'],
  zayiReasons: ['Döküldü', 'Yanlış hazırlandı', 'Bozuk / bayat', 'Müşteri iade etti'],
  discountReasons: ['Öğrenci', 'Personel', 'Müdavim', 'Kampanya', 'Şikâyet telafisi'],
  quickCash: [10000, 20000, 50000, 100000, 200000],
  sizeLabels: { M: 'Orta', L: 'Büyük' },
  requireDayOpen: true,
  kitchenWarnMinutes: 7,
  kitchenAlarmMinutes: 12,
  roomBillingStepMinutes: 15,
  roomMinimumMinutes: 60,
  stampGoal: 6,
  // Yerel damga kartı varsayılan kapalı: tek sadakat programı uygulamadaki damga (laffogato hukuk metni tek program
  // tanımlar). Kategori anahtarı yazılırsa açılır; site bağlantısı kuruluyken hiç açılmaz (sync/laffogato-link.ts)
  stampCategoryKeys: [],
  demoMode: false,
  // Var olan kurulumlarda hiçbir şey değişmesin: patron Yönetim › Ayarlar'dan seçer
  serviceMode: DEFAULT_SERVICE_MODE,
  tipsEnabled: false,
  // Bar ekranı ve "Bara gönder" açık: var olan kurulumlarda hiçbir şey değişmez; bar ekranı olmayan işletme kapatır
  barEnabled: true,
  // Müşteri ekranı: gece teması, sitenin tescilli sloganı; duyuru ve karekod patron girene kadar yok
  customerDisplay: {
    theme: 'gece',
    welcomeTitle: 'Hoş geldiniz',
    welcomeSubtitle: 'Drink it. Eat the cup.',
    thanksTitle: 'Teşekkürler, afiyet olsun',
    messages: [],
    qrUrl: '',
    qrLabel: 'Uygulamayı indirin, damga kazanın',
    showClock: true,
    showOptions: true,
  },
};

/** Yalnız sunucuda kullanılan ayarlar */
export interface PrivateSettings {
  /** Site menüsü otomatik senkronu */
  menuAutoSync: boolean;
  /** Online siparişleri sitenin imzalı ucundan çek */
  onlineOrdersSync: boolean;
  /** lafmaliyet satış listesinde boy ekleri */
  posSizeSuffix: { M: string; L: string; TEK: string };
  /** Anomali eşikleri */
  alertDiscountPct: number;
  alertCashDiffKurus: number;
  /** Günlük yedek sayısı */
  backupKeep: number;
  /** Otomatik gün sonu (ModPOS'taki 06:00 gibi); açık adisyon varsa alınmaz, uyarı düşer */
  autoDayEnd: boolean;
  autoDayEndHour: number;
  /** Yazarkasa POS bağlantısı: kapalı, TokenX Connect (Cloud) ya da eğitim simülatörü */
  okcProvider: 'kapali' | 'tokenx' | 'simulator';
  /** anlik: kasada ödeme (sepet hemen cihaza düşer) · liste: masada ödeme (cihaz açık sepetleri listeler) */
  okcMode: 'anlik' | 'liste';
  /** KDV oranı -> cihazdaki kısım no ("10" -> 1) */
  okcSectionMap: Record<string, number>;
  /** Yemek kartı operatör kimliği -> LafPOS ödeme türü (ör. "1005" -> Multinet) */
  okcOperatorMethods: Record<string, string>;
  /** Yönetim › Roller ve yetkiler'de düzenlenen rol yetki setleri; olmayan rol varsayılanını kullanır */
  rolePermissions: RoleMatrix;
  /** İlk Z numarası: geçişte ModPOS'un son Z'si + 1; zincir yalnız yukarı doğru etkilenir (`nextZNo`). null: 1'den */
  zNoStart: number | null;
  /**
   * Bu kasanın şubesi: lafmaliyet'teki şube kimliği (`tuzla`, `marina`; lafmaliyet docs/SUBE.md). Gün sonu paketine
   * konur ki panel günü doğru şubeye yazsın (docs/03-ENTEGRASYON.md §4). Tek şubeli kurulumda varsayılan `tuzla`
   * yeter; ikinci bir kasa kurulurken Yönetim › Ayarlar'dan değiştirilir. Boş bırakılamaz: panel şubesiz günü
   * bugünkü gibi Tuzla'ya yazar, bu da yanlış şubeye ciro demektir.
   */
  branchId: string;
  /**
   * Paket platformları: mod, hazırlık süresi, otomatik kabul, tahmini komisyon (shared/platforms.ts). Arayüze
   * bootstrap'la gitmez: komisyon oranı maliyettir; ekranlar `GET /api/platforms`'tan okur (oran yalnız maliyet,
   * ayar ya da senkron yetkisine)
   */
  platforms: Record<PlatformId, PlatformSettings>;
}

export const PRIVATE_DEFAULTS: PrivateSettings = {
  menuAutoSync: true,
  onlineOrdersSync: true,
  posSizeSuffix: { M: 'MEDIUM', L: 'LARGE', TEK: '' },
  alertDiscountPct: 25,
  alertCashDiffKurus: 10000,
  backupKeep: 14,
  autoDayEnd: false,
  autoDayEndHour: 6,
  okcProvider: 'kapali',
  okcMode: 'anlik',
  okcSectionMap: { '1': 3, '10': 1, '20': 2 },
  okcOperatorMethods: {},
  rolePermissions: {},
  zNoStart: null,
  branchId: 'tuzla',
  platforms: PLATFORM_DEFAULTS,
};

export type AllSettings = PublicSettings & PrivateSettings;
const DEFAULTS: AllSettings = { ...PUBLIC_DEFAULTS, ...PRIVATE_DEFAULTS };

let cache: AllSettings | null = null;

export function getSettings(): AllSettings {
  if (cache) return cache;
  const rows = db.select().from(schema.settings).all();
  const merged = { ...DEFAULTS } as Record<string, unknown>;
  for (const r of rows) if (r.key in DEFAULTS) merged[r.key] = r.value;
  cache = merged as unknown as AllSettings;
  return cache;
}

/**
 * Kurulum (eğitim) modu: giriş ekranında örnek PIN'ler açık (`demoMode`, kurulum verisi böyle başlar) ya da yazarkasa
 * eğitim simülatöründe. Bu modda kapanan gün eğitim günüdür (`business_days.trainingDay`); lafmaliyet'e hiç gitmez,
 * kurulum modu sonradan kapansa da. docs/03-ENTEGRASYON.md §4.3
 */
export function trainingMode(s: Pick<AllSettings, 'demoMode' | 'okcProvider'> = getSettings()): boolean {
  return s.demoMode || s.okcProvider === 'simulator';
}

export function getPublicSettings(): PublicSettings {
  const all = getSettings();
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(PUBLIC_DEFAULTS)) out[k] = (all as unknown as Record<string, unknown>)[k];
  return out as unknown as PublicSettings;
}

/** Ayarları yazar; `t` verilirse çağıranın işleminin içinde (denetim kaydıyla birlikte) */
export function updateSettings(patch: Partial<AllSettings>, t: Tx | DB = db) {
  const now = Date.now();
  // Önbellek her durumda düşer: işlem geri alınsa da sonraki okuma veritabanından gelir
  cache = null;
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS) || value === undefined) continue;
    // null: kayıt silinir, ayar varsayılanına döner (değer sütunu boş olamaz; null'u yalnız varsayılanı null olan
    // ayar kabul eder, ör. ilk Z numarası)
    if (value === null) {
      t.delete(schema.settings).where(eq(schema.settings.key, key)).run();
      continue;
    }
    const existing = t.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (existing) t.update(schema.settings).set({ value, updatedAt: now }).where(eq(schema.settings.key, key)).run();
    else t.insert(schema.settings).values({ key, value, updatedAt: now }).run();
  }
  cache = null;
}

export function getSyncState<T>(key: string): T | null {
  const row = db.select().from(schema.syncState).where(eq(schema.syncState.key, key)).get();
  return (row?.value as T) ?? null;
}

export function setSyncState(key: string, value: unknown) {
  const now = Date.now();
  db.insert(schema.syncState)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: schema.syncState.key, set: { value, updatedAt: now } })
    .run();
}

/**
 * Sonradan eklenen yetkiler, yönetimden özelleştirilmiş (kayıtlı) rol setlerine bir kez eklenir: kayıtlı set
 * kaydedildiği günün yetkilerini sayar, yeni yetki o rolde sessizce kapalı kalırdı (ör. müdür ödenmez onaylayamazdı).
 * Benzer yetkileri (`like`) taşıyan rollere eklenir; patron sonra kaldırırsa bir daha eklenmez.
 */
const ADDED_PERMISSIONS: { permission: Permission; like: Permission[] }[] = [
  { permission: 'siparis.odenmez', like: ['siparis.ikram', 'odeme.iade'] },
];

const SETTINGS_UPGRADES_KEY = 'ayar-guncellemeleri';

/**
 * Tek seferlik ayar düzeltmeleri (açılışta): kayıtlı Ödenmez gerekçelerinden "Zayi" düşer, çünkü zayi artık ayrı
 * türdür (zayiReasons); kalsaydı personel dökülen ürünü ödenmez diye kapatır, zayi raporu eksik kalırdı. Patron
 * sonradan yeniden yazarsa dokunulmaz.
 */
export function upgradeStoredSettings() {
  const done = new Set(getSyncState<string[]>(SETTINGS_UPGRADES_KEY) ?? []);
  if (done.has('zayi-nedeni')) return;
  const current = getSettings().odenmezReasons;
  const kept = current.filter((r) => r.trim().toLocaleLowerCase('tr-TR') !== 'zayi');
  tx((t) => {
    if (kept.length !== current.length) updateSettings({ odenmezReasons: kept }, t);
    setSyncState(SETTINGS_UPGRADES_KEY, [...done, 'zayi-nedeni']);
  });
}
const ADDED_KEY = 'rol-yetki-eklemeleri';

export function upgradeRoleSets() {
  const done = new Set(getSyncState<string[]>(ADDED_KEY) ?? []);
  const todo = ADDED_PERMISSIONS.filter((a) => !done.has(a.permission));
  if (!todo.length) return;
  const matrix: RoleMatrix = { ...getSettings().rolePermissions };
  let changed = false;
  for (const role of Object.keys(matrix) as Role[]) {
    for (const a of todo) {
      const set = matrix[role] ?? [];
      if (a.like.every((p) => set.includes(p)) && !set.includes(a.permission)) {
        matrix[role] = [...set, a.permission];
        changed = true;
      }
    }
  }
  tx((t) => {
    if (changed) updateSettings({ rolePermissions: matrix }, t);
    setSyncState(ADDED_KEY, [...done, ...todo.map((a) => a.permission)]);
  });
}
