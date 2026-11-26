import { parseTL } from '@shared/money';
import type { MethodKind } from '../basket';
import { describe, PAIRING_LOST_MESSAGE, pairingLost, PAVO_EOD, PavoClient, PavoError, type PavoResponse, type PavoSale, type PavoSaleItem, type PavoStore } from '../pavo';
import type { DocKind, FiscalBasket, FiscalPayment, FiscalProvider, FiscalResult, PendingReceipt, PollOutcome } from './types';
import { PAVO_KIMLIGI, PAVO_TABAN_KASA, PAVO_UYGULAMA } from '@shared/eski-adlar';

/**
 * Pavo (N86 ve diğer PavoPay cihazları) kafenin yerel ağında REST ile. Satış cihaza gider, kasiyer cihazda ödemeyi
 * (nakit, kart; bölünmüş de) alır ve cihaz VUK 507 belgesini (e-Arşiv, e-Fatura ya da bilgi fişi) keser; cihazın
 * yanıtı satışın sonucudur. Yanıt gelmezse (sunucu yeniden başladı, bağlantı koptu) sonuç sipariş no ile sorulur.
 *
 * Belgesiz noktalarda temkinli (docs/04-YAZARKASA.md §8): tanınmayan "başarılı" yanıt ödemesiz sonuç sayılır; ödeme
 * LafPOS'a işlenmez, sepet hataya düşer ve yöneticiye alarm gider, kalan kasada alınır. Böylece cihazda kesilen
 * belgenin parası hiçbir yanlış eşlemeyle ikinci kez ya da yanlış türle sayılmaz.
 */

/**
 * Sıra no ve sertifika izi veritabanında (`sync_state`). Depo `service.ts`'ten verilir: bu modül yüklenirken
 * veritabanına dokunmaz (sağlayıcı listesi testlerde ortam hazırlanmadan da yüklenebilir)
 */
/** Kurulumun Pavo kimliği (fingerprint) de kalıcı saklanır; eski testlerin deposu onu tutmayabilir */
export interface PavoBacking extends PavoStore {
  getFingerprint?(): string | null;
  setFingerprint?(fp: string): void;
}
let backing: PavoBacking | null = null;
export function usePavoStore(s: PavoBacking) {
  backing = s;
}
const need = (): PavoStore => {
  if (!backing) throw new Error('Pavo deposu bağlanmadı');
  return backing;
};
const store: PavoStore = {
  getSequence: () => need().getSequence(),
  setSequence: (n) => need().setSequence(n),
  getCert: () => need().getCert(),
  setCert: (fp) => need().setCert(fp),
};

/**
 * Cihazın adresi ve seri numarası nereden: yönetimden girilen (ayarlar, `service.ts` bağlar) yoksa ayarlar dosyası
 * (PAVO_URL, PAVO_SERIAL). Kaynak verilmediyse yalnız ortam okunur (sağlayıcı listesi testlerde ayarsız yüklenir)
 */
export type PavoSource = 'panel' | 'dosya';
let panelConfig: () => { url: string; serial: string } | null = () => null;
export function usePavoConfig(fn: () => { url: string; serial: string } | null) {
  panelConfig = fn;
  client = undefined;
}

/** Eski kurulumların (kimlik saklanmadan eşleştirilmiş) ve ortamda tanımsızken eşleştirilmemiş kurulumun kimliği */
export const LEGACY_FINGERPRINT = PAVO_KIMLIGI;
/** Pavo kimliği biçimi: kısa, harf-rakam-tire (docs/04-YAZARKASA.md §8.1) */
export const FINGERPRINT_RE = /^[A-Za-z0-9-]{1,32}$/;

/** Kuruluma özel yeni kimlik: `LafPOS-` ve 6 harf-rakam (karışmasın diye 0/O, 1/I yok) */
export function newFingerprint(rand: (n: number) => number = (n) => Math.floor(Math.random() * n)): string {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let tail = '';
  for (let i = 0; i < 6; i++) tail += abc[rand(abc.length)];
  return `${LEGACY_FINGERPRINT}-${tail}`;
}

/**
 * Cihaza giden Pavo kimliği (`TransactionHandle.Fingerprint`). Sıra: ayarlar dosyasındaki `PAVO_FINGERPRINT`; yoksa
 * kurulumun saklanan kimliği; o da yoksa ve cihaz daha önce eşleştirildiyse eski kimlik `LafPOS` (eşleştirme bozulmasın
 * diye saklanır, sonra hep o gider); hiç eşleştirilmemişse eşleştirmeye dek `LafPOS` (ilk eşleştirmede yenisi üretilir)
 */
export function pavoFingerprint(): { value: string; source: 'dosya' | 'kurulum' | 'eski' | 'yok' } {
  const fromEnv = (process.env.PAVO_FINGERPRINT ?? '').trim();
  if (fromEnv) return { value: fromEnv, source: 'dosya' };
  const stored = backing?.getFingerprint?.() ?? null;
  if (stored) return { value: stored, source: stored === LEGACY_FINGERPRINT ? 'eski' : 'kurulum' };
  const paired = !!backing && (backing.getSequence() > 0 || !!backing.getCert());
  if (paired) {
    backing?.setFingerprint?.(LEGACY_FINGERPRINT);
    return { value: LEGACY_FINGERPRINT, source: 'eski' };
  }
  return { value: LEGACY_FINGERPRINT, source: 'yok' };
}

