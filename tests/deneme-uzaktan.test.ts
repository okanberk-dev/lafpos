import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GECMIS_KEY, type HistoryDay } from '@shared/gecmis';
import type { RemoteDayReport } from '@shared/remote-reports';
import { addDays, businessDate } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { upstashCommand } from './fake-upstash';
import { type Harness, PINS, startApp } from './harness';
import { REDIS_ONEKI } from '@shared/eski-adlar';

/**
 * "Geçişi tamamla" ve "Denemeyi bitir"in sildiği günler AsilPOS Uzaktan'dan da kalkar (KALANLAR §4.5): kasa silinen
 * tarihleri silmeyle aynı işlemde yazar (`cloud.reports.silinen`), sıradaki canlı bakışta o tarihlere boş gün (`n: 0`,
 * ek verisiz) iter; bulut eski deneme raporunun ve ek verisinin üstüne yazar, Uzaktan o günü listeye ve toplamlara
 * katmaz. API değişmez. Gerçek AsilPOS günü kalan ya da geçmiş ciro (ModPOS) günü olan tarih boşaltılmaz. Gidemeyen
 * tarih listede kalır, "Raporları yeniden gönder" listeyi silmez. Daha önce gönderilmiş ama kasada artık hiçbir şeyi
 * olmayan tarih (eski sürümde yapılmış geçiş) tarama ona gelince boşaltılır.
 */
const CLOUD = 'https://deneme-uzak.test';
const SECRET = 'd'.repeat(40);
const PASSWORD = 'deneme-uzak-parola-1';
const NEW_PIN = '482915';
const REMOVED_KEY = 'cloud.reports.silinen';
const store = new Map<string, string>();
/** Buluta giden rapor paketlerinin tarihleri */
const posted: string[][] = [];
let cloudDown = false;
let h: Harness;
let today: string;

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET, merkezUrl: '', lafmaliyetUrl: '' });
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, ASILPOS_UZAKTAN_PAROLA: PASSWORD, ASILPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0' });
  const { gunzipSync } = await import('node:zlib');
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') return new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[]) }));
    if (new URL(url).origin === new URL(CLOUD).origin) {
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      if (path === 'uzaktan/rapor') {
        if (cloudDown) return new Response('{}', { status: 503 });
        const { gz } = JSON.parse(String(init!.body)) as { gz: string };
        posted.push((JSON.parse(gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')) as { days: RemoteDayReport[] }).days.map((d) => d.date));
      }
      const { GET, POST } = await import('../api/uzaktan');
      const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: init?.method ?? 'GET', body: init?.body as string | undefined, headers: init?.headers as Record<string, string> });
      return (init?.method ?? 'GET') === 'POST' ? POST(req) : GET(req);
    }
    return realFetch(input, init);
  });
  const { reportToday } = await import('../server/services/reports');
  today = reportToday();
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

