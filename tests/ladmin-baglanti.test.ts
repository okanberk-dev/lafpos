import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branchSlug, checkConnValue, connField } from '@shared/baglanti';
import { addDays, businessDate } from '@shared/time';
import { type Harness, startApp } from './harness';

/**
 * LafPOS ↔ lafmaliyet (ladmin) bağlantısının kenar durumları (docs/03-ENTEGRASYON.md §4.2): adres yalnız https site
 * kökü, yönlendirme izlenmez ve okunur hata yazar, 200 yalnız lafmaliyet'in kendi yanıtıysa "gönderildi" sayılır,
 * şube gönderirken güncel ayardan, hata metinleri Türkçe ve yerinde, geçiş günü kısa yanıtla silinmez, cihazda süren
 * banka gün sonu pakete girmez, kartla açık hesap tahsilatı banka kıyasına girer, kasanın kendi satır adları ürüne
 * verilmez.
 */

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  raw?: string;
}

let h: Harness;
let server: Server;
const posts: { sube?: string; date?: string; bankPos?: unknown }[] = [];
const replies: Reply[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === '/api/pos/gun') posts.push(body);
      const r = replies.shift() ?? { status: 200, body: { ok: true, date: body?.date, lines: 0, matched: 0, unmatched: [], counted: true, switchDay: '2026-11-01' } };
      res.writeHead(r.status, { 'content-type': r.raw ? 'text/html' : 'application/json', ...(r.headers ?? {}) });
      res.end(r.raw ?? JSON.stringify(r.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, LAFMALIYET_SYNC_SECRET: 'm'.repeat(48) });
  // Kurulum modu dışı (kurulum modunda gün lafmaliyet'e hiç gitmez)
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, okcProvider: 'kapali' });
});

afterAll(() => {
  server.close();
  h.cleanup();
});

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const lm = await import('../server/sync/lafmaliyet');
  const settings = await import('../server/lib/settings');
  const { ulid } = await import('../server/lib/ids');
  const internet = await import('../server/lib/internet');
  let n = 0;
  const insertDay = () => {
    const id = ulid();
    const at = Date.now() - 3600_000;
    const date = addDays(businessDate(Date.now()), -(40 + ++n));
    db.insert(schema.businessDays).values({ id, date, zNo: 900 + n, openedAt: at, openingCash: 0, closedAt: at + 60_000, trainingDay: false }).run();
    return { id, date };
  };
  const row = (key: string) =>
    db
      .select()
      .from(schema.outbox)
      .all()
      .filter((r) => r.target === 'lafmaliyet' && r.dedupeKey === key)
      .at(-1)!;
  const day = (id: string) => db.select().from(schema.businessDays).where(eq(schema.businessDays.id, id)).get()!;
  /** Günü kuyruğa koyar, bir tur gönderir; kaydı ve günü döner */
  const sendOnce = async (id: string) => {
    const key = lm.enqueueDay(id)!;
    db.update(schema.outbox).set({ nextAttemptAt: 0 }).where(eq(schema.outbox.dedupeKey, key)).run();
    await lm.flushOutbox();
    return { row: row(key), day: day(id) };
  };
  return { db, schema, eq, lm, settings, internet, insertDay, sendOnce };
}