/**
 * Eşleştirmeden hemen önce: ortamda tanımlı değilse ve kurulumun kimliği yoksa yenisi üretilir ve saklanır (bir kez;
 * yeniden eşleştirmede aynısı kalır). Eski eşleştirilmiş kurulum `pavoFingerprint`te `LafPOS`'u saklamıştır
 */
function ensureFingerprint(): string {
  const now = pavoFingerprint();
  if (now.source !== 'yok' || !backing?.setFingerprint) return now.value;
  const fp = newFingerprint();
  backing.setFingerprint(fp);
  client = undefined;
  return fp;
}

let client: PavoClient | null | undefined;
let clientSource: PavoSource | null = null;
export function pavo(): PavoClient | null {
  if (client === undefined) {
    const fingerprint = pavoFingerprint().value;
    const panel = panelConfig();
    const fromFile = panel ? null : PavoClient.configFromEnv(process.env);
    const cfg = panel ? { url: panel.url, serial: panel.serial, fingerprint } : fromFile ? { ...fromFile, fingerprint } : null;
    client = cfg ? new PavoClient(cfg, store) : null;
    clientSource = cfg ? (panel ? 'panel' : 'dosya') : null;
  }
  return client;
}
/** Cihazın bilgileri yönetimden değişti: istemci yeni adresle kurulur (çağıran cihazın boşta olduğunu denetler) */
export function reconfigurePavo() {
  client = undefined;
  lastAsked.clear();
  failedSince.clear();
}
/** Testler için: ortam değişince istemci yeniden kurulur */
export function resetPavo(next?: PavoClient | null) {
  client = next === undefined ? undefined : next;
  outcomes.clear();
  lastAsked.clear();
  failedSince.clear();
}

/**
 * Cihazda banka gün sonu bu süreçte sürüyor mu (`/PerformEOD`, en çok 3 dk). İstemci kurulmamışsa sürmüyordur: gün
 * sonu istemciyle gönderilir. Güncelleyici bunu "meşgul" sayar (lib/mesgul.ts)
 */
export function pavoEodRunning(): boolean {
  return !!client && client.busyWith === PAVO_EOD;
}

/** LafPOS'un sepet kimliğinden cihazın sipariş no'su (16 karakter; aynı sepet hep aynı no) */
export function pavoOrderNo(basketId: string): string {
  return `LP${basketId.replace(/-/g, '').toUpperCase().slice(0, 14)}`;
}

const tl = (kurus: number) => kurus / 100;

/**
 * Cihazın bildiği KDV grupları. Belgede ve entegratör kodunda görülen yalnız `KDV10` ve `KDV20`; başka oranlı kalem
 * (%0, %1) cihaza gitmez, cihaz yanlış grupla belge kesmesin (grup listesi Pavo'dan istenecek, docs/04 §8.4)
 */
const PAVO_TAX_GROUPS = new Set(['KDV10', 'KDV20']);

/**
 * LafPOS sepetini Pavo satışına çevirir. Tutarlar TL ve KDV dahil. İndirim kaleme işlenir (ayrı indirim alanının
 * anlamı belgede yok): satırın ödenecek tutarı adede tam bölünmüyorsa satır iki olur (n-1 adet ve son adet),
 * fişin toplamı LafPOS'un hesabıyla kuruşu kuruşuna aynı kalır.
 */
