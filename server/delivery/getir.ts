import { tl } from '@shared/money';
import { ACCEPT_SECONDS, PLATFORM_LABEL, type PlatformCourier, type PlatformOrderPayload, REJECT_REASONS } from '@shared/platforms';
import { signedFetch } from '../lib/signature';
import { networkError, type PlatformAdapter, PlatformHttpError, type PlatformNotify } from './adapter';

/**
 * Getir Yemek bağdaştırıcısı (GetirFood API 1.5.8; belgeler calisma/arastirma/paket-platformlari/getir/* ve README,
 * calisma-notlari dalı). Getir siparişi bizim verdiğimiz iki adrese iter (yeni sipariş, iptal; başlıkta bizim
 * ürettiğimiz `x-api-key`): AsilPOS Uzaktan (Vercel, api/uzaktan.ts `getir/*`) kaydı Redis'teki gelen kutusuna koyar,
 * kasa gelen kutusunu imzalı olarak 20 saniyede bir çeker, işler ve siler. Yedek: kasa doğrudan Getir'in onaysız
 * (`/food-orders/periodic/unapproved`), iptal (`/periodic/cancelled`) ve onaylı (`/food-orders/active`) listelerini
 * de okur (en sık dakikada bir; aktarıcı düşmüşse hemen); iki yoldan gelen aynı sipariş tekilleşir.
 *
 * - Kimlik: `POST /auth/login` {appSecretKey, restaurantSecretKey} → {token, restaurantId}; jeton 1 saat, her
 *   istekte `token` başlığı; 401'de bir kez yeniden giriş (aynı anda tek giriş). Restoran kimliği bilinmeden
 *   aktarıcının sipariş kaydı alınmaz (başka restoranın siparişi ayıklanamaz): girişe dek gelen kutusunda kalır.
 * - Akış: `/verify` (ileri tarihli onaysız, durum 325: `/verify-scheduled`) → `/prepare` → Getir kuryesinde
 *   (deliveryType 1) `/handover`, kendi kuryemizde (2) `/deliver`; ret ve iptal `/cancel` {cancelReasonId, cancelNote},
 *   neden `/cancel-options`'tan (sipariş başına 5 dk saklanır: uç 10 dk'da 40 istekle sınırlı). Getir verify,
 *   prepare ve deliver arasında en az 1 dakika ister (belge "Order Flow"; handover bu kurala bağlı değil). Aralık
 *   tekdüze saatle tutulur (saat geri alınsa da en çok 1 dk beklenir); kasa yeniden başlayınca son çağrı bilinmez,
 *   açılıştan 1 dk beklenir.
 * - Getir'in bütün hizmet hataları HTTP 400'dür (belge "Service Error Messages"): geçici olanlar koduyla ayrılır
 *   (`GETIR_TRANSIENT_CODES`); giriş hatası siparişe ait değildir, hiçbir zaman kalıcı sayılmaz.
 * - Para TL ondalık gelir, kuruşa çevrilir; saatler GMT (belge "System Time").
 *
 * Belgeden emin olunmayanlar (güvenli taraf seçildi; canlıya geçmeden Getir'in test ortamında bir tur atılır, uyuşmayan
 * ad yalnız bu dosyanın başındaki sabitlerde değişir):
 * - 74 (PreparedTimeLimit) ve 62 (DeliveredToClientTimeLimit): 1 dk kuralının ihlali mi, süre aşımı mı belgede yok.
 *   İlkinde aşama bir aralık beklenip bir kez daha denenir; yine aynı kod gelirse kalıcı (park ve alarm).
 * - 3 (durum geçersiz) bir aşamaya gelirse Getir'deki durum `GET /food-orders/{id}`'den okunur: aşama orada geçilmişse
 *   (yanıtı kaybolan önceki denememiz uygulanmış, aşama Getir tabletinden ya da kuryeden ilerlemiş, ileri tarihli
 *   sipariş Getir'ce 500'e alınmış) başarı sayılır, sonraki aşama gider. Geçildi sayılan: swagger'daki `prepareDate`,
 *   `handoverDate`, `deliverDate` alanları ya da durum eşikleri (`GETIR_PASSED_STATUS`: hazır ≥ 500, kuryeye
 *   verildi ≥ 600, teslim ≥ 900; belgede yalnız 500 "hazırlanıyor" var, öteki numaralar test ortamında doğrulanır).
 *   Etkinleşmemiş ya da yeniden onay bekleyen ileri tarihli siparişte (325, 350, 400) hazır bir aralık sonra yeniden
 *   denenir (425); iptal belirtisi (iptal nedeni, notu, saati ya da ≥ 1500) ya da geride kalan durum kalıcı ret.
 *   Durum okunamazsa: önceki denemenin yanıtı kaybolduysa (ağ, 5xx) uygulanmış sayılır, yoksa geçici (park yok).
 * - `result: false` ya da nesne olmayan 2xx gövde (vekil sunucunun HTML'i gibi) hiçbir uçta başarı sayılmaz: kabulde
 *   kasada kabul edilmez, aşamada ve iptalde geçici hata olarak yeniden denenir (yinelenen kabul 2, iptal 13 döner).
 * - İleri tarihli sipariş: push gövdesinde `scheduledDate` yok; saat `GET /food-orders/{id}`'den alınır. Alınamazsa
 *   kayıt bir dakikaya dek gelen kutusunda bekletilir (yedek liste ya da sonraki tur saati getirsin; Getir'in 5 dk'lık
 *   kabul süresinin içinde), sonra siparişin notuna "saat Getir panelinde" yazılarak alınır. Belge "400 ön onaylı ileri tarihli → /verify" der: 325'i kasada
 *   `/verify-scheduled` ile kabul edilmiş sipariş etkinleşince 400 olarak yeniden onaysız listede görünürse
 *   bağdaştırıcı `/verify`'ı kendisi gönderir (`reconfirm`). 400 + ileri tarihli siparişin 5 dk'lık süresi etkinleşme
 *   anından işler; o an belgede olmadığı için kasaya geliş anından sayılır. 325 iken `/verify-scheduled` 3 dönerse
 *   (sipariş o arada etkinleşmiş) `/verify` denenir.
 * - `/food-orders/active` yanıtı (Getir'de onaylı siparişler): 350 ve üstü, 400 olmayan, teslim edilmemiş (900 altı,
 *   `deliverDate` yok) ve iptal belirtisi taşımayan (yanıt şemasında `cancelReason`, `cancelNote`; push'ta `cancelDate`;
 *   durum ≥ 1500) sipariş onaylı sayılır. Kasada onay bekleyen ya da süresi dolmuş kayıt "platformda kabul edildi"
 *   olur; kasanın hiç görmediği sipariş tabletten kabul edilmiş gibi gelir (Kabul yalnız adisyonu açar).
 * - Etkinleşen ileri tarihli siparişin yeniden itmesi (400 + ileri tarihli): onay sipariş başına bir kez gider; 5 dk
 *   içinde aynı sipariş yeniden 400 görünürse beklenir (`RECONFIRM_QUIET_MS`), Getir "zaten onaylı" (2) derse aralık
 *   yeniden başlamaz.
 * - İndirim alanları (`totalDiscountedPrice`, satırda `…DiscountedPriceWithOption`) indirim yokken 0 gelebilir: değer
 *   yalnız 0 < değer < taban ise indirim sayılır. İndirim Getir'in kendi alanlarından okunur; Getir'in toplamı ile
 *   kalemler arasındaki açıklanamayan fark indirimden ayrı tutulur: toplam kalemleri aşarsa fark adisyona ve platform
 *   alacağına girmez, uydurma ücret satırı olmaz, notta Getir'in toplamı, indirimli toplamı ve kalemler yazar ("Getir'den
 *   doğrulayın"); müşterinin ödediği kalemlerden indirimin açıklayamayacağı kadar düşükse fark restoran indirimi
 *   sayılır (Getir'in karşıladığını gösteren alan yok: platform payı uydurulmaz), notta görünür.
 * - Ödeme: Getir'in metninde "online" ya da "kapıda" kelimesi geçiyorsa (başta ya da içeride, "Kredi Kartı (Online)")
 *   karar ona uyar (3 Kredi / Banka Kartı'nın kapıda sayılması bizim varsayımımız); kod bilinmiyorsa, metin iki
 *   kelimeyi birden taşıyorsa ya da bilinen kodun yönüyle çelişiyorsa etiket "Getir'den doğrulayın" der ve Yönetim
 *   uyarır.
 * - Giriş olmadan (restoran kimliği bilinmeden) aktarıcının siparişleri kasaya alınmaz: yoklama "engelli" döner,
 *   Yönetim ilk turda uyarır, sürerse (5 dk) alarm; aynı siparişin iptal kaydı da gelen kutusunda bekler.
 * - Girişin gövdesi (swagger JSON şema, açıklama "HTTP Basic Auth"), hata gövdesindeki `code` alanı, `/periodic`
 *   uçlarının biçimi (dizi; `{data: [...]}` de kabul), iptal seçeneği metinleri, ürün kimliği alanı (`product`,
 *   zincirde `chainProduct`; yoksa kalem ada göre eşlenir, satır kimliği eşleme anahtarı olmaz).
 */

