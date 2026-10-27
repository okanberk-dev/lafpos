import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, OrderDTO } from '@shared/types';

/**
 * Uçtan uca API akışı (sunucu süreç içinde, geçici veritabanıyla): kurulum verisi, gün açma, masa ve tezgâh
 * satışı, seçenek fiyatları, iptal/indirim yetkisi, kalem bazlı ve nakit ödeme, eğitim cihazıyla yazarkasa
 * ödemesi, karaoke odası, gün sonu, lafmaliyet paketi ve yetki sınırları.
 */
const dir = mkdtempSync(join(tmpdir(), 'lafpos-test-'));
process.env.LAFPOS_DATA_DIR = dir;
process.env.LAFPOS_NO_JOBS = '1';

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };
let app: App;
const tokens: Record<string, string> = {};
let boot: BootstrapDTO;

async function call<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<{ status: number; json: T }> {
  const res = await app.request(`/api${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: (text && text.startsWith('{')) || text.startsWith('[') ? JSON.parse(text) : (text as T) };
}
const ok = async <T,>(who: string, method: string, path: string, body?: unknown): Promise<T> => {
  const r = await call<T>(who, method, path, body);
  if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};

beforeAll(async () => {
  const { runMigrations } = await import('../server/db/client');
  const { seedIfEmpty } = await import('../server/db/seed');
  const { createApp } = await import('../server/app');
  runMigrations();
  seedIfEmpty();
  app = createApp();
  for (const [who, pin] of Object.entries({ kasa: '1111', garson: '2222', mudur: '2468', patron: '1897' })) {
    const r = await call<{ token: string }>('', 'POST', '/auth/login', { pin });
    tokens[who] = r.json.token;
  }
  boot = await ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

const product = (name: string) => boot.products.find((p) => p.name === name)!;
const optionItem = (groupKey: string, code: string) => boot.optionGroups.find((g) => g.extKey === groupKey)!.items.find((i) => i.code === code)!;
const method = (name: string) => boot.paymentMethods.find((m) => m.name === name)!;

describe('LafPOS uçtan uca', () => {
  it('kurulum: site menüsü, yerel ürünler, seçenekler, masa planı', () => {
    expect(boot.products.length).toBeGreaterThan(80);
    expect(product('Latte').priceL).toBeGreaterThan(product('Latte').price);
    expect(product('Türk kahvesi').optionGroupIds.length).toBe(1);
    expect(boot.tables.some((t) => t.kind === 'oda')).toBe(true);
    expect(boot.integrations.okc.provider).toBe('simulator');
    expect('cost' in boot.products[0]).toBe(false);
  });

  it('gün açılmadan satış yok; kasiyer günü açar', async () => {
    const r = await call('garson', 'POST', '/orders', { type: 'tezgah' });
    expect(r.status).toBe(409);
    await ok('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
  });

  let masa: OrderDTO;
  it('masa: seçenek fiyatı sunucuda, zorunlu seçenekte varsayılan', async () => {
    const table = boot.tables.find((t) => t.kind === 'masa')!;
    masa = await ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id, guests: 2 });
    masa = await ok<OrderDTO>('garson', 'POST', `/orders/${masa.id}/items`, {
      items: [
        { productId: product('Latte').id, size: 'L', qty: 1, options: [{ itemId: optionItem('milk', 'oat').id }, { itemId: optionItem('syrup', 'vanilla').id }, { itemId: optionItem('extraShot', 'extraShot').id, qty: 1 }] },
        { productId: product('Türk kahvesi').id, qty: 2 },
      ],
    });
    const latte = masa.items.find((i) => i.name === 'Latte')!;
    expect(latte.unitPrice).toBe(product('Latte').priceL! + 2500 + 5000 + 5000);
    expect(latte.optionsText).toContain('Yulaf');
    const tk = masa.items.find((i) => i.name === 'Türk kahvesi')!;
    expect(tk.optionsText).toBe('Orta');
  });

  it('garson indirim yapamaz; müdür PIN onayıyla yapar', async () => {
    const denied = await call<{ code: string }>('garson', 'POST', `/orders/${masa.id}/discount`, { type: 'percent', value: 20, reason: 'Öğrenci' });
    expect(denied.status).toBe(403);
    expect(denied.json.code).toBe('approval_required');
    masa = await ok<OrderDTO>('garson', 'POST', `/orders/${masa.id}/discount`, { type: 'percent', value: 20, reason: 'Öğrenci', approverPin: '2468' });
    expect(masa.totals.orderDiscount).toBeGreaterThan(0);
  });

  it('kalem bazlı kart + nakit ödeme, para üstü, adisyon kapanır', async () => {
    const tk = masa.items.find((i) => i.name === 'Türk kahvesi')!;
    const first = await ok<{ order: OrderDTO; closed: boolean }>('kasa', 'POST', `/orders/${masa.id}/payments`, { methodId: method('Kredi kartı').id, amount: masa.totals.lineNet[tk.id], items: [{ itemId: tk.id, qty: 2 }] });
    expect(first.closed).toBe(false);
    const due = first.order.total - first.order.paid;
    const second = await ok<{ order: OrderDTO; closed: boolean; change: number }>('kasa', 'POST', `/orders/${masa.id}/payments`, { methodId: method('Nakit').id, amount: due, given: due + 10000 });
    expect(second.closed).toBe(true);
    expect(second.change).toBe(10000);
    expect(second.order.paid).toBe(second.order.total);
  });

  it('tezgâh satışı eğitim cihazında (yazarkasa) ödenir, adisyon kendiliğinden kapanır', async () => {
    let o = await ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 2 }] });
    const sent = await ok<{ receipt: { id: string; amount: number; status: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(sent.receipt.amount).toBe(o.total);
    const again = await call('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(again.status).toBe(409);
    const done = await ok<{ status: string; zNo: number; receiptNo: number }>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, {
      payments: [
        { type: 3, amount: o.total - 5000 },
        { type: 1, amount: 5000 },
      ],
    });
    expect(done.status).toBe('tamamlandi');
    // Kör kasa: kasiyer kapanmış adisyonun ödeme dökümünü görmez, müdür görür
    expect((await ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`)).payments).toEqual([]);
    const after = await ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(after.status).toBe('kapali');
    expect(after.payments.map((p) => p.methodName).sort()).toEqual(['Kredi kartı', 'Nakit']);
    expect(after.items.every((i) => i.paidQty === i.qty)).toBe(true);
  });

  it('cihazda fiş iptali LafPOS ödemesini geri alır ve adisyonu açar', async () => {
    let o = await ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    const sent = await ok<{ receipt: { id: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    await ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: o.total }] });
    // Fiş iptali ödeme iptalidir: yetkili onayı ister
    const denied = await call<{ code: string }>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/cancel`, { voidReceipt: true });
    expect(denied.json.code).toBe('approval_required');
    await ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/cancel`, { voidReceipt: true, approverPin: '2468' });
    const after = await ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(after.status).toBe('acik');
    expect(after.paid).toBe(0);
    await ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Test' });
  });

  it('karaoke odası: sayaç çalışırken ödeme alınmaz, durunca en az 1 saat yazılır', async () => {
    const room = boot.tables.find((t) => t.kind === 'oda')!;
    const o = await ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    await ok('kasa', 'POST', `/orders/${o.id}/room/start`, {});
    const blocked = await call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: 100 });
    expect([409, 400]).toContain(blocked.status);
    const stopped = await ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/room/stop`, {});
    expect(stopped.total).toBe(room.hourlyRate);
    await ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, amount: stopped.total });
  });

  it('garson rapor göremez; patron görür', async () => {
    expect((await call('garson', 'GET', '/reports/summary')).status).toBe(403);
    const s = await ok<{ netSales: number; receipts: number }>('patron', 'GET', '/reports/summary');
    expect(s.receipts).toBeGreaterThanOrEqual(3);
    const live = await ok<{ netSales: number; anomalies: unknown[] }>('patron', 'GET', '/reports/patron');
    expect(live.netSales).toBe(s.netSales);

    // Masasız açık adisyon patron panelinde türünün adıyla görünür, ham anahtarla ("tezgah") değil
    const t = await ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const withItem = await ok<OrderDTO>('kasa', 'POST', `/orders/${t.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const after = await ok<{ openChecks: { id: string; place: string }[] }>('patron', 'GET', '/reports/patron');
    expect(after.openChecks.find((c) => c.id === t.id)?.place).toBe('Tezgâh');
    await ok('kasa', 'POST', `/orders/${t.id}/payments`, { methodId: method('Nakit').id, amount: withItem.total });
  });

  it('kör kasa: kasiyer ara raporu görmez; rol yetkisi verilince görür (rol matrisi)', async () => {
    const blind = await ok<{ summary: unknown; blind: boolean }>('kasa', 'GET', '/cash/day');
    expect(blind.blind).toBe(true);
    expect(blind.summary).toBeNull();
    const roles = await ok<{ roles: { role: string; permissions: string[]; defaults: string[]; locked: boolean }[] }>('patron', 'GET', '/admin/roles');
    const kasiyer = roles.roles.find((r) => r.role === 'kasiyer')!;
    expect(kasiyer.permissions).not.toContain('kasa.rakam');
    await ok('patron', 'PUT', '/admin/roles/kasiyer', { permissions: [...kasiyer.permissions, 'kasa.rakam'] });
    const seen = await ok<{ summary: { expectedCash: number } | null; blind: boolean }>('kasa', 'GET', '/cash/day');
    expect(seen.blind).toBe(false);
    expect(seen.summary?.expectedCash).toBeGreaterThan(0);
    // Varsayılana dönünce özel kayıt silinir, kasiyer yine kör sayar
    const back = await ok<{ custom: boolean }>('patron', 'PUT', '/admin/roles/kasiyer', { permissions: kasiyer.defaults });
    expect(back.custom).toBe(false);
    expect((await ok<{ blind: boolean }>('kasa', 'GET', '/cash/day')).blind).toBe(true);
    // Patron rolü kilitli; personel yetkisi olmayan rol değiştiremez; denetim kaydına uyarı düşer
    expect((await call<{ code: string }>('patron', 'PUT', '/admin/roles/patron', { permissions: [] })).json.code).toBe('role_locked');
    expect((await call('kasa', 'PUT', '/admin/roles/garson', { permissions: [] })).status).toBe(403);
    const audit = await ok<{ action: string; severity: string }[]>('patron', 'GET', '/admin/audit?severity=uyari&limit=50');
    expect(audit.some((a) => a.action === 'role.permissions')).toBe(true);
  });

  it('kasiyer ürünü kasadan tükendi işaretler; garson işaretleyemez', async () => {
    const espresso = product('Espresso');
    expect((await call('garson', 'POST', `/sync/products/${espresso.id}/availability`, { active: false })).status).toBe(403);
    await ok('kasa', 'POST', `/sync/products/${espresso.id}/availability`, { active: false });
    expect((await ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).products.find((p) => p.id === espresso.id)?.active).toBe(false);
    await ok('kasa', 'POST', `/sync/products/${espresso.id}/availability`, { active: true });
  });

  it('gün sonu Z ve lafmaliyet paketi (ekler ayrı satır, TL); kasiyer kör kapatır', async () => {
    const x = await ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closed = await ok<{ day: { id: string }; summary: unknown; blind: boolean }>('kasa', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
    expect(closed.blind).toBe(true);
    expect(closed.summary).toBeNull();
    const z = await ok<{ day: { id: string }; summary: { cashDiff: number; netSales: number }; lafmaliyet: Record<string, number> }>('patron', 'GET', `/cash/days/${closed.day.id}`);
    expect(z.summary.cashDiff).toBe(0);
    expect(z.lafmaliyet.z_total).toBeCloseTo(z.summary.netSales / 100, 2);
    const payload = await ok<{ lines: { posName: string; siteMenuId: string | null; slot: string | null; qty: number; revenue: number }[]; z: { zTotal: number } }>('patron', 'GET', `/sync/lafmaliyet/gun/${z.day.id}`);
    const names = payload.lines.map((l) => l.posName);
    expect(names).toEqual(expect.arrayContaining(['LATTE LARGE', 'LATTE MEDIUM', 'EXTRA SHOT', 'SYRUP', 'ALTERNATIF SÜT', 'TÜRK KAHVESİ', 'KARAOKE ODASI']));
    expect(new Set(names).size).toBe(names.length);
    const latteL = payload.lines.find((l) => l.posName === 'LATTE LARGE')!;
    expect(latteL.siteMenuId).toMatch(/^mnu-/);
    expect(latteL.slot).toBe('L');
    const sum = payload.lines.reduce((a, l) => a + l.revenue, 0);
    expect(sum).toBeCloseTo(payload.z.zTotal, 1);
    const csv = await app.request('/api/sync/lafmaliyet/satislar.csv', { headers: { authorization: `Bearer ${tokens.patron}` } });
    const bytes = new Uint8Array(await csv.arrayBuffer());
    // Excel'in Türkçe karakterleri doğru açması için UTF-8 BOM (Response.text() BOM'u siler, baytlara bakılır)
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder().decode(bytes)).toMatch(/^Ürün;Adet;Tutar/);
  });
});