export function pavoSale(basket: FiscalBasket, orderNo: string, appVersion = '1'): PavoSale {
  const items: PavoSaleItem[] = [];
  const line = (name: string, tax: string, qty: number, unit: number): PavoSaleItem => ({
    Name: name,
    IsGeneric: false,
    UnitCode: 'C62',
    TaxGroupCode: tax,
    ItemQuantity: qty,
    UnitPriceAmount: tl(unit),
    GrossPriceAmount: tl(unit * qty),
    TotalPriceAmount: tl(unit * qty),
  });
  let total = 0;
  for (const it of basket.items) {
    const amount = Math.round((it.price * it.quantity) / 1000) - (it.adjust?.totalValue ?? 0);
    if (amount <= 0) continue;
    const rate = Math.round(it.taxPercent / 100);
    const tax = `KDV${rate}`;
    if (!PAVO_TAX_GROUPS.has(tax)) throw new PavoError(`%${rate} KDV'li kalem Pavo'ya gönderilemez (${it.name}); ürünün KDV oranını düzeltin ya da hesabı kasadan alın`, 'KDV_GROUP');
    total += amount;
    if (it.quantity % 1000 !== 0) {
      // Kesirli adet (LafPOS'ta yok, temkin): tek satır, birim fiyat yuvarlanır, satır tutarı kesin
      const qty = it.quantity / 1000;
      items.push({ ...line(it.name, tax, qty, Math.round(amount / qty)), GrossPriceAmount: tl(amount), TotalPriceAmount: tl(amount) });
      continue;
    }
    const qty = it.quantity / 1000;
    const unit = Math.floor(amount / qty);
    const rest = amount - unit * qty;
    if (rest === 0) items.push(line(it.name, tax, qty, unit));
    else {
      if (qty > 1) items.push(line(it.name, tax, qty - 1, unit));
      items.push(line(it.name, tax, 1, unit + rest));
    }
  }
  return {
    RefererApp: PAVO_UYGULAMA,
    RefererAppVersion: appVersion,
    OrderNo: orderNo,
    MainDocumentType: 1,
    GrossPrice: tl(total),
    TotalPrice: tl(total),
    CurrencyCode: 'TRY',
    ExchangeRate: 1,
    SendResponseBeforePrint: false,
    AddedSaleItems: items,
    // Kasada seçilen ödeme türü cihazda hazır gelir (Mediator 1 nakit, 2 kart; yanıttaki PaymentTypeId ile aynı); yoksa
    // kasiyer cihazda seçer. Tutar fişin toplamı: bölünmüş ödeme cihazda yapılmaz
    // Yemek kartında cihazın ödeme aracı no'su (Yönetim › Yazarkasa POS › yemek kartı eşlemesi); eşlenmemiş yemek kartı
    // ödeme bilgisiyle gitmez, kasiyer cihazda seçer
    ...(basket.odemeTuru && (basket.odemeTuru !== 'yemek' || basket.odemeAraci != null)
      ? { PaymentInformations: [{ Mediator: basket.odemeTuru === 'yemek' ? basket.odemeAraci! : basket.odemeTuru === 'kart' ? 2 : 1, Amount: tl(total), CurrencyCode: 'TRY', ExchangeRate: 1 }] }
      : {}),
  };
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** Yanıttaki satış kaydı: `Data` kendisi ya da `Data.Sale` */
function saleOf(res: PavoResponse): Obj | null {
  const data = obj(res.Data);
  if (!data) return null;
  const looks = (o: Obj | null) => !!o && (Array.isArray(o.AddedPayments) || Array.isArray(o.FinancialDocuments));
  if (looks(data)) return data;
  const inner = obj(data.Sale);
  return looks(inner) ? inner : null;
}

/**
 * Yemek kartına eşlenmiş ödeme araçları (Yönetim › Yazarkasa POS; servis ayarlardan verir). Eşleme yönetici seçimidir,
 * tahmin değil: cihazın listesinde o no'nun adı görülerek yapılır
 */
let mealMediators: () => ReadonlySet<number> = () => new Set();
export function usePavoMealMediators(fn: () => ReadonlySet<number>) {
  mealMediators = fn;
}

/**
 * Pavo'nun ödeme tipi: 1 nakit, 2 kredi kartı (satış kaydında); yemek kartına eşlenmiş araç yemek kartı. Anlamı
 * bilinmeyen tip (eşlenmemiş yemek kartı, havale...) tahminle bir türe yazılmaz: ödemesi işlenmez, sepet eksik ödenmiş
 * sayılır, yönetici kalanı doğru türle alır
 */
function kindOf(type: number | null, meal: ReadonlySet<number>): MethodKind | null {
  return type === 1 ? 'nakit' : type === 2 ? 'kart' : type != null && meal.has(type) ? 'yemek' : null;
}

function docKindOf(name: string | null): DocKind {
  const n = (name ?? '').toLocaleLowerCase('tr');
  if (n.includes('bilgi')) return 'bilgi_fisi';
  if (n.includes('fatura') && !n.includes('arşiv') && !n.includes('arsiv')) return 'e_fatura';
  if (n.includes('mali')) return 'okc_fis';
  return 'e_arsiv';
}

export type SaleReading =
  | { kind: 'paid'; result: FiscalResult }
  | { kind: 'cancelled'; result: FiscalResult; message: string }
  | { kind: 'failed'; message: string; code: string | null }
  | { kind: 'open' };

/**
 * Cihazın yanıtını okur. Ödendi: satış kaydında etkin ödeme ya da belge var · vazgeçildi: kasiyer cihazda
 * vazgeçti (`HasAbondon`) · başarısız: hata, belge ve ödeme yok · açık: hatasız ama satış kaydı yok (sürüyor ya da
 * yanıt biçimi tanınmadı; sonuç sorulur).
 */
export function readSale(res: PavoResponse, meal: ReadonlySet<number> = mealMediators()): SaleReading {
  const sale = saleOf(res);
  const payments: FiscalPayment[] = [];
  let taken = 0;
  for (const p of (sale?.AddedPayments as unknown[] | undefined) ?? []) {
    const o = obj(p);
    if (!o) continue;
    const status = num(o.StatusId);
    // Satış kaydında 2 etkin ödemedir; iptal edilen ya da başarısız deneme sayılmaz
    if (status != null && status !== 2) continue;
    const amount = num(o.PaymentAmount ?? o.Amount);
    if (amount == null || amount <= 0) continue;
    taken++;
    const type = num(o.PaymentTypeId ?? o.Mediator ?? o.PaymentMediatorId);
    const kind = kindOf(type, meal);
    // Yemek kartında aracın no'su operatör gibi taşınır: servis onu eşlenen ödeme türüne (Multinet...) yazar
    if (kind) payments.push({ kind, amount: Math.round(amount * 100), operatorId: kind === 'yemek' ? type : null, description: `Pavo ödeme tipi ${type}` });
  }
  const doc = obj(((sale?.FinancialDocuments as unknown[] | undefined) ?? [])[0]);
  const docId = doc ? (str(doc.InvoiceNo) ?? str(doc.DocumentNo)) : null;
  const documented = taken > 0 || !!docId;
  if (documented) {
    return {
      kind: 'paid',
      result: {
        status: 'paid',
        docKind: docKindOf(str(obj(doc?.Type)?.Name)),
        zNo: null,
        receiptNo: null,
        docId: docId ?? str(sale?.SaleNumber),
        payments,
        raw: res,
      },
    };
  }
  if (res.HasAbondon) {
    return { kind: 'cancelled', message: describe(res), result: { status: 'cancelled', docKind: null, zNo: null, receiptNo: null, docId: null, payments: [], raw: res } };
  }
  if (res.HasError) return { kind: 'failed', message: describe(res), code: res.ErrorCode == null ? null : String(res.ErrorCode) };
  return { kind: 'open' };
}

// ─── Ödeme araçları ────────────────────────────────────────────────────────

const MEDIATOR_ID_KEYS = ['Mediator', 'Id', 'PaymentMediatorId', 'MediatorId', 'PaymentMediator', 'PaymentTypeId', 'Type', 'Code'];
const MEDIATOR_NAME_KEYS = ['Name', 'Description', 'MediatorName', 'PaymentMediatorName', 'DisplayName', 'Title', 'Label', 'Text'];
const pick = <T>(o: Obj, keys: string[], read: (v: unknown) => T | null): T | null => {
  // Alan adı büyük ya da küçük harfle başlayabilir (`Name`, `name`)
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    const v = real ? read(o[real]) : null;
    if (v != null) return v;
  }
  return null;
};

