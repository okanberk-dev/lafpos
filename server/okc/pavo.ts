import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { PAVO_KIMLIGI } from '@shared/eski-adlar';

/**
 * Pavo yazarkasa POS (N86 ve diğer PavoPay cihazları) için yerel ağ REST istemcisi.
 *
 * Kaynaklar (Kasım 2026): Pavo'nun belge sitesi (docs.pavopay.dev) yalnız iş ortaklarına açık. Bağlantı kuralları
 * sitenin herkese açıkken kaydedilmiş REST sayfasından: cihaz yerel ağda (Wi-Fi ya da Ethernet) HTTP sunucusudur,
 * her uç JSON `POST`'tur, aynı anda tek istek işler, her istekte `TransactionHandle` (seri no, eşleştirmedeki
 * parmak izi, kesin artan sıra no, cihaz saatinden en çok ±300 sn sapan tarih) gönderilir; `/Ping` ve `/Pairing`
 * bu denetimden muaftır. Satış uçları (`/CompleteSale`, `/GetSaleResult`) ve satış gövdesi entegratörlerin açık
 * kodlarından; satış sonucunun biçimi Pavo'nun satış kaydından (AddedPayments, FinancialDocuments). Banka gün sonu
 * (`/PerformEOD`, `/PrintEODCopy`) Pavo'nun REST paketinden (BKM TechPOS 509 REST V39, örnek istek ve yanıtlarıyla).
 * Ayrıntı ve doğrulanmamış noktalar: docs/04-YAZARKASA.md §8.
 *
 * Güvenlik: cihaz kendi imzaladığı sertifikayla HTTPS sunar. LafPOS eşleştirmede gördüğü sertifikanın parmak izini
 * saklar ve sonraki isteklerde gövdeyi göndermeden önce karşılaştırır (aynı ağdaki başka bir makine kendini cihaz
 * gibi gösteremez). Sertifika değişirse (cihaz uygulaması güncellendi) yeniden eşleştirilir.
 */

export interface PavoConfig {
  /** Cihazın adresi, ör. https://192.168.1.50:4567 */
  url: string;
  /** Cihazın seri numarası (ayarlar › cihaz bilgisi; fişin altında da yazar) */
  serial: string;
  /** Eşleştirmede cihaza kaydedilen kimlik; her istekte aynısı gider */
  fingerprint: string;
}

/** Cihazın her yanıtının ortak kabuğu */
export interface PavoResponse {
  HasError?: boolean;
  HasAbondon?: boolean;
  ErrorCode?: string | number | null;
  Message?: string | null;
  Errors?: unknown;
  Data?: unknown;
  TransactionHandle?: unknown;
  [key: string]: unknown;
}

/** Sıra no ve sertifika izi kalıcı saklanır (sunucu yeniden başlasa da sıra geri gitmez) */
export interface PavoStore {
  getSequence(): number;
  setSequence(n: number): void;
  getCert(): string | null;
  setCert(fp: string | null): void;
}

export class PavoError extends Error {
  constructor(
    message: string,
    /** Cihazın hata kodu (yanıt geldiyse) */
    public code: string | null = null,
    /** Yanıt alınamadı (zaman aşımı, bağlantı koptu): istek cihaza ulaşmış olabilir */
    public uncertain = false,
    public response: PavoResponse | null = null,
  ) {
    super(message);
    this.name = 'PavoError';
  }
}

