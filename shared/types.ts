import type { OrderTotals, SplitState } from './order-calc';
import type { Permission, Role } from './permissions';
import type { PlatformId } from './platforms';
import type { ServiceMode } from './service-mode';
import type { RoomBookingSnapshot, SiteKaraokeBooking } from './karaoke';
import type { TableCallDTO } from './site-alerts';

/** Sunucu ile arayüz arasındaki veri biçimleri. Para alanları kuruş. */

export type Size = 'M' | 'L' | 'TEK';

export interface SelectedOption {
  groupId: string;
  /** Grup adı: "Süt" */
  group: string;
  /** Sitedeki grup anahtarı: milk | roast | syrup | extraShot | sugar */
  groupKey: string | null;
  itemId: string;
  /** Seçenek adı: "Yulaf" */
  name: string;
  /** Sitedeki kimlik: "oat" */
  code: string | null;
  /** Birim başına fark fiyatı */
  price: number;
  qty: number;
}

export interface MeDTO {
  id: string;
  name: string;
  role: Role;
  color: string;
  permissions: Permission[];
  maxDiscountPct: number;
}

export interface UserLite {
  id: string;
  name: string;
  role: Role;
  color: string;
  active: boolean;
}

export interface SectionDTO {
  id: string;
  name: string;
  sort: number;
}

export interface TableDTO {
  id: string;
  sectionId: string;
  name: string;
  seats: number;
  shape: 'square' | 'rect' | 'round' | 'bar';
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'masa' | 'oda';
  hourlyRate: number | null;
  siteTableCode: string | null;
  /** Masanın QR kodu (shared/table-qr.ts); yoksa null */
  qrCode: string | null;
  sort: number;
}

export interface StationDTO {
  id: string;
  name: string;
  kind: 'bar' | 'mutfak' | 'diger';
  color: string;
}

export interface CategoryDTO {
  id: string;
  name: string;
  subtitle: string | null;
  color: string;
  sort: number;
  stationId: string | null;
  customizable: boolean;
  extKey: string | null;
  active: boolean;
}

export interface ProductDTO {
  id: string;
  categoryId: string;
  name: string;
  shortName: string | null;
  description: string | null;
  price: number;
  priceL: number | null;
  kdvRate: number;
  stationId: string | null;
  color: string | null;
  image: string | null;
  active: boolean;
  /** Tükendi'yi kim kapattı: 'site' ise kasiyer açamaz (Sitede satışta değil), yalnız menü yetkisi olan */
  soldOutBy: 'lafpos' | 'site' | null;
  hidden: boolean;
  favorite: boolean;
  sort: number;
  tags: string[];
  allergens: string[] | null;
  barcode: string | null;
  isService: boolean;
  portionsLeft: number | null;
  extSource: 'laffogato' | null;
  extId: string | null;
  posName: string | null;
  /** Yalnız rapor.maliyet yetkisi olana dolu gelir */
  cost?: number | null;
  /** Bağlı seçenek grupları (sıralı) */
  optionGroupIds: string[];
}

export interface OptionItemDTO {
  id: string;
  name: string;
  code: string | null;
  price: number;
  isDefault: boolean;
  maxQty: number;
  allergens: string[];
  /** Kasada Tükendi: seçenek penceresinde gri, kasa satışı almaz (409 `option_sold_out`) */
  soldOut: boolean;
}

export interface OptionGroupDTO {
  id: string;
  name: string;
  kind: 'single' | 'multi' | 'counter';
  required: boolean;
  maxSelect: number;
  extKey: string | null;
  items: OptionItemDTO[];
}

export interface PaymentMethodDTO {
  id: string;
  name: string;
  kind: 'nakit' | 'kart' | 'yemek' | 'havale' | 'cari' | 'online' | 'diger';
  zField: 'cash' | 'card' | 'meal_card' | 'online' | 'other';
  channel: string | null;
  color: string;
}

export interface HappyHourDTO {
  id: string;
  name: string;
  days: number[];
  start: string;
  end: string;
  percent: number;
  categoryIds: string[];
  productIds: string[];
  active: boolean;
}

