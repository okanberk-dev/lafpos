import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { deviceRoute, type DeviceRouteInput } from '@shared/odeme-fisi';
import { KOPRU_PS1 } from '../server/okc/token-kablo-kopru';
import { type BridgeProcess, commandLine, parseBridgeLine, parseFiscalInfo, TokenKablo, wireBasket } from '../server/okc/token-kablo';
import { type Harness, startApp } from './harness';

/**
 * Token kablolu (TokenX Connect Wire): köprünün satır protokolü, cihaz durumu, sepet ve sonuç; sahte köprüyle uçtan uca
 * (kablo takılınca kendiliğinden kurulum, nakit ve yemek kartı ödemesi, cihazın sepeti işleyememesi). Gerçek köprü
 * PowerShell'de Token'ın DLL'iyle çalışır (Windows kasa); sahtesi aynı satırları konuşur.
 */

const FISCAL = JSON.stringify({
  businessMode: 0,
  sections: [
    { sectionNo: 1, name: 'GIDA', taxPercent: 1000, type: 0 },
    { sectionNo: 2, name: 'ICECEK', taxPercent: 2000, type: 0 },
    { sectionNo: 4, name: 'SU', taxPercent: 100, type: 0 },
  ],
  paymentAppInfo: [67, 1002, 1004],
});

/** Sahte köprü: komut satırlarını okur, Token kütüphanesi gibi yanıt verir */
class FakeBridge extends EventEmitter implements BridgeProcess {
  stdout = new PassThrough();
  stderr = new PassThrough();
  baskets: Record<string, unknown>[] = [];
  /** `basket` komutunun yanıtı: '1' gitti, '0' gitmedi; `reject` ardından 9 tipli paket */
  basketReply: '1' | '0' | 'reject' = '1';
  index = '1';
  fiscal: string | null = FISCAL;
  stdin = {
    write: (s: string) => {
      for (const line of s.split('\n').filter(Boolean)) {
        const [id, cmd, b64] = line.split('\t');
        const body = b64 ? Buffer.from(b64, 'base64').toString('utf8') : null;
        if (cmd === 'fiscal') this.res(id!, this.fiscal);
        else if (cmd === 'index') this.res(id!, this.index);
        else if (cmd === 'basket') {
          this.baskets.push(JSON.parse(body!) as Record<string, unknown>);
          this.res(id!, this.basketReply === '0' ? '0' : '1');
          if (this.basketReply === 'reject') this.line({ t: 'serial', type: 9, value: '{}' });
        } else if (cmd === 'quit') {
          this.res(id!, '1');
          setTimeout(() => this.emit('exit', 0), 1);
        }
      }
      return true;
    },
  };
  line(o: unknown) {
    this.stdout.write(`${JSON.stringify(o)}\n`);
  }
  res(id: string, value: string | null) {
    this.line({ t: 'res', id, ok: true, value });
  }
  plug(id = 'AT00012345') {
    this.line({ t: 'device', connected: true, id });
  }
  unplug() {
    this.line({ t: 'device', connected: false, id: null });
  }
  sale(o: Record<string, unknown>) {
    this.line({ t: 'serial', type: 3, value: JSON.stringify(o) });
  }
  kill() {
    this.emit('exit', null);
  }
}

const wait = (ms = 20) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 2000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('beklenen durum gelmedi');
    await wait(10);
  }
}

