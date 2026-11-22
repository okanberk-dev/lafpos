import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { reportCloses, reportStatsDates, type StatsDayReport, statsFromReports } from '@shared/remote-calc';
import { businessDayStartMs } from '@shared/time';
import { COMPARE_LABELS, type PatronStats, statsDates, statsSource, summaryCompares, todayStats } from '@shared/today-stats';
import { signedHeaders } from '../server/lib/signature';
import { type UpstashCall, upstashCommand } from './fake-upstash';

/**
 * Patron panelinin Kıyas kartı üç yoldan beslenir (shared/today-stats.ts `StatsSource`): `kasa` (yeni kasa girdiyi
 * gönderir), `rapor` (eski kasa göndermez; LafPOS Uzaktan bulutta duran gün raporlarından kurar) ve `ozet` (ikisi de
 * yok; özetin kendi iki rakamı). Burada `rapor` ve `ozet` yolları: hangi duyarlılıkla (dakika, saat, gün sonu) ne
 * yazıldığı, Uzaktan'ın yanıtı ve Upstash komutu. Kasayla kuruşu kuruşuna eşitlik tests/patron-kiyas.test.ts'te.
 */
const T = '2026-11-22'; // Pazar
const at = (minute: number) => businessDayStartMs(T) + minute * 60_000 + 30_000;
const rep = (date: string, closes: [number, number, number][], extra: Partial<StatsDayReport> = {}): StatsDayReport => ({
  date,
  n: 1,
  closed: true,
  s: { rev: closes.reduce((a, c) => a + c[1], 0), receipts: closes.reduce((a, c) => a + c[2], 0) },
  closes,
  hours: [],
  ...extra,
});
const patron = { date: T, dayOpen: true, netSales: 35_700, orders: 4, hourly: Array.from({ length: 24 }, (_, h) => (h === 9 ? 20_000 : h === 11 ? 15_700 : 0)) };

