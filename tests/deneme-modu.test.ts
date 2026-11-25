import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, DenemeStatusDTO, OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Deneme modu ve "Denemeyi bitir, gerçek kullanıma başla" (server/services/deneme.ts): yeni kurulumda hiçbir hareket
 * yok, kurulum deneme modunda açılır; bitirmek yalnız patrona, kendi PIN'iyle, açık gün yokken ve gerçek gün yokken
 * çalışır; önce yedek alır, deneme hareketlerini siler, kurulumu bırakır, örnek PIN'leri kapatır, bir kez çalışır.
 */

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { sql, eq } = await import('drizzle-orm');
  const { getSettings } = await import('../server/lib/settings');
  const count = (table: Parameters<ReturnType<typeof db.select>['from']>[0]) => db.select({ n: sql<number>`count(*)` }).from(table).get()!.n;
  return { db, schema, eq, count, getSettings };
}

const TRANSACTIONAL = ['orders', 'orderItems', 'payments', 'businessDays', 'cashMovements', 'shiftCounts', 'customers', 'customerLedger', 'reservations', 'roomSessions', 'fiscalReceipts', 'platformOrders'] as const;

async function configCounts() {
  const { schema, count } = await mod();
  return {
    products: count(schema.products),
    categories: count(schema.categories),
    tables: count(schema.tables),
    sections: count(schema.sections),
    paymentMethods: count(schema.paymentMethods),
    stations: count(schema.stations),
    printers: count(schema.printers),
    optionGroups: count(schema.optionGroups),
    users: count(schema.users),
  };
}

describe('yeni kurulum', () => {
  it('hiç hareket yok, yalnız kurulum; örnek kampanya yalnız demoda', async () => {
    const { schema, count } = await mod();
    for (const t of TRANSACTIONAL) expect(count(schema[t]), t).toBe(0);
    expect(count(schema.happyHours)).toBe(0);
    const cfg = await configCounts();
    expect(cfg.products).toBeGreaterThan(50);
    expect(cfg.tables).toBeGreaterThan(10);
    expect(cfg.paymentMethods).toBeGreaterThan(0);
    expect(cfg.users).toBe(5);
  });

  it('deneme modunda açılır: örnek PIN, eğitim yazarkasası, şerit', async () => {
    const { getSettings } = await mod();
    expect(getSettings()).toMatchObject({ demoMode: true, okcProvider: 'simulator', liveSince: null });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.integrations.deneme).toBe(true);
    const login = await h.ok<{ demoPins: unknown[] | null }>('', 'GET', '/auth/users');
    expect(login.demoPins).toHaveLength(5);
  });
});

