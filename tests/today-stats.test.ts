import { describe, expect, it } from 'vitest';
import { businessDayStartMs } from '@shared/time';
import { curves, dayLabel, forecast, type PatronStats, sameDayLastMonth, statsDates, todayStats, topCompare, weekStart } from '@shared/today-stats';

/**
 * "Bugün" kıyaslarının altın testleri (shared/today-stats.ts): bilinen gün verisiyle beklenen kıyas; eksik gün "veri
 * yok" (₺0 değil), gün aşırı kapanış, hafta ve ay sınırı, 29-31 gün ay farkı, tahmin ve en çok satanlar. Kasadaki
 * Raporlar'la eşitlik tests/patron-kiyas.test.ts'te.
 */
const at = (date: string, minute: number) => businessDayStartMs(date) + minute * 60_000 + 30_000;
const stats = (p: Partial<PatronStats>): PatronStats => ({
  v: 1,
  guests: 0,
  days: {},
  daily: [],
  topPrev: [],
  ...p,
});

describe('takvim', () => {
  it('geçen ayın aynı günü; olmayan gün null', () => {
    expect(sameDayLastMonth('2026-11-22')).toBe('2026-10-22');
    expect(sameDayLastMonth('2026-10-31')).toBeNull(); // Eylül 30 gün
    expect(sameDayLastMonth('2026-12-31')).toBeNull(); // Kasım 30 gün
    expect(sameDayLastMonth('2026-12-30')).toBe('2026-11-30');
    expect(sameDayLastMonth('2026-01-31')).toBe('2025-12-31');
    expect(sameDayLastMonth('2027-03-28')).toBe('2027-02-28');
    expect(sameDayLastMonth('2027-03-29')).toBeNull();
    expect(sameDayLastMonth('2028-03-29')).toBe('2028-02-29'); // artık yıl
    expect(sameDayLastMonth('2027-01-15')).toBe('2026-12-15');
  });
  it('hafta Pazartesi başlar; tarih etiketi gün adıyla', () => {
    expect(weekStart('2026-11-22')).toBe('2026-11-16'); // Pazar
    expect(weekStart('2026-11-16')).toBe('2026-11-16');
    expect(dayLabel('2026-10-22')).toBe('22 Ekim Perşembe');
    expect(dayLabel('2026-11-22')).toBe('22 Kasım Pazar');
  });
  it('kasanın gönderdiği tarihler', () => {
    const d = statsDates('2026-11-19');
    expect(d.curves).toEqual(['2026-11-19', '2026-11-18', '2026-11-12', '2026-11-05', '2026-10-29', '2026-10-22', '2026-10-19']);
    expect(d.dailyFrom).toBe('2026-10-01');
    expect(d.dailyTo).toBe('2026-11-18');
    expect(statsDates('2026-10-31').lastMonth).toBeNull();
  });
});