/** Cihazın son yanıtları (yönetim ekranında gösterilir; gövde değil, özet) */
export interface PavoExchange {
  at: number;
  path: string;
  ok: boolean;
  errorCode: string | null;
  message: string | null;
  /**
   * Yanıttaki `Data`'nın üst düzey alanları: belgesiz yanıt biçimini tanımak için. `Data` dizi ise ilk öğesinin
   * alanları (`[]` önekiyle), `Data` yoksa yanıtın kabuk dışındaki üst düzey alanları (`.` önekiyle)
   */
  dataKeys: string[];
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Cihazın beklediği yerel saat biçimi: yyyy-MM-ddTHH:mm:ss.fff (saat dilimi eki yok) */
export function pavoDate(d = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/** Sertifikanın SHA-256 izi (Node'un `fingerprint256` biçimi: iki nokta ayrımlı büyük harf) */
export function certFingerprint(raw: Buffer): string {
  return (
    createHash('sha256')
      .update(raw)
      .digest('hex')
      .toUpperCase()
      .match(/../g)
      ?.join(':') ?? ''
  );
}

/** Cihazın REST portu yazılmazsa: N86'da entegratörlerin kullandığı (docs/04-YAZARKASA.md §8.1) */
export const PAVO_DEFAULT_PORT = 4567;

/**
 * Yönetimde yazılan cihaz adresi → istemcinin adresi. "192.168.1.50", "192.168.1.50:4568" ya da
 * "http://192.168.1.50:4567" kabul edilir; şema yazılmazsa https, port yazılmazsa 4567. Yol, kullanıcı adı, sorgu
 * kabul edilmez; anlaşılmayan adres null
 */
export function pavoAddress(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 200 || /\s/.test(raw)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw)?.[1]?.toLowerCase() ?? null;
  if (scheme && scheme !== 'http' && scheme !== 'https') return null;
  const rest = scheme ? raw.slice(scheme.length + 3) : raw;
  const host = rest.replace(/\/+$/, '');
  // Yalnız ad ya da IPv4 ve isteğe bağlı port: yol, kullanıcı ve sorgu yok
  const m = /^([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::(\d{1,5}))?$/i.exec(host);
  if (!m) return null;
  const port = m[2] ? Number(m[2]) : PAVO_DEFAULT_PORT;
  if (port < 1 || port > 65535) return null;
  return `${scheme ?? 'https'}://${m[1]!.toLowerCase()}:${port}`;
}

/** Cihazın seri numarası: fişin altında ve cihazın ayarlarında yazan harf ve rakamlar */
export function pavoSerial(input: string): string | null {
  const s = input.trim().toUpperCase();
  return /^[A-Z0-9][A-Z0-9._-]{2,39}$/.test(s) ? s : null;
}

/** Gün sonu sürerken `busyWith` bu değeri taşır (sipariş no'ları `LP` ile başlar, karışmaz) */
export const PAVO_EOD = 'GUNSONU';

export class PavoClient {
  /** Cihaz aynı anda tek istek işler: istekler sıraya girer */
  private queue: Promise<unknown> = Promise.resolve();
  /** Süren satış isteğinin sipariş no'su (cihazın ekranında açık satış) ya da süren gün sonu (`PAVO_EOD`) */
  busyWith: string | null = null;
  readonly exchanges: PavoExchange[] = [];

  constructor(
    public cfg: PavoConfig,
    private store: PavoStore,
  ) {}

  static configFromEnv(env: Record<string, string | undefined>): PavoConfig | null {
    const url = (env.PAVO_URL ?? '').trim().replace(/\/+$/, '');
    const serial = (env.PAVO_SERIAL ?? '').trim();
    if (!/^https?:\/\/[^/\s]+$/.test(url) || !serial) return null;
    return { url, serial, fingerprint: (env.PAVO_FINGERPRINT ?? '').trim() || PAVO_KIMLIGI };
  }

  /** Bağlantı denemesi (eşleştirmesiz çalışır) */
  ping(timeoutMs = 10_000): Promise<PavoResponse> {
    return this.call('/Ping', {}, { timeoutMs, sequence: 'none' });
  }

  /**
   * Eşleştirme: cihazda onay ekranı açılır, kasiyer onaylar. Sıra no 1'den başlar; görülen sertifika bundan sonra
   * tek geçerli sertifikadır. Pavo günde bir eşleştirmeyi önerir (sıra no sıfırlanır, bağlantı doğrulanır).
   */
  async pair(): Promise<PavoResponse> {
    const res = await this.call('/Pairing', {}, { timeoutMs: 120_000, sequence: 'pair', trustNewCert: true });
    if (res.HasError) throw new PavoError(`Eşleştirme reddedildi: ${describe(res)}`, code(res), false, res);
    return res;
  }

  /** Cihazda tanımlı ödeme araçları (nakit, kart, yemek kartı...) */
  paymentMediators(): Promise<PavoResponse> {
    return this.call('/PaymentMediators', {}, { timeoutMs: 15_000 });
  }

  /**
   * Satışı cihaza yollar. Yanıt kasiyer cihazda ödemeyi alıp belgeyi kesince (ya da vazgeçince) gelir; o süre
   * boyunca cihaz başka istek almaz.
   */
  async completeSale(sale: PavoSale): Promise<PavoResponse> {
    if (this.busyWith === PAVO_EOD) throw new PavoError('Cihazda gün sonu sürüyor');
    this.busyWith = sale.OrderNo;
    try {
      return await this.call('/CompleteSale', { Sale: sale }, { timeoutMs: 5 * 60_000 });
    } finally {
      if (this.busyWith === sale.OrderNo) this.busyWith = null;
    }
  }

  /** Sipariş no ile satışın sonucunu sorar */
  saleResult(orderNo: string): Promise<PavoResponse> {
    return this.call('/GetSaleResult', { Sale: { OrderNo: orderNo } }, { timeoutMs: 15_000 });
  }

  /**
   * Banka gün sonu (`/PerformEOD`): cihaz bankalardaki kart işlemlerini kapatır (batch). Sürerken (en çok 3 dk)
   * `busyWith` gün sonu işaretidir, cihaz satış almaz. Özet istenir (`useSummary`); slip görüntüsü, JSON ve metin
   * istenmez (yanıt küçük kalır, kart numarası taşıyan döküm gelmez). Yanıt alınamazsa gün sonu alınmış olabilir:
   * yeniden denemeden önce `eodCopy` ile doğrulanır. `before` gün sonu gönderilmeden, cihaz meşgul işaretliyken
   * çalışır (araya satış girmez): cihazın son gün sonunu okumak, "sürüyor" kaydı. Hata atarsa gün sonu gönderilmez.
   */
  async performEod(opts: { print?: boolean; timeoutMs?: number; before?: () => Promise<void> | void } = {}): Promise<PavoResponse> {
    if (this.busyWith) throw new PavoError(this.busyWith === PAVO_EOD ? 'Cihazda gün sonu sürüyor' : 'Cihazda süren bir satış var; bitince gün sonu alın');
    this.busyWith = PAVO_EOD;
    try {
      await opts.before?.();
      return await this.call(
        '/PerformEOD',
        { PerformEOD: { AdditionalInfo: { useSummary: true, print: !!opts.print, receiptImage: false, receiptWidth: '58mm', printData: { receiptJsonEnabled: false, receiptTextEnabled: false } } } },
        { timeoutMs: opts.timeoutMs ?? 180_000 },
      );
    } finally {
      if (this.busyWith === PAVO_EOD) this.busyWith = null;
    }
  }

  /**
   * Önceki gün sonunun bilgisi (`/PrintEODCopy`); `batchNo` verilmezse son gün sonu. Pavo'da bu uç varsayılan olarak
   * slip basar: `print: false` açıkça gönderilir, LafPOS yalnız özeti okur.
   */
  eodCopy(batchNo?: number, timeoutMs = 30_000): Promise<PavoResponse> {
    return this.call('/PrintEODCopy', { EODCopy: { ...(batchNo != null ? { batchNo } : {}), useSummary: true, print: false, receiptImage: false } }, { timeoutMs });
  }

  private call(path: string, body: Record<string, unknown>, opts: { timeoutMs: number; sequence?: 'next' | 'pair' | 'none'; trustNewCert?: boolean }): Promise<PavoResponse> {
    const run = async () => {
      const seq = opts.sequence === 'pair' ? 1 : opts.sequence === 'none' ? Math.max(1, this.store.getSequence()) : this.store.getSequence() + 1;
      // Sıra no gönderimden önce yazılır: yanıt gelmese de aynı numara ikinci kez gitmez (cihaz tekrarı reddeder)
      if (opts.sequence !== 'none') this.store.setSequence(seq);
      const payload = {
        TransactionHandle: { SerialNumber: this.cfg.serial, TransactionDate: pavoDate(), TransactionSequence: seq, Fingerprint: this.cfg.fingerprint },
        ...body,
      };
      let res: PavoResponse;
      try {
        res = await this.post(path, payload, opts.timeoutMs, !!opts.trustNewCert);
      } catch (e) {
        this.note(path, null, e instanceof Error ? e.message : String(e));
        throw e;
      }
      this.note(path, res);
      return res;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private note(path: string, res: PavoResponse | null, error?: string) {
    this.exchanges.unshift({
      at: Date.now(),
      path,
      ok: !!res && !res.HasError,
      errorCode: res ? code(res) : null,
      message: res ? (res.Message ?? null) : (error ?? null),
      dataKeys: res ? shapeOf(res) : [],
    });
    this.exchanges.length = Math.min(this.exchanges.length, 10);
  }

  private post(path: string, payload: unknown, timeoutMs: number, trustNewCert: boolean): Promise<PavoResponse> {
    const url = new URL(path, this.cfg.url);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    const secure = url.protocol === 'https:';
    return new Promise<PavoResponse>((resolve, reject) => {
      let sent = false;
      const fail = (e: PavoError) => reject(e);
      const headers = { 'content-type': 'application/json; charset=utf-8', accept: 'application/json', 'content-length': String(body.length) };
      const common = { method: 'POST', hostname: url.hostname, port: url.port || (secure ? 443 : 80), path: url.pathname, headers, agent: false as const, timeout: timeoutMs };
      const req = secure
        ? // Cihazın sertifikası kendinden imzalı: zincir yerine eşleştirmede saklanan parmak izi denetlenir
          httpsRequest({ ...common, rejectUnauthorized: false })
        : httpRequest(common);
      // Bağlantı kurulduktan sonraki hata belirsizdir (istek cihaza ulaşmış olabilir); kurulamayan bağlantı kesin hatadır
      if (!secure) req.on('socket', (socket) => socket.once('connect', () => (sent = true)));
      req.on('timeout', () => req.destroy(new PavoError(`Cihaz ${Math.round(timeoutMs / 1000)} sn içinde yanıt vermedi`, null, sent)));
      req.on('error', (e) => {
        if (e instanceof PavoError) return fail(e);
        const errno = (e as NodeJS.ErrnoException).code;
        // Gövde gitmeden kurulamayan bağlantı kesin hatadır; gönderildikten sonra kopan bağlantı belirsizdir
        const msg =
          errno === 'ECONNREFUSED'
            ? 'Cihaz bağlantıyı reddetti (adres ya da port yanlış, cihazda REST kapalı olabilir)'
            : errno === 'EHOSTUNREACH' || errno === 'ENETUNREACH'
              ? 'Cihaza ulaşılamadı (aynı ağda mı, IP adresi değişmiş olabilir)'
              : `Cihaza bağlanılamadı: ${e.message}`;
        fail(new PavoError(msg, errno ?? null, sent));
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('error', (e) => fail(new PavoError(`Cihazın yanıtı okunamadı: ${e.message}`, null, true)));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json: unknown;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          if (!json || typeof json !== 'object') {
            return fail(new PavoError(`Cihazdan tanınmayan yanıt (HTTP ${res.statusCode})`, `HTTP_${res.statusCode}`, true));
          }
          resolve(json as PavoResponse);
        });
      });
      const send = () => {
        if (secure) sent = true;
        req.end(body);
      };
      if (!secure) return send();
      req.on('socket', (socket) => {
        (socket as TLSSocket).once('secureConnect', () => {
          const raw = (socket as TLSSocket).getPeerCertificate()?.raw;
          const seen = raw ? certFingerprint(raw) : '';
          const known = this.store.getCert();
          if (trustNewCert) {
            if (seen) this.store.setCert(seen);
          } else if (known && seen !== known) {
            req.destroy(new PavoError('Cihazın sertifikası eşleştirmedekinden farklı. Cihaz değiştiyse ya da uygulaması güncellendiyse Yönetim › Yazarkasa POS › Eşleştir', 'CERT_CHANGED'));
            return;
          }
          send();
        });
      });
    });
  }
}

/** Kabuğun bilinen alanları: yanıtın biçimi özetlenirken sayılmaz */
const ENVELOPE = new Set(['HasError', 'HasAbondon', 'ErrorCode', 'Message', 'Errors', 'Data', 'TransactionHandle']);

/** Yanıtın biçimi (değer değil, yalnız alan adları): `PavoExchange.dataKeys` */
function shapeOf(res: PavoResponse): string[] {
  const data = res.Data;
  const keys = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.keys(v) : []);
  if (Array.isArray(data)) return keys(data[0]).map((k) => `[].${k}`).slice(0, 40);
  if (data && typeof data === 'object') return Object.keys(data).slice(0, 40);
  return Object.keys(res)
    .filter((k) => !ENVELOPE.has(k))
    .map((k) => `.${k}`)
    .slice(0, 40);
}

function code(res: PavoResponse): string | null {
  return res.ErrorCode == null || res.ErrorCode === '' ? null : String(res.ErrorCode);
}

/**
 * Eşleştirmenin bozulduğunu söyleyen cihaz kodları (sahada görüldü, Kasım 2026): 73 sıra no hatası, 74 kimlik
 * (FingerPrint) tutmuyor. İkisi de cihaz başka bir programla (başka POS, Pavo'nun kendi uygulaması) yeniden
 * eşleştirilince gelir; LafPOS'tan yeniden eşleştirince düzelir (sıra no 1'den başlar, kimlik yeniden kaydedilir)
 */
const PAIRING_LOST = new Set(['73', '74']);
export function pairingLost(errorCode: string | number | null | undefined): boolean {
  return errorCode != null && PAIRING_LOST.has(String(errorCode));
}
export const PAIRING_LOST_MESSAGE = 'Cihaz başka bir programla eşleştirilmiş; Yönetim › Yazarkasa POS’ta “Eşleştir”e basıp cihazdaki onayı verin, sonra yeniden deneyin';

export function describe(res: PavoResponse): string {
  const c = code(res);
  const said = [res.Message?.trim() || 'Cihaz hata döndürdü', c ? `(kod ${c})` : ''].filter(Boolean).join(' ');
  return pairingLost(c) ? `${PAIRING_LOST_MESSAGE}. Cihazın yanıtı: ${said}` : said;
}

// ─── Satış gövdesi ─────────────────────────────────────────────────────────

export interface PavoSaleItem {
  Name: string;
  IsGeneric: boolean;
  /** C62 adet, KGM kilogram (UN/ECE birim kodu) */
  UnitCode: string;
  /** KDV1, KDV10, KDV20 */
  TaxGroupCode: string;
  ItemQuantity: number;
  /** TL, KDV dahil */
  UnitPriceAmount: number;
  GrossPriceAmount: number;
  TotalPriceAmount: number;
}

export interface PavoSale {
  RefererApp: string;
  RefererAppVersion: string;
  OrderNo: string;
  /** 1: satış belgesi (cihaz kendi ayarına göre e-Arşiv, e-Fatura ya da bilgi fişi keser) */
  MainDocumentType: number;
  GrossPrice: number;
  TotalPrice: number;
  CurrencyCode: 'TRY';
  ExchangeRate: number;
  SendResponseBeforePrint: boolean;
  AddedSaleItems: PavoSaleItem[];
  /** Önceden seçili ödeme (Mediator 1 nakit, 2 kart; entegratörlerin açık kodundan, belge kapalı): cihaz o türle açılır */
  PaymentInformations?: { Mediator: number; Amount: number; CurrencyCode: 'TRY'; ExchangeRate: number }[];
}
