import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { normalizePosName, posNameKey, posNameOf } from '@shared/pos-name';
import { businessDate, staleDayMessage } from '@shared/time';
import type { OrderDTO, SelectedOption } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * lafmaliyet gün sonu paketi (`POST /api/pos/gun`, docs/03-ENTEGRASYON.md §4): POS adı kuralı, günde bir ada bir
 * satır, ekler koda göre (laktozsuz süt 0 TL), ikram ekleri ve yalnız kapanmış adisyonların ikramı, kartla bahşiş ve
 * kartla cari tahsilatı, dünden açık kalan güne satış engeli, yönetimin doğrulamaları. Altın gövde
 * (tests/fixtures/lafmaliyet-gun.golden.json) iki deponun ortak sözleşme örneğidir: lafmaliyet aynı dosyayı kendi
 * ayrıştırıcısıyla okur. Gövde değişirse bilerek yeniden üretilir: ASILPOS_GOLDEN=1 npx vitest run tests/lafmaliyet-gun.test.ts
 */
const GOLDEN = new URL('./fixtures/lafmaliyet-gun.golden.json', import.meta.url);
/** Aynı gün, personel bağlantısıyla (§4.8 `workedStaffRefs`): ikinci ortak örnek, lafmaliyet aynı dosyayı okur */
const GOLDEN_STAFF = new URL('./fixtures/lafmaliyet-gun-personel.golden.json', import.meta.url);
const GOLDEN_DATE = '2026-10-26';
let goldenDayId = '';

let h: Harness;
let modules: {
  db: typeof import('../server/db/client').db;
  schema: typeof import('../server/db/client').schema;
};

beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true }); // bahşiş testleri: ayar açık kurulum ve eski veri
  const client = await import('../server/db/client');
  modules = { db: client.db, schema: client.schema };
});
afterAll(() => h.cleanup());

type Line = { posName: string; siteMenuId: string | null; slot: 'M' | 'L' | null; qty: number; revenue: number; gross: number; isService: boolean; isAddon: boolean; listPrices?: { price: number; qty: number }[] };
type Ikram = { posName: string; siteMenuId: string | null; slot: 'M' | 'L' | null; qty: number; menuValue: number; reason: string | null; kind: string; personKind: string | null };
type Payload = {
  revision: number;
  correction?: { kind: string; reason: string };
  bankPos?: Record<string, unknown>;
  /** Kasanın şubesi (docs/03-ENTEGRASYON.md §4) */
  sube: string;
  date: string;
  z: Record<string, number | null> & { vat?: { rate: number; base: number; vat: number }[]; okcZNo?: string | null; openedAt?: string; closedAt?: string | null };
  lines: Line[];
  ikram: Ikram[];
  payments: { name: string; zField: string; channel: string | null; count: number; amount: number; kind: string }[];
  offDevice: { card: number; cash: number; cardTips: number };
  refunds: { amount: number; zField: string; name: string; channel: string | null; reason: string | null }[];
  iptal: { posName: string; qty: number; listValue: number; prepared: boolean; reason: string | null; refund: boolean }[];
  cashMoves: { id: string; kind: string; amount: number; description: string; at: string; categoryId: number | null; recipient?: string }[];
  /** Gün sonu tamlığı (docs/03-ENTEGRASYON.md §4.9) */
  okc?: { provider: string; zReport: boolean; docs: number; cash: number; card: number; mealCard: number; other: number; total: number; voided: { count: number; cash: number; card: number }; vat: unknown[] | null };
  collections: { name: string; zField: string; channel: string | null; kind: string; count: number; amount: number }[];
  shiftCounts: { at: string; counted: number; expected: number; diff: number; confirmed: boolean }[];
  discountLines: { scope: string; posName: string | null; type: string; value: number; amount: number; reason: string | null }[];
};

const product = (name: string) => {
  const p = h.boot.products.find((x) => x.name === name);
  if (!p) throw new Error(`Ürün yok: ${name}`);
  return p;
};
const option = (groupKey: string, code: string) => h.boot.optionGroups.find((g) => g.extKey === groupKey)!.items.find((i) => i.code === code)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;

type Pick = { name: string; size?: 'M' | 'L'; qty?: number; options?: { itemId: string; qty?: number }[] };
async function sell(items: Pick[], type: 'tezgah' | 'masa' = 'tezgah', tableId?: string) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', type === 'masa' ? { type, tableId } : { type });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}), ...(i.options ? { options: i.options } : {}) })),
  });
}
const pay = (o: OrderDTO, methodName: string, extra: Record<string, unknown> = {}) =>
  h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(methodName).id, amount: o.total - o.paid, ...extra });
const comp = (o: OrderDTO, itemName: string, reason: string, extra: Record<string, unknown> = {}) =>
  h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items.find((i) => i.name === itemName && !i.complimentary)!.id}/comp`, { reason, ...extra });
const itemOf = (o: OrderDTO, name: string) => o.items.find((i) => i.name === name && !i.voided && !i.complimentary)!;
const voidItem = (o: OrderDTO, name: string, reason: string) => h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${itemOf(o, name).id}/void`, { reason });

function openDayRow() {
  const { db, schema } = modules;
  return db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get();
}

