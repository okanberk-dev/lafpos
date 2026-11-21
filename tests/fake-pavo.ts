import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';

/**
 * Testler için sahte Pavo cihazı (yerel ağ REST). Pavo'nun REST sayfasındaki kurallarla: seri no aynı olmalı,
 * parmak izi eşleştirmedekiyle aynı olmalı, sıra no öncekinden kesin büyük olmalı, tarih ±300 sn içinde olmalı;
 * `/Ping` ve `/Pairing` muaf. Aynı anda tek istek: ikinci istek "meşgul" hatası alır. `/CompleteSale` kasiyer
 * cihazda bitirene kadar (testte `pay`, `abandon`, `reject`) açık kalır. Satış kaydı Pavo'nun satış biçiminde
 * (AddedPayments, FinancialDocuments). Banka gün sonu (`/PerformEOD`, `/PrintEODCopy`) Pavo'nun REST paketindeki
 * örnek yanıtların biçiminde: kartla alınan ödemeler açık batch'e girer, gün sonu batch'i kapatıp özeti döner.
 */

export interface FakeSale {
  orderNo: string;
  body: Record<string, unknown>;
  state: 'open' | 'paid' | 'abandoned' | 'failed';
  record?: Record<string, unknown>;
}

export interface FakePavo {
  url: string;
  serial: string;
  sales: Map<string, FakeSale>;
  requests: { path: string; body: Record<string, unknown> }[];
  /** Cihazın ekranındaki satışı ödenmiş bitirir (tutar TL) */
  pay(orderNo: string, payments: { type: number; amount: number; status?: number }[], doc?: { invoiceNo: string; typeName?: string }): void;
  abandon(orderNo: string): void;
  reject(orderNo: string, code: string, message: string): void;
  /** Bundan sonraki `/CompleteSale` hemen bu yanıtla döner */
  nextSaleReply: Record<string, unknown> | null;
  /** Bundan sonraki istekler yanıtsız kalır (bağlantı açık, cevap yok) */
  silent: boolean;
  /**
   * `/PerformEOD`: `ok` batch kapanır, özet döner · `fail` 5085 "Günsonu alınamadı" (batch açık kalır) · `silent` batch
   * kapanır ama yanıt gelmez (yanıtı kaybolan gün sonu) · `drop` istek işlenmez, batch açık kalır, yanıt gelmez
   */
  eodMode: 'ok' | 'fail' | 'silent' | 'drop';
  /**
   * `/PrintEODCopy`'nin yanıtı: `null` normal · `http404` gövdesiz HTTP 404 (sahada N86, uç yok) · nesne: bu JSON yanıt
   * (ör. eşleştirmesi bozulmuş cihazın 74'ü)
   */
  eodCopyReply: null | 'http404' | Record<string, unknown>;
  /** `/Ping` JSON yerine bu HTTP koduyla gövdesiz yanıt verir (seri no'suz Ping'i reddeden cihaz) */
  pingHttpStatus: number | null;
  /** `/PaymentMediators`'ın `Data`'sı (biçimi belgesiz; farklı biçimler denenir) */
  mediatorsData: unknown;
  /** `ok` gün sonunun yanıtı bu kadar gecikir (bankalara bağlanan cihaz) */
  eodDelayMs: number;
  /** Kapanmış batch'ler (son gün sonu en sonda) */
  batches: { batchNo: number; dateTime: string; eodData: Record<string, unknown> }[];
  /** Açık batch'e LafPOS dışından kart işlemi (TL) */
  addCardTransaction(amount: number): void;
  /** Cihazın kendi menüsünden gün sonu (LafPOS'a istek gelmez); `agoMs` kadar önce alınmış gibi */
  menuEod(agoMs?: number): void;
  close(): Promise<void>;
}

