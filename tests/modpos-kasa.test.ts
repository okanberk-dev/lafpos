import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GECMIS_KEY, type HistoryDay, historyKey, MODPOS_KEY } from '@shared/gecmis';
import type { RemoteDayReport } from '@shared/remote-reports';
import { addDays } from '@shared/time';
import { upstashCommand } from './fake-upstash';
import { type Harness, startApp } from './harness';

/**
 * Sahibin bildirdiği hata (23 Kasım 2026): LafPOS Uzaktan › Raporlar › "Geçen hafta" Marina'nın ModPOS günlerini (16-21)
 * hiç göstermiyor. Elle yüklenen geçmiş bulutta başka bir dükkân anahtarında (ya da hiç yok), eski deneme raporları da
 * duruyor olabilir; buluttaki durumu okuyamayız. Çözüm kasada: ModPOS günleri lafmaliyet'ten (ladmin) gelir
 * (`GET /api/panel/pos/modpos-gunler`), kasa onları kendi dükkân kimliğiyle gün raporu olarak Uzaktan'a iter ve kendi
 * Raporlar'ında da gösterir. İş günü, Z zinciri ve lafmaliyet giden kutusu geçmişi görmez.
 */
const CLOUD = 'https://modpos-uzak.test';
const LADMIN = 'https://ladmin.test';
const SECRET = 'u'.repeat(40);
const SYNC = 's'.repeat(40);
const PASSWORD = 'modpos-kasa-parola-1';
const store = new Map<string, string>();
const ladminCalls: { path: string; query: string; signed: boolean }[] = [];
let ladminAnswer: (url: URL) => Response;
let h: Harness;
let today: string;

/** §6 ModPOS tablosu (TL), dün ve önceki sekiz gün (13-21 Kasım'ın yerine kasanın bugününe göre) */
const TABLE: [number, number, number, number, number, number, number, string][] = [
  [390.0, 195.0, 195.0, 0, 0, 2, 0, 'Z-2026-002'],
  [3311.0, 2687.25, 623.75, 249.0, 0, 14, 0, 'Z-2026-003'],
  [5753.0, 4146.5, 1606.5, 517.0, 100.0, 27, 90.0, 'Z-2026-004'],
  [2670.0, 2140.0, 530.0, 0, 0, 9, 0, 'Z-2026-005'],
  [1641.25, 1171.25, 470.0, 153.75, 455.0, 12, 0, 'Z-2026-006'],
  [2419.25, 1814.5, 604.75, 315.75, 400.0, 16, 0, 'Z-2026-007'],
  [2535.75, 1472.5, 1063.25, 204.25, 200.0, 19, 0, 'Z-2026-008'],
  [4008.0, 2914.25, 1093.75, 397.0, 255.0, 19, 0, 'Z-2026-009'],
  [4620.5, 3203.0, 1417.5, 229.5, 0, 17, 0, 'Z-2026-010'],
];
/** Tablonun i. günü: bugünden 9 - i gün önce (son satır dün) */
const dateOf = (i: number) => addDays(today, -(9 - i));

/** lafmaliyet'in yanıtı (CONTRACT §5.1): TL iki haneli; 15'inci günün ciro dışı 100 ödenmez + 90 ikram */
function ladminBody(over: Record<string, unknown> = {}) {
  return {
    version: 1,
    now: new Date().toISOString(),
    sube: 'marina',
    switchDay: addDays(today, 0),
    days: TABLE.map(([ciro, kart, nakit, indirim, odenmez, fis, ikram, zNo], i) => ({
      date: dateOf(i),
      ciro,
      kart,
      nakit,
      yemek: 0,
      online: 0,
      diger: 0,
      indirim,
      odenmez,
      ikram,
      fis,
      zNo,
      // İlk gün KDV kırılımıyla; öbürleri kırılımsız (kasa %10 sayar)
      ...(i === 0 ? { kdv: [{ rate: 10, base: 354.55, vat: 35.45 }] } : {}),
    })),
    urunler: { from: dateOf(0), to: dateOf(8), rows: Array.from({ length: 31 }, (_, i) => ({ ad: `ÜRÜN ${String(i + 1).padStart(2, '0')}`, boy: i % 2 ? 'L' : 'M', adet: i < 23 ? 8 : 7, tutar: i < 30 ? 950 : 915 })) },
    ...over,
  };
}

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET, merkezUrl: '', lafmaliyetUrl: '', lafmaliyetToken: SYNC });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  delete process.env.LAFPOS_UYE_EPOSTA;
  const { sign } = await import('../server/lib/signature');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') return new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[]) }));
    if (url.startsWith(LADMIN)) {
      const u = new URL(url);
      const headers = new Headers(init?.headers);
      const ts = Number(headers.get('x-laf-timestamp'));
      const signed = headers.get('x-laf-signature') === `v1=${sign(SYNC, { timestamp: ts, method: init?.method ?? 'GET', url: u, body: '' })}`;
      ladminCalls.push({ path: u.pathname, query: u.search, signed });
      return ladminAnswer(u);
    }
    if (url.startsWith(CLOUD)) {
      const { GET, POST } = await import('../api/uzaktan');
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: init?.method ?? 'GET', body: init?.body as string | undefined, headers: init?.headers as Record<string, string> });
      return (init?.method ?? 'GET') === 'POST' ? POST(req) : GET(req);
    }
    return realFetch(input, init);
  });
  const { reportToday } = await import('../server/services/reports');
  today = reportToday();
  ladminAnswer = () => Response.json(ladminBody());
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});
beforeEach(() => {
  ladminCalls.length = 0;
});