describe('bugün kıyasları', () => {
  const T = '2026-11-19'; // Perşembe
  const base = stats({
    guests: 7,
    days: {
      [T]: {
        open: true,
        closes: [
          [60, 10000, 1],
          [300, 20000, 2],
        ],
      },
      '2026-11-18': {
        open: false,
        closes: [
          [120, 5000, 1],
          [650, 7000, 1],
        ],
      },
      '2026-11-12': {
        open: false,
        closes: [
          [100, 10000, 1],
          [599, 10000, 1],
          [600, 5000, 1],
          [601, 99999, 1],
        ],
      },
    },
  });
  const input = { date: T, dayOpen: true, netSales: 30000, orders: 3 };

  it('gün sürerken aynı saate kadar; tam gün küçük satırda; geçen ay yoksa veri yok', () => {
    const r = todayStats(input, base, at(T, 600));
    expect(r.mode).toBe('live');
    expect(r.cutoffMin).toBe(600);
    const [dun, hafta, ay] = r.compares;
    expect(dun).toMatchObject({
      date: '2026-11-18',
      value: { netSales: 5000, receipts: 1 },
      full: { netSales: 12000, receipts: 2 },
      change: 500,
      diff: 25000,
    });
    // Kesim dakikası dahil (600), sonrası değil (601)
    expect(hafta).toMatchObject({
      date: '2026-11-12',
      value: { netSales: 25000, receipts: 3 },
      full: { netSales: 124999, receipts: 4 },
      change: 20,
      diff: 5000,
    });
    expect(ay).toMatchObject({
      date: '2026-10-19',
      value: null,
      full: null,
      change: null,
      diff: null,
    });
    expect(r.guests).toBe(7);
  });

  it('gün kapanınca tam gün kıyası', () => {
    const r = todayStats(
      { ...input, dayOpen: false },
      {
        ...base,
        days: {
          ...base.days,
          [T]: { open: false, closes: base.days[T]!.closes },
        },
      },
      at(T, 600),
    );
    expect(r.mode).toBe('closed');
    expect(r.compares[0]).toMatchObject({
      value: { netSales: 12000 },
      change: 150,
    });
    expect(r.compares[1]!.value!.netSales).toBe(124999);
    expect(r.forecast).toBeNull();
  });

  it('gün açılmadıysa kıyas günlerinin tam günü, yüzde yok', () => {
    const { [T]: _t, ...past } = base.days;
    const r = todayStats({ ...input, netSales: 0, orders: 0, dayOpen: false }, { ...base, days: past }, at(T, 120));
    expect(r.mode).toBe('none');
    expect(r.compares[0]).toMatchObject({
      value: { netSales: 12000 },
      change: null,
      diff: null,
    });
  });

  it('kıyas günü satışsızsa ₺0 ve yüzde yok (veri yok değil)', () => {
    const r = todayStats(
      input,
      {
        ...base,
        days: { ...base.days, '2026-11-18': { open: false, closes: [] } },
      },
      at(T, 600),
    );
    expect(r.compares[0]).toMatchObject({
      value: { netSales: 0, receipts: 0 },
      change: null,
      diff: 30000,
    });
  });

  it('gün aşırı: gece yarısından sonra kapanan adisyon günün içinde', () => {
    // 01:30'da (gün başından 1230. dakika) kapanan satış geçen haftanın tam gününde ve bugünün 01:40'ına kadar
    const s = stats({
      days: {
        [T]: { open: true, closes: [[1235, 1000, 1]] },
        '2026-11-12': {
          open: false,
          closes: [
            [1230, 7000, 1],
            [1300, 3000, 1],
          ],
        },
      },
    });
    const r = todayStats({ date: T, dayOpen: true, netSales: 1000, orders: 1 }, s, at(T, 1240));
    expect(r.compares[1]).toMatchObject({
      value: { netSales: 7000 },
      full: { netSales: 10000 },
    });
    const c = curves(T, s, 1240);
    expect(c.hours).toBe(24);
    expect(c.lastWeek!.at(-1)).toBe(10000);
    expect(c.today!.length).toBe(21); // 0..20. saat başı; şu an 20 sa 40 dk
    expect(c.todayNow).toBe(1000);
  });
});