/**
 * `/PaymentMediators` yanıtından ödeme araçları (no ve ad). Yanıtın biçimi belgesiz: liste `Data`'nın kendisi, `Data`'nın
 * bir alanı (ör. `Data.PaymentMediators`) ya da kabukta `Data` dışında bir alan olabilir; ilk bulunan dizi okunur. Öğe
 * nesne (no ve ad alanları) ya da yalnız ad olabilir. Tanınmayan biçim boş liste (çağıran alan adlarını gösterir)
 */
export function readMediators(res: PavoResponse): { id: number | null; name: string | null }[] {
  const lists = (v: unknown): unknown[][] => (Array.isArray(v) ? [v] : obj(v) ? Object.values(obj(v)!).filter(Array.isArray) : []);
  const rest = Object.fromEntries(Object.entries(res).filter(([k]) => !['Data', 'Errors', 'TransactionHandle'].includes(k)));
  for (const list of [...lists(res.Data), ...lists(rest)]) {
    const out = list
      .map((m) => {
        const o = obj(m);
        if (o) return { id: pick(o, MEDIATOR_ID_KEYS, num), name: pick(o, MEDIATOR_NAME_KEYS, (v) => (typeof v === 'string' ? str(v) : null))?.slice(0, 60) ?? null };
        return typeof m === 'string' && m.trim() ? { id: null, name: m.trim().slice(0, 60) } : null;
      })
      .filter((m): m is { id: number | null; name: string | null } => !!m && (m.id != null || m.name != null));
    if (out.length) return out.slice(0, 40);
  }
  return [];
}

// ─── Banka gün sonu ────────────────────────────────────────────────────────

/** Gün sonunun LafPOS'ta saklanan özeti: kart no, işlem dökümü, slip görüntüsü saklanmaz */
export interface PavoEodSummary {
  batchNo: string | null;
  /** Cihazın yazdığı biçimde (`gg.aa.yyyy ss:dd`, İstanbul saati) */
  deviceDateTime: string | null;
  /** Genel toplam (TL satırı), kuruş; iptaller düşülmüş */
  grandTotalKurus: number | null;
  acquirers: { name: string; count: number | null; totalKurus: number | null }[];
}

export type EodReading =
  | { kind: 'ok'; summary: PavoEodSummary | null; message: string | null }
  | { kind: 'failed'; code: string | null; message: string }
  | { kind: 'unknown'; code: string | null; message: string };

/** Yazıcı hataları (5066-5072): gün sonu alınmış, yalnız slip basılamamış olabilir */
const PRINTER_ERRORS = new Set(['5066', '5067', '5068', '5069', '5070', '5071', '5072']);

/** Para birimi satırlarından TL olanın tutarı ("2,22 TL" → 222); tanınmayan tutar null */
function tlTotal(list: unknown): number | null {
  const rows = (Array.isArray(list) ? list : []).map(obj).filter((o): o is Obj => !!o);
  const row = rows.find((o) => /^(TL|TRY)$/i.test(String(o.currency ?? '').trim())) ?? (rows.length === 1 && rows[0]!.currency == null ? rows[0] : null);
  const raw = row ? str(row.totalAmount) : null;
  return raw ? parseTL(raw) : null;
}

const count = (v: unknown): number | null => {
  const n = num(v);
  return n != null && Number.isInteger(n) && n >= 0 ? n : null;
};