describe('köprü satırları', () => {
  it('satırlar okunur; tanınmayan ve bozuk satır yok sayılır', () => {
    expect(parseBridgeLine('{"t":"ready"}')).toEqual({ t: 'ready' });
    expect(parseBridgeLine('{"t":"device","connected":true,"id":" AV123 "}')).toEqual({ t: 'device', connected: true, id: 'AV123' });
    expect(parseBridgeLine('{"t":"serial","type":3,"value":"{}"}')).toEqual({ t: 'serial', type: 3, value: '{}' });
    expect(parseBridgeLine('{"t":"res","id":"k1","ok":false,"message":"x"}')).toEqual({ t: 'res', id: 'k1', ok: false, value: null, message: 'x' });
    expect(parseBridgeLine('Uyarı: bir şey')).toBeNull();
    expect(parseBridgeLine('{bozuk')).toBeNull();
    expect(parseBridgeLine('{"t":"baska"}')).toBeNull();
  });

  it('komut satırı: kimlik, komut ve UTF-8 gövdenin base64’ü; sekme ve satır sonu gövdeyi bozmaz', () => {
    const line = commandLine('k7', 'basket', '{"name":"Çay\t\n"}');
    expect(line.endsWith('\n')).toBe(true);
    const [id, cmd, b64] = line.trimEnd().split('\t');
    expect([id, cmd]).toEqual(['k7', 'basket']);
    expect(Buffer.from(b64!, 'base64').toString('utf8')).toBe('{"name":"Çay\t\n"}');
    expect(commandLine('k1', 'fiscal')).toBe('k1\tfiscal\t\n');
  });

  it('cihaz bilgisi: kısımlar ve ödeme uygulamaları; boş ya da bozuk yanıt yok', () => {
    expect(parseFiscalInfo(FISCAL)).toEqual({
      sections: [
        { sectionNo: 1, name: 'GIDA', taxPercent: 1000 },
        { sectionNo: 2, name: 'ICECEK', taxPercent: 2000 },
        { sectionNo: 4, name: 'SU', taxPercent: 100 },
      ],
      paymentApps: [67, 1002, 1004],
    });
    expect(parseFiscalInfo('')).toBeNull();
    expect(parseFiscalInfo('null')).toBeNull();
    expect(parseFiscalInfo('{}')).toEqual({ sections: [], paymentApps: [] });
    expect(parseFiscalInfo('{x')).toBeNull();
  });

  it('kablolu sepet bulut alanlarını taşımaz (masa adı, filtre, webhook); ödeme ve indirim gider', () => {
    const w = wireBasket({
      basketID: 'b1',
      title: 'Masa 3',
      filter: 'Bahçe',
      callbackUrl: 'https://x',
      note: 'AsilPOS #12',
      items: [{ name: 'Latte', price: 12000, sectionNo: 1, taxPercent: 1000, quantity: 2000, adjust: { description: 'İndirim', discountOrSurcharge: 0, type: 0, totalValue: 1000 } }],
      paymentItems: [{ amount: 23000, type: 7, operatorId: 1002 }],
    });
    expect(w).toEqual({
      basketID: 'b1',
      documentType: 0,
      createInvoice: false,
      isVoid: false,
      items: [{ name: 'Latte', price: 12000, sectionNo: 1, taxPercent: 1000, quantity: 2000, unit: 'Adet', adjust: { description: 'İndirim', discountOrSurcharge: 0, type: 0, totalValue: 1000 } }],
      paymentItems: [{ amount: 23000, type: 7, operatorId: 1002 }],
      note: 'AsilPOS #12',
    });
  });

  it('köprü betiği ASCII (Windows PowerShell 5.1 BOM’suz dosyayı ANSI okur) ve iki sınıfı ayrı derler', () => {
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(KOPRU_PS1)).toBe(true);
    expect(KOPRU_PS1).toContain('[AsilposKopruYukle]::Hazirla($Dll)');
    expect(KOPRU_PS1.indexOf('[AsilposKopruYukle]::Hazirla($Dll)')).toBeLessThan(KOPRU_PS1.indexOf('-ReferencedAssemblies @($Dll)'));
    for (const fn of ['sendBasket', 'sendPayment', 'getFiscalInfo', 'getActiveDeviceIndex', 'setSerialInCallback', 'setDeviceStateCallback', 'reConnect', 'deleteCommunication']) {
      expect(KOPRU_PS1).toContain(fn);
    }
  });
});