export const GETIR_DEFAULT_URL = 'https://food-external-api-gateway.getirapi.com';
/** Test ortamı (belge "URLs") */
export const GETIR_TEST_URL = 'https://food-external-api-gateway.development.getirapi.com';

const enc = encodeURIComponent;
export const GETIR_PATHS = {
  login: '/auth/login',
  unapproved: '/food-orders/periodic/unapproved',
  cancelled: '/food-orders/periodic/cancelled',
  active: '/food-orders/active',
  order: (id: string) => `/food-orders/${enc(id)}`,
  verify: (id: string) => `/food-orders/${enc(id)}/verify`,
  verifyScheduled: (id: string) => `/food-orders/${enc(id)}/verify-scheduled`,
  prepare: (id: string) => `/food-orders/${enc(id)}/prepare`,
  handover: (id: string) => `/food-orders/${enc(id)}/handover`,
  deliver: (id: string) => `/food-orders/${enc(id)}/deliver`,
  cancel: (id: string) => `/food-orders/${enc(id)}/cancel`,
  cancelOptions: (id: string) => `/food-orders/${enc(id)}/cancel-options`,
};

/** Sipariş durumları (belge "Order Flow"): 325 ileri tarihli onaysız, 400 onaysız (anlık ya da ön onaylı ileri tarihli), 350 onaylı, 500 hazırlanıyor */
export const GETIR_STATUS = { scheduledUnapproved: 325, unapproved: 400, verified: 350, preparing: 500 } as const;

/**
 * Aşamanın Getir'de geçildiği sayılan en küçük durum (3 gelince okunur; "emin olunmayanlar"). Belgede yalnız 500
 * "hazırlanıyor" var (prepare "hazırlanıyor" yapar); 600 kuryeye verildi ve 900 teslim test ortamında doğrulanır.
 * Önce swagger'daki tarih alanlarına (`prepareDate`, `handoverDate`, `deliverDate`) bakılır
 */
export const GETIR_PASSED_STATUS = { prepare: 500, handover: 600, deliver: 900 } as const;
/** Bu durum ve üstü iptal (test ortamında doğrulanır; iptal nedeni ya da notu da iptal belirtisidir) */
export const GETIR_CANCELLED_FROM = 1500;

/** Kim götürür (`deliveryType`): 1 Getir kuryesi, 2 restoranın kuryesi (belge "Order Flow"); gel-al belgede yok */
export const GETIR_DELIVERY = { getir: 1, restaurant: 2 } as const;

/**
 * Ödeme türleri (belge "Payment Methods"). Online olanlar (kasada tahsil edilmez): 1 MasterPass (belge: online),
 * 2 BKM Express, 15 MobilExpress, 16 GetirMoney (cüzdan), 19 Sodexo Online. Belge hangilerinin online olduğunu tek tek
 * yazmaz ("online ödeme türleri /payment-methods'ta listelenmez"): 3 Kredi / Banka Kartı kapıda POS cihazı sayıldı
 * (online kart MasterPass'tır); Getir'in metni "Online …" derse ona uyulur. Test ortamında doğrulanır.
 */
export const GETIR_ONLINE_METHODS: ReadonlySet<number> = new Set([1, 2, 15, 16, 19]);
export const GETIR_PAYMENT_LABEL: Record<number, string> = {
  1: 'MasterPass',
  2: 'BKM Express',
  3: 'Kredi / Banka Kartı',
  4: 'Nakit',
  5: 'Multinet',
  6: 'Sodexo',
  8: 'Ticket',
  10: 'Setcard',
  11: 'Metropol',
  12: 'Paye',
  15: 'MobilExpress',
  16: 'GetirMoney',
  17: 'Sodexo Pass Mobil',
  18: 'CIO',
  19: 'Sodexo Online',
  21: 'TokenFlex',
};

/** Getir hizmet hata kodları (belge "Service Error Messages"); yanıt gövdesinde `code` beklenir */
export const GETIR_ERROR_TEXT: Record<number, string> = {
  1: 'sipariş bulunamadı',
  2: 'sipariş zaten onaylanmış',
  3: 'sipariş bu durumda değil',
  4: 'sipariş o an kilitli',
  11: 'sipariş iptal edilemez',
  12: 'bu aşamada restoran iptal edemez',
  13: 'sipariş zaten iptal edilmiş',
  14: 'kurye bu aşamaya hazır değil',
  15: 'kurye henüz restorana ulaşmadı',
  28: 'sipariş başka restoranın',
  38: 'restoran Getir\'de kapalı',
  59: 'iptal nedeni gerekli',
  62: 'teslim için süre sınırı',
  73: 'Getir uygulama anahtarı tanınmadı',
  74: 'hazırlandı için süre sınırı',
  79: 'ileri tarihli sipariş henüz etkinleşmedi (teslimden 1 saat önce onaylanır)',
  92: 'restoran bulunamadı',
};

/**
 * Zamanla düzelen Getir kodları (hepsi HTTP 400 gelir): 4 sipariş o an kilitli, 14 kurye durumu, 15 kurye henüz
 * restorana ulaşmadı, 79 ileri tarihli sipariş henüz etkinleşmedi. Kalıcı sayılmaz, sonraki turda yeniden denenir
 */
export const GETIR_TRANSIENT_CODES: ReadonlySet<number> = new Set([4, 14, 15, 79]);
/** Anlamı belirsiz süre kodları: bir aralık beklenip bir kez daha denenir (yukarıdaki "emin olunmayanlar") */
export const GETIR_INTERVAL_CODES: ReadonlySet<number> = new Set([62, 74]);

/** Aşama çağrıları arasında Getir'in istediği bekleme (belge: en az 1 dakika) */
export const STEP_GAP_MS = 60_000;
/** Yedek yoklamanın (onaysız, iptal ve onaylı listeler) en sık aralığı: belge "/unapproved sürekli sorgulanmamalı" */
export const BACKUP_EVERY_MS = 60_000;
/** İptal seçeneklerinin saklanma süresi (`/cancel-options` 10 dk'da 40 istek, aşılınca 60 sn blok) */
export const CANCEL_OPTIONS_TTL_MS = 5 * 60_000;
/** İleri tarihli siparişin saati alınamazsa kaydın gelen kutusunda bekletildiği en uzun süre (geliş anından) */
export const SCHEDULE_LOOKUP_MS = 60_000;
/** Yeniden onayı gitmiş siparişin bu süre içinde yeniden 400 görünmesi onay istemez (liste gecikmesi) */
export const RECONFIRM_QUIET_MS = 5 * 60_000;

export interface GetirConfig {
  appSecretKey: string;
  restaurantSecretKey: string;
  /** Canlı GETIR_DEFAULT_URL; test ortamı GETIR_TEST_URL */
  apiUrl: string;
  cloudUrl: string;
  cloudSecret: string;
  /** Testte kısaltılır */
  stepGapMs?: number;
  backupEveryMs?: number;
  /**
   * Son girişte öğrenilen restoran kimliğinin kalıcı kaydı (server/delivery/registry.ts, sync_state): kasa yeniden
   * başlayıp Getir'e giremese de aktarıcıdan yalnız kendi gelen kutusunu ister, bütün kutuları okumaz (Upstash bütçesi)
   */
  restaurantMemory?: { load(): string | null; save(id: string): void };
}

export const getirConfigured = (c: GetirConfig) => !!(c.appSecretKey && c.restaurantSecretKey && c.cloudUrl && c.cloudSecret.length >= 32);

// ─── Getir sipariş gövdesi (belge "Integration Structure" ve swagger "Get Food Order Response Schema"; isteğe bağlı okunur)

export interface GetirName {
  tr?: string;
  en?: string;
}

export interface GetirProduct {
  /** Satır kimliği (her siparişte yeni): eşleme anahtarı değildir */
  id?: string;
  /** Restoranın ürün kimliği (Ürün eşleme buna bağlanır); zincirde chainProduct */
  product?: string;
  chainProduct?: string;
  count?: number;
  name?: GetirName | string;
  /** Birim fiyat (TL), seçenekler hariç */
  price?: number;
  optionPrice?: number;
  priceWithOption?: number;
  totalPrice?: number;
  totalOptionPrice?: number;
  /** Adet × (ürün + seçenek) */
  totalPriceWithOption?: number;
  /** Yapısı belgede boş nesne; seçenek adları displayInfo'dan okunur */
  optionCategories?: unknown[];
  displayInfo?: { title?: GetirName; options?: { tr?: string[]; en?: string[] } };
  note?: string;
  discountedPriceWithOption?: number;
  totalDiscountedPriceWithOption?: number;
}

