import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Gün sonu gövdesinin Faz 2 alanları (docs/03-ENTEGRASYON.md §4, docs/hesap-sozlesmesi.md): satırın liste değeri ve
 * ek işareti, Z'nin liste değeri, ikram/ödenmez/zayi toplamları, KDV dökümü, açılış ve kapanış anı, yazarkasanın Z'si;
 * ikramın türü ve ödenmezin kişi türü (kişi gitmez), iptaller (hazırlandı mı, iade mi), iadeler (yeniden yazılan
 * ödeme düşülür), yazarkasadan geçmeyen, gönderim sırası (`revision`) ve düzeltme (`correction`), banka gün sonunun
 * hata kodu. Eski Z (ödenmez, zayi, yazarkasadan geçmeyen yok) yine geçerli gövde verir. Şube kimliği ilk başarılı
 * gönderimden sonra kilitlenir.
 */

interface Line { posName: string; siteMenuId: string | null; slot: string | null; qty: number; revenue: number; gross: number; isService: boolean; isAddon: boolean }
interface Ikram { posName: string; qty: number; menuValue: number; reason: string | null; kind: string; personKind: string | null }
interface Iptal { posName: string; siteMenuId: string | null; slot: string | null; qty: number; listValue: number; prepared: boolean; reason: string | null; refund: boolean }
interface Refund { amount: number; zField: string; name: string; channel: string | null; reason: string | null }
interface Payload {
  revision: number;
  correction?: { kind: string; reason: string };
  date: string;
  sube: string;
  z: Record<string, unknown> & { zTotal: number; discounts: number; offRevenue: number; listValue: number; ikramTotal: number; odenmezTotal: number; zayiTotal: number; vat: { rate: number; base: number; vat: number }[] };
  lines: Line[];
  ikram: Ikram[];
  iptal: Iptal[];
  refunds: Refund[];
  offDevice: { card: number; cash: number };
  bankPos?: Record<string, unknown>;
}

let h: Harness;
let server: Server;
const posts: Payload[] = [];
/**
 * Yanıtı bekletilen gün sonu: istek gelince `arrived` çözülür, yanıt `release` çözülünce gider (istek yoldayken);
 * `status` verilirse o hatayla (ör. 503)
 */
let hold: { arrived: () => void; release: Promise<void>; status?: number } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : null;
      if (req.url === '/api/pos/gun') {
        posts.push(body);
        const held = hold;
        hold = null;
        if (held) {
          held.arrived();
          await held.release;
          if (held.status) {
            res.writeHead(held.status, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'unavailable' }));
            return;
          }
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, date: body?.date, lines: 0, matched: 0, unmatched: [], counted: true, switchDay: '2026-11-01' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, LAFMALIYET_SYNC_SECRET: 'f'.repeat(48) });
  // Yazarkasa eğitim cihazında ama gerçek kullanım başlamış: gün gerçek gündür (lafmaliyet'e gider), cihaz fişi kesilir
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, liveSince: Date.now() - 86400_000 });
}, 60_000);

afterAll(() => {
  server.close();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const option = (groupKey: string, code: string) => h.boot.optionGroups.find((g) => g.extKey === groupKey)!.items.find((i) => i.code === code)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const user = (name: string) => h.boot.users.find((u) => u.name === name)!;

type Pick = { name: string; size?: 'M' | 'L'; qty?: number; options?: { itemId: string; qty?: number }[] };
async function sell(items: Pick[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', reuse: null });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}), ...(i.options ? { options: i.options } : {}) })),
  });
}
const pay = (o: OrderDTO, methodName: string) => h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(methodName).id, amount: o.total - o.paid });
const itemOf = (o: OrderDTO, name: string) => o.items.find((i) => i.name === name && !i.voided && !i.complimentary)!;

async function mods() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const lm = await import('../server/sync/lafmaliyet');
  const settings = await import('../server/lib/settings');
  return { db, schema, eq, lm, settings };
}

async function openDay() {
  return (await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 50000 })).id;
}
/**
 * Kapanan günü geçmiş bir tarihe alır (bir tarihe tek Z): sonraki test yeni gün açar. Giden kutusundaki kayıtları da
 * (gönderim sırası tarihin anahtarıyla sayılır) yoldakiler bittikten sonra o tarihe taşır
 */
