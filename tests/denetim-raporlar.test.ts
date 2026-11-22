import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PlatformId, PlatformOrderPayload } from '@shared/platforms';
import type { RemoteDayExtra, RemoteDayReport } from '@shared/remote-reports';
import { addDays, businessDayStartMs } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Oturum denetiminin uzaktan rapor bulguları:
 * - "Bugün" ve kıyasın "aynı saate kadar"ı kasanın şimdiki zamanından (özetin nabzı), son rapor itmesinden değil
 * - kıyas dönemi uzakta saklanan 400 günün dışındaysa "kıyas yok", yarım toplamla şişmiş yüzde değil
 * - iş günü açılmamış tarihteki kaçan platform siparişi uzakta da görünür
 * - sınırı aşan ek veri: eski liste silinir, kasa listeyi kısaltır ve toplamı korur, ekranda yazar
 * - "Raporları yeniden gönder" süren turla çakışınca sıfırlama ezilmez
 */
const CLOUD = 'https://denetim-rapor.test';
const SECRET = 'z'.repeat(40);
const store = new Map<string, string>();
/** Dükkânların özet sürümü (Redis hash `lafpos:surum`): kasanın son itmesi, nabız dahil */
const versions = new Map<string, string>();
let gate: Promise<void> | null = null;
let h: Harness;

function redis([cmd, ...args]: string[]): unknown {
  if (cmd === 'GET') return store.get(args[0]!) ?? null;
  if (cmd === 'MGET') return args.map((k) => store.get(k) ?? null);
  if (cmd === 'SET') return (store.set(args[0]!, args[1]!), 'OK');
  if (cmd === 'DEL') return args.filter((k) => store.delete(k)).length;
  if (cmd === 'HGET') return versions.get(args[1]!) ?? null;
  if (cmd === 'HSET') return (versions.set(args[1]!, args[2]!), 1);
  if (cmd === 'HGETALL') return [...versions].flat();
  return 1;
}

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET, merkezUrl: '' });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  delete process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI;
  delete process.env.LAFPOS_UYE_EPOSTA;
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === 'https://redis.test') return new Response(JSON.stringify({ result: redis(JSON.parse(String(init!.body)) as string[]) }));
    if (!url.startsWith(CLOUD)) return realFetch(input, init);
    if (gate) await gate;
    const path = new URL(url).pathname.replace(/^\/api\//, '');
    const { POST } = await import('../api/uzaktan');
    return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: init!.body as string, headers: init!.headers as Record<string, string> }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