export interface BusinessDayDTO {
  id: string;
  date: string;
  zNo: number;
  openedAt: number;
  openedByName: string | null;
  openingCash: number;
  closedAt: number | null;
  /** Gün sonundan sonra yeniden açıldıysa son açılış anı */
  reopenedAt?: number | null;
  /** Gün sonu kurulum modunda alındı (true, eğitim günü) ya da gerçek (false); null açık ya da işaretten önce kapandı.
   * lafmaliyet'e yalnız false giden gün gider */
  trainingDay?: boolean | null;
}

export interface PublicSettings {
  businessName: string;
  businessAddress: string;
  businessPhone: string;
  receiptHeader: string;
  receiptFooter: string;
  /** Adisyonda (hesap fişi) bağlı müşterinin adı yazılsın mı (varsayılan kapalı; müşteri yoksa hiç yazılmaz) */
  receiptCustomerName: boolean;
  /** Ödeme alınınca fiş yazıcısından kısa işyeri nüshası (kasa bilgisayarında; varsayılan açık) */
  receiptStoreCopy: boolean;
  /** Yazarkasa bağlı değilken ödemeden sonra müşteriye bilgi fişi ("mali değeri yoktur"; varsayılan kapalı) */
  receiptInfoSlip: boolean;
  serviceRate: number;
  autoLockMinutes: number;
  /** Kasa, bar ve tablet ekranı kararmasın (Screen Wake Lock) */
  keepAwake: boolean;
  /** Ürün kartlarında sitedeki görsel (küçük kopyası kasa sunucusunda) */
  productImages: boolean;
  /**
   * Seçenekleri sor: iki boylu üründe boy düğmesi hemen ekler; `zorunlu` (varsayılan) zorunlu seçimi olan üründe
   * (Türk kahvesinde şeker), `hep` seçeneği olan her üründe seçenek penceresini o boy seçili açar
   */
  askOptions: 'zorunlu' | 'hep';
  voidReasons: string[];
  compReasons: string[];
  /** Ödenmez kapanış gerekçeleri (personel yemeği, patron hesabı; ciro dışı) */
  odenmezReasons: string[];
  /** Zayi gerekçeleri (döküldü, yanlış hazırlandı, bozuk; ciro dışı, ayrı raporlanır) */
  zayiReasons: string[];
  discountReasons: string[];
  /** Hazır indirim nedenine dokununca yazılan yüzde (adisyon ve kalem indirimi); 0: kapalı, yüzde elle */
  discountPresetPct: number;
  quickCash: number[];
  sizeLabels: { M: string; L: string };
  requireDayOpen: boolean;
  kitchenWarnMinutes: number;
  kitchenAlarmMinutes: number;
  roomBillingStepMinutes: number;
  roomMinimumMinutes: number;
  stampGoal: number;
  stampCategoryKeys: string[];
  /** Kurulum modu: giriş ekranında örnek PIN'ler yazar. Canlıya geçince kapatılır */
  demoMode: boolean;
  /** Servis modu: masaya servis (varsayılan), yarı self ya da self servis (shared/service-mode.ts) */
  serviceMode: ServiceMode;
  /** Bahşiş alınır mı (varsayılan kapalı: işletme bahşiş almaz; eski kayıtlardaki bahşiş raporlarda kalır) */
  tipsEnabled: boolean;
  /**
   * Bar ekranı ve "Bara gönder" (operatör 20 Kas 2026; varsayılan açık). Kapalıyken kalem bara ve mutfağa gitmez
   * (istasyonsuz yazılır, teslim sayılır), adisyonda "Bara gönder" yerine "Kaydet", bar ekranı menüde yok
   */
  barEnabled: boolean;
  /** İki ekranlı kasanın müşteriye dönük ekranı (`/musteri-ekrani`): görünüm ve metinler, Yönetim › Müşteri ekranı */
  customerDisplay: CustomerDisplaySettings;
}