/** Uzaktan'ın Raporlar'ı, kasanın dükkânı (`default`: Merkez'e bağlı değil) */
async function remote<T = any>(path: string): Promise<T> {
  const { GET, POST } = await import('../api/uzaktan');
  const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '4.4.4.4' } }))).json()) as { token: string };
  const [p, q = ''] = path.split('?');
  const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${p}${q ? `&${q}` : ''}`, { headers: { authorization: `Bearer ${token}`, 'x-laf-dukkan': 'default' } }));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

/** Kuruşa çevrilmiş tablo: elle yüklenen geçmişin biçimi (Merkez, `parseHistory` sonrası) */
const manualDays = (): HistoryDay[] =>
  TABLE.map(([ciro, kart, nakit, indirim, odenmez, fis, ikram, z], i) => ({
    date: dateOf(i),
    ciro: Math.round(ciro * 100),
    adisyon: fis,
    closes: [],
    pay: [
      ['Kredi kartı', 'card', Math.round(kart * 100), 0],
      ['Nakit', 'cash', Math.round(nakit * 100), 0],
    ],
    ...(indirim ? { indirim: Math.round(indirim * 100) } : {}),
    ...(odenmez + ikram ? { odenmez: Math.round((odenmez + ikram) * 100) } : {}),
    z,
  }));

/** Eski deneme raporu: "Denemeyi bitir"den önce buluta itilmiş, 880 TL (tablonun ilk günü ModPOS'ta 390 TL) */
function staleTraining(date: string): RemoteDayReport {
  return {
    v: 1,
    date,
    at: Date.parse(`${date}T20:00:00+03:00`),
    n: 1,
    closed: true,
    z: [3],
    s: { list: 88000, gross: 88000, comp: 0, disc: 0, svc: 0, rev: 88000, odenmez: 0, zayi: 0, voided: 0, receipts: 4, items: 6, tips: 0, guests: 0, tableSales: 0, paidClosed: 88000, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
    pay: [['Nakit', 'cash', 88000, 4]],
    types: [],
    kdv: [[10, 88000, 80000, 8000]],
    closes: [[600, 88000, 4]],
    prod: [],
    hours: [],
    clock: [],
    staff: [],
  };
}

describe('sahibin bildirdiği hata: Uzaktan "Geçen hafta" ModPOS günlerini göstermiyor', () => {
  it('kasada geçmiş var, bulutta başka dükkânın anahtarında: Uzaktan o günleri göstermez; kasa iter, hepsi görünür', async () => {
    const { setSyncState } = await import('../server/lib/settings');
    const { reportTick } = await import('../server/sync/cloud-reports');
    // Kasa Merkez nabzıyla geçmişi almış (elle yüklenen); bulutta kayıt başka bir kurulum kimliğinin anahtarında
    setSyncState(GECMIS_KEY, { at: 7, kaynak: 'ModPOS', gunler: manualDays() });
    store.set(historyKey('a'.repeat(24)), JSON.stringify({ v: 1, kaynak: 'ModPOS', at: 7, gunler: manualDays() }));
    // Tablonun ilk günü için bulutta "Denemeyi bitir"den önce itilmiş 880 TL'lik deneme raporu
    store.set(`lafpos:rapor:default:gun:${dateOf(0)}`, JSON.stringify(staleTraining(dateOf(0))));
    const week = `reports/summary?from=${dateOf(3)}&to=${dateOf(8)}`;
    const before = await remote<{ byDay: { date: string }[] }>(week);
    // Hata: 6 ModPOS günü yok
    expect(before.byDay).toEqual([]);
    await reportTick({ backfill: true });
    const after = await remote<{ byDay: { date: string; netSales: number; kaynak?: string; zText?: string }[]; netSales: number; waterfall: { discounts: number } }>(week);
    expect(after.byDay.map((d) => d.date)).toEqual([3, 4, 5, 6, 7, 8].map(dateOf));
    expect(after.byDay.every((d) => d.kaynak === 'ModPOS')).toBe(true);
    expect(after.byDay.map((d) => d.zText)).toEqual(['Z-2026-005', 'Z-2026-006', 'Z-2026-007', 'Z-2026-008', 'Z-2026-009', 'Z-2026-010']);
    expect(after.netSales).toBe(267000 + 164125 + 241925 + 253575 + 400800 + 462050);
    expect(after.waterfall.discounts).toBe(15375 + 31575 + 20425 + 39700 + 22950);
    // Eski deneme raporu (880 TL) ModPOS'un 390 TL'lik gününe döner: 490 TL fark kalmaz
    const all = await remote<{ netSales: number; byDay: { date: string; netSales: number }[] }>(`reports/summary?from=${dateOf(0)}&to=${dateOf(8)}`);
    expect(all.byDay[0]).toMatchObject({ date: dateOf(0), netSales: 39000 });
    expect(all.netSales).toBe(2734875);
  });
});

describe('ModPOS dönemi lafmaliyet\'ten (GET /api/panel/pos/modpos-gunler)', () => {
  it('bağlantı tanımlı değilse hiç istek yok; elle çekim 409', async () => {
    const { modposTick, pullModposNow } = await import('../server/sync/modpos');
    expect(await modposTick()).toBe('off');
    expect(() => pullModposNow({ id: null })).toThrow(/bağlantısı tanımlı değil/);
    expect(ladminCalls).toEqual([]);
  });

  it('imzalı istek şubeyle; günler kuruşa çevrilir (ciro dışı = ödenmez + ikram, KDV, Z), ürün listesi alınır', async () => {
    const { env } = await import('../server/env');
    env.lafmaliyetUrl = LADMIN;
    const { pullModposNow, modposState } = await import('../server/sync/modpos');
    const r = await pullModposNow({ id: null }, Date.now());
    expect(ladminCalls).toEqual([{ path: '/api/panel/pos/modpos-gunler', query: '?sube=marina', signed: true }]);
    expect(r).toMatchObject({ days: 9, from: dateOf(0), to: dateOf(8), products: 31, changed: true });
    const s = modposState()!;
    expect(s).toMatchObject({ kaynak: 'ModPOS', source: 'ladmin', switchDay: today, lastError: null });
    expect(s.gunler[0]).toEqual({ date: dateOf(0), ciro: 39000, adisyon: 2, closes: [], pay: [['Kredi kartı', 'card', 19500, 0], ['Nakit', 'cash', 19500, 0]], kdv: [[10, 39000, 35455, 3545]], z: 'Z-2026-002' });
    // 15'inci gün: 100 ödenmez + 90 ikram = 190 ciro dışı; KDV kırılımı yok (rapor %10 sayar)
    expect(s.gunler[2]).toMatchObject({ ciro: 575300, indirim: 51700, odenmez: 19000, z: 'Z-2026-004' });
    expect(s.gunler[2]).not.toHaveProperty('kdv');
    expect(s.urunler!.rows).toHaveLength(31);
    expect(s.urunler!.rows.reduce((a, x) => a + x[3], 0)).toBe(2941500);
    expect(s.urunler!.rows.reduce((a, x) => a + x[2], 0)).toBe(240);
    // Elle çekim denetim kaydına yazılır
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    expect(db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'sync.lafmaliyet_modpos')).all()).toHaveLength(1);
  });

  it('bütçe: kendiliğinden iş günü başına bir kez; elle çekim 5 dakikadan sık değil', async () => {
    const { modposTick, pullModposNow, modposState } = await import('../server/sync/modpos');
    const at = modposState()!.checkedAt;
    // Aynı iş gününde yeniden kendiliğinden istek yok
    expect(await modposTick(at + 60_000)).toBe('skip');
    expect(ladminCalls).toEqual([]);
    // Elle: 5 dakika dolmadan 429
    expect(() => pullModposNow({ id: null }, at + 4 * 60_000)).toThrow(/az önce çekildi/);
    const route = await h.call('patron', 'POST', '/sync/lafmaliyet/modpos/pull');
    expect(route.status).toBe(429);
    expect(ladminCalls).toEqual([]);
    // Ertesi iş günü bir kez
    const next = at + 24 * 3600_000;
    expect(await modposTick(next)).toBe('ok');
    expect(await modposTick(next + 10 * 60_000)).toBe('skip');
    expect(ladminCalls).toHaveLength(1);
  });

  it('hata önceki günleri silmez, Entegrasyon\'da görünür; başka şubenin yanıtı alınmaz', async () => {
    const { pullModposNow, modposState, modposStatus } = await import('../server/sync/modpos');
    const before = modposState()!.gunler;
    const t0 = modposState()!.checkedAt + 6 * 60_000;
    ladminAnswer = () => Response.json({ error: 'boom' }, { status: 500 });
    await expect(pullModposNow({ id: null }, t0)).rejects.toThrow(/ModPOS dönemi alınamadı \(HTTP 500/);
    expect(modposState()!.gunler).toEqual(before);
    expect(modposStatus()).toMatchObject({ days: 9, error: { message: expect.stringMatching(/HTTP 500/) } });
    ladminAnswer = () => Response.json(ladminBody({ sube: 'tuzla' }));
    await expect(pullModposNow({ id: null }, t0 + 6 * 60_000)).rejects.toThrow(/"tuzla" şubesinin/);
    ladminAnswer = () => Response.json({ ...ladminBody(), days: [{ date: 'x' }] });
    await expect(pullModposNow({ id: null }, t0 + 12 * 60_000)).rejects.toThrow(/beklenen biçimde değil/);
    expect(modposState()!.gunler).toEqual(before);
    ladminAnswer = () => Response.json(ladminBody());
    await pullModposNow({ id: null }, t0 + 18 * 60_000);
    expect(modposStatus()).toMatchObject({ days: 9, error: null, products: 31 });
  });
});

describe('lafmaliyet\'in yanıtı hoşgörüyle okunur', () => {
  it('bozuk gün tek başına düşer, bilinmeyen alan yok sayılır; ondalıklı adet alınır, bozuk ürün listesi düşer, günler kalır', async () => {
    const { pullModposNow, modposState } = await import('../server/sync/modpos');
    const t0 = modposState()!.checkedAt + 6 * 60_000;
    try {
      ladminAnswer = () => {
        const b = ladminBody() as ReturnType<typeof ladminBody> & { extra?: unknown };
        b.extra = { yeni: true };
        (b.days as unknown[])[1] = { date: dateOf(1), ciro: 'bozuk' };
        (b.days[2] as Record<string, unknown>).zNo = 42;
        (b.days[2] as Record<string, unknown>).kdv = 'bozuk';
        (b.days[2] as Record<string, unknown>).yeniAlan = 1;
        b.urunler.rows[0]!.adet = 7.5;
        return Response.json(b);
      };
      const r = await pullModposNow({ id: null }, t0);
      expect(r).toMatchObject({ days: 8, products: 31 });
      const s = modposState()!;
      expect(s.gunler.map((d) => d.date)).not.toContain(dateOf(1));
      expect(s.gunler.find((d) => d.date === dateOf(2))).toMatchObject({ ciro: 575300, indirim: 51700 });
      expect(s.gunler.find((d) => d.date === dateOf(2))).not.toHaveProperty('z');
      expect(s.urunler!.rows[0]![2]).toBe(7.5);
      ladminAnswer = () => Response.json({ ...ladminBody(), urunler: { from: dateOf(0), rows: 'bozuk' } });
      expect(await pullModposNow({ id: null }, t0 + 6 * 60_000)).toMatchObject({ days: 9, products: 0 });
      expect(modposState()!.urunler).toBeUndefined();
    } finally {
      ladminAnswer = () => Response.json(ladminBody());
      await pullModposNow({ id: null }, t0 + 12 * 60_000);
    }
    expect(modposState()).toMatchObject({ lastError: null });
    expect(modposState()!.gunler).toHaveLength(9);
    expect(modposState()!.urunler!.rows).toHaveLength(31);
  });
});

describe('yalnız föyden gelen gün ve karaoke KDV\'si (CONTRACT §9)', () => {
  it('föy gününde indirim bilinmiyor: brüt = ciro, raporlar "bilinmiyor" der; KDV satırları geldiği gibi (%20 karaoke)', async () => {
    const { pullModposNow, modposState } = await import('../server/sync/modpos');
    const { reportTick } = await import('../server/sync/cloud-reports');
    const t0 = modposState()!.checkedAt + 6 * 60_000;
    try {
      ladminAnswer = () => {
        const b = ladminBody();
        // Dünden önceki gün yalnız föyden (indirim bilinmiyor); dün kasa raporlu, karaoke %20 dahil
        Object.assign(b.days[7]!, { indirim: null, kaynak: 'foy' });
        Object.assign(b.days[8]!, { kaynak: 'kasa_raporu', kdv: [{ rate: 10, base: 3836.82, vat: 383.68 }, { rate: 20, base: 333.33, vat: 66.67 }] });
        return Response.json(b);
      };
      await pullModposNow({ id: null }, t0);
      const days = modposState()!.gunler;
      expect(days[7]).toMatchObject({ date: dateOf(7), ciro: 400800, indirimBilinmiyor: true });
      expect(days[7]).not.toHaveProperty('indirim');
      expect(days[8]!.kdv).toEqual([
        [10, 422050, 383682, 38368],
        [20, 40000, 33333, 6667],
      ]);
      const s = await h.ok<any>('patron', 'GET', `/reports/summary?from=${dateOf(7)}&to=${dateOf(8)}`);
      expect(s.history).toEqual({ kaynak: 'ModPOS', days: 2, from: dateOf(7), to: dateOf(8), indirimBilinmiyor: 1 });
      expect(s.waterfall.discounts).toBe(22950);
      expect(s.gross).toBe(400800 + 462050 + 22950);
      expect(s.kdv).toEqual([
        { rate: 10, gross: 400800 + 422050, base: 364364 + 383682, kdv: 36436 + 38368 },
        { rate: 20, gross: 40000, base: 33333, kdv: 6667 },
      ]);
      const only = await h.ok<any>('patron', 'GET', `/reports/items?kind=indirim&from=${dateOf(7)}&to=${dateOf(7)}`);
      expect(only.history).toEqual({ kaynak: 'ModPOS', days: 1, amount: 0, indirimBilinmiyor: 1 });
      // Uzaktan da aynı: gün raporu bilinmiyor işaretiyle gider
      await reportTick({ backfill: true });
      expect(JSON.parse(store.get(`lafpos:rapor:default:gun:${dateOf(7)}`)!)).toMatchObject({ indirimBilinmiyor: true, s: { disc: 0, gross: 400800 } });
      const remoteSum = await remote<any>(`reports/summary?from=${dateOf(7)}&to=${dateOf(8)}`);
      expect(remoteSum.history).toEqual({ kaynak: 'ModPOS', days: 2, from: dateOf(7), to: dateOf(8), indirimBilinmiyor: 1 });
      expect(remoteSum.kdv).toEqual(s.kdv);
      const remoteItems = await remote<any>(`reports/items?kind=indirim&from=${dateOf(7)}&to=${dateOf(7)}`);
      expect(remoteItems.history).toEqual({ kaynak: 'ModPOS', days: 1, amount: 0, indirimBilinmiyor: 1 });
    } finally {
      ladminAnswer = () => Response.json(ladminBody());
      await pullModposNow({ id: null }, t0 + 6 * 60_000);
      await reportTick({ backfill: true });
    }
    expect(modposState()!.gunler[7]).toMatchObject({ indirim: 39700 });
  });
});

describe('kasadaki Raporlar ModPOS günlerini gösterir (Z ve iş günü hariç)', () => {
  const range = () => `from=${dateOf(0)}&to=${dateOf(8)}`;

  it('Ciro: §6 ModPOS rakamları, günler "ModPOS" etiketli ve Z numaralı; satılan ürün listenin adedi', async () => {
    const s = await h.ok<any>('patron', 'GET', `/reports/summary?${range()}`);
    expect(s.waterfall).toEqual({ list: 2734875 + 206625 + 150000, complimentary: 150000, discounts: 206625, service: 0, revenue: 2734875, kdv: 2734875 - 2486251, netExKdv: 2486251 });
    expect(s.receipts).toBe(135);
    expect(s.days).toBe(9);
    expect(s.payments.map((p: { name: string; amount: number }) => [p.name, p.amount])).toEqual([
      ['Kredi kartı', 1974425],
      ['Nakit', 760450],
    ]);
    expect(s.byDay.map((d: { kaynak?: string }) => d.kaynak)).toEqual(Array(9).fill('ModPOS'));
    expect(s.byDay[8]).toMatchObject({ date: dateOf(8), netSales: 462050, zText: 'Z-2026-010' });
    expect(s.itemsSold).toBe(240);
    expect(s.history).toEqual({ kaynak: 'ModPOS', days: 9, from: dateOf(0), to: dateOf(8) });
  });

  it('Ürünler: dönemin hepsi seçiliyse ModPOS bloğu (indirim öncesi), bir kısmı seçiliyse not; İndirim ve İkram listesinde toplam notu', async () => {
    const p = await h.ok<any>('patron', 'GET', `/reports/products?${range()}`);
    expect(p.total).toBe(0);
    expect(p.history).toMatchObject({ kaynak: 'ModPOS', covered: true, qty: 240, amount: 2941500, from: dateOf(0), to: dateOf(8) });
    const part = await h.ok<any>('patron', 'GET', `/reports/products?from=${dateOf(3)}&to=${dateOf(8)}`);
    expect(part.history).toEqual({ kaynak: 'ModPOS', from: dateOf(0), to: dateOf(8), covered: false });
    const ind = await h.ok<any>('patron', 'GET', `/reports/items?kind=indirim&${range()}`);
    expect(ind.history).toEqual({ kaynak: 'ModPOS', days: 9, amount: 206625 });
    const ikr = await h.ok<any>('patron', 'GET', `/reports/items?kind=ikram&${range()}`);
    expect(ikr.history).toEqual({ kaynak: 'ModPOS', days: 9, amount: 150000 });
    // lafmaliyet'ten gelen gün kapanış dakikası taşımaz: saatlik yalnız LafPOS'un (boş)
    const hr = await h.ok<any>('patron', 'GET', `/reports/hourly?${range()}`);
    expect(hr.total).toBe(0);
  });

  it('aynı tarihte lafmaliyet günü elle yükleneni geçer; patron panelinin kıyası da birleşik kaydı okur', async () => {
    const { setSyncState } = await import('../server/lib/settings');
    // Elle yüklenende dünün cirosu farklı (eski yükleme)
    setSyncState(GECMIS_KEY, { at: 8, kaynak: 'ModPOS', gunler: manualDays().map((d, i) => (i === 8 ? { ...d, ciro: 100, pay: [] } : d)) });
    const s = await h.ok<any>('patron', 'GET', `/reports/summary?from=${dateOf(8)}&to=${dateOf(8)}`);
    expect(s.netSales).toBe(462050);
    const p = await h.ok<{ stats: { daily: [string, number, number][] } }>('patron', 'GET', '/reports/patron');
    expect(p.stats.daily).toContainEqual([dateOf(8), 462050, 17]);
  });

  it('gerçek LafPOS günü geçmişi ezer; gerçek kullanımda deneme günü geçmişe yer bırakır (adisyonları okunmaz)', async () => {
    const { db, schema } = await import('../server/db/client');
    const { updateSettings } = await import('../server/lib/settings');
    const base = { openedAt: Date.parse(`${dateOf(1)}T09:00:00+03:00`), closedAt: Date.parse(`${dateOf(1)}T23:00:00+03:00`), openingCash: 0 };
    db.insert(schema.businessDays).values({ id: 'deneme-gunu-1', date: dateOf(1), zNo: 901, trainingDay: true, ...base }).run();
    db.insert(schema.businessDays).values({ id: 'gercek-gunu-2', date: dateOf(2), zNo: 902, trainingDay: false, ...base }).run();
    try {
      // Kurulum modunda deneme günleri kendi aralarında sayılır: geçmiş yalnız boş tarihe
      const setup = await h.ok<any>('patron', 'GET', `/reports/summary?from=${dateOf(1)}&to=${dateOf(2)}`);
      expect(setup.byDay.map((d: { kaynak?: string }) => d.kaynak ?? null)).toEqual([null, null]);
      updateSettings({ demoMode: false, okcProvider: 'kapali', liveSince: Date.now() });
      const s = await h.ok<any>('patron', 'GET', `/reports/summary?from=${dateOf(1)}&to=${dateOf(2)}`);
      // 14'ü ModPOS (deneme günü yerine), 15'i LafPOS'un gerçek günü (satışsız)
      expect(s.byDay).toEqual([
        { date: dateOf(1), netSales: 331100, receipts: 14, kaynak: 'ModPOS', zText: 'Z-2026-003' },
        { date: dateOf(2), netSales: 0, receipts: 0 },
      ]);
      expect(s.days).toBe(2);
    } finally {
      db.delete(schema.businessDays).run();
    }
  });

  it('yalıtım: geçmiş iş gününe, Z zincirine ve lafmaliyet giden kutusuna girmez; Z listesi değişmez', async () => {
    const { db, schema } = await import('../server/db/client');
    const { buildDayReport } = await import('../server/sync/cloud-reports');
    expect(db.select().from(schema.businessDays).all()).toEqual([]);
    expect(db.select().from(schema.outbox).all().filter((o) => o.target === 'lafmaliyet')).toEqual([]);
    // Gün raporu (Uzaktan'a giden LafPOS günü) geçmişi bilmez: o tarihte LafPOS günü yok
    expect(buildDayReport(dateOf(4))).toBeNull();
    const days = await h.ok<{ days?: unknown[] } | unknown[]>('patron', 'GET', '/cash/days');
    expect(JSON.stringify(days)).not.toMatch(/Z-2026/);
    // Yeni gün LafPOS'un kendi Z sırasıyla açılır (ModPOS'un Z'si sayılmaz)
    const opened = await h.ok<{ zNo: number }>('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    expect(opened.zNo).toBe(1);
  });
});

describe('Uzaktan\'a giden ModPOS günleri', () => {
  it('lafmaliyet\'ten gelen günler kaynak ve Z ile gider; değişmeyen gün yeniden gitmez, değişen gün gider', async () => {
    const { reportTick } = await import('../server/sync/cloud-reports');
    await reportTick({ backfill: true });
    const day = JSON.parse(store.get(`lafpos:rapor:default:gun:${dateOf(2)}`)!) as RemoteDayReport;
    expect(day).toMatchObject({ kaynak: 'ModPOS', zText: 'Z-2026-004', s: { rev: 575300, disc: 51700, comp: 19000, odenmez: 19000 } });
    expect(day.kdv).toEqual([[10, 575300, 523000, 52300]]);
    const sent: string[] = [];
    const real = globalThis.fetch;
    const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith('/api/uzaktan/rapor')) {
        const { gunzipSync } = await import('node:zlib');
        sent.push(...(JSON.parse(gunzipSync(Buffer.from((JSON.parse(String(init!.body)) as { gz: string }).gz, 'base64')).toString('utf8')) as { days: RemoteDayReport[] }).days.map((d) => d.date));
      }
      return real(input, init);
    });
    vi.stubGlobal('fetch', spy);
    try {
      const { pullModposNow, modposState } = await import('../server/sync/modpos');
      // Aynı içerik yeniden çekilir: kayıt anı değişmez, hiçbir gün yeniden gitmez
      await pullModposNow({ id: null }, modposState()!.checkedAt + 6 * 60_000);
      await reportTick({ backfill: true });
      expect(sent.filter((d) => d < today)).toEqual([]);
      // lafmaliyet'te bir günün indirimi düzeltildi: yalnız o gün gider
      ladminAnswer = () => {
        const b = ladminBody();
        b.days[5]!.indirim = 300;
        return Response.json(b);
      };
      await pullModposNow({ id: null }, modposState()!.checkedAt + 6 * 60_000);
      await reportTick({ backfill: true });
      expect(sent.filter((d) => d < today && d >= dateOf(0))).toEqual([dateOf(5)]);
    } finally {
      vi.stubGlobal('fetch', real);
      ladminAnswer = () => Response.json(ladminBody());
    }
  });
});
