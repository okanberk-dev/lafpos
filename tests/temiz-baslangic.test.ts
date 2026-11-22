import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businessDate } from '@shared/time';
import type { DenemeStatusDTO, OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Temiz başlangıç (Marina, 22 Kasım 2026): "Geçişi tamamla" deneme günlerini (eğitim günü) bütün hareketleriyle siler,
 * gerçek günlere dokunmaz. Pencerede isteğe bağlı: bugünden önceki gerçek görünen günler de denemeydi (eski sürümde patron
 * PIN'i değişince deneme sessizce kapanıyordu): onlar ve lafmaliyet giden kutusu kayıtları da silinir. Bugünkü ya da
 * sonraki gerçek gün varsa seçenek yoktur. Yalnız patron, açık günde yapılmaz. Karşılama sihirbazının "Gerçek
 * kullanıma başla" adımı `liveSince`'e bakar.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const NEW_PIN = '482915';
const PATH = '/admin/deneme/bitir';

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq, inArray, sql } = await import('drizzle-orm');
  const { getSettings, updateSettings } = await import('../server/lib/settings');
  const count = (table: Parameters<ReturnType<typeof db.select>['from']>[0]) => db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;
  return { db, schema, eq, inArray, count, getSettings, updateSettings };
}

/** Bir gün: aç, satış (nakit), kasa hareketi, isteğe bağlı açık hesap satışı, kapat; sonra tarihi ve işareti yazılır */
async function makeDay(date: string | null, trainingDay: boolean, customerId?: string, as?: string) {
  // Geçişten sonra örnek PIN'li hesaplar kapanır: o zaman her şeyi patron yapar
  const kasa = as ?? 'kasa';
  const mudur = as ?? 'mudur';
  const { db, schema, eq } = await mod();
  await h.ok(kasa, 'POST', '/cash/day/open', { openingCash: 10000 });
  const product = h.boot.products.find((p) => p.name === 'Latte')!;
  const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
  let o = await h.ok<OrderDTO>(kasa, 'POST', '/orders', { type: 'tezgah' });
  o = await h.ok<OrderDTO>(kasa, 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, size: 'M', qty: 1 }] });
  await h.ok(kasa, 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total, given: o.total });
  await h.ok(mudur, 'POST', '/cash/movements', { kind: 'harcama', amount: 1000, description: 'Buz' });
  if (customerId) {
    const cari = h.boot.paymentMethods.find((m) => m.kind === 'cari')!;
    let c = await h.ok<OrderDTO>(mudur, 'POST', '/orders', { type: 'tezgah' });
    c = await h.ok<OrderDTO>(mudur, 'POST', `/orders/${c.id}/items`, { items: [{ productId: product.id, size: 'M', qty: 1 }] });
    await h.ok(mudur, 'POST', `/orders/${c.id}/payments`, { methodId: cari.id, amount: c.total, customerId });
  }
  const x = await h.ok<{ summary: { expectedCash: number } }>(mudur, 'GET', '/cash/day');
  await h.ok(kasa, 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
  // Önceki günler geçmişe taşındı: bugünün tarihli tek kapanmış gün bu
  const day = db.select().from(schema.businessDays).all().find((d) => d.closedAt != null && d.date === businessDate(Date.now()))!;
  db.update(schema.businessDays).set({ trainingDay, ...(date ? { date } : {}) }).where(eq(schema.businessDays.id, day.id)).run();
  return day.id;
}

/** Günün bütün hareketleri (birebir karşılaştırma için) */
async function snapshot(dayIds: string[]) {
  const { db, schema, inArray } = await mod();
  const orders = db.select().from(schema.orders).where(inArray(schema.orders.dayId, dayIds)).all();
  const orderIds = orders.map((o) => o.id);
  return {
    days: db.select().from(schema.businessDays).where(inArray(schema.businessDays.id, dayIds)).all(),
    orders,
    items: orderIds.length ? db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, orderIds)).all() : [],
    payments: db.select().from(schema.payments).where(inArray(schema.payments.dayId, dayIds)).all(),
    cash: db.select().from(schema.cashMovements).where(inArray(schema.cashMovements.dayId, dayIds)).all(),
    ledger: db.select().from(schema.customerLedger).where(inArray(schema.customerLedger.dayId, dayIds)).all(),
  };
}

async function addOutbox(target: 'lafmaliyet' | 'laffogato', dedupeKey: string) {
  const { db, schema } = await mod();
  const now = Date.now();
  db.insert(schema.outbox).values({ target, kind: target === 'lafmaliyet' ? 'pos.gun' : 'menu.isActive', dedupeKey, payload: {}, createdAt: now, nextAttemptAt: now }).run();
}