/** Cihazın `eodData`'sından yalnız özet alanları (Pavo'nun PerformEOD ve PrintEODCopy yanıtlarının biçimi) */
export function eodSummary(eod: unknown): PavoEodSummary | null {
  const o = obj(eod);
  if (!o) return null;
  const acquirers = (Array.isArray(o.acquirers) ? o.acquirers : [])
    .map(obj)
    .filter((a): a is Obj => !!a)
    .map((a) => {
      const card = tlTotal(a.cardTotals);
      const fast = tlTotal(a.fastTotals);
      return {
        name: (str(a.acquirerName) ?? 'Banka').slice(0, 60),
        count: count(a.acquirerTotalCount),
        totalKurus: card == null && fast == null ? null : (card ?? 0) + (fast ?? 0),
      };
    });
  return { batchNo: str(o.batchNo)?.slice(0, 20) ?? null, deviceDateTime: str(o.dateTime)?.slice(0, 20) ?? null, grandTotalKurus: tlTotal(o.grandTotals), acquirers };
}

/**
 * Gün sonu yanıtını okur. Başarı ölçütü Pavo'nun: `HasError` ve `HasAbondon` false. Özeti (batch no) olan yanıt
 * hata taşısa da alınmış sayılır (yazıcı hatası gibi); özetsiz yazıcı hatası belirsizdir (gün sonu alınmış olabilir),
 * doğrulanır. Diğer hatalar alınamadı.
 */
export function readEod(res: PavoResponse): EodReading {
  const summary = eodSummary(obj(res.Data)?.eodData);
  const code = res.ErrorCode == null || res.ErrorCode === '' ? null : String(res.ErrorCode);
  if (summary?.batchNo) return { kind: 'ok', summary, message: res.HasError ? describe(res) : null };
  if (!res.HasError && !res.HasAbondon) return { kind: 'ok', summary, message: summary ? null : 'Cihaz gün sonunu tamamladı; özet gelmedi' };
  if (res.HasAbondon) return { kind: 'failed', code, message: `Cihazda gün sonundan vazgeçildi${code ? ` (kod ${code})` : ''}` };
  if (code && PRINTER_ERRORS.has(code)) return { kind: 'unknown', code, message: `${describe(res)}; gün sonu alınmış olabilir` };
  return { kind: 'failed', code, message: describe(res) };
}

/** Cihazın gün sonu saati (`gg.aa.yyyy ss:dd`, İstanbul = UTC+3, yaz saati yok) → an; tanınmazsa null */
export function eodTimeMs(deviceDateTime: string | null | undefined): number | null {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2})/.exec((deviceDateTime ?? '').trim());
  if (!m) return null;
  const [, d, mo, y, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  return Date.UTC(y, mo - 1, d, h - 3, mi);
}

/**
 * Gün sonu denemesinin kıyas tabanı: denemeden önceki son gün sonu. `cihaz` gün sonu gönderilmeden hemen önce
 * cihazdan okundu (`/PrintEODCopy`) · `bos` cihazda kayıtlı gün sonu yoktu · `lafpos` cihaz son gün sonunu vermedi
 * (uç yanıt verdi ama özet yok), LafPOS'un bildiği son batch
 */
export interface EodBaseline {
  prevBatchNo: string | null;
  prevBatchFrom: 'cihaz' | 'bos' | typeof PAVO_TABAN_KASA;
}

/**
 * `/PrintEODCopy` yanıtından taban; cihaz son gün sonunu vermediyse null (çağıran LafPOS'un bildiğine düşer).
 * Eşleştirme bozulmuşsa (73, 74) hata: gün sonu da reddedilirdi, gönderilmez; kasiyer yeniden eşleştirir
 */
export function readEodBaseline(res: PavoResponse): EodBaseline | null {
  if (res.HasError && pairingLost(res.ErrorCode)) throw new PavoError(PAIRING_LOST_MESSAGE, String(res.ErrorCode), false, res);
  if (res.HasError) return String(res.ErrorCode ?? '') === '5075' ? { prevBatchNo: null, prevBatchFrom: 'bos' } : null;
  const s = eodSummary(obj(res.Data)?.eodData);
  return s?.batchNo ? { prevBatchNo: s.batchNo, prevBatchFrom: 'cihaz' } : null;
}

/**
 * Cihaz yanıt verdi ama son gün sonunun kopyasını vermedi: uç bu cihazda yok (404, 405, 501) ya da başarılı yanıtın
 * gövdesi boş (2xx; sahada N86: HTTP 404, gövdesiz). Cihazın iç hatası (500, 503...) kopya yok sayılmaz: cihaz bozuk
 * durumda olabilir, gün sonu gönderilmez (#72 incelemesi). Zaman aşımı ve kopan bağlantı da bu değildir
 */
export function eodCopyUnavailable(e: unknown): e is PavoError {
  return e instanceof PavoError && /^HTTP_(404|405|501|2\d\d)$/.test(e.code ?? '');
}

/**
 * Cihazdaki gün sonu bu denemenin sonucu olabilir mi. Cihaz saati okunabiliyorsa denemeden en çok 6 dk önce olmalı
 * (cihaz saati dakika hassasiyetinde ve kasa bilgisayarından en çok 5 dk sapar, Pavo'nun toleransı): daha eskisi
 * cihazın menüsünden önceden alınmıştır. Batch no denemeden önceki son batch'ten büyük olmalı; deneme öncesinde
 * cihazda gün sonu yoktuysa her gün sonu sonradır; önceki batch bilinmiyorsa (ya da sayı değilse) cihaz saati karar verir
 */