/** Müşteri ekranının teması: gece (koyu, varsayılan), porselen (açık, sitenin zemini), yeşil (marka yüzeyi) */
export const CUSTOMER_DISPLAY_THEMES = ['gece', 'porselen', 'yesil'] as const;
export type CustomerDisplayTheme = (typeof CUSTOMER_DISPLAY_THEMES)[number];

/**
 * Müşteri ekranının özelleştirmesi. Metinler müşteriye görünür; boş başlık varsayılan metne döner. Oturumsuz okunur
 * (`GET /api/public/display-config`): ekran personel PIN'iyle açık durmaz, burada gizli bir şey yoktur.
 */
export interface CustomerDisplaySettings {
  theme: CustomerDisplayTheme;
  /** Karşılama başlığı ("Hoş geldiniz") ve altındaki satır (slogan) */
  welcomeTitle: string;
  welcomeSubtitle: string;
  /** Ödemeden sonraki teşekkür başlığı */
  thanksTitle: string;
  /** Boştayken sırayla dönen kısa duyurular (en çok 6): happy hour, kampanya, uygulama */
  messages: string[];
  /** Karekod (uygulama, menü, Wi-Fi, Instagram); adres boşsa çizilmez */
  qrUrl: string;
  qrLabel: string;
  /** Sağ üstte saat */
  showClock: boolean;
  /** Sipariş satırlarında seçenekler (süt, şurup) */
  showOptions: boolean;
}

/** `GET /api/public/display-config`: müşteri ekranının ayarları ve işletme adı */
export interface DisplayConfigDTO extends CustomerDisplaySettings {
  businessName: string;
}

export interface BootstrapDTO {
  me: MeDTO;
  settings: PublicSettings;
  sections: SectionDTO[];
  tables: TableDTO[];
  stations: StationDTO[];
  categories: CategoryDTO[];
  products: ProductDTO[];
  optionGroups: OptionGroupDTO[];
  paymentMethods: PaymentMethodDTO[];
  happyHours: HappyHourDTO[];
  users: UserLite[];
  day: BusinessDayDTO | null;
  /**
   * Merkez'deki dükkân adı ve şube kodu (LafPOS Uzaktan › Merkez'den; server/sync/merkez.ts). Fişin başlığında yazılır.
   * Merkez'e bağlı değilse ya da henüz verilmediyse null (eski sunucu göndermez)
   */
  branch?: { name: string | null; code: string | null } | null;
  integrations: {
    /** `auto`: "Ödemeyi al" sepeti kendiliğinden cihaza yollar (Yönetim › Yazarkasa POS) */
    okc: { provider: 'kapali' | 'tokenx' | 'pavo' | 'simulator'; mode: 'anlik' | 'liste'; auto: boolean };
    /** Kasa bilgisayarında fiş yazıcısı bulundu (Windows kasa kısayolu bildirdi): ödeme sonrası fişler sessiz basılır */
    receiptPrinter: boolean;
    laffogatoPanel: boolean;
    lafmaliyetPush: boolean;
    /** Site adresi; boşsa site bağlantısı kurulmadı (LAFFOGATO_URL yok) */
    laffogatoUrl: string;
    /** Yerel damga kartı açık mı (varsayılan kapalı; site bağlantısı kuruluyken hiç açılmaz) */
    localStamps: boolean;
    /** Sitedeki karaoke rezervasyonları okunuyor mu (site bağlantısı, anahtar ve planda oda; §2.4) */
    siteKaraoke: boolean;
    /**
     * Deneme modu (kurulum modu ya da eğitim yazarkasası): satışlar eğitimdir, lafmaliyet'e gitmez. Kabuk her
     * ekranda "Deneme modu" şeridini gösterir (eski sunucu göndermez: şerit yok)
     */
    deneme?: boolean;
    /**
     * Deneme kapanmış ama "gerçek kullanıma başla" hiç tamamlanmamış (`liveSince` yok): eski sürümde patron PIN'i
     * değişince deneme sessizce kapanıyordu. Patron "Geçişi tamamla" ile bitirir (kayıt silinmez)
     */
    goLivePending?: boolean;
  };
  serverTime: number;
}