/** Yeni, boş bir iş günü: açık gün varsa kapatır, kapanan günleri geçmişe taşır (bir tarihe tek Z kuralı) */
let past = 0;
async function freshDay() {
  const { db, schema } = modules;
  if (openDayRow()) await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
  db.update(schema.businessDays)
    .set({ date: `2026-09-${String(++past).padStart(2, '0')}` })
    .where(eq(schema.businessDays.date, businessDate(Date.now())))
    .run();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
  return openDayRow()!;
}
const payloadOf = (dayId: string) => h.ok<Payload>('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);

describe('altın gövde (iki boy, ek, ikram, karaoke, cari, bahşiş; indirim, iptal, ödenmez, zayi, iade, yazarkasa, yeniden açılış)', () => {
  it('tohumlanmış günün paketi dosyayla bayt bayt aynı', async () => {
    const { db, schema } = modules;
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 150000 });
    const day = openDayRow()!;
    expect(day.zNo).toBe(1);

    const table = h.boot.tables.find((t) => t.kind === 'masa')!;
    // Masa: iki boy Latte (yulaf + vanilya; laktozsuz + ekstra shot), Türk kahvesi; kartla, bahşişli
    const masa = await sell(
      [
        { name: 'Latte', size: 'M', qty: 2, options: [{ itemId: option('milk', 'oat').id }, { itemId: option('syrup', 'vanilla').id }] },
        { name: 'Latte', size: 'L', options: [{ itemId: option('milk', 'lactose-free').id }, { itemId: option('extraShot', 'extraShot').id, qty: 1 }] },
        { name: 'Türk Kahvesi' },
      ],
      'masa',
      table.id,
    );
    expect((await pay(masa, 'Kredi kartı', { tip: 2500 })).closed).toBe(true);

    // Tezgâh: ekstra shot'lı Espresso ikram (ekiyle), Americano L, yenilebilir bardak; nakit
    let tezgah = await sell([
      { name: 'Espresso', size: 'M', options: [{ itemId: option('extraShot', 'extraShot').id, qty: 1 }] },
      { name: 'Americano', size: 'L' },
      { name: 'Yenilebilir bardak' },
    ]);
    tezgah = await comp(tezgah, 'Espresso', 'Müdavim');
    expect((await pay(tezgah, 'Nakit', { given: 50000 })).closed).toBe(true);

    // Yemek kartı (Pluxee): komisyon kanalı pakette
    const yemek = await sell([{ name: 'San Sebastian' }]);
    expect((await pay(yemek, 'Pluxee')).closed).toBe(true);

    // Karaoke odası açık hesaba; sonra aynı müşteriden kartla tahsilat
    const customer = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Altın Gövde Müşterisi' });
    const room = h.boot.tables.find((t) => t.kind === 'oda')!;
    const oda = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    await h.ok('kasa', 'POST', `/orders/${oda.id}/room/start`, {});
    const stopped = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${oda.id}/room/stop`, {});
    expect((await h.ok<{ closed: boolean }>('mudur', 'POST', `/orders/${oda.id}/payments`, { methodId: method('Açık hesap').id, amount: stopped.total, customerId: customer.id })).closed).toBe(true);
    await h.ok('mudur', 'POST', '/cash/collect', { customerId: customer.id, methodId: method('Kredi kartı').id, amount: 40000 });

    // İptal edilen adisyonun ikramı tüketim değil: pakete girmez
    let iptal = await sell([{ name: 'Mocha', size: 'M' }]);
    iptal = await comp(iptal, 'Mocha', 'Tadım');
    await h.ok('mudur', 'POST', `/orders/${iptal.id}/cancel`, { reason: 'Vazgeçti' });

    // Faz 2 alanları (docs/hesap-sozlesmesi.md): adisyon indirimi; bar başladıktan sonra iptal (hazırlanmış) ve
    // başlamadan iptal; kartla
    let indirimli = await sell([{ name: 'Cappuccino', size: 'M' }, { name: 'Filtre Kahve', size: 'M' }, { name: 'Cool Lime', size: 'M' }, { name: 'Soda' }]);
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: [itemOf(indirimli, 'Cool Lime').id], status: 'hazirlaniyor' });
    indirimli = await voidItem(indirimli, 'Cool Lime', 'Yanlış ürün');
    indirimli = await voidItem(indirimli, 'Soda', 'Fazla yazıldı');
    indirimli = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${indirimli.id}/discount`, { type: 'amount', value: 3600, reason: 'Müdavim' });
    await pay(indirimli, 'Kredi kartı');
    // Kişili ödenmez (personel yemeği, patronun ürün denemesi) ve zayi; satılan Çay nakit
    let odenmez = await sell([{ name: 'Türk Kahvesi' }, { name: 'Brownie' }, { name: 'Su' }, { name: 'Çay', size: 'M' }]);
    const user = (name: string) => h.boot.users.find((u) => u.name === name)!;
    odenmez = await comp(odenmez, 'Türk Kahvesi', 'Personel yemeği', { kind: 'odenmez', person: { kind: 'user', id: user('Garson').id } });
    odenmez = await comp(odenmez, 'Brownie', 'Deneme', { kind: 'odenmez', person: { kind: 'user', id: user('Patron').id } });
    odenmez = await comp(odenmez, 'Su', 'Döküldü', { kind: 'zayi' });
    expect((await pay(odenmez, 'Nakit')).closed).toBe(true);
    // Kalem iadesi (kartla ödenen iki Latte'den biri; kalan yeniden yazılır) ve ödeme iptali (nakit → kart)
    const iade = await sell([{ name: 'Latte', size: 'M', qty: 2 }]);
    await pay(iade, 'Kredi kartı');
    await h.ok('mudur', 'POST', `/orders/${iade.id}/refund-items`, { items: [{ itemId: iade.items[0]!.id, qty: 1 }], reason: 'Soğuk geldi' });
    const tur = await sell([{ name: 'Su' }]);
    await pay(tur, 'Nakit');
    const turPaid = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${tur.id}`);
    await pay(await h.ok<OrderDTO>('mudur', 'POST', `/orders/${tur.id}/payments/${turPaid.payments[0]!.id}/refund`, { reason: 'Kartla ödeyecek' }), 'Kredi kartı');
    // Yazarkasadan (eğitim cihazı) geçen kart satışı: öteki ödemeler yazarkasadan geçmeyen
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
    const cihaz = await sell([{ name: 'Tiramisu' }]);
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${cihaz.id}/send`, { items: null });
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });

    // Gün kapandı, geç gelen müşteri için yeniden açıldı (neden gövdenin düzeltmesi), bir satış daha
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    await h.ok('mudur', 'POST', `/cash/days/${day.id}/reopen`, { reason: 'Geç gelen masa' });
    expect((await pay(await sell([{ name: 'Espresso', size: 'L' }]), 'Nakit', { tip: 500 })).closed).toBe(true);

    // Kasa hareketleri satır satır (cashMoves): lafmaliyet'in personel kategorisiyle harcama (son çekilen liste), teslim,
    // giriş. Kimlik ve an saatten bağımsız olsun diye sabitlenir
    const { setSyncState } = await import('../server/lib/settings');
    setSyncState('lafmaliyet.expenseCategories', {
      at: Date.parse('2026-10-26T08:00:00+03:00'),
      attemptAt: Date.parse('2026-10-26T08:00:00+03:00'),
      items: [
        { id: 1, name: 'Nakit malzeme alımı', section: 'mal' },
        { id: 2, name: 'Bakım & onarım', section: 'genel' },
        { id: 3, name: 'Diğer fatura dışı', section: 'genel' },
      ],
    });
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'harcama', amount: 12000, description: 'Buz', categoryId: 1 });
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'teslim', amount: 20000, description: 'Patrona teslim', recipientName: 'Patron' });
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'giris', amount: 5000, description: 'Bozuk para' });
    const moves = db.select().from(schema.cashMovements).where(eq(schema.cashMovements.dayId, day.id)).all().sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    const fixed = [
      ['01M5WDWP40S3V9J8M2N4P6Q8T0', '2026-10-26T18:40:00+03:00'],
      ['01M5WFAEZ0X2Y4Z6A8B0C2D4E6', '2026-10-26T19:05:00+03:00'],
      ['01M5WG5XW0F0G2H4J6K8M0N2P4', '2026-10-26T19:20:00+03:00'],
    ] as const;
    moves.forEach((m, i) => db.update(schema.cashMovements).set({ id: fixed[i]![0], createdAt: Date.parse(fixed[i]![1]) }).where(eq(schema.cashMovements.id, m.id)).run());
    const x = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    // Vardiya sayımı (₺5,00 eksik); anı saatten bağımsız
    await h.ok('mudur', 'POST', '/cash/shift-counts', { countedCash: x.summary.expectedCash - 500 });
    db.update(schema.shiftCounts).set({ createdAt: Date.parse('2026-10-26T19:30:00+03:00') }).where(eq(schema.shiftCounts.dayId, day.id)).run();
    // Paket tarihi saatten bağımsız olsun: satışlar bugünün gününe yazılır (eski güne satış engeli), gün kapanmadan
    // hemen önce sabit bir iş gününe alınır. Gün sonu eski günde de alınır; kapanış ve paket bu tarihi görür.
    db.update(schema.businessDays).set({ date: GOLDEN_DATE }).where(eq(schema.businessDays.id, day.id)).run();
    // Gün sonu: föyde kredi kartı slipi yazıldı, gün sonu notu
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash - 1000, cashCounts: { [`m:${method('Kredi kartı').id}`]: 128500 }, note: 'Geç kapanış' });
    // Yazarkasadan geçen satış Pavo'nun belgesi (gerçek cihaz; eğitim cihazı Pavo gibi fiş kesti): gövdede `okc`
    db.update(schema.fiscalReceipts).set({ provider: 'pavo' }).where(eq(schema.fiscalReceipts.orderId, cihaz.id)).run();
    // Açılış ve kapanış anı ile banka gün sonu saatten bağımsız: sabit anlar (gövde bayt bayt aynı kalsın). Kasa zinciri:
    // gün kurulum modunda açıldı (önceki gerçek gün yok, beklenen boş); örnek gövde beklenenli bir açılışı gösterir
    // (önceki günün devri ₺1.400,00, açılış ₺1.500,00, fark +₺100,00 ve nedeni; services/devir.ts)
    db.update(schema.businessDays)
      .set({
        openedAt: Date.parse('2026-10-26T07:58:00+03:00'),
        closedAt: Date.parse('2026-10-27T00:12:00+03:00'),
        expectedOpening: 140000,
        openingDiff: 10000,
        openingReason: 'Sabah bozuk para eklendi',
      })
      .where(eq(schema.businessDays.id, day.id))
      .run();
    setSyncState(`pavo.eod.${day.id}`, {
      status: 'failed',
      batchNo: null,
      at: Date.parse('2026-10-27T00:14:00+03:00'),
      grandTotalKurus: null,
      dayCardKurus: null,
      message: 'Gün sonu alınamadı',
      errorCode: '5085',
      acquirers: [],
      trigger: 'otomatik',
      dayClosed: true,
      // Gün içinde elle alınmış banka gün sonu (gövdede `bankPos.batches`)
      earlier: [{ batchNo: '000278', deviceDateTime: null, grandTotalKurus: 24000, at: Date.parse('2026-10-26T15:10:00+03:00'), trigger: 'elle', dayClosed: false }],
    });

    goldenDayId = day.id;
    const payload = await payloadOf(day.id);
    // Hiçbir kullanıcı lafmaliyet personeline bağlı değil: alan yok, gövde bağlantıdan önceki baytlarla aynı (§4.8)
    expect('workedStaffRefs' in payload).toBe(false);
    if (process.env.ASILPOS_GOLDEN === '1') {
      mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
      writeFileSync(GOLDEN, `${JSON.stringify(payload, null, 2)}\n`);
    }
    expect(existsSync(GOLDEN)).toBe(true);
    expect(`${JSON.stringify(payload, null, 2)}\n`).toBe(readFileSync(GOLDEN, 'utf8'));

    // Altın gövdenin kendi tutarlılığı (lafmaliyet'in kuralları; docs/hesap-sozlesmesi.md §5, §6, §11)
    const z = payload.z;
    const names = payload.lines.map((l) => l.posName);
    expect(new Set(names).size).toBe(names.length);
    expect(payload.lines.reduce((a, l) => a + l.revenue, 0)).toBeCloseTo(z.zTotal!, 2);
    expect(payload.lines.reduce((a, l) => a + (l.gross - l.revenue), 0)).toBeCloseTo(z.discounts!, 2);
    expect(z.discounts).toBe(36);
    expect(z.ikramTotal! + z.odenmezTotal! + z.zayiTotal!).toBeCloseTo(z.offRevenue!, 2);
    expect(z.listValue! - z.discounts! - z.ikramTotal! - z.odenmezTotal!).toBeCloseTo(z.zTotal!, 2);
    expect(z.vat!.reduce((a, v) => a + v.base + v.vat, 0)).toBeCloseTo(z.zTotal!, 2);
    expect(z.cash! + z.card! + z.mealCard! + z.online! + z.other!).toBeCloseTo(z.zTotal!, 2);
    expect(payload.ikram.reduce((a, l) => a + l.menuValue, 0)).toBeCloseTo(z.offRevenue!, 2);
    // Yeni alanlar boş değil: sıra, düzeltme, kişi türü (kişi gitmez), iptal (hazırlanmış ve hazırlanmamış, iade),
    // iadeler, yazarkasadan geçen ve geçmeyen, banka gün sonunun hata kodu
    expect(payload.revision).toBe(1);
    expect(payload.correction).toEqual({ kind: 'reopen', reason: 'Geç gelen masa' });
    expect(payload.ikram.map((i) => [i.kind, i.personKind])).toEqual(expect.arrayContaining([['ikram', null], ['odenmez', 'personel'], ['odenmez', 'patron'], ['zayi', null]]));
    expect(new Set(payload.iptal.map((i) => i.prepared))).toEqual(new Set([true, false]));
    expect(payload.iptal.some((i) => i.refund)).toBe(true);
    expect(payload.refunds.map((r) => [r.amount, r.zField])).toEqual([
      [195, 'card'],
      [60, 'cash'],
    ]);
    expect(payload.lines.some((l) => l.isAddon)).toBe(true);
    // Şube fiyatı: satılan her ürün satırı dondurulan liste fiyatlarını taşır; hizmet satırı (oda, servis) taşımaz
    expect(payload.lines.filter((l) => !l.isService).every((l) => l.listPrices?.length)).toBe(true);
    expect(payload.lines.filter((l) => l.isService).map((l) => 'listPrices' in l)).toEqual([false]);
    expect(payload.offDevice.card).toBeGreaterThan(0);
    expect(payload.offDevice.cash).toBeGreaterThan(0);
    expect(payload.offDevice.card).toBeLessThan(z.card!);
    expect(z.okcZNo).toBe('1');
    expect(payload.bankPos).toMatchObject({ status: 'failed', errorCode: '5085' });
    expect(JSON.stringify(payload)).not.toMatch(/Garson|Altın Gövde/);
    expect(payload.ikram.some((i) => i.reason === 'Tadım')).toBe(false);
    expect(payload.z.cardTips).toBe(25);
    expect(payload.z.cardCollections).toBe(400);
    expect(payload.payments.find((p) => p.name === 'Nakit')!.channel).toBeNull();
    expect(payload.payments.find((p) => p.name === 'Pluxee')!.channel).toBe('pluxee');
    const milk = payload.lines.find((l) => l.posName === 'ALTERNATIF SÜT')!;
    expect(milk).toMatchObject({ siteMenuId: 'mnu-0082', slot: 'M', qty: 3 });
    // Kasa zinciri (Faz 3): açılışın beklenen tutarı, farkı ve nedeni; kasa hareketleri satır satır, kişisiz, toplamları Z ile
    expect(z).toMatchObject({ openingCash: 1500, expectedOpening: 1400, openingDiff: 100, openingReason: 'Sabah bozuk para eklendi' });
    expect(payload.cashMoves).toEqual([
      { id: '01M5WDWP40S3V9J8M2N4P6Q8T0', kind: 'harcama', amount: 120, description: 'Buz', at: '2026-10-26T15:40:00.000Z', categoryId: 1 },
      { id: '01M5WFAEZ0X2Y4Z6A8B0C2D4E6', kind: 'teslim', amount: 200, description: 'Patrona teslim', at: '2026-10-26T16:05:00.000Z', categoryId: null, recipient: 'Patron' },
      { id: '01M5WG5XW0F0G2H4J6K8M0N2P4', kind: 'giris', amount: 50, description: 'Bozuk para', at: '2026-10-26T16:20:00.000Z', categoryId: null },
    ]);
    const moved = (k: string) => payload.cashMoves.filter((m) => m.kind === k).reduce((a, m) => a + m.amount, 0);
    expect(moved('harcama')).toBeCloseTo(z.cashOut!, 2);
    expect(moved('teslim')).toBeCloseTo(z.handedOver!, 2);
    expect(moved('giris')).toBeLessThanOrEqual(z.cashIn! + 0.001);
    // Gün sonu tamlığı (§4.9): günün bütün banka gün sonları ve bütün kıyası, yazarkasanın belgeleri, yazarkasadan
    // geçmeyen kartın bahşişi, nakit bahşiş, not, föyde yazılan slip, tahsilatlar, vardiya sayımı, indirim satırları
    expect(payload.bankPos).toMatchObject({ batches: [{ batchNo: '000278', at: '2026-10-26T12:10:00.000Z', total: 240, trigger: 'elle', dayClosed: false }] });
    expect(typeof payload.bankPos!.dayCard).toBe('number');
    const okc = payload.okc!;
    expect(okc).toMatchObject({ provider: 'pavo', zReport: false, docs: 1, voided: { count: 0, cash: 0, card: 0 } });
    expect(okc.card).toBeCloseTo(z.card! - payload.offDevice.card - okc.voided.card, 2);
    expect(okc.cash).toBeCloseTo(z.cash! - payload.offDevice.cash - okc.voided.cash, 2);
    expect(payload.offDevice.cardTips).toBe(25);
    expect(z.cashTips).toBe(5);
    expect(payload.z).toMatchObject({ closeNote: 'Geç kapanış', methodCounts: [{ name: 'Kredi kartı', zField: 'card', channel: null, counted: 1285 }] });
    expect(payload.collections).toEqual([{ name: 'Kredi kartı', zField: 'card', channel: null, kind: 'kart', count: 1, amount: 400 }]);
    expect(payload.shiftCounts).toMatchObject([{ at: '2026-10-26T16:30:00.000Z', diff: -5, confirmed: false }]);
    expect(payload.discountLines).toEqual([{ scope: 'order', posName: null, type: 'amount', value: 36, amount: 36, reason: 'Müdavim' }]);
    expect(payload.payments.map((p) => p.kind)).not.toContain(undefined);
  });

  it('personel bağlantısıyla (ikinci örnek): yalnız workedStaffRefs eklenir, sonda; o gün iş yapan bağlı kişiler, sayı sırasıyla, ad yok', async () => {
    const { db, schema } = modules;
    expect(goldenDayId).not.toBe('');
    const user = (name: string) => h.boot.users.find((u) => u.name === name)!;
    // Kasa ve Müdür o gün satış, ödeme, iptal ve gün sonu yaptı; Garson yalnız ödenmezin kişisi (iş yapmadı); Patron bağsız
    const links: [string, string][] = [
      ['Kasa', 's:12'],
      ['Müdür', 's:7'],
      ['Garson', 's:3'],
    ];
    try {
      for (const [name, ref] of links) db.update(schema.users).set({ staffRef: ref }).where(eq(schema.users.id, user(name).id)).run();
      const payload = await payloadOf(goldenDayId);
      if (process.env.ASILPOS_GOLDEN === '1') writeFileSync(GOLDEN_STAFF, `${JSON.stringify(payload, null, 2)}\n`);
      expect(`${JSON.stringify(payload, null, 2)}\n`).toBe(readFileSync(GOLDEN_STAFF, 'utf8'));
      const golden = JSON.parse(readFileSync(GOLDEN, 'utf8')) as Record<string, unknown>;
      expect(payload).toEqual({ ...golden, workedStaffRefs: ['s:7', 's:12'] });
      expect(Object.keys(payload).at(-1)).toBe('workedStaffRefs');
      expect(JSON.stringify(payload)).not.toMatch(/Kasa"|Müdür|Garson/);
    } finally {
      db.update(schema.users).set({ staffRef: null }).run();
    }
    // Bağlantılar kalkınca yine ilk örnekle bayt bayt aynı
    expect(`${JSON.stringify(await payloadOf(goldenDayId), null, 2)}\n`).toBe(readFileSync(GOLDEN, 'utf8'));
  });
});

