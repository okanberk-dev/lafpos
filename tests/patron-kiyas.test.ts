import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDays, businessDate, businessDayStartMs } from '@shared/time';
import { monthStart, type PatronStats, sameDayLastMonth, todayStats, topCompare, weekStart } from '@shared/today-stats';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Patron panelinin "Bugün" kıyasları kasadaki Raporlar'la kuruşu kuruşuna aynı: kasa girdiyi (`stats`) kurar, ekran
 * `shared/today-stats.ts` ile hesaplar. Dün ve geçen ayın aynı günü tam gün = Raporlar › Ciro o gün; geçen hafta
 * aynı saate kadar = panelin eski kıyası (`compare.lastWeek`); hafta ve ay başından bugüne = Raporlar › Ciro o dönem
 * ve kıyas dönemi (`comparison`, aynı saate kadar). Geç kapanan adisyon (geçen hafta, bu saatten 2 saat sonra) kıyasa
 * girmez, tam güne girer.
 */
let h: Harness;
const MUDUR = PINS.mudur;

beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const add = (o: OrderDTO, items: { name: string; qty?: number; size?: 'M' | 'L' }[]) =>
  h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
    items: items.map((i) => ({
      productId: product(i.name).id,
      qty: i.qty ?? 1,
      ...(i.size ? { size: i.size } : {}),
    })),
  });
const pay = (o: OrderDTO, name: string, amount: number) =>
  h.ok('kasa', 'POST', `/orders/${o.id}/payments`, {
    methodId: method(name).id,
    amount,
  });

/** Bir gün: masa (indirim, ikram), tezgâh nakit, tamamı ikram edilen adisyon; `n` çarpanı günleri birbirinden ayırır */
async function sellDay(n: number, openOne = false) {
  const tables = h.boot.tables.filter((t) => t.kind !== 'oda');
  let a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', {
    type: 'masa',
    tableId: tables[0]!.id,
    guests: 2,
  });
  a = await add(a, [
    { name: 'Latte', size: 'M', qty: n },
    { name: 'Türk Kahvesi', qty: 2 },
  ]);
  await h.ok('kasa', 'POST', `/orders/${a.id}/items/${a.items.find((i) => i.name === 'Türk Kahvesi')!.id}/comp`, { qty: 1, reason: 'Müdavim', approverPin: MUDUR });
  a = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${a.id}`);
  await pay(a, 'Kredi kartı', a.total);
  let b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  b = await add(b, [{ name: 'Americano', size: 'M', qty: n + 1 }]);
  await pay(b, 'Nakit', b.total);
  let c = await h.ok<OrderDTO>('kasa', 'POST', '/orders', {
    type: 'tezgah',
    reuse: null,
  });
  c = await add(c, [{ name: 'Espresso', size: 'M' }]);
  c = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${c.id}/items/${c.items[0]!.id}/comp`, { reason: 'Gecikme', approverPin: MUDUR });
  await h.ok('kasa', 'POST', `/orders/${c.id}/close`, {});
  if (openOne) {
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', {
      type: 'masa',
      tableId: tables[1]!.id,
      guests: 3,
    });
    d = await add(d, [{ name: 'Flat White', size: 'M' }]);
  }
}