/** Yönetim › Ayarlar ve yedek › Deneme modu (GET /api/admin/deneme; yalnız patron) */
/** Gün sayısı ve tarih aralığı (iş günü, YYYY-MM-DD) */
export interface DayRangeDTO {
  days: number;
  from: string | null;
  to: string | null;
}

export interface DenemeStatusDTO {
  deneme: boolean;
  /** Gerçek kullanımın başladığı an; doluysa deneme verisi silme bir daha çalışmaz */
  liveSince: number | null;
  dayOpen: boolean;
  /** Deneme modu dışında kapanmış gün sayısı: 0 değilse silme yapılmaz */
  realDays: number;
  /**
   * Yarım kalmış geçiş: gerçek kullanım başlamamış (`liveSince` yok) ama gerçek gün var. "Geçişi tamamla" deneme
   * günlerini (`trialDays`) siler, gerçek günlere dokunmaz (isteğe bağlı `earlyRealDays` hariç); başlangıcı yazar,
   * örnek PIN'li hesapları kapatır
   */
  finalizeOnly: boolean;
  /** Kapanmış deneme günleri (eğitim günü ya da işaretsiz): "Geçişi tamamla" bunları siler */
  trialDays: DayRangeDTO;
  /**
   * Bugünden önceki gerçek görünen günler: bütün gerçek günler bugünden önceyse ve gerçek kullanım hiç başlamadıysa
   * pencere "onları da sil" seçeneğini (varsayılan işaretsiz) gösterir; yoksa null
   */
  earlyRealDays: DayRangeDTO | null;
  /** Gerçek olduğu kanıtlı (Pavo fişi, lafmaliyet'e gönderim) ya da kanıtlı günden sonraki, silinmeye önerilmeyen gerçek gün sayısı */
  provenRealDays?: number;
  counts: { orders: number; payments: number; days: number; cashMovements: number; reservations: number; customers: number; platformOrders: number; fiscalReceipts: number; audit: number };
  /** Örnek PIN'iyle duran öbür açık hesaplar (bitirince kapanır) */
  samplePinUsers: { id: string; name: string; role: string }[];
  /** Patronun kendi PIN'i örnek PIN: bitirirken yeni PIN zorunlu */
  mustChangeOwnPin: boolean;
  okcProvider: 'kapali' | 'tokenx' | 'pavo' | 'simulator';
}

export interface OrderItemDTO {
  id: string;
  productId: string | null;
  name: string;
  size: Size;
  options: SelectedOption[];
  optionsText: string;
  qty: number;
  unitPrice: number;
  basePrice: number;
  kdvRate: number;
  discount: number;
  discountReason: string | null;
  happyHour: boolean;
  complimentary: boolean;
  compReason: string | null;
  /** İkramın türü; ikram değilse null (eski ikramlar 'ikram') */
  compKind: CompKind | null;
  /** Ödenmezde adına yazılan kişi; başka türde ve eski kayıtlarda null */
  compPerson: CompPersonDTO | null;
  voided: boolean;
  voidReason: string | null;
  voidAfterSend: boolean;
  note: string | null;
  stationId: string | null;
  status: 'yeni' | 'hazirlaniyor' | 'hazir' | 'servis';
  /** Ödeme bekliyor (tezgâh satışında "Öde"): bara henüz gitmedi, ödeme alınınca gider */
  held: boolean;
  batch: number;
  sentAt: number;
  readyAt: number | null;
  paidQty: number;
  isService: boolean;
  createdBy: string | null;
  createdAt: number;
}

