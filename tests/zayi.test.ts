import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMP_KINDS, compReasonText } from '@shared/comp';
import type { OrderDTO, ZSummary } from '@shared/types';
import { PINS, startApp, type Harness } from './harness';

/**
 * Zayi (döküldü, yanlış hazırlandı, bozuk): adisyonun tamamı ödeme ekranından (`POST /orders/:id/comp` kind zayi) ya da
 * kalem kalem (`POST /orders/:id/items/:itemId/comp` kind zayi) ciro dışı yazılır. İkram ve ödenmezle aynı kapsam
 * (ciro dışı, `complimentary`), ama Z'de, raporda, CSV'de ve lafmaliyet ikram satırında ayrı; yetkisi ödenmezinki.
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

async function table(items: { name: string; qty: number }[], who = 'kasa') {
  const t = h.boot.tables.filter((x) => x.kind === 'masa')[tableIndex++];
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'masa', tableId: t.id, guests: 2 });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty })) });
}

const day = () => h.ok<{ summary: ZSummary; day: { id: string; date: string } }>('patron', 'GET', '/cash/day');

describe('zayi', () => {
  let ikramValue = 0;
  let odenmezValue = 0;
  let zayiValue = 0;

  it('ayarlar: zayi gerekçeleri varsayılanla gelir ve düzenlenir; ödenmez listesinde artık "Zayi" yok', async () => {
    expect(h.boot.settings.zayiReasons).toEqual(['Döküldü', 'Yanlış hazırlandı', 'Bozuk / bayat', 'Müşteri iade etti']);
    expect(h.boot.settings.odenmezReasons).not.toContain('Zayi');
    await h.ok('patron', 'PUT', '/admin/settings', { zayiReasons: ['Döküldü', 'Yandı'] });
    const boot = await h.ok<{ settings: { zayiReasons: string[]; odenmezReasons: string[] } }>('kasa', 'GET', '/bootstrap');
    expect(boot.settings.zayiReasons).toEqual(['Döküldü', 'Yandı']);
    // patchOf: gönderilmeyen alan varsayılanla ezilmez
    expect(boot.settings.odenmezReasons).toEqual(h.boot.settings.odenmezReasons);
    expect(COMP_KINDS).toEqual(['ikram', 'odenmez', 'zayi']);
  });

  it('adisyonun tamamı zayi: kasiyerin yetkisi yok (ödenmez yetkisi), müdür onaylar; bilinmeyen tür 422', async () => {
    await h.pinPrice('Americano', 15000);
    const o = await table([{ name: 'Americano', qty: 2 }]);
    const bad = await h.call<{ code: string }>('patron', 'POST', `/orders/${o.id}/comp`, { kind: 'fire', reason: 'x' });
    expect(bad.status).toBe(422);
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    expect([denied.status, denied.json.code]).toEqual([403, 'approval_required']);
    const blank = await h.call<{ code: string; error?: string }>('patron', 'POST', `/orders/${o.id}/comp`, { kind: 'zayi', reason: ' ' });
    expect([blank.status, blank.json.code]).toEqual([400, 'reason_required']);
    const closed = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'zayi', reason: 'Döküldü', approverPin: PINS.mudur });
    expect(closed.status).toBe('kapali');
    expect(closed.total).toBe(0);
    expect(closed.items.every((i) => i.complimentary && i.compKind === 'zayi' && i.compReason === 'Döküldü')).toBe(true);
    zayiValue += 2 * 15000;
    const audit = await h.ok<{ action: string; orderId: string | null; userName: string | null; approverName: string | null; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    const entry = audit.find((a) => a.action === 'order.zayi' && a.orderId === o.id)!;
    expect(entry.approverName).toBe('Müdür');
    expect(entry.message).toContain('zayi kapattı');
  });

  it('kalem zayi: adet seçilir, kalem bölünür, kalanı ödenir; geri alma yazanın yetkisini ister', async () => {
    await h.pinPrice('Latte', 16000);
    let o = await table([{ name: 'Latte', qty: 3 }]);
    const latte = o.items[0]!;
    const denied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items/${latte.id}/comp`, { kind: 'zayi', qty: 1, reason: 'Döküldü' });
    expect([denied.status, denied.json.code]).toEqual([403, 'approval_required']);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${latte.id}/comp`, { kind: 'zayi', qty: 1, reason: 'Döküldü', approverPin: PINS.mudur });
    const zayi = o.items.find((i) => i.complimentary)!;
    const paidLine = o.items.find((i) => !i.complimentary)!;
    expect([zayi.qty, zayi.compKind, zayi.compReason, paidLine.qty]).toEqual([1, 'zayi', 'Döküldü', 2]);
    expect(o.total).toBe(2 * 16000);
    // İkram yetkisi olan kasiyer zayi kaydını tek başına geri alamaz; müdür onayıyla alır, sonra yeniden yazar
    const undoDenied = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items/${zayi.id}/comp`, { undo: true, reason: '' });
    expect([undoDenied.status, undoDenied.json.code]).toEqual([403, 'approval_required']);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${zayi.id}/comp`, { undo: true, reason: '', approverPin: PINS.mudur });
    expect(o.items.some((i) => i.complimentary)).toBe(false);
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/comp`, { kind: 'zayi', qty: 1, reason: 'Yanlış hazırlandı' });
    // Kind verilmeyen kalem ikramı eskisi gibi ikramdır; kasiyer kendi yetkisiyle yapar ve geri alır
    const rest = o.items.find((i) => !i.complimentary)!;
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${rest.id}/comp`, { qty: 1, reason: 'Müdavim' });
    const ikram = o.items.find((i) => i.compKind === 'ikram')!;
    expect(ikram.qty).toBe(1);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${ikram.id}/comp`, { undo: true, reason: '' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${o.items.find((i) => !i.complimentary)!.id}/comp`, { qty: 1, reason: 'Müdavim' });
    expect(o.total).toBe(16000);
    const paid = await h.ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 16000 });
    expect(paid.closed).toBe(true);
    zayiValue += 16000;
    ikramValue += 16000;
  });

  it('ödenmez ve ikram zayiden ayrı sayılır; Z ve rapor özeti: complimentary = ikram + ödenmez + zayi, ciro 0 kalmaz', async () => {
    const o = await table([{ name: 'Americano', qty: 1 }]);
    await h.ok('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği' });
    odenmezValue += 15000;
    const { summary } = await day();
    expect(summary.complimentary).toBe(ikramValue + odenmezValue + zayiValue);
    expect(summary.odenmez).toBe(odenmezValue);
    expect(summary.zayi).toBe(zayiValue);
    expect(summary.netSales).toBe(16000);
    expect(summary.receipts).toBe(1);
    const today = (await day()).day.date;
    const rep = await h.ok<{ complimentary: number; odenmez: number; zayi: number; netSales: number }>('patron', 'GET', `/reports/summary?from=${today}&to=${today}`);
    expect(rep).toMatchObject({ complimentary: ikramValue + odenmezValue + zayiValue, odenmez: odenmezValue, zayi: zayiValue, netSales: 16000 });
    const live = await h.ok<{ complimentary: number; odenmez: number; zayi: number }>('patron', 'GET', '/reports/patron');
    expect(live).toMatchObject({ complimentary: ikramValue + odenmezValue + zayiValue, odenmez: odenmezValue, zayi: zayiValue });
  });

  it('ikram listesi türü taşır; CSV "Zayi" sütunu; lafmaliyet ikram satırında "Zayi: " ön eki, toplam off_revenue', async () => {
    const today = (await day()).day.date;
    const list = await h.ok<{ rows: { compKind: string | null; reason: string | null; value: number }[] }>('patron', 'GET', `/reports/items?kind=ikram&from=${today}&to=${today}`);
    const by = (kind: string) => list.rows.filter((r) => r.compKind === kind).reduce((a, r) => a + r.value, 0);
    expect([by('zayi'), by('odenmez'), by('ikram')]).toEqual([zayiValue, odenmezValue, ikramValue]);
    const csv = await h.call<string>('patron', 'GET', `/reports/export.csv?type=ikram&from=${today}&to=${today}`);
    expect(csv.json).toContain('Zayi');
    expect(csv.json).toContain('Ödenmez');
    const { day: open } = await day();
    const { buildDayPayload } = await import('../server/sync/lafmaliyet');
    const payload = buildDayPayload(open.id) as unknown as { ikram: { reason: string; menuValue: number }[]; z: { offRevenue: number } };
    expect(payload.ikram.some((i) => i.reason === 'Zayi: Döküldü')).toBe(true);
    expect(payload.ikram.some((i) => i.reason === 'Ödenmez: Personel yemeği')).toBe(true);
    expect(payload.ikram.some((i) => i.reason === 'Müdavim')).toBe(true);
    expect(payload.ikram.reduce((a, i) => a + i.menuValue, 0)).toBeCloseTo(payload.z.offRevenue, 2);
    expect(compReasonText('zayi', 'Bozuk')).toBe('Zayi: Bozuk');
    expect(compReasonText('ikram', 'Tadım')).toBe('Tadım');
    expect(compReasonText(null, null)).toBe('');
  });

  it('tahsilatı platformun yaptığı paket siparişi ciro dışı kapanmaz; kendi kuryemiz kapıda alıyorsa kapanır', async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
    const service = await import('../server/delivery/service');
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    const ingest = (over: { code: string; courier: 'platform' | 'restoran'; platformCollects: boolean }) => {
      const fx = new Effects();
      const lines = [{ externalId: 'ys-latte', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: [], note: null }];
      const res = tx((t) =>
        service.ingestPlatformOrder(t, fx, {
          platform: 'yemeksepeti',
          simulated: true,
          externalId: `ys-${over.code}`,
          code: over.code,
          placedAt: Date.now(),
          scheduledFor: null,
          courier: over.courier,
          platformCollects: over.platformCollects,
          paymentLabel: over.platformCollects ? 'Online kart' : 'Kapıda nakit',
          customer: { name: 'Ayşe K.', phone: null, address: null },
          note: null,
          lines,
          subtotal: 19000,
          restaurantDiscount: 0,
          platformDiscount: 0,
          customerTotal: 19000,
        }),
      );
      fx.flush();
      return res.row;
    };
    const paid = ingest({ code: 'ZY01', courier: 'platform', platformCollects: true });
    const a = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${paid.id}/accept`, {});
    const r1 = await h.call<{ code: string }>('mudur', 'POST', `/orders/${a.orderId}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    expect([r1.status, r1.json.code]).toEqual([409, 'platform_order']);
    const o = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${a.orderId}`);
    const r2 = await h.call<{ code: string }>('mudur', 'POST', `/orders/${a.orderId}/items/${o.items[0]!.id}/comp`, { kind: 'zayi', qty: 1, reason: 'Döküldü' });
    expect([r2.status, r2.json.code]).toEqual([409, 'platform_order']);
    const r3 = await h.call<{ code: string }>('mudur', 'POST', `/orders/${a.orderId}/items/${o.items[0]!.id}/comp`, { qty: 1, reason: 'Müdavim' });
    expect([r3.status, r3.json.code]).toEqual([409, 'platform_order']);
    // Kendi kuryemiz kapıda alıyor: tahsilat kasada, dökülen sipariş zayi kapanabilir
    const cash = ingest({ code: 'ZY02', courier: 'restoran', platformCollects: false });
    const b = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${cash.id}/accept`, {});
    const closed = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${b.orderId}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    expect([closed.status, closed.total]).toEqual(['kapali', 0]);
    zayiValue += 19000;
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'kapali' });
  });

  it('açılış düzeltmesi: kayıtlı Ödenmez gerekçelerinden "Zayi" bir kez düşer, patron yeniden yazarsa kalır', async () => {
    const { upgradeStoredSettings, getSettings, setSyncState } = await import('../server/lib/settings');
    await h.ok('patron', 'PUT', '/admin/settings', { odenmezReasons: ['Personel yemeği', 'ZAYİ', 'Deneme'] });
    setSyncState('ayar-guncellemeleri', []);
    upgradeStoredSettings();
    expect(getSettings().odenmezReasons).toEqual(['Personel yemeği', 'Deneme']);
    await h.ok('patron', 'PUT', '/admin/settings', { odenmezReasons: ['Zayi'] });
    upgradeStoredSettings();
    expect(getSettings().odenmezReasons).toEqual(['Zayi']);
    await h.ok('patron', 'PUT', '/admin/settings', { odenmezReasons: ['Personel yemeği', 'Deneme'] });
  });

  it('ödeme alınmış adisyon zayi kapanmaz (kalem kalem yazılır); iptal edilmiş kalem zayi yazılamaz', async () => {
    const o = await table([{ name: 'Americano', qty: 2 }]);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 15000 });
    const r1 = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'zayi', reason: 'Döküldü' });
    expect([r1.status, r1.json.code]).toEqual([409, 'has_payments']);
    const live = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    const unpaid = live.items.find((i) => i.qty - i.paidQty > 0)!;
    const voided = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${unpaid.id}/void`, { qty: 1, reason: 'Yanlış giriş' });
    const dead = voided.items.find((i) => i.voided)!;
    const r2 = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/items/${dead.id}/comp`, { kind: 'zayi', qty: 1, reason: 'Döküldü' });
    expect(r2.status).toBe(409);
  });
});
