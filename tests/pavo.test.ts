import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { PavoClient, PavoError, type PavoStore } from '../server/okc/pavo';
import { pavoOrderNo, pavoSale, pavoTiming, readSale } from '../server/okc/providers/pavo';
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

  it('her istekte sıra no öncekinden büyük, seri no ve kimlik aynı (cihaz aksini reddeder)', () => {
    const handles = device.requests.map((q) => q.body.TransactionHandle as { TransactionSequence: number; SerialNumber: string; Fingerprint: string });
    const afterPair = handles.slice(device.requests.findIndex((q) => q.path === '/Pairing'));
    const seqs = afterPair.filter((_, i) => device.requests[device.requests.length - afterPair.length + i]!.path !== '/Ping').map((x) => x.TransactionSequence);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(new Set(handles.map((x) => x.SerialNumber))).toEqual(new Set([device.serial]));
    expect(new Set(afterPair.map((x) => x.Fingerprint))).toEqual(new Set(['LafPOS-test']));
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
