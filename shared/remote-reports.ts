/**
 * LafPOS Uzaktan raporları: kasanın her iş günü için buluta ittiği günlük rapor özeti (server/sync/cloud-reports.ts
 * kurar, api/uzaktan.ts saklar ve dönem için toplar). Yalnız tür: api/uzaktan.ts bunu `import type` ile alır (Vercel
 * işlevi göreli içe aktarmayı çalışma anında çözemez, tür derlemede silinir).
 *
 * Biçim kısa tutulur (Upstash'te gün başına bir anahtar, ~420 gün): listeler dizi demeti. Para kuruş. Maliyet, kâr,
 * PIN, müşteri adı ve telefonu yoktur (docs/07-UZAKTAN-ERISIM.md §4).
 */

/** Şimdilik tek dükkân; Merkez gelince dükkân kimliği anahtarın parçası olur (`lafpos:rapor:<dükkân>:gun:<tarih>`) */
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
}

/** Kasanın bir itmesi (`POST /api/uzaktan/rapor`, gzip'li gövde `gz`) */
export interface RemoteReportPush {
  v: 1;
  shop: string;
  /** Kasanın "bugün"ü (açık iş günü) ve itmenin anı: uzaktaki Raporlar'ın "Bugün"ü ve kıyasın "aynı saate kadar"ı */
  today: string;
  at: number;
  days: RemoteDayReport[];
}
