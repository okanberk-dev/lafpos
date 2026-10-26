import { eq } from 'drizzle-orm';
import type { RoleMatrix } from '@shared/permissions';
import type { PublicSettings } from '@shared/types';
import { db, schema } from '../db/client';

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
  voidReasons: ['Yanlış giriş', 'Müşteri vazgeçti', 'Ürün bitti', 'Geç kaldı', 'Hatalı hazırlandı'],
  compReasons: ['Müdavim', 'Doğum günü', 'Gecikme özrü', 'Personel', 'Tadım'],
  discountReasons: ['Öğrenci', 'Personel', 'Müdavim', 'Kampanya', 'Şikâyet telafisi'],
  quickCash: [10000, 20000, 50000, 100000, 200000],
  sizeLabels: { M: 'Orta', L: 'Büyük' },
  requireDayOpen: true,
  kitchenWarnMinutes: 7,
  kitchenAlarmMinutes: 12,
  roomBillingStepMinutes: 15,
  roomMinimumMinutes: 60,
  stampGoal: 6,
  stampCategoryKeys: ['matcha', 'espresso', 'ice-coffee', 'cold', 'hot', 'frappe', 'smoothie', 'frozen', 'ice-tea'],
  demoMode: false,
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

export function getPublicSettings(): PublicSettings {
  const all = getSettings();
  const out = {} as Record<string, unknown>;
  for (const k of Object.keys(PUBLIC_DEFAULTS)) out[k] = (all as unknown as Record<string, unknown>)[k];
  return out as unknown as PublicSettings;
}

export function updateSettings(patch: Partial<AllSettings>) {
  const now = Date.now();
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS) || value === undefined) continue;
    const existing = db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    if (existing) db.update(schema.settings).set({ value, updatedAt: now }).where(eq(schema.settings.key, key)).run();
    else db.insert(schema.settings).values({ key, value, updatedAt: now }).run();
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
