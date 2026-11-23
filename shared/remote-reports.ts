/**
 * LafPOS Uzaktan raporları: kasanın her iş günü için buluta ittiği günlük rapor özeti (server/sync/cloud-reports.ts
 * kurar, api/uzaktan.ts saklar ve dönem için toplar). Yalnız tür: api/uzaktan.ts bunu `import type` ile alır (Vercel
 * işlevi göreli içe aktarmayı çalışma anında çözemez, tür derlemede silinir).
 *
 * Biçim kısa tutulur (Upstash'te gün başına bir anahtar, ~420 gün): listeler dizi demeti. Para kuruş. Maliyet, kâr,
 * PIN, müşteri adı ve telefonu yoktur (docs/07-UZAKTAN-ERISIM.md §4).
 */

import type { CheckRow, CrossPay, ItemListRow, OdenmezPersonRow, PlatformDayRow, PrepDone } from './remote-calc';
import type { PushedHistoryProducts } from './gecmis';

/** Merkez'e bağlı olmayan eski kasanın dükkânı; bağlı kasada kurulum kimliği (`lafpos:rapor:<dükkân>:gun:<tarih>`) */
export const REMOTE_SHOP = 'default';

/** Uzaktan raporların tutulduğu ve bir raporun alabileceği en uzun dönem (gün; kasadaki MAX_RANGE_DAYS ile aynı) */
export const REMOTE_REPORT_DAYS = 400;

export interface RemoteDaySummary {
  /** Liste değeri: brüt + ciro dışı (ikram, ödenmez, zayi) */
  list: number;
  gross: number;
  comp: number;
  disc: number;
  svc: number;
  /** Ciro (KDV dahil): kapanmış POS adisyonları */
  rev: number;
  odenmez: number;
  zayi: number;
  voided: number;
  receipts: number;
  items: number;
  tips: number;
  /** Masa adisyonlarının kişi sayısı ve cirosu (kişi başı) */
  guests: number;
  tableSales: number;
  paidClosed: number;
  paidOpen: number;
  onlineOrders: number;
  onlineAmount: number;
  /**
   * Yazarkasadan geçmeyen kart ve nakit (shared/order-calc.ts `offDeviceTotals`). Eski kasanın özetinde yok, patron
   * rolü kasa rakamlarını görmüyorsa (kör kasa) gitmez: dönemin bir günü taşımıyorsa uzakta satır yazmaz
   * (shared/remote-calc.ts `sumOffDevice`)
   */
  off?: { card: number; cash: number };
}

export interface RemoteDayReport {
  v: 1;
  /** İş günü (05:00 kuralı) */
  date: string;
  /** Kasada kurulduğu an: aynı günün eski özeti yenisini ezmez */
  at: number;
  /** O tarihteki iş günü sayısı (Raporlar'ın "N iş günü") */
  n: number;
  /** Günün bütün iş günleri kapandı mı (gün sonu alındı) */
  closed: boolean;
  /** Z numaraları */
  z: number[];
  s: RemoteDaySummary;
  /** Ödeme türleri: [ad, Z alanı, tutar, adet] */
  pay: [string, string, number, number][];
  /** Satış türleri: [tür, adisyon, tutar] */
  types: [string, number, number][];
  /** KDV: [oran, KDV dahil, matrah, KDV] */
  kdv: [number, number, number, number][];
  /** Kapanan satış, kapandığı dakikaya göre (gün başından): [dakika, ciro, adisyon]; bugünün kıyası için */
  closes: [number, number, number][];
  /** Ürünler: [anahtar, ad, boy, kategori, adet, ciro, ikram adedi, iptal adedi] */
  prod: [string, string, string, string, number, number, number, number][];
  /** Saatlik: [gün başından geçen saat, ciro, adisyon] (dolu saatler) */
  hours: [number, number, number][];
  /** Saatin kendisine göre ciro (haftanın günü × saat ısı haritası): [saat 0-23, ciro] */
  clock: [number, number][];
  /** Personel: [kimlik, ad, adisyon, ciro, iptal adedi, iptal tutarı, ikram adedi, ikram tutarı, indirim, ödenmez adedi, ödenmez tutarı] */
  staff: [string, string, number, number, number, number, number, number, number, number, number][];
  /** Gün aşırı ödemeler (shared/remote-calc.ts `CrossPay`); eski kasanın özetinde yok */
  xpay?: CrossPay[];
  /** Geçmiş ciro günü (shared/gecmis.ts `historyReport`): önceki kasa programının adı ("ModPOS"); LafPOS gününde yok */
  kaynak?: string;
  /** Geçmiş gündeki önceki programın Z numarası ("Z-2026-002"); LafPOS'un Z'si `z`'de, sayı */
  zText?: string;
  /** Geçmiş gününün indirimi bilinmiyor (yalnız ModPOS föyünden): `s.disc` 0 ama raporlar onu bilinen sıfır saymaz */
  indirimBilinmiyor?: true;
  /**
   * Geçmiş cironun dönem ürün listesi (shared/gecmis.ts `PushedHistoryProducts`, indirim öncesi): kasa bloğun dönemindeki
   * her geçmiş gününe koyar, `n` o dönemin geçmiş günü sayısıdır. Uzaktan bloğu yalnız seçilen dönem bloğu kapsıyor ve
   * bloğu taşıyan `n` günün hepsi raporda duruyorsa ürün ürün gösterir (api/uzaktan.ts `pushedHistoryBlock`)
   */
  urunler?: PushedHistoryProducts;
  /** Ek sekmeler (hazırlama, adisyonlar, kalem listeleri, iadeler, platformlar): bulutta ayrı anahtarda tutulur */
  x?: RemoteDayExtra;
}

/**
 * Günün ek verisi. Kasadaki raporun tek günlük çıktısı; dönem için shared/remote-calc.ts ile birleşir. Buluta gitmez:
 * iptal, ikram, indirim ve iade nedenleri, müşteri adı (ödenmez kişisi "Müşteri"), maliyet ve komisyon
 */
export interface RemoteDayExtra {
  prep: { done: PrepDone[]; hand: number[] };
  checks: CheckRow[];
  lists: { iptal: ItemListRow[]; ikram: ItemListRow[]; indirim: ItemListRow[]; happy: ItemListRow[] };
  odenmez: OdenmezPersonRow[];
  refunds: { id: string; at: number; orderNo: number | null; method: string; amount: number; reason: null; by: string | null }[];
  plat: { rows: PlatformDayRow[]; pending: number };
  /**
   * Kasada sınırı aşınca kısaltılan listeler (server/sync/cloud-reports.ts `fitExtra`): düşen satırların sayısı ve
   * tutarı; uzakta toplamlara eklenir, liste "kısaltıldı" der
   */
  cut?: { iptal?: ListCut; ikram?: ListCut; indirim?: ListCut; happy?: ListCut; checks?: number };
}

export interface ListCut {
  count: number;
  value: number;
}

/** Kasanın bir itmesi (`POST /api/uzaktan/rapor`, gzip'li gövde `gz`) */
export interface RemoteReportPush {
  v: 1;
  shop: string;
  /** Kasanın "bugün"ü (açık iş günü) ve itmenin anı: uzaktaki Raporlar'ın "Bugün"ü ve kıyasın "aynı saate kadar"ı */
  today: string;
  at: number;
  days: RemoteDayReport[];
  /** Ürünlerin bugünkü kategorisi (ürün kimliği → kategori adı): dönemde kategori kasadaki gibi bugünküdür */
  cat?: Record<string, string>;
}