let past = 0;
async function retire(dayId: string) {
  const m = await mods();
  await m.lm.flushOutbox();
  const day = m.db.select().from(m.schema.businessDays).where(m.eq(m.schema.businessDays.id, dayId)).get()!;
  const date = `2026-08-${String(++past).padStart(2, '0')}`;
  m.db.update(m.schema.businessDays).set({ date }).where(m.eq(m.schema.businessDays.id, dayId)).run();
  m.db.update(m.schema.outbox).set({ dedupeKey: `gun:${date}` }).where(m.eq(m.schema.outbox.dedupeKey, `gun:${day.date}`)).run();
}
const payload = (dayId: string) => h.ok<Payload>('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);
const close = (countedCash: number | null = null) => h.ok<{ day: { id: string } }>('mudur', 'POST', '/cash/day/close', { countedCash });

describe('satırlar, Z toplamları ve ikram türleri', () => {
  let p: Payload;
  beforeAll(async () => {
    const dayId = await openDay();
    // İndirimli adisyon: iki Latte M (biri vanilya şuruplu), ₺52,50 adisyon indirimi; kartla
    let a = await sell([{ name: 'Latte', size: 'M', options: [{ itemId: option('syrup', 'vanilla').id }] }, { name: 'Latte', size: 'M' }]);
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/discount`, { type: 'amount', value: 5250, reason: 'Müdavim' });
    await pay(a, 'Kredi kartı');
    // İkram, ödenmez (patron, personel, müşteri) ve zayi; geri kalanı nakit
    let b = await sell([{ name: 'Espresso' }, { name: 'Americano' }, { name: 'Türk Kahvesi' }, { name: 'Çay' }, { name: 'Su' }, { name: 'San Sebastian' }]);
    b = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.id}/items/${itemOf(b, 'Espresso').id}/comp`, { reason: 'Müdavim' });
    b = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.id}/items/${itemOf(b, 'Americano').id}/comp`, { kind: 'odenmez', reason: 'Sahibin hesabı', person: { kind: 'user', id: user('Patron').id } });
    b = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.id}/items/${itemOf(b, 'Türk Kahvesi').id}/comp`, { kind: 'odenmez', reason: 'Deneme', person: { kind: 'user', id: user('Garson').id } });
    const customer = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Faz İki Müşterisi' });
    b = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.id}/items/${itemOf(b, 'Çay').id}/comp`, { kind: 'odenmez', reason: 'Şikâyet', person: { kind: 'customer', id: customer.id } });
    b = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.id}/items/${itemOf(b, 'Su').id}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    await pay(b, 'Nakit');
    await close(null);
    p = await payload(dayId);
    await retire(dayId);
  });

  it('satırın liste değeri (indirim öncesi) ve ek işareti; Σ(liste − ciro) = indirim', () => {
    const latte = p.lines.find((l) => l.posName === 'LATTE MEDIUM')!;
    const syrup = p.lines.find((l) => l.posName === 'SYRUP')!;
    expect(latte).toMatchObject({ qty: 2, gross: 390, isAddon: false });
    expect(syrup).toMatchObject({ qty: 1, gross: 50, isAddon: true, siteMenuId: 'mnu-0080' });
    expect(p.lines.every((l) => typeof l.gross === 'number' && typeof l.isAddon === 'boolean')).toBe(true);
    expect(p.lines.reduce((a, l) => a + (l.gross - l.revenue), 0)).toBeCloseTo(52.5, 2);
    expect(p.z.discounts).toBe(52.5);
  });

  it('Z: liste değeri, ikram/ödenmez/zayi ayrı; ikram + ödenmez + zayi = ciro dışı; ciro = liste − indirim − ikram − ödenmez', () => {
    expect(p.z.ikramTotal).toBe(110);
    expect(p.z.odenmezTotal).toBe(165 + 130 + 60);
    expect(p.z.zayiTotal).toBe(60);
    expect(p.z.ikramTotal + p.z.odenmezTotal + p.z.zayiTotal).toBeCloseTo(p.z.offRevenue, 2);
    expect(p.z.listValue).toBeCloseTo(440 + 290 + 110 + 355, 2);
    expect(p.z.listValue - p.z.discounts - p.z.ikramTotal - p.z.odenmezTotal).toBeCloseTo(p.z.zTotal, 2);
    expect(p.lines.reduce((a, l) => a + l.revenue, 0)).toBeCloseTo(p.z.zTotal, 2);
  });

  it('KDV dökümü oran başına (matrah + KDV = ciro); açılış ve kapanış anı ISO', () => {
    expect(p.z.vat).toEqual([{ rate: 10, base: expect.any(Number), vat: expect.any(Number) }]);
    expect(p.z.vat.reduce((a, v) => a + v.base + v.vat, 0)).toBeCloseTo(p.z.zTotal, 2);
    expect(p.z.openedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(p.z.closedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(p.z.okcZNo).toBeNull();
  });

  it('ikramın türü ve ödenmezin kişi türü (patron, personel, müşteri); kişi ve kimlik gitmez', () => {
    const kinds = p.ikram.map((i) => [i.posName, i.kind, i.personKind]);
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['ESPRESSO MEDIUM', 'ikram', null],
        ['AMERİCANO MEDIUM', 'odenmez', 'patron'],
        ['TÜRK KAHVESİ MEDIUM', 'odenmez', 'personel'],
        ['ÇAY MEDIUM', 'odenmez', 'musteri'],
        ['SU', 'zayi', null],
      ]),
    );
    // Nedenin öneki kalır (eski lafmaliyet türü bundan okur)
    expect(p.ikram.find((i) => i.posName === 'SU')!.reason).toBe('Zayi: Döküldü');
    const text = JSON.stringify(p);
    for (const secret of ['Patron', 'Garson', 'Faz İki', user('Patron').id, user('Garson').id]) expect(text).not.toContain(secret);
  });
});

describe('iptaller, iadeler ve yazarkasadan geçmeyen', () => {
  let p: Payload;
  beforeAll(async () => {
    const dayId = await openDay();
    // Hazırlanmadan iptal (bar başlamadı) ve hazırlandıktan sonra iptal (bar başladı); ek parçasıyla
    let a = await sell([{ name: 'Mocha', size: 'M', options: [{ itemId: option('extraShot', 'extraShot').id, qty: 1 }] }, { name: 'Cappuccino', size: 'M' }, { name: 'Espresso' }]);
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: [itemOf(a, 'Mocha').id], status: 'hazirlaniyor' });
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Mocha').id}/void`, { reason: 'Yanlış ürün' });
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Cappuccino').id}/void`, { reason: 'Vazgeçti' });
    await pay(a, 'Nakit');
    // Kalem iadesi: kartla ödenen iki Latte'den biri iade; kalan yeniden yazılır, iade net ₺195
    const b = await sell([{ name: 'Latte', size: 'M', qty: 2 }]);
    await pay(b, 'Kredi kartı');
    await h.ok('mudur', 'POST', `/orders/${b.id}/refund-items`, { items: [{ itemId: b.items[0]!.id, qty: 1 }], reason: 'Soğuk geldi' });
    // Ödeme iptali (tür değişti): nakit iptal, kartla yeniden
    const c = await sell([{ name: 'Çay' }]);
    await pay(c, 'Nakit');
    // Kör kasada kapanan adisyonun ödemeleri gizli: ödeme kimliği müdürün dökümünden
    const paid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${c.id}`);
    const reopened = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${c.id}/payments/${paid.payments[0]!.id}/refund`, { reason: 'Kartla ödeyecek' });
    // Yazarkasadan geçen kart satışı (cihaz fişi) ve geçmeyen
    await pay(reopened, 'Kredi kartı');
    const d = await sell([{ name: 'San Sebastian' }]);
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${d.id}/send`, { items: null });
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    await close(null);
    p = await payload(dayId);
    await retire(dayId);
  });

  it('iptal: hazırlanan ve hazırlanmayan, ek ayrı parça; liste değeri adet × birim fiyat', () => {
    const rows = p.iptal.map((r) => [r.posName, r.qty, r.listValue, r.prepared, r.reason, r.refund]);
    expect(rows).toEqual(
      expect.arrayContaining([
        ['MOCHA MEDIUM', 1, 245, true, 'Yanlış ürün', false],
        ['EXTRA SHOT', 1, 50, true, 'Yanlış ürün', false],
        ['CAPPUCCİNO MEDIUM', 1, 195, false, 'Vazgeçti', false],
      ]),
    );
    expect(p.iptal.find((r) => r.posName === 'EXTRA SHOT')).toMatchObject({ siteMenuId: 'mnu-0081', slot: 'M' });
  });

  it('kalem iadesi iptalde iade işaretiyle; iadeler yeniden yazılan ödemeyi düşer, tür adıyla (kişi yok)', () => {
    expect(p.iptal.find((r) => r.refund)).toMatchObject({ posName: 'LATTE MEDIUM', qty: 1, listValue: 195, reason: 'İade: Soğuk geldi' });
    expect(p.refunds).toEqual(
      expect.arrayContaining([
        { amount: 195, zField: 'card', name: 'Kredi kartı', channel: null, reason: 'İade: Soğuk geldi' },
        { amount: 60, zField: 'cash', name: 'Nakit', channel: null, reason: 'Kartla ödeyecek' },
      ]),
    );
    expect(p.refunds).toHaveLength(2);
    expect(JSON.stringify(p.refunds)).not.toContain('Müdür');
  });

  it('yazarkasadan geçmeyen kart ve nakit (bahşiş hariç); yazarkasanın Z no metin', () => {
    // Cihazdan geçen San Sebastian dışındaki satışlar LafPOS'ta alındı
    expect(p.offDevice).toEqual({ card: 195 + 60, cash: 110 });
    expect(p.z.okcZNo).toEqual(expect.stringMatching(/^\d+$/));
  });
});

describe('gönderim sırası ve düzeltme', () => {
  it('her gönderim bir artar; yeniden sayım ve yeniden açılış düzeltmedir, nedeniyle; Pavo yeniden gönderimi düzeltme değil', async () => {
    const m = await mods();
    const dayId = await openDay();
    await pay(await sell([{ name: 'Espresso' }]), 'Nakit');
    await close(60000);
    await m.lm.flushOutbox();
    const first = posts.filter((x) => x.date === businessDate(Date.now())).at(-1)!;
    expect(first.revision).toBe(1);
    expect(first).not.toHaveProperty('correction');
    // Sayımı değiştirmek (yetkili): düzeltme
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 61000 });
    await m.lm.flushOutbox();
    const second = posts.filter((x) => x.date === first.date).at(-1)!;
    expect(second.revision).toBe(2);
    expect(second.correction).toEqual({ kind: 'recount', reason: 'Kasa sayımı değiştirildi: ₺600,00 → ₺610,00' });
    // Düzeltme ulaştı: sonraki gövde (önizleme) yeni sıradır, düzeltme taşımaz
    expect(m.lm.buildDayPayload(dayId).revision).toBe(3);
    expect(m.lm.buildDayPayload(dayId)).not.toHaveProperty('correction');
    // Günü yeniden açmak (neden saklanır) ve kapatmak: düzeltme yeniden açılış
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/reopen`, { reason: 'Geç gelen masa' });
    await pay(await sell([{ name: 'Çay' }]), 'Nakit');
    await close(66000);
    await m.lm.flushOutbox();
    const third = posts.filter((x) => x.date === first.date).at(-1)!;
    expect(third.revision).toBe(3);
    expect(third.correction).toEqual({ kind: 'reopen', reason: 'Geç gelen masa' });
    // Pavo gün sonu sonucu gelince gün yeniden gider: yeni sıra, düzeltme değil (yeniden açılış bir önceki gövdeyle ulaştı)
    m.settings.setSyncState(`pavo.eod.${dayId}`, { status: 'failed', batchNo: null, at: Date.now(), grandTotalKurus: null, dayCardKurus: null, message: 'Günsonu alınamadı', errorCode: '5085', acquirers: [] });
    m.lm.enqueueDay(dayId);
    await m.lm.flushOutbox();
    const fourth = posts.filter((x) => x.date === first.date).at(-1)!;
    expect(fourth.revision).toBe(4);
    expect(fourth).not.toHaveProperty('correction');
    expect(fourth.bankPos).toMatchObject({ status: 'failed', errorCode: '5085' });
    // Elle "Gönder" de düzeltme değil
    await h.ok('mudur', 'POST', `/sync/lafmaliyet/gun/${dayId}/push`);
    const fifth = posts.filter((x) => x.date === first.date).at(-1)!;
    expect(fifth.revision).toBe(5);
    expect(fifth).not.toHaveProperty('correction');
    // Sonra yeniden sayım: yeni düzeltme, yalnız bir kez
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 66500 });
    await m.lm.flushOutbox();
    const sixth = posts.filter((x) => x.date === first.date).at(-1)!;
    expect(sixth).toMatchObject({ revision: 6, correction: { kind: 'recount', reason: 'Kasa sayımı değiştirildi: ₺660,00 → ₺665,00' } });
    m.lm.enqueueDay(dayId);
    await m.lm.flushOutbox();
    expect(posts.filter((x) => x.date === first.date).at(-1)).not.toHaveProperty('correction');
    await retire(dayId);
  });

  it('yanıtı beklenen gönderim sırasında gün yeniden kuyruğa girerse: yoldaki kayıt silinmez, sıra tekrar etmez, düzeltme bir kez gider', async () => {
    const m = await mods();
    const start = posts.length;
    const dayId = await openDay();
    await pay(await sell([{ name: 'Espresso' }]), 'Nakit');
    await close(60000);
    await m.lm.flushOutbox();
    const date = posts.at(-1)!.date;
    // Sayım düzeltmesi gönderilirken lafmaliyet yanıtı bekletir (en çok 15 sn); bu arada Pavo'nun sonucu gelir
    let arrived!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (arrived = r));
    hold = { arrived, release: new Promise<void>((r) => (release = r)) };
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 61000 });
    await reached;
    m.settings.setSyncState(`pavo.eod.${dayId}`, { status: 'ok', batchNo: '0042', at: Date.now(), grandTotalKurus: 0, dayCardKurus: 0, message: null, acquirers: [] });
    m.lm.enqueueDay(dayId);
    release();
    await m.lm.flushOutbox();
    const sent = posts.slice(start).filter((x) => x.date === date);
    expect(sent.map((x) => x.revision)).toEqual([1, 2, 3]);
    expect(sent[1]!.correction).toEqual({ kind: 'recount', reason: 'Kasa sayımı değiştirildi: ₺600,00 → ₺610,00' });
    expect(sent[2]).not.toHaveProperty('correction');
    expect(sent[2]!.bankPos).toMatchObject({ status: 'ok', batchNo: '0042' });
    // Yoldaki kayıt 200 aldı: gönderildi sayılır, kuyrukta bekleyen kalmaz
    const rows = m.db.select().from(m.schema.outbox).where(m.eq(m.schema.outbox.dedupeKey, `gun:${date}`)).all();
    expect(rows.map((r) => r.sentAt != null)).toEqual([true, true, true]);
    expect(rows.map((r) => (r.payload as Payload).revision)).toEqual([1, 2, 3]);
    await retire(dayId);
  });

  it('yoldaki gönderim gidemezse: yerine yenisi girdiyse ya da gün yeniden açıldıysa atılır, eski gövde sonra gitmez', async () => {
    const m = await mods();
    const dayId = await openDay();
    await pay(await sell([{ name: 'Espresso' }]), 'Nakit');
    await close(60000);
    await m.lm.flushOutbox();
    const key = `gun:${posts.at(-1)!.date}`;
    const rows = () => m.db.select().from(m.schema.outbox).where(m.eq(m.schema.outbox.dedupeKey, key)).all();
    const holdNext = (status: number) => {
      let arrived!: () => void;
      let release!: () => void;
      const reached = new Promise<void>((r) => (arrived = r));
      hold = { arrived, release: new Promise<void>((r) => (release = r)), status };
      return { reached, release: () => release() };
    };
    // Sayım düzeltmesi yoldayken Pavo'nun sonucu kuyruğa girer, yoldaki 503 alır: atılır, yenisi düzeltmeyle 2. sıra
    let held = holdNext(503);
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 61000 });
    await held.reached;
    m.lm.enqueueDay(dayId);
    held.release();
    await m.lm.flushOutbox();
    expect(rows().map((r) => [r.sentAt != null, (r.payload as Payload).revision, (r.payload as Payload).correction?.kind ?? null])).toEqual([
      [true, 1, null],
      [true, 2, 'recount'],
    ]);
    // Gönderim yoldayken gün yeniden açılır, yoldaki 503 alır: atılır (gün açıkken eski Z gitmez)
    held = holdNext(503);
    m.lm.enqueueDay(dayId);
    void m.lm.flushOutbox();
    await held.reached;
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/reopen`, { reason: 'Geç gelen masa' });
    held.release();
    await m.lm.flushOutbox();
    expect(rows().filter((r) => r.sentAt == null)).toEqual([]);
    // Gün yeniden kapanınca yeni gövde: 3. sıra, yeniden açılış düzeltmesiyle
    await close(60000);
    await m.lm.flushOutbox();
    expect(posts.at(-1)).toMatchObject({ revision: 3, correction: { kind: 'reopen', reason: 'Geç gelen masa' } });
    await retire(dayId);
  });

  it('aynı tutarla yeniden kaydedilen sayım (yalnız föy notu ya da döküm) düzeltme değil; önceki düzeltme kalır', async () => {
    const m = await mods();
    const dayId = await openDay();
    await pay(await sell([{ name: 'Espresso' }]), 'Nakit');
    await close(60000);
    // Föyün notu sayımla birlikte kaydedilir: tutar aynıyken lafmaliyet'e giden gün düzeltilmiş sayılmaz
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 60000, note: 'Föy notu' });
    expect(m.lm.buildDayPayload(dayId)).not.toHaveProperty('correction');
    // Gerçek değişiklikten sonra aynı tutarla yeniden kaydetmek onun nedenini ezmez
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 61000 });
    await h.ok('mudur', 'POST', `/cash/days/${dayId}/count`, { countedCash: 61000, note: 'İkinci not' });
    expect(m.lm.buildDayPayload(dayId).correction).toEqual({ kind: 'recount', reason: 'Kasa sayımı değiştirildi: ₺600,00 → ₺610,00' });
    await retire(dayId);
  });
});

describe('neden sınırı', () => {
  it('ikram, iptal ve iade nedenleri öneki dahil en çok 200 karakter', async () => {
    const dayId = await openDay();
    const long = 'x'.repeat(200);
    let a = await sell([{ name: 'Americano' }, { name: 'Su' }, { name: 'Çay' }, { name: 'Espresso' }]);
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Americano').id}/comp`, { kind: 'odenmez', reason: long, person: { kind: 'user', id: user('Garson').id } });
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Su').id}/comp`, { kind: 'zayi', reason: long });
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Çay').id}/void`, { reason: long });
    await pay(a, 'Nakit');
    await close(null);
    const p = await payload(dayId);
    const reasons = [...p.ikram.map((i) => i.reason), ...p.iptal.map((i) => i.reason)];
    expect(reasons).toHaveLength(3);
    for (const r of reasons) expect(r!.length).toBeLessThanOrEqual(200);
    expect(p.ikram.map((i) => i.reason!.slice(0, 9))).toEqual(expect.arrayContaining(['Ödenmez: ', 'Zayi: xxx']));
    await retire(dayId);
  });
});