describe('POS adı (shared/pos-name.ts)', () => {
  const suffix = { M: 'MEDIUM', L: 'LARGE', TEK: '' };
  it('iki boylu üründe override taban ad, boy eki eklenir; boy eki iki kez yazılmaz', () => {
    const latte = { name: 'Latte', posName: 'LATTE', priceL: 21000 };
    expect(posNameOf(latte, 'M', suffix)).toBe('LATTE MEDIUM');
    expect(posNameOf(latte, 'L', suffix)).toBe('LATTE LARGE');
    expect(posNameOf({ ...latte, posName: 'LATTE  medium' }, 'L', suffix)).toBe('LATTE LARGE');
    expect(posNameOf({ ...latte, posName: null }, 'L', suffix)).toBe('LATTE LARGE');
  });
  it('tek boyda override olduğu gibi; boşluk sadeleşir; boş override yok sayılır', () => {
    expect(posNameOf({ name: 'Su', posName: '  SU   (PET) ', priceL: null }, 'TEK', suffix)).toBe('SU (PET)');
    expect(posNameOf({ name: 'Karaoke odası', posName: '   ', priceL: null }, 'TEK', suffix)).toBe('KARAOKE ODASI');
    expect(normalizePosName('', 'Karaoke odası')).toBe('KARAOKE ODASI');
    expect(normalizePosName('  ', '  ')).toBe('ADSIZ ÜRÜN');
    expect(posNameKey('Iced  latte')).toBe(posNameKey('İCED LATTE'));
  });
});