export interface GetirOrder {
  id: string;
  status?: number;
  isScheduled?: boolean;
  /** Kuryenin ve müşterinin söylediği onay kodu */
  confirmationId?: string;
  client?: {
    id?: string;
    name?: string;
    contactPhoneNumber?: string;
    /** Maskeli: "+90 (850) 000-00000 / 000000" */
    clientPhoneNumber?: string;
    clientUnmaskedPhoneNumber?: string;
    deliveryAddress?: { id?: string; address?: string; aptNo?: string; floor?: string; doorNo?: string; city?: string; district?: string; description?: string };
    location?: { lat?: number; lon?: number };
  };
  courier?: { id?: string; status?: number; name?: string };
  products?: GetirProduct[];
  clientNote?: string;
  doNotKnock?: boolean;
  dropOffAtDoor?: boolean;
  /** TL; indirimden önce ve sonra. İndirimi kimin karşıladığı belgede yok */
  totalPrice?: number;
  totalDiscountedPrice?: number;
  checkoutDate?: string;
  scheduledDate?: string;
  verifyDate?: string;
  /** Aşama saatleri (swagger "Get Food Order Response Schema"): aşamanın Getir'de geçildiğini gösterir */
  prepareDate?: string;
  handoverDate?: string;
  deliverDate?: string;
  deliveryType?: number;
  isEcoFriendly?: boolean;
  paymentMethod?: number;
  paymentMethodText?: GetirName;
  restaurant?: { id?: string; name?: string };
  isQueued?: boolean;
  cancelDate?: string;
  cancelNote?: string;
  cancelReason?: { id?: string; messages?: GetirName; cancelSource?: number };
}

/** Aktarıcının gelen kutusundaki kayıt: sipariş (newOrder) ya da iptal (cancelOrder) */
export type InboxItem =
  | { id: string; kind: 'order'; receivedAt: number; order: GetirOrder }
  | { id: string; kind: 'cancel'; receivedAt: number; orderId: string; reason?: string; restaurantId?: string };

/**
 * Sayı okuyucu: sayı ya da sayısal metin ("150", "12,5"); yoksa null. Bir alanın "var" sayılması ile okunması aynı
 * kurala bağlıdır (metin sayı ya iki yerde de okunur ya da hiçbirinde)
 */
const num = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v.trim().replace(',', '.'));
    return Number.isFinite(n) ? n : null;
  }
  return null;
};
/** TL → kuruş; okunamayan değer null */
const kurusOf = (v: unknown): number | null => {
  const n = num(v);
  return n == null ? null : Math.round(n * 100);
};
const toQty = (v: unknown): number => {
  const n = num(v) ?? 1;
  return n >= 1 ? Math.round(n) : 1;
};
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** Getir saatleri GMT (belge "System Time"): saat dilimi yazılmamış ISO metin UTC sayılır (yerel sanılırsa 3 saat kayar) */
export const toMs = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v > 1e12 ? v : v * 1000;
  if (typeof v !== 'string' || !v.trim()) return null;
  let s = v.trim();
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s = `${s.replace(' ', 'T')}Z`;
  const d = Date.parse(s);
  return Number.isNaN(d) ? null : d;
};
const nameOf = (n: GetirName | string | undefined): string | null => (typeof n === 'string' ? text(n) : (text(n?.tr) ?? text(n?.en)));

/** Kim götürür: deliveryType 1 Getir kuryesi, 2 kendi kuryemiz; bilinmeyen değer kendi kuryemiz sayılır (adres ve telefon kasaya gelsin) */
export function courierOf(o: GetirOrder): PlatformCourier {
  return o.deliveryType === GETIR_DELIVERY.getir ? 'platform' : 'restoran';
}

/** "online" ve "kapıda" kelimesi metnin herhangi bir yerinde (başta, içeride, parantezde; harf sınırıyla) */
const ONLINE_WORD = /(^|[^\p{L}])online([^\p{L}]|$)/iu;
const DOOR_WORD = /(^|[^\p{L}])kap[ıi]da([^\p{L}]|$)/iu;
/** Kapıda sayılması bizim varsayımımız olan kod (3 Kredi / Banka Kartı): metin "online" derse çelişki sayılmaz */
const ASSUMED_DOOR_METHOD = 3;

/**
 * Ödeme: online mı, kasada görünen adı, doğrulanması gerekiyor mu. Getir'in metninde "online" ya da "kapıda" kelimesi
 * geçiyorsa (başta ya da içeride: "Kredi Kartı (Online)") karar ona uyar, yoksa tür koduna bakılır; etiket kararla hiç
 * çelişmez. Kod bilinmiyorsa, metin iki kelimeyi birden taşıyorsa ya da bilinen kodun yönüyle çelişiyorsa etiket
 * "Getir'den doğrulayın" der (`verify`)
 */
export function paymentOf(o: GetirOrder): { online: boolean; label: string; verify: boolean } {
  const method = typeof o.paymentMethod === 'number' && Number.isFinite(o.paymentMethod) ? o.paymentMethod : null;
  const known = method != null && GETIR_PAYMENT_LABEL[method] != null;
  const txt = nameOf(o.paymentMethodText);
  const saysOnline = !!txt && ONLINE_WORD.test(txt);
  const saysDoor = !!txt && DOOR_WORD.test(txt);
  const both = saysOnline && saysDoor;
  const byText = both ? null : saysOnline ? true : saysDoor ? false : null;
  const byCode = method != null && GETIR_ONLINE_METHODS.has(method);
  const online = byText ?? byCode;
  // Kodun "kapıda" sayılması bizim varsayımımız (belge yazmaz): metin "online" derse o geçer. Bilinen kodla metin
  // çelişirse (online kod + "kapıda", kapıda kod + "online") ya da metin iki yönü birden söylüyorsa etiket doğrulatır
  const conflict = both || (byText != null && known && byText !== byCode && method !== ASSUMED_DOOR_METHOD);
  const name = txt ?? (known ? GETIR_PAYMENT_LABEL[method!]! : null);
  if (!known && byText == null) return { online, label: `${name ?? (method != null ? `Ödeme türü ${method}` : 'Ödeme türü yok')}: Getir'den doğrulayın`, verify: true };
  // Ad kararın kelimesini zaten taşıyorsa olduğu gibi, yoksa önüne eklenir ("Kapıda … (Online)" hiç üretilmez)
  const label = both || (online ? saysOnline : saysDoor) ? name! : `${online ? 'Online' : 'Kapıda'} ${name}`;
  return conflict ? { online, label: `${label} (ödeme türü ${method ?? 'yok'}): Getir'den doğrulayın`, verify: true } : { online, label, verify: false };
}

