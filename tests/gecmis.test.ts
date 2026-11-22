import { describe, expect, it } from 'vitest';
import { fillHistory, type HistoryDay, historyKey, historyReport, historyStatsDay, mergeHistoryStats, parseHistory, readHistory } from '@shared/gecmis';
import { reportCloses, statsFromReports } from '@shared/remote-calc';
import { type PatronStats, todayStats } from '@shared/today-stats';
import { merkez, type MerkezDeps } from '../api/_merkez';

/**
 * Geçmiş ciro: dükkânın LafPOS'tan önceki kasa programında kalan günleri (Marina'nın ModPOS günleri, 13-21 Kas 2026).
 * Sahip Merkez'den yükler; Uzaktan'ın kıyasları ve raporları o günleri de görür. Aynı gün iki kaynakta varsa cirosu
 * büyük olan geçer, toplanmaz.
 */
const DAY = { date: '2026-11-21', ciro: 462050, adisyon: 17, kart: [320300, 13], nakit: [141750, 4], closes: [[332, 4500, 1], [403, 26000, 1], [962, 70000, 2], [1016, 361550, 13]] };
const WEEK = { date: '2026-11-15', ciro: 575300, adisyon: 27 };

describe('geçmiş ciro: doğrulama', () => {
  it('günleri tarih sırasına koyar, ödeme türlerini Z alanıyla yazar', () => {
    const days = parseHistory([DAY, WEEK]);
    expect(typeof days).not.toBe('string');
    const [w, d] = days as HistoryDay[];
    expect(w!.date).toBe('2026-11-15');
    expect(w!.closes).toEqual([]);
    expect(d!.pay).toEqual([
      ['Kredi kartı', 'card', 320300, 13],
      ['Nakit', 'cash', 141750, 4],
    ]);
    expect(d!.closes[0]).toEqual([332, 4500, 1]);
  });

  it('yarım veri saklanmaz: kapanışlar ya da ödeme türleri günün cirosunu tutmuyorsa hata cümlesi döner', () => {
    expect(parseHistory([{ ...DAY, ciro: 462051 }])).toMatch(/kapanışların toplamı/);
    expect(parseHistory([{ ...WEEK, kart: [1, 1] }])).toMatch(/ödeme türlerinin toplamı/);
    expect(parseHistory([{ date: '2026-02-30', ciro: 1, adisyon: 1 }])).toMatch(/Tarih/);
    expect(parseHistory([{ date: '2026-11-21', ciro: 1.5, adisyon: 1 }])).toMatch(/tam sayı/);
    expect(parseHistory('x')).toMatch(/anlaşılamadı/);
  });

  it('saklanan kayıt geri okunur; bozuk ya da boş kayıt yok sayılır', () => {
    const days = parseHistory([DAY]) as HistoryDay[];
    expect(readHistory(JSON.stringify({ v: 1, kaynak: 'ModPOS', at: 1, gunler: days }))).toEqual(days);
    expect(readHistory('{')).toBeNull();
    expect(readHistory(JSON.stringify({ v: 1, gunler: [] }))).toBeNull();
    expect(readHistory(null)).toBeNull();
  });
});