describe('eski Z', () => {
  it('ödenmez, zayi ve yazarkasadan geçmeyen olmayan saklı Z yine geçerli gövde verir', async () => {
    const m = await mods();
    const dayId = await openDay();
    let a = await sell([{ name: 'Latte', size: 'M' }, { name: 'Su' }]);
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/items/${itemOf(a, 'Su').id}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    await pay(a, 'Kredi kartı');
    await close(null);
    const row = m.db.select().from(m.schema.businessDays).where(m.eq(m.schema.businessDays.id, dayId)).get()!;
    const { odenmez: _o, zayi: _z, offDevice: _d, odenmezPeople: _p, ...old } = row.summary!;
    m.db.update(m.schema.businessDays).set({ summary: old as never }).where(m.eq(m.schema.businessDays.id, dayId)).run();
    const p = await payload(dayId);
    expect(p.offDevice).toEqual({ card: 195, cash: 0 });
    expect(p.z).toMatchObject({ zayiTotal: 60, odenmezTotal: 0, ikramTotal: 0, offRevenue: 60, listValue: 195, zTotal: 195 });
    await retire(dayId);
  });
});

describe('şube kimliği kilidi', () => {
  it('lafmaliyet bir günü kabul ettikten sonra şube kimliği yalnız patronun onayıyla değişir; denetimde uyarı', async () => {
    const m = await mods();
    // Önceki testlerde günler 200 aldı: kilitli; Yönetim › Ayarlar kilidi alanın altında gösterir (kabul edilen şubeyle)
    expect(await h.ok('mudur', 'GET', '/admin/settings/branch-lock')).toEqual({ locked: true, branchId: 'marina', acceptedBranch: 'marina' });
    const locked = await h.call<{ code: string; error: string }>('patron', 'PUT', '/admin/settings', { branchId: 'tuzla' });
    expect(locked.status).toBe(409);
    expect(locked.json.code).toBe('branch_locked');
    expect(locked.json.error).toContain('marina');
    expect(m.settings.getSettings().branchId).toBe('marina');
    // Aynı değeri yeniden göndermek (bütün form) serbest
    expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'marina', businessName: "L'Affogato" })).status).toBe(200);
    // Müdür onaylasa da değiştiremez (patron ayarı)
    expect((await h.call('mudur', 'PUT', '/admin/settings', { branchId: 'tuzla', confirmBranchChange: true })).status).toBe(403);
    const ok = await h.call<{ branchId: string }>('patron', 'PUT', '/admin/settings', { branchId: 'tuzla', confirmBranchChange: true });
    expect(ok.status).toBe(200);
    expect(ok.json.branchId).toBe('tuzla');
    const audit = (await h.ok<{ action: string; severity: string; message: string; data: Record<string, unknown> | null }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=50')).find((a) => a.action === 'settings.branchId')!;
    expect(audit).toMatchObject({ severity: 'uyari', data: { from: 'marina', to: 'tuzla', locked: true } });
    // Onay alanı ayar olarak saklanmaz, denetimde ayar adı olarak geçmez
    expect(JSON.stringify(m.settings.getSettings())).not.toContain('confirmBranchChange');
    // Kilit lafmaliyet'in kabul ettiği şubeyi söyler, şu anki kimliği değil (tuzla'ya hiç gün gitmedi)
    expect(await h.ok('patron', 'GET', '/admin/settings/branch-lock')).toEqual({ locked: true, branchId: 'tuzla', acceptedBranch: 'marina' });
    const again = await h.call<{ code: string; error: string }>('patron', 'PUT', '/admin/settings', { branchId: 'kadikoy' });
    expect(again.status).toBe(409);
    expect(again.json.error).toContain('"marina" şubesine kaydetti');
    expect(again.json.error).not.toContain('"tuzla" şubesine');
    // Kabul edilen şubeye geri dönmek onay istemez
    expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'marina' })).status).toBe(200);
    expect(m.settings.getSettings().branchId).toBe('marina');
  });

  it('hiç gün gönderilmemişse kilit yok', async () => {
    const m = await mods();
    m.db.delete(m.schema.outbox).run();
    m.settings.setSyncState('lafmaliyet.push', {});
    expect(await h.ok('patron', 'GET', '/admin/settings/branch-lock')).toEqual({ locked: false, branchId: 'marina', acceptedBranch: null });
    // Kilit durumu yalnız ayar yetkisiyle (kasiyer ayar ekranını görmez)
    expect((await h.call('kasa', 'GET', '/admin/settings/branch-lock')).status).toBe(403);
    expect((await h.call('patron', 'PUT', '/admin/settings', { branchId: 'tuzla' })).status).toBe(200);
    m.settings.updateSettings({ branchId: 'marina' });
  });
});