describe('köprü yöneticisi', () => {
  const make = () => {
    const fake = new FakeBridge();
    const k = new TokenKablo({ spawner: () => fake, ready: () => ({ ok: true }), dir: '/tmp', script: '/tmp/kopru.ps1', supported: true, rejectWaitMs: 50 });
    return { fake, k };
  };

  it('ön koşul eksikse köprü açılmaz, neden görünür', () => {
    const k = new TokenKablo({ ready: () => ({ ok: false, phase: 'kurulum', message: 'Token kütüphanesi kurulu değil' }), supported: true });
    expect(k.start()).toMatchObject({ phase: 'kurulum', message: 'Token kütüphanesi kurulu değil' });
    expect(k.running).toBe(false);
  });

  it('hazır → kablo bekleniyor → takılınca kısımlar okunur, model 300TR; çıkınca yeniden bekler', async () => {
    const { fake, k } = make();
    const connected: unknown[] = [];
    k.on('connected', (s) => connected.push(s));
    k.start();
    fake.line({ t: 'ready' });
    await until(() => k.state.phase === 'bekliyor');
    fake.plug('AT00012345');
    await until(() => k.connected);
    expect(k.state).toMatchObject({ phase: 'bagli', fiscalId: 'AT00012345', model: '300TR', paymentApps: [67, 1002, 1004] });
    expect(k.state.sections.map((s) => s.sectionNo)).toEqual([1, 2, 4]);
    expect(connected).toHaveLength(1);
    fake.unplug();
    await until(() => k.state.phase === 'bekliyor');
    expect(k.connected).toBe(false);
    k.stop();
  });

  it('kütüphane yüklenemezse (kurulum eksik) yeniden denenmez; neden ekranda kalır', async () => {
    const { fake, k } = make();
    k.start();
    fake.line({ t: 'fatal', message: 'DllNotFoundException' });
    fake.emit('exit', 2);
    await until(() => !k.running);
    expect(k.state.phase).toBe('kurulum');
    expect(k.state.message).toContain('DllNotFoundException');
  });

  it('sepet: gitti (1); gitmedi (0) ve cihaz işleyemedi (9) okunur hatayla; bağlı değilken gönderilmez', async () => {
    const { fake, k } = make();
    const basket = { basketID: 'b1', items: [{ name: 'Çay', price: 3000, sectionNo: 1, taxPercent: 1000, quantity: 1000 }] };
    await expect(k.sendBasket(basket)).rejects.toThrow('kabloyla bağlı değil');
    k.start();
    fake.line({ t: 'ready' });
    fake.plug();
    await until(() => k.connected);
    await k.sendBasket(basket);
    expect(fake.baskets[0]).toMatchObject({ basketID: 'b1', items: [{ name: 'Çay', price: 3000 }] });
    fake.basketReply = '0';
    await expect(k.sendBasket(basket)).rejects.toThrow('Cihaz sepeti almadı');
    fake.basketReply = 'reject';
    await expect(k.sendBasket(basket)).rejects.toThrow('Cihaz sepeti işleyemedi');
    k.stop();
  });

  it('satış sonucu (3) sepet kimliğiyle saklanır ve yayılır', async () => {
    const { fake, k } = make();
    const sales: unknown[] = [];
    k.on('sale', (s) => sales.push(s));
    k.start();
    fake.sale({ basketID: 'b9', status: 0, paymentItems: [{ type: 1, amount: 500 }] });
    await until(() => sales.length === 1);
    expect(k.sales.get('b9')).toMatchObject({ status: 0 });
    k.stop();
  });
});

describe('ödeme penceresi: yemek kartı cihaza', () => {
  const base: DeviceRouteInput = { provider: 'pavo', mode: 'anlik', auto: true, canSend: true, methodKind: 'yemek', tip: 0, payMode: 'tutar', splitActive: false, amount: 1000, remaining: 1000, pickedCount: 0, amountPaidHere: false };
  it('Pavo: eşlenmiş yemek kartı cihaza gider, eşlenmemiş AsilPOS’a yazılır (nedeniyle)', () => {
    expect(deviceRoute({ ...base, mealOnDevice: true })).toMatchObject({ send: true });
    expect(deviceRoute({ ...base, mealOnDevice: false })).toMatchObject({ send: false, reason: expect.stringContaining('eşlenmedi') });
    // Eski sunucu (bilgi yok): Pavo'da gitmez
    expect(deviceRoute(base)).toMatchObject({ send: false });
  });
  it('Token kablolu: yemek kartı, nakit ve kart cihaza gider', () => {
    for (const methodKind of ['yemek', 'nakit', 'kart'] as const) expect(deviceRoute({ ...base, provider: 'tokenkablo', methodKind, mealOnDevice: true })).toMatchObject({ send: true });
  });
});