describe('Denemeyi bitir', () => {
  let cfgBefore: Awaited<ReturnType<typeof configCounts>>;

  it('durum yalnız patrona', async () => {
    expect((await h.call('mudur', 'GET', '/admin/deneme')).status).toBe(403);
    expect((await h.call('kasa', 'GET', '/admin/deneme')).status).toBe(403);
    const s = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(s).toMatchObject({ deneme: true, liveSince: null, dayOpen: false, realDays: 0, mustChangeOwnPin: true });
    expect(s.samplePinUsers.map((u) => u.name).sort()).toEqual(['Bar ekranı', 'Garson', 'Kasa', 'Müdür']);
  });

  it('deneme satışı, kasa hareketi, müşteri, rezervasyon; açık gün varken bitmez', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 50000 });
    const product = h.boot.products.find((p) => p.name === 'Latte')!;
    const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, size: 'M', qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total, given: o.total });
    await h.ok('mudur', 'POST', '/cash/movements', { kind: 'harcama', amount: 5000, description: 'Buz' });
    await h.ok('kasa', 'POST', '/customers', { name: 'Deneme Müşteri' });
    await h.ok('mudur', 'POST', '/reservations', { date: '2026-12-01', time: '19:00', name: 'Deneme' });

    const r = await h.call<{ code: string }>('patron', 'POST', '/admin/deneme/bitir', { pin: PINS.patron, newPin: '482915' });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe('day_open');

    const x = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
    const { schema, count } = await mod();
    expect(count(schema.orders)).toBeGreaterThan(0);
    expect(count(schema.businessDays)).toBe(1);
  });

  it('yalnız patron, kendi PIN’iyle; örnek PIN’den yeni PIN zorunlu', async () => {
    const path = '/admin/deneme/bitir';
    expect((await h.call('mudur', 'POST', path, { pin: PINS.mudur, newPin: '482915' })).status).toBe(403);
    expect((await h.call<{ code: string }>('patron', 'POST', path, { pin: '0000', newPin: '482915' })).json).toMatchObject({ code: 'pin_invalid' });
    expect((await h.call<{ code: string }>('patron', 'POST', path, { pin: PINS.patron })).json).toMatchObject({ code: 'new_pin_required' });
    expect((await h.call<{ code: string }>('patron', 'POST', path, { pin: PINS.patron, newPin: PINS.kasa })).json).toMatchObject({ code: 'pin_sample' });
    expect((await h.call<{ code: string }>('patron', 'POST', path, { pin: PINS.patron, newPin: '12' })).json).toMatchObject({ code: 'pin_invalid' });
    // Hiçbiri bir şey silmedi
    const { schema, count, getSettings } = await mod();
    expect(count(schema.orders)).toBeGreaterThan(0);
    expect(getSettings().liveSince).toBeNull();
  });

  it('gerçek (deneme dışı) gün varken durum "yalnız geçişi tamamla" der; hiçbir şey silinmez (tamamlama tests/saha-duzeltmeleri.test.ts)', async () => {
    const { db, schema, eq } = await mod();
    const d = db.select().from(schema.businessDays).get()!;
    db.update(schema.businessDays).set({ trainingDay: false }).where(eq(schema.businessDays.id, d.id)).run();
    expect(await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme')).toMatchObject({ realDays: 1, finalizeOnly: true });
    db.update(schema.businessDays).set({ trainingDay: true }).where(eq(schema.businessDays.id, d.id)).run();
  });

  it('yedek alır, hareketleri siler, kurulumu bırakır, ayarları gerçeğe çevirir, denetime yazar', async () => {
    cfgBefore = await configCounts();
    const before = await mod();
    const days = before.db.select().from(before.schema.businessDays).all();
    const r = await h.ok<{ already: boolean; backup: string; deleted: { orders: number; days: number }; closedUsers: string[] }>('patron', 'POST', '/admin/deneme/bitir', { pin: PINS.patron, newPin: '482915' });
    expect(r.already).toBe(false);
    expect(r.deleted.orders).toBeGreaterThan(0);
    expect(r.deleted.days).toBe(1);
    expect(r.backup).toMatch(/lafpos-deneme-oncesi-.*\.db$/);
    expect(existsSync(r.backup)).toBe(true);
    expect(r.closedUsers.sort()).toEqual(['Bar ekranı', 'Garson', 'Kasa', 'Müdür']);

    const { db, schema, count, getSettings } = await mod();
    for (const t of TRANSACTIONAL) expect(count(schema[t]), t).toBe(0);
    const audit = db.select().from(schema.auditLog).all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: 'deneme.bitir', severity: 'uyari', data: { remoteDays: 1 } });
    // Silinen günün tarihi aynı işlemde LafPOS Uzaktan'da boşaltılmak üzere yazıldı (tests/deneme-uzaktan.test.ts)
    const { getSyncState } = await import('../server/lib/settings');
    expect(getSyncState('cloud.reports.silinen')).toEqual([days[0]!.date]);
    // Kurulum aynı; örnek PIN'li hesaplar silinmez, kapanır
    expect(await configCounts()).toEqual(cfgBefore);
    expect(getSettings()).toMatchObject({ demoMode: false, okcProvider: 'kapali' });
    expect(getSettings().liveSince).toBeGreaterThan(0);

    const boot = await h.ok<BootstrapDTO>('patron', 'GET', '/bootstrap');
    expect(boot.integrations.deneme).toBe(false);
    expect((await h.ok<{ demoPins: unknown }>('', 'GET', '/auth/users')).demoPins).toBeNull();
  });

  it('patron yeni PIN’le girer; örnek PIN’ler artık girmez', async () => {
    expect((await h.call('', 'POST', '/auth/login', { pin: PINS.patron })).status).toBe(401);
    expect((await h.call('', 'POST', '/auth/login', { pin: PINS.kasa })).status).toBe(401);
    await h.login('patron', '482915');
    // Kapanan hesap yeni PIN'siz açılmaz; örnek PIN verilemez; yeni PIN'le açılır
    const users = await h.ok<{ id: string; name: string; active: boolean }[]>('patron', 'GET', '/admin/users');
    const kasa = users.find((u) => u.name === 'Kasa')!;
    expect(kasa.active).toBe(false);
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${kasa.id}`, { active: true })).json).toMatchObject({ code: 'pin_sample' });
    expect((await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${kasa.id}`, { active: true, pin: PINS.garson })).json).toMatchObject({ code: 'pin_sample' });
    await h.ok('patron', 'PATCH', `/admin/users/${kasa.id}`, { active: true, pin: '730416' });
    await h.login('kasa', '730416');
    // Kurulum modu geri açılmaz
    expect((await h.call<{ code: string }>('patron', 'PUT', '/admin/settings', { demoMode: true })).json).toMatchObject({ code: 'live' });
  });

  it('bir kez çalışır: tekrar basmak hiçbir şey silmez', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(o.id).toBeTruthy();
    const r = await h.ok<{ already: boolean }>('patron', 'POST', '/admin/deneme/bitir', { pin: '482915' });
    expect(r.already).toBe(true);
    const { schema, count } = await mod();
    expect(count(schema.businessDays)).toBe(1);
    expect(count(schema.orders)).toBe(1);
    const s = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(s.liveSince).toBeGreaterThan(0);
  });
});