export function eodAfter(device: Pick<PavoEodSummary, 'batchNo' | 'deviceDateTime'>, attempt: { at: number; prevBatchNo: string | null; prevBatchFrom?: EodBaseline['prevBatchFrom'] }): boolean {
  const at = eodTimeMs(device.deviceDateTime);
  if (at != null && at < attempt.at - 6 * 60_000) return false;
  if (attempt.prevBatchFrom === 'bos') return true;
  if (attempt.prevBatchNo && device.batchNo === attempt.prevBatchNo) return false;
  const a = Number(device.batchNo);
  const b = Number(attempt.prevBatchNo);
  if (attempt.prevBatchNo && device.batchNo && Number.isFinite(a) && Number.isFinite(b)) return a > b;
  return at != null;
}

/**
 * Bekleme süreleri (testler kısaltır). `sendWaitMs`: gönderimin ilk saniyeleri beklenir, cihaz satışı hemen
 * reddederse (KDV grubu, eşleştirme) kasiyer görür · `askEveryMs`: cihaz tek istek işler, sonuç sorgusu bekleyen
 * sepet başına en sık bu aralıkla · `failConfirmMs`: sonuç sorgusu "başarısız" derse satış ancak bu kadar sonraki bir
 * sorguda da aynı kod gelince cihazdan düşmüş sayılır (tek okuma isteğin reddi olabilir, satış hakkında bir şey
 * söylemez; ask) · `eodMs`: banka gün sonunun yanıtı en çok bu kadar beklenir (bankalara bağlanır, dakikalar
 * sürebilir) · `eodCopyMs`: son gün sonunun bilgisi (doğrulama ve gün sonundan hemen önceki taban)
 */
export const pavoTiming = { sendWaitMs: 6_000, askEveryMs: 5_000, failConfirmMs: 15_000, eodMs: 180_000, eodCopyMs: 30_000 };

/** Cihaz meşgulken verilecek ret: süren gün sonu ya da cihazın ekranındaki satış */
export function busyMessage(c: PavoClient, then: string): string | null {
  if (!c.busyWith) return null;
  return c.busyWith === PAVO_EOD ? 'Cihazda gün sonu sürüyor' : `Cihazda süren bir satış var; ${then}`;
}

/** Satış isteğinin yanıtı (sepet kimliğiyle); sorgu döngüsü alıp işler */
const outcomes = new Map<string, PavoResponse | PavoError>();
const lastAsked = new Map<string, number>();
/**
 * Sonuç sorgusunun "başarısız" okumasının art arda ilk görüldüğü an ve kodu (sepet başına). Satış ancak aynı kodlu
 * okuma en az `failConfirmMs` sonraki bir sorguda da gelirse cihazdan düşmüş sayılır; arada gelen başka her okuma
 * (başka kodlu başarısız okuma da: geçici ret ardından "satış yok" iki ayrı tek okumadır) sayacı baştan başlatır
 */
const failedSince = new Map<string, { since: number; code: string | null }>();

function cancelledResult(res: PavoResponse | null): FiscalResult {
  return { status: 'cancelled', docKind: null, zNo: null, receiptNo: null, docId: null, payments: [], raw: res };
}

/** Sonucu sipariş no ile sorar */
async function ask(c: PavoClient, receiptId: string, orderNo: string): Promise<PollOutcome> {
  lastAsked.set(receiptId, Date.now());
  const res = await c.saleResult(orderNo);
  const reading = readSale(res);
  if (reading.kind === 'paid' || reading.kind === 'cancelled') return { kind: 'result', result: reading.result };
  if (reading.kind === 'failed' && pairingLost(reading.code)) {
    // Eşleştirme bozuk (73, 74): cihaz isteği reddetti, satış hakkında bir şey söylemedi. Sepet bekler: müşteri cihazda
    // ödemiş olabilir, iptal sayılsa yeniden gönderim kartı ikinci kez çekerdi (inceleme, 23 Kas 2026). Kasiyer
    // eşleştirme mesajını görür ("Son hata"da "Yeniden eşleştir"); eşleşince sorgu sonucu getirir
    failedSince.delete(receiptId);
    throw new PavoError(reading.message, reading.code, false, res);
  }
  // Cihaz bu satışla meşgul değilken "satış yok / başarısız" diyorsa (kart reddedildi, satış cihazdan düştü) satış
  // bitmiştir: sepet vazgeçildi sayılır, ödeme penceresi yeniden göndermeye hazır olur. Sahada (22 Kas 2026) kart reddinden
  // sonra sepet "Cihazda ödeme bekleniyor"da kalıyor, kasiyer elle iptal edip yeniden gönderiyordu. Belge kesilmişse yanıt
  // "ödendi" okunur (yukarıda); ağ hatası buraya gelmez (istek fırlatır, sepet bekler). Cihazın "satış yok" kodu
  // bilinmiyor: tek "başarısız" okuma isteğin geçici reddi de olabilir (cihaz meşgul), satış ancak aynı kodlu okuma
  // `failConfirmMs` sonra da gelirse düşmüş sayılır (inceleme, 23 Kas 2026). Sonuçta cihazın ham yanıtı saklanır: kod
  // sahada öğrenilir
  if (reading.kind === 'failed' && c.busyWith !== orderNo) {
    const now = Date.now();
    const prev = failedSince.get(receiptId);
    // Kod değiştiyse (ör. önce cihaz meşgul, sonra "satış yok") okumalar aynı değil: sayaç yeni koddan başlar
    const since = prev && prev.code === reading.code ? prev.since : now;
    failedSince.set(receiptId, { since, code: reading.code });
    if (now - since >= pavoTiming.failConfirmMs) return { kind: 'result', result: cancelledResult(res) };
    return { kind: 'pending', locked: false, lockedBy: null };
  }
  failedSince.delete(receiptId);
  return { kind: 'pending', locked: false, lockedBy: null };
}