function addressOf(o: GetirOrder): string | null {
  const a = o.client?.deliveryAddress;
  if (!a) return null;
  const detail = [a.aptNo && `${a.aptNo}`, a.floor && `kat ${a.floor}`, a.doorNo && `daire ${a.doorNo}`].filter(Boolean).join(', ');
  const parts = [a.address, detail, a.district, a.city, a.description].map(text).filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** Etkinleşmiş (ön onaylı) ileri tarihli sipariş: onaysız listede 400 ve ileri tarihli; `/verify` ister */
export const activatedScheduled = (o: Pick<GetirOrder, 'status' | 'isScheduled'>) => o.status === GETIR_STATUS.unapproved && !!o.isScheduled;

/**
 * İptal belirtisi: yanıt şemasında (`/active`, `/periodic`, `GET /food-orders/{id}`) iptal nedeni ve notu, push
 * gövdesinde iptal saati; durum `GETIR_CANCELLED_FROM` ve üstü
 */
export const cancelledOnGetir = (o: GetirOrder) =>
  !!(text(o.cancelReason?.id) || text(o.cancelNote) || text(o.cancelDate) || (typeof o.status === 'number' && o.status >= GETIR_CANCELLED_FROM));

/**
 * Getir'de onaylanmış (`/food-orders/active`), iptal edilmemiş ve teslim edilmemiş sipariş: durum 350 ve üstü, 400
 * değil (onaysız listedekiler 325 ve 400), teslim eşiğinin altında ve teslim saati yok, iptal belirtisi yok. Belirsiz
 * durum (eşiğin üstü) onaylı sayılmaz: kasaya tabletten kabul edilmiş gibi düşmesin
 */
export const approvedOnGetir = (o: GetirOrder) =>
  typeof o.status === 'number' &&
  o.status >= GETIR_STATUS.verified &&
  o.status !== GETIR_STATUS.unapproved &&
  o.status < GETIR_PASSED_STATUS.deliver &&
  !text(o.deliverDate) &&
  !cancelledOnGetir(o);

/**
 * Getir siparişi → AsilPOS'un tek biçimi. Satırın birim fiyatı ürün + seçenekler (`priceWithOption`); adet toplamı
 * (`totalPriceWithOption`) tutmuyorsa birim ona göre düzeltilir. Getir ücret satırı (teslimat, ambalaj) göndermez:
 * Getir kuryesinin ücretini Getir müşteriden kendisi alır. İndirim Getir'in kendi alanlarından okunur (`totalPrice` −
 * `totalDiscountedPrice`, satırda `totalDiscountedPriceWithOption`; büyük olan) ve kimin karşıladığını belge yazmaz:
 * restoran kampanyası sayılır (Getir'in karşıladığı kampanya varsa farkı hesap kesiminde görünür). İndirimli değer
 * yalnız 0 < değer < taban ise sayılır. Getir'in toplamı ile kalemler arasındaki açıklanamayan fark indirimden ayrı
 * tutulur ("emin olunmayanlar"): toplam kalemleri aşarsa fark adisyona ve platform alacağına girmez, notta görünür;
 * müşterinin ödediği indirimin açıklayamayacağı kadar düşükse fark restoran indirimi sayılır (adisyon onun üstünde
 * kalmaz), notta görünür. Platform payı hiç uydurulmaz (Getir'in karşıladığını gösteren alan yok). Kabul süresi
 * sipariş saatinden 5 dk (belge "Time Limit for Order Confirmation"); etkinleşmiş ileri tarihli siparişte kasaya geliş
 * anından. `preAccepted`: Getir'de zaten onaylı (`/food-orders/active`)
 */
export function fromGetirOrder(o: GetirOrder, now = Date.now(), opts: { preAccepted?: boolean } = {}): PlatformOrderPayload {
  if (typeof o.id !== 'string' || !o.id) throw new Error('sipariş kimliği yok');
  const courier = courierOf(o);
  const pay = paymentOf(o);
  const lines: PlatformOrderPayload['lines'] = [];
  let lineDiscount = 0;
  for (const p of o.products ?? []) {
    const qty = toQty(p.count);
    let unit = kurusOf(p.priceWithOption) ?? (kurusOf(p.price) ?? 0) + (kurusOf(p.optionPrice) ?? 0);
    const total = kurusOf(p.totalPriceWithOption) ?? 0;
    if (total > 0 && Math.abs(total - unit * qty) > qty) unit = Math.round(total / qty);
    const lineTotal = unit * qty;
    const unitDiscounted = kurusOf(p.discountedPriceWithOption);
    const discounted = kurusOf(p.totalDiscountedPriceWithOption) ?? (unitDiscounted != null ? unitDiscounted * qty : null);
    // İndirim yokken 0 gelen (ya da tabana eşit, ondan büyük) değer indirim değildir
    if (discounted != null && discounted > 0 && discounted < lineTotal) lineDiscount += lineTotal - discounted;
    const modifiers = (p.displayInfo?.options?.tr ?? p.displayInfo?.options?.en ?? []).map(text).filter((m): m is string => !!m);
    // Satır kimliği (`id`) her siparişte yenidir: eşleme anahtarı olmaz, ürün kimliği yoksa kalem ada göre eşlenir
    lines.push({ externalId: text(p.product) ?? text(p.chainProduct), name: nameOf(p.name) ?? nameOf(p.displayInfo?.title) ?? 'Ürün', qty, unitPrice: unit, modifiers, note: text(p.note) });
  }
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const listed = kurusOf(o.totalPrice);
  const discounted = kurusOf(o.totalDiscountedPrice);
  const hasDiscounted = listed != null && discounted != null && discounted > 0 && discounted < listed;
  const orderDiscount = hasDiscounted ? listed - discounted : 0;
  // İndirim Getir'in kendi alanlarından: satır indirimleri sipariş toplamında da yer alır, büyük olan alınır
  let restaurantDiscount = Math.min(subtotal, Math.max(orderDiscount, lineDiscount));
  // Müşterinin Getir'de ödediği (indirimli toplam, yoksa toplam)
  const paid = discounted != null && discounted > 0 ? discounted : listed != null && listed > 0 ? listed : null;
  const platformCollects = pay.online || courier === 'platform';
  const getirTotal = listed != null ? `Getir toplamı ${tl(listed)}${hasDiscounted ? ` (indirimli ${tl(discounted)})` : ''}` : `Getir toplamı ${tl(paid ?? 0)}`;
  const atDoor = !platformCollects && paid != null ? `; müşteri kapıda ${tl(paid)} öder` : '';
  let gapNote: string | null = null;
  if (listed != null && listed > subtotal) {
    // Getir'in toplamı kalemleri aşıyor: farkın ne olduğu belgede yok (ücret mi, okunamayan seçenek mi). İndirimden
    // ayrı tutulur (indirimle birbirini sessizce götürmez); adisyona ve platform alacağına girmez, notta görünür
    gapNote = `${getirTotal}, kalemler ${tl(subtotal)}: ${tl(listed - subtotal)} farkı Getir'den doğrulayın${atDoor}`;
  } else if (paid != null && paid > subtotal) {
    // Toplam yok ya da kalemlerin altında ama ödenen kalemlerin üstünde: uydurma ücret satırı açılmaz; notta görünür
    restaurantDiscount = 0;
    gapNote = `Getir'de ödenen ${tl(paid)}, kalemler ${tl(subtotal)}: ${tl(paid - subtotal)} farkı Getir'den doğrulayın${atDoor}`;
  } else if (paid != null) {
    const unexplained = subtotal - restaurantDiscount - paid;
    // Adisyon müşterinin ödediğinden ne fazla ne az: fazla sayılmış indirim geri alınır (sessizce); indirimin
    // açıklayamadığı eksik restoran indirimi sayılır (Getir'in karşıladığı bilinmez, platform payı uydurulmaz), notta
    restaurantDiscount = subtotal - paid;
    if (unexplained > 0) gapNote = `Kalemler ${tl(subtotal)}, ${getirTotal}: ${tl(unexplained)} farkı indirim sayıldı, Getir'den doğrulayın`;
  }
  const customerTotal = subtotal - restaurantDiscount;
  const placed = toMs(o.checkoutDate);
  const scheduledFor = o.isScheduled ? toMs(o.scheduledDate) : null;
  const noteParts = [
    opts.preAccepted ? 'Getir panelinden onaylandı' : null,
    o.isScheduled && scheduledFor == null ? 'İLERİ TARİHLİ: saat Getir panelinde' : null,
    gapNote,
    text(o.clientNote),
    courier === 'restoran' && o.doNotKnock ? 'Kapıyı çalmayın' : null,
    courier === 'restoran' && o.dropOffAtDoor ? 'Kapıya bırakın' : null,
  ].filter(Boolean);
  const phone = text(o.client?.contactPhoneNumber) ?? text(o.client?.clientPhoneNumber) ?? text(o.client?.clientUnmaskedPhoneNumber);
  return {
    platform: 'getir',
    simulated: false,
    externalId: o.id,
    code: text(o.confirmationId) ?? o.id.slice(-4),
    placedAt: placed ?? now,
    scheduledFor,
    courier,
    // Online ödendiyse ya da kapıda ödemeyi Getir kuryesi alıyorsa tahsilat platformun; kendi kuryemiz kapıda alırsa kasada
    platformCollects,
    paymentLabel: pay.label,
    customer: { name: text(o.client?.name), phone: courier === 'restoran' ? phone : null, address: courier === 'restoran' ? addressOf(o) : null },
    note: noteParts.length ? noteParts.join(' · ') : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount: 0,
    customerTotal,
    // Getir 5 dk içinde yanıt ister (sipariş saatinden; geç çekilen sipariş taze süre almaz). Etkinleşmiş ileri tarihli
    // siparişin süresi etkinleşmeden işler (saati belgede yok): kasaya geliş anından. Saat yoksa kasa ACCEPT_SECONDS uygular
    expiresAt: opts.preAccepted ? null : activatedScheduled(o) || placed == null ? undefined : placed + ACCEPT_SECONDS.getir! * 1000,
    ...(opts.preAccepted ? { preAccepted: true } : {}),
    // Getir siparişinde test bayrağı yok (test ortamının siparişleri gerçek akışla denenir)
    test: false,
    // Açıklanamayan fark (notta da yazar), Getir'in toplamı hiç gelmedi (kalemler çapraz denetlenemez; Trendyol Go ve
    // Yemeksepeti'nde de aynı kural) ya da kendi kuryemizin siparişinde belirsiz ödeme türü (tahsilatı kim yapar
    // tahmin): otomatik kabul edilmez. Saati okunamayan ileri tarihli sipariş de
    ...(gapNote || paid == null || (pay.verify && courier !== 'platform') ? { amountReview: gapNote ?? (paid == null ? "Getir toplamı gelmedi: tutarı Getir'den doğrulayın" : pay.label) } : {}),
    ...(o.isScheduled && scheduledFor == null ? { scheduledUnknown: true } : {}),
    platformData: { status: o.status ?? null, isScheduled: !!o.isScheduled, deliveryType: o.deliveryType ?? null, restaurantId: text(o.restaurant?.id), paymentMethod: o.paymentMethod ?? null },
  };
}

type Data = { status?: number | null; isScheduled?: boolean; restaurantId?: string | null };
const dataOf = (o: PlatformOrderPayload): Data => (o.platformData ?? {}) as Data;

/**
 * Kasadaki ret nedenleri → Getir'in iptal seçeneği (`/cancel-options` {id, message}); seçenek metinleri belgede yok,
 * anahtar kelimeyle eşlenir, bulunamazsa "diğer" ya da ilk seçenek. Test ortamında doğrulanır.
 */
export const GETIR_REASON_PATTERNS: Record<(typeof REJECT_REASONS)[number], RegExp> = {
  'Ürün tükendi': /ürün|stok|tüken|malzeme|kalmad/,
  'Çok yoğunuz': /yoğun|kapasite|busy/,
  'Kapanmak üzereyiz': /kapan|kapalı|closed|mesai/,
  'Adres hizmet alanı dışında': /adres|bölge|mesafe|hizmet alanı|uzak|teslimat alanı/,
  Diğer: /diğer|other/,
};

export function pickCancelOption(options: { id?: unknown; message?: unknown }[], reason: string): { id: string; message: string } | null {
  const valid = options.filter((x): x is { id: string; message?: string } => !!x && typeof x.id === 'string' && !!x.id).map((x) => ({ id: x.id, message: text(x.message) ?? '' }));
  if (!valid.length) return null;
  const find = (re: RegExp) => valid.find((x) => re.test(x.message.toLocaleLowerCase('tr-TR')));
  const pattern = (GETIR_REASON_PATTERNS as Record<string, RegExp | undefined>)[reason];
  return (pattern && find(pattern)) ?? find(GETIR_REASON_PATTERNS.Diğer) ?? valid[0]!;
}

// ─── Getir istemcisi ─────────────────────────────────────────────────────────

/**
 * Getir'in yanıtı; `code` Getir hizmet hata kodu (belge "Service Error Messages"). `auth`: girişin hatası (anahtar,
 * ağ geçidi): siparişe ait değildir, hiçbir zaman kalıcı sayılmaz (sipariş park edilmez, kasadaki iptal kapanmaz)
 */
export class GetirHttpError extends PlatformHttpError {
  constructor(
    status: number,
    message: string,
    readonly code: number | null = null,
    readonly auth = false,
  ) {
    super(status, message);
  }
  /** Giriş hatası ve zamanla düzelen kodlar (GETIR_TRANSIENT_CODES) geçicidir; ötekiler HTTP koduna göre */
  override get permanent(): boolean {
    if (this.auth) return false;
    if (this.code != null && GETIR_TRANSIENT_CODES.has(this.code)) return false;
    return super.permanent;
  }
}

async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<{ status: number; json: unknown }> {
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? 8000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal }).catch((e) => {
      throw networkError(e, timeoutMs);
    });
    const raw = await res.text().catch((e) => {
      throw networkError(e, timeoutMs);
    });
    let json: unknown = null;
    try {
      json = raw ? JSON.parse(raw) : null;
    } catch {
      json = raw;
    }
    return { status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}