describe('adres ve anahtar denetimi', () => {
  const url = connField('LAFMALIYET_URL')!;
  it('lafmaliyet ve site adresi yalnız https site kökü: yol, sorgu, düz http (yerel ağ dışında) reddedilir; büyük harf ve sondaki / düzelir', () => {
    expect(checkConnValue(url, ' https://LADMIN.laffogato.net/ ')).toEqual({ value: 'https://ladmin.laffogato.net' });
    expect(checkConnValue(url, 'http://ladmin.laffogato.net')).toEqual({ error: 'Adres: adres https:// ile başlamalı (http yalnız yerel ağda)' });
    expect(checkConnValue(url, 'https://ladmin.laffogato.net/api/pos/gun')).toHaveProperty('error');
    expect(checkConnValue(url, 'https://ladmin.laffogato.net/?x=1')).toHaveProperty('error');
    expect(checkConnValue(url, 'https://kisi:sifre@ladmin.laffogato.net')).toHaveProperty('error');
    for (const local of ['http://127.0.0.1:3000', 'http://192.168.1.20:3000', 'http://localhost:3000', 'http://kasa.local']) expect(checkConnValue(url, local)).not.toHaveProperty('error');
    expect(checkConnValue(connField('LAFFOGATO_URL')!, 'https://laffogato.net/menu')).toHaveProperty('error');
    // Yolu olan adresler (TokenX) yolu korur
    expect(checkConnValue(connField('TOKENX_AUTH_URL')!, 'https://auth.example.com/connect/token/')).toEqual({ value: 'https://auth.example.com/connect/token' });
  });

  it('lafmaliyet anahtarı en az 32 karakter (kısası imza atmaz, bağlantı kapalı görünürdü)', () => {
    expect(checkConnValue(connField('LAFMALIYET_SYNC_SECRET')!, 'k'.repeat(31))).toEqual({ error: 'Anahtar: en az 32 karakter' });
    expect(checkConnValue(connField('LAFMALIYET_SYNC_SECRET')!, 'k'.repeat(32))).toEqual({ value: 'k'.repeat(32) });
  });

  it('şube kimliği yazımı büyük I harfini silmez: MARINA, Marına → marina', () => {
    expect(branchSlug('MARINA')).toBe('marina');
    expect(branchSlug('Marına')).toBe('marina');
    expect(branchSlug('İSTİNYE')).toBe('istinye');
    expect(branchSlug('Tuzla-2 ')).toBe('tuzla-2');
  });

  it('.env adresinin sonundaki / ve boşluk atılır', async () => {
    const { env } = await import('../server/env');
    expect(env.lafmaliyetUrl).toBe(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  });
});

describe('gün sonu gönderimi', () => {
  it('200 ama lafmaliyet yanıtı değil (giriş sayfası, boş gövde, başka gün): gönderildi sayılmaz, gün işaretlenmez, yeniden denenir', async () => {
    const m = await mod();
    for (const r of [{ status: 200, body: null, raw: '<html>Giriş</html>' }, { status: 200, body: {} }, { status: 200, body: { ok: true, date: '2000-01-01' } }]) {
      const d = m.insertDay();
      replies.push(r);
      const { row, day } = await m.sendOnce(d.id);
      expect(row.sentAt).toBeNull();
      expect(day.exportedAt).toBeNull();
      expect(row.lastError).toContain('Adresten lafmaliyet yanıtı gelmedi');
      // Kalıcı değil: bir yıl park edilmez
      expect(row.nextAttemptAt - Date.now()).toBeLessThan(86400_000);
    }
  });

  it('yönlendirme izlenmez: okunur hata, internet "var" sayılır, gün gitmez', async () => {
    const m = await mod();
    const d = m.insertDay();
    const before = posts.length;
    replies.push({ status: 301, body: null, headers: { location: 'https://ladmin.laffogato.net/api/pos/gun' } });
    const { row } = await m.sendOnce(d.id);
    expect(row.sentAt).toBeNull();
    expect(row.lastError).toBe("Adres yönlendiriyor (HTTP 301 → https://ladmin.laffogato.net): Yönetim › Bağlantı bilgileri'nde adresi yönlendirmesiz, https:// ile ve sonunda yol olmadan yazın");
    expect(m.internet.internetState().state).not.toBe('down');
    // Gövde yeni adrese gitmedi: sahte sunucuya tek istek geldi
    expect(posts.length).toBe(before + 1);
  });

  it('hata metinleri: 404 yanlış adres, gövdesiz 503 geçici, not_configured 503 anahtar yok, 401 imza; wrong_branch şubeyi söyler', async () => {
    const m = await mod();
    const cases: [Reply, string][] = [
      [{ status: 404, body: null }, 'adreste lafmaliyet yok'],
      [{ status: 503, body: null }, 'lafmaliyet şu an yanıt vermiyor'],
      [{ status: 503, body: { error: 'not_configured' } }, "lafmaliyet'te LAFPOS_SYNC_SECRET tanımlı değil"],
      [{ status: 401, body: { error: 'unauthorized' } }, 'kasa bilgisayarının saati doğru mu (±5 dk)'],
      [{ status: 409, body: { error: 'wrong_branch', sube: 'tuzla', expected: 'marina' } }, 'bu kasa "tuzla" şubesine ayarlı, lafmaliyet yalnız "marina" şubesini alıyor'],
      [{ status: 400, body: { error: 'invalid', field: 'lines.0.qty' } }, "LafPOS'u ve lafmaliyet'i güncelleyip"],
    ];
    for (const [reply, text] of cases) {
      replies.push(reply);
      const { row } = await m.sendOnce(m.insertDay().id);
      expect(row.sentAt).toBeNull();
      expect(row.lastError).toContain(text);
      expect(row.lastError).not.toContain('?.');
    }
    // 503 not_configured artık "anahtar yok" yalnız gövdesi öyleyse
    expect(m.lm.pushErrorText(503, null, {})).not.toContain('LAFPOS_SYNC_SECRET');
  });

  it('ağ hatası Türkçe: "fetch failed" yazılmaz', async () => {
    const { networkErrorText } = await import('../server/sync/lafmaliyet');
    const refused = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    expect(networkErrorText(refused)).toBe("lafmaliyet'e ulaşılamadı: bağlantı kurulamadı (internet) [ECONNREFUSED]");
    const dns = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' }) });
    expect(networkErrorText(dns)).toContain('adres bulunamadı');
    expect(networkErrorText(new DOMException('aborted', 'TimeoutError'))).toBe('lafmaliyet zamanında yanıt vermedi');
    expect(networkErrorText(new TypeError('fetch failed'))).toMatch(/^lafmaliyet'e ulaşılamadı/);
    expect(networkErrorText(new Error('beklenmeyen'))).toBe('beklenmeyen');
  });

  it('şube gönderirken güncel ayardan: kuyruktaki eski şubeli kayıt düzeltilmiş şubeyle gider', async () => {
    const m = await mod();
    const d = m.insertDay();
    m.settings.updateSettings({ branchId: 'tuzla' });
    const key = m.lm.enqueueDay(d.id)!;
    m.settings.updateSettings({ branchId: 'marina' });
    m.db.update(m.schema.outbox).set({ nextAttemptAt: 0 }).where(m.eq(m.schema.outbox.dedupeKey, key)).run();
    await m.lm.flushOutbox();
    expect(posts.filter((p) => p.date === d.date).at(-1)?.sube).toBe('marina');
  });

  it('geçiş günü olmayan kısa 200 yanıtı bilinen geçiş gününü silmez', async () => {
    const m = await mod();
    await m.sendOnce(m.insertDay().id);
    expect(m.lm.knownSwitchDay()).toBe('2026-11-01');
    const d = m.insertDay();
    replies.push({ status: 200, body: { ok: true, date: d.date, lines: 0 } });
    const { row } = await m.sendOnce(d.id);
    expect(row.sentAt).not.toBeNull();
    expect(m.lm.knownSwitchDay()).toBe('2026-11-01');
  });

  it('cihazda süren banka gün sonu (running) pakete girmez; bitince (ok) girer', async () => {
    const m = await mod();
    const d = m.insertDay();
    const eod = { status: 'running', batchNo: null, at: Date.now(), grandTotalKurus: null, dayCardKurus: 1000, message: 'sürüyor', acquirers: [] };
    m.settings.setSyncState(`pavo.eod.${d.id}`, eod);
    expect(m.lm.buildDayPayload(d.id)).not.toHaveProperty('bankPos');
    m.settings.setSyncState(`pavo.eod.${d.id}`, { ...eod, status: 'ok', batchNo: '000300', grandTotalKurus: 1000 });
    expect(m.lm.buildDayPayload(d.id)).toMatchObject({ bankPos: { status: 'ok', pavoCard: 10, lafposCard: 10, diff: 0 } });
  });
});

describe('banka gün sonu kıyası', () => {
  it('kartla açık hesap tahsilatı LafPOS kart tutarına girer (bankaya gider); iade edilen ve nakit tahsilat girmez', async () => {
    const m = await mod();
    const { cardBasis } = await import('../server/okc/service');
    const { ulid } = await import('../server/lib/ids');
    const card = h.boot.paymentMethods.find((x) => x.zField === 'card')!;
    const cash = h.boot.paymentMethods.find((x) => x.zField === 'cash')!;
    const d = m.insertDay();
    const summary = { byZField: { cash: 0, card: 5000, meal_card: 0, online: 0, other: 0 }, payments: [{ methodId: card.id, name: card.name, zField: 'card', channel: null, count: 1, amount: 5000, tips: 300 }] };
    m.db.update(m.schema.businessDays).set({ summary: summary as never }).where(m.eq(m.schema.businessDays.id, d.id)).run();
    const at = Date.now() - 1800_000;
    const pay = (method: typeof card, amount: number, createdAt: number, refundedAt: number | null = null) =>
      m.db
        .insert(m.schema.payments)
        .values({ id: ulid(), orderId: null, dayId: d.id, methodId: method.id, methodName: method.name, zField: method.zField, amount, createdAt, refundedAt })
        .run();
    pay(card, 2000, at);
    pay(card, 700, at, at + 1);
    pay(cash, 900, at);
    // İlk gün sonu: Z'nin kartı + kartla bahşiş + kartla tahsilat
    expect(cardBasis(d.id, [])).toEqual({ dayCardKurus: 5000 + 300 + 2000, dayCardSinceBatch: null });
    // Sonraki gün sonu: yalnız önceki batch'ten sonrakiler
    pay(card, 450, at + 120_000);
    const batch = { batchNo: '000301', deviceDateTime: null, grandTotalKurus: 7300, at: at + 60_000, trigger: 'elle' as const, dayClosed: false };
    expect(cardBasis(d.id, [batch as never])).toEqual({ dayCardKurus: 450, dayCardSinceBatch: '000301' });
  });

  it("22.11: yazarkasadan geçmeyen kart (₺870) ve gün kapandıktan sonra cihazda fişi iptal edilen kart Pavo'nun batch'inde beklenmez", async () => {
    const m = await mod();
    const { cardBasis } = await import('../server/okc/service');
    const { ulid } = await import('../server/lib/ids');
    const card = h.boot.paymentMethods.find((x) => x.zField === 'card')!;
    const d = m.insertDay();
    const at = Date.now() - 1800_000;
    let no = 0;
    /** Kapanmış adisyon ve kart ödemesi; `receipt` verilirse ödeme o yazarkasa fişinin (cihazdan geçti) */
    const sale = (amount: number, receipt: 'tamamlandi' | 'fis_iptal' | null, createdAt = at, tip = 0) => {
      const orderId = ulid();
      m.db.insert(m.schema.orders).values({ id: orderId, dayId: d.id, no: ++no, type: 'tezgah', status: 'kapali', openedAt: createdAt, closedAt: createdAt, total: amount, paid: amount, updatedAt: createdAt }).run();
      const paymentId = ulid();
      m.db.insert(m.schema.payments).values({ id: paymentId, orderId, dayId: d.id, methodId: card.id, methodName: card.name, zField: 'card', amount, tip, createdAt }).run();
      if (receipt) {
        m.db
          .insert(m.schema.fiscalReceipts)
          .values({ id: ulid(), orderId, provider: 'pavo', mode: 'anlik', status: receipt, amount, items: [], basket: {}, paymentIds: [paymentId], createdAt, updatedAt: createdAt })
          .run();
      }
    };
    // Cihazdan geçen kart ₺4.160, cihazdan geçmeyen kart ₺870 (bahşişiyle ₺20), gün kapandıktan sonra cihazda fişi
    // iptal edilen kart ₺125 (LafPOS'ta ödeme canlı kalır, Z'nin kartında durur ama bankanın batch'inde yok)
    sale(300000, 'tamamlandi');
    sale(116000, 'tamamlandi');
    sale(87000, null, at, 2000);
    sale(12500, 'fis_iptal');
    const zCard = 300000 + 116000 + 87000 + 12500;
    const summary = { byZField: { cash: 0, card: zCard, meal_card: 0, online: 0, other: 0 }, payments: [{ methodId: card.id, name: card.name, zField: 'card', channel: null, count: 4, amount: zCard, tips: 2000 }] };
    m.db.update(m.schema.businessDays).set({ summary: summary as never }).where(m.eq(m.schema.businessDays.id, d.id)).run();
    expect(cardBasis(d.id, [])).toEqual({ dayCardKurus: 416000, dayCardSinceBatch: null });
    // Sonraki gün sonunda da: önceki batch'ten sonraki kart ödemelerinden cihazdan geçmeyen ve fişi iptal edilen düşer
    sale(4500, 'tamamlandi', at + 120_000);
    sale(3000, null, at + 120_000);
    sale(1500, 'fis_iptal', at + 120_000);
    const batch = { batchNo: '000401', deviceDateTime: null, grandTotalKurus: 416000, at: at + 60_000, trigger: 'elle' as const, dayClosed: false };
    expect(cardBasis(d.id, [batch as never])).toEqual({ dayCardKurus: 4500, dayCardSinceBatch: '000401' });
  });
});

describe('kasanın kendi satır adları', () => {
  it('servis ücreti, platform ücreti ve ek adları ürüne lafmaliyet adı olarak verilemez', async () => {
    const category = h.boot.categories[0]!;
    for (const posName of ['SERVİS ÜCRETİ', 'servis ücreti', 'PLATFORM ÜCRETİ', 'SYRUP', 'Extra Shot', 'ALTERNATIF SÜT']) {
      const r = await h.call<{ code: string; error: string }>('patron', 'POST', '/admin/products', { categoryId: category.id, name: `Deneme ${posName}`, price: 1000, kdvRate: 10, posName });
      expect(r.status, posName).toBe(409);
      expect(r.json.code).toBe('pos_name_reserved');
    }
    const ok = await h.call('patron', 'POST', '/admin/products', { categoryId: category.id, name: 'Deneme serbest', price: 1000, kdvRate: 10, posName: 'SERBEST AD' });
    expect(ok.status).toBe(200);
  });
});



