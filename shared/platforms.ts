/**
 * Paket platformları (Yemeksepeti, Getir Yemek, Trendyol Go / Uber Eats, Migros Yemek): sunucu ve arayüzün ortak
 * sözlüğü. Platform siparişi bir POS satışıdır (paket ya da gel-al); platformun tahsil ettiği tutar platformun
 * `online` ödeme türüyle (kanal = platform, Z'de online) yazılır, kasada tahsil edilmez. Belgeler:
 * docs/PAKET-PLATFORMLARI.md.
 */
import type { PaymentChannel } from './labels';

export const PLATFORMS = ['yemeksepeti', 'getir', 'trendyol', 'migros'] as const;
export type PlatformId = (typeof PLATFORMS)[number] & PaymentChannel;

export const PLATFORM_LABEL: Record<PlatformId, string> = {
  yemeksepeti: 'Yemeksepeti',
  getir: 'Getir Yemek',
  trendyol: 'Trendyol Go',
  migros: 'Migros Yemek',
};

/** Rozet rengi (platformların rengine yakın, beyaz metinle en az 4,5:1 karşıtlık) */
export const PLATFORM_COLOR: Record<PlatformId, string> = {
  yemeksepeti: '#c8033f',
  getir: '#5d3ebc',
  trendyol: '#c2410c',
  migros: '#a16207',
};

/**
 * Platformun kabul süresi (sn): yanıt verilmezse sipariş platformda iptal olur. Getir 5 dk'da restoranı kapatır,
 * Yemeksepeti `expiryDate` (~15 dk), Migros belgesiz (10 dk varsayılır).
 */
export const ACCEPT_SECONDS: Record<PlatformId, number | null> = {
  yemeksepeti: 15 * 60,
  getir: 5 * 60,
  // Trendyol Go belgede süre vermez: 30 dk sonra şeritten düşer (platform o arada iptal eder)
  trendyol: 30 * 60,
  migros: 10 * 60,
};

/**
 * Platform başına mod: kapalı, deneme (simülatör; yalnız kurulum modunda) ya da canlı (gerçek bağdaştırıcı; anahtarlar
 * .env'de, server/delivery/registry.ts). Canlı yalnız bağdaştırıcısı olan ve anahtarı tanımlı platformda seçilebilir.
 */
export type PlatformMode = 'kapali' | 'deneme' | 'canli';
export const PLATFORM_MODES: readonly PlatformMode[] = ['kapali', 'deneme', 'canli'];
export const PLATFORM_MODE_LABEL: Record<PlatformMode, string> = { kapali: 'Kapalı', deneme: 'Deneme', canli: 'Canlı' };

/** Yönetim › Paket platformları: canlı bağlantının durumu */
export interface PlatformLiveStatus {
  /** LafPOS'ta bu platform için bağdaştırıcı var mı (Trendyol Go, Yemeksepeti, Getir var; Migros Yemek'in belgesi yok) */
  supported: boolean;
  /** Anahtarlar .env'de tanımlı mı */
  configured: boolean;
  /** Son başarılı yoklama */
  lastPollAt: number | null;
  lastError: string | null;
  /** Kabul edilmiş, platforma aşaması bildirilen açık siparişler */
  openOrders: number;
}

/** Platform ürünü → LafPOS ürünü eşlemesi (Yönetim › Paket platformları › Ürün eşleme); boşsa ada göre eşlenir */
export interface PlatformProductDTO {
  id: string;
  platform: PlatformId;
  externalId: string;
  name: string;
  productId: string | null;
  productName: string | null;
  lastSeenAt: number;
}

