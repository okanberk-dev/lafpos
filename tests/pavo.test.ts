import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { PavoClient, PavoError, type PavoStore } from '../server/okc/pavo';
import { eodAfter, eodCopyUnavailable, eodSummary, eodTimeMs, pavoOrderNo, pavoSale, pavoTiming, readEod, readEodBaseline, readSale } from '../server/okc/providers/pavo';
import { type FakePavo, startFakePavo } from './fake-pavo';
import { type Harness, startApp } from './harness';

/**
 * Pavo (N86) yerel ağ bağlantısı: satışın Pavo biçimine çevrilmesi, cihaz yanıtının okunması ve sahte cihazla
 * uçtan uca akış (eşleştirme, gönderme, ödeme, vazgeçme, ret, iptal). Sahte cihaz Pavo'nun REST kurallarını uygular.
 */

describe('sepet → Pavo satışı', () => {
  it('tutarlar TL ve KDV dahil; KDV grubu orandan; indirim adede bölünmüyorsa satır ikiye ayrılır, toplam kuruşu kuruşuna aynı', () => {
    const sale = pavoSale(
      {
        basketID: 'b',
        items: [
          { name: 'Latte', price: 12000, sectionNo: 1, taxPercent: 1000, quantity: 3000, adjust: { description: 'İndirim', discountOrSurcharge: 0, type: 0, totalValue: 1000 } },
          { name: 'Su', price: 2000, sectionNo: 2, taxPercent: 2000, quantity: 1000 },
        ],
      },
      'LP0001',
    );
    // 3 × 120 TL - 10 TL = 350 TL: 2 × 116,66 + 1 × 116,68
    expect(sale.AddedSaleItems).toEqual([
      { Name: 'Latte', IsGeneric: false, UnitCode: 'C62', TaxGroupCode: 'KDV10', ItemQuantity: 2, UnitPriceAmount: 116.66, GrossPriceAmount: 233.32, TotalPriceAmount: 233.32 },
      { Name: 'Latte', IsGeneric: false, UnitCode: 'C62', TaxGroupCode: 'KDV10', ItemQuantity: 1, UnitPriceAmount: 116.68, GrossPriceAmount: 116.68, TotalPriceAmount: 116.68 },
      { Name: 'Su', IsGeneric: false, UnitCode: 'C62', TaxGroupCode: 'KDV20', ItemQuantity: 1, UnitPriceAmount: 20, GrossPriceAmount: 20, TotalPriceAmount: 20 },
    ]);
    expect(sale).toMatchObject({ OrderNo: 'LP0001', MainDocumentType: 1, GrossPrice: 370, TotalPrice: 370, CurrencyCode: 'TRY', RefererApp: 'LafPOS' });
    const lines = sale.AddedSaleItems.reduce((a, i) => a + Math.round(i.TotalPriceAmount * 100), 0);
    expect(lines).toBe(37000);
  });

  it('sipariş no sepetten tek anlamlı, 16 karakter', () => {
    expect(pavoOrderNo('0f8fad5b-d9cb-469f-a165-70867728950e')).toBe('LP0F8FAD5BD9CB46');
  });

  it('cihazın bilmediği KDV grubu (%0, %1) reddedilir; okunur mesajla', () => {
    const basket = (taxPercent: number) => ({ basketID: 'b', items: [{ name: 'Su', price: 2000, sectionNo: 1, taxPercent, quantity: 1000 }] });
    const e = (() => {
      try {
        pavoSale(basket(0), 'LP1');
      } catch (x) {
        return x;
      }
    })();
    expect(e).toBeInstanceOf(PavoError);
    expect((e as PavoError).message).toBe("%0 KDV'li kalem Pavo'ya gönderilemez (Su); ürünün KDV oranını düzeltin ya da hesabı kasadan alın");
    expect(() => pavoSale(basket(100), 'LP1')).toThrow("%1 KDV'li kalem");
    expect(pavoSale(basket(1000), 'LP1').AddedSaleItems[0]!.TaxGroupCode).toBe('KDV10');
  });
});

