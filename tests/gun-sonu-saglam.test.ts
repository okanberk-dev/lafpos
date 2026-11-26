import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { istanbulParts } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { pavoTiming } from '../server/okc/providers/pavo';
import { type FakePavo, startFakePavo } from './fake-pavo';
import { type Harness, startApp } from './harness';

/**
 * Gün sonu zinciri sessiz kalmaz (26 Kasım 2026; 25 Kasım teşhisinde bulunan iki açık):
 *
 * 1. Gün kapandıktan sonra lafmaliyet gövdesi kurulamazsa (`buildDayPayload` atar) kapanış yine 200 döner, gün kapalı
 *    kalır; Pavo'nun banka gün sonu ve kasa farkı bildirimi yine çalışır; denetim kaydına alarm yazılır ve patrona
 *    bildirim (`lafmaliyet`) gider. Otomatik gün sonunda da (zamanlayıcıda hata süreci düşürmez).
 * 2. lafmaliyet günü kalıcı reddederse (400/409/413/422; kayıt park edilir) patrona bir kez bildirim gider: gün, neden ve
 *    "Kasa › Geçmiş günler › Z › Gönder". Aynı gün ve neden için yeniden gitmez; gün ulaşınca unutulur.
 *
 * Gövde, günün Pavo kaydı bozuk yazılarak attırılır (`acquirers` dizi değil): cihazın gün sonu yeni kaydı yazınca gövde
 * yine kurulur, gün lafmaliyet'e gider.
 */

const CLOUD = 'https://saglam.test';
const RESEND = 'Kasa › Geçmiş günler › Z › Gönder';
let h: Harness;
let device: FakePavo;
let server: Server;
const posts: Record<string, unknown>[] = [];
/** Sahte lafmaliyet'in yanıtı (gövdeye göre) */
let reply: (body: Record<string, unknown>) => { status: number; json: unknown } = (body) => ({ status: 200, json: { ok: true, date: body.date, lines: 0, matched: 0, unmatched: [], counted: true } });
/** Siteye (LafPOS Uzaktan) giden telefon bildirimleri */
const notices: { kind: string; title: string; body: string }[] = [];

beforeAll(async () => {
  pavoTiming.askEveryMs = 0;
  pavoTiming.failConfirmMs = 0;
  pavoTiming.eodMs = 1_000;
  pavoTiming.eodCopyMs = 1_000;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      if (req.url === '/api/pos/gun') posts.push(body);
      const r = reply(body);
      res.writeHead(r.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  device = await startFakePavo();
  h = await startApp({
    PAVO_URL: device.url,
    PAVO_SERIAL: device.serial,
    PAVO_FINGERPRINT: 'LafPOS-test',
    LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    LAFMALIYET_SYNC_SECRET: 's'.repeat(48),
  });
  // Uzaktan kurulu: bildirim siteye gider (gövdesi yakalanır)
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: 'c'.repeat(40) });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith(CLOUD)) {
      if (new URL(url).pathname === '/api/uzaktan/bildirim') notices.push(JSON.parse(String(init!.body)) as (typeof notices)[number]);
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input, init);
  });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, liveSince: Date.now() - 86400_000 });
  const { setNotifySettings } = await import('../server/sync/bildirim');
  // Her kasa farkı bildirilir (sayımsız satış ₺100'den az olabilir)
  setNotifySettings({ cashDiffMin: 1 });
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
  await h.ok('patron', 'POST', '/okc/pair');
}, 60_000);

afterAll(async () => {
  vi.unstubAllGlobals();
  server.close();
  await device.close();
  h.cleanup();
});

type Day = { id: string; date: string; zNo: number; closedAt: number | null };
type Audit = { action: string; severity: string; message: string; entityId: string | null; data: Record<string, unknown> | null };

async function mods() {
  const { db, schema } = await import('../server/db/client');
  const { eq, desc } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const lm = await import('../server/sync/lafmaliyet');
  return { db, schema, eq, desc, settings, lm };
}

let past = 0;

/** Yeni iş günü (bir tarihe tek Z: kapanmış günler geçmiş tarihe alınır), bir nakit satış; açık günün kimliği */
async function openWithSale(): Promise<string> {
  const m = await mods();
  for (const d of m.db.select().from(m.schema.businessDays).all()) {
    if (!d.closedAt || d.date.startsWith('2020-')) continue;
    const to = `2020-03-${String(++past).padStart(2, '0')}`;
    m.db.update(m.schema.businessDays).set({ date: to }).where(m.eq(m.schema.businessDays.id, d.id)).run();
    m.db.update(m.schema.outbox).set({ dedupeKey: `gun:${to}` }).where(m.eq(m.schema.outbox.dedupeKey, `gun:${d.date}`)).run();
  }
  posts.length = 0;
  notices.length = 0;
  const day = await h.ok<Day>('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  const filled = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Türk Kahvesi')!.id, qty: 1 }] });
  await h.ok('kasa', 'POST', `/orders/${filled.id}/payments`, { methodId: h.boot.paymentMethods.find((x) => x.kind === 'nakit')!.id, amount: filled.total - filled.paid });
  return day.id;
}

