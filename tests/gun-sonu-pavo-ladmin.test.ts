import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { pavoTiming } from '../server/okc/providers/pavo';
import { type FakePavo, startFakePavo } from './fake-pavo';
import { type Harness, startApp } from './harness';

/**
 * Gün sonu, Pavo'nun banka gün sonu ve lafmaliyet (25 Kasım 2026: Marina'nın gün sonu e-postası gitmedi). lafmaliyet gün
 * sonu e-postasını Pavo'nun sonucunu taşıyan gövdeyle tek seferde gönderir; ikinci gövde gelmezse bekler. Bu yüzden:
 *
 * - Otomatik banka gün sonu başlayacaksa ilk gövde tutulur (EOD_FIRST_PUSH_HOLD_MS) ve `bankPosPending: true` taşır.
 * - Gün sonu bitince (alındı ya da alınamadı) gün sonucuyla HEMEN gider (dakikalık işi beklemez), tutulanın yerine.
 * - Otomatik deneme atlanırsa (ör. cihaz meşgul) gün yine hemen gider, `bankPosPending: false`: lafmaliyet beklemez.
 * - Pavo'nun otomatik gün sonu kapalıysa gövde hiç tutulmaz, `bankPosPending: false`.
 */

let h: Harness;
let device: FakePavo;
let server: Server;
const posts: Record<string, unknown>[] = [];

beforeAll(async () => {
  pavoTiming.askEveryMs = 0;
  pavoTiming.failConfirmMs = 0;
  pavoTiming.eodMs = 1_000;
  pavoTiming.eodCopyMs = 1_000;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      if (req.url === '/api/pos/gun' && body) posts.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, date: body?.date, lines: 0, matched: 0, unmatched: [], counted: true, switchDay: '2026-11-01' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  device = await startFakePavo();
  h = await startApp({
    PAVO_URL: device.url,
    PAVO_SERIAL: device.serial,
    PAVO_FINGERPRINT: 'LafPOS-test',
    LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
    LAFMALIYET_SYNC_SECRET: 'p'.repeat(48),
  });
  const { updateSettings } = await import('../server/lib/settings');
  // Gerçek kullanım: gün gerçek gündür (lafmaliyet'e gider), cihazda banka gün sonu alınır
  updateSettings({ demoMode: false, liveSince: Date.now() - 86400_000 });
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'pavo' });
  await h.ok('patron', 'POST', '/okc/pair');
  expect((await h.ok<{ pavo: { paired: boolean } }>('patron', 'GET', '/okc/status')).pavo.paired).toBe(true);
}, 60_000);

afterAll(async () => {
  server.close();
  await device.close();
  h.cleanup();
});

type Day = { id: string; date: string; closedAt: number | null; zNo: number };
type Outbox = { dedupeKey: string; nextAttemptAt: number; sentAt: number | null; payload: Record<string, unknown> };

async function mods() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const lm = await import('../server/sync/lafmaliyet');
  return { db, schema, eq, settings, lm };
}

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const cash = () => h.boot.paymentMethods.find((m) => m.kind === 'nakit')!;
let past = 0;

/**
 * Önceki testin arka plan işleri (Pavo gün sonu, onun yeniden kuyruğa koyduğu gün, yoldaki gönderim) bitene dek beklenir:
 * her gün bugünün tarihiyle açıldığı için geç gelen bir gövde sonraki testin gövdesine karışırdı
 */
async function settle(): Promise<void> {
  const m = await mods();
  await until(async () => {
    const busy = m.db
      .select()
      .from(m.schema.outbox)
      .all()
      .filter((r) => r.target === 'lafmaliyet' && r.sentAt === null && r.nextAttemptAt <= Date.now() + 1_000);
    const running = m.db
      .select()
      .from(m.schema.syncState)
      .all()
      .some((r) => r.key.startsWith('pavo.eod.') && JSON.stringify(r.value).includes('"running"'));
    return !busy.length && !running;
  }, 'önceki testin arka plan işleri', 10_000);
  await new Promise((r) => setTimeout(r, 100));
}

/** Yeni iş günü (bir tarihe tek Z: kapanmış günler ve giden kutusu geçmiş tarihe alınır), bir nakit satış */
async function openWithSale(): Promise<void> {
  await settle();
  const m = await mods();
  for (const d of m.db.select().from(m.schema.businessDays).all()) {
    if (!d.closedAt || d.date.startsWith('2020-')) continue;
    const to = `2020-02-${String(++past).padStart(2, '0')}`;
    m.db.update(m.schema.businessDays).set({ date: to }).where(m.eq(m.schema.businessDays.id, d.id)).run();
    // Gövdenin tarihi de taşınır: önceki testten kalan bir yeniden deneme bugünün tarihiyle gidip bu testin gövdesi sanılmasın
    for (const r of m.db.select().from(m.schema.outbox).where(m.eq(m.schema.outbox.dedupeKey, `gun:${d.date}`)).all()) {
      const payload = { ...(r.payload as Record<string, unknown>), date: to };
      m.db.update(m.schema.outbox).set({ dedupeKey: `gun:${to}`, payload }).where(m.eq(m.schema.outbox.id, r.id)).run();
    }
  }
  // Her gün bugünün tarihiyle açılır: önceki günlerin gövdeleri aynı tarihli, sayılmaz
  posts.length = 0;
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  const filled = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
  await h.ok('kasa', 'POST', `/orders/${filled.id}/payments`, { methodId: cash().id, amount: filled.total - filled.paid });
}

