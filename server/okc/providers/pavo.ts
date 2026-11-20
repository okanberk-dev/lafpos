import type { MethodKind } from '../basket';
import { describe, PavoClient, PavoError, type PavoResponse, type PavoSale, type PavoSaleItem, type PavoStore } from '../pavo';
import type { DocKind, FiscalBasket, FiscalPayment, FiscalProvider, FiscalResult, PendingReceipt, PollOutcome } from './types';

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
let backing: PavoStore | null = null;
export function usePavoStore(s: PavoStore) {
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

let client: PavoClient | null | undefined;
export function pavo(): PavoClient | null {
  if (client === undefined) {
    const cfg = PavoClient.configFromEnv(process.env);
    client = cfg ? new PavoClient(cfg, store) : null;
  }
  return client;
}
/** Testler için: ortam değişince istemci yeniden kurulur */
export function resetPavo(next?: PavoClient | null) {
  client = next === undefined ? undefined : next;
  outcomes.clear();
  lastAsked.clear();
}

/** LafPOS'un sepet kimliğinden cihazın sipariş no'su (16 karakter; aynı sepet hep aynı no) */
export function pavoOrderNo(basketId: string): string {
  return `LP${basketId.replace(/-/g, '').toUpperCase().slice(0, 14)}`;
}

const tl = (kurus: number) => kurus / 100;

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
    total += amount;
    const tax = `KDV${Math.round(it.taxPercent / 100)}`;
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
    RefererApp: 'LafPOS',
    RefererAppVersion: appVersion,
    OrderNo: orderNo,
    MainDocumentType: 1,
    GrossPrice: tl(total),
    TotalPrice: tl(total),
    CurrencyCode: 'TRY',
    ExchangeRate: 1,
    SendResponseBeforePrint: false,
    AddedSaleItems: items,
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
 * Pavo'nun ödeme tipi: 1 nakit, 2 kredi kartı (satış kaydında). Anlamı belgelenmemiş tip (yemek kartı, havale...)
 * tahminle bir türe yazılmaz: ödemesi işlenmez, sepet eksik ödenmiş sayılır, yönetici kalanı doğru türle alır
 */
function kindOf(type: number | null): MethodKind | null {
  return type === 1 ? 'nakit' : type === 2 ? 'kart' : null;
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
export function readSale(res: PavoResponse): SaleReading {
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
    const kind = kindOf(type);
    if (kind) payments.push({ kind, amount: Math.round(amount * 100), operatorId: null, description: `Pavo ödeme tipi ${type}` });
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

/**
 * Bekleme süreleri (testler kısaltır). `sendWaitMs`: gönderimin ilk saniyeleri beklenir, cihaz satışı hemen
 * reddederse (KDV grubu, eşleştirme) kasiyer görür · `askEveryMs`: cihaz tek istek işler, sonuç sorgusu bekleyen
 * sepet başına en sık bu aralıkla
 */
export const pavoTiming = { sendWaitMs: 6_000, askEveryMs: 5_000 };

/** Satış isteğinin yanıtı (sepet kimliğiyle); sorgu döngüsü alıp işler */
const outcomes = new Map<string, PavoResponse | PavoError>();
const lastAsked = new Map<string, number>();

function cancelledResult(res: PavoResponse | null): FiscalResult {
  return { status: 'cancelled', docKind: null, zNo: null, receiptNo: null, docId: null, payments: [], raw: res };
}

/** Sonucu sipariş no ile sorar */
async function ask(c: PavoClient, receiptId: string, orderNo: string): Promise<PollOutcome> {
  lastAsked.set(receiptId, Date.now());
  const reading = readSale(await c.saleResult(orderNo));
  if (reading.kind === 'paid' || reading.kind === 'cancelled') return { kind: 'result', result: reading.result };
  return { kind: 'pending', locked: false, lockedBy: null };
}

export const pavoProvider: FiscalProvider = {
  id: 'pavo',
  label: 'Pavo · yerel ağ',
  capabilities: { transport: 'push', instant: true, list: false, splitPayment: true, cancel: true, poll: true, docKinds: ['e_arsiv', 'e_fatura', 'bilgi_fisi'] },
  configured: () => !!pavo(),
  notConfigured: 'Pavo bilgileri ayarlar dosyasında eksik (PAVO_URL, PAVO_SERIAL)',
  terminalId: () => pavo()?.cfg.serial ?? null,
  status() {
    const c = pavo();
    return {
      configured: !!c,
      url: c?.cfg.url ?? null,
      serial: c?.cfg.serial ?? null,
      paired: store.getSequence() > 0,
      certificate: store.getCert(),
      busy: c?.busyWith ?? null,
      exchanges: c?.exchanges ?? [],
    };
  },
  async send(r: PendingReceipt) {
    const c = pavo()!;
    if (c.busyWith) throw new PavoError('Cihazda süren bir satış var; önce onu tamamlayın');
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
    if (outcomes.has(r.id)) throw new PavoError('Cihazın yanıtı geldi, işleniyor; birkaç saniye sonra yeniden deneyin');
    // Cihazda ödenmiş satış silinmez (sonucu işlenir); ödenmemiş satış cihazda kalmaz, silinecek bir şey yok
    const reading = readSale(await c.saleResult(orderNo));
    if (reading.kind === 'paid') throw new PavoError('Bu satış cihazda ödenmiş; sonuç adisyona işleniyor');
  },
  async poll(r: PendingReceipt): Promise<PollOutcome> {
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
          // kesildiyse ödendi, değilse vazgeçildi
          const again = await ask(c, r.id, orderNo).catch(() => null);
          return again?.kind === 'result' ? again : { kind: 'result', result: cancelledResult(out) };
        }
        // Hatasız ama satış kaydı yok: sonuç sorulur
      }
    }
    if (c.busyWith === orderNo) return { kind: 'pending', locked: true, lockedBy: 'Pavo' };
    if (Date.now() - (lastAsked.get(r.id) ?? 0) < pavoTiming.askEveryMs) return { kind: 'pending', locked: false, lockedBy: null };
    return ask(c, r.id, orderNo);
  },
  async test() {
    const c = pavo();
    if (!c) throw new Error(pavoProvider.notConfigured);
    if (c.busyWith) throw new PavoError('Cihazda süren bir satış var; bitince deneyin');
    const ping = await c.ping();
    const mediators = await c.paymentMediators().catch((e: unknown) => ({ HasError: true, Message: e instanceof Error ? e.message : String(e) }) as PavoResponse);
    const list = Array.isArray(mediators.Data) ? (mediators.Data as unknown[]).map(obj).filter((o): o is Obj => !!o) : [];
    return {
      ping: { ok: !ping.HasError, message: ping.HasError ? describe(ping) : (ping.Message ?? null) },
      paired: !mediators.HasError,
      pairingHint: mediators.HasError ? `Eşleştirme gerekli: ${describe(mediators)}` : null,
      mediators: list.map((m) => ({ id: num(m.Mediator ?? m.Id ?? m.PaymentMediatorId), name: str(m.Name ?? m.Description ?? m.MediatorName) })),
    };
  },
};

/** Yönetim › Yazarkasa POS › Eşleştir */
export async function pairPavo() {
  const c = pavo();
  if (!c) throw new Error(pavoProvider.notConfigured);
  if (c.busyWith) throw new PavoError('Cihazda süren bir satış var; bitince eşleştirin');
  const res = await c.pair();
  return { ok: true, message: res.Message ?? null, certificate: store.getCert() };
}