/** Hata gövdesindeki Getir kodu (`code`), varsa */
function codeOf(json: unknown): number | null {
  if (!json || typeof json !== 'object') return null;
  const c = (json as { code?: unknown }).code;
  return typeof c === 'number' && Number.isFinite(c) ? c : null;
}

/** Hata metni; `login`: girişin 404'ü "sipariş bulunamadı" değildir (adres ya da ağ geçidi) */
function explain(status: number, json: unknown, login = false): string {
  const code = codeOf(json);
  const msg = json && typeof json === 'object' ? ((json as { message?: string }).message ?? (json as { error?: string }).error) : typeof json === 'string' ? json.slice(0, 120) : null;
  const known = code != null ? GETIR_ERROR_TEXT[code] : undefined;
  const why = known ?? (status === 401 || status === 403 ? 'kimlik reddedildi' : status === 429 ? 'istek sınırı aşıldı' : status === 404 && !login ? 'sipariş bulunamadı' : `HTTP ${status}`);
  return msg && !known ? `${why}: ${msg}` : code != null ? `${why} (Getir ${code})` : why;
}

/**
 * Getir'in uygulandı yanıtı: nesne gövde ve `result` false değil (swagger Model23 {result}, iptal Model4 {}). Değilse
 * hata: `status` 409 kabulde (kasada kabul edilmez), 502 aşamada ve iptalde (geçici, yeniden denenir)
 */
function ensureApplied(json: unknown, what: string, status: number): void {
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new GetirHttpError(status, `Getir ${what}: yanıt beklenen biçimde gelmedi`);
  if ((json as { result?: unknown }).result === false) throw new GetirHttpError(status, `Getir ${what}: uygulanmadı (result: false)`);
}

/** Jeton: `POST /auth/login`; 1 saat geçerli (belge "Authentication"), 55 dakikada yenilenir, 401'de bir kez yeniden alınır */
export class GetirClient {
  private token: { value: string; expiresAt: number } | null = null;
  /** Süren giriş: aynı anda gelen çağrılar aynı girişi bekler (yeni giriş eski jetonu düşürebilir) */
  private loggingIn: Promise<string> | null = null;
  /** Girişte Getir'in verdiği restoran kimliği: başka restoranın siparişi ayıklanır */
  restaurantId: string | null = null;
  /** En az bir kez giriş yapıldı (restoran kimliği yanıtta yoksa da ayıklama denendi sayılır) */
  identified = false;
  constructor(private readonly c: GetirConfig) {}

  private url(path: string) {
    return `${this.c.apiUrl.replace(/\/+$/, '')}${path}`;
  }

  private async login(): Promise<string> {
    // Swagger gövdeyi JSON şemayla verir (appSecretKey, restaurantSecretKey); açıklamadaki "HTTP Basic Auth" sözü test ortamında doğrulanır
    // Girişin ağ hatası da girişin hatasıdır (`auth`): aşama isteği hiç çıkmadı, "yanıtı kayboldu" sayılmaz
    const { status, json } = await request(this.url(GETIR_PATHS.login), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ appSecretKey: this.c.appSecretKey, restaurantSecretKey: this.c.restaurantSecretKey }) }).catch((e: unknown) => {
      throw e instanceof PlatformHttpError && !(e instanceof GetirHttpError) ? new GetirHttpError(e.status, e.message, null, true) : e;
    });
    const out = json as { token?: string; restaurantId?: string } | null;
    // Girişin hatası (yanlış ya da iptal edilmiş anahtar: 73, 92; adres; ağ geçidi) siparişe ait değil: hiçbir zaman kalıcı değil
    if (status !== 200 || !out?.token) throw new GetirHttpError(status, `giriş olmadı (${explain(status, json, true)})`, codeOf(json), true);
    this.token = { value: out.token, expiresAt: Date.now() + 55 * 60_000 };
    if (typeof out.restaurantId === 'string' && out.restaurantId) this.restaurantId = out.restaurantId;
    this.identified = true;
    return this.token.value;
  }

  /** Tek uçuş: süren giriş varsa onu bekler */
  private refresh(): Promise<string> {
    this.loggingIn ??= this.login().finally(() => {
      this.loggingIn = null;
    });
    return this.loggingIn;
  }

  private bearer(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return Promise.resolve(this.token.value);
    return this.refresh();
  }

  /** Giriş yapılmamışsa yapar (restoran kimliği öğrenilir) */
  async ready(): Promise<void> {
    await this.bearer();
  }

  /**
   * Jetonlu istek; 2xx'te gövde, yoksa GetirHttpError. 401 ve 403'te bir kez daha denenir: bu arada başka çağrı
   * jetonu yenilediyse yenisiyle, yoksa yeniden girişle (aynı anda tek giriş)
   */
  async call(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
    let token = await this.bearer();
    for (let attempt = 0; attempt < 2; attempt++) {
      const headers: Record<string, string> = { token, accept: 'application/json' };
      if (body !== undefined) headers['content-type'] = 'application/json';
      const { status, json } = await request(this.url(path), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      if (status >= 200 && status < 300) return json;
      if ((status === 401 || status === 403) && attempt === 0) {
        const used = token;
        if (this.loggingIn) token = await this.loggingIn;
        else if (this.token && this.token.value !== used) token = this.token.value;
        else {
          this.token = null;
          token = await this.refresh();
        }
        continue;
      }
      throw new GetirHttpError(status, explain(status, json), codeOf(json));
    }
    throw new GetirHttpError(401, 'kimlik reddedildi');
  }

  post(path: string, body: unknown = {}) {
    return this.call('POST', path, body);
  }

  /** Sipariş listesi (onaysız, iptal, onaylı): dizi; `{data: [...]}` sarmalı da kabul edilir. Beklenmeyen biçim hata: boş sanılıp sipariş kaçmasın */
  async orders(path: string): Promise<GetirOrder[]> {
    const json = await this.post(path, {});
    const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { data?: unknown }).data) ? (json as { data: unknown[] }).data : null;
    if (!list) throw new GetirHttpError(502, 'sipariş listesi beklenen biçimde gelmedi');
    return list.filter((o): o is GetirOrder => !!o && typeof (o as GetirOrder).id === 'string');
  }

  /** Tek sipariş (`GET /food-orders/{id}`; ileri tarihli siparişin saati push gövdesinde yok) */
  async order(id: string): Promise<GetirOrder | null> {
    const json = await this.call('GET', GETIR_PATHS.order(id));
    const o = json && typeof json === 'object' && 'data' in json ? (json as { data?: unknown }).data : json;
    return o && typeof o === 'object' && typeof (o as GetirOrder).id === 'string' ? (o as GetirOrder) : null;
  }
}