describe('geçmiş ciro: raporlar ve kıyas', () => {
  const days = parseHistory([DAY, WEEK]) as HistoryDay[];
  const day = days[1]!;

  it('gün raporu: ciro, adisyon, saatlik kırılım ve saatin kendisi (05:00 iş günü)', () => {
    const r = historyReport(day);
    expect(r.s.rev).toBe(462050);
    expect(r.s.receipts).toBe(17);
    expect(r.closed).toBe(true);
    expect(r.hours).toEqual([
      [5, 4500, 1],
      [6, 26000, 1],
      [16, 431550, 15],
    ]);
    // 332. dakika = 10:32, 1016. dakika = 21:56
    expect(r.clock).toEqual([
      [10, 4500],
      [11, 26000],
      [21, 431550],
    ]);
    expect(r.hours.reduce((a, h) => a + h[1], 0)).toBe(r.s.rev);
  });

  it('aynı gün iki kaynakta: cirosu büyük olan geçer; bugün ve dönem dışı günlere dokunulmaz', () => {
    const rep = (date: string, rev: number) => ({ date, s: { rev }, own: true });
    const make = (h: HistoryDay) => ({ date: h.date, s: { rev: h.ciro }, own: false });
    const out = fillHistory(['2026-11-15', '2026-11-21', '2026-11-22'], [rep('2026-11-21', 9000), rep('2026-11-22', 100)], days, '2026-11-22', make);
    const by = Object.fromEntries(out.map((r) => [r.date, r]));
    expect(by['2026-11-21']).toMatchObject({ own: false, s: { rev: 462050 } });
    expect(by['2026-11-15']).toMatchObject({ own: false, s: { rev: 575300 } });
    expect(by['2026-11-22']).toMatchObject({ own: true });
    // LafPOS'un günü daha büyükse o kalır (gerçek satış LafPOS'ta)
    expect(fillHistory(['2026-11-21'], [rep('2026-11-21', 999999)], days, '2026-11-22', make)[0]).toMatchObject({ own: true });
    // Dönemde olmayan gün eklenmez
    expect(fillHistory(['2026-11-20'], [], days, '2026-11-22', make)).toEqual([]);
    expect(fillHistory(['2026-11-21'], [], null, '2026-11-22', make)).toEqual([]);
  });

  it('eski kasa (bulut kıyası): dün dakikasıyla, geçen hafta bugün yalnız gün sonu toplamıyla gelir', () => {
    const reps = fillHistory(['2026-11-15', '2026-11-21'], [], days, '2026-11-22', historyStatsDay);
    expect(reportCloses(reps.find((r) => r.date === '2026-11-21')!).grain).toBeUndefined();
    expect(reportCloses(reps.find((r) => r.date === '2026-11-15')!)).toEqual({ closes: [[0, 575300, 27]], grain: 'gun' });
    const stats = statsFromReports({ date: '2026-11-22', dayOpen: true, netSales: 0, orders: 0 }, reps);
    expect(stats.days['2026-11-21']!.closes).toHaveLength(4);
    expect(stats.daily).toContainEqual(['2026-11-21', 462050, 17]);
    expect(stats.daily).toContainEqual(['2026-11-15', 575300, 27]);
  });

  it('yeni kasa (kendi kıyas girdisi): eksik günler geçmişten, deneme satışlı gün geçmişle değişir, büyük gün kalır', () => {
    const stats: PatronStats = {
      v: 1,
      guests: 0,
      days: { '2026-11-22': { open: true, closes: [[400, 10000, 1]] }, '2026-11-21': { open: false, closes: [[600, 5000, 1]] } },
      daily: [['2026-11-21', 5000, 1]],
      topPrev: [],
    };
    const out = mergeHistoryStats(stats, '2026-11-22', days);
    expect(out.days['2026-11-21']!.closes).toEqual(day.closes);
    expect(out.days['2026-11-15']).toEqual({ open: false, closes: [[0, 575300, 27]], grain: 'gun' });
    expect(out.days['2026-11-22']).toEqual(stats.days['2026-11-22']);
    expect(out.daily).toEqual([
      ['2026-11-21', 462050, 17],
      ['2026-11-15', 575300, 27],
    ]);
    // Kasanın günü geçmişten büyükse dokunulmaz; geçmiş yoksa girdi aynen döner
    const big: PatronStats = { ...stats, days: { '2026-11-21': { open: false, closes: [[600, 900000, 30]] } }, daily: [['2026-11-21', 900000, 30]] };
    expect(mergeHistoryStats(big, '2026-11-22', days).days['2026-11-21']!.closes).toEqual([[600, 900000, 30]]);
    expect(mergeHistoryStats(big, '2026-11-22', days).daily).toContainEqual(['2026-11-21', 900000, 30]);
    expect(mergeHistoryStats(stats, '2026-11-22', null)).toBe(stats);
  });

  it('patron panelinin kıyası: "Dün" geçmiş günün aynı saate kadarki cirosunu gösterir', () => {
    const stats = mergeHistoryStats({ v: 1, guests: 0, days: { '2026-11-22': { open: true, closes: [[400, 10000, 1]] } }, daily: [], topPrev: [] }, '2026-11-22', days);
    // 22 Kasım 12:00 (iş günü 05:00'te başlar: 420. dakika): düne göre 10:32 ve 11:43 kapanışları sayılır
    const now = Date.parse('2026-11-22T12:00:00+03:00');
    const t = todayStats({ date: '2026-11-22', dayOpen: true, netSales: 10000, orders: 1, top: [] } as never, stats, now);
    const dun = t.compares.find((c) => c.key === 'dun')!;
    expect(dun.value).toEqual({ netSales: 30500, receipts: 2 });
    expect(dun.full).toEqual({ netSales: 462050, receipts: 17 });
  });
});

describe('Merkez: geçmiş ciro yükleme', () => {
  const ID = 'a'.repeat(24);
  const store = new Map<string, string>([[`lafpos:merkez:kurulum:${ID}`, JSON.stringify({ id: ID, ad: 'Marina', createdAt: 1, lisans: { durum: 'aktif', bitis: null }, mod: 'otomatik' })]]);
  const deps = (admin: boolean): MerkezDeps =>
    ({
      redis: async (cmd: string, ...rest: (string | number)[]) => {
        if (cmd === 'MGET') return rest.map((k) => store.get(String(k)) ?? null);
        if (cmd === 'GET') return store.get(String(rest[0])) ?? null;
        if (cmd === 'SET') return (store.set(String(rest[0]), String(rest[1])), 'OK');
        if (cmd === 'DEL') return rest.filter((k) => store.delete(String(k))).length;
        return null;
      },
      verify: () => false,
      signedShared: () => false,
      admin: async () => admin,
    }) as unknown as MerkezDeps;
  const post = (body: unknown, admin = true) => {
    const url = new URL('https://x.test/api/uzaktan/merkez/gecmis');
    return merkez(new Request(url, { method: 'POST', body: JSON.stringify(body) }), url, 'merkez/gecmis', deps(admin));
  };

  it('yalnız sahip yükler; kayıt dükkânın anahtarına yazılır, boş liste siler', async () => {
    expect((await post({ id: ID, gunler: [DAY] }, false)).status).toBe(401);
    const res = await post({ id: ID, kaynak: 'ModPOS', gunler: [DAY, WEEK] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, gun: 2, ciro: 1037350, ilk: '2026-11-15', son: '2026-11-21' });
    const saved = JSON.parse(store.get(historyKey(ID))!) as { kaynak: string; gunler: HistoryDay[] };
    expect(saved.kaynak).toBe('ModPOS');
    expect(saved.gunler.map((d) => d.date)).toEqual(['2026-11-15', '2026-11-21']);
    expect((await post({ id: ID, gunler: [{ ...DAY, adisyon: 3 }] })).status).toBe(400);
    expect((await post({ id: 'b'.repeat(24), gunler: [DAY] })).status).toBe(404);
    expect(await (await post({ id: ID, gunler: [] })).json()).toEqual({ ok: true, gun: 0, ciro: 0 });
    expect(store.has(historyKey(ID))).toBe(false);
  });
});