describe('kıyas girdisi gün raporlarından (eski kasa)', () => {
  it('okunacak günler kasanın gönderdiği günlerle aynı (bugün hariç)', () => {
    for (const today of ['2026-11-22', '2026-11-02', '2026-11-30', '2026-10-31', '2027-03-29', '2027-01-01', '2026-03-01']) {
      const kasa = statsDates(today);
      const bulut = reportStatsDates(today);
      expect(bulut.curves, today).toEqual(kasa.curves.filter((d) => d !== today));
      expect([bulut.dailyFrom, bulut.dailyTo], today).toEqual([kasa.dailyFrom, kasa.dailyTo]);
      expect(bulut.all).toEqual([...new Set(bulut.all)].sort());
      for (const d of bulut.curves) expect(bulut.all, `${today} ${d}`).toContain(d);
      // En çok iki MGET parçası (60'lık)
      expect(bulut.all.length, today).toBeLessThanOrEqual(70);
    }
  });

  it('dakikası olan gün: aynı saate kadar; satışsız gün "satış yok" (₺0), raporu olmayan gün "veri yok"', () => {
    const stats: PatronStats = statsFromReports(patron, [
      rep('2026-11-21', [
        [200, 50_000, 5],
        [399, 47_500, 4],
        [700, 30_000, 3],
      ]),
      rep('2026-11-15', []),
      null,
    ]);
    expect(stats.src).toBe('rapor');
    const r = todayStats(patron, stats, at(400));
    expect(r.mode).toBe('live');
    const [dun, hafta, ay] = r.compares;
    expect(dun).toMatchObject({ label: 'Dün', date: '2026-11-21', value: { netSales: 97_500, receipts: 9 }, full: { netSales: 127_500, receipts: 12 }, grain: 'dakika', change: -63.4, diff: 35_700 - 97_500 });
    // O gün iş günü var, satış yok: ₺0 (ekran "satış yok" yazar), yüzde hesaplanamaz
    expect(hafta).toMatchObject({ label: 'Geçen hafta bugün', value: { netSales: 0, receipts: 0 }, change: null });
    // Rapor yok: veri yok (₺0 değil)
    expect(ay).toMatchObject({ label: 'Geçen ay bugün', date: '2026-10-22', value: null, full: null, change: null });
    expect(COMPARE_LABELS).toEqual({ dun: 'Dün', hafta: 'Geçen hafta bugün', ay: 'Geçen ay bugün' });
  });

  it('yalnız saatlik kırılım: tamamlanan saatler sayılır, süren saat sayılmaz', () => {
    const day = rep('2026-11-21', [], { s: { rev: 90_000, receipts: 9 }, hours: [[3, 40_000, 4], [6, 20_000, 2], [9, 30_000, 3]] });
    expect(reportCloses(day)).toEqual({ closes: [[239, 40_000, 4], [419, 20_000, 2], [599, 30_000, 3]], grain: 'saat' });
    const stats = statsFromReports(patron, [day]);
    // 11:40 (gün başından 400. dakika): 08:00-09:00 saati (239) tamam; 11:00-12:00 saati (419) sürüyor
    const dun = todayStats(patron, stats, at(400)).compares[0]!;
    expect(dun).toMatchObject({ grain: 'saat', value: { netSales: 40_000, receipts: 4 }, full: { netSales: 90_000, receipts: 9 } });
    expect(todayStats(patron, stats, at(419)).compares[0]!.value).toEqual({ netSales: 60_000, receipts: 6 });
  });

  it('kırılım yok: gün sonu toplamı, "gün sonu" notu; gün sürerken yüzde yok, gün kapanınca var; tahmine girmez', () => {
    const bare = (date: string, rev: number): StatsDayReport => ({ date, n: 1, closed: true, s: { rev, receipts: 3 } });
    const stats = statsFromReports(patron, [bare('2026-11-21', 80_000), bare('2026-11-15', 60_000), bare('2026-11-08', 50_000)]);
    expect(stats.days['2026-11-21']).toEqual({ open: false, closes: [[0, 80_000, 3]], grain: 'gun' });
    const live = todayStats(patron, stats, at(400));
    expect(live.compares[0]).toMatchObject({ grain: 'gun', value: { netSales: 80_000, receipts: 3 }, change: null, diff: null });
    // Pay hesaplanamayan günlerle tahmin yapılmaz (pay %100 çıkar, tahmin bugünkü ciroya eşitlenirdi)
    expect(live.forecast).toBeNull();
    const closedStats = statsFromReports({ ...patron, dayOpen: false }, [bare('2026-11-21', 80_000)]);
    const closed = todayStats({ ...patron, dayOpen: false }, closedStats, at(1000));
    expect(closed.mode).toBe('closed');
    expect(closed.compares[0]).toMatchObject({ grain: 'gun', change: -55.4, diff: 35_700 - 80_000 });
  });

  it('bugün: gün açıksa canlı; kapalı ve satış varsa kapandı; açılmadıysa yok. Hafta ve ay toplamı geçmiş tam günlerden', () => {
    const days = [rep('2026-11-21', [[100, 10_000, 1]]), rep('2026-11-16', [[100, 20_000, 2]]), rep('2026-11-02', [[100, 30_000, 3]]), rep('2026-10-22', [[100, 5_000, 1]])];
    const live = todayStats(patron, statsFromReports(patron, days), at(400));
    // Bugünün eğrisi özetin saatlik dizisinden: 09:00 saati gün başından 4. saat, 11:00 saati 6. saat
    expect(live.curve.today!.slice(0, 7)).toEqual([0, 0, 0, 0, 0, 20_000, 20_000]);
    expect(live.curve.todayNow).toBe(35_700);
    // Hafta Pazartesi 16 Kasım'dan: 16'sı ve 21'i + bugün; ay 1 Kasım'dan: 2, 16, 21 + bugün
    expect(live.periods.map((p) => [p.key, p.cur.netSales, p.cur.days])).toEqual([
      ['hafta', 30_000 + 35_700, 3],
      ['ay', 60_000 + 35_700, 4],
    ]);
    const closed = { ...patron, dayOpen: false };
    expect(todayStats(closed, statsFromReports(closed, days), at(900)).mode).toBe('closed');
    const none = { ...patron, dayOpen: false, netSales: 0, orders: 0, hourly: [] };
    expect(todayStats(none, statsFromReports(none, days), at(60)).mode).toBe('none');
    expect(todayStats(none, statsFromReports({ ...none, lastClose: { date: T } }, days), at(900)).mode).toBe('closed');
    // Bugünün ve geleceğin raporu geçmiş gün sayılmaz
    expect(statsFromReports(patron, [rep(T, [[10, 999, 1]])]).daily).toEqual([]);
  });
});

describe('özetin kendi rakamlarıyla (girdi hiç yok)', () => {
  const d = { ...patron, yesterday: { netSales: 97_500, receipts: 9 }, compare: { lastWeek: { netSales: 19_500, orders: 2, change: 83.1 } } };

  it('dün gün sonu toplamıyla (gün sürerken yüzde yok), geçen hafta bu saate kadar, geçen ay veri yok', () => {
    expect(statsSource(d)).toBe('ozet');
    const r = summaryCompares(d);
    expect(r.mode).toBe('live');
    expect(r.compares.map((c) => c.label)).toEqual(['Dün', 'Geçen hafta bugün', 'Geçen ay bugün']);
    expect(r.compares[0]).toMatchObject({ grain: 'gun', value: { netSales: 97_500, receipts: 9 }, change: null, diff: null });
    expect(r.compares[1]).toMatchObject({ grain: 'dakika', value: { netSales: 19_500, receipts: 2 }, change: 83.1, diff: 16_200, full: null });
    expect(r.compares[2]).toMatchObject({ date: '2026-10-22', value: null, change: null });
    const closed = summaryCompares({ ...d, dayOpen: false });
    expect(closed.mode).toBe('closed');
    expect(closed.compares[0]).toMatchObject({ change: -63.4, diff: 35_700 - 97_500 });
  });
});