describe('banka gün sonu yanıtı → özet', () => {
  // Pavo'nun REST paketindeki örnek yanıt (PerformEODSuccessfulResponse.json), kısaltılmış
  const sample = {
    HasAbondon: false,
    HasError: false,
    ErrorCode: null,
    Message: null,
    Data: {
      gunSonu: 'Günsonu Tamamlandı',
      eodData: {
        isyeriSlipIsim: 'PAVO TEST',
        tcKimlikNo: '11111111111',
        vergiNo: '1111111111',
        serialNo: 'PAV60W636961',
        batchNo: '000278',
        dateTime: '12.06.2023 13:32',
        acquirers: [
          {
            acquirerId: '1',
            acquirerName: 'Test Bankası',
            acquirerMerchantId: '000000000000002',
            hasCard: 'true',
            cardTransactions: [
              {
                title: 'Test Bankası - Kart İşlemleri - TL',
                transactions: [
                  { operationName: 'Satış', amount: '7,22 TL', cardNo: '4111 **** **** 8707 ', authorizationCode: '000002' },
                  { operationName: 'Satış İptal', amount: '5,00 TL', cardNo: '4111 **** **** 8707 ', authorizationCode: '000007' },
                ],
                summaries: [
                  { operationName: 'Satış', transactionCount: '3', totalAmount: '7,22' },
                  { operationName: 'Satış İptal', transactionCount: '1', totalAmount: '-5,00' },
                ],
              },
            ],
            cardTotals: [{ currency: 'TL', transactionCount: '4', totalAmount: '2,22 TL' }],
            acquirerTotalCount: '4',
            hasFast: 'false',
            fastTransactions: [],
            fastTotals: [],
          },
          { acquirerName: 'Diğer Banka', cardTotals: [{ currency: 'TL', transactionCount: '2', totalAmount: '1.234,56 TL' }], acquirerTotalCount: '2' },
        ],
        grandTotals: [{ currency: 'TL', transactionCount: '6', totalAmount: '1.236,78 TL' }],
      },
      eodJson: [],
      eodText: [],
      eodImage: '',
    },
  };

  it('batch no, cihaz saati, genel toplam ve banka satırları kuruşa; kart no ve döküm alınmaz', () => {
    const r = readEod(sample);
    expect(r).toEqual({
      kind: 'ok',
      message: null,
      summary: {
        batchNo: '000278',
        deviceDateTime: '12.06.2023 13:32',
        grandTotalKurus: 123678,
        acquirers: [
          { name: 'Test Bankası', count: 4, totalKurus: 222 },
          { name: 'Diğer Banka', count: 2, totalKurus: 123456 },
        ],
      },
    });
    const text = JSON.stringify(r);
    for (const secret of ['cardNo', '4111', 'tcKimlikNo', '11111111111', 'vergiNo', 'authorizationCode', 'transactions']) expect(text).not.toContain(secret);
  });

  it('başarısız (5085), vazgeçilen, özetsiz yazıcı hatası (belirsiz) ayrılır; özeti olan yazıcı hatası alınmış sayılır', () => {
    expect(readEod({ HasAbondon: false, HasError: true, ErrorCode: 5085, Message: 'Günsonu alınamadı', Data: null })).toEqual({ kind: 'failed', code: '5085', message: 'Günsonu alınamadı (kod 5085)' });
    expect(readEod({ HasAbondon: true, HasError: true, ErrorCode: 5061, Message: 'İşlemden vazgeçildi' })).toMatchObject({ kind: 'failed' });
    expect(readEod({ HasError: true, ErrorCode: 5069, Message: 'Kağıt bitti. Yazdırma başarısız.' })).toMatchObject({ kind: 'unknown', code: '5069' });
    expect(readEod({ ...sample, HasError: true, ErrorCode: 5069, Message: 'Kağıt bitti' })).toMatchObject({ kind: 'ok', summary: { batchNo: '000278' } });
    expect(readEod({ HasError: false, HasAbondon: false, Data: { gunSonu: 'Günsonu Tamamlandı' } })).toMatchObject({ kind: 'ok', summary: null });
  });

  it('cihaz saati İstanbul saatidir (UTC+3)', () => {
    expect(eodTimeMs('12.06.2023 13:32')).toBe(Date.UTC(2023, 5, 12, 10, 32));
    expect(eodTimeMs('')).toBeNull();
    expect(eodSummary(null)).toBeNull();
  });

  it('taban: gün sonundan hemen önce cihazın son gün sonu; kayıtlı gün sonu yoksa boş, özetsiz yanıtta LafPOS’unkine düşülür', () => {
    expect(readEodBaseline(sample)).toEqual({ prevBatchNo: '000278', prevBatchFrom: 'cihaz' });
    expect(readEodBaseline({ HasError: true, ErrorCode: '5075', Message: 'Batch bulunamadı.' })).toEqual({ prevBatchNo: null, prevBatchFrom: 'bos' });
    expect(readEodBaseline({ HasError: true, ErrorCode: '404', Message: 'Bilinmeyen uç' })).toBeNull();
    expect(readEodBaseline({ HasError: false, Data: {} })).toBeNull();
  });

  it('cihazdaki gün sonu bu denemenin sonucu mu: batch tabandan büyük ve cihaz saati denemeden 6 dk’dan eski değil', () => {
    const at = Date.UTC(2026, 10, 20, 20, 0); // 23:00 İstanbul
    const attempt = { at, prevBatchNo: '000280', prevBatchFrom: 'lafpos' as const };
    expect(eodAfter({ batchNo: '000281', deviceDateTime: '20.11.2026 23:01' }, attempt)).toBe(true);
    expect(eodAfter({ batchNo: '000281', deviceDateTime: '20.11.2026 22:55' }, attempt)).toBe(true);
    // Cihazın menüsünden 20 dk önce alınmış gün sonu: batch LafPOS'un bildiğinden büyük ama bu deneme değil
    expect(eodAfter({ batchNo: '000281', deviceDateTime: '20.11.2026 22:40' }, attempt)).toBe(false);
    expect(eodAfter({ batchNo: '000280', deviceDateTime: '20.11.2026 23:01' }, attempt)).toBe(false);
    // Saat okunamıyorsa batch no; batch no da bilinmiyorsa karar verilemez (alınmamış sayılır)
    expect(eodAfter({ batchNo: '000281', deviceDateTime: null }, attempt)).toBe(true);
    expect(eodAfter({ batchNo: '000281', deviceDateTime: null }, { at, prevBatchNo: null })).toBe(false);
    expect(eodAfter({ batchNo: '000281', deviceDateTime: '20.11.2026 23:01' }, { at, prevBatchNo: null })).toBe(true);
    // Deneme öncesinde cihazda gün sonu yoktu: her yeni gün sonu sonradır (saat yine denetlenir)
    expect(eodAfter({ batchNo: '000001', deviceDateTime: '20.11.2026 23:02' }, { at, prevBatchNo: null, prevBatchFrom: 'bos' })).toBe(true);
    expect(eodAfter({ batchNo: '000001', deviceDateTime: '20.11.2026 21:00' }, { at, prevBatchNo: null, prevBatchFrom: 'bos' })).toBe(false);
  });
});

describe('cihaz yanıtı → sonuç', () => {
  const record = (payments: unknown[], docs: unknown[] = []) => ({ HasError: false, Data: { OrderNo: 'X', AddedPayments: payments, FinancialDocuments: docs } });

  it('ödendi: etkin ödemeler (StatusId 2) kuruşa, belge no e-Arşiv; iptal edilen deneme sayılmaz', () => {
    const r = readSale(
      record(
        [
          { StatusId: 2, PaymentAmount: 60.5, PaymentTypeId: 2 },
          { StatusId: 4, PaymentAmount: 60.5, PaymentTypeId: 2 },
          { StatusId: 2, PaymentAmount: 39.5, PaymentTypeId: 1 },
        ],
        [{ InvoiceNo: 'LAF2026000000007', Type: { Name: 'e-Arşiv Fatura' } }],
      ),
    );
    expect(r.kind).toBe('paid');
    if (r.kind !== 'paid') return;
    expect(r.result).toMatchObject({ status: 'paid', docKind: 'e_arsiv', docId: 'LAF2026000000007' });
    expect(r.result.payments.map((p) => [p.kind, p.amount])).toEqual([
      ['kart', 6050],
      ['nakit', 3950],
    ]);
  });

  it('belge türü adından: e-Fatura, bilgi fişi', () => {
    const doc = (name: string) => readSale(record([{ StatusId: 2, PaymentAmount: 1, PaymentTypeId: 1 }], [{ InvoiceNo: 'A', Type: { Name: name } }]));
    expect(doc('e-Fatura')).toMatchObject({ result: { docKind: 'e_fatura' } });
    expect(doc('Bilgi Fişi')).toMatchObject({ result: { docKind: 'bilgi_fisi' } });
  });

  it('anlamı bilinmeyen ödeme tipi tahminle işlenmez: belge var, ödeme yok (eksik ödeme, yönetici alır)', () => {
    const r = readSale(record([{ StatusId: 2, PaymentAmount: 100, PaymentTypeId: 7 }]));
    expect(r).toMatchObject({ kind: 'paid', result: { status: 'paid', payments: [] } });
  });

  it('vazgeçildi, başarısız ve açık (satış kaydı yok) ayrılır', () => {
    expect(readSale({ HasError: true, HasAbondon: true, ErrorCode: '1001', Message: 'İptal' })).toMatchObject({ kind: 'cancelled', result: { status: 'cancelled' } });
    expect(readSale({ HasError: true, ErrorCode: '5001', Message: 'Kart reddedildi' })).toEqual({ kind: 'failed', message: 'Kart reddedildi (kod 5001)', code: '5001' });
    expect(readSale({ HasError: false, Message: 'Satış başlatıldı' })).toEqual({ kind: 'open' });
    expect(readSale({ HasError: false, Data: { Foo: 1 } })).toEqual({ kind: 'open' });
    // Hata dönse de ödeme alınmış belge ödendi sayılır (yazıcı hatası gibi)
    expect(readSale({ HasError: true, ErrorCode: '5070', Data: { AddedPayments: [{ StatusId: 2, PaymentAmount: 10, PaymentTypeId: 1 }] } })).toMatchObject({ kind: 'paid' });
  });
});