/** Günün Pavo kaydı bozuk: gövde kurulurken atar (`acquirers.map`), otomatik banka gün sonunu engellemez */
async function breakPayload(dayId: string) {
  const m = await mods();
  m.settings.setSyncState(`pavo.eod.${dayId}`, { status: 'failed', at: Date.now(), batchNo: null, grandTotalKurus: null, dayCardKurus: null, message: 'bozuk', acquirers: null, trigger: 'elle', dayClosed: false });
  expect(() => m.lm.buildDayPayload(dayId)).toThrow();
}

async function audits(action: string): Promise<Audit[]> {
  const m = await mods();
  return m.db.select().from(m.schema.auditLog).where(m.eq(m.schema.auditLog.action, action)).all() as unknown as Audit[];
}

async function until<T>(read: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms = 8_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} olmadı`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const settle = () => new Promise((r) => setTimeout(r, 50));
const eodRequests = () => device.requests.filter((r) => r.path === '/PerformEOD').length;

describe('gün sonu: lafmaliyet gövdesi kurulamazsa', () => {
  it('kapanış 200 döner, gün kapalı; Pavo gün sonu ve kasa farkı bildirimi yine çalışır; alarm ve patrona bildirim', async () => {
    const dayId = await openWithSale();
    await breakPayload(dayId);
    const eodBefore = eodRequests();
    const failedBefore = (await audits('sync.lafmaliyet_failed')).length;
    const res = await h.call<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(res.status).toBe(200);
    const day = res.json.day;
    expect(day.closedAt).not.toBeNull();
    // Giden kutusuna bir şey girmedi; denetim kaydında alarm, nedeni ve yeniden gönderme yolu
    const alarms = (await audits('sync.lafmaliyet_failed')).slice(failedBefore);
    expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatchObject({ severity: 'alarm', entityId: dayId });
    expect(alarms[0]!.message).toContain(`Z ${day.zNo}`);
    expect(alarms[0]!.message).toContain(RESEND);
    // Patrona: lafmaliyet bildirimi ve kasa farkı (afterDayClose çalıştı)
    const lm = await until(() => notices.find((n) => n.kind === 'lafmaliyet'), 'lafmaliyet bildirimi');
    expect(lm.title).toBe(`Gün sonu lafmaliyet'e gitmedi (Z ${day.zNo})`);
    expect(lm.body).toContain(RESEND);
    expect(lm.body.length).toBeLessThanOrEqual(240);
    await until(() => notices.find((n) => n.kind === 'kasa-farki'), 'kasa farkı bildirimi');
    // Pavo'nun banka gün sonu başladı; yeni kaydı gövdeyi yine kurulur kılar, gün lafmaliyet'e gider
    await until(() => eodRequests() > eodBefore, 'Pavo gün sonu');
    const sent = await until(() => posts.find((p) => p.date === day.date), 'gün sonu gövdesi');
    expect(sent.bankPos).toMatchObject({ status: 'ok' });
    // Alarm bir kez
    await settle();
    expect(notices.filter((n) => n.kind === 'lafmaliyet')).toHaveLength(1);
  });

  it('otomatik gün sonunda da: kapanış atmaz, Pavo gün sonu başlar, alarm yazılır', async () => {
    const dayId = await openWithSale();
    await breakPayload(dayId);
    const m = await mods();
    const { autoDayEndTick } = await import('../server/jobs');
    // Saatin 5. dakikası, gün 4 saat önce açılmış: otomatik gün sonu bu turda
    const p = istanbulParts(Date.now());
    const now = Date.now() + (5 - p.minute) * 60_000;
    m.settings.updateSettings({ autoDayEnd: true, autoDayEndHour: p.hour });
    m.db.update(m.schema.businessDays).set({ openedAt: now - 4 * 3600_000 }).where(m.eq(m.schema.businessDays.id, dayId)).run();
    const eodBefore = eodRequests();
    const failedBefore = (await audits('sync.lafmaliyet_failed')).length;
    try {
      expect(() => autoDayEndTick(now)).not.toThrow();
    } finally {
      m.settings.updateSettings({ autoDayEnd: false });
    }
    const day = m.db.select().from(m.schema.businessDays).where(m.eq(m.schema.businessDays.id, dayId)).get()!;
    expect(day.closedAt).not.toBeNull();
    expect((await audits('sync.lafmaliyet_failed')).slice(failedBefore)).toMatchObject([{ severity: 'alarm', entityId: dayId }]);
    await until(() => notices.find((n) => n.kind === 'lafmaliyet'), 'lafmaliyet bildirimi');
    await until(() => eodRequests() > eodBefore, 'Pavo gün sonu');
    await until(() => posts.find((x) => x.date === day.date), 'gün sonu gövdesi');
  });
});