export interface PaymentDTO {
  id: string;
  methodId: string;
  methodName: string;
  zField: string;
  amount: number;
  tip: number;
  given: number | null;
  change: number | null;
  /** Kalem bazlı ödemede kalemler; `amount` bu adetlere düşen tutar (yazarkasa ve eski ödemelerde yok) */
  items: { itemId: string; qty: number; amount?: number }[] | null;
  customerId: string | null;
  note: string | null;
  userId: string | null;
  userName: string | null;
  createdAt: number;
  refundedAt: number | null;
  refundReason: string | null;
  /** Paylaşımlı hesapta pay: 2/4 */
  shareNo: number | null;
  shareOf: number | null;
}

export interface CustomerLite {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  stamps: number;
  creditLimit: number | null;
}

export interface RoomSessionDTO {
  id: string;
  startedAt: number;
  endedAt: number | null;
  hourlyRate: number;
  /** Bağlı site karaoke rezervasyonu (docs/03-ENTEGRASYON.md §2.4); yoksa null */
  bookingId: string | null;
  /** Bağlıysa rezervasyon bloğunun bu oturuma düşen kalanı (dakika) */
  prepaidMinutes: number | null;
  /** Bağlanırken saklanan rezervasyon koşulu (ad ve not yok); ekran güncel durumu sitenin listesinden okur */
  booking: RoomBookingSnapshot | null;
}

export interface OrderDTO {
  id: string;
  dayId: string;
  no: number;
  type: 'masa' | 'tezgah' | 'gelal' | 'paket' | 'online';
  status: 'acik' | 'kapali' | 'iptal' | 'birlesti';
  tableId: string | null;
  tableName: string | null;
  customer: CustomerLite | null;
  waiterId: string | null;
  waiterName: string | null;
  guests: number;
  note: string | null;
  openedAt: number;
  closedAt: number | null;
  discountType: 'percent' | 'amount' | null;
  discountValue: number | null;
  discountReason: string | null;
  serviceRate: number;
  total: number;
  paid: number;
  totals: OrderTotals;
  billPrintedAt: number | null;
  billPrints: number;
  /** Adisyonun tamamı ödenmez kapandıysa adına yazılan kişi; yoksa null */
  compPerson: CompPersonDTO | null;
  source: 'pos' | 'laffogato';
  extId: string | null;
  extNo: number | null;
  /** done: LafPOS'ta son aşamaya getirildi · gone: sitenin listesinden kalktı */
  extStage: 'new' | 'preparing' | 'ready' | 'done' | 'gone' | null;
  extFulfillment: 'table' | 'pickup' | 'delivery' | null;
  extLabel: string | null;
  extPaid: boolean;
  extTotal: number | null;
  scheduledFor: string | null;
  deliveryName: string | null;
  deliveryPhone: string | null;
  deliveryAddress: string | null;
  deliveryStatus: 'hazirlaniyor' | 'hazir' | 'yolda' | 'teslim' | null;
  courierId: string | null;
  cancelReason: string | null;
  /** Yarı self serviste masa no / numaratör ("12"); personel siparişi bu masaya götürür */
  numarator: string | null;
  /** Paket platformundan geldiyse platform ve kısa kod (shared/platforms.ts) */
  platform: PlatformId | null;
  platformCode: string | null;
  items: OrderItemDTO[];
  payments: PaymentDTO[];
  /**
   * Hesap paylaşımı (kişi sayısı, ödenen ve kalan paylar, elle mi); bölünmediyse null. `reset`: elle paylar hesap
   * değiştiği için düştü, paylar yeniden eşit (ekran kısa notla söyler)
   */
  split: (SplitState & { reset: boolean }) | null;
  room: RoomSessionDTO | null;
  version: number;
  updatedAt: number;
}

/** Masa planındaki bir masanın canlı durumu */
export interface FloorOrderSummary {
  id: string;
  no: number;
  total: number;
  paid: number;
  guests: number;
  openedAt: number;
  waiterId: string | null;
  waiterName: string | null;
  billPrintedAt: number | null;
  itemCount: number;
  /** Bar/mutfakta bekleyen kalem sayısı */
  pendingKitchen: number;
  /** Hazır olup servis bekleyen kalem */
  readyToServe: number;
  source: 'pos' | 'laffogato';
  roomStartedAt: number | null;
  /**
   * Parasal izi yok (sunucunun `isEmptyOrder`'ı: kalem, iptal edilmiş kalem ve ödeme satırı yok; oda sayacı ve yazarkasa
   * sepeti yok): gün sonu kendiliğinden kapatır, boş tezgâh satışı yeni satışta yeniden kullanılır. Kalemleri iptal
   * edilmiş adisyon `itemCount` 0 olsa da boş değildir, gün sonunu tutar. Eski Uzaktan özetinde yok
   */
  empty?: boolean;
}

