import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO, ZSummary } from '@shared/types';
import { PINS, startApp, type Harness } from './harness';

/**
 * Adisyonun tamamı ciro dışı: "Hepsini ikram et" ve "Ödenmez kapat" (personel yemeği, zayi, patron hesabı). İkisi de
 * cirodan düşer; ödenmez raporda, Z'de ve lafmaliyet ikram satırında ayrı görünür. Ödenmez ayrı yetki ister.
 */
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
let tableIndex = 0;

async function table(items: { name: string; qty: number }[], who = 'garson') {
  const t = h.boot.tables.filter((x) => x.kind === 'masa')[tableIndex++];
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'masa', tableId: t.id, guests: 2 });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty })) });
}

const day = () => h.ok<{ summary: ZSummary; day: { id: string } }>('patron', 'GET', '/cash/day');

describe('adisyonu ciro dışı kapatma', () => {
  let ikramValue = 0;
  let odenmezValue = 0;
  let odenmezExtra = 0;

  it('hepsini ikram et: garson yetkili onayıyla, adisyon sıfırla kapanır', async () => {
    await h.pinPrice('Americano', 15000);
    let o = await table([{ name: 'Americano', qty: 2 }]);
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Öğrenci', approverPin: PINS.mudur });
    expect(o.totals.orderDiscount).toBeGreaterThan(0);
    const denied = await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/comp`, { kind: 'ikram', reason: 'Doğum günü' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('approval_required');
    const closed = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/comp`, { kind: 'ikram', reason: 'Doğum günü', approverPin: PINS.mudur });
    expect(closed.status).toBe('kapali');
    expect(closed.total).toBe(0);
    // Kalmayan ücretin indirimi de kalmaz
    expect(closed.discountType).toBeNull();
    expect(closed.items.every((i) => i.complimentary && i.compKind === 'ikram' && i.compReason === 'Doğum günü')).toBe(true);
    ikramValue = 2 * 15000;
  });

  it('ödenmez: kasiyerin yetkisi yok, müdür onaylar; ikramdan ayrı sayılır', async () => {
    await h.pinPrice('Latte', 16000);
    const o = await table([{ name: 'Latte', qty: 3 }], 'kasa');
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('approval_required');
    const closed = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', approverPin: PINS.mudur });
    expect(closed.status).toBe('kapali');
    expect(closed.items.every((i) => i.compKind === 'odenmez')).toBe(true);
    odenmezValue = o.items.reduce((a, i) => a + i.qty * i.unitPrice, 0);

    const { summary } = await day();
    expect(summary.complimentary).toBe(ikramValue + odenmezValue);
    expect(summary.odenmez).toBe(odenmezValue);
    expect(summary.netSales).toBe(0);
    expect(summary.receipts).toBe(0);
  });

  it('ödeme alınmış, ücretli kalemi olmayan ya da yazarkasada bekleyen adisyon kapatılmaz', async () => {
    const paid = await table([{ name: 'Americano', qty: 2 }], 'kasa');
    await h.ok('kasa', 'POST', `/orders/${paid.id}/payments`, { methodId: method('Nakit').id, amount: 15000 });
    const r1 = await h.call<{ code: string }>('patron', 'POST', `/orders/${paid.id}/comp`, { kind: 'odenmez', reason: 'Zayi' });
    expect([r1.status, r1.json.code]).toEqual([409, 'has_payments']);

    const empty = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const r2 = await h.call<{ code: string }>('patron', 'POST', `/orders/${empty.id}/comp`, { kind: 'ikram', reason: 'Tadım' });
    expect([r2.status, r2.json.code]).toEqual([409, 'nothing_to_comp']);

    const blank = await table([{ name: 'Americano', qty: 1 }], 'kasa');
    const r3 = await h.call<{ code: string }>('patron', 'POST', `/orders/${blank.id}/comp`, { kind: 'odenmez', reason: '  ' });
    expect([r3.status, r3.json.code]).toEqual([400, 'reason_required']);
    await h.ok('patron', 'POST', `/orders/${blank.id}/comp`, { kind: 'odenmez', reason: 'Zayi' });
    odenmezExtra += 15000;

    const device = await table([{ name: 'Americano', qty: 1 }], 'kasa');
    const sent = await h.ok<{ receipt: { id: string; amount: number } }>('kasa', 'POST', `/okc/orders/${device.id}/send`, {});
    const r4 = await h.call<{ code: string }>('patron', 'POST', `/orders/${device.id}/comp`, { kind: 'ikram', reason: 'Tadım' });
    expect(r4.status).toBe(409);
    // Cihaz fişi kesti ama ödeme LafPOS'a işlenmedi (ödemesiz kapanış): kalemler cihazda ödenmiş olabilir, ödenmez yazılmaz
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 9, amount: sent.receipt.amount }] });
    const r5 = await h.call<{ code: string }>('patron', 'POST', `/orders/${device.id}/comp`, { kind: 'odenmez', reason: 'Zayi' });
    expect([r5.status, r5.json.code]).toEqual([409, 'okc_unresolved']);
  });

  it('hesap yazdırıldıktan sonra ciro dışı kapanış alarmdır', async () => {
    const o = await table([{ name: 'Americano', qty: 1 }], 'kasa');
    await h.ok('kasa', 'POST', `/orders/${o.id}/bill`, {});
    await h.ok('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'ikram', reason: 'Gecikme özrü' });
    ikramValue += 15000;
    const audit = await h.ok<{ action: string; orderId: string | null; severity: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    const entry = audit.find((a) => a.action === 'order.comp' && a.orderId === o.id)!;
    expect(entry.severity).toBe('alarm');
    expect(entry.message).toContain('hesap yazdırıldıktan sonra');
  });

  it('raporlar: ikram listesinde tür, özetde ödenmez ayrı; denetim kaydı', async () => {
    const today = (await day()).day as unknown as { date: string };
    const list = await h.ok<{ rows: { compKind: string | null; reason: string | null; value: number }[] }>('patron', 'GET', `/reports/items?kind=ikram&from=${today.date}&to=${today.date}`);
    expect(list.rows.filter((r) => r.compKind === 'odenmez').reduce((a, r) => a + r.value, 0)).toBe(odenmezValue + odenmezExtra);
    expect(list.rows.filter((r) => r.compKind === 'ikram').reduce((a, r) => a + r.value, 0)).toBe(ikramValue);
    const summary = await h.ok<{ complimentary: number; odenmez: number }>('patron', 'GET', `/reports/summary?from=${today.date}&to=${today.date}`);
    expect(summary).toMatchObject({ complimentary: ikramValue + odenmezValue + odenmezExtra, odenmez: odenmezValue + odenmezExtra });
    const audit = await h.ok<{ action: string; userName: string | null; approverName: string | null }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.find((a) => a.action === 'order.odenmez' && a.userName === 'Kasa')?.approverName).toBe('Müdür');
    const csv = await h.call<string>('patron', 'GET', `/reports/export.csv?type=ikram&from=${today.date}&to=${today.date}`);
    expect(csv.json).toContain('Ödenmez');
  });

  it('lafmaliyet gün paketi: ödenmez ikram satırında nedeniyle, toplam off_revenue ile aynı', async () => {
    const { day: open } = await day();
    const { buildDayPayload } = await import('../server/sync/lafmaliyet');
    const payload = buildDayPayload(open.id) as unknown as { ikram: { reason: string; menuValue: number }[]; z: { offRevenue: number } };
    expect(payload.ikram.some((i) => i.reason === 'Ödenmez: Personel yemeği')).toBe(true);
    expect(payload.ikram.some((i) => i.reason === 'Doğum günü')).toBe(true);
    expect(payload.ikram.reduce((a, i) => a + i.menuValue, 0)).toBeCloseTo(payload.z.offRevenue, 2);
  });
});

describe('sonradan eklenen yetki', () => {
  it('kayıtlı müdür seti ödenmez yetkisini bir kez alır; patron kaldırırsa geri gelmez', async () => {
    const { ROLE_DEFAULTS } = await import('@shared/permissions');
    const old = ROLE_DEFAULTS.mudur.filter((p) => p !== 'siparis.odenmez' && p !== 'rapor.maliyet');
    await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: old });
    const { upgradeRoleSets, getSettings, setSyncState } = await import('../server/lib/settings');
    setSyncState('rol-yetki-eklemeleri', []);
    upgradeRoleSets();
    expect(getSettings().rolePermissions.mudur).toContain('siparis.odenmez');
    await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: old });
    upgradeRoleSets();
    expect(getSettings().rolePermissions.mudur).not.toContain('siparis.odenmez');
  });
});