async function closeAndMove(toDate: string) {
  const r = await h.ok<{ day: { id: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
  const { sqlite, db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, r.day.id)).get()!;
  const shift = businessDayStartMs(day.date) - businessDayStartMs(toDate);
  sqlite.prepare('UPDATE business_days SET date = ?, opened_at = opened_at - ?, closed_at = closed_at - ? WHERE id = ?').run(toDate, shift, shift, r.day.id);
  sqlite.prepare('UPDATE orders SET opened_at = opened_at - ?, closed_at = closed_at - ?, updated_at = updated_at - ? WHERE day_id = ?').run(shift, shift, shift, r.day.id);
  sqlite
    .prepare('UPDATE order_items SET created_at = created_at - ?, sent_at = sent_at - ?, voided_at = voided_at - ? WHERE order_id IN (SELECT id FROM orders WHERE day_id = ?)')
    .run(shift, shift, shift, r.day.id);
  sqlite.prepare('UPDATE payments SET created_at = created_at - ? WHERE day_id = ?').run(shift, r.day.id);
}

interface Patron {
  now: number;
  date: string;
  dayOpen: boolean;
  netSales: number;
  orders: number;
  compare: { lastWeek: { netSales: number; orders: number } };
  top: { key: string; qty: number; revenue: number }[];
  stats: PatronStats;
}

describe('patron "Bugün" kıyasları', () => {
  it('kasadaki Raporlar ile aynı', async () => {
    const today = businessDate(Date.now());
    const lastMonth = sameDayLastMonth(today);
    const past = [addDays(today, -9), addDays(today, -7), addDays(today, -2), addDays(today, -1), ...(lastMonth && lastMonth < addDays(today, -9) ? [lastMonth, addDays(lastMonth, -1)] : [])];
    for (const [i, date] of past.entries()) {
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      await sellDay(i + 1);
      await closeAndMove(date);
    }
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await sellDay(3, true);
    const now = Date.now();
    // Geçen hafta: bir adisyon bu saatten 2 saat sonra kapanmış
    const { sqlite, db, schema } = await import('../server/db/client');
    const lw = db
      .select()
      .from(schema.businessDays)
      .all()
      .find((d) => d.date === addDays(today, -7))!;
    const late = db
      .select()
      .from(schema.orders)
      .all()
      .find((o) => o.dayId === lw.id && o.status === 'kapali' && o.type === 'tezgah' && o.total > 0)!;
    sqlite.prepare('UPDATE orders SET closed_at = ? WHERE id = ?').run(now - 7 * 86400_000 + 2 * 3600_000, late.id);

    const d = await h.ok<Patron>('patron', 'GET', '/reports/patron');
    const rep = await import('../server/services/reports');
    const r = todayStats(d, d.stats, d.now);
    expect(r.mode).toBe('live');

    // Bugün: kapanış dakikalarının toplamı = panelin cirosu ve adisyonu
    const todayCloses = d.stats.days[today]!.closes;
    expect(todayCloses.reduce((a, c) => a + c[1], 0)).toBe(d.netSales);
    expect(todayCloses.reduce((a, c) => a + c[2], 0)).toBe(d.orders);
    expect(d.netSales).toBeGreaterThan(0);
    expect(r.guests).toBe(rep.summaryReport({ from: today, to: today }, d.now).guests);

    const full = (date: string) => {
      const s = rep.summaryReport({ from: date, to: date }, d.now);
      return { netSales: s.netSales, receipts: s.receipts };
    };
    const [dun, hafta, ay] = r.compares;
    expect(dun!.full).toEqual(full(addDays(today, -1)));
    expect(hafta!.full).toEqual(full(addDays(today, -7)));
    // Geçen hafta aynı saate kadar: panelin eski kıyası ve Raporlar'ın tek günlük kıyası
    expect(hafta!.value).toEqual({
      netSales: d.compare.lastWeek.netSales,
      receipts: d.compare.lastWeek.orders,
    });
    expect(hafta!.value).toEqual({
      netSales: rep.summaryReport({ from: today, to: today }, d.now).previous.netSales,
      receipts: rep.summaryReport({ from: today, to: today }, d.now).previous.receipts,
    });
    expect(hafta!.value!.netSales).toBeLessThan(hafta!.full!.netSales);
    if (lastMonth && lastMonth < addDays(today, -9)) expect(ay!.full).toEqual(full(lastMonth));

    // Hafta ve ay başından bugüne = Raporlar › Ciro o dönem; kıyas = Raporlar'ın kıyas dönemi (aynı saate kadar)
    for (const p of r.periods) {
      const range = {
        from: p.key === 'hafta' ? weekStart(today) : monthStart(today),
        to: today,
      };
      const s = rep.summaryReport(range, d.now);
      expect({ netSales: p.cur.netSales, receipts: p.cur.receipts }).toEqual({
        netSales: s.netSales,
        receipts: s.receipts,
      });
      expect({ netSales: p.prev.netSales, receipts: p.prev.receipts }).toEqual({
        netSales: s.previous.netSales,
        receipts: s.previous.receipts,
      });
      expect(p.change).toBe(s.previous.change);
    }
    expect(r.periods.map((p) => p.key)).toEqual(['hafta', 'ay']);

    // En çok satanlar: geçen hafta tam gün = Raporlar › Ürünler o gün
    const lwProducts = rep.productReport({ from: addDays(today, -7), to: addDays(today, -7) }, false).products;
    for (const p of topCompare(d.top, d.stats, null, true)) {
      const row = lwProducts.find((x) => x.key === p.key);
      expect(p.prev).toEqual({
        qty: row?.qty ?? 0,
        revenue: row?.revenue ?? 0,
      });
    }

    // Özet saatten bağımsız: aynı veriyle bir dakika sonra da aynı girdi (Uzaktan'ın değişmeyen özeti yazılmaz)
    expect(rep.patronLive(false).stats).toEqual(d.stats);
  });
});