describe('lafmaliyet kalıcı reddederse', () => {
  it('patrona bir kez bildirim: gün, neden ve yol; aynı neden yeniden gitmez, başka neden ve ulaştıktan sonraki ret gider', async () => {
    const m = await mods();
    // Pavo yok: tek gövde, hemen gider
    m.settings.updateSettings({ okcProvider: 'kapali' });
    try {
      await openWithSale();
      reply = (body) => ({ status: 409, json: { error: 'z_conflict', date: body.date, zNo: 7 } });
      const rejectedBefore = (await audits('sync.lafmaliyet_rejected')).length;
      const day = (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
      const first = await until(() => notices.find((n) => n.kind === 'lafmaliyet'), 'ret bildirimi');
      expect(first.title).toBe(`lafmaliyet gün sonunu reddetti (Z ${day.zNo})`);
      expect(first.body).toContain("lafmaliyet'te bu güne Z 7 kayıtlı");
      expect(first.body).toContain(RESEND);
      expect(first.body.length).toBeLessThanOrEqual(240);
      // Kayıt park edildi; denetim kaydında tam metin
      const row = m.db.select().from(m.schema.outbox).where(m.eq(m.schema.outbox.dedupeKey, `gun:${day.date}`)).orderBy(m.desc(m.schema.outbox.id)).get()!;
      expect(row.sentAt).toBeNull();
      expect(row.nextAttemptAt - Date.now()).toBeGreaterThan(300 * 86400_000);
      const audit = (await audits('sync.lafmaliyet_rejected')).slice(rejectedBefore);
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ severity: 'alarm', entityId: day.id });
      expect(audit[0]!.message).toContain(row.lastError!);

      // Elle "Gönder", aynı neden: ekranda hata, patrona yeni bildirim ve yeni alarm yok
      const again = await h.call('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`);
      expect(again.status).toBe(502);
      await settle();
      expect(notices.filter((n) => n.kind === 'lafmaliyet')).toHaveLength(1);
      expect((await audits('sync.lafmaliyet_rejected')).slice(rejectedBefore)).toHaveLength(1);

      // Başka neden (sürüm farkı): yeni bildirim
      reply = () => ({ status: 400, json: { error: 'invalid', field: 'lines.3.qty' } });
      expect((await h.call('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`)).status).toBe(502);
      const second = await until(() => notices.filter((n) => n.kind === 'lafmaliyet')[1], 'ikinci ret bildirimi');
      expect(second.body).toContain('HTTP 400, invalid: lines.3.qty');
      expect(second.body).toContain(RESEND);

      // Gün ulaştı: anahtarlar unutulur; sonra aynı nedenle yeniden reddedilirse yine haber verilir
      reply = (body) => ({ status: 200, json: { ok: true, date: body.date } });
      await h.ok('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`);
      reply = (body) => ({ status: 409, json: { error: 'z_conflict', date: body.date, zNo: 7 } });
      expect((await h.call('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`)).status).toBe(502);
      await until(() => notices.filter((n) => n.kind === 'lafmaliyet')[2], 'ulaştıktan sonraki ret bildirimi');
    } finally {
      reply = (body) => ({ status: 200, json: { ok: true, date: body.date, lines: 0, matched: 0, unmatched: [], counted: true } });
      m.settings.updateSettings({ okcProvider: 'pavo' });
    }
  });

  it('bildirim metni kısa kalır (site 240 karakterde keser): yol sonda kesilmez', async () => {
    const { pushRejectNotice } = (await mods()).lm;
    const payload = { date: '2026-11-25', z: { zNo: 1234 } };
    const long = 'x'.repeat(200);
    const cases = [
      pushRejectNotice(409, { error: 'wrong_branch', sube: long, expected: long }, payload),
      pushRejectNotice(409, { error: 'z_conflict', zNo: 123456 }, payload),
      pushRejectNotice(422, { error: long, field: long }, payload),
      pushRejectNotice(413, null, payload),
    ];
    for (const n of cases) {
      expect(n.title.length).toBeLessThanOrEqual(80);
      expect(n.body.length).toBeLessThanOrEqual(240);
      expect(n.body.startsWith('25 Kas Çar: ')).toBe(true);
      expect(n.body.endsWith(`${RESEND} ile yeniden gönderin`)).toBe(true);
    }
    expect(cases[0]!.body).toContain('Şube kimliğini');
  });

  it('site yeni türü (lafmaliyet) kabul eder', async () => {
    const { bildirim } = await import('../api/_bildirim');
    const deps = { redis: async () => null, admin: async () => false, signed: () => true };
    const post = (kind: string) => bildirim(new Request(`${CLOUD}/api/uzaktan`, { method: 'POST', body: JSON.stringify({ kind, title: 't', body: 'b', at: Date.now() }) }), 'uzaktan/bildirim', deps);
    expect((await post('lafmaliyet')).status).toBe(200);
    expect((await post('bilinmeyen')).status).toBe(400);
  });
});