/** Bekleyen sepetin bir sorgusu: önce gelen yanıt, yoksa (en sık `askEveryMs`'de bir) sipariş no ile sorgu */
async function pollOnce(r: PendingReceipt): Promise<PollOutcome> {
  const c = pavo();
  if (!c) return { kind: 'pending', locked: r.status === 'kilitli', lockedBy: null };
  const orderNo = pavoOrderNo(r.id);
  const out = outcomes.get(r.id);
  if (out) {
    outcomes.delete(r.id);
    if (!(out instanceof PavoError)) {
      const reading = readSale(out);
      if (reading.kind === 'paid' || reading.kind === 'cancelled') return { kind: 'result', result: reading.result };
      if (reading.kind === 'failed') {
        // Cihaz satışı hatayla bitirdi (kart reddi, kasiyer kapattı). Belge kesilip kesilmediği bir kez sorulur:
        // kesildiyse ödendi, değilse vazgeçildi. Cihaz meşgulse (gün sonu, en çok 3 dk; ya da başka satış) sorgu
        // onun arkasında kuyrukta beklerdi: yanıt saklanır, sepet bekler, cihaz boşalınca sorulur
        if (c.busyWith) {
          outcomes.set(r.id, out);
          return { kind: 'pending', locked: false, lockedBy: null };
        }
        // Bu sorguyu cihaz eşleştirme bozuk diye reddederse (73, 74) belge kesilip kesilmediği bilinmez: sepet iptal
        // sayılmaz, sorgu eşleştirme mesajıyla hata verir ("Son hata"). Eşleşince sonuç sorgusu (ask) karar verir: kart
        // çekilmişse ödendi, değilse "satış yok" kesinleşince vazgeçildi; iptal sayılsaydı yeniden gönderim kartı
        // ikinci kez çekerdi (inceleme, 23 Kas 2026)
        const again = await ask(c, r.id, orderNo).catch((e: unknown) => {
          if (e instanceof PavoError && pairingLost(e.code)) throw e;
          return null;
        });
        return again?.kind === 'result' ? again : { kind: 'result', result: cancelledResult(out) };
      }
      // Hatasız ama satış kaydı yok: sonuç sorulur
    }
  }
  if (c.busyWith === orderNo) return { kind: 'pending', locked: true, lockedBy: 'Pavo' };
  // Gün sonu sürerken cihaz sorgu da almaz (yanıtı gün sonunu bekler): sepet bekler, gün sonu bitince sorulur
  if (c.busyWith === PAVO_EOD) return { kind: 'pending', locked: r.status === 'kilitli', lockedBy: null };
  if (Date.now() - (lastAsked.get(r.id) ?? 0) < pavoTiming.askEveryMs) return { kind: 'pending', locked: false, lockedBy: null };
  return ask(c, r.id, orderNo);
}

