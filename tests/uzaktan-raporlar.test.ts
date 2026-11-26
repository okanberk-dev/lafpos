import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RemoteDayReport } from '@shared/remote-reports';
import { addDays, businessDayStartMs } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';
import { REDIS_ONEKI } from '@shared/eski-adlar';

/**
 * Müşterinin telefonunun yazılabileceği biçimler (yalnız '0530' aranmaz: gövdedeki milisaniyelik bir zaman damgası
 * rastgele o rakamları taşıyabiliyordu, test ara sıra düşüyordu)
 */
const PHONE_FORMS = ['0530 000 11 22', '05300001122', '5300001122', '000 11 22'];

/**
 * AsilPOS Uzaktan raporları (server/sync/cloud-reports.ts → api/uzaktan.ts). Kasa günlük rapor özetlerini iter, bulut
 * dönemin günlerini toplar. Doğrulama: aynı veriyle uzaktaki Ciro, Saatlik, Ürünler ve Personel kasadakiyle kuruşu
 * kuruşuna aynı (tek gün, çok gün, bugünü içeren dönemin "aynı saate kadar" kıyası); günlerde maliyet, kâr, PIN,
 * müşteri adı ve telefonu yok; internetsizken kuyrukta bekleyen günler internet dönünce tam bir kez gider; ilk
 * açılıştaki tarama 400 günü paketlerle gezer, ikinci tarama değişmeyen günü göndermez. Dönem 400 günle sınırlı.
 */
const CLOUD = 'https://asilpos-uzak.test';
const SECRET = 'r'.repeat(40);
const MUDUR = PINS.mudur;
const store = new Map<string, string>();
const posted: { path: string; days: string[] }[] = [];
let offline = false;
let h: Harness;
let today: string;

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET });
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0' });
  const realFetch = globalThis.fetch;
  const { gunzipSync } = await import('node:zlib');
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://redis.test') return new Response(JSON.stringify({ result: redis(JSON.parse(String(init!.body)) as string[]) }));
    if (!url.startsWith(CLOUD)) return realFetch(input, init);
    if (offline) throw new TypeError('fetch failed');
    // Kasanın itmesi doğrudan Vercel işlevine (imza, gzip, saklama gerçek)
    const path = new URL(url).pathname.replace(/^\/api\//, '');
    if (path === 'uzaktan/rapor') {
      const { gz } = JSON.parse(String(init!.body)) as { gz: string };
      posted.push({ path, days: (JSON.parse(gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')) as { days: RemoteDayReport[] }).days.map((d) => d.date) });
    }
    const { POST } = await import('../api/uzaktan');
    return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: init!.body as string, headers: init!.headers as Record<string, string> }));
  });
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

/** Bellekte Upstash: GET, SET (EX/EXAT), MGET, INCR, DEL, EXPIRE */
function redis([cmd, ...args]: string[]): unknown {
  if (cmd === 'GET') return store.get(args[0]!) ?? null;
  if (cmd === 'MGET') return args.map((k) => store.get(k) ?? null);
  if (cmd === 'SET') return (store.set(args[0]!, args[1]!), 'OK');
  if (cmd === 'INCR') return (store.set(args[0]!, String(Number(store.get(args[0]!) ?? 0) + 1)), Number(store.get(args[0]!)));
  if (cmd === 'DEL') return (store.delete(args[0]!), 1);
  return 1;
}

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const add = (o: OrderDTO, items: { name: string; qty?: number; size?: 'M' | 'L' }[]) =>
  h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
const pay = (o: OrderDTO, name: string, amount: number, tip = 0) => h.ok<{ order: OrderDTO }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method(name).id, amount, tip });