describe('akış (sahte köprü)', () => {
  let h: Harness;
  let fake: FakeBridge;
  let kablo: TokenKablo;
  beforeAll(async () => {
    h = await startApp();
    ({ kablo } = await import('../server/okc/token-kablo'));
    const { syncTokenKablo } = await import('../server/okc/token-kablo-servis');
    kablo.configure({ spawner: () => (fake = new FakeBridge()), ready: () => ({ ok: true }), supported: true, rejectWaitMs: 50 });
    syncTokenKablo();
    fake!.line({ t: 'ready' });
    await until(() => kablo.state.phase === 'bekliyor');
  });
  afterAll(() => {
    kablo.stop();
    h.cleanup();
  });

  type Status = { provider: string; mode: string; sectionMap: Record<string, number>; operatorMethods: Record<string, string>; tokenKablo: { phase: string; model: string | null; fiscalId: string | null } };
  type Receipt = { id: string; status: string; amount: number; docKind: string | null; zNo: number | null; receiptNo: number | null };
  const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
  const newOrder = async (qty = 1) => {
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty }] });
  };
  const methods = () => h.boot.paymentMethods;

  it('eğitim cihazında gün açıkken kablo takılırsa bağlantı geçmez (eğitim gününe gerçek fiş karışmaz), neden görünür', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    const open = await h.call('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect([200, 409]).toContain(open.status);
    fake.plug('AT00099999');
    await until(() => kablo.connected);
    await wait(30);
    const s = await h.ok<Status & { tokenKablo: { held: string | null } }>('patron', 'GET', '/okc/status');
    expect(s.provider).toBe('simulator');
    expect(s.tokenKablo.held).toContain('Eğitim günü açık');
    fake.unplug();
    await until(() => !kablo.connected);
  });

  it('kablo takılınca: yazarkasa kapalıyken bağlantı Token kabloluya geçer, kısımlar ve yemek kartları eşlenir, denetime yazılır', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'kapali' });
    expect((await h.ok<Status>('patron', 'GET', '/okc/status')).provider).toBe('kapali');
    fake.plug('AT00099999');
    await until(() => kablo.connected);
    await wait(30);
    const s = await h.ok<Status>('patron', 'GET', '/okc/status');
    expect(s).toMatchObject({ provider: 'tokenkablo', mode: 'anlik', tokenKablo: { phase: 'bagli', model: '300TR', fiscalId: 'AT00099999' } });
    // Varsayılan %10 → 1, %20 → 2 cihazda tutuyor; %1 → 3 cihazda yok, cihazdaki %1 kısmı (4) alınır
    expect(s.sectionMap).toEqual({ '1': 4, '10': 1, '20': 2 });
    const multinet = methods().find((m) => m.channel === 'multinet');
    const pluxee = methods().find((m) => m.channel === 'pluxee');
    if (multinet) expect(s.operatorMethods['1002']).toBe(multinet.id);
    if (pluxee) expect(s.operatorMethods['1004']).toBe(pluxee.id);
    const { db, schema } = await import('../server/db/client');
    const rows = db.select().from(schema.auditLog).all();
    expect(rows.some((r) => r.action === 'okc.settings' && r.message.includes('kabloyla bağlandı'))).toBe(true);
  });

  it('nakit: ödeme sepetle gider (tip 1), cihaz fişi keser, adisyon kapanır; Z ve fiş no kalır', async () => {
    const o = await newOrder(2);
    const nakit = methods().find((m) => m.kind === 'nakit')!;
    const r = await h.ok<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { odeme: 'nakit', methodId: nakit.id });
    expect(r.receipt.status).toBe('gonderildi');
    const sent = fake.baskets.at(-1)!;
    expect(sent).toMatchObject({ basketID: r.receipt.id, paymentItems: [{ type: 1, amount: o.total }] });
    expect(sent).not.toHaveProperty('title');
    fake.sale({ basketID: r.receipt.id, status: 0, zNo: 12, receiptNo: 7, paymentItems: [{ type: 1, amount: o.total, operatorId: 0, status: -1 }] });
    await until(() => true);
    await wait(50);
    const done = await h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${r.receipt.id}/refresh`);
    expect(done).toMatchObject({ status: 'tamamlandi', zNo: 12, receiptNo: 7 });
    expect(await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).toMatchObject({ status: 'kapali', paid: o.total });
  });

  it('yemek kartı: tip 7 ve kartın uygulaması gider; sonuç o yemek kartı türüne, bilgi fişi olarak yazılır', async () => {
    const multinet = methods().find((m) => m.kind === 'yemek' && m.channel === 'multinet');
    if (!multinet) return;
    const o = await newOrder(1);
    const r = await h.ok<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { odeme: 'yemek', methodId: multinet.id });
    expect(fake.baskets.at(-1)).toMatchObject({ paymentItems: [{ type: 7, amount: o.total, operatorId: 1002 }] });
    fake.sale({ basketID: r.receipt.id, status: 0, zNo: 12, receiptNo: 8, paymentItems: [{ type: 7, amount: o.total, operatorId: 1002 }] });
    await wait(50);
    const done = await h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${r.receipt.id}/refresh`);
    expect(done).toMatchObject({ status: 'tamamlandi', docKind: 'bilgi_fisi' });
    const paid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(paid.payments.map((p) => p.methodId)).toEqual([multinet.id]);
  });

  it('cihaz satış ekranında değilse (9) sepet hataya düşer, adisyon kilitlenmez ve yeniden gönderilir', async () => {
    const o = await newOrder(1);
    fake.basketReply = 'reject';
    const r = await h.call<{ error: string; code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(r.status).toBe(502);
    expect(r.json.error).toContain('işleyemedi');
    fake.basketReply = '1';
    const again = await h.call<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(again.status).toBe(200);
    // Kasiyer cihazda vazgeçer: sonuç -1, adisyon açık kalır
    fake.sale({ basketID: again.json.receipt.id, status: -1, message: 'CANCELLED' });
    await wait(50);
    expect((await h.ok<Receipt>('kasa', 'POST', `/okc/receipts/${again.json.receipt.id}/refresh`)).status).toBe('iptal');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).status).toBe('acik');
  });

  it('cihaz ekranındaki sepet AsilPOS’tan silinmez (cihazda vazgeçilir); kablo çıkınca yalnız yetkili onayıyla iptal sayılır', async () => {
    const o = await newOrder(1);
    const r = await h.ok<{ receipt: Receipt }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    const del = await h.call<{ error: string }>('kasa', 'POST', `/okc/receipts/${r.receipt.id}/cancel`, {});
    expect(del.status).toBe(502);
    expect(del.json.error).toContain('cihazda iptal tuşuyla');
    fake.unplug();
    await until(() => !kablo.connected);
    const status = await h.ok<Status>('patron', 'GET', '/okc/status');
    expect(status.tokenKablo.phase).toBe('bekliyor');
    // Kablo takılı değilken yeni sepet gitmez
    const o2 = await newOrder(1);
    const blocked = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o2.id}/send`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.json.code).toBe('okc_not_configured');
  });

  it('kurulum düğmesi Windows dışında açık bir nedenle reddedilir; Token kablolu masada ödeme kabul etmez', async () => {
    kablo.configure({ supported: false });
    const r = await h.call<{ code: string; error: string }>('patron', 'POST', '/okc/token-kablo/kur');
    expect(r.status).toBe(409);
    expect(r.json.error).toContain('Windows');
    kablo.configure({ supported: true });
    expect((await h.call('patron', 'PUT', '/okc/settings', { mode: 'liste' })).status).toBe(409);
  });
});