/** Uzaktan'ın Raporlar'ı, kasanın dükkânı (`default`) */
async function remote<T = any>(path: string): Promise<T> {
  const { GET, POST } = await import('../api/uzaktan');
  const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '5.5.5.5' } }))).json()) as { token: string };
  const [p, q = ''] = path.split('?');
  const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${p}${q ? `&${q}` : ''}`, { headers: { authorization: `Bearer ${token}`, 'x-laf-dukkan': 'default' } }));
  expect(res.status).toBe(200);
  return (await res.json()) as T;
}

const dayKey = (date: string) => `${REDIS_ONEKI}rapor:default:gun:${date}`;
const extraKey = (date: string) => `${REDIS_ONEKI}rapor:default:ek:${date}`;
const cloudDay = (date: string) => (store.has(dayKey(date)) ? (JSON.parse(store.get(dayKey(date))!) as RemoteDayReport) : null);

/** Süren tur varsa (ör. "yeniden gönder"in başlattığı) bitmesini bekleyip bir tur */
async function tick(opts: { backfill?: boolean } = {}) {
  const { reportTick } = await import('../server/sync/cloud-reports');
  for (let i = 0; i < 200; i++) {
    const r = await reportTick(opts);
    if (r !== 'busy') return r;
    await new Promise((ok) => setTimeout(ok, 10));
  }
  throw new Error('rapor turu bitmedi');
}

async function removedList() {
  const { getSyncState } = await import('../server/lib/settings');
  return getSyncState<string[]>(REMOVED_KEY) ?? [];
}

/** Bir gün: aç, bir Latte nakit, kapat; sonra tarihi ve deneme işareti yazılır */
async function makeDay(date: string, trainingDay: boolean, as = 'kasa') {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const mudur = as === 'kasa' ? 'mudur' : as;
  await h.ok(as, 'POST', '/cash/day/open', { openingCash: 10000, reason: 'Test: açılış önceki sayımdan farklı' });
  const product = h.boot.products.find((p) => p.name === 'Latte')!;
  const cash = h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
  let o = await h.ok<OrderDTO>(as, 'POST', '/orders', { type: 'tezgah' });
  o = await h.ok<OrderDTO>(as, 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, size: 'M', qty: 1 }] });
  await h.ok(as, 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total, given: o.total });
  const x = await h.ok<{ summary: { expectedCash: number } }>(mudur, 'GET', '/cash/day');
  await h.ok(as, 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
  const day = db.select().from(schema.businessDays).all().find((d) => d.closedAt != null && d.date === businessDate(Date.now()))!;
  db.update(schema.businessDays).set({ trainingDay, date }).where(eq(schema.businessDays.id, day.id)).run();
  return day.id;
}

/** Kasanın ve Uzaktan'ın Ciro'su aynı dönem için */
async function both(from: string, to: string) {
  const path = `reports/summary?from=${from}&to=${to}`;
  const kasa = await h.ok<{ netSales: number; receipts: number; days: number }>('patron', 'GET', `/${path}`);
  const uzak = await remote<{ netSales: number; receipts: number; days: number; byDay: { date: string; kaynak?: string }[] }>(path);
  return { kasa, uzak };
}

describe('Geçişi tamamla: silinen deneme günleri Uzaktan\'dan da kalkar', () => {
  // Tarihler: iki yalnız deneme günü (D2, D3), deneme günüyle aynı tarihte gerçek gün (D4), deneme günü olan geçmiş
  // ciro (ModPOS) tarihi (D5)
  const D = (n: number) => addDays(today, -n);

  it('hazırlık: deneme günleri buluta gider; deneme sessizce kapanır, gerçek gün ve geçmiş ciro günü', async () => {
    const { resetReportSync } = await import('../server/sync/cloud-reports');
    const { setSyncState, updateSettings } = await import('../server/lib/settings');
    for (const n of [2, 3, 4, 5]) await makeDay(D(n), true);
    resetReportSync();
    await tick({ backfill: true });
    for (const n of [2, 3, 4, 5]) {
      expect(cloudDay(D(n)), D(n)).toMatchObject({ n: 1, closed: true });
      expect(cloudDay(D(n))!.s.rev).toBeGreaterThan(0);
      expect(store.has(extraKey(D(n))), D(n)).toBe(true);
    }
    // Eski sürüm: patron PIN'i değişince deneme sessizce kapandı, sonraki gün gerçek kaydedildi
    updateSettings({ demoMode: false });
    await makeDay(D(4), false);
    const hist: HistoryDay = { date: D(5), ciro: 123400, adisyon: 7, closes: [], pay: [['Nakit', 'cash', 123400, 7]], z: 'Z-2026-001' };
    setSyncState(GECMIS_KEY, { at: 1, kaynak: 'ModPOS', gunler: [hist] });
    // Tarama baştan: gerçek gün de gider
    resetReportSync();
    await tick({ backfill: true });
    expect(cloudDay(D(4))).toMatchObject({ n: 2 });
    // Eğitim yazarkasası hâlâ seçili (kasa eğitimde): geçmiş ciro günü deneme gününün yerine henüz geçmez
    expect(cloudDay(D(5))).toMatchObject({ n: 1 });
    expect(cloudDay(D(5))).not.toHaveProperty('kaynak');
    expect(cloudDay(D(2))).toMatchObject({ n: 1 });
  });

  it('geçiş silinen tarihleri aynı işlemde yazar (gerçek günü kalan tarih de: raporu deneme satışsız yenilenir)', async () => {
    const r = await h.ok<{ finalized: boolean; purged: { days: number } }>('patron', 'POST', '/admin/deneme/bitir', { pin: PINS.patron, newPin: NEW_PIN });
    expect(r).toMatchObject({ finalized: true, purged: { days: 4 } });
    // D4'te gerçek gün kaldı (listede, yalnız gerçek günün raporu gider); D5'in geçmiş ciro günü var ama AsilPOS günü
    // kalmadı (listede, raporu geçmiş günüyle gider)
    expect(await removedList()).toEqual([D(5), D(4), D(3), D(2)]);
    const { db, schema } = await import('../server/db/client');
    const audit = db.select().from(schema.auditLog).all().filter((a) => a.action === 'deneme.bitir').at(-1)!;
    expect(audit.data).toMatchObject({ remoteDays: 3 });
  });

  it('bulut gidemezse liste kalır; "Raporları yeniden gönder" listeyi silmez', async () => {
    cloudDown = true;
    try {
      await tick();
      expect(await removedList()).toEqual([D(5), D(4), D(3), D(2)]);
      expect(cloudDay(D(2))).toMatchObject({ n: 1 });
      const { resendReports } = await import('../server/sync/cloud-reports');
      resendReports();
      await tick({ backfill: true });
      expect(await removedList()).toEqual([D(5), D(4), D(3), D(2)]);
      expect(cloudDay(D(4))).toMatchObject({ n: 2 });
    } finally {
      cloudDown = false;
    }
  });

  it('sıradaki canlı bakış silinen günleri boşaltır, gerçek günü kalan tarihi deneme satışsız yeniler', async () => {
    // Tarama beklenmez: yalnız canlı bakış
    await tick();
    expect(await removedList()).toEqual([]);
    for (const n of [2, 3]) {
      expect(cloudDay(D(n)), D(n)).toMatchObject({ n: 0, closed: true, z: [], s: { rev: 0, receipts: 0 }, prod: [], staff: [] });
      // Ek veri (adisyonlar, iptal, ikram listeleri) de silindi
      expect(store.has(extraKey(D(n))), D(n)).toBe(false);
    }
    // Gerçek gün boşalmaz: yalnız gerçek günün raporu; geçmiş ciro günü yerinde
    expect(cloudDay(D(4))).toMatchObject({ n: 1 });
    expect(store.has(extraKey(D(4)))).toBe(true);
    expect(cloudDay(D(5))).toMatchObject({ kaynak: 'ModPOS', s: { rev: 123400 } });
    // Uzaktan'ın Ciro'su kasanınkiyle aynı; silinen günler gün listesinde ve toplamlarda yok
    const { kasa, uzak } = await both(D(5), D(2));
    expect(uzak.netSales).toBe(kasa.netSales);
    expect(uzak.receipts).toBe(kasa.receipts);
    expect(uzak.days).toBe(2);
    expect(uzak.byDay.map((d) => d.date)).toEqual([D(5), D(4)]);
  });

  it('ikinci tur hiçbir şey göndermez', async () => {
    const { reportSyncState } = await import('../server/sync/cloud-reports');
    // "Yeniden gönder"in taraması bitsin
    for (let i = 0; i < 80 && reportSyncState().backfilling; i++) await tick({ backfill: true });
    posted.length = 0;
    await tick();
    await tick({ backfill: true });
    expect(posted).toEqual([]);
  });

  it('eski sürümde silinmiş gün: daha önce gönderilmiş, kasada hiçbir şeyi kalmamış tarih taramada boşalır', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const id = await makeDay(D(6), false, 'patron');
    const { resetReportSync } = await import('../server/sync/cloud-reports');
    resetReportSync();
    await tick({ backfill: true });
    expect(cloudDay(D(6))).toMatchObject({ n: 1 });
    // Listeye yazılmadan kalktı (eski sürümün geçişi): gün bulutun saklamadığı eski bir tarihe taşınır
    db.update(schema.businessDays).set({ date: '2020-01-01' }).where(eq(schema.businessDays.id, id)).run();
    expect(await removedList()).toEqual([]);
    // Günlük tarama yeniden başlar
    setSyncState('cloud.reports', { ...getSyncState<Record<string, unknown>>('cloud.reports'), cursor: null, sweptAt: 0 });
    await tick({ backfill: true });
    expect(cloudDay(D(6))).toMatchObject({ n: 0, s: { rev: 0 } });
    expect(store.has(extraKey(D(6)))).toBe(false);
    // Gerçek gün ve geçmiş ciro günü yine boşalmaz
    expect(cloudDay(D(4))).toMatchObject({ n: 1 });
    expect(cloudDay(D(5))).toMatchObject({ kaynak: 'ModPOS' });
  });
});