export interface PlatformSettings {
  mode: PlatformMode;
  /** Kabulde platforma bildirilen hazırlık süresi (dk) */
  prepMinutes: number;
  /** Raporda tahmini komisyon (yüzde); Trendyol Go gerçek komisyonu hesap kesiminde verir */
  commissionPct: number;
  /**
   * Otomatik kabul (varsayılan kapalı): yalnız bütün güvenli koşulları sağlayan sipariş, seçilen kişi adına kabul
   * edilir; ötekiler elle kabul bekler (docs/PAKET-PLATFORMLARI.md "Otomatik kabul")
   */
  autoAccept: boolean;
  /** Otomatik kabulde kabul eden kişi: etkin ve paket yetkili olmalı (her denemede yeniden okunur) */
  autoAcceptUserId: string | null;
  /** Otomatik kabul edilecek en yüksek müşteri tutarı (kuruş); üstü elle */
  autoAcceptMaxKurus: number;
}

/** Otomatik kabulün tutar sınırı: varsayılan ve ayarda girilebilecek en yüksek değer (kuruş) */
export const AUTO_ACCEPT_MAX_DEFAULT = 150_000;
export const AUTO_ACCEPT_MAX_LIMIT = 5_000_000;
/** Kabul süresinin bitmesine bundan az kalmışsa otomatik kabul denenmez (platform çağrısı yetişmeyebilir) */
export const AUTO_ACCEPT_MIN_LEFT_MS = 30_000;
/**
 * Sipariş saatinden (ileri tarihlide teslim saatinden) bu kadar geçmişse otomatik kabul edilmez: bağlantı kopukken
 * birikmiş sipariş platformda çoktan kaybolmuş olabilir (Trendyol Go'da kabul süresi kasaya geliş anından sayılır)
 */
export const AUTO_ACCEPT_MAX_AGE_MS = 30 * 60_000;
/** Otomatik kabul edilmeyen siparişin şeritteki notu bununla başlar (`lastError`): hata değil, elle kabul bekliyor */
export const AUTO_SKIP_PREFIX = 'Otomatik kabul edilmedi';

const DEFAULTS: PlatformSettings = { mode: 'kapali', prepMinutes: 20, commissionPct: 0, autoAccept: false, autoAcceptUserId: null, autoAcceptMaxKurus: AUTO_ACCEPT_MAX_DEFAULT };

export const PLATFORM_DEFAULTS: Record<PlatformId, PlatformSettings> = {
  yemeksepeti: { ...DEFAULTS },
  getir: { ...DEFAULTS },
  trendyol: { ...DEFAULTS },
  migros: { ...DEFAULTS },
};

/** Kim götürür: platformun kuryesi, restoranın kuryesi ya da müşteri gelip alır */
export type PlatformCourier = 'platform' | 'restoran' | 'gelal';

export const COURIER_LABEL: Record<PlatformCourier, string> = { platform: 'Platform kuryesi', restoran: 'Kendi kuryemiz', gelal: 'Gel-al' };