/** Gerçekçi bir gün: masa (indirim, ikram, iptal, kart ve bahşiş), tezgâh (adisyon indirimi, nakit), müşteriye ödenmez */
async function sellDay(customerId: string, openOne = false) {
  const tables = h.boot.tables.filter((t) => t.kind !== 'oda');
  let a = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: tables[0]!.id, guests: 3 });
  a = await add(a, [{ name: 'Latte', size: 'M', qty: 2 }, { name: 'Türk Kahvesi', qty: 2 }, { name: 'Espresso', size: 'M' }]);
  const latte = a.items.find((i) => i.name === 'Latte')!;
  const turk = a.items.find((i) => i.name === 'Türk Kahvesi')!;
  const esp = a.items.find((i) => i.name === 'Espresso')!;
  await h.ok('kasa', 'POST', `/orders/${a.id}/items/${latte.id}/discount`, { type: 'percent', value: 15, reason: 'Müdavim', approverPin: MUDUR });
  await h.ok('kasa', 'POST', `/orders/${a.id}/items/${turk.id}/comp`, { qty: 1, reason: 'Müdavim', approverPin: MUDUR });
  a = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${a.id}/items/${esp.id}/void`, { reason: 'Vazgeçti', approverPin: MUDUR });
  await pay(a, 'Kredi kartı', a.total, 2500);

  let b = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  b = await add(b, [{ name: 'Mocha', size: 'L' }, { name: 'Americano', size: 'M', qty: 3 }]);
  b = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${b.id}/discount`, { type: 'amount', value: 3333, reason: 'Kampanya', approverPin: MUDUR });
  await pay(b, 'Nakit', b.total);

  let c = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  c = await add(c, [{ name: 'Latte', size: 'L', qty: 2 }]);
  c = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${c.id}/items/${c.items[0]!.id}/comp`, { qty: 1, kind: 'odenmez', reason: 'Müşteri şikâyeti', person: { kind: 'customer', id: customerId } });
  await pay(c, 'Nakit', c.total);

  if (openOne) {
    let d = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: tables[2]!.id, guests: 2 });
    d = await add(d, [{ name: 'Flat White', size: 'M', qty: 2 }]);
    await pay(d, 'Nakit', 5000);
  }
}

/** Kapanmış günü geçmiş bir tarihe taşır: gün ve bütün zaman damgaları aynı kadar geri */
async function moveDay(dayId: string, toDate: string) {
  const { sqlite, db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get()!;
  const shift = businessDayStartMs(day.date) - businessDayStartMs(toDate);
  sqlite.prepare('UPDATE business_days SET date = ?, opened_at = opened_at - ?, closed_at = closed_at - ? WHERE id = ?').run(toDate, shift, shift, dayId);
  sqlite
    .prepare('UPDATE orders SET opened_at = opened_at - ?, closed_at = closed_at - ?, updated_at = updated_at - ?, bill_printed_at = bill_printed_at - ? WHERE day_id = ?')
    .run(shift, shift, shift, shift, dayId);
  sqlite
    .prepare(
      'UPDATE order_items SET created_at = created_at - ?, sent_at = sent_at - ?, started_at = started_at - ?, ready_at = ready_at - ?, served_at = served_at - ?, voided_at = voided_at - ? WHERE order_id IN (SELECT id FROM orders WHERE day_id = ?)',
    )
    .run(shift, shift, shift, shift, shift, shift, dayId);
  sqlite.prepare('UPDATE payments SET created_at = created_at - ?, refunded_at = refunded_at - ? WHERE day_id = ?').run(shift, shift, dayId);
}

async function closeAndMove(toDate: string) {
  const r = await h.ok<{ day: { id: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
  await moveDay(r.day.id, toDate);
}

let NOW = 0;
let lateOrderId = '';

describe('uzaktan raporlar', () => {
  it('kurulum: geçen hafta, dün ve bugün (bir adisyon açık)', async () => {
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Ayşe Yılmaz', phone: '0530 000 11 22' });
    const { businessDate } = await import('@shared/time');
    today = businessDate(Date.now());
    // Geçen haftanın aynı günü: bir adisyon bugünün bu saatinden 2 saat sonra kapanmış (kıyas "aynı saate kadar")
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await sellDay(cust.id);
    await closeAndMove(addDays(today, -7));
    // Dün
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await sellDay(cust.id);
    await closeAndMove(addDays(today, -1));
    // Bugün
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await sellDay(cust.id, true);
    NOW = Date.now();
    const { sqlite, db, schema } = await import('../server/db/client');
    const day = db.select().from(schema.businessDays).all().find((d) => d.date === addDays(today, -7))!;
    lateOrderId = db.select().from(schema.orders).all().filter((o) => o.dayId === day.id && o.status === 'kapali' && o.type === 'tezgah').sort((a, b) => a.openedAt - b.openedAt)[0]!.id;
    sqlite.prepare('UPDATE orders SET closed_at = ? WHERE id = ?').run(NOW - 7 * 86400_000 + 2 * 3600_000, lateOrderId);
  });

  it('ilk tarama günleri iter; ikinci tur değişmeyen günü göndermez', async () => {
    const cr = await import('../server/sync/cloud-reports');
    cr.resetReportSync();
    posted.length = 0;
    // Dakikada 7 gün: 400 gün yaklaşık 58 turda
    let turns = 0;
    do await cr.reportTick({ backfill: true, now: NOW + turns++ * 60_000 });
    while (cr.reportSyncState().backfilling && turns < 80);
    expect(turns).toBeGreaterThan(50);
    expect(turns).toBeLessThan(62);
    const sent = posted.flatMap((p) => p.days).sort();
    expect(sent).toEqual([addDays(today, -7), addDays(today, -1), today].sort());
    expect(cr.reportSyncState().backfilling).toBe(false);
    posted.length = 0;
    const again = await cr.reportTick({ now: NOW });
    expect(again).toEqual({ sent: 0, queued: 0 });
    expect(posted).toHaveLength(0);
    // Bulutta gün başına bir anahtar ve kasanın "bugün"ü
    expect([...store.keys()].filter((k) => k.startsWith(`${REDIS_ONEKI}rapor:default:gun:`)).sort()).toEqual([addDays(today, -7), addDays(today, -1), today].sort().map((d) => `${REDIS_ONEKI}rapor:default:gun:${d}`));
    expect(JSON.parse(store.get(`${REDIS_ONEKI}rapor:default:son`)!)).toMatchObject({ today, at: NOW });
  });

  it('uzaktaki Ciro, Saatlik, Ürünler, Personel kasadakiyle aynı (tek gün, çok gün, bugün)', async () => {
    const rep = await import('../server/services/reports');
    const { GET, POST } = await import('../api/uzaktan');
    const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST' }))).json()) as { token: string };
    const remote = async <T,>(path: string, r: { from: string; to: string }) => {
      const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/${path}&from=${r.from}&to=${r.to}`, { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status).toBe(200);
      return (await res.json()) as T;
    };
    // Eşit tutarlı satırların sırası iki tarafta farklı olabilir (kasada kalemin sırası, uzakta günün sırası)
    const sorted = <T,>(rows: T[]) => [...rows].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
    const ranges = [
      { from: addDays(today, -7), to: addDays(today, -7) },
      { from: addDays(today, -7), to: addDays(today, -1) },
      { from: addDays(today, -10), to: today },
      { from: today, to: today },
    ];
    for (const r of ranges) {
      const till = rep.summaryReport(r, NOW);
      const s = await remote<typeof till & { byDay: { z: number[] }[] }>('summary', r);
      const { byDay, payments, types, ...rest } = s;
      const { byDay: tb, payments: tp, types: tt, ...tillRest } = till;
      expect(rest).toEqual(JSON.parse(JSON.stringify(tillRest)));
      expect(byDay.map((d) => ({ date: d.date, netSales: d.netSales, receipts: d.receipts }))).toEqual(tb);
      expect(sorted(payments)).toEqual(sorted(tp));
      expect(sorted(types)).toEqual(sorted(tt));
      expect(till.netSales).toBeGreaterThan(0);

      expect(await remote('hourly', r)).toEqual(JSON.parse(JSON.stringify(rep.hourlyReport(r))));

      const tp2 = rep.productReport(r, false);
      const p = await remote<typeof tp2>('products', r);
      expect(p.total).toBe(tp2.total);
      expect(p.service).toBe(tp2.service);
      expect(sorted(p.categories)).toEqual(sorted(tp2.categories));
      expect(sorted(p.products)).toEqual(sorted(tp2.products.map(({ categoryId: _c, revenueNet: _r, ...x }) => x)));

      const ts = rep.staffReport(r);
      expect(sorted((await remote<typeof ts>('staff', r)).staff)).toEqual(sorted(ts.staff));
    }
    // Bugünün kıyası geçen haftanın aynı günü "aynı saate kadar": geç kapanan adisyon iki tarafta da sayılmaz
    const t = rep.summaryReport({ from: today, to: today }, NOW);
    const full = rep.summaryReport({ from: addDays(today, -7), to: addDays(today, -7) }, NOW);
    expect(t.previous.label).toContain('aynı saate kadar');
    expect(t.previous.netSales).toBeLessThan(full.netSales);
    expect(t.previous.netSales).toBeGreaterThan(0);
  });

  it('ek sekmeler kasadakiyle aynı: hazırlama, kalem listeleri, adisyonlar, gün aşırı ödeme, bugünkü kategori ve CSV', async () => {
    const rep = await import('../server/services/reports');
    const cr = await import('../server/sync/cloud-reports');
    const { sqlite, db, schema } = await import('../server/db/client');
    const { GET, POST } = await import('../api/uzaktan');
    // Gün aşırı ödeme: dünün kapanmış adisyonunun bir ödemesi bugün alınmış gibi (dönem raporunda kapanmışların ödemesi)
    const days = db.select().from(schema.businessDays).all();
    const yesterday = days.find((d) => d.date === addDays(today, -1))!;
    const todayDay = days.find((d) => d.date === today)!;
    const yOrder = db.select().from(schema.orders).all().find((o) => o.dayId === yesterday.id && o.status === 'kapali')!;
    const yPay = db.select().from(schema.payments).all().find((p) => p.orderId === yOrder.id)!;
    sqlite.prepare('UPDATE payments SET day_id = ? WHERE id = ?').run(todayDay.id, yPay.id);
    // Kategori sonradan değişti: dönemde kasadaki gibi bugünkü kategori
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const other = h.boot.categories.find((c) => c.id !== latte.categoryId)!;
    sqlite.prepare('UPDATE products SET category_id = ? WHERE id = ?').run(other.id, latte.id);
    // Hazırlama: bugünün bir kalemi barda hazır
    const item = db.select().from(schema.orderItems).all().find((i) => i.stationId && !i.voided && i.orderId && !i.readyAt)!;
    if (item) sqlite.prepare('UPDATE order_items SET ready_at = sent_at + 95000 WHERE id = ?').run(item.id);
    cr.resetReportSync();
    let turns = 0;
    do await cr.reportTick({ backfill: true, now: NOW + turns++ * 60_000 });
    while (cr.reportSyncState().backfilling && turns < 80);

    const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST' }))).json()) as { token: string };
    // CSV baytlarıyla okunur (Response.text() baştaki BOM'u atar)
    const remote = async (path: string, r: { from: string; to: string }, q = ''): Promise<any> => {
      const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/${path}&from=${r.from}&to=${r.to}${q}`, { headers: { authorization: `Bearer ${token}` } }));
      expect(res.status, path).toBe(200);
      return path.endsWith('.csv') ? Buffer.from(await res.arrayBuffer()).toString('utf8') : res.json();
    };
    const plain = <T,>(x: T) => JSON.parse(JSON.stringify(x)) as T;
    // Buluta neden ve müşteri adı gitmez: kasanın satırı aynı biçime çevrilerek karşılaştırılır
    const masked = (rows: { reason: string | null; person: { kind: string; name: string } | null }[]) =>
      rows.map((r) => ({ ...r, reason: null, person: r.person ? (r.person.kind === 'customer' ? { kind: 'customer', name: 'Müşteri' } : r.person) : null }));
    const ranges = [
      { from: today, to: today },
      { from: addDays(today, -1), to: today },
      { from: addDays(today, -10), to: today },
    ];
    for (const r of ranges) {
      const s = rep.summaryReport(r, NOW);
      expect((await remote('summary', r)).reconciliation).toEqual(s.reconciliation);
      expect(await remote('prep', r)).toEqual(plain(rep.prepReport(r)));
      for (const kind of ['iptal', 'ikram', 'indirim', 'happy'] as const) {
        const till = rep.itemListReport(r, kind);
        const got = await remote('items', r, `&kind=${kind}`);
        expect(got.rows).toEqual(plain(masked(till.rows)));
        expect([got.total, got.count]).toEqual([till.total, till.count]);
        if (kind === 'ikram') expect(got.odenmezPeople).toEqual(plain(till.odenmezPeople.map((p) => (p.kind === 'customer' ? { ...p, id: null, name: 'Müşteri' } : p))));
      }
      expect(await remote('checks', r)).toEqual(plain(rep.checksReport(r)));
      expect(await remote('refunds', r)).toEqual(plain({ ...rep.refundReport(r), rows: rep.refundReport(r).rows.map((x) => ({ ...x, reason: null })) }));
      const { commission: _c, ...plat } = rep.platformReport(r, false, NOW) as ReturnType<typeof rep.platformReport> & { commission?: number };
      expect(await remote('platforms', r)).toEqual(plain(plat));
      const p = await remote('products', r);
      expect(p.products.find((x: { name: string }) => x.name === 'Latte').category).toBe(other.name);
    }
    // Gün aşırı ödeme gerçekten ayrıldı: bugün tek başına açıkta, iki günlük dönemde kapanmışlarda
    const one = rep.summaryReport({ from: today, to: today }, NOW).reconciliation;
    const two = rep.summaryReport({ from: addDays(today, -1), to: today }, NOW).reconciliation;
    expect(one.paidOpen).toBeGreaterThanOrEqual(yPay.amount);
    expect(two.paidOpen).toBe(one.paidOpen - yPay.amount);

    // CSV: kasadakiyle aynı satırlar (iptal listesinde neden uzakta boş)
    const { csvRows, toCsv } = await import('@shared/report-csv');
    const r = { from: addDays(today, -10), to: today };
    expect(await remote('export.csv', r, '&type=urunler')).toBe(toCsv(csvRows('urunler', (await remote('products', r)) as never)));
    expect(await remote('export.csv', r, '&type=saatlik')).toBe(toCsv(csvRows('saatlik', rep.hourlyReport(r))));
    expect(await remote('export.csv', r, '&type=adisyonlar')).toBe(toCsv(csvRows('adisyonlar', rep.checksReport(r, null))));
    expect(await remote('export.csv', r, '&type=iptal')).toBe(toCsv(csvRows('iptal', { rows: masked(rep.itemListReport(r, 'iptal').rows) })));
    // Kasanın CSV'si de aynı kurucudan (tek kaynak)
    const till = await h.call<string>('patron', 'GET', `/reports/export.csv?type=saatlik&from=${r.from}&to=${r.to}`);
    // Test yardımcısı yanıtı metin okur (BOM düşer)
    expect(`\uFEFF${till.json}`).toBe(toCsv(csvRows('saatlik', rep.hourlyReport(r))));
  });

  it('ek veride neden, müşteri adı ve telefonu, maliyet yok; para ve tarih biçimi kasayla aynı', async () => {
    const cr = await import('../server/sync/cloud-reports');
    const x = JSON.stringify(cr.buildDayReport(today, NOW));
    for (const secret of ['Vazgeçti', 'Müdavim', 'Kampanya', 'Müşteri şikâyeti', 'Ayşe', ...PHONE_FORMS, 'cost', 'margin', 'commission']) expect(x).not.toContain(secret);
    const { csvCell, csvDateTime } = await import('@shared/report-csv');
    const { tlPlain } = await import('@shared/money');
    const { fmtDateTime } = await import('@shared/time');
    for (const k of [0, 5, 123456, -9900, 100000099]) expect(csvCell({ kurus: k })).toBe(tlPlain(k));
    for (const ms of [NOW, NOW - 86400_000 * 200, Date.parse('2026-03-29T00:30:00Z')]) expect(csvDateTime(ms)).toBe(fmtDateTime(ms));
  });

  it('kıyas dönemi kasadakiyle aynı kuralla; aynı saate kadar dakika duyarlılığıyla', async () => {
    const { comparison } = await import('../server/services/reports');
    const { remoteComparison, salesUntil } = await import('../api/uzaktan');
    const now = Date.parse('2026-11-18T12:34:00Z');
    for (const r of [
      { from: '2026-11-18', to: '2026-11-18' },
      { from: '2026-11-01', to: '2026-11-18' },
      { from: '2026-10-01', to: '2026-10-31' },
      { from: '2026-03-01', to: '2026-03-31' },
      { from: '2026-11-10', to: '2026-11-18' },
      { from: '2025-11-19', to: '2026-11-18' },
    ]) {
      expect(remoteComparison(r, now, '2026-11-18')).toEqual(comparison(r, now, '2026-11-18'));
    }
    const day = { date: '2026-11-11', s: { rev: 600, receipts: 3 }, closes: [[0, 100, 1], [120, 200, 1], [600, 300, 1]] } as unknown as RemoteDayReport;
    const start = businessDayStartMs('2026-11-11');
    expect(salesUntil(day, null)).toEqual({ netSales: 600, receipts: 3 });
    expect(salesUntil(day, start + 120 * 60_000)).toEqual({ netSales: 300, receipts: 2 });
    expect(salesUntil(day, start + 120 * 60_000 - 1)).toEqual({ netSales: 100, receipts: 1 });
    expect(salesUntil(day, start - 1)).toEqual({ netSales: 0, receipts: 0 });
  });

  it('patron panelinin geçen hafta kıyası günlük özetteki kapanış dakikalarıyla aynı', async () => {
    const { patronLive } = await import('../server/services/reports');
    const { salesUntil } = await import('../api/uzaktan');
    const live = patronLive(false);
    const lastWeek = JSON.parse(store.get(`${REDIS_ONEKI}rapor:default:gun:${addDays(today, -7)}`)!) as RemoteDayReport;
    const elapsed = live.now - businessDayStartMs(today);
    const fromSummary = salesUntil(lastWeek, businessDayStartMs(addDays(today, -7)) + elapsed);
    expect(fromSummary.netSales).toBe(live.compare.lastWeek.netSales);
    expect(fromSummary.receipts).toBe(live.compare.lastWeek.orders);
  });

  it('günlerde maliyet, kâr, PIN, müşteri adı ve telefonu yok', () => {
    const days = [...store.entries()].filter(([k]) => k.startsWith(`${REDIS_ONEKI}rapor:`)).map(([, v]) => v);
    expect(days.length).toBeGreaterThan(0);
    const text = days.join('\n');
    for (const bad of ['Ayşe', 'Yılmaz', ...PHONE_FORMS, '"cost"', '"margin"', '"costsAt"', '"revenueNet"', 'pin', 'phone', 'Müşteri şikâyeti']) expect(text).not.toContain(bad);
    // Ödenmez yine ciro dışında sayılır, kişisi olmadan
    const d = JSON.parse(days[0]!) as RemoteDayReport;
    expect(Object.keys(d).sort()).toEqual(['at', 'clock', 'closed', 'closes', 'date', 'hours', 'kdv', 'n', 'pay', 'prod', 's', 'staff', 'types', 'v', 'xpay', 'z']);
  });

  it('dönem denetimi: en çok 400 gün, geçersiz tarih 422, ters dönem çevrilir', async () => {
    const { GET, POST } = await import('../api/uzaktan');
    const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST' }))).json()) as { token: string };
    const get = (q: string) => GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/summary&${q}`, { headers: { authorization: `Bearer ${token}` } }));
    const long = await get(`from=${addDays(today, -400)}&to=${today}`);
    expect([long.status, ((await long.json()) as { code: string }).code]).toEqual([422, 'range_too_long']);
    expect((await get(`from=${addDays(today, -399)}&to=${today}`)).status).toBe(200);
    expect((await get('from=2026-02-30&to=2026-03-01')).status).toBe(422);
    const rev = (await (await get(`from=${today}&to=${addDays(today, -7)}`)).json()) as { range: { from: string; to: string } };
    expect(rev.range).toEqual({ from: addDays(today, -7), to: today });
    // İmzasız itme reddedilir
    expect((await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/rapor`, { method: 'POST', body: '{"gz":""}' }))).status).toBe(401);
  });

  it('internetsiz: değişen günler kuyrukta; internet dönünce catch-up tam bir kez gönderir', async () => {
    const cr = await import('../server/sync/cloud-reports');
    const cu = await import('../server/sync/catch-up');
    // Bugün yeni satış: bugünün özeti değişti
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await add(o, [{ name: 'Espresso', size: 'M' }]);
    await pay(o, 'Nakit', o.total);
    offline = true;
    posted.length = 0;
    const r = await cr.reportTick();
    expect(r).toEqual({ sent: 0, queued: 1 });
    expect(cu.pendingCounts().reports).toBe(1);
    // Kuyruk bir sonraki internetsiz turda büyümez, kaybolmaz
    expect(await cr.reportTick()).toEqual({ sent: 0, queued: 1 });

    offline = false;
    await cu.catchUp();
    const sent = posted.filter((p) => p.path === 'uzaktan/rapor').flatMap((p) => p.days);
    expect(sent).toEqual([today]);
    expect(cu.pendingCounts().reports).toBe(0);
    posted.length = 0;
    await cu.catchUp();
    expect(posted.filter((p) => p.path === 'uzaktan/rapor')).toHaveLength(0);
    // Bulut yeni rakamı gösterir
    const stored = JSON.parse(store.get(`${REDIS_ONEKI}rapor:default:gun:${today}`)!) as RemoteDayReport;
    const { summaryReport } = await import('../server/services/reports');
    expect(stored.s.rev).toBe(summaryReport({ from: today, to: today }).netSales);
  });

  it('eski özet yenisini ezmez', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { gzipSync } = await import('node:zlib');
    const { POST } = await import('../api/uzaktan');
    const key = `${REDIS_ONEKI}rapor:default:gun:${today}`;
    const cur = JSON.parse(store.get(key)!) as RemoteDayReport;
    const old = { ...cur, at: cur.at - 60_000, s: { ...cur.s, rev: 1 } };
    const body = JSON.stringify({ gz: gzipSync(JSON.stringify({ v: 1, shop: 'default', today, at: cur.at - 60_000, days: [old] })).toString('base64') });
    const url = new URL(`${CLOUD}/api/uzaktan/rapor`);
    const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/rapor`, { method: 'POST', body, headers: signedHeaders(SECRET, 'POST', url, body) }));
    expect(((await res.json()) as { stored: number }).stored).toBe(0);
    expect((JSON.parse(store.get(key)!) as RemoteDayReport).s.rev).toBe(cur.s.rev);
  });
});

