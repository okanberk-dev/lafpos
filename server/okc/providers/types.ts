import type { MethodKind } from '../basket';
import type { TokenxBasket } from '../tokenx';

/**
 * Yazarkasa sağlayıcılarının ortak sözleşmesi. Her marka (Token, Pavo, ileride Hugin, Ingenico) bir sağlayıcıdır;
 * adisyon, sepet, kilit, zorla iptal ve sonucun adisyona işlenmesi `service.ts`'te tek yerdedir, sağlayıcı yalnız
 * cihazla konuşur. Sonuç markadan bağımsız `FiscalResult`'tır: mali fiş, bilgi fişi ya da e-belge (VUK 507 cihazları).
 */

export type ProviderId = 'tokenx' | 'tokenkablo' | 'pavo' | 'hugin' | 'simulator';

/**
 * AsilPOS'un cihaz sepeti. Biçim TokenX sepetiyle aynıdır: birim fiyat kuruş, adet x1000, KDV oranı x100, kısım no,
 * kalemin indirim payı `adjust.totalValue`. Diğer sağlayıcılar bu biçimden kendi biçimlerine çevirir.
 */
/**
 * `odemeTuru`: yalnız Pavo; kasada seçilen ödeme türü cihazda önceden seçili gelir (providers/pavo.ts `pavoSale`).
 * `odemeAraci`: yemek kartında cihazın ödeme aracı no'su (Yönetim › Yazarkasa POS › yemek kartı eşlemesi)
 */
export type FiscalBasket = TokenxBasket & { odemeTuru?: 'nakit' | 'kart' | 'yemek'; odemeAraci?: number };

/** Cihazın kestiği belge: ÖKC mali fişi, bilgi fişi (yemek kartı, fatura), e-Arşiv ya da e-Fatura (VUK 507 cihazları) */
export type DocKind = 'okc_fis' | 'bilgi_fisi' | 'e_arsiv' | 'e_fatura';

export interface FiscalPayment {
  kind: MethodKind;
  amount: number;
  /** Yemek kartı operatörü (Multinet, Pluxee...) cihazın verdiği kimlikle; AsilPOS ödeme türüne eşlenir */
  operatorId: number | null;
  description: string | null;
}

/**
 * Cihazdan gelen sonuç. `paid`: ödeme alındı ve belge kesildi · `cancelled`: cihazda vazgeçildi, belge yok ·
 * `voided`: kesilmiş belge cihazda iptal edildi (ödeme geri alınır, adisyon yeniden açılır).
 */
export interface FiscalResult {
  status: 'paid' | 'cancelled' | 'voided';
  docKind: DocKind | null;
  zNo: number | null;
  receiptNo: number | null;
  /** e-Arşiv / e-Fatura ETTN ya da belge numarası */
  docId: string | null;
  payments: FiscalPayment[];
  /** Cihazın ham yanıtı (denetim ve destek için) */
  raw?: unknown;
}

export interface ProviderCapabilities {
  /** push: sepeti biz cihaza yollarız · pull: cihaz açık sepetleri bizden çeker (sunucu internetten erişilebilir olmalı) */
  transport: 'push' | 'pull' | 'local';
  /** Kasada ödeme: sepet hemen cihazın ekranına düşer */
  instant: boolean;
  /** Masada ödeme: cihaz açık sepetleri listeler, garson seçer */
  list: boolean;
  /** Bir sepette birden çok ödeme (kart + nakit) */
  splitPayment: boolean;
  /** Sepet cihazdan silinebilir (ödeme alınmadıysa) */
  cancel: boolean;
  /** Durum sorgulanabilir (webhook ulaşmazsa) */
  poll: boolean;
  docKinds: DocKind[];
}

/**
 * Sorgu sonucu: belge kesildi, sepet cihazdan silindi, sağlayıcıda böyle bir sepet hiç yok (yanıtı alınamayan
 * gönderim ulaşmamış) ya da hâlâ bekliyor (kilitli/kilitsiz)
 */
export type PollOutcome =
  | { kind: 'result'; result: FiscalResult }
  | { kind: 'deleted' }
  | { kind: 'missing' }
  | { kind: 'pending'; locked: boolean; lockedBy: string | null };

export interface PendingReceipt {
  id: string;
  status: string;
  mode: 'anlik' | 'liste';
  basket: FiscalBasket;
  amount: number;
}

export interface FiscalProvider {
  id: ProviderId;
  label: string;
  capabilities: ProviderCapabilities;
  /** Bağlantı bilgileri tanımlı mı; değilse `notConfigured` açıklaması gösterilir */
  configured(): boolean;
  notConfigured: string;
  terminalId(): string | null;
  /** Yönetim ekranında gösterilecek durum (gizli değer içermez) */
  status(): Record<string, unknown>;
  /**
   * Sepetin cihaza gidebilir olduğunu sepet kaydı yazılmadan denetler (ör. cihazın bilmediği KDV grubu); gidemezse
   * okunur mesajla hata fırlatır, kasiyer hatayı görür, adisyon kilitlenmez
   */
  validate?(basket: FiscalBasket): void;
  /**
   * Sepeti cihaza yollar. Çekme (pull) sağlayıcısında sepet AsilPOS'ta bekler, cihaz kendisi alır. Hata
   * `uncertain: true` taşıyorsa (zaman aşımı, bağlantı koptu) sepet cihaza ulaşmış olabilir: bekleyen kalır ve
   * `poll` ile sorgulanır; diğer hatalarda sepet cihazda yok sayılır.
   */
  send(receipt: PendingReceipt): Promise<void>;
  /** Sepeti cihazdan siler (ödeme alınmadıysa); ulaşılamazsa hata fırlatır */
  cancel(receipt: PendingReceipt): Promise<void>;
  poll?(receipt: PendingReceipt): Promise<PollOutcome>;
  test?(): Promise<unknown>;
}