async function outboxKeys() {
  const { db, schema } = await mod();
  return db
    .select()
    .from(schema.outbox)
    .all()
    .map((r) => `${r.target}:${r.dedupeKey}`)
    .sort();
}

let trialIds: string[] = [];
let realIds: string[] = [];
let customerId = '';

describe('Geçişi tamamla: deneme günleri silinir, gerçek günler kalır', () => {
  it('hazırlık: iki deneme günü, deneme sessizce kapanmış, iki gerçek görünen gün', async () => {
    const { updateSettings } = await mod();
    customerId = (await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Açık Hesap' })).id;
    trialIds.push(await makeDay('2026-11-15', true, customerId));
    trialIds.push(await makeDay('2026-11-16', true));
    updateSettings({ demoMode: false });
    realIds.push(await makeDay('2026-11-18', false, customerId));
    realIds.push(await makeDay('2026-11-19', false));
    await addOutbox('lafmaliyet', 'gun:2026-11-15');
    await addOutbox('lafmaliyet', 'gun:2026-11-18');
    await addOutbox('laffogato', 'menu:x');
  });

  it('kurulum adımı: deneme kapalı ama başlangıç yazılmamış → "Gerçek kullanıma başla" bitmemiş', async () => {
    const r = await h.ok<{ steps: { key: string; done: boolean; detail: string }[] }>('patron', 'GET', '/admin/kurulum');
    expect(r.steps.find((s) => s.key === 'gercek')).toMatchObject({ done: false, detail: 'Ayarlar ve yedek › Geçişi tamamla' });
  });

  it('yetki: yalnız patron; açık günde reddedilir, hiçbir şey silinmez', async () => {
    const { count, schema, updateSettings } = await mod();
    expect((await h.call('mudur', 'POST', PATH, { pin: PINS.mudur, purgeReal: true })).status).toBe(403);
    expect((await h.call('kasa', 'POST', PATH, { pin: PINS.kasa })).status).toBe(403);
    expect((await h.call('mudur', 'GET', '/admin/deneme')).status).toBe(403);
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const r = await h.call<{ code: string }>('patron', 'POST', PATH, { pin: PINS.patron, newPin: NEW_PIN });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('day_open');
    expect(count(schema.businessDays)).toBe(5);
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    // Boş açılıp kapanan gün de denemeydi (eğitim günü): 17 Kasım
    const { db, eq } = await mod();
    const empty = db.select().from(schema.businessDays).all().find((d) => !trialIds.includes(d.id) && !realIds.includes(d.id))!;
    updateSettings({ demoMode: false });
    db.update(schema.businessDays).set({ date: '2026-11-17', trainingDay: true }).where(eq(schema.businessDays.id, empty.id)).run();
    trialIds.push(empty.id);
  });

  it('durum: silinecek deneme günleri ve bugünden önceki gerçek görünen günler', async () => {
    const st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(st).toMatchObject({ liveSince: null, finalizeOnly: true, realDays: 2 });
    expect(st.trialDays).toEqual({ days: 3, from: '2026-11-15', to: '2026-11-17' });
    expect(st.earlyRealDays).toEqual({ days: 2, from: '2026-11-18', to: '2026-11-19' });
  });

  it('işaretsiz: deneme günleri bütün hareketleriyle silinir; gerçek günlerin kayıtları birebir kalır', async () => {
    const { db, schema, eq, inArray, count, getSettings } = await mod();
    const before = await snapshot(realIds);
    expect(before.orders.length).toBeGreaterThan(0);
    expect(before.ledger.length).toBe(1);
    const trialBefore = await snapshot(trialIds);
    expect(trialBefore.ledger.length).toBe(1);
    const balanceBefore = db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get()!.balance;
    const trialDebt = trialBefore.ledger[0].amount;

    const r = await h.ok<{ finalized: boolean; purged: { days: number; realDays: number; orders: number; outbox: number }; backup: string }>('patron', 'POST', PATH, {
      pin: PINS.patron,
      newPin: NEW_PIN,
    });
    expect(r.finalized).toBe(true);
    expect(r.purged).toMatchObject({ days: 3, realDays: 0, orders: trialBefore.orders.length, outbox: 1 });
    expect(r.backup).toMatch(/deneme-oncesi/);

    // Deneme günleri ve her şeyleri gitti
    expect(db.select().from(schema.businessDays).where(inArray(schema.businessDays.id, trialIds)).all()).toHaveLength(0);
    const trialOrderIds = trialBefore.orders.map((o) => o.id);
    expect(db.select().from(schema.orderItems).where(inArray(schema.orderItems.orderId, trialOrderIds)).all()).toHaveLength(0);
    expect(db.select().from(schema.payments).where(inArray(schema.payments.dayId, trialIds)).all()).toHaveLength(0);
    expect(db.select().from(schema.cashMovements).where(inArray(schema.cashMovements.dayId, trialIds)).all()).toHaveLength(0);
    expect(db.select().from(schema.customerLedger).where(inArray(schema.customerLedger.dayId, trialIds)).all()).toHaveLength(0);
    // Gerçek günler birebir
    expect(await snapshot(realIds)).toEqual(before);
    expect(count(schema.businessDays)).toBe(2);
    // Müşteri bakiyesinden yalnız deneme borcu düştü; müşteri kaldı
    expect(db.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get()!.balance).toBe(balanceBefore - trialDebt);
    // Giden kutusu: deneme gününün kaydı gitti; gerçek günün ve sitenin kaydı kaldı
    expect(await outboxKeys()).toEqual(['laffogato:menu:x', 'lafmaliyet:gun:2026-11-18']);
    expect(getSettings().liveSince).toBeGreaterThan(0);
    const audit = db.select().from(schema.auditLog).all().filter((a) => a.action === 'deneme.bitir').at(-1)!;
    expect(audit.message).toContain('3 gün silindi (15.11.2026–17.11.2026)');
    expect(audit.message).toContain('2 gerçek gün kaldı');

    const k = await h.ok<{ steps: { key: string; done: boolean; detail: string }[] }>('patron', 'GET', '/admin/kurulum');
    expect(k.steps.find((s) => s.key === 'gercek')).toMatchObject({ done: true, detail: 'Başladı' });
    // Bir kez çalışır
    expect(await h.ok<{ already: boolean }>('patron', 'POST', PATH, { pin: NEW_PIN })).toMatchObject({ already: true });
  });
});

describe('Geçişi tamamla: bugünden önceki gerçek görünen günler de denemeydi', () => {
  it('işaretli: o günler, hareketleri ve lafmaliyet giden kutusu kayıtları silinir', async () => {
    const { db, schema, count, updateSettings } = await mod();
    // Başlangıç yazılmamış hâle dön (aynı kurulumda ikinci senaryo)
    updateSettings({ liveSince: null });
    const st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(st.trialDays.days).toBe(0);
    expect(st.earlyRealDays).toEqual({ days: 2, from: '2026-11-18', to: '2026-11-19' });

    const r = await h.ok<{ purged: { days: number; realDays: number; outbox: number } }>('patron', 'POST', PATH, { pin: NEW_PIN, purgeReal: true });
    expect(r.purged).toMatchObject({ days: 2, realDays: 2, outbox: 1 });
    expect(count(schema.businessDays)).toBe(0);
    expect(count(schema.orders)).toBe(0);
    expect(count(schema.payments)).toBe(0);
    expect(count(schema.cashMovements)).toBe(0);
    expect(count(schema.customerLedger)).toBe(0);
    expect(db.select().from(schema.customers).all().find((c) => c.id === customerId)?.balance).toBe(0);
    expect(await outboxKeys()).toEqual(['laffogato:menu:x']);
    const audit = db.select().from(schema.auditLog).all().filter((a) => a.action === 'deneme.bitir').at(-1)!;
    expect(audit.message).toContain('2 tanesi gerçek görünen ama deneme olan gün');
  });

  it('bugünkü gerçek gün varken seçenek yok ve reddedilir; işaretsiz tamamlanır, gerçek günlere dokunulmaz', async () => {
    const { count, schema, updateSettings } = await mod();
    updateSettings({ liveSince: null });
    realIds = [await makeDay('2026-11-20', false, undefined, 'patron'), await makeDay(null, false, undefined, 'patron')];
    await addOutbox('lafmaliyet', 'gun:2026-11-20');
    const before = await snapshot(realIds);
    expect(before.days.map((d) => d.date).sort()).toEqual(['2026-11-20', businessDate(Date.now())].sort());

    const st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(st.earlyRealDays).toBeNull();
    const bad = await h.call<{ code: string }>('patron', 'POST', PATH, { pin: NEW_PIN, purgeReal: true });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('purge_not_allowed');

    const r = await h.ok<{ finalized: boolean; purged: { days: number } }>('patron', 'POST', PATH, { pin: NEW_PIN });
    expect(r).toMatchObject({ finalized: true, purged: { days: 0 } });
    expect(await snapshot(realIds)).toEqual(before);
    expect(count(schema.businessDays)).toBe(2);
    expect(await outboxKeys()).toEqual(['laffogato:menu:x', 'lafmaliyet:gun:2026-11-20']);
  });
});

describe('Geçişi tamamla: gerçek olduğu kanıtlı gün silinmeye önerilmez', () => {
  /** Günün ilk adisyonuna gerçek Pavo fişi (tamamlanmış) */
  async function pavoReceipt(dayId: string) {
    const { db, schema, eq } = await mod();
    const o = db.select().from(schema.orders).where(eq(schema.orders.dayId, dayId)).get()!;
    const now = Date.now();
    db.insert(schema.fiscalReceipts)
      .values({ id: `fr-${dayId}`, orderId: o.id, provider: 'pavo', mode: 'anlik', status: 'tamamlandi', amount: o.total, items: [], basket: {}, createdAt: now, updatedAt: now, completedAt: now })
      .run();
  }

  it('dün kapanmış Pavo fişli ilk gerçek gün, ertesi sabah earlyReal\'e girmez ve silinemez', async () => {
    const { db, schema, eq, count, updateSettings } = await mod();
    updateSettings({ liveSince: null });
    // Önceki senaryodan kalan bugünkü gerçek gün (dün kapanmış gibi) ve 20 Kasım
    const today = businessDate(Date.now());
    const yesterday = db.select().from(schema.businessDays).all().find((d) => d.date === today)!;
    db.update(schema.businessDays).set({ date: '2026-11-21' }).where(eq(schema.businessDays.id, yesterday.id)).run();
    await pavoReceipt(yesterday.id);

    let st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    // Yalnız kanıtsız 20 Kasım önerilir; Pavo fişli 21 Kasım değil
    expect(st.earlyRealDays).toEqual({ days: 1, from: '2026-11-20', to: '2026-11-20' });
    expect(st.provenRealDays).toBe(1);

    // Kanıtlı günden sonraki kanıtsız gün de önerilmez: 21 Kasım 19'una taşınınca 20 Kasım ondan sonra kalır
    db.update(schema.businessDays).set({ date: '2026-11-19' }).where(eq(schema.businessDays.id, yesterday.id)).run();
    st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(st.earlyRealDays).toBeNull();
    const bad = await h.call<{ code: string }>('patron', 'POST', PATH, { pin: NEW_PIN, purgeReal: true });
    expect(bad.status).toBe(422);
    expect(bad.json.code).toBe('purge_not_allowed');
    expect(count(schema.businessDays)).toBe(2);
    expect(count(schema.fiscalReceipts)).toBe(1);
  });

  it('lafmaliyet\'e gönderilmiş gün (exportedAt ya da gönderilmiş gun: kaydı) önerilmez; işaretli silmede yalnız kanıtsız gün gider', async () => {
    const { db, schema, eq, count, updateSettings } = await mod();
    updateSettings({ liveSince: null });
    const days = db.select().from(schema.businessDays).all();
    const pavoDay = days.find((d) => d.date === '2026-11-19')!;
    const other = days.find((d) => d.date === '2026-11-20')!;
    db.update(schema.businessDays).set({ date: '2026-11-21' }).where(eq(schema.businessDays.id, pavoDay.id)).run();
    db.update(schema.businessDays).set({ exportedAt: Date.now() }).where(eq(schema.businessDays.id, other.id)).run();
    expect((await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme')).earlyRealDays).toBeNull();
    db.update(schema.businessDays).set({ exportedAt: null }).where(eq(schema.businessDays.id, other.id)).run();
    db.update(schema.outbox).set({ sentAt: Date.now() }).where(eq(schema.outbox.dedupeKey, 'gun:2026-11-20')).run();
    expect((await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme')).earlyRealDays).toBeNull();
    db.update(schema.outbox).set({ sentAt: null }).where(eq(schema.outbox.dedupeKey, 'gun:2026-11-20')).run();

    const r = await h.ok<{ purged: { days: number; realDays: number } }>('patron', 'POST', PATH, { pin: NEW_PIN, purgeReal: true });
    expect(r.purged).toMatchObject({ days: 1, realDays: 1 });
    // Pavo fişli gün ve fişi kaldı
    expect(db.select().from(schema.businessDays).all().map((d) => d.date)).toEqual(['2026-11-21']);
    expect(count(schema.fiscalReceipts)).toBe(1);
  });
});