describe('hafta ve ay başından', () => {
  it('Pazartesi: hafta yalnız bugün, geçen Pazartesi aynı saate kadar; Pazar sayılmaz', () => {
    const T = '2026-11-16';
    const s = stats({
      days: {
        [T]: { open: true, closes: [[60, 4000, 1]] },
        '2026-11-09': {
          open: false,
          closes: [
            [30, 1000, 1],
            [500, 9000, 1],
          ],
        },
      },
      daily: [
        ['2026-11-15', 50000, 10],
        ['2026-11-09', 10000, 2],
        ['2026-11-08', 7000, 1],
      ],
    });
    const r = todayStats({ date: T, dayOpen: true, netSales: 4000, orders: 1 }, s, at(T, 120));
    const w = r.periods.find((p) => p.key === 'hafta')!;
    expect(w.cur).toMatchObject({ from: T, to: T, netSales: 4000, days: 1 });
    expect(w.prev).toMatchObject({
      from: '2026-11-09',
      to: '2026-11-09',
      netSales: 1000,
      days: 1,
    });
    expect(w.change).toBe(300);
  });

  it('hafta ortası: geçmiş tam günler + bugün; önceki hafta aynı gün sayısıyla', () => {
    const T = '2026-11-19'; // Perşembe
    const s = stats({
      days: {
        [T]: { open: true, closes: [[60, 3000, 1]] },
        '2026-11-12': {
          open: false,
          closes: [
            [30, 2000, 1],
            [700, 8000, 1],
          ],
        },
      },
      daily: [
        ['2026-11-18', 10000, 2],
        ['2026-11-16', 20000, 4], // Salı (17) kapalıydı: gün yok
        ['2026-11-15', 99999, 9], // önceki hafta: Pazar, sayılmaz
        ['2026-11-12', 10000, 2], // geçen Perşembe tam gün: kıyasta kesimli eğriden gelir
        ['2026-11-11', 6000, 1],
        ['2026-11-10', 6000, 1],
        ['2026-11-09', 6000, 1],
      ],
    });
    const w = todayStats({ date: T, dayOpen: true, netSales: 3000, orders: 1 }, s, at(T, 120)).periods.find((p) => p.key === 'hafta')!;
    expect(w.cur).toMatchObject({ netSales: 33000, receipts: 7, days: 3 });
    expect(w.prev).toMatchObject({ netSales: 20000, receipts: 4, days: 4 });
    expect(w.change).toBe(65);
  });
  it('son 7 gün: bugün dahil 7 gün ↔ önceki 7 gün; geçen haftanın aynı günü aynı saate kadar, ₺ fark', () => {
    const T = '2026-11-19';
    const s = stats({
      days: {
        [T]: { open: true, closes: [[60, 3000, 1]] },
        '2026-11-12': {
          open: false,
          closes: [
            [30, 2000, 1],
            [700, 8000, 1],
          ],
        },
      },
      daily: [
        ['2026-11-18', 10000, 2],
        ['2026-11-14', 5000, 1],
        ['2026-11-13', 2000, 1], // 6 gün önce: dönemin ilk günü
        ['2026-11-12', 10000, 2], // 7 gün önce: önceki dönemin son günü, kesimli eğriden (2000) gelir
        ['2026-11-11', 4000, 1],
        ['2026-11-06', 2000, 1], // 13 gün önce: önceki dönemin ilk günü
        ['2026-11-05', 77777, 7], // 14 gün önce: sayılmaz
      ],
    });
    const p = todayStats({ date: T, dayOpen: true, netSales: 3000, orders: 1 }, s, at(T, 120)).periods.find((x) => x.key === 'son7')!;
    expect(p.label).toBe('Son 7 gün');
    expect(p.cur).toMatchObject({ netSales: 20000, receipts: 5, days: 4, from: '2026-11-13', to: T });
    expect(p.prev).toMatchObject({ netSales: 8000, receipts: 3, days: 3, from: '2026-11-06', to: '2026-11-12' });
    expect(p.change).toBe(150);
    expect(p.diff).toBe(12000);
    // Önceki dönemde hiç iş günü yoksa yüzde ve fark yok ("veri yok", sıfır değil)
    const bos = todayStats({ date: T, dayOpen: true, netSales: 3000, orders: 1 }, stats({ days: { [T]: { open: true, closes: [[60, 3000, 1]] } } }), at(T, 120)).periods.find((x) => x.key === 'son7')!;
    expect(bos.prev.days).toBe(0);
    expect(bos.change).toBeNull();
    expect(bos.diff).toBeNull();
  });

  it("ayın 1'i: önceki ayın 1'i aynı saate kadar", () => {
    const T = '2026-12-01';
    const s = stats({
      days: {
        [T]: { open: true, closes: [[60, 5000, 1]] },
        '2026-11-01': {
          open: false,
          closes: [
            [60, 2500, 1],
            [900, 1, 1],
          ],
        },
      },
      daily: [['2026-11-30', 8000, 1]],
    });
    const r = todayStats({ date: T, dayOpen: true, netSales: 5000, orders: 1 }, s, at(T, 300));
    const m = r.periods.find((p) => p.key === 'ay')!;
    expect(m).toMatchObject({
      wholePrev: false,
      cur: { netSales: 5000, days: 1 },
      prev: { from: '2026-11-01', to: '2026-11-01', netSales: 2500 },
      change: 100,
    });
    expect(r.compares[2]).toMatchObject({ date: '2026-11-01', change: 100 });
  });

  it("31 Ekim: Eylül'de 31 yok; ay kıyası Eylül'ün tamamıyla, geçen ay aynı gün yok", () => {
    const T = '2026-10-31';
    const sep = Array.from({ length: 30 }, (_, i) => [`2026-09-${String(i + 1).padStart(2, '0')}`, 1000, 1] as [string, number, number]);
    const oct = Array.from({ length: 30 }, (_, i) => [`2026-10-${String(i + 1).padStart(2, '0')}`, 2000, 1] as [string, number, number]);
    const s = stats({
      days: { [T]: { open: true, closes: [[60, 2000, 1]] } },
      daily: [...sep, ...oct],
    });
    const r = todayStats({ date: T, dayOpen: true, netSales: 2000, orders: 1 }, s, at(T, 120));
    expect(r.compares[2]).toMatchObject({
      date: null,
      value: null,
      change: null,
    });
    const m = r.periods.find((p) => p.key === 'ay')!;
    expect(m).toMatchObject({
      wholePrev: true,
      cur: { netSales: 62000, days: 31 },
      prev: { from: '2026-09-01', to: '2026-09-30', netSales: 30000, days: 30 },
    });
  });

  it("29 Mart 2027: Şubat 28 gün, Şubat'ın tamamı", () => {
    const T = '2027-03-29';
    const s = stats({
      days: { [T]: { open: true, closes: [] } },
      daily: [
        ['2027-02-28', 500, 1],
        ['2027-02-01', 500, 1],
        ['2027-01-31', 9999, 1],
      ],
    });
    const m = todayStats({ date: T, dayOpen: true, netSales: 0, orders: 0 }, s, at(T, 60)).periods.find((p) => p.key === 'ay')!;
    expect(m).toMatchObject({
      wholePrev: true,
      prev: { from: '2027-02-01', to: '2027-02-28', netSales: 1000, days: 2 },
    });
  });
});