describe('akış (sahte cihaz)', () => {
  let device: FakePavo;
  let h: Harness;
  beforeAll(async () => {
    pavoTiming.sendWaitMs = 300;
    pavoTiming.askEveryMs = 0;
    device = await startFakePavo();
    h = await startApp({ PAVO_URL: device.url, PAVO_SERIAL: device.serial, PAVO_FINGERPRINT: 'LafPOS-test' });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  });
  afterAll(async () => {
    await device.close();
    h.cleanup();
  });

  const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
  const newOrder = async (qty = 2) => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty }] });
  };
  type Receipt = { id: string; status: string; amount: number; docKind: string | null; docId: string | null; error: string | null };
  const send = (o: OrderDTO) => h.call<{ receipt: Receipt; code?: string; error?: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
  const refresh = (id: string) => h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${id}/refresh`);
  const settle = () => new Promise((r) => setTimeout(r, 50));

  it('Pavo yalnız kasada ödeme: masada ödeme reddedilir, Pavo seçilince ödeme yeri kasaya döner', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'tokenx', mode: 'liste' });
    expect((await h.call('patron', 'PUT', '/okc/settings', { provider: 'pavo', mode: 'liste' })).status).toBe(409);
    const s = await h.ok<{ provider: string; mode: string; pavo: { configured: boolean; paired: boolean } }>('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
    expect(s).toMatchObject({ provider: 'pavo', mode: 'anlik', pavo: { configured: true, paired: false } });
  });

  it('eşleştirmeden önce deneme cihazın yanıt verdiğini ama eşleştirme gerektiğini söyler; eşleştirince ödeme araçları gelir', async () => {
    const before = await h.ok<{ ping: { ok: boolean }; paired: boolean; pairingHint: string | null }>('patron', 'POST', '/okc/test');
    expect(before).toMatchObject({ ping: { ok: true }, paired: false });
    expect(before.pairingHint).toContain('Eşleştirme');
    // Eşleştirme yalnız ayar yetkisiyle
    expect((await h.call('kasa', 'POST', '/okc/pair')).status).toBe(403);
    await h.ok('patron', 'POST', '/okc/pair');
    const after = await h.ok<{ paired: boolean; mediators: { id: number; name: string }[] }>('patron', 'POST', '/okc/test');
    expect(after).toMatchObject({ paired: true, mediators: [{ id: 1, name: 'Nakit' }, { id: 2, name: 'Kredi Kartı' }] });
    const status = await h.ok<{ pavo: { paired: boolean; exchanges: { path: string }[] } }>('patron', 'GET', '/okc/status');
    expect(status.pavo.paired).toBe(true);
    expect(status.pavo.exchanges.map((x) => x.path)).toContain('/Pairing');
  });

  it('satış cihaza gider; kasiyer kart ve nakitle öder; adisyon kapanır, belge no ödemede kalır', async () => {
    const o = await newOrder(2);
    const r = await send(o);
    expect(r.status).toBe(200);
    expect(r.json.receipt.status).toBe('gonderildi');
    const orderNo = pavoOrderNo(r.json.receipt.id);
    const sale = device.sales.get(orderNo)!;
    expect(sale.state).toBe('open');
    expect(Math.round(Number(sale.body.TotalPrice) * 100)).toBe(o.total);
    // Satış cihazın ekranındayken: sepet kilitli görünür, LafPOS'tan silinemez (cihazda vazgeçilir)
    expect((await refresh(r.json.receipt.id)).status).toBe('kilitli');
    const del = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/receipts/${r.json.receipt.id}/cancel`, {});
    expect(del.status).toBe(502);
    expect(del.json.error).toContain('cihazda vazgeçin');

    const card = Math.round(o.total * 0.6);
    device.pay(orderNo, [{ type: 2, amount: card / 100 }, { type: 1, amount: (o.total - card) / 100 }], { invoiceNo: 'LAF2026000000042' });
    await settle();
    const done = await refresh(r.json.receipt.id);
    expect(done).toMatchObject({ status: 'tamamlandi', docKind: 'e_arsiv', docId: 'LAF2026000000042' });
    const paid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(paid).toMatchObject({ status: 'kapali', paid: o.total });
    expect(paid.payments.map((p) => p.amount).sort((a, b) => a - b)).toEqual([o.total - card, card].sort((a, b) => a - b));
    expect(paid.payments[0]!.note).toBe('Yazarkasa e-Arşiv LAF2026000000042');
  });

  it('kasiyer cihazda vazgeçerse sepet kapanır, adisyon açık kalır ve yeniden gönderilebilir', async () => {
    const o = await newOrder(1);
    const r = await send(o);
    device.abandon(pavoOrderNo(r.json.receipt.id));
    await settle();
    expect((await refresh(r.json.receipt.id)).status).toBe('iptal');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    const again = await send(o);
    expect(again.status).toBe(200);
    device.pay(pavoOrderNo(again.json.receipt.id), [{ type: 1, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000043' });
    await settle();
    expect((await refresh(again.json.receipt.id)).status).toBe('tamamlandi');
  });

  it('cihaz satışı hemen reddederse kasiyer hatayı görür, sepet hataya düşer, adisyon kilitli kalmaz', async () => {
    const o = await newOrder(1);
    device.nextSaleReply = { HasError: true, HasAbondon: false, ErrorCode: '4012', Message: 'Vergi grubu bulunamadı' };
    const r = await send(o);
    expect(r.status).toBe(502);
    expect(r.json).toMatchObject({ code: 'pavo_send' });
    expect(r.json.error).toContain('Vergi grubu bulunamadı');
    const [receipt] = await h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${o.id}/receipts`);
    expect(receipt!.status).toBe('hata');
    // Adisyon kasadan alınabilir
    const methods = h.boot.paymentMethods;
    const cash = methods.find((m) => m.kind === 'nakit')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total });
  });

  it('tanınmayan "başarılı" yanıt ödendi sayılmaz: sonuç sorulur, satış kaydı gelince işlenir', async () => {
    const o = await newOrder(1);
    device.nextSaleReply = { HasError: false, Message: 'Satış alındı', Data: { Foo: 1 } };
    const r = await send(o);
    expect(r.status).toBe(200);
    await settle();
    expect((await refresh(r.json.receipt.id)).status).toBe('gonderildi');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    device.pay(pavoOrderNo(r.json.receipt.id), [{ type: 2, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000044' });
    expect((await refresh(r.json.receipt.id)).status).toBe('tamamlandi');
  });

  it('belgelenmemiş ödeme tipi: ödeme işlenmez, sepet eksik ödenmiş hatası ve alarm; kalemler yeniden gönderilmez', async () => {
    const o = await newOrder(1);
    const r = await send(o);
    device.pay(pavoOrderNo(r.json.receipt.id), [{ type: 7, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000045' });
    await settle();
    const after = await refresh(r.json.receipt.id);
    expect(after.status).toBe('hata');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
    expect((await send(o)).json).toMatchObject({ code: 'okc_unresolved' });
  });

  it('cihaza ulaşılamazsa elle yenileme okunur hata döner (beklenmeyen hata değil), sepet beklemede kalır', async () => {
    const o = await newOrder(1);
    device.nextSaleReply = { HasError: false, Message: 'Satış alındı' };
    const r = await send(o);
    expect(r.status).toBe(200);
    await settle();
    const { pavo } = await import('../server/okc/providers/pavo');
    const client = pavo()!;
    const url = client.cfg.url;
    client.cfg.url = 'http://127.0.0.1:9';
    try {
      const res = await h.call<{ code: string; error: string }>('kasa', 'POST', `/okc/receipts/${r.json.receipt.id}/refresh`);
      expect(res.status).toBe(502);
      expect(res.json.code).toBe('pavo_device');
    } finally {
      client.cfg.url = url;
    }
    device.pay(pavoOrderNo(r.json.receipt.id), [{ type: 1, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000046' });
    expect((await refresh(r.json.receipt.id)).status).toBe('tamamlandi');
  });

  it('satış hatayla biterken cihazda gün sonu sürüyorsa belge sorgusu gün sonunun arkasına kuyruğa girmez; bitince sorulur', async () => {
    const { pavo } = await import('../server/okc/providers/pavo');
    const client = pavo()!;
    const o = await newOrder(1);
    const r = await send(o);
    expect(r.status).toBe(200);
    const orderNo = pavoOrderNo(r.json.receipt.id);
    const asked = () => device.requests.filter((q) => q.path === '/GetSaleResult' && (q.body.Sale as { OrderNo?: string }).OrderNo === orderNo).length;
    const before = asked();
    // Cihaz satışı reddeder ve hemen gün sonuna geçer (meşgul işareti gün sonu): yanıt saklanır, sepet bekler
    client.busyWith = 'GUNSONU';
    try {
      device.reject(orderNo, '5001', 'Kart reddedildi');
      await settle();
      expect((await refresh(r.json.receipt.id)).status).toBe('gonderildi');
      await settle();
      expect(asked()).toBe(before);
    } finally {
      client.busyWith = null;
    }
    // Gün sonu bitti: belge kesilip kesilmediği bir kez sorulur, kesilmediği için sepet vazgeçilmiş olur
    expect((await refresh(r.json.receipt.id)).status).toBe('iptal');
    expect(asked()).toBe(before + 1);
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
  });

  it('her istekte sıra no öncekinden büyük, seri no ve kimlik aynı (cihaz aksini reddeder)', () => {
    const handles = device.requests.map((q) => q.body.TransactionHandle as { TransactionSequence: number; SerialNumber: string; Fingerprint: string });
    const afterPair = handles.slice(device.requests.findIndex((q) => q.path === '/Pairing'));
    const seqs = afterPair.filter((_, i) => device.requests[device.requests.length - afterPair.length + i]!.path !== '/Ping').map((x) => x.TransactionSequence);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(new Set(handles.map((x) => x.SerialNumber))).toEqual(new Set([device.serial]));
    expect(new Set(afterPair.map((x) => x.Fingerprint))).toEqual(new Set(['LafPOS-test']));
  });

  describe('banka gün sonu', () => {
    type Batch = { batchNo: string | null; grandTotalKurus: number | null; dayClosed: boolean };
    type Eod = {
      at: number;
      dayId: string | null;
      trigger: string;
      status: 'ok' | 'failed' | 'unknown' | 'running' | 'skipped';
      batchNo: string | null;
      deviceDateTime: string | null;
      grandTotalKurus: number | null;
      dayCardKurus: number | null;
      dayCardSinceBatch?: string | null;
      earlier: Batch[];
      acquirers: { name: string; count: number | null; totalKurus: number | null }[];
      errorCode: string | null;
      message: string | null;
      prevBatchNo: string | null;
      prevBatchFrom?: string;
      amountsHidden: boolean;
    };
    type PavoStatus = { busy: string | null; eod: Eod | null };
    type Day = { id: string; closedAt: number | null };
    let mods: {
      db: typeof import('../server/db/client').db;
      schema: typeof import('../server/db/client').schema;
      eq: typeof import('drizzle-orm').eq;
      getSyncState: typeof import('../server/lib/settings').getSyncState;
      setSyncState: typeof import('../server/lib/settings').setSyncState;
      recoverDeviceEod: typeof import('../server/okc/service').recoverDeviceEod;
    };
    beforeAll(async () => {
      // Gün sonunun yanıtı 3 dk yerine 1 sn, son gün sonunun bilgisi (taban ve doğrulama) 1 sn beklenir
      pavoTiming.eodMs = 1_000;
      pavoTiming.eodCopyMs = 1_000;
      const { db, schema } = await import('../server/db/client');
      const { eq } = await import('drizzle-orm');
      const { getSyncState, setSyncState, updateSettings } = await import('../server/lib/settings');
      const { recoverDeviceEod } = await import('../server/okc/service');
      mods = { db, schema, eq, getSyncState, setSyncState, recoverDeviceEod };
      // Kurulum (eğitim) modunda cihaz gün sonu alınmaz: gerçek kurulum gibi
      updateSettings({ demoMode: false });
    });

    const status = async (who = 'patron') => (await h.ok<{ pavo: PavoStatus; pavoAutoEod: boolean }>(who, 'GET', '/okc/status')).pavo;
    const waitStatus = async (ok: (s: PavoStatus) => boolean, what: string) => {
      const until = Date.now() + 4_000;
      for (;;) {
        const s = await status();
        if (ok(s)) return s;
        if (Date.now() > until) throw new Error(`${what} olmadı: ${JSON.stringify(s.eod)}`);
        await new Promise((r) => setTimeout(r, 15));
      }
    };
    const waitEod = async (since: number, want: Eod['status']) => (await waitStatus((s) => !!s.eod && s.eod.at >= since && s.eod.status === want, `gün sonu ${want}`)).eod!;
    const audits = () =>
      mods.db
        .select()
        .from(mods.schema.auditLog)
        .where(mods.eq(mods.schema.auditLog.action, 'okc.eod'))
        .all()
        .sort((a, b) => b.id - a.id);
    const eodRequests = () => device.requests.filter((q) => q.path === '/PerformEOD');
    const dayEod = (dayId: string) => mods.getSyncState<Eod>(`pavo.eod.${dayId}`);
    /** Açık adisyonlar nakitle kapatılır: gün sonu açık adisyonla alınmaz */
    const payOpen = async () => {
      const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
      const open = mods.db.select().from(mods.schema.orders).where(mods.eq(mods.schema.orders.status, 'acik')).all();
      for (const row of open) {
        const o = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${row.id}`);
        if (o.total - o.paid > 0) await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total - o.paid });
      }
    };
    const closeDay = async () => {
      await payOpen();
      return (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
    };
    const dayIsClosed = async () => (await h.ok<{ day: Day | null }>('mudur', 'GET', '/cash/day')).day === null;
    const reopen = (id: string) => h.ok('mudur', 'POST', `/cash/days/${id}/reopen`, { reason: 'Pavo gün sonu testi' });
    let pastDays = 0;
    /** Yeni iş günü: bir iş gününe tek Z, bugün kapanmış günler geçmiş tarihlere alınır, sonra gün açılır */
    const newDay = async () => {
      for (const d of mods.db.select().from(mods.schema.businessDays).all()) {
        if (!d.closedAt || d.date.startsWith('2020-')) continue;
        mods.db
          .update(mods.schema.businessDays)
          .set({ date: `2020-01-${String(++pastDays).padStart(2, '0')}` })
          .where(mods.eq(mods.schema.businessDays.id, d.id))
          .run();
      }
      return h.ok<Day>('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    };

    it("%0 KDV'li kalem cihaza gitmez: sepet kaydı yazılmadan okunur hata, adisyon kilitlenmez", async () => {
      const p = product('Türk Kahvesi');
      mods.db.update(mods.schema.products).set({ kdvRate: 0 }).where(mods.eq(mods.schema.products.id, p.id)).run();
      try {
        const o = await newOrder(1);
        const r = await send(o);
        expect(r.status).toBe(400);
        expect(r.json).toMatchObject({ code: 'okc_basket' });
        expect(r.json.error).toContain("%0 KDV'li kalem Pavo'ya gönderilemez");
        expect(await h.ok<Receipt[]>('kasa', 'GET', `/okc/orders/${o.id}/receipts`)).toEqual([]);
      } finally {
        mods.db.update(mods.schema.products).set({ kdvRate: p.kdvRate }).where(mods.eq(mods.schema.products.id, p.id)).run();
      }
    });

    it('gün kapanınca cihazda gün sonu alınır: özet saklanır (kart no yok), kart toplamı LafPOS ile aynı, slip istenmez', async () => {
      const before = eodRequests().length;
      const t0 = Date.now();
      const day = await closeDay();
      expect(day.closedAt).not.toBeNull();
      const eod = await waitEod(t0, 'ok');
      // Cihazda henüz gün sonu yoktu (taban "boş")
      expect(eod).toMatchObject({ dayId: day.id, trigger: 'otomatik', batchNo: '000278', errorCode: null, amountsHidden: false, earlier: [], prevBatchNo: null, prevBatchFrom: 'bos' });
      expect(eod.dayCardKurus).toBeGreaterThan(0);
      // Bu günün kart ödemelerinin hepsi cihazdan: bankanın batch'i LafPOS'un kart toplamıyla aynı
      expect(eod.grandTotalKurus).toBe(eod.dayCardKurus);
      expect(eod.dayCardSinceBatch).toBeNull();
      expect(eod.acquirers).toEqual([{ name: 'Test Bankası', count: 2, totalKurus: eod.dayCardKurus }]);
      expect(await dayIsClosed()).toBe(true);

      const [req] = eodRequests().slice(before);
      expect(req!.body.PerformEOD).toEqual({
        AdditionalInfo: { useSummary: true, print: false, receiptImage: false, receiptWidth: '58mm', printData: { receiptJsonEnabled: false, receiptTextEnabled: false } },
      });
      // Gönderimden hemen önce cihazın son gün sonu okunur (taban); slip basılmaz
      const at = device.requests.indexOf(req!);
      expect(device.requests[at - 1]).toMatchObject({ path: '/PrintEODCopy', body: { EODCopy: { useSummary: true, print: false, receiptImage: false } } });
      // Saklanan yalnız özet: kart no, işlem dökümü, işyeri bilgisi yok
      const stored = [mods.getSyncState('pavo.eod.last'), dayEod(day.id)];
      for (const s of stored) {
        expect(s).toMatchObject({ status: 'ok', batchNo: '000278' });
        const text = JSON.stringify(s);
        for (const secret of ['cardNo', '4111', 'transactions', 'tcKimlikNo', 'vergiNo', 'PAVO TEST', 'eodImage']) expect(text).not.toContain(secret);
      }
      expect(audits()[0]).toMatchObject({ severity: 'info', amount: eod.grandTotalKurus });
      expect(audits()[0]!.message).toContain('batch 000278');
    });

    it('yeniden açılıp kapanan gün için cihaz gün sonu kendiliğinden ikinci kez alınmaz; ilk batch saklı kalır, elle alınan ikincisi yalnız sonraki kart ödemeleriyle kıyaslanır', async () => {
      const first = mods.getSyncState<Eod>('pavo.eod.last')!;
      const dayId = first.dayId!;
      await reopen(dayId);
      // Yeniden açılan günde cihazdan kartla bir satış daha (bankanın yeni batch'ine girer)
      const o = await newOrder(1);
      const r = await send(o);
      device.pay(pavoOrderNo(r.json.receipt.id), [{ type: 2, amount: o.total / 100 }], { invoiceNo: 'LAF2026000000050' });
      await settle();
      expect((await refresh(r.json.receipt.id)).status).toBe('tamamlandi');
      const before = eodRequests().length;
      const lastAudit = audits()[0]!.id;
      const day = await closeDay();
      expect(day.id).toBe(dayId);
      await settle();
      // Aynı gün kimliğiyle ikinci /PerformEOD gitmez; bilgi kaydı düşer
      expect(eodRequests().length).toBe(before);
      const skip = audits()[0]!;
      expect(skip.id).toBeGreaterThan(lastAudit);
      expect(skip.severity).toBe('info');
      expect(skip.message).toContain('zaten alındı (batch 000278)');
      // Günün ve son sonucun kaydı ezilmez: batch 278 ve tutarları duruyor
      expect(dayEod(dayId)).toMatchObject({ status: 'ok', batchNo: '000278', grandTotalKurus: first.grandTotalKurus });
      expect((await status()).eod).toMatchObject({ status: 'ok', batchNo: '000278' });

      // Elle ikinci gün sonu: yeni batch yalnız yeniden açıldıktan sonraki kart satışını taşır ve LafPOS'ta da yalnız
      // önceki gün sonundan sonraki kart ödemeleriyle kıyaslanır (günün bütün kartıyla değil: yanlış "eksik" uyarısı yok)
      const manual = await h.ok<Eod>('patron', 'POST', '/okc/eod', {});
      expect(manual).toMatchObject({ status: 'ok', trigger: 'elle', dayId, batchNo: '000279', grandTotalKurus: o.total, dayCardKurus: o.total, dayCardSinceBatch: '000278', prevBatchNo: '000278' });
      expect(manual.earlier.map((b) => b.batchNo)).toEqual(['000278']);
      expect(audits()[0]).toMatchObject({ severity: 'info', amount: o.total });
      expect(audits()[0]!.message).not.toContain('eksik');
      // Günün kaydında iki batch de var: ilki tutarıyla saklı
      expect(dayEod(dayId)).toMatchObject({ status: 'ok', batchNo: '000279', earlier: [{ batchNo: '000278', grandTotalKurus: first.grandTotalKurus, dayClosed: true }] });
      // Kör kasa: önceki batch'lerin tutarı da gizli
      expect((await status('kasa')).eod).toMatchObject({ earlier: [{ batchNo: '000278', grandTotalKurus: null }] });
    });

    it('cihaz gün sonunu alamazsa (5085) LafPOS günü yine kapanır; alarm düşer, elle yeniden denenir', async () => {
      await newDay();
      device.eodMode = 'fail';
      const t0 = Date.now();
      const day = await closeDay();
      expect(day.closedAt).not.toBeNull();
      const eod = await waitEod(t0, 'failed');
      expect(eod).toMatchObject({ dayId: day.id, errorCode: '5085', batchNo: null, prevBatchNo: '000279', prevBatchFrom: 'cihaz' });
      expect(eod.message).toContain('Günsonu alınamadı');
      expect(audits()[0]).toMatchObject({ severity: 'alarm' });
      expect(await dayIsClosed()).toBe(true);

      // Elle yeniden deneme: yetki gün sonu yetkisi (garson alamaz). Cihazda LafPOS dışı bir kart işlemi var, bu günün
      // LafPOS kart toplamı 0: toplam farklı, uyarı düşer
      device.eodMode = 'ok';
      device.addCardTransaction(12.5);
      expect((await h.call('garson', 'POST', '/okc/eod', {})).status).toBe(403);
      const manual = await h.ok<Eod>('patron', 'POST', '/okc/eod', {});
      expect(manual).toMatchObject({ status: 'ok', trigger: 'elle', dayId: day.id, batchNo: '000280', grandTotalKurus: 1250, dayCardKurus: 0, dayCardSinceBatch: null, earlier: [] });
      expect(audits()[0]).toMatchObject({ severity: 'uyari' });
      expect(audits()[0]!.message).toContain('kart toplamından');
      expect(audits()[0]!.message).toContain('fazla');
      expect(await dayIsClosed()).toBe(true);
    });

    it('kör kasa: kasiyer gün sonunu görür ve alabilir ama tutarları görmez', async () => {
      const blind = await status('kasa');
      expect(blind.eod).toMatchObject({ status: 'ok', batchNo: '000280', grandTotalKurus: null, dayCardKurus: null, amountsHidden: true });
      expect(blind.eod!.acquirers.every((a) => a.totalKurus === null)).toBe(true);
      const verified = await h.ok<{ changed: boolean; device: { batchNo: string; grandTotalKurus: number | null } }>('kasa', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: false, device: { batchNo: '000280', grandTotalKurus: null } });
      // Doğrulama slip basmaz (Pavo'da bu ucun varsayılanı basmak)
      const copy = device.requests.filter((q) => q.path === '/PrintEODCopy').at(-1)!;
      expect(copy.body.EODCopy).toEqual({ useSummary: true, print: false, receiptImage: false });
      expect((await status('patron')).eod).toMatchObject({ grandTotalKurus: 1250, amountsHidden: false });
    });

    it('gün sonu sürerken cihaz satış almaz, sonuç "sürüyor" görünür; yanıt gelmezse sonuç belirsiz, yeniden deneme önce doğrulama ister', async () => {
      const open = await newDay();
      // Cihazın ekranında olmayan, sonucu beklenen bir sepet (satış alındı, kayıt henüz yok)
      const waiting = await newOrder(1);
      device.nextSaleReply = { HasError: false, Message: 'Satış alındı' };
      const pending = await send(waiting);
      expect(pending.status).toBe(200);
      await settle();
      // Gönderim sürerken sorgu döngüsü sepeti bir an kilitli görmüş olabilir: sonuç sorulunca kilit açılır
      expect((await refresh(pending.json.receipt.id)).status).toBe('gonderildi');
      device.eodMode = 'silent';
      const run = h.call<{ code: string; error: string }>('patron', 'POST', '/okc/eod', {});
      // Gönderimden önce "sürüyor" kaydı (taban cihazdan okundu): süreç bu sırada kapanırsa açılışta belirsiz olur
      const running = (await waitStatus((s) => s.eod?.status === 'running', 'sürüyor')).eod!;
      expect(running).toMatchObject({ trigger: 'elle', dayId: open.id, prevBatchNo: '000280', prevBatchFrom: 'cihaz' });
      expect(dayEod(open.id)).toMatchObject({ status: 'running' });
      expect((await status()).busy).toBe('GUNSONU');
      const o = await newOrder(1);
      const refused = await send(o);
      expect(refused.status).toBe(502);
      expect(refused.json.error).toContain('Cihazda gün sonu sürüyor');
      // Bekleyen sepet gün sonu sürerken iptal edilmez; "cihaza ulaşılamadı" diye zorla da iptal sayılmaz
      const cancel = await h.call<{ code: string; error: string }>('patron', 'POST', `/okc/receipts/${pending.json.receipt.id}/cancel`, { force: true });
      expect(cancel.status).toBe(409);
      expect(cancel.json).toMatchObject({ code: 'okc_busy' });
      expect(cancel.json.error).toContain('gün sonu sürüyor');
      expect((await refresh(pending.json.receipt.id)).status).toBe('gonderildi');
      const res = await run;
      expect(res.status).toBe(502);
      expect(res.json.code).toBe('pavo_eod_unknown');
      expect((await status()).eod).toMatchObject({ status: 'unknown', trigger: 'elle', batchNo: null });
      expect(audits()[0]).toMatchObject({ severity: 'alarm' });
      // Belirsiz sonucun üstüne ikinci gün sonu gönderilmez: önce doğrulama
      const again = await h.call<{ code: string }>('patron', 'POST', '/okc/eod', {});
      expect(again.status).toBe(409);
      expect(again.json.code).toBe('okc_eod_unknown');
      // Cihaz gün sonunu almıştı (yanıtı kayboldu): doğrulama sonucu "alındı" yapar, tutarlar cihazınkiyle
      const verified = await h.ok<{ changed: boolean; record: Eod }>('patron', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: true, record: { status: 'ok', batchNo: '000281', grandTotalKurus: 0, dayId: open.id } });
      expect(audits()[0]!.message).toContain('doğrulandı');
      device.eodMode = 'ok';
      // Gün sonu bitti: bekleyen sepet yine sorgulanır, cihazda ödenince işlenir
      device.pay(pavoOrderNo(pending.json.receipt.id), [{ type: 1, amount: waiting.total / 100 }], { invoiceNo: 'LAF2026000000047' });
      expect((await refresh(pending.json.receipt.id)).status).toBe('tamamlandi');
    });

    it('gün kapanırken cihaz yanıt vermezse gün beklemeden kapanır ve kapalı kalır; sonuç belirsizken yeni gün sonu kendiliğinden gitmez, doğrulama çözer', async () => {
      // Açık gün içinde elle alınan gün sonu (281) kapanışın gün sonunu engellemez: sonraki kart işlemlerini kapatır
      device.eodMode = 'silent';
      const t0 = Date.now();
      const day = await closeDay();
      // Gün sonu yanıtı beklenmedi: gün kapalı, cihaz hâlâ gün sonunda
      expect(day.closedAt).not.toBeNull();
      expect((await status()).busy).toBe('GUNSONU');
      expect(await dayIsClosed()).toBe(true);
      const eod = await waitEod(t0, 'unknown');
      expect(eod).toMatchObject({ dayId: day.id, trigger: 'otomatik', earlier: [{ batchNo: '000281', dayClosed: false }] });
      expect(await dayIsClosed()).toBe(true);
      // Kendiliğinden yeniden denenmez
      const sent = eodRequests().length;
      await new Promise((r) => setTimeout(r, 600));
      expect(eodRequests().length).toBe(sent);
      // Sonuç belirsizken kapanan yeni günde de gün sonu gönderilmez: önce doğrulama
      await newDay();
      const next = await closeDay();
      await settle();
      expect(eodRequests().length).toBe(sent);
      expect(audits()[0]).toMatchObject({ severity: 'info' });
      expect(audits()[0]!.message).toContain('Doğrula');
      expect(dayEod(next.id)).toMatchObject({ status: 'skipped', errorCode: 'okc_eod_unknown' });
      expect((await status()).eod).toMatchObject({ status: 'unknown', dayId: day.id });

      device.eodMode = 'ok';
      const verified = await h.ok<{ changed: boolean; record: Eod }>('patron', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: true, record: { status: 'ok', batchNo: '000282', dayId: day.id, dayCardKurus: 0, dayCardSinceBatch: '000281' } });
      expect(dayEod(day.id)).toMatchObject({ status: 'ok', batchNo: '000282', earlier: [{ batchNo: '000281' }] });
    });

    it('doğrulama cihazda yeni gün sonu bulamazsa belirsiz sonuç "alınamadı" olur, yeniden denenebilir', async () => {
      await newDay();
      // Cihaz gün sonu isteğine yanıt vermedi ve gün sonunu da almadı (istek işlenmeden kaldı)
      device.eodMode = 'drop';
      const t0 = Date.now();
      const day = await closeDay();
      expect(await waitEod(t0, 'unknown')).toMatchObject({ prevBatchNo: '000282', prevBatchFrom: 'cihaz' });
      device.eodMode = 'ok';
      const verified = await h.ok<{ changed: boolean; record: Eod; message: string }>('patron', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: true, record: { status: 'failed', dayId: day.id } });
      expect(verified.message).toContain('alınmamış');
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', dayId: day.id, batchNo: '000283' });
    });

    it('cihazın menüsünden önceden alınan gün sonu bu denemenin sonucu sayılmaz: taban gönderimden hemen önce cihazdan okunur', async () => {
      // LafPOS'un bildiği son batch 283; kasiyer cihazın menüsünden gün sonu alır (284), LafPOS'a haber gitmez
      device.menuEod();
      await newDay();
      device.eodMode = 'drop';
      const t0 = Date.now();
      const day = await closeDay();
      // Taban LafPOS'un bildiği 283 değil, cihazın 284'ü: doğrulama 284'ü bu denemenin sonucu sanmaz
      expect(await waitEod(t0, 'unknown')).toMatchObject({ prevBatchNo: '000284', prevBatchFrom: 'cihaz' });
      device.eodMode = 'ok';
      const verified = await h.ok<{ changed: boolean; record: Eod; message: string }>('patron', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: true, record: { status: 'failed', dayId: day.id } });
      expect(verified.message).toContain('batch 000284');
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', dayId: day.id, batchNo: '000285' });
    });

    it('cihaz son gün sonunu vermezse (yanıt yok) gün sonu hiç gönderilmez: alınamadı, yeniden denenebilir', async () => {
      await newDay();
      const before = eodRequests().length;
      device.silent = true;
      let day: Day | null = null;
      try {
        const t0 = Date.now();
        day = await closeDay();
        const eod = await waitEod(t0, 'failed');
        expect(eod.message).toContain('gün sonu gönderilmedi');
        expect(eodRequests().length).toBe(before);
        expect(audits()[0]).toMatchObject({ severity: 'alarm' });
      } finally {
        device.silent = false;
      }
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', dayId: day!.id, batchNo: '000286' });
    });

    it('cihazda kayıtlı gün sonu yoksa (5075) belirsiz deneme alınmamış sayılır; elle yenisi o güne yazılır', async () => {
      await newDay();
      device.eodMode = 'drop';
      const t0 = Date.now();
      const day = await closeDay();
      await waitEod(t0, 'unknown');
      device.eodMode = 'ok';
      const saved = device.batches.splice(0);
      try {
        const verified = await h.ok<{ changed: boolean; record: Eod; message: string }>('patron', 'POST', '/okc/eod/verify', {});
        expect(verified).toMatchObject({ changed: true, record: { status: 'failed', dayId: day.id } });
        expect(verified.message).toContain('kayıtlı gün sonu yok');
        expect(audits()[0]).toMatchObject({ severity: 'uyari' });
      } finally {
        device.batches.push(...saved);
      }
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', trigger: 'elle', dayId: day.id, batchNo: '000287' });
      expect(dayEod(day.id)).toMatchObject({ status: 'ok', batchNo: '000287' });
    });

    it('"Gün kapanınca cihazda gün sonu al" kapalıysa gün sonu atlanır (bilgi kaydıyla); elle alınabilir', async () => {
      const s = await h.ok<{ pavoAutoEod: boolean }>('patron', 'PUT', '/okc/settings', { pavoAutoEod: false });
      expect(s.pavoAutoEod).toBe(false);
      await newDay();
      const before = eodRequests().length;
      const t0 = Date.now();
      await closeDay();
      const eod = await waitEod(t0, 'skipped');
      expect(eod.message).toContain('kapalı');
      expect(audits()[0]).toMatchObject({ severity: 'info' });
      expect(eodRequests().length).toBe(before);
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', batchNo: '000288' });
      await h.ok('patron', 'PUT', '/okc/settings', { pavoAutoEod: true });
    });

    it('süreç gün sonu sürerken kapanırsa "sürüyor" kaydı açılışta belirsiz olur, alarm düşer; doğrulanmadan yenisi alınmaz', async () => {
      // Önce bir gün sonu yanıtı gecikerek gelir: süre boyunca "sürüyor", bitince "alındı"
      device.eodDelayMs = 300;
      const run = h.ok<Eod>('patron', 'POST', '/okc/eod', {});
      const running = (await waitStatus((s) => s.eod?.status === 'running', 'sürüyor')).eod!;
      expect(running).toMatchObject({ trigger: 'elle', prevBatchNo: '000288', prevBatchFrom: 'cihaz', batchNo: null });
      const done = await run;
      device.eodDelayMs = 0;
      expect(done).toMatchObject({ status: 'ok', batchNo: '000289', dayId: running.dayId });
      expect(dayEod(done.dayId!)).toMatchObject({ status: 'ok', batchNo: '000289' });

      // Süreç gün sonu sürerken kapandı: kayıt "sürüyor" kaldı (cihaz bu kez gün sonunu almadı)
      const orphan: Eod = { ...done, status: 'running', at: Date.now(), batchNo: null, deviceDateTime: null, grandTotalKurus: null, acquirers: [], prevBatchNo: '000289', prevBatchFrom: 'cihaz', message: 'Cihazda gün sonu sürüyor' };
      mods.setSyncState('pavo.eod.last', orphan);
      mods.setSyncState(`pavo.eod.${orphan.dayId}`, orphan);
      // Açılış temizlemeden de "sürüyor" kaydının üstüne gün sonu gönderilmez (cihaz meşgul değil)
      const before = eodRequests().length;
      expect((await h.call<{ code: string }>('patron', 'POST', '/okc/eod', {})).json).toMatchObject({ code: 'okc_eod_unknown' });
      mods.recoverDeviceEod();
      expect((await status()).eod).toMatchObject({ status: 'unknown', dayId: orphan.dayId });
      expect(dayEod(orphan.dayId!)).toMatchObject({ status: 'unknown' });
      expect(audits()[0]).toMatchObject({ severity: 'alarm' });
      expect(audits()[0]!.message).toContain('LafPOS kapandı');
      // İkinci açılış bir şey değiştirmez
      const n = audits().length;
      mods.recoverDeviceEod();
      expect(audits().length).toBe(n);
      expect((await h.call<{ code: string }>('patron', 'POST', '/okc/eod', {})).json).toMatchObject({ code: 'okc_eod_unknown' });
      expect(eodRequests().length).toBe(before);
      // Doğrulama: cihazdaki son gün sonu tabanla aynı, gün sonu alınmamış
      const verified = await h.ok<{ changed: boolean; record: Eod }>('patron', 'POST', '/okc/eod/verify', {});
      expect(verified).toMatchObject({ changed: true, record: { status: 'failed' } });
    });

    type Okc = { lastError: { message: string } | null; pavo: PavoStatus };
    const okc = () => h.ok<Okc>('patron', 'GET', '/okc/status');

    it('sahada: cihaz son gün sonunun kopyasını vermezse (HTTP 404, gövdesiz) gün sonu yine alınır; taban LafPOS’un bildiği batch, eski hata silinir', async () => {
      mods.setSyncState('okc.lastError', { message: 'Cihaz gün sonu: Cihazdan tanınmayan yanıt (HTTP 404)', at: Date.now() - 60_000 });
      device.eodCopyReply = 'http404';
      try {
        const known = mods.getSyncState<string>('pavo.eod.batch');
        const before = eodRequests().length;
        const rec = await h.ok<Eod>('patron', 'POST', '/okc/eod', {});
        expect(rec).toMatchObject({ status: 'ok', prevBatchNo: known, prevBatchFrom: 'lafpos' });
        expect(eodRequests().length).toBe(before + 1);
        expect((await okc()).lastError).toBeNull();
        // Doğrulama kopyasız yapılamaz: okunur ret, beklenmeyen hata değil
        const v = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/eod/verify', {});
        expect(v.status).toBe(502);
        expect(v.json.code).toBe('pavo_eod_nocopy');
        expect(v.json.error).toContain('cihazın kendi menüsünden');
      } finally {
        device.eodCopyReply = null;
      }
    });

    it('cihaz kopya ucunda iç hata verirse (HTTP 500) gün sonu gönderilmez; 405 ve 501 kopya yok sayılır', async () => {
      expect(eodCopyUnavailable(new PavoError('x', 'HTTP_500', true))).toBe(false);
      expect(eodCopyUnavailable(new PavoError('x', 'HTTP_503', true))).toBe(false);
      expect(eodCopyUnavailable(new PavoError('x', 'HTTP_400', true))).toBe(false);
      for (const code of ['HTTP_404', 'HTTP_405', 'HTTP_501', 'HTTP_200', 'HTTP_204']) expect(eodCopyUnavailable(new PavoError('x', code, true))).toBe(true);
      expect(eodCopyUnavailable(new PavoError('x', null, true))).toBe(false);
      device.eodCopyReply = 'http500';
      try {
        const before = eodRequests().length;
        const r = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/eod', {});
        expect(r.status).toBe(502);
        expect(eodRequests().length).toBe(before);
      } finally {
        device.eodCopyReply = null;
      }
    });

    it('cihaz başka programla eşleşmişse (73, 74) gün sonu gönderilmez, açık Türkçe mesaj; yeniden eşleştirince "Son hata" kalkar', async () => {
      for (const code of ['74', '73']) {
        device.eodCopyReply = { HasError: true, HasAbondon: false, ErrorCode: code, Message: code === '74' ? 'FingerPrint mismatch' : 'Sequence error', Data: null };
        const before = eodRequests().length;
        const r = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/eod', {});
        expect(r.status).toBe(502);
        expect(r.json.error).toContain('başka bir programla eşleştirilmiş');
        expect(r.json.error).toContain('Eşleştir');
        expect(eodRequests().length).toBe(before);
        expect((await okc()).lastError?.message).toContain('başka bir programla eşleştirilmiş');
      }
      const v = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/eod/verify', {});
      expect(v.json).toMatchObject({ code: 'pavo_pairing' });
      device.eodCopyReply = null;
      await h.ok('patron', 'POST', '/okc/pair');
      expect((await okc()).lastError).toBeNull();
      expect(await h.ok<Eod>('patron', 'POST', '/okc/eod', {})).toMatchObject({ status: 'ok', prevBatchFrom: 'cihaz' });
    });
  });

  it('bağlantı denemesi ödeme araçlarının adlarını getirir: liste Data’da, Data içinde ya da küçük harfli alanlarla', async () => {
    const names = async () => (await h.ok<{ mediators: { id: number | null; name: string | null }[]; mediatorsNote: string | null }>('patron', 'POST', '/okc/test'));
    try {
      device.mediatorsData = { PaymentMediators: [{ PaymentMediatorId: 1, PaymentMediatorName: 'NAKİT' }, { PaymentMediatorId: 3, PaymentMediatorName: 'YEMEK KARTI' }] };
      expect((await names()).mediators).toEqual([{ id: 1, name: 'NAKİT' }, { id: 3, name: 'YEMEK KARTI' }]);
      device.mediatorsData = [{ id: 2, name: 'Kredi Kartı' }];
      expect((await names()).mediators).toEqual([{ id: 2, name: 'Kredi Kartı' }]);
      device.mediatorsData = { Count: 0 };
      const none = await names();
      expect(none.mediators).toEqual([]);
      expect(none.mediatorsNote).toContain('Count');
    } finally {
      device.mediatorsData = [{ Mediator: 1, Name: 'Nakit' }, { Mediator: 2, Name: 'Kredi Kartı' }];
    }
  });
});