async function outboxOf(date: string): Promise<Outbox[]> {
  const m = await mods();
  return m.db.select().from(m.schema.outbox).where(m.eq(m.schema.outbox.dedupeKey, `gun:${date}`)).all() as unknown as Outbox[];
}

async function until<T>(read: () => Promise<T | null | undefined | false>, what: string, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await read();
    if (v) return v;
    if (Date.now() > end) throw new Error(`${what} olmadı`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Bu günün gövdeleri: aynı tarihli önceki günlerinkinden Z no'suyla ayrılır */
const postsFor = (day: Pick<Day, 'date' | 'zNo'>) => posts.filter((p) => p.date === day.date && (p.z as { zNo?: number } | undefined)?.zNo === day.zNo);

describe('gün sonu: Pavo beklenirken lafmaliyet gövdesi', () => {
  it('otomatik banka gün sonu başlayacaksa ilk gövde tutulur (bankPosPending: true); gün sonu bitince sonuçla hemen gider, tek gövde', async () => {
    await openWithSale();
    device.eodDelayMs = 400;
    const t0 = Date.now();
    const day = (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
    try {
      // Kapanışta: gövde kuyrukta ama tutuluyor, Pavo'yu bekliyor
      const [held] = await outboxOf(day.date);
      expect(held!.sentAt).toBeNull();
      expect(held!.nextAttemptAt).toBeGreaterThanOrEqual(t0 + (await mods()).lm.EOD_FIRST_PUSH_HOLD_MS - 1_000);
      expect(held!.payload).toMatchObject({ bankPosPending: true });
      expect(held!.payload.bankPos).toBeUndefined();
      expect(postsFor(day)).toEqual([]);
      // Gün sonu bitince: sonuçla hemen gider (dakikalık iş beklenmez), tek gövde
      const sent = await until(async () => postsFor(day)[0], 'sonuçlu gövde');
      expect(sent.bankPos).toMatchObject({ status: 'ok' });
      expect(sent.bankPosPending).toBeUndefined();
      await new Promise((r) => setTimeout(r, 100));
      expect(postsFor(day)).toHaveLength(1);
      const rows = await outboxOf(day.date);
      expect(rows.filter((r) => r.sentAt === null)).toEqual([]);
    } finally {
      device.eodDelayMs = 0;
    }
  });

  it('otomatik deneme atlanırsa tutulan gövdenin yerine gün hemen gider, bankPosPending: false (lafmaliyet beklemez)', async () => {
    await openWithSale();
    const m = await mods();
    const { deviceEndOfDay } = await import('../server/okc/service');
    m.settings.updateSettings({ okcPavoAutoEod: false });
    try {
      const day = (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
      await until(async () => postsFor(day)[0], 'kapanış gövdesi');
      // Kapanışın kendi denemesi (ayar kapalı: atlandı) kaydedilip gönderilene dek beklenir
      await until(async () => m.settings.getSyncState(`pavo.eod.${day.id}`) && postsFor(day).length >= 2, 'kapanışın atlanan denemesi');
      await settle();
      posts.length = 0;
      // Kapanışta Pavo bekleniyordu (gövde tutuldu), sonra otomatik deneme atlandı (ör. cihaz meşgul ya da ayar kapandı)
      m.db.delete(m.schema.syncState).where(m.eq(m.schema.syncState.key, `pavo.eod.${day.id}`)).run();
      m.lm.enqueueDay(day.id, { eodAtClose: true, holdMs: m.lm.EOD_FIRST_PUSH_HOLD_MS });
      // Tutulan kayıt: ileri tarihli (yoldaki ya da az önce gönderilen kayıtla karışmaz)
      const held = (await outboxOf(day.date)).find((r) => r.sentAt === null && r.nextAttemptAt > Date.now() + 60_000);
      expect(held?.payload).toMatchObject({ bankPosPending: true });
      const rec = await deviceEndOfDay(day.id, null);
      expect(rec).toMatchObject({ status: 'skipped', errorCode: 'okc_eod_off' });
      const sent = await until(async () => postsFor(day)[0], 'atlanınca gövde');
      expect(sent.bankPosPending).toBe(false);
      expect(sent.bankPos).toBeUndefined();
      expect((await outboxOf(day.date)).filter((r) => r.sentAt === null)).toEqual([]);
    } finally {
      m.settings.updateSettings({ okcPavoAutoEod: true });
    }
  });

  it("Pavo'nun otomatik gün sonu kapalıysa gövde tutulmaz ve hemen gider (bankPosPending: false)", async () => {
    await openWithSale();
    const m = await mods();
    m.settings.updateSettings({ okcPavoAutoEod: false });
    try {
      const day = (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
      const sent = await until(async () => postsFor(day)[0], 'gövde');
      expect(sent.bankPosPending).toBe(false);
    } finally {
      m.settings.updateSettings({ okcPavoAutoEod: true });
    }
  });

  it('Pavo seçili değilse alan hiç gitmez (sözleşmenin eski hâli)', async () => {
    const m = await mods();
    m.settings.updateSettings({ okcProvider: 'kapali' });
    try {
      await openWithSale();
      const day = (await h.ok<{ day: Day }>('kasa', 'POST', '/cash/day/close', { countedCash: null })).day;
      const sent = await until(async () => postsFor(day)[0], 'gövde');
      expect('bankPosPending' in sent).toBe(false);
    } finally {
      m.settings.updateSettings({ okcProvider: 'pavo' });
    }
  });
});