describe('LafPOS Uzaktan: eski kasanın özetine kıyas girdisi eklenir', () => {
  const CLOUD = 'https://lafpos.vercel.app';
  const SECRET = 'k'.repeat(40);
  const REDIS = 'https://redis.test';
  const store = new Map<string, string>();
  const log: UpstashCall[] = [];
  const ENV = ['LAFPOS_CLOUD_SECRET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA'];
  const saved: Record<string, string | undefined> = {};
  const BASE = JSON.parse(readFileSync(join(__dirname, '../api/demo-ozet.json'), 'utf8')) as { at: number; bootstrap: Record<string, unknown>; patron: Record<string, unknown> & { date: string } };
  const api = () => import('../api/uzaktan');
  let failReads = false;

  beforeAll(() => {
    for (const k of ENV) saved[k] = process.env[k];
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, KV_REST_API_URL: REDIS, KV_REST_API_TOKEN: 't' });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== REDIS) throw new Error(`beklenmeyen istek: ${String(input)}`);
      const cmd = JSON.parse(String(init!.body)) as string[];
      if (failReads && cmd[0] === 'MGET' && String(cmd[1]).startsWith('lafpos:rapor:')) return new Response('{"error":"down"}', { status: 500 });
      return new Response(JSON.stringify({ result: upstashCommand(store, cmd, log) }));
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
  });
  beforeEach(async () => {
    store.clear();
    log.length = 0;
    failReads = false;
    (await api()).statsDayCache.clear();
  });

  const today = BASE.patron.date;
  const prev = (n: number) => new Date(Date.parse(`${today}T12:00:00Z`) - n * 86400_000).toISOString().slice(0, 10);
  const snap = (at: number, sales: number, stats?: unknown) => ({ ...BASE, at, bootstrap: { ...BASE.bootstrap, serverTime: at }, patron: { ...BASE.patron, now: at, netSales: sales, ...(stats ? { stats } : {}) } });
  async function push(s: object) {
    const { POST } = await api();
    const body = JSON.stringify({ gz: gzipSync(JSON.stringify(s)).toString('base64') });
    await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/push`, { method: 'POST', body, headers: signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/uzaktan/push`), body) }));
  }
  async function login() {
    const { POST } = await api();
    return ((await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: '{}' }))).json()) as { token: string }).token;
  }
  async function view(token: string, tag?: string | null) {
    const { GET } = await api();
    const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=reports/patron`, { headers: { authorization: `Bearer ${token}`, ...(tag ? { 'if-none-match': tag } : {}) } }));
    return { status: res.status, tag: res.headers.get('etag'), body: res.status === 200 ? ((await res.json()) as { now: number; netSales: number; stats?: PatronStats }) : null };
  }
  /** Bulutta duran gün raporu (kasanın ittiği biçim; kıyasın okuduğu alanlar dolu) */
  const dayReport = (date: string, closes: [number, number, number][]) => ({
    v: 1,
    date,
    at: 1,
    n: 1,
    closed: true,
    z: [1],
    s: { rev: closes.reduce((a, c) => a + c[1], 0), receipts: closes.reduce((a, c) => a + c[2], 0) },
    pay: [],
    types: [],
    kdv: [],
    closes,
    prod: [['p|M', 'Latte', 'M', 'Kahve', 3, 1, 0, 0]],
    hours: [],
    clock: [],
    staff: [],
  });
  const cmds = () => log.map((c) => c.cmd);

  it('stats göndermeyen kasa: girdi gün raporlarından, src "rapor"; okuma yalnız özet okunurken ve bellekte tutulur', async () => {
    store.set(`lafpos:rapor:default:gun:${prev(1)}`, JSON.stringify(dayReport(prev(1), [[60, 40_000, 2], [900, 60_000, 3]])));
    store.set(`lafpos:rapor:default:gun:${prev(7)}`, JSON.stringify(dayReport(prev(7), [[30, 25_000, 1]])));
    await push(snap(BASE.at, 100_000));
    const token = await login();
    log.length = 0;
    const first = await view(token);
    expect(first.status).toBe(200);
    // Sürüm, özet ve gün raporları (tek MGET); yeni yoklama yok
    expect(cmds()).toEqual(['HGETALL', 'GET', 'MGET']);
    expect(first.body!.stats).toMatchObject({ v: 1, src: 'rapor', guests: 0, topPrev: [] });
    expect(first.body!.stats!.days[prev(1)]).toEqual({ open: false, closes: [[60, 40_000, 2], [900, 60_000, 3]] });
    expect(first.body!.stats!.daily).toContainEqual([prev(1), 100_000, 5]);
    // Kıyas ekranın yaptığı hesapla: dün aynı saate kadar ve gün sonu
    const r = todayStats({ date: today, dayOpen: true, netSales: 100_000, orders: 5 }, first.body!.stats!, businessDayStartMs(today) + 400 * 60_000);
    expect(r.compares[0]).toMatchObject({ value: { netSales: 40_000, receipts: 2 }, full: { netSales: 100_000, receipts: 5 }, change: 150 });
    expect(r.compares[1]).toMatchObject({ value: { netSales: 25_000, receipts: 1 }, change: 300 });
    expect(r.compares[2]!.value).toBeNull();

    // Değişmeyen özet: 304, gün raporu okunmaz
    log.length = 0;
    expect((await view(token, first.tag)).status).toBe(304);
    expect(cmds()).toEqual(['HGETALL']);
    // Satış geldi: özet yeniden okunur, geçmiş günler bellekten (MGET yok)
    await push(snap(BASE.at + 60_000, 125_000));
    log.length = 0;
    const next = await view(token, first.tag);
    expect(next.body!.netSales).toBe(125_000);
    expect(next.body!.stats!.src).toBe('rapor');
    expect(cmds()).toEqual(['HGETALL', 'GET']);
  });

  it('stats gönderen kasa (yeni derleme): özete dokunulmaz, gün raporu okunmaz', async () => {
    const stats = { v: 1, guests: 4, days: {}, daily: [], topPrev: [] };
    store.set(`lafpos:rapor:default:gun:${prev(1)}`, JSON.stringify(dayReport(prev(1), [[60, 40_000, 2]])));
    await push(snap(BASE.at, 100_000, stats));
    const token = await login();
    log.length = 0;
    const r = await view(token);
    expect(r.body!.stats).toEqual(stats);
    expect(statsSource(r.body!)).toBe('kasa');
    expect(cmds()).toEqual(['HGETALL', 'GET']);
  });

  it('gün raporu okunamazsa özet olduğu gibi döner (ekran özetin iki rakamıyla çizer)', async () => {
    await push(snap(BASE.at, 100_000));
    const token = await login();
    failReads = true;
    const r = await view(token);
    expect(r.status).toBe(200);
    expect(r.body!.netSales).toBe(100_000);
    expect(r.body!.stats).toBeUndefined();
    expect(statsSource(r.body!)).toBe('ozet');
  });
});

describe('ekran yazıları', () => {
  it('değişim hapı Türkçe biçimde: yüzde işareti önde, ondalık virgül; artışta artı, düşüşte yalnız ok', async () => {
    const { changeText } = await import('@shared/today-stats');
    expect(changeText(83.1)).toBe('+%83,1');
    expect(changeText(-63.4)).toBe('%63,4');
    expect(changeText(76)).toBe('+%76');
    expect(changeText(1044.5)).toBe('+%1.044,5');
    expect(changeText(0)).toBe('%0');
  });

  it('canlılık: iki dakikaya kadar "Az önce", sonra "N dk önce"; bir saatten eskiyse saat yazılır', async () => {
    const { agoText } = await import('@shared/today-stats');
    expect(agoText(0)).toBe('Az önce');
    expect(agoText(119_000)).toBe('Az önce');
    expect(agoText(3 * 60_000 + 20_000)).toBe('3 dk önce');
    expect(agoText(59 * 60_000)).toBe('59 dk önce');
    expect(agoText(61 * 60_000)).toBeNull();
  });

  it('Merkez satırı kurulu derlemeyi tarihiyle yazar ("Sürüm 0.2.0" tek başına hangi derleme olduğunu söylemez)', async () => {
    const { buildLabel } = await import('../src/lib/text');
    // Derleme numarası commit'in unix zamanı: 21 Kasım 2026 19:42 (İstanbul)
    const build = Date.UTC(2026, 10, 21, 16, 42) / 1000;
    expect(buildLabel('0.2.0', build)).toBe('Sürüm 0.2.0 · 21 Kas 19:42 derlemesi');
    expect(buildLabel('0.2.0', null)).toBe('Sürüm 0.2.0');
    expect(buildLabel(null, null)).toBe('Sürüm bilinmiyor');
    expect(buildLabel(null, build)).toBe('21 Kas 19:42 derlemesi');
    // Zaman olmayan eski numara olduğu gibi
    expect(buildLabel('0.1.0', 412)).toBe('Sürüm 0.1.0 · derleme 412');
  });
});