describe('sertifika sabitleme (HTTPS)', () => {
  const openssl = spawnSync('openssl', ['version']).status === 0;
  const memory = (): PavoStore & { cert: string | null; seq: number } => {
    const s = { cert: null as string | null, seq: 0 };
    return Object.assign(s, {
      getSequence: () => s.seq,
      setSequence: (n: number) => (s.seq = n),
      getCert: () => s.cert,
      setCert: (fp: string | null) => (s.cert = fp),
    });
  };
  const makeCert = (dir: string, name: string) => {
    const key = join(dir, `${name}.key`);
    const cert = join(dir, `${name}.crt`);
    spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=pavo-test'], { stdio: 'ignore' });
    return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
  };

  it.skipIf(!openssl)('eşleştirmede görülen sertifika saklanır; başka sertifika sunan makineye satış gitmez', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pavo-tls-'));
    try {
      const a = await startFakePavo({ tls: makeCert(dir, 'a') });
      const store = memory();
      const client = new PavoClient({ url: a.url, serial: a.serial, fingerprint: 'LafPOS' }, store);
      await client.pair();
      expect(store.cert).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
      expect((await client.paymentMediators()).HasError).toBe(false);
      await a.close();

      // Aynı adreste başka bir "cihaz" (başka sertifika): gövde gönderilmeden kesilir
      const b = await startFakePavo({ tls: makeCert(dir, 'b') });
      client.cfg.url = b.url;
      const e = await client.paymentMediators().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PavoError);
      expect((e as PavoError).code).toBe('CERT_CHANGED');
      expect(b.requests).toHaveLength(0);
      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