export const pavoProvider: FiscalProvider = {
  id: 'pavo',
  label: 'Pavo · yerel ağ',
  capabilities: { transport: 'push', instant: true, list: false, splitPayment: true, cancel: true, poll: true, docKinds: ['e_arsiv', 'e_fatura', 'bilgi_fisi'] },
  configured: () => !!pavo(),
  notConfigured: 'Pavo cihazının adresi ve seri numarası girilmedi (Yönetim › Yazarkasa POS › Pavo)',
  terminalId: () => pavo()?.cfg.serial ?? null,
  status() {
    const c = pavo();
    return {
      configured: !!c,
      source: c ? clientSource : null,
      url: c?.cfg.url ?? null,
      serial: c?.cfg.serial ?? null,
      paired: store.getSequence() > 0,
      fingerprint: pavoFingerprint().value,
      fingerprintSource: pavoFingerprint().source,
      certificate: store.getCert(),
      busy: c?.busyWith ?? null,
      exchanges: c?.exchanges ?? [],
    };
  },
  validate(basket) {
    // Sepet cihaza gitmeden (sepet kaydı yazılmadan) denetlenir: KDV grubu cihazın bilmediği bir oransa ret
    pavoSale(basket, 'LP');
  },
  async send(r: PendingReceipt) {
    const c = pavo()!;
    const busy = busyMessage(c, 'önce onu tamamlayın');
    if (busy) throw new PavoError(busy);
    const orderNo = pavoOrderNo(r.id);
    const run = c.completeSale(pavoSale(r.basket, orderNo, process.env.npm_package_version ?? '1'));
    // Yanıt ne zaman gelirse sorgu döngüsü işler; ilk saniyelerde gelen ret kasiyere hemen hata olarak döner
    const settled = run.then(
      (res) => res,
      (e: unknown) => (e instanceof PavoError ? e : new PavoError(e instanceof Error ? e.message : String(e), null, true)),
    );
    void settled.then((out) => outcomes.set(r.id, out));
    const early = await Promise.race([settled, new Promise<null>((res) => setTimeout(() => res(null), pavoTiming.sendWaitMs).unref?.())]);
    if (early === null) return;
    if (early instanceof PavoError) {
      outcomes.delete(r.id);
      throw early;
    }
    const reading = readSale(early);
    if (reading.kind === 'failed') {
      outcomes.delete(r.id);
      throw new PavoError(reading.message, reading.code, false, early);
    }
  },
  async cancel(r: PendingReceipt) {
    const c = pavo();
    if (!c) throw new Error('Pavo bağlantısı yok');
    const orderNo = pavoOrderNo(r.id);
    // Satış ekranı cihazda açıkken cihaz başka istek almaz: vazgeçme cihazdan yapılır, sonuç kendiliğinden gelir
    if (c.busyWith === orderNo) throw new PavoError('Satış cihazın ekranında açık; cihazda vazgeçin, LafPOS sepeti kendiliğinden kapatır');
    // Gün sonu sürerken cihaz sorgu almaz (en çok 3 dk): iptal beklemeden reddedilir; cihaza ulaşılamadı sayılmaz
    if (c.busyWith === PAVO_EOD) throw new PavoError('Cihazda gün sonu sürüyor; bitince yeniden deneyin', 'EOD_BUSY');
    if (outcomes.has(r.id)) throw new PavoError('Cihazın yanıtı geldi, işleniyor; birkaç saniye sonra yeniden deneyin');
    // Cihazda ödenmiş satış silinmez (sonucu işlenir); ödenmemiş satış cihazda kalmaz, silinecek bir şey yok
    const res = await c.saleResult(orderNo);
    const reading = readSale(res);
    if (reading.kind === 'paid') throw new PavoError('Bu satış cihazda ödenmiş; sonuç adisyona işleniyor');
    // Eşleştirme bozuksa (73, 74) yanıt satış hakkında değil: ödenip ödenmediği bilinmez, sepet "cihaza ulaşılamadı"
    // gibi yalnız yetkili onayıyla iptal sayılır (inceleme, 23 Kas 2026)
    if (reading.kind === 'failed' && pairingLost(reading.code)) throw new PavoError(reading.message, reading.code, false, res);
    lastAsked.delete(r.id);
    failedSince.delete(r.id);
  },
  async poll(r: PendingReceipt): Promise<PollOutcome> {
    const out = await pollOnce(r);
    // Sonuçlanan sepetin izi tutulmaz: sorgu zamanı, gelen yanıt ve "başarısız" okuması yalnız bekleyen sepet için
    if (out.kind !== 'pending') {
      lastAsked.delete(r.id);
      outcomes.delete(r.id);
      failedSince.delete(r.id);
    }
    return out;
  },
  async test() {
    const c = pavo();
    if (!c) throw new Error(pavoProvider.notConfigured);
    const busy = busyMessage(c, 'bitince deneyin');
    if (busy) throw new PavoError(busy);
    const ping = await c.ping();
    const mediators = await c.paymentMediators().catch((e: unknown) => ({ HasError: true, Message: e instanceof Error ? e.message : String(e) }) as PavoResponse);
    const list = mediators.HasError ? [] : readMediators(mediators);
    return {
      ping: { ok: !ping.HasError, message: ping.HasError ? describe(ping) : (ping.Message ?? null) },
      paired: !mediators.HasError,
      pairingHint: mediators.HasError ? (pairingLost(mediators.ErrorCode) ? describe(mediators) : `Eşleştirme gerekli: ${describe(mediators)}`) : null,
      mediators: list,
      // Cihaz yanıt verdi ama liste tanınmadı: yanıtın alan adları (değer değil) destek için görünür
      mediatorsNote: !mediators.HasError && !list.length ? `Cihaz ödeme araçlarını tanınan biçimde vermedi${c.exchanges[0]?.dataKeys.length ? ` (alanlar: ${c.exchanges[0].dataKeys.join(', ')})` : ''}` : null,
    };
  },
};

/** Yönetim › Yazarkasa POS › Eşleştir */
export async function pairPavo() {
  let c = pavo();
  if (!c) throw new Error(pavoProvider.notConfigured);
  const busy = busyMessage(c, 'bitince eşleştirin');
  if (busy) throw new PavoError(busy);
  // İlk eşleştirme kurulumun kimliğini üretir (istemci yeni kimlikle kurulur); sonrakiler aynısını kullanır
  if (c.cfg.fingerprint !== ensureFingerprint()) c = pavo()!;
  const res = await c.pair();
  return { ok: true, message: res.Message ?? null, certificate: store.getCert() };
}
