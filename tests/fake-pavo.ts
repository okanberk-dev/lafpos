import { createServer as createHttp, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import type { AddressInfo } from 'node:net';

/**
 * Testler için sahte Pavo cihazı (yerel ağ REST). Pavo'nun REST sayfasındaki kurallarla: seri no aynı olmalı,
 * parmak izi eşleştirmedekiyle aynı olmalı, sıra no öncekinden kesin büyük olmalı, tarih ±300 sn içinde olmalı;
 * `/Ping` ve `/Pairing` muaf. Aynı anda tek istek: ikinci istek "meşgul" hatası alır. `/CompleteSale` kasiyer
 * cihazda bitirene kadar (testte `pay`, `abandon`, `reject`) açık kalır. Satış kaydı Pavo'nun satış biçiminde
 * (AddedPayments, FinancialDocuments).
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
  close(): Promise<void>;
}

const ok = (extra: Record<string, unknown> = {}) => ({ HasError: false, HasAbondon: false, ErrorCode: null, Message: 'İşlem başarılı', ...extra });
const err = (code: string, message: string, extra: Record<string, unknown> = {}) => ({ HasError: true, HasAbondon: false, ErrorCode: code, Message: message, ...extra });

export async function startFakePavo(opts: { serial?: string; tls?: { key: string; cert: string } } = {}): Promise<FakePavo> {
  const serial = opts.serial ?? 'PAV860000001';
  let fingerprint: string | null = null;
  let lastSeq = 0;
  let busy = false;
  const waiting = new Map<string, (reply: Record<string, unknown>) => void>();

  const device: FakePavo = {
    url: '',
    serial,
    sales: new Map(),
    requests: [],
    nextSaleReply: null,
    silent: false,
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

    if (path === '/PaymentMediators') return send(res, ok({ Data: [{ Mediator: 1, Name: 'Nakit' }, { Mediator: 2, Name: 'Kredi Kartı' }] }));
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
    return send(res, err('404', 'Bilinmeyen uç'));
  };

  const server: Server = opts.tls ? createHttps({ key: opts.tls.key, cert: opts.tls.cert }, (q, r) => void handler(q, r)) : createHttp((q, r) => void handler(q, r));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  device.url = `${opts.tls ? 'https' : 'http'}://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return device;
}
