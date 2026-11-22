import type { PlatformId } from './platforms';
import type { OrderDTO } from './types';

/** Bar geçmişi: bir istekte en çok bu kadar fiş (açık günün en yenileri) */
export const KITCHEN_HISTORY_MAX = 100;
/** Kapanan adisyonlar: sayfa başına varsayılan ve en çok satır */
export const CLOSED_PAGE_DEFAULT = 40;
export const CLOSED_PAGE_MAX = 100;
/** Arama metni en çok bu kadar karakter */
export const HISTORY_QUERY_MAX = 60;

/**
 * Siparişler › Kapanan listesinin satırı: kartı çizmeye yeten kadar (adisyonun tamamı ayrıntıda gelir). Adı
 * Siparişler kartıyla aynı kuraldan kurulsun diye sipariş alanları `OrderDTO` ile aynı adda (`orderCardName`)
 */
export interface ClosedOrderRow {
  id: string;
  no: number;
  type: OrderDTO['type'];
  source: OrderDTO['source'];
  tableName: string | null;
  numarator: string | null;
  extLabel: string | null;
  extNo: number | null;
  deliveryName: string | null;
  platform: PlatformId | null;
  platformCode: string | null;
  /** Adisyona bağlı kayıtlı müşteri (açık hesap, damga) */
  customerName: string | null;
  openedAt: number;
  closedAt: number | null;
  /** Adisyon tutarı (kuruş); sitede ödenmiş online siparişte sitenin tutarı */
  total: number;
  extPaid: boolean;
  /** İptal edilmemiş kalemlerin adedi ve kısa özeti ("2 Latte, 1 Cheesecake") */
  itemCount: number;
  summary: string;
  /** Daha fazla kalem varsa özetin dışında kalan satır sayısı */
  more: number;
  /** İptal edilen ve ciro dışı (ikram, ödenmez, zayi) kalem adedi: kartta küçük işaret */
  voided: number;
  comped: number;
  /** Ödeme türleri (iptal edilmeyenler); kör kasada boş */
  methods: string[];
  /** Yazarkasada kesilen son fişin numarası; yoksa null */
  receiptNo: number | null;
}

export interface ClosedOrdersDTO {
  /** Listelenen iş günü ve bugünün iş günü (YYYY-MM-DD) */
  date: string;
  today: string;
  /** Aramayla eşleşen (arama yoksa günün) kapanan adisyon sayısı */
  count: number;
  rows: ClosedOrderRow[];
  /** Sonraki sayfanın imleci (`before`); son sayfada null */
  next: string | null;
}

/** Yazarkasada kesilen mali fiş: Z ve fiş numarası. Tutar kör kasada gelmez */
export interface ClosedOrderReceipt {
  id: string;
  zNo: number | null;
  receiptNo: number | null;
  at: number;
  /** Fiş sonradan cihazda iptal edildi */
  cancelled: boolean;
  amount: number | null;
}

export interface ClosedOrderDetailDTO {
  /** Kişiye göre süzülmüş adisyon: kör kasada ödeme dökümü boş, başkasının adisyonunda garson ve ödemeyi alan gizli */
  order: OrderDTO;
  /** Ödeme dökümü bu kişiye gösterilmiyor (kör kasa): ekran "yok" demez, nedenini söyler */
  paymentsHidden: boolean;
  receipts: ClosedOrderReceipt[];
  /** Adisyonun iş günü (YYYY-MM-DD) */
  date: string;
}
