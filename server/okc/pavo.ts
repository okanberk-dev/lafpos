import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { TLSSocket } from 'node:tls';

/**
 * Pavo yazarkasa POS (N86 ve diğer PavoPay cihazları) için yerel ağ REST istemcisi.
 *
 * Kaynaklar (Kasım 2026): Pavo'nun belge sitesi (docs.pavopay.dev) yalnız iş ortaklarına açık. Bağlantı kuralları
 * sitenin herkese açıkken kaydedilmiş REST sayfasından: cihaz yerel ağda (Wi-Fi ya da Ethernet) HTTP sunucusudur,
 * her uç JSON `POST`'tur, aynı anda tek istek işler, her istekte `TransactionHandle` (seri no, eşleştirmedeki
 * parmak izi, kesin artan sıra no, cihaz saatinden en çok ±300 sn sapan tarih) gönderilir; `/Ping` ve `/Pairing`
 * bu denetimden muaftır. Satış uçları (`/CompleteSale`, `/GetSaleResult`) ve satış gövdesi entegratörlerin açık
 * kodlarından; satış sonucunun biçimi Pavo'nun satış kaydından (AddedPayments, FinancialDocuments). Ayrıntı ve
 * doğrulanmamış noktalar: docs/04-YAZARKASA.md §8.
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
  /** Yanıttaki `Data`'nın üst düzey alanları: belgesiz yanıt biçimini tanımak için */
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

export class PavoClient {
  /** Cihaz aynı anda tek istek işler: istekler sıraya girer */
  private queue: Promise<unknown> = Promise.resolve();
  /** Süren satış isteğinin sipariş no'su (cihazın ekranında açık satış) */
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
    return { url, serial, fingerprint: (env.PAVO_FINGERPRINT ?? '').trim() || 'LafPOS' };
  }

  /** Bağlantı denemesi (eşleştirmesiz çalışır) */
  ping(): Promise<PavoResponse> {
    return this.call('/Ping', {}, { timeoutMs: 10_000, sequence: 'none' });
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
    const data = res?.Data;
    this.exchanges.unshift({
      at: Date.now(),
      path,
      ok: !!res && !res.HasError,
      errorCode: res ? code(res) : null,
      message: res ? (res.Message ?? null) : (error ?? null),
      dataKeys: data && typeof data === 'object' && !Array.isArray(data) ? Object.keys(data).slice(0, 40) : [],
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

function code(res: PavoResponse): string | null {
  return res.ErrorCode == null || res.ErrorCode === '' ? null : String(res.ErrorCode);
}

export function describe(res: PavoResponse): string {
  const c = code(res);
  return [res.Message?.trim() || 'Cihaz hata döndürdü', c ? `(kod ${c})` : ''].filter(Boolean).join(' ');
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
}