/** Platform siparişinin tek biçimi (her bağdaştırıcı buna çevirir). Tutarlar kuruş */
export interface PlatformOrderPayload {
  platform: PlatformId;
  /** Deneme siparişi (simülatör): yalnız kurulum modunda üretilir */
  simulated?: boolean;
  externalId: string;
  /** Kuryenin ve personelin söylediği kısa kod */
  code: string;
  placedAt: number;
  scheduledFor: number | null;
  courier: PlatformCourier;
  /**
   * Tahsilatı platform mu yapar: önceden online ödendiyse ya da kapıda ödemeyi platform kuryesi alıyorsa evet.
   * Hayırsa (kendi kuryemiz kapıda alır) ödeme kasada alınır
   */
  platformCollects: boolean;
  /** Müşterinin ödeme şekli: "Online kart", "Kapıda nakit", "Kapıda Multinet" */
  paymentLabel: string;
  customer: { name: string | null; phone: string | null; address: string | null };
  note: string | null;
  /** `kind: 'fee'`: platformun ücreti (teslimat, ambalaj): hizmet satırı olur (KDV %20, mutfağa gitmez), eşlenebilir */
  lines: { externalId: string | null; name: string; qty: number; unitPrice: number; modifiers: string[]; note: string | null; kind?: 'fee' }[];
  /** Satırların toplamı (birim fiyat × adet) */
  subtotal: number;
  /** Restoranın karşıladığı indirim (adisyon indirimi olur) */
  restaurantDiscount: number;
  /** Platformun karşıladığı indirim: müşteri daha az öder, fark platformdan gelir; ciroyu düşürmez */
  platformDiscount: number;
  /** Müşterinin ödediği */
  customerTotal: number;
  /** Platformun verdiği kabul süresi sonu (ms; geçmişse sipariş süresi dolmuş gelir); yoksa ACCEPT_SECONDS */
  expiresAt?: number | null;
  /**
   * Sipariş platformda (tablette) zaten kabul edildi (Yemeksepeti dolaylı akış): süre işlemez, kasadaki Kabul yalnız
   * adisyonu açar, ret ve iptal platformun uygulamasından yapılır
   */
  preAccepted?: boolean;
  /** Platformun test siparişi: mutfağa düşmesin diye kabul edilmez, yalnız reddedilir */
  test?: boolean;
  /**
   * Tutar ya da tahsilat platformdan doğrulanmalı: bağdaştırıcı platformun verdiği toplamları kalemlerle tam
   * açıklayamadı (Getir'in açıklanamayan farkı, Yemeksepeti'nde kasada alınacak tutarın sıfır görünmesi, Trendyol Go'da
   * ödenen tutarın olmaması ya da kalemleri aşması) ya da kendi kuryemizin siparişinde ödeme türü belirsiz (online mı
   * kapıda mı tahmin edildi). Doluysa sipariş otomatik kabul edilmez
   */
  amountReview?: string;
  /** İleri tarihli ama saati bilinmiyor (`scheduledFor` boş; saat notta ya da platformun panelinde): otomatik kabul edilmez */
  scheduledUnknown?: boolean;
  /** Bağdaştırıcının kendi verisi (sipariş belirteci, geri çağrı adresleri gibi); kasa yorumlamaz */
  platformData?: Record<string, unknown>;
}

export type PlatformOrderStatus = 'bekliyor' | 'kabul' | 'ret' | 'iptal' | 'suresi_doldu';

export const PLATFORM_STATUS_LABEL: Record<PlatformOrderStatus, string> = {
  bekliyor: 'Onay bekliyor',
  kabul: 'Kabul edildi',
  ret: 'Reddedildi',
  iptal: 'Platform iptal etti',
  suresi_doldu: 'Süresi doldu',
};

/** Ret nedenleri (platformların neden kodlarına bağdaştırıcı eşler) */
export const REJECT_REASONS = ['Ürün tükendi', 'Çok yoğunuz', 'Kapanmak üzereyiz', 'Adres hizmet alanı dışında', 'Diğer'] as const;

export interface PlatformOrderDTO {
  id: string;
  platform: PlatformId;
  status: PlatformOrderStatus;
  receivedAt: number;
  expiresAt: number | null;
  orderId: string | null;
  orderNo: number | null;
  decidedBy: string | null;
  reason: string | null;
  /** Kalemlerden eşleşmeyenler (LafPOS'ta karşılığı yok): kabulde "Platform ürünü" satırı olur */
  unmatched: string[];
  /** Kasada tükenmiş kalemler: kabul edilemez (ürünü satışa açın ya da reddedin) */
  soldOut: string[];
  payload: PlatformOrderPayload;
  /** Platforma son bildirimin ya da yerel kabulün hatası (eski sunucu göndermez) */
  lastError?: string | null;
  /** Kabul platforma gitti ama adisyon açılamadı: Kabul yalnız yerelde yeniden dener (süre dolmaz) */
  announced?: boolean;
  /** Platform iptal etti, adisyonda kasada alınmış ödeme var: ödeme geri alınınca kendiliğinden kapanır */
  cancelPending?: boolean;
}