/** Sitedeki karaoke rezervasyonu ve sayaca bağlandıysa adisyonu (docs/03-ENTEGRASYON.md §2.4) */
export interface SiteKaraokeBookingDTO extends SiteKaraokeBooking {
  /** Bu rezervasyona bağlı oda sayacı: çalışan, yoksa son duran */
  session: { orderId: string; orderNo: number; tableName: string; active: boolean } | null;
}

/**
 * Oda kutusunun gördüğü site karaokesi. `kapali`: site bağlantısı kurulmadı ya da site karaokeyi LafPOS'a açmadı;
 * `bekliyor`: bu iş günü için henüz alınmadı; `hata`: son çekim başarısız, eldeki liste gösterilir
 */
export interface SiteKaraokeDTO {
  state: 'kapali' | 'bekliyor' | 'hazir' | 'hata';
  message: string | null;
  /** İş günü (pencere) */
  date: string;
  pulledAt: number | null;
  complete: boolean;
  bookings: SiteKaraokeBookingDTO[];
}

export interface FloorStateDTO {
  tables: Record<string, FloorOrderSummary[]>;
  reservations: { id: string; tableId: string | null; time: string; name: string; guests: number; status: string }[];
  /**
   * Sitedeki bugünkü karaoke rezervasyonları (odayı tutanlar; site bağlantısı yoksa boş). Oda türündeki masaların
   * hepsine aittir: sitede tek karaoke odası var. Eski Uzaktan özetinde yok
   */
  siteKaraoke?: SiteKaraokeBookingDTO[];
  /**
   * Sitedeki açık masa çağrıları (uygulamada "Garson çağır", su, peçete), en eskisi önce; masa kartında rozet. Site
   * bağlantısı yoksa boş. Eski Uzaktan özetinde yok
   */
  siteCalls?: TableCallDTO[];
  /** Masaya bağlı olmayan açık siparişler (tezgah, gel-al, paket, online) */
  others: (FloorOrderSummary & { type: string; label: string })[];
}

export interface KitchenTicketItem {
  id: string;
  name: string;
  size: Size;
  optionsText: string;
  qty: number;
  note: string | null;
  status: 'yeni' | 'hazirlaniyor' | 'hazir' | 'servis';
  voided: boolean;
  stationId: string | null;
  sentAt: number;
  startedAt: number | null;
  readyAt: number | null;
  /** Teslim anı (bar geçmişi; eski sunucu göndermez) */
  servedAt?: number | null;
}

export interface KitchenTicket {
  key: string;
  orderId: string;
  orderNo: number;
  batch: number;
  label: string;
  type: string;
  source: 'pos' | 'laffogato';
  waiterName: string | null;
  note: string | null;
  sentAt: number;
  scheduledFor: string | null;
  /** Masa no / numaratör: fişte numara yerine "Masa 12" */
  numarator: string | null;
  /** Paket platformunun siparişi: teslimi platformun akışında, bar ekranında Teslim edildi düğmesi yok (eski sunucu göndermez) */
  platform?: PlatformId | null;
  /**
   * Tahsil edilecek bir şey yok: hesap kapandı ya da tamamı ödendi, ya da fişin bütün canlı kalemleri kalemi seçilerek
   * ödendi ya da ikram (tezgâh satışı ödeme alınınca bara düşer): fişte "Ödendi"; eski sunucu göndermez
   */
  paid?: boolean;
  /**
   * Bar geçmişi (`GET /kitchen?history=1`; öteki görünümlerde ve eski sunucuda yok): fişin hazır olduğu an (kalemlerin
   * en geçi; sitenin kendi akışında ilerleyen online siparişte bilinmez, null), hepsi teslim edildiyse teslim anı,
   * "Hazır" ve "Teslim edildi" diyenlerin adı
   */
  history?: { readyAt: number | null; servedAt: number | null; readyBy: string | null; servedBy: string | null };
  items: KitchenTicketItem[];
}