describe('ekler koda göre (server/sync/lafmaliyet.ts addonsOf)', () => {
  it('laktozsuz süt 0 TL ama alternatif süt; Normal süt ve Şurup yok ek değil; ekstra shot adediyle', async () => {
    const { addonsOf } = await import('../server/sync/lafmaliyet');
    const op = (groupKey: string, code: string | null, price: number, qty = 1): SelectedOption => ({ groupId: 'g', group: groupKey, groupKey, itemId: code ?? 'x', name: code ?? 'x', code, price, qty });
    expect(addonsOf([op('milk', 'lactose-free', 0)])).toEqual([{ key: 'milk', qty: 1, price: 0 }]);
    expect(addonsOf([op('milk', 'normal', 0), op('syrup', 'none', 0), op('roast', 'light', 0), op('sugar', 'sugar', 0, 2)])).toEqual([]);
    expect(addonsOf([op('extraShot', 'extraShot', 5000, 2), op('syrup', 'caramel', 5000)])).toEqual([
      { key: 'extraShot', qty: 2, price: 5000 },
      { key: 'syrup', qty: 1, price: 5000 },
    ]);
  });
});

describe('gün paketi: satırlar ve ikram', () => {
  it('override\'lı iki boylu ürün M + L iki satır; boşluk farkı birleşir', async () => {
    const day = await freshDay();
    const latte = product('Latte');
    await h.ok('patron', 'PATCH', `/admin/products/${latte.id}`, { posName: '  LATTE ' });
    const a = await sell([{ name: 'Latte', size: 'M' }, { name: 'Latte', size: 'L', qty: 2 }]);
    await pay(a, 'Nakit');
    // Eski kalemde boşluklu ad (yönetimde boşluklu yazılmış posName): lafmaliyet'in sadeleştirmesiyle aynı satır
    const b = await sell([{ name: 'Latte', size: 'M' }]);
    modules.db.update(modules.schema.orderItems).set({ posName: ' LATTE   MEDIUM ' }).where(eq(modules.schema.orderItems.orderId, b.id)).run();
    await pay(b, 'Nakit');
    const lines = (await payloadOf(day.id)).lines;
    expect(lines.find((l) => l.posName === 'LATTE MEDIUM')).toMatchObject({ siteMenuId: latte.extId, slot: 'M', qty: 2 });
    expect(lines.find((l) => l.posName === 'LATTE LARGE')).toMatchObject({ siteMenuId: latte.extId, slot: 'L', qty: 2 });
    expect(lines).toHaveLength(2);
    await h.ok('patron', 'PATCH', `/admin/products/${latte.id}`, { posName: null });
  });

  it('aynı ad iki kaleme düşerse ikincisi ayrılır; bağsız (yerel) satır adını korur; günde bir ada bir satır', async () => {
    const { db, schema } = modules;
    const day = await freshDay();
    // Yönetimin çakışma engeli öncesinden kalmış adlar (doğrudan veritabanına)
    const set = (name: string, posName: string) => db.update(schema.products).set({ posName }).where(eq(schema.products.id, product(name).id)).run();
    set('Americano', 'KAHVE');
    set('Espresso', 'KAHVE');
    set('Yenilebilir bardak', 'MOCHA MEDIUM');
    const o = await sell([{ name: 'Americano', size: 'M' }, { name: 'Espresso', size: 'M' }, { name: 'Mocha', size: 'M' }, { name: 'Yenilebilir bardak' }]);
    await pay(o, 'Nakit');
    const lines = (await payloadOf(day.id)).lines;
    const names = lines.map((l) => l.posName);
    expect(new Set(names.map(posNameKey)).size).toBe(names.length);
    const [first, second] = [product('Americano').extId!, product('Espresso').extId!].sort();
    expect(lines.find((l) => l.siteMenuId === first)!.posName).toBe('KAHVE MEDIUM');
    expect(lines.find((l) => l.siteMenuId === second)!.posName).toBe(`KAHVE MEDIUM (${second})`);
    expect(lines.find((l) => l.siteMenuId === null)!.posName).toBe('MOCHA MEDIUM');
    expect(lines.find((l) => l.siteMenuId === product('Mocha').extId)!.posName).toBe(`MOCHA MEDIUM (${product('Mocha').extId})`);
    set('Americano', null as unknown as string);
    set('Espresso', null as unknown as string);
    set('Yenilebilir bardak', 'YENİLEBİLİR BARDAK');
  });

  it('boş oda adı: oda satırı ürünün adına düşer, lafmaliyet boş adı reddetmez', async () => {
    const day = await freshDay();
    const roomProduct = h.boot.products.find((p) => p.isService && p.hidden)!;
    await h.ok('patron', 'PATCH', `/admin/products/${roomProduct.id}`, { posName: '   ' });
    const room = h.boot.tables.find((t) => t.kind === 'oda')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    await h.ok('kasa', 'POST', `/orders/${o.id}/room/start`, {});
    const stopped = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/room/stop`, {});
    await pay(stopped, 'Kredi kartı');
    const line = (await payloadOf(day.id)).lines.find((l) => l.isService)!;
    expect(line.posName).toBe('KARAOKE ODASI');
    await h.ok('patron', 'PATCH', `/admin/products/${roomProduct.id}`, { posName: 'KARAOKE ODASI' });
  });

  it('laktozsuz süt 0 TL satırı; ikram edilen içeceğin ekleri ikram[]\'da ayrı, menü değeri aynı oranla', async () => {
    const day = await freshDay();
    const sold = await sell([{ name: 'Latte', size: 'M', options: [{ itemId: option('milk', 'lactose-free').id }] }]);
    await pay(sold, 'Nakit');
    let comped = await sell([{ name: 'Latte', size: 'L', qty: 2, options: [{ itemId: option('milk', 'oat').id }, { itemId: option('extraShot', 'extraShot').id, qty: 1 }] }]);
    const unit = comped.items[0]!.unitPrice;
    comped = await comp(comped, 'Latte', 'Doğum günü');
    await h.ok('mudur', 'POST', `/orders/${comped.id}/close`, {});
    const p = await payloadOf(day.id);
    expect(p.lines.find((l) => l.posName === 'ALTERNATIF SÜT')).toMatchObject({ siteMenuId: 'mnu-0082', slot: 'M', qty: 1, revenue: 0 });
    expect(p.ikram.map((i) => [i.posName, i.siteMenuId, i.qty])).toEqual([
      ['LATTE LARGE', product('Latte').extId, 2],
      ['ALTERNATIF SÜT', 'mnu-0082', 2],
      ['EXTRA SHOT', 'mnu-0081', 2],
    ]);
    const value = (n: string) => p.ikram.find((i) => i.posName === n)!.menuValue;
    expect(value('ALTERNATIF SÜT')).toBe(50);
    expect(value('EXTRA SHOT')).toBe(100);
    expect(p.ikram.reduce((a, i) => a + i.menuValue, 0)).toBeCloseTo((2 * unit) / 100, 2);
    expect(p.z.offRevenue).toBeCloseTo((2 * unit) / 100, 2);
  });

  it('iptal edilmiş adisyonun ikramı ikram[]\'a girmez (Z\'nin ikram tutarıyla aynı kapsam)', async () => {
    const day = await freshDay();
    let o = await sell([{ name: 'Mocha', size: 'M' }]);
    o = await comp(o, 'Mocha', 'Tadım');
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Vazgeçti' });
    const p = await payloadOf(day.id);
    expect(p.ikram).toEqual([]);
    expect(p.z.offRevenue).toBe(0);
  });

  it('kartla bahşiş ve kartla cari tahsilatı ayrı alanlarda; nakit bahşiş ve nakit tahsilat sayılmaz', async () => {
    const day = await freshDay();
    const card = await sell([{ name: 'Espresso', size: 'M' }]);
    await pay(card, 'Kredi kartı', { tip: 1550 });
    const cash = await sell([{ name: 'Espresso', size: 'M' }]);
    await pay(cash, 'Nakit', { tip: 1000 });
    const c = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Tahsilat Müşterisi' });
    // Tahsilat bakiyeyi aşamaz (over_balance): önce açık hesaba borç yazılır
    await pay(await sell([{ name: 'Espresso', size: 'M', qty: 10 }]), 'Açık hesap', { customerId: c.id });
    await h.ok('mudur', 'POST', '/cash/collect', { customerId: c.id, methodId: method('Kredi kartı').id, amount: 25050 });
    await h.ok('mudur', 'POST', '/cash/collect', { customerId: c.id, methodId: method('Nakit').id, amount: 10000 });
    const z = (await payloadOf(day.id)).z;
    expect(z.cardTips).toBe(15.5);
    expect(z.cardCollections).toBe(250.5);
  });
});

describe('lines[].listPrices: satılan kalemin dondurulan liste fiyatları (şube fiyatı, docs/03-ENTEGRASYON.md §4)', () => {
  it('birleşen satırda iki fiyat ayrı adetleriyle (gün içinde fiyat değişti); ek kendi fiyatıyla; indirim liste fiyatını değiştirmez', async () => {
    const { db, schema } = modules;
    const day = await freshDay();
    const latte = product('Latte');
    const row = () => db.select().from(schema.products).where(eq(schema.products.id, latte.id)).get()!;
    const old = row().price;
    const vanilla = option('syrup', 'vanilla');
    let a = await sell([{ name: 'Latte', size: 'M', options: [{ itemId: vanilla.id }] }]);
    a = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${a.id}/discount`, { type: 'amount', value: 1000, reason: 'Müdavim' });
    await pay(a, 'Nakit');
    // Marina'nın yeni fiyatı gün içinde yürürlüğe girdi (sitenin `nextPriceAt` anında eşitlendi): yeni kalem yeni fiyatla
    db.update(schema.products).set({ price: old + 1500 }).where(eq(schema.products.id, latte.id)).run();
    try {
      await pay(await sell([{ name: 'Latte', size: 'M', qty: 2 }]), 'Kredi kartı');
    } finally {
      db.update(schema.products).set({ price: old }).where(eq(schema.products.id, latte.id)).run();
    }
    const p = await payloadOf(day.id);
    const line = p.lines.find((l) => l.posName === 'LATTE MEDIUM')!;
    expect(line.qty).toBe(3);
    expect(line.listPrices).toEqual([
      { price: old / 100, qty: 1 },
      { price: (old + 1500) / 100, qty: 2 },
    ]);
    // Mutlu saat yokken ana parçanın liste değeri fiyat × adet toplamıdır
    expect(line.listPrices!.reduce((s, x) => s + x.price * x.qty, 0)).toBeCloseTo(line.gross, 2);
    expect(p.lines.find((l) => l.posName === 'SYRUP')!.listPrices).toEqual([{ price: vanilla.price / 100, qty: 1 }]);
    // Ad ya da kişi yok: yalnız fiyat ve adet
    expect(Object.keys(line.listPrices![0]!)).toEqual(['price', 'qty']);
  });

  it('en çok 20 fiyat: en çok satılanlar kalır, fiyat sırasıyla', async () => {
    const { db, schema } = modules;
    const day = await freshDay();
    const su = product('Su');
    const old = db.select().from(schema.products).where(eq(schema.products.id, su.id)).get()!.price;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    let last = o;
    try {
      for (let i = 0; i <= 20; i++) {
        db.update(schema.products).set({ price: old + i * 100 }).where(eq(schema.products.id, su.id)).run();
        last = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: su.id, qty: i === 20 ? 2 : 1 }] });
      }
    } finally {
      db.update(schema.products).set({ price: old }).where(eq(schema.products.id, su.id)).run();
    }
    await pay(last, 'Nakit');
    const line = (await payloadOf(day.id)).lines.find((l) => l.siteMenuId === su.extId)!;
    expect(line.qty).toBe(22);
    const kept = [...Array.from({ length: 19 }, (_, i) => old + i * 100), old + 2000];
    expect(line.listPrices).toEqual(kept.map((k) => ({ price: k / 100, qty: k === old + 2000 ? 2 : 1 })));
  });
});