const tr = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const trAmount = (kurus: number) => tr.format(kurus / 100);
const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** Cihazın saat biçimi: gg.aa.yyyy ss:dd (İstanbul) */
const deviceTime = (ms: number) => {
  const d = new Date(ms + 3 * 3600_000);
  return `${pad(d.getUTCDate())}.${pad(d.getUTCMonth() + 1)}.${d.getUTCFullYear()} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};

const ok = (extra: Record<string, unknown> = {}) => ({ HasError: false, HasAbondon: false, ErrorCode: null, Message: 'İşlem başarılı', ...extra });
const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ HasError: true, HasAbondon: false, ErrorCode: code, Message: message, ...extra });

export async function startFakePavo(opts: { serial?: string; tls?: { key: string; cert: string } } = {}): Promise<FakePavo> {
  const serial = opts.serial ?? 'PAV860000001';
  let fingerprint: string | null = null;
  let lastSeq = 0;
  let busy = false;
  const waiting = new Map<string, (reply: Record<string, unknown>) => void>();
  /** Açık batch'in kart işlemleri (kuruş; iptal eksi) */
  let open: { amount: number; at: number }[] = [];

  /** Pavo'nun örnek yanıtındaki biçim (kart no ve işlem dökümü dahil: LafPOS bunları saklamamalı) */
  const closeBatch = (now = Date.now()) => {
    const batchNo = (device.batches.at(-1)?.batchNo ?? 277) + 1;
    const total = open.reduce((a, t) => a + t.amount, 0);
    const eodData = {
      isyeriSlipIsim: 'PAVO TEST',
      isyeriSlipAdres: 'PAVO TEST',
      tcKimlikNo: '11111111111',
      vergiNo: '1111111111',
      serialNo: serial,
      batchNo: pad(batchNo, 6),
      dateTime: deviceTime(now),
      acquirers: [
        {
          acquirerId: '1',
          acquirerName: 'Test Bankası',
          acquirerMerchantId: '000000000000002',
          acquirerTerminalId: '10002791',
          hasCard: 'true',
          cardTransactions: [
            {
              title: 'Test Bankası - Kart İşlemleri - TL',
              transactions: open.map((t, i) => ({
                operationName: t.amount < 0 ? 'Satış İptal' : 'Satış',
                transactionNo: pad(i + 1, 6),
                dateTime: deviceTime(t.at),
                amount: `${trAmount(Math.abs(t.amount))} TL`,
                cardNo: '4111 **** **** 8707 ',
                authorizationCode: pad(i + 2, 6),
                cardTitle: 'Yurt İçi VISA Kredi',
              })),
              summaries: [{ operationName: 'Satış', transactionCount: String(open.length), totalAmount: trAmount(total) }],
            },
          ],
          cardTotals: [{ currency: 'TL', transactionCount: String(open.length), totalAmount: `${trAmount(total)} TL` }],
          acquirerTotalCount: String(open.length),
          hasFast: 'false',
          fastTransactions: [],
          fastTotals: [],
          acquirerEodMessage: 'TechPOS Günsonu Mesajı',
        },
      ],
      grandTotals: [{ currency: 'TL', transactionCount: String(open.length), totalAmount: `${trAmount(total)} TL` }],
    };
    open = [];
    const batch = { batchNo, dateTime: eodData.dateTime, eodData };
    device.batches.push(batch);
    return batch;
  };

  const device: FakePavo = {
    url: '',
    serial,
    sales: new Map(),
    requests: [],
    nextSaleReply: null,
    silent: false,
    eodMode: 'ok',
    eodDelayMs: 0,
    eodCopyReply: null,
    pingHttpStatus: null,
    mediatorsData: [{ Mediator: 1, Name: 'Nakit' }, { Mediator: 2, Name: 'Kredi Kartı' }],
    batches: [],
    addCardTransaction(amount) {
      open.push({ amount: Math.round(amount * 100), at: Date.now() });
    },
    menuEod(agoMs = 0) {
      closeBatch(Date.now() - agoMs);
    },
    pay(orderNo, payments, doc) {
      const sale = device.sales.get(orderNo)!;
      sale.state = 'paid';
      sale.record = {
        OrderNo: orderNo,
        SaleNumber: 'S-1',
        StatusId: 3,
        TotalPrice: sale.body.TotalPrice,
        AddedPayments: payments.map((p, i) => ({ Id: i + 1, StatusId: p.status ?? 2, PaymentAmount: p.amount, PaymentTypeId: p.type, PaymentMediatorId: p.type })),
        FinancialDocuments: doc ? [{ Id: 1, InvoiceNo: doc.invoiceNo, DocumentNo: 'D1', Type: { Id: 1, Name: doc.typeName ?? 'e-Arşiv Fatura', Cancellable: true } }] : [],
      };
      // Kartla alınan etkin ödemeler bankanın açık batch'ine girer (gün sonunda toplanır)
      for (const p of payments) if (p.type === 2 && (p.status ?? 2) === 2) open.push({ amount: Math.round(p.amount * 100), at: Date.now() });
      waiting.get(orderNo)?.(ok({ Data: sale.record }));
    },
    abandon(orderNo) {
      device.sales.get(orderNo)!.state = 'abandoned';
      waiting.get(orderNo)?.({ HasError: true, HasAbondon: true, ErrorCode: '1001', Message: 'İşlem kullanıcı tarafından iptal edildi' });
    },
    reject(orderNo, code, message) {
      device.sales.get(orderNo)!.state = 'failed';
      waiting.get(orderNo)?.(err(code, message));
    },
    async close() {
      for (const done of waiting.values()) done(err('0', 'kapandı'));
      await new Promise<void>((r) => server.close(() => r()));
    },
  };

  const read = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>));
    });
  const send = (res: ServerResponse, body: Record<string, unknown>) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const body = await read(req);
    const path = req.url ?? '';
    device.requests.push({ path, body });
    if (device.silent) return; // yanıt yok
    if (req.method !== 'POST') return send(res, err('405', 'Yalnız POST'));
    if (busy) return send(res, err('9001', 'Cihaz meşgul'));
    if (path === '/Ping' && device.pingHttpStatus) {
      res.writeHead(device.pingHttpStatus);
      return res.end();
    }
    const h = (body.TransactionHandle ?? {}) as { SerialNumber?: string; Fingerprint?: string; TransactionSequence?: number; TransactionDate?: string };
    if (h.SerialNumber !== serial) return send(res, err('2001', 'Seri numarası eşleşmiyor'));
    const at = Date.parse(h.TransactionDate ?? '');
    if (!Number.isFinite(at) || Math.abs(at - Date.now()) > 300_000) return send(res, err('2002', 'İşlem tarihi geçersiz'));
    if (path === '/Ping') return send(res, ok({ Message: 'Pong' }));
    if (path === '/Pairing') {
      fingerprint = h.Fingerprint ?? null;
      lastSeq = h.TransactionSequence ?? 0;
      return send(res, ok({ Message: 'Eşleştirme başarılı' }));
    }
    if (!fingerprint || h.Fingerprint !== fingerprint) return send(res, err('2003', 'Eşleştirme bulunamadı'));
    if (typeof h.TransactionSequence !== 'number' || h.TransactionSequence <= lastSeq) return send(res, err('2004', 'İşlem sıra numarası geçersiz'));
    lastSeq = h.TransactionSequence;

    if (path === '/PaymentMediators') return send(res, ok({ Data: device.mediatorsData }));
    if (path === '/CompleteSale') {
      const sale = body.Sale as Record<string, unknown>;
      const orderNo = String(sale.OrderNo);
      device.sales.set(orderNo, { orderNo, body: sale, state: 'open' });
      if (device.nextSaleReply) {
        const reply = device.nextSaleReply;
        device.nextSaleReply = null;
        if (reply.HasError) device.sales.get(orderNo)!.state = 'failed';
        return send(res, reply);
      }
      busy = true;
      waiting.set(orderNo, (reply) => {
        waiting.delete(orderNo);
        busy = false;
        send(res, reply);
      });
      return;
    }
    if (path === '/GetSaleResult') {
      const orderNo = String((body.Sale as { OrderNo?: string } | undefined)?.OrderNo ?? '');
      const sale = device.sales.get(orderNo);
      if (!sale) return send(res, err('3001', 'Satış bulunamadı'));
      if (sale.state === 'paid') return send(res, ok({ Data: sale.record }));
      if (sale.state === 'abandoned') return send(res, { HasError: true, HasAbondon: true, ErrorCode: '1001', Message: 'İptal edildi' });
      if (sale.state === 'failed') return send(res, err('3002', 'Satış başarısız'));
      return send(res, ok({ Data: { OrderNo: orderNo, StatusId: 1 } }));
    }
    if (path === '/PerformEOD') {
      if (device.eodMode === 'fail') return send(res, { HasAbondon: false, HasError: true, ErrorCode: 5085, Message: 'Günsonu alınamadı', Data: null });
      if (device.eodMode === 'drop') return; // istek işlenmedi: gün sonu yok, yanıt yok
      const batch = closeBatch();
      if (device.eodMode === 'silent') return; // gün sonu alındı ama yanıt gelmiyor
      const reply = ok({ Message: null, Data: { gunSonu: 'Günsonu Tamamlandı', eodData: batch.eodData, eodJson: [], eodText: [], eodImage: '' } });
      if (device.eodDelayMs > 0) return void setTimeout(() => send(res, reply), device.eodDelayMs);
      return send(res, reply);
    }
    if (path === '/PrintEODCopy' && device.eodCopyReply === 'http404') {
      res.writeHead(404);
      return res.end();
    }
    if (path === '/PrintEODCopy' && device.eodCopyReply && device.eodCopyReply !== 'http404') return send(res, device.eodCopyReply);
    if (path === '/PrintEODCopy') {
      const want = (body.EODCopy as { batchNo?: number } | undefined)?.batchNo;
      const batch = want == null ? device.batches.at(-1) : device.batches.find((b) => b.batchNo === want);
      if (!batch) return send(res, err('5075', 'Batch bulunamadı.'));
      return send(res, ok({ Message: null, Data: { printEODCopyResultMessage: 'Başarılı', eodData: batch.eodData, eodJson: [], eodText: [], eodImage: '' } }));
    }
    return send(res, err('404', 'Bilinmeyen uç'));
  };

  const server: Server = opts.tls ? createHttps({ key: opts.tls.key, cert: opts.tls.cert }, (q, r) => void handler(q, r)) : createHttp((q, r) => void handler(q, r));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  device.url = `${opts.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return device;
}
