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

/** Bu sürümde platform başına mod: kapalı ya da deneme (simülatör). Gerçek bağlantı anahtar ve sözleşmeyle gelir */
export type PlatformMode = 'kapali' | 'deneme';

export interface PlatformSettings {
  mode: PlatformMode;
  /** Kabulde platforma bildirilen hazırlık süresi (dk) */
  prepMinutes: number;
  /** Raporda tahmini komisyon (yüzde); Trendyol Go gerçek komisyonu hesap kesiminde verir */
  commissionPct: number;
}

export const PLATFORM_DEFAULTS: Record<PlatformId, PlatformSettings> = {
  yemeksepeti: { mode: 'kapali', prepMinutes: 20, commissionPct: 0 },
  getir: { mode: 'kapali', prepMinutes: 20, commissionPct: 0 },
  trendyol: { mode: 'kapali', prepMinutes: 20, commissionPct: 0 },
  migros: { mode: 'kapali', prepMinutes: 20, commissionPct: 0 },
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
  lines: { externalId: string | null; name: string; qty: number; unitPrice: number; modifiers: string[]; note: string | null }[];
  /** Satırların toplamı (birim fiyat × adet) */
  subtotal: number;
  /** Restoranın karşıladığı indirim (adisyon indirimi olur) */
  restaurantDiscount: number;
  /** Platformun karşıladığı indirim: müşteri daha az öder, fark platformdan gelir; ciroyu düşürmez */
  platformDiscount: number;
  /** Müşterinin ödediği */
  customerTotal: number;
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
}