// ─── Aktarıcı (AsilPOS Uzaktan) ───────────────────────────────────────────────

/**
 * Aktarıcının adresi; restoranın kimliği (girişte öğrenilen ya da son girişteki) imzalı sorguda (`?restoran=`):
 * aktarıcı yalnız bu restoranın gelen kutusunu verir ve siler (api/uzaktan.ts `pullLists`). Kimlik hiç bilinmiyorsa
 * (ilk girişten önce) sorgusuz, eski kasa gibi bütün kutular. Eski aktarıcı sorguyu yok sayar (ortak kutu)
 */
function relayUrl(c: GetirConfig, path: string, restaurantId?: string | null): URL {
  const url = new URL(`${c.cloudUrl}/api/getir/${path}`);
  if (restaurantId) url.searchParams.set('restoran', restaurantId);
  return url;
}

/** Gelen kutusunu çeker (imzalı; önce iptaller, en çok 50 kayıt) */
export async function fetchInbox(c: GetirConfig, restaurantId?: string | null): Promise<InboxItem[]> {
  const { status, json } = await signedFetch(c.cloudSecret, 'GET', relayUrl(c, 'inbox', restaurantId)).catch((e) => {
    throw networkError(e, 8000);
  });
  if (status !== 200) throw new GetirHttpError(status, `aktarıcı gelen kutusu alınamadı (${explain(status, json)})`);
  const body = json as { items?: unknown } | null;
  if (!body || !Array.isArray(body.items)) throw new GetirHttpError(502, 'aktarıcı gelen kutusu beklenen biçimde gelmedi');
  return body.items.filter((i): i is InboxItem => !!i && typeof (i as InboxItem).id === 'string' && ((i as InboxItem).kind === 'order' || (i as InboxItem).kind === 'cancel'));
}