/**
 * Ciro dışı kapanan kalemin türü: müşteriye ikram, ödenmez (personel yemeği, patron hesabı) ya da zayi (döküldü,
 * yanlış hazırlandı, bozuk). Üçü de ödenmez, cirodan düşer; raporda ve Z'de ayrı görünür (shared/comp.ts).
 */
export type CompKind = 'ikram' | 'odenmez' | 'zayi';

/** Ödenmezin bağlandığı kayıtlı kişinin türü: personel (kullanıcı) ya da müşteri */
export type CompPersonKind = 'user' | 'customer';

/**
 * Ödenmez yazılan kişi: tür, kimlik ve yazıldığı andaki adının kopyası (kişi sonradan silinse ya da adı değişse de
 * kayıt okunur). Yalnız LafPOS'ta kalır: lafmaliyet'e, siteye ve müşteri ekranına gitmez. Maliyet yetkisi olmayana
 * başkasının adına yazılmış personel ödenmezinde kimlik boş, ad "Personel" gelir (personel tutarı)
 */
export interface CompPersonDTO {
  kind: CompPersonKind;
  id: string;
  name: string;
}

/** Kişi bazında ödenmez (rapor, Z): kimin adına, kaç adet, menü değeri. Kişisi olmayan eski kayıtta tür ve kimlik boş */
export interface OdenmezPersonDTO {
  kind: CompPersonKind | null;
  /** Gösterilmeyen personelde (maliyet yetkisi yok) null, adı "Personel" */
  id: string | null;
  name: string;
  qty: number;
  amount: number;
}

/** lafmaliyet Kasa raporundaki ödeme alanı */
export type ZField = 'cash' | 'card' | 'meal_card' | 'online' | 'other';

/** Gün sonu (Z) ya da ara rapor (X) özeti. Tutarlar kuruş. */
export interface ZSummary {
  orders: number;
  receipts: number;
  guests: number;
  gross: number;
  discounts: number;
  /** Ciro dışı kalemler (ikram ve ödenmez birlikte; lafmaliyet'e off_revenue) */
  complimentary: number;
  /** Ciro dışının ödenmez kısmı (personel yemeği, patron hesabı); eski Z'lerde yok */
  odenmez?: number;
  /** Ciro dışının zayi kısmı (döküldü, yanlış hazırlandı, bozuk); eski Z'lerde yok */
  zayi?: number;
  /** Ödenmezin kişi bazında dökümü (kapanmış adisyonlar); eski Z'lerde yok. lafmaliyet'e gitmez */
  odenmezPeople?: OdenmezPersonDTO[];
  voided: number;
  voidAfterSendCount: number;
  service: number;
  netSales: number;
  payments: { methodId: string; name: string; zField: ZField; channel: string | null; count: number; amount: number; tips: number }[];
  byZField: Record<ZField, number>;
  kdv: { rate: number; gross: number; base: number; kdv: number }[];
  tips: number;
  cariSales: number;
  cariCollections: number;
  cashIn: number;
  cashOut: number;
  handedOver: number;
  openingCash: number;
  expectedCash: number;
  countedCash: number | null;
  cashDiff: number | null;
  onlineOrders: number;
  onlineTotal: number;
  topProducts: { name: string; qty: number; amount: number }[];
  byUser: { userId: string; name: string; orders: number; amount: number }[];
  openOrdersAtClose: number;
}

/** Yönetim › Ağ ve uzaktan erişim: sunucunun dinlediği adresler */
export interface NetAddressDTO {
  /** Ağ kartının adı (Wi-Fi, Ethernet, Tailscale) */
  name: string;
  address: string;
  url: string;
}