describe('dünden açık kalan gün', () => {
  it('yeni adisyon, kalem ve oda sayacı 409 stale_day; ödeme, iptal ve gün sonu serbest; kasa aynı metni gösterir', async () => {
    const { db, schema } = modules;
    const day = await freshDay();
    const room = h.boot.tables.find((t) => t.kind === 'oda')!;
    const open = await sell([{ name: 'Espresso', size: 'M' }]);
    const idle = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    const toCancel = await sell([{ name: 'Americano', size: 'M' }]);
    const toSplit = await sell([{ name: 'Espresso', size: 'M' }, { name: 'Americano', size: 'M' }]);
    // 05:00 geçti, gün sonu alınmadı: günün tarihi dün
    const today = businessDate(Date.now());
    const [y, m, d] = today.split('-').map(Number);
    const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
    db.update(schema.businessDays).set({ date: yesterday }).where(eq(schema.businessDays.id, day.id)).run();
    const message = staleDayMessage({ date: yesterday, zNo: day.zNo })!;
    expect(message).toMatch(new RegExp(`^Dünün günü açık \\(\\d+ \\S+, Z ${day.zNo}\\)\\. Önce gün sonunu alın$`));

    const created = await h.call<{ code: string; error: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(created.status).toBe(409);
    expect(created.json.code).toBe('stale_day');
    const added = await h.call<{ code: string }>('kasa', 'POST', `/orders/${open.id}/items`, { items: [{ productId: product('Espresso').id, qty: 1, size: 'M' }] });
    expect([added.status, added.json.code]).toEqual([409, 'stale_day']);
    const started = await h.call<{ code: string }>('kasa', 'POST', `/orders/${idle.id}/room/start`, {});
    expect([started.status, started.json.code]).toEqual([409, 'stale_day']);
    const cash = await h.ok<{ stale: string | null }>('kasa', 'GET', '/cash/day');
    expect(cash.stale).toBe(message);

    expect((await pay(open, 'Nakit')).closed).toBe(true);
    await h.ok('mudur', 'POST', `/orders/${toCancel.id}/cancel`, { reason: 'Müşteri gitti' });
    // Hesap bölme yeni satış değil: kalem yeni adisyona taşınır, iki adisyon da ödenir
    const moved = await h.ok<{ source: OrderDTO; target: OrderDTO }>('kasa', 'POST', `/orders/${toSplit.id}/transfer`, { items: [{ itemId: toSplit.items[1]!.id, qty: 1 }] });
    expect(moved.target.id).not.toBe(toSplit.id);
    expect(moved.target.items.map((i) => i.name)).toEqual(['Americano']);
    expect((await pay(moved.source, 'Nakit')).closed).toBe(true);
    expect((await pay(moved.target, 'Nakit')).closed).toBe(true);
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    const closed = db.select().from(schema.businessDays).where(and(eq(schema.businessDays.id, day.id))).get()!;
    expect(closed.closedAt).not.toBeNull();
    // Bugünün günü açılınca satış yeniden serbest
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect((await h.ok<{ stale: string | null }>('kasa', 'GET', '/cash/day')).stale).toBeNull();
    expect((await h.call('kasa', 'POST', '/orders', { type: 'tezgah' })).status).toBe(200);
  });

  it('eski gün metni: dünden eskiyse tarihle, bugünün gününde yok', () => {
    const now = Date.parse('2026-10-26T12:00:00+03:00');
    expect(staleDayMessage({ date: '2026-10-26', zNo: 9 }, now)).toBeNull();
    expect(staleDayMessage({ date: '2026-10-25', zNo: 14 }, now)).toBe('Dünün günü açık (25 Ekim, Z 14). Önce gün sonunu alın');
    expect(staleDayMessage({ date: '2026-10-23', zNo: 12 }, now)).toBe('23 Ekim günü hâlâ açık (Z 12). Önce gün sonunu alın');
    // 05:00'ten önce iş günü hâlâ dün: dünün günü eski sayılmaz
    expect(staleDayMessage({ date: '2026-10-25', zNo: 14 }, Date.parse('2026-10-26T04:30:00+03:00'))).toBeNull();
  });
});

describe('yönetim doğrulamaları', () => {
  it('lafmaliyet adı başka ürünün / boyun adıyla çakışırsa 409; aynı adlı iki yerel ürün serbest', async () => {
    const cat = h.boot.categories.find((c) => !c.extKey)!;
    // Sitenin "Su" kalemi (mnu-0036) SU adını taşır: yerel ürün aynı adı alamaz
    const su = await h.call<{ code: string }>('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Su', price: 3000, kdvRate: 10, posName: 'su' });
    expect([su.status, su.json.code]).toEqual([409, 'pos_name_taken']);
    const local = await h.ok<{ id: string }>('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Kuzu Kulağı', price: 3000, kdvRate: 10, posName: 'KUZU KULAĞI' });
    const taken = await h.call<{ code: string; error: string }>('patron', 'PATCH', `/admin/products/${local.id}`, { posName: 'latte  medium' });
    expect([taken.status, taken.json.code]).toEqual([409, 'pos_name_taken']);
    expect(taken.json.error).toContain('Latte (M)');
    // İki boylu yerel ürünün M adı sitenin kalemine düşerse de 409 (taban ad + boy eki)
    const created = await h.call<{ code: string }>('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Latte kopya', price: 1000, priceL: 2000, kdvRate: 10, posName: 'LATTE' });
    expect([created.status, created.json.code]).toEqual([409, 'pos_name_taken']);
    // Aynı adlı iki yerel ürün lafmaliyet'te tek satırda toplanır (ModPOS'taki gibi): çakışma değil
    expect((await h.call('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Kuzu Kulağı (büyük)', price: 4000, kdvRate: 10, posName: 'kuzu  kulağı' })).status).toBe(200);
  });

  it('eski bir çakışma, adı değiştirmeyen kaydı (renk, istasyon) engellemez', async () => {
    const { db, schema } = modules;
    const [a, b] = [product('Cappuccino'), product('Flat White')];
    for (const p of [a, b]) db.update(schema.products).set({ posName: 'SÜTLÜ' }).where(eq(schema.products.id, p.id)).run();
    // Formdan gelen kayıt posName'i de taşır; ad değişmediği için çakışma denetlenmez
    expect((await h.call('patron', 'PATCH', `/admin/products/${a.id}`, { color: '#3f6b8a', posName: 'SÜTLÜ' })).status).toBe(200);
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/products/${a.id}`, { posName: 'SÜTLÜ KAHVE' })).status).toBe(200);
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/products/${a.id}`, { posName: 'sütlü' })).json.code).toBe('pos_name_taken');
    for (const p of [a, b]) db.update(schema.products).set({ posName: null }).where(eq(schema.products.id, p.id)).run();
  });

  it('KDV %1 reddedilir', async () => {
    const cat = h.boot.categories.find((c) => !c.extKey)!;
    const r = await h.call('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Bir', price: 1000, kdvRate: 1 });
    expect(r.status).toBe(422);
    expect((await h.call('patron', 'POST', '/admin/products', { categoryId: cat.id, name: 'Bir', price: 1000, kdvRate: 10 })).status).toBe(200);
  });

  it('ödeme türü: nakit ⇔ Nakit alanı; komisyon kanalı listeden', async () => {
    const base = { name: 'Deneme', kind: 'kart', zField: 'card', color: '#245c43' };
    expect((await h.call<{ code: string }>('patron', 'POST', '/admin/payment-methods', { ...base, kind: 'nakit' })).json.code).toBe('cash_pair');
    expect((await h.call<{ code: string }>('patron', 'POST', '/admin/payment-methods', { ...base, zField: 'cash' })).json.code).toBe('cash_pair');
    expect((await h.call('patron', 'POST', '/admin/payment-methods', { ...base, kind: 'yemek', zField: 'meal_card', channel: 'Sodexo' })).status).toBe(422);
    const ok = await h.ok<{ id: string }>('patron', 'POST', '/admin/payment-methods', { ...base, kind: 'online', zField: 'online', channel: 'yemeksepeti' });
    // Düzenlemede de kayıtlı değerle birlikte denetlenir: yalnız türü nakde çevirmek reddedilir
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/payment-methods/${ok.id}`, { kind: 'nakit' })).json.code).toBe('cash_pair');
    expect((await h.call('patron', 'PATCH', `/admin/payment-methods/${ok.id}`, { kind: 'nakit', zField: 'cash', channel: null })).status).toBe(200);
    // Kuraldan önce kaydedilmiş uyumsuz tür kapatılabilir (yalnız `active`); türü ya da alanı değişince denetlenir
    const { db, schema } = modules;
    db.update(schema.paymentMethods).set({ kind: 'kart', zField: 'cash' }).where(eq(schema.paymentMethods.id, ok.id)).run();
    expect((await h.call('patron', 'PATCH', `/admin/payment-methods/${ok.id}`, { active: false })).status).toBe(200);
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/payment-methods/${ok.id}`, { zField: 'cash', kind: 'kart' })).json.code).toBe('cash_pair');
  });

  it('ödeme almış nakit türü karta çevrilse de beklenen nakit Z nakdiyle tutar (ödemenin dondurulan alanı)', async () => {
    const day = await freshDay();
    const m = await h.ok<{ id: string }>('patron', 'POST', '/admin/payment-methods', { name: 'Çekmece', kind: 'nakit', zField: 'cash', color: '#245c43' });
    const payWith = (o: OrderDTO) => h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: m.id, amount: o.total - o.paid });
    const first = await sell([{ name: 'Americano', size: 'M' }]);
    expect((await payWith(first)).closed).toBe(true);
    // Gün açıkken tür nakitten karta çevrilir (eşleşme kuralına uyar): alınmış nakit çekmecede kalır
    expect((await h.call('patron', 'PATCH', `/admin/payment-methods/${m.id}`, { kind: 'kart', zField: 'card' })).status).toBe(200);
    const second = await sell([{ name: 'Espresso', size: 'M' }]);
    expect((await payWith(second)).closed).toBe(true);

    type S = { openingCash: number; expectedCash: number; byZField: Record<string, number> };
    const s = (await h.ok<{ summary: S }>('mudur', 'GET', '/cash/day')).summary;
    expect(s.byZField.cash).toBe(first.total);
    expect(s.byZField.card).toBe(second.total);
    expect(s.expectedCash).toBe(s.openingCash + s.byZField.cash);
    const z = (await payloadOf(day.id)).z;
    expect(z.expectedCash).toBeCloseTo(z.openingCash! + z.cash!, 2);
    expect(z.cashIn).toBe(0);
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${m.id}`, { active: false });
  });
});

/**
 * Şube kimliği (docs/03-ENTEGRASYON.md §4, 4 Kasım 2026): gün sonu paketi kasanın şubesini taşır, böylece
 * lafmaliyet günü doğru şubenin cirosuna yazar (lafmaliyet docs/SUBE.md). Varsayılan `marina`: ilk AsilPOS kasası
 * Marina'da (21 Kasım 2026); lafmaliyet AsilPOS'un şubesinden başka şubeye ayarlı kasanın gününü reddeder.
 */
describe('şube kimliği pakete girer', () => {
  it('varsayılan marina, ayar değişince paket onu taşır', async () => {
    const day = await freshDay();
    expect((await payloadOf(day.id)).sube).toBe('marina');

    await h.ok('patron', 'PUT', '/admin/settings', { branchId: 'tuzla' });
    expect((await payloadOf(day.id)).sube).toBe('tuzla');
    await h.ok('patron', 'PUT', '/admin/settings', { branchId: 'marina' });
  });

  it('geçersiz kimlik ayarlanamaz (lafmaliyet ile aynı kural)', async () => {
    for (const kotu of ['', 'M', 'Marina', '1marina', 'mar na', 'marina!', 'm'.repeat(25)]) {
      const r = await h.call('patron', 'PUT', '/admin/settings', { branchId: kotu });
      expect(r.status, `şube kimliği kabul edilmemeli: ${JSON.stringify(kotu)}`).toBe(422);
    }
    // Ayar değişmedi
    const day = await freshDay();
    expect((await payloadOf(day.id)).sube).toBe('marina');
  });
});