describe('uzaktan canlı rakamların tazeliği', () => {
  it('gün açıkken 10 dakikadan eski veri "kafeden veri gelmiyor"; gün kapalıyken eskilik sayılmaz', async () => {
    const { remoteFreshness, REMOTE_STALE_MS, fmtClock } = await import('../src/lib/remote');
    const at = Date.parse('2026-11-21T09:00:00Z');
    expect(REMOTE_STALE_MS).toBe(10 * 60_000);
    expect(remoteFreshness(at + 9 * 60_000, at, true)).toBe('live');
    expect(remoteFreshness(at + 10 * 60_000, at, true)).toBe('live');
    expect(remoteFreshness(at + 10 * 60_000 + 1, at, true)).toBe('stale');
    expect(remoteFreshness(at + 5 * 3600_000, at, false)).toBe('closed');
    expect(fmtClock(at + 5_000)).toBe('12:00:05');
  });

  it('uzaktaki patron özeti gün sonu kartını taşır (kasa farkı patronun kasa rakamı yetkisiyle)', async () => {
    const { buildSnapshot } = await import('../server/sync/cloud');
    const card = buildSnapshot().patron.lastClose;
    expect(card).toMatchObject({ date: addDays(today, -1), cash: { counted: 0 } });
    expect(card!.payments.length).toBeGreaterThan(0);
    expect(JSON.stringify(card)).not.toMatch(/cost|margin/);
  });
});