export interface NetworkInfoDTO {
  hostname: string;
  port: number;
  /** Sunucu yalnız bu bilgisayarı dinliyor (LAFPOS_HOST): tabletler bağlanamaz */
  loopbackOnly: boolean;
  /** Kafenin ağındaki adresler; sanal ağ kartları (WSL, Hyper-V, VirtualBox) sonda */
  lan: NetAddressDTO[];
  /** Tailscale adresleri (100.64.0.0/10): telefon Tailscale açıkken her yerden */
  tailscale: NetAddressDTO[];
  /** LafPOS Uzaktan (Vercel): canlı özetin son gönderimi */
  cloud?: { configured: boolean; url: string | null; lastSuccessAt?: number; lastError?: string | null };
}

/** Çağrı ekranı (televizyon ya da tablet): gel-al ve tezgâh siparişleri, numara ve yalnız ad */
export interface PickupEntryDTO {
  id: string;
  no: number;
  /** Online siparişte müşterinin adı (soyadı gelmez); tezgâhta yok, numara söylenir */
  name: string | null;
  online: boolean;
  /** Masa no / numaratör girildiyse: ekranda numara yerine masa, sipariş masaya getirilir */
  table: string | null;
  /** Paket platformunun gel-al siparişi: müşteri uygulamada platformun kısa kodunu görür, ekranda numara yerine o */
  platform?: PlatformId | null;
  code?: string | null;
}

export interface PickupBoardDTO {
  preparing: PickupEntryDTO[];
  /** En yeni üstte; hazır olduktan 10 dakika sonra ya da teslim edilince düşer */
  ready: (PickupEntryDTO & { readyAt: number })[];
}

/** Müşteri ekranı: kasadaki adisyonun müşteriye gösterilen hâli (sunucu bellekte tutar, kaydetmez) */
export interface DisplayLineDTO {
  name: string;
  size: string | null;
  qty: number;
  options: string;
  total: number;
}

export type DisplayStateDTO =
  | { kind: 'idle'; at: number }
  | {
      kind: 'order';
      at: number;
      label: string;
      /** Kalemler menü fiyatıyla (adet × birim); ikram 0 */
      lines: DisplayLineDTO[];
      /** Kalem ve adisyon indirimlerinin toplamı */
      discount: number;
      /** Servis ücreti; kalemler − indirim + servis = toplam */
      service: number;
      total: number;
      paid: number;
      due: number;
    }
  | {
      kind: 'thanks';
      at: number;
      total: number;
      /** Self servisin çağrı kimliği ("No 34" ya da "Masa 12"); bara giden kalemi olmayan satışta ve eski kasada yok */
      call?: string;
    };

/**
 * Vardiya kasa sayımı: gün içinde kasiyer değişirken devreden kasayı sayar; o anki beklenen nakit ve fark saklanır.
 * Kör kasada (kasa rakamlarını görmeyen) beklenen ve fark null; sayılan tutar ve banknotlar yalnız sayana ve
 * devralana gider.
 */
export interface ShiftCountDTO {
  id: string;
  dayId: string;
  /** Sayan (devreden) */
  userId: string;
  userName: string;
  /** Devralan; boşsa yalnız ara sayım */
  toUserId: string | null;
  toUserName: string | null;
  /** Devralan sayımı kendi PIN'iyle onayladı */
  confirmed: boolean;
  counted: number | null;
  expected: number | null;
  /** Sayılan − beklenen, günün başından (eksi: kasa eksik) */
  diff: number | null;
  /** Bu vardiyanın kendi farkı: önceki sayımdan bu yana (ilk sayımda `diff`); uyarı ve alarm bununla */
  shiftDiff: number | null;
  /** Banknot ve madenî para adetleri: kuruş değeri → adet (gün sonu sayımıyla aynı biçim); toplam girildiyse null */
  banknotes: Record<string, number> | null;
  note: string | null;
  createdAt: number;
}