async function remote<T = any>(path: string, shop?: string): Promise<T> {
  const { GET, POST } = await import('../api/uzaktan');
  const login = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: '{}' }))).json()) as { token: string };
  const [p, q = ''] = path.split('?');
  const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${p}${q ? `&${q}` : ''}`, { headers: { authorization: `Bearer ${login.token}`, ...(shop ? { 'x-laf-dukkan': shop } : {}) } }));
  return (await res.json()) as T;
}

/** Bir günün rapor özeti: kapanışlar dakika dakika (gün başından) */
function day(date: string, closes: [number, number][]): RemoteDayReport {
  const rev = closes.reduce((a, c) => a + c[1], 0);
  return {
    v: 1,
    date,
    at: 0,
    n: 1,
    closed: true,
    z: [],
    s: { list: rev, gross: rev, comp: 0, disc: 0, svc: 0, rev, odenmez: 0, zayi: 0, voided: 0, receipts: closes.length, items: 0, tips: 0, guests: 0, tableSales: 0, paidClosed: rev, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
    pay: [],
    types: [],
    kdv: [],
    closes: closes.map(([m, v]) => [m, v, 1]),
    prod: [],
    hours: [],
    clock: [],
    staff: [],
  };
}
/** İstanbul saatiyle an */
const at = (date: string, hhmm: string) => Date.parse(`${date}T${hhmm}:00+03:00`);

describe('uzaktaki "bugün" ve kıyas kasanın şimdiki zamanıyla', () => {
  it('sabah gün açılmadan: dünün itmesi "bugün" sayılmaz, kıyas aynı saate kadar (yanlış -%100 yok)', async () => {
    const shop = 'sabah';
    // Gün sonu 01:00'de alındı, son rapor itmesi o an; sonra değişen gün yok. Özetin nabzı 07:00'de geldi (gün kapalı)
    store.set(`lafpos:rapor:${shop}:son`, JSON.stringify({ today: '2026-11-20', at: at('2026-11-21', '01:00') }));
    versions.set(shop, JSON.stringify({ at: at('2026-11-21', '07:00'), o: false, d: null }));
    // Geçen haftanın aynı günü: bütün satış öğleden sonra
    store.set(`lafpos:rapor:${shop}:gun:2026-11-14`, JSON.stringify(day('2026-11-14', [[600, 10_000]])));
    const s = await remote<{ previous: { label: string; netSales: number; change: number | null } }>('reports/summary?from=2026-11-21&to=2026-11-21', shop);
    expect(s.previous.label).toMatch(/aynı saate kadar/);
    expect(s.previous.netSales).toBe(0);
    expect(s.previous.change).toBeNull();
  });

  it('sakin saatte: kıyas son satışın itmesine değil kasanın son nabzına kadar', async () => {
    const shop = 'aksam';
    store.set(`lafpos:rapor:${shop}:son`, JSON.stringify({ today: '2026-11-21', at: at('2026-11-21', '09:01') }));
    versions.set(shop, JSON.stringify({ at: at('2026-11-21', '23:45'), o: true, d: '2026-11-21' }));
    // 21'inde 09:00'da 12.000 satış; geçen hafta 09:00'da 5.000, 20:00'de 5.000 (gün 05:00'te başlar)
    store.set(`lafpos:rapor:${shop}:gun:2026-11-21`, JSON.stringify(day('2026-11-21', [[240, 12_000]])));
    store.set(`lafpos:rapor:${shop}:gun:2026-11-14`, JSON.stringify(day('2026-11-14', [[240, 5_000], [900, 5_000]])));
    const s = await remote<{ netSales: number; previous: { netSales: number; change: number | null } }>('reports/summary?from=2026-11-21&to=2026-11-21', shop);
    expect(s.previous.netSales).toBe(10_000);
    expect(s.previous.change).toBe(20);
  });
});

describe('uzakta saklanmayan kıyas dönemi', () => {
  it('325 günlük dönemde kıyas 400 günün dışına taşar: yüzde yok, "uzakta yalnız … sonrası" denir', async () => {
    const { sumSummary, oldestRemoteDay } = await import('../api/uzaktan');
    const today = '2026-11-21';
    const range = { from: '2026-01-01', to: today };
    // Kıyas döneminin yalnız saklanan kısmı (yarım toplam): eskiden %300'ü aşan yanlış artış
    const prev = [day('2025-11-01', [[300, 1_000]])];
    const s = sumSummary(range, [day('2026-05-01', [[300, 21_000]])], prev, at(today, '12:00'), today);
    expect(s.previous).toMatchObject({ change: null, netSales: null, unavailable: true });
    expect(oldestRemoteDay(today)).toBe('2025-10-18');
    // Dönem pencerenin içindeyse kıyas olağan
    const ok = sumSummary({ from: '2026-11-01', to: '2026-11-07' }, [day('2026-11-01', [[300, 2_000]])], [day('2026-10-25', [[300, 1_000]])], at(today, '12:00'), today);
    expect(ok.previous.change).toBe(100);
    expect(ok).not.toHaveProperty('availableFrom');
    // 400 günden eski dönem: sayfa uyarır
    const old = sumSummary({ from: '2025-09-01', to: '2025-09-30' }, [], [], at(today, '12:00'), today);
    expect(old).toMatchObject({ availableFrom: '2025-10-18', previous: { unavailable: true } });
  });
});

describe('ek verinin sınırı', () => {
  const row = (i: number) => ({ id: `r${i}`, at: 1_700_000_000_000 - i, orderNo: i, place: 'Masa 1', name: 'Latte', size: 'M', qty: 1, value: 100, reason: null, compKind: null, person: null, by: 'Ayşe', approvedBy: null, afterSend: false, afterBill: false });
  const extra = (happy: number): RemoteDayExtra => ({
    prep: { done: [], hand: [] },
    checks: [],
    lists: { iptal: [], ikram: [], indirim: [], happy: Array.from({ length: happy }, (_, i) => row(i)) as unknown as RemoteDayExtra['lists']['happy'] },
    odenmez: [],
    refunds: [],
    plat: { rows: [], pending: 0 },
  });

  it('kasa sınırı aşan listeyi kısaltır, düşen satırların sayısı ve tutarı kalır', async () => {
    const { fitExtra } = await import('../server/sync/cloud-reports');
    const big = extra(5000);
    const fit = fitExtra(big, 200 * 1024);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(200 * 1024);
    expect(fit.lists.happy.length + fit.cut!.happy!.count).toBe(5000);
    expect(fit.lists.happy.reduce((a, r) => a + r.value, 0) + fit.cut!.happy!.value).toBe(5000 * 100);
    // Küçük gün olduğu gibi
    expect(fitExtra(extra(10))).not.toHaveProperty('cut');
  });

  it('bulut büyük ek veriyi saklamaz, aynı günün eski listesini siler ve günü yanıtta söyler; uzak toplam kısaltılan satırları sayar', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { gzipSync } = await import('node:zlib');
    const { POST } = await import('../api/uzaktan');
    const shop = 'buyuk';
    const push = async (x: unknown, pushAt: number) => {
      const d = { ...day('2026-11-20', [[300, 1_000]]), at: pushAt, x };
      const body = JSON.stringify({ gz: gzipSync(JSON.stringify({ v: 1, shop, today: '2026-11-20', at: pushAt, days: [d] })).toString('base64') });
      const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/rapor`, { method: 'POST', body, headers: signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/uzaktan/rapor`), body) }));
      return (await res.json()) as { skippedDates: { date: string; why: string }[] };
    };
    expect((await push(extra(3), Date.now() - 1000)).skippedDates).toEqual([]);
    expect(store.has(`lafpos:rapor:${shop}:ek:2026-11-20`)).toBe(true);
    const huge = { ...extra(0), checks: Array.from({ length: 4000 }, (_, i) => ({ id: `c${i}`, no: i, status: 'kapali', type: 'masa', place: 'Masa 1'.repeat(30), openedAt: 1, closedAt: 2, waiter: 'Ayşe', qty: 1, total: 100, methods: ['Nakit'] })) };
    const res = await push(huge, Date.now());
    expect(res.skippedDates).toEqual([{ date: '2026-11-20', why: 'extra' }]);
    expect(store.has(`lafpos:rapor:${shop}:ek:2026-11-20`)).toBe(false);
    // Kasada kısaltılmış liste: toplam ve sayı tam, "kısaltıldı" işareti
    const cut = { ...extra(2), cut: { happy: { count: 8, value: 800 } } };
    await push(cut, Date.now() + 1000);
    const happy = await remote<{ count: number; total: number; truncated?: boolean }>('reports/items?from=2026-11-20&to=2026-11-20&kind=happy', shop);
    expect(happy).toMatchObject({ count: 10, total: 1000, truncated: true });
  });
});

describe('kasa tarafı', () => {
  function payload(platform: PlatformId, placedAt: number): PlatformOrderPayload {
    const lines = [{ externalId: `${platform}-latte`, name: 'Latte', qty: 2, unitPrice: 19000, modifiers: [], note: null }];
    return { platform, simulated: true, externalId: `${platform}-${Math.random()}`, code: 'BAYRAM', placedAt, scheduledFor: null, courier: 'platform', platformCollects: true, paymentLabel: 'Online kart', customer: { name: 'Deniz A.', phone: null, address: null }, note: null, lines, subtotal: 38000, restaurantDiscount: 0, platformDiscount: 0, customerTotal: 38000 };
  }

  it('iş günü açılmamış tarihte süresi dolan platform siparişi uzakta da "kaçan" görünür', async () => {
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
    const { tx } = await import('../server/db/client');
    const { Effects } = await import('../server/lib/effects');
    const service = await import('../server/delivery/service');
    const today = (await h.ok<{ date: string }>('patron', 'GET', '/reports/patron')).date;
    const holiday = addDays(today, -3);
    const when = businessDayStartMs(holiday) + 6 * 3600_000;
    const fx = new Effects();
    tx((t) => service.ingestPlatformOrder(t, fx, payload('yemeksepeti', when), when));
    fx.flush();
    const { buildDayReport, reportTick, resetReportSync } = await import('../server/sync/cloud-reports');
    const rep = buildDayReport(holiday);
    expect(rep).toMatchObject({ n: 0, closed: true });
    resetReportSync();
    await reportTick({ backfill: true });
    const kasa = await h.ok<{ missed: { orders: number; amount: number } }>('patron', 'GET', `/reports/platforms?from=${holiday}&to=${holiday}`);
    expect(kasa.missed).toMatchObject({ orders: 1, amount: 38000 });
    const uzak = await remote<{ missed: { orders: number; amount: number }; netSales: number }>(`reports/platforms?from=${holiday}&to=${holiday}`, 'default');
    expect(uzak.missed).toMatchObject({ orders: 1, amount: 38000 });
    // Satışı olmayan gün Ciro'nun gün sayısına ve gün listesine girmez
    const s = await remote<{ days: number; byDay: unknown[] }>(`reports/summary?from=${holiday}&to=${holiday}`, 'default');
    expect(s).toMatchObject({ days: 0, byDay: [] });
  });

  it('"Yeniden gönder" süren turla çakışınca sıfırlama ezilmez', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: h.boot.paymentMethods.find((m) => m.name === 'Nakit')!.id, amount: o.total });
    const { reportTick, resendReports, resetReportSync } = await import('../server/sync/cloud-reports');
    const { getSyncState } = await import('../server/lib/settings');
    resetReportSync();
    let open!: () => void;
    gate = new Promise<void>((r) => (open = r));
    const running = reportTick({ backfill: true });
    await new Promise((r) => setTimeout(r, 50));
    resendReports();
    open();
    gate = null;
    await running;
    const st = getSyncState<{ sent: Record<string, string>; sweptAt: number }>('cloud.reports')!;
    expect(st.sent).toEqual({});
    expect(st.sweptAt).toBe(0);
  });
});