/** İşlenen kayıtları siler (çekimle aynı kutudan); silinemezse bir sonraki çekimde yine gelir (tekilleştirme kasada) */
export async function ackInbox(c: GetirConfig, ids: string[], restaurantId?: string | null): Promise<void> {
  if (!ids.length) return;
  const { status } = await signedFetch(c.cloudSecret, 'POST', relayUrl(c, 'inbox/ack', restaurantId), { ids });
  if (status !== 200) throw new GetirHttpError(status, 'aktarıcı gelen kutusu temizlenemedi');
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
/** Tekdüze saat: duvar saati geri alınsa da aralık bir aşamadan uzun beklemez */
const clock = () => performance.now();

/** Getir'e bildirilen aşamalar (3 gelince Getir'deki durumla karşılaştırılır) */
export type GetirStage = keyof typeof GETIR_PASSED_STATUS;
const STAGE_DATE: Record<GetirStage, 'prepareDate' | 'handoverDate' | 'deliverDate'> = { prepare: 'prepareDate', handover: 'handoverDate', deliver: 'deliverDate' };
/** Etkinleşmemiş ya da yeniden onay bekleyen ileri tarihli sipariş: hazır bekletilir */
const NOT_ACTIVE: ReadonlySet<number> = new Set([GETIR_STATUS.scheduledUnapproved, GETIR_STATUS.verified, GETIR_STATUS.unapproved]);

/**
 * Aşama Getir'de nerede ("emin olunmayanlar"): geçilmiş (tarih alanı ya da durum eşiği), beklenmeli (yalnız hazır:
 * ileri tarihli sipariş etkinleşmemiş ya da yeniden onay bekliyor), iptal edilmiş ya da geride
 */
export function stageOnGetir(o: GetirOrder, stage: GetirStage): 'passed' | 'waiting' | 'cancelled' | 'behind' {
  if (cancelledOnGetir(o)) return 'cancelled';
  const status = typeof o.status === 'number' ? o.status : null;
  if (text(o[STAGE_DATE[stage]]) || (status != null && status >= GETIR_PASSED_STATUS[stage])) return 'passed';
  if (stage === 'prepare' && status != null && NOT_ACTIVE.has(status)) return 'waiting';
  return 'behind';
}

/**
 * İstek çıktı ama sonucu bilinmiyor (ağ, zaman aşımı, 5xx, beklenmeyen ya da `result: false` gövde): Getir aşamayı
 * uygulamış olabilir. Girişin hatası değildir (aşama isteği hiç çıkmadı)
 */
const unsure = (e: unknown) => e instanceof PlatformHttpError && !(e instanceof GetirHttpError && e.auth) && (e.status === 0 || e.status >= 500);

export function getirAdapter(c: GetirConfig, client = new GetirClient(c)): PlatformAdapter {
  const gap = c.stepGapMs ?? STEP_GAP_MS;
  const backupEvery = c.backupEveryMs ?? BACKUP_EVERY_MS;
  let lastBackupAt = Number.NEGATIVE_INFINITY;
  /** Açılış: önceki süreçteki son çağrı bilinmez, en kötüsü varsayılır (açılıştan bir aralık beklenir) */
  const bootAt = clock();
  /** Sipariş → son akış çağrısı (verify, prepare, deliver; tekdüze saat): Getir aralarında en az 1 dk ister */
  const lastCall = new Map<string, number>();
  /** Süre kodu (74, 62) alıp bir aralık sonra yeniden denenen aşamalar: ikinci kez gelirse kalıcı */
  const intervalRetried = new Set<string>();
  /** Yanıtı kaybolan aşamalar (sipariş + yol): yeniden denemeye 3 gelir ve Getir'deki durum okunamazsa uygulanmış sayılır */
  const uncertain = new Set<string>();
  /** Sipariş → yeniden onayın gittiği an (tekdüze saat): aynı sipariş kısa süre içinde yeniden onaylanmaz */
  const reconfirmedAt = new Map<string, number>();
  /** Sipariş → iptal seçenekleri (`/cancel-options` hız sınırlı) */
  const cancelOptions = new Map<string, { at: number; options: unknown[] }>();
  /** Son girişteki restoran kimliği (kalıcı kayıttan bir kez okunur; undefined: henüz okunmadı) */
  let remembered: string | null | undefined;

  /**
   * Gelen kutusunun restoranı: girişte öğrenilen kimlik; giriş olmadıysa (yeniden başlatma) son girişteki, o da yoksa
   * null (sorgusuz: aktarıcı bütün kutuları verir, eski kasa gibi). Yeni kimlik kalıcı kayda yazılır. Kayıt okunamaz
   * ya da yazılamazsa yoklama durmaz
   */
  const inboxRestaurant = (): string | null => {
    if (remembered === undefined) {
      try {
        remembered = c.restaurantMemory?.load() ?? null;
      } catch {
        remembered = null;
      }
    }
    if (client.restaurantId && client.restaurantId !== remembered) {
      remembered = client.restaurantId;
      try {
        c.restaurantMemory?.save(remembered);
      } catch {
        // Bir sonraki girişte yeniden yazılır
      }
    }
    return client.restaurantId ?? remembered;
  };

  const remaining = (orderId: string) => Math.min(gap, (lastCall.get(orderId) ?? bootAt) + gap - clock());

  /**
   * Aşamaya 3 (durum geçersiz) geldi: Getir'deki durum okunur. Geçilmişse başarı (yanıtı kaybolan denememiz uygulanmış
   * ya da aşama Getir'de ilerlemiş); etkinleşmemiş ileri tarihli siparişte bir aralık sonra yeniden (425); iptal ya
   * da geride kalan durum kalıcı ret. Okunamazsa: yanıtı kaybolan deneme varsa uygulanmış sayılır, yoksa geçici
   */
  async function settleInvalid(orderId: string, key: string, stage: GetirStage, err: GetirHttpError): Promise<void> {
    let o: GetirOrder | null = null;
    try {
      o = await client.order(orderId);
    } catch {
      o = null;
    }
    if (o) {
      const where = stageOnGetir(o, stage);
      if (where === 'passed') return;
      if (where === 'waiting') {
        lastCall.set(orderId, clock());
        throw new GetirHttpError(425, `Getir'de sipariş henüz hazırlık aşamasında değil (durum ${o.status}: ileri tarihli sipariş etkinleşmedi ya da yeniden onay bekliyor); ${Math.ceil(gap / 60_000)} dk sonra yeniden denenecek`);
      }
      if (where === 'cancelled') throw new GetirHttpError(err.status, `${err.message}; sipariş Getir'de iptal edilmiş`, err.code);
      throw err;
    }
    if (uncertain.has(key)) return;
    throw new GetirHttpError(503, `${err.message}; Getir'deki durum okunamadı, yeniden denenecek`);
  }

  /**
   * Akış çağrısı. `gapped` (prepare, deliver): süre dolmamışsa 425 (kalıcı değil, sessizce sonraki turda). Süre kodu
   * (74, 62) ilk gelişte bir aralık beklenip yeniden denenir. Yanıt `result: false` ise geçici hata. Yanıtı kaybolan
   * (ağ, 5xx) aşama işaretlenir; yeniden denemeye 3 gelirse `settleInvalid` karar verir
   */
  async function step(orderId: string, path: string, what: string, stage: GetirStage, gapped = true) {
    if (gapped) {
      const wait = remaining(orderId);
      if (wait > 0) throw new GetirHttpError(425, `Getir aşamalar arasında ${Math.ceil(gap / 60_000)} dk ister; ${Math.ceil(wait / 1000)} sn sonra yeniden denenecek`);
    }
    const key = `${orderId} ${path}`;
    try {
      const res = await client.post(path, {});
      ensureApplied(res, what, 502);
    } catch (e) {
      if (e instanceof GetirHttpError && e.code === 3) {
        await settleInvalid(orderId, key, stage, e);
      } else {
        if (unsure(e)) uncertain.add(key);
        if (gapped && e instanceof GetirHttpError && e.code != null && GETIR_INTERVAL_CODES.has(e.code) && !intervalRetried.has(key)) {
          intervalRetried.add(key);
          lastCall.set(orderId, clock());
          throw new GetirHttpError(425, `Getir aşamayı henüz kabul etmedi (${e.message}); ${Math.ceil(gap / 60_000)} dk sonra yeniden denenecek`);
        }
        throw e;
      }
    }
    uncertain.delete(key);
    if (gapped) lastCall.set(orderId, clock());
  }

  /**
   * Kabul (verify ya da verify-scheduled). Getir panelinden zaten onaylanmışsa (2) 'already': kasada yalnız adisyon
   * açılır; aralığı çağıran başlatır (kabulde evet, yeniden onayda hayır: onay önceden gitmişti)
   */
  async function verify(orderId: string, path: string): Promise<'applied' | 'already'> {
    try {
      const res = await client.post(path, {});
      ensureApplied(res, 'kabul', 409);
    } catch (e) {
      if (!(e instanceof GetirHttpError && e.code === 2)) throw e;
      return 'already';
    }
    lastCall.set(orderId, clock());
    return 'applied';
  }

  /** Başka restoranın siparişi (girişte öğrenilen kimlikle): atlanır ama bildirilir */
  const foreign = (o: GetirOrder) => !!(client.restaurantId && o.restaurant?.id && o.restaurant.id !== client.restaurantId);

  return {
    platform: 'getir',
    label: PLATFORM_LABEL.getir,
    configured: () => getirConfigured(c),
    // Getir kuryesine verilince de bildirilir (yolda → handover)
    handover: true,
    async poll(_since, now) {
      const orders = new Map<string, PlatformOrderPayload>();
      const cancelled = new Set<string>();
      const confirmed = new Set<string>();
      const reconfirm = new Set<string>();
      const invalid: { externalId: string; error: string }[] = [];
      const warnings: string[] = [];
      const seen = new Set<string>();
      /** Başka restoranın siparişleri: gelen kutusunda kalır (kaydı da iptali de), o restoranın kasası alır */
      const foreignOrders = new Set<string>();
      const take = (o: GetirOrder, opts: { preAccepted?: boolean } = {}) => {
        const id = typeof o.id === 'string' ? o.id : '';
        if (!id || seen.has(id)) return;
        seen.add(id);
        if (foreign(o)) {
          foreignOrders.add(id);
          invalid.push({ externalId: id, error: `başka restoranın siparişi (${o.restaurant!.id}); bu restoran ${client.restaurantId}, kayıt gelen kutusunda o restorana bırakıldı` });
          return;
        }
        // Kasada /verify-scheduled ile kabul edilmiş ileri tarihli sipariş etkinleşince yeniden onay ister: sipariş
        // başına bir kez (gelen kutusundaki yeniden itme ya da onaysız liste bir süre daha 400 gösterebilir)
        if (activatedScheduled(o)) {
          const at = reconfirmedAt.get(id);
          if (at == null || clock() - at > RECONFIRM_QUIET_MS) reconfirm.add(id);
        }
        // Bozuk sipariş ötekileri durdurmaz: atlanır, kimliğiyle bildirilir
        try {
          const payload = fromGetirOrder(o, now, opts);
          orders.set(id, payload);
          if (!opts.preAccepted && paymentOf(o).verify) warnings.push(`${payload.code} siparişinin ödeme türü belirsiz (${payload.paymentLabel})`);
        } catch (e) {
          invalid.push({ externalId: id, error: message(e) });
        }
      };
      // 0) Restoran kimliği bilinmeden aktarıcının sipariş kaydı alınmaz: önce giriş
      let loginError: string | null = null;
      if (!client.identified) {
        try {
          await client.ready();
        } catch (e) {
          loginError = message(e);
        }
      }
      // 1) Aktarıcının gelen kutusu: restoranın kendi kutusu (kimlik girişte öğrenilir; giriş olmadıysa son girişteki);
      // silme de aynı kutudan
      const restaurantId = inboxRestaurant();
      let items: InboxItem[] = [];
      let relayError: string | null = null;
      try {
        items = await fetchInbox(c, restaurantId);
      } catch (e) {
        relayError = message(e);
      }
      // Kayıt kimliği → sipariş kimliği (kasada kalacaklar için). Bekletilen kayıtlar (girişe dek, ileri tarihli
      // siparişin saati gelene dek) silinmez; bekletilen siparişin iptal kaydı da (sipariş ve iptali birlikte işlenir)
      const orderIdOf = new Map<string, string>();
      const held = new Set<string>();
      const heldOrders = new Set<string>();
      /** Kutuda bırakılan iptal kayıtları: başka restoranın ya da (giriş olmadan) sahibi henüz bilinmeyen */
      const left = new Set<string>();
      /** Saati beklenen ileri tarihli siparişler (sipariş → kayıt): yedek liste saatiyle getirirse kayıt bekletilmez */
      const awaitingTime = new Map<string, string>();
      for (const item of items) {
        if (item.kind === 'cancel') {
          orderIdOf.set(item.id, item.orderId);
          const owner = typeof item.restaurantId === 'string' && item.restaurantId ? item.restaurantId : null;
          // Başka restoranın iptali (ortak gelen kutusunda): uygulanmaz, silinmez
          if (owner && client.restaurantId && owner !== client.restaurantId) {
            left.add(item.id);
            continue;
          }
          // Giriş olmadı, restoran bilinmiyor: iptal uygulanır (kasada olmayan siparişe dokunmaz) ama silinmez, sahibi
          // belli olunca yeniden gelir
          if (owner && !client.identified) left.add(item.id);
          cancelled.add(item.orderId);
          continue;
        }
        const id = item.order && typeof item.order.id === 'string' ? item.order.id : item.id;
        orderIdOf.set(item.id, id);
        if (!item.order || typeof item.order.id !== 'string') {
          invalid.push({ externalId: id, error: 'sipariş kimliği yok' });
          continue;
        }
        if (!client.identified) {
          held.add(item.id);
          heldOrders.add(id);
          continue;
        }
        let o = item.order;
        // Push gövdesinde ileri tarihli siparişin saati yok: Getir'den sorulur. Olmazsa kayıt bir dakikaya dek gelen
        // kutusunda bekler (yedek liste ya da sonraki tur saati getirsin), sonra notta "Getir panelinde" yazarak alınır
        if (o.isScheduled && !text(o.scheduledDate)) {
          let full: GetirOrder | null = null;
          try {
            full = await client.order(o.id);
          } catch {
            full = null;
          }
          if (full && text(full.scheduledDate)) o = { ...o, scheduledDate: full.scheduledDate };
          else if (typeof item.receivedAt === 'number' && now - item.receivedAt < SCHEDULE_LOOKUP_MS) {
            held.add(item.id);
            heldOrders.add(id);
            awaitingTime.set(id, item.id);
            continue;
          }
        }
        take(o);
      }
      // Giriş hiç olmadı (restoran kimliği yok): aktarıcının siparişleri kasaya gelmiyor. Yoklama hatası değildir
      // (iptaller işlenir), kasa ayrıca uyarır ve sürerse alarm verir
      const blocked =
        loginError != null && !client.identified
          ? `Getir'e giriş olmadı (${loginError}): restoran kimliği bilinmeden yeni sipariş kasaya alınmıyor, ${held.size} kayıt gelen kutusunda bekliyor; siparişleri Getir uygulamasından yönetin`
          : undefined;
      // 2) Yedek: doğrudan Getir'in onaysız, iptal ve onaylı listeleri (aktarıcı düştüyse hemen, yoksa en sık dakikada bir).
      // Listeler ayrı ayrı: iptal ya da onaylı listesinin hatası onaysız siparişleri düşürmez
      // Saat geri alınırsa (now < son yoklama) bekleme uzamaz
      // Giriş bu turda olmadıysa (restoran kimliği yok) Getir'in listeleri de okunamaz: girişe ikinci kez gidilmez
      if (blocked && relayError != null) throw new GetirHttpError(0, `aktarıcı: ${relayError}; Getir: ${loginError}`);
      if (!blocked && (relayError != null || now - lastBackupAt >= backupEvery || now < lastBackupAt)) {
        lastBackupAt = now;
        let backupError: string | null = null;
        try {
          for (const o of await client.orders(GETIR_PATHS.unapproved)) take(o);
        } catch (e) {
          backupError = message(e);
        }
        if (backupError != null && relayError != null) throw new GetirHttpError(0, `aktarıcı: ${relayError}; Getir: ${backupError}`);
        if (backupError != null) warnings.push(`yedek yoklama yapılamadı (${backupError}); siparişler aktarıcıdan alınıyor`);
        try {
          for (const o of await client.orders(GETIR_PATHS.cancelled)) if (!foreign(o)) cancelled.add(o.id);
        } catch (e) {
          warnings.push(`Getir'in iptal listesi okunamadı (${message(e)})`);
        }
        // Getir panelinden onaylanmış sipariş (belge "Time Limit for Order Confirmation": /food-orders/active)
        try {
          for (const o of await client.orders(GETIR_PATHS.active)) {
            if (foreign(o) || !approvedOnGetir(o)) continue;
            confirmed.add(o.id);
            take(o, { preAccepted: true });
          }
        } catch (e) {
          warnings.push(`Getir'in onaylı sipariş listesi okunamadı (${message(e)})`);
        }
      }
      if (relayError != null) warnings.unshift(`aktarıcı gelen kutusu alınamadı (${relayError}); siparişler doğrudan Getir'den alınıyor`);
      // Saati beklenen sipariş yedek listeden saatiyle geldiyse kaydı artık bekletilmez
      for (const [id, itemId] of awaitingTime) {
        if (orders.get(id)?.scheduledFor == null) continue;
        held.delete(itemId);
        heldOrders.delete(id);
      }
      // İptal edilmiş sipariş yeni sipariş olarak kayda girmez (iptali aynı turda ya da girişi beklerken gelmiş);
      // kasada zaten varsa iptali uygulanır
      for (const id of cancelled) {
        orders.delete(id);
        confirmed.delete(id);
        reconfirm.delete(id);
      }
      // Kasada işlenenler silinir; başka restoranınki (siparişi ve iptaliyle), kayda alınmayan (Kapalı), kaydı düşen,
      // iptali ertelenen ve bekletilen (siparişi ve iptaliyle) kutuda kalır
      const commit = (keep: ReadonlySet<string>) => {
        const stays = (i: InboxItem) => {
          const orderId = orderIdOf.get(i.id) ?? '';
          return held.has(i.id) || left.has(i.id) || heldOrders.has(orderId) || foreignOrders.has(orderId) || keep.has(orderId);
        };
        return ackInbox(
          c,
          items.filter((i) => !stays(i)).map((i) => i.id),
          restaurantId,
        );
      };
      return { orders: [...orders.values()], cancelled: [...cancelled], confirmed: [...confirmed], reconfirm: [...reconfirm], invalid, commit, warning: warnings.length ? warnings.join('; ') : undefined, blocked };
    },
    async accept(order) {
      const id = order.externalId;
      // Getir'de zaten onaylı (panelden): Getir'e gidecek bir şey yok; ilk aşama için bir aralık beklenir
      if (order.preAccepted) {
        lastCall.set(id, clock());
        return;
      }
      // Hazırlık süresi Getir'e sipariş başına gitmez (verify gövdesiz; restoranın ortalama süresi ayrı ve sınırlı uçta)
      let result: 'applied' | 'already' | null = null;
      if (dataOf(order).status === GETIR_STATUS.scheduledUnapproved) {
        try {
          result = await verify(id, GETIR_PATHS.verifyScheduled(id));
        } catch (e) {
          // 325 olarak gelmiş sipariş o arada etkinleşmiş (400): /verify ister
          if (!(e instanceof GetirHttpError && e.code === 3)) throw e;
        }
      }
      result ??= await verify(id, GETIR_PATHS.verify(id));
      // Getir panelinden ya da IVR'dan zaten onaylanmış (2): onay anı bilinmez, en geç şimdi: ilk aşama bir aralık
      // bekler. Kasa bunu bilir: otomatik kabul adisyonu açmaz (kasada onay bekleyen sipariş panelden de alınmış olabilir)
      if (result === 'already') {
        lastCall.set(id, clock());
        return 'already';
      }
    },
    async reconfirm(order) {
      // Kasada kabul edilmiş ileri tarihli sipariş etkinleşince Getir onaysız listede yeniden 400 gösterdi: /verify.
      // Getir "zaten onaylı" (2) derse aralık yeniden başlamaz (onay önceden gitmişti), kasa denetim kaydı yazmaz
      const id = order.externalId;
      const result = await verify(id, GETIR_PATHS.verify(id));
      reconfirmedAt.set(id, clock());
      return result === 'already' ? 'already' : undefined;
    },
    async reject(order, reason) {
      const id = order.externalId;
      // Kabulden sonra kasada iptal de aynı yoldan: Getir'in o aşamada verdiği seçenekler; vermiyorsa (kurye yolda) kalıcı ret.
      // Seçenekler sipariş başına bir süre saklanır: uç 10 dk'da 40 istekle sınırlı, kasadaki iptal her turda yeniden denenir
      let cached = cancelOptions.get(id);
      if (!cached || clock() - cached.at > CANCEL_OPTIONS_TTL_MS) {
        const options = await client.call('GET', GETIR_PATHS.cancelOptions(id));
        if (!Array.isArray(options)) throw new GetirHttpError(502, 'iptal seçenekleri beklenen biçimde gelmedi');
        cached = { at: clock(), options };
        cancelOptions.set(id, cached);
      }
      const pick = pickCancelOption(cached.options as { id?: unknown; message?: unknown }[], reason);
      if (!pick) throw new GetirHttpError(409, 'Getir bu sipariş için iptal seçeneği vermiyor: bu aşamada restoran iptal edemez');
      try {
        const res = await client.post(GETIR_PATHS.cancel(id), { cancelReasonId: pick.id, cancelNote: reason });
        ensureApplied(res, 'iptal', 502);
      } catch (e) {
        if (!(e instanceof GetirHttpError && e.code === 13)) throw e;
      }
      cancelOptions.delete(id);
    },
    async notify(order, status: PlatformNotify, courier) {
      const id = order.externalId;
      if (status === 'hazir') {
        // İleri tarihli siparişi Getir teslimden 1 saat önce kendiliğinden "hazırlanıyor"a (500) alır: 3 gelirse
        // Getir'deki durum okunur (settleInvalid)
        await step(id, GETIR_PATHS.prepare(id), 'hazırlandı', 'prepare');
        return true;
      }
      if (courier === 'platform') {
        // Getir kuryesi: kuryeye verilince handover (1 dk kuralına bağlı değil: kurye beklemesin); teslimi Getir yazar
        if (status !== 'yolda') return false;
        await step(id, GETIR_PATHS.handover(id), 'kuryeye teslim', 'handover', false);
        return true;
      }
      // Kendi kuryemiz: "yolda"nın Getir'de karşılığı yok, teslimde deliver
      if (status !== 'teslim') return false;
      await step(id, GETIR_PATHS.deliver(id), 'teslim', 'deliver');
      return true;
    },
  };
}