describe('tahmin ve en çok satanlar', () => {
  const T = '2026-11-19';
  const day = (closes: [number, number, number][]) => ({ open: false, closes });
  it('son 4 aynı günün saat payıyla; erken saatte ve tek günle yok', () => {
    const s = stats({
      days: {
        [T]: { open: true, closes: [[100, 5000, 1]] },
        '2026-11-12': day([
          [100, 2000, 1],
          [800, 8000, 1],
        ]), // %20
        '2026-11-05': day([
          [100, 3000, 1],
          [800, 7000, 1],
        ]), // %30
        '2026-10-29': day([]), // satışsız gün sayılmaz
      },
    });
    // Σ pay = 5000 / 20000 = %25 → 5000 / 0,25
    expect(forecast({ date: T, dayOpen: true, netSales: 5000, orders: 1 }, s, 600)).toEqual({ value: 20000, days: 2, share: 25 });
    expect(forecast({ date: T, dayOpen: true, netSales: 5000, orders: 1 }, s, 50)).toBeNull(); // pay %0
    expect(forecast({ date: T, dayOpen: true, netSales: 5000, orders: 1 }, s, null)).toBeNull(); // gün kapandı
    const one = stats({
      days: { [T]: s.days[T]!, '2026-11-12': s.days['2026-11-12']! },
    });
    expect(forecast({ date: T, dayOpen: true, netSales: 5000, orders: 1 }, one, 600)).toBeNull();
  });
  it('geçen hafta aynı saate kadar; geçen hafta gün yoksa kıyas yok', () => {
    const top = [
      { key: 'a', qty: 4, revenue: 4000 },
      { key: 'b', qty: 1, revenue: 1000 },
    ];
    const s = stats({
      topPrev: [
        [0, 100, 2, 2000],
        [0, 900, 5, 5000],
        [1, 50, 1, 1000],
      ],
    });
    expect(topCompare(top, s, 600, true).map((p) => [p.prev, p.change])).toEqual([
      [{ qty: 2, revenue: 2000 }, 100],
      [{ qty: 1, revenue: 1000 }, 0],
    ]);
    expect(topCompare(top, s, null, true)[0]!.prev).toEqual({
      qty: 7,
      revenue: 7000,
    });
    expect(topCompare(top, s, 600, false)[0]).toMatchObject({
      prev: null,
      change: null,
    });
  });
});
