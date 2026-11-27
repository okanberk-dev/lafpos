import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import { answerText, pushToast, staleCostsText, unmatchedCount, unmatchedText } from '../src/lib/lafmaliyet';
import { type Harness, startApp } from './harness';

/**
 * lafmaliyet'e geçiş istemcisi (plan L2, docs/03-ENTEGRASYON.md §4): kurulum modunda kapanan gün (eğitim günü) kurulum
 * modu kapansa da hiç gitmez, geçmiş günler bir kez kuyruğa girer, 200 yanıtının alanları (`counted`, `switchDay`, `matched`, `unmatched`) saklanır, "Gönder" kendi
 * gününün sonucunu okur, maliyet gövdesi doğrulanır (0 = bilinmiyor, bozuk gövde haritayı korur) ve günde bir
 * kendiliğinden çekilir; maliyetin tarihi yalnız maliyet yetkisine gider.
 */

interface Reply {
  status: number;
  body: unknown;
}

let h: Harness;
let lafmaliyet: Server;
const calls: { method: string; path: string; body: { date?: string; z?: { zNo?: number } } | null }[] = [];
/** Sırayla kullanılacak gün sonu yanıtları; boşsa `dayReply` */
const dayReplies: Reply[] = [];
let dayReply = (date: string): Reply => ({ status: 200, body: { ok: true, date, lines: 3, matched: 2, unmatched: ['PUMPKIN CHAI LATTE'], counted: false, switchDay: null } });
let costsReply: Reply = { status: 200, body: { version: 1, now: new Date().toISOString(), items: [] } };

const today = businessDate(Date.now());
const day = (n: number) => addDays(today, -n);

beforeAll(async () => {
  // Sahte lafmaliyet: iki uç, istenen yanıtla; gelen istekler kaydedilir
  lafmaliyet = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const path = new URL(req.url ?? '/', 'http://x').pathname;
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? '', path, body });
      const reply = path === '/api/pos/gun' ? (dayReplies.shift() ?? dayReply(body?.date ?? '')) : path === '/api/panel/pos/urunler' ? costsReply : { status: 404, body: { error: 'not_found' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => lafmaliyet.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(lafmaliyet.address() as AddressInfo).port}`, LAFMALIYET_SYNC_SECRET: 'm'.repeat(48) });
});

afterAll(() => {
  lafmaliyet.close();
  h.cleanup();
});

const posts = (date?: string) => calls.filter((c) => c.method === 'POST' && c.path === '/api/pos/gun' && (!date || c.body?.date === date));
const costGets = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/panel/pos/urunler').length;

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const lm = await import('../server/sync/lafmaliyet');
  const { updateSettings, setSyncState } = await import('../server/lib/settings');
  const { ulid } = await import('../server/lib/ids');
  /** Gün sonu alınmış (ya da açık) bir geçmiş gün; satışsız. Varsayılan: kurulum modu dışında kapanmış gerçek gün */
  const insertDay = (date: string, zNo: number, o: { closed?: boolean; exportedAt?: number; training?: boolean | null } = {}) => {
    const id = ulid();
    const at = Date.now() - 3600_000;
    const closed = o.closed !== false;
    db.insert(schema.businessDays)
      .values({ id, date, zNo, openedAt: at, openingCash: 0, closedAt: closed ? at + 60_000 : null, exportedAt: o.exportedAt ?? null, trainingDay: closed ? (o.training === undefined ? false : o.training) : null })
      .run();
    return id;
  };
  const dayRow = (id: string) => db.select().from(schema.businessDays).where(eq(schema.businessDays.id, id)).get()!;
  const outbox = () => db.select().from(schema.outbox).all().filter((r) => r.target === 'lafmaliyet');
  const drain = async () => {
    for (let i = 0; i < 10 && outbox().some((r) => !r.sentAt && r.nextAttemptAt <= Date.now()); i++) await lm.flushOutbox();
  };
  return { db, schema, eq, lm, updateSettings, setSyncState, insertDay, dayRow, outbox, drain };
}

interface Status {
  configured: boolean;
  training: boolean;
  pending: number;
  failing: number;
  answer: { date: string; counted?: boolean; switchDay?: string | null; matched?: number; unmatched?: string[] } | null;
  backfill: { from: string | null; to: string; unsent: number | null };
  costsAt?: number | null;
  costsError?: { message: string } | null;
  autoPush?: unknown;
}
const status = async () => (await h.ok<{ lafmaliyet: Status }>('patron', 'GET', '/sync/status')).lafmaliyet;

describe('lafmaliyet geçişi', () => {
  it('kurulum modunda gün kuyruğa girmez, elle ve geçmiş günlerle de gönderilmez; maliyet çekilir', async () => {
    const { outbox, insertDay, lm, dayRow } = await mod();
    // Kurulum verisi kurulum modunda başlar (örnek PIN'ler, yazarkasa simülatörü)
    expect(await status()).toMatchObject({ configured: true, training: true });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const x = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closed = await h.ok<{ day: { id: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
    // Gün sonu: gün kuyruğa girmez; maliyetler hiç çekilmediği için bir kez çekilir (yazmayan imzalı GET)
    await vi.waitFor(() => expect(costGets()).toBe(1), { timeout: 5000, interval: 25 });
    expect(outbox()).toEqual([]);
    expect(posts()).toEqual([]);
    // Gün eğitim günü olarak işaretlenir
    expect(dayRow(closed.day.id).trainingDay).toBe(true);
    expect((await h.ok<{ day: { trainingDay: boolean } }>('patron', 'GET', `/cash/days/${closed.day.id}`)).day.trainingDay).toBe(true);

    const push = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/lafmaliyet/gun/${closed.day.id}/push`);
    expect(push.status).toBe(409);
    expect(push.json.code).toBe('training_mode');
    expect(push.json.error).toMatch(/Kurulum modunda/);
    insertDay(day(70), 1, { training: true });
    const back = await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(70), to: day(1) });
    expect(back.status).toBe(409);
    expect(back.json.code).toBe('training_mode');
    expect(lm.enqueueDay(closed.day.id)).toBeNull();
    expect(outbox()).toEqual([]);

    // Yalnız simülatör de kurulum modu sayılır
    const { updateSettings } = await mod();
    updateSettings({ demoMode: false });
    expect((await status()).training).toBe(true);
    updateSettings({ okcProvider: 'kapali' });
    expect((await status()).training).toBe(false);
  });

  it('kurulum modunda kapanan gün, kurulum modu kapandıktan sonra da gitmez: geçmiş günler, Gönder, yeniden sayım', async () => {
    const { outbox, insertDay, lm, db, schema } = await mod();
    expect((await status()).training).toBe(false);
    const training = db.select().from(schema.businessDays).all().find((d) => d.date === today && d.closedAt)!;
    expect(training.trainingDay).toBe(true);
    // İşaretten önce kapanan gün (AsilPOS o zaman canlıda değildi) de eğitim günü sayılır
    const legacy = insertDay(day(65), 90, { training: null });

    const back = await h.ok<{ queued: number; days: string[]; training: number }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(70), to: today });
    expect(back).toEqual({ queued: 0, days: [], training: 3 });
    const push = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/lafmaliyet/gun/${training.id}/push`);
    expect(push.status).toBe(409);
    expect(push.json.code).toBe('training_day');
    expect(push.json.error).toMatch(/kurulum modunda kapandı/);
    const old = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/lafmaliyet/gun/${legacy}/push`);
    expect(old.json.code).toBe('training_day');
    expect(old.json.error).toMatch(/işareti tutulmadan önce kapandı/);
    // Yeniden sayım günü kuyruğa koymaz
    await h.ok('mudur', 'POST', `/cash/days/${training.id}/count`, { countedCash: training.expectedCash ?? 0 });
    expect(lm.enqueueDay(training.id)).toBeNull();
    expect(lm.unsentClosedDays(day(70), today)).toEqual([]);
    await lm.flushOutbox();
    expect(outbox()).toEqual([]);
    expect(posts()).toEqual([]);
  });

  it('geçmiş günler: aralıktaki gönderilmemiş kapanmış günler bir kez kuyruğa girer, gidince işaretlenir', async () => {
    const { insertDay, dayRow, outbox, drain } = await mod();
    // Geçiş günü henüz bilinmiyor (lafmaliyet'ten yanıt gelmedi): varsayılan başlangıç yok
    expect((await status()).backfill).toEqual({ from: null, to: day(1), unsent: null });

    const b1 = insertDay(day(60), 2);
    const b2 = insertDay(day(59), 3);
    const open = insertDay(day(58), 4, { closed: false });
    const done = insertDay(day(57), 5, { exportedAt: 1 });
    const b5 = insertDay(day(56), 6);
    dayReply = (date) => ({ status: 200, body: { ok: true, date, lines: 0, matched: 0, unmatched: [], counted: date >= day(60), switchDay: day(60) } });

    // Yetki: senkron yönetimi
    expect((await h.call('kasa', 'POST', '/sync/lafmaliyet/backfill', { from: day(60), to: day(56) })).status).toBe(403);
    const r = await h.ok<{ queued: number; days: string[] }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(60), to: day(56) });
    expect(r).toEqual({ queued: 3, days: [day(60), day(59), day(56)], training: 0 });
    // Kuyruğa yeni giren gün hata değildir: sırasını bekler
    expect((await status()).failing).toBe(0);
    await drain();
    for (const d of [day(60), day(59), day(56)]) expect(posts(d)).toHaveLength(1);
    expect(posts(day(58))).toEqual([]);
    expect(posts(day(57))).toEqual([]);
    for (const id of [b1, b2, b5]) expect(dayRow(id).exportedAt).toBeGreaterThan(0);
    expect(dayRow(open).exportedAt).toBeNull();
    expect(dayRow(done).exportedAt).toBe(1);
    expect(outbox().filter((o) => !o.sentAt)).toEqual([]);

    // İkinci kez: gidenler yeniden gitmez
    expect(await h.ok('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(60), to: day(56) })).toEqual({ queued: 0, days: [], training: 0 });
    // Varsayılan aralık lafmaliyet'in bildirdiği geçiş gününden düne; açık gün ve eğitim günü sayılmaz
    expect((await status()).backfill).toEqual({ from: day(60), to: day(1), unsent: 0 });

    // Denetim kaydı
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50');
    expect(audit.find((a) => a.action === 'sync.lafmaliyet_backfill')?.message).toMatch(/3 gün/);

    // Aralık denetimi
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(1), to: day(2) })).json.code).toBe('range');
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(1), to: addDays(today, 1) })).json.code).toBe('range');
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: day(500), to: day(1) })).json.code).toBe('range_too_long');
    expect((await h.call('patron', 'POST', '/sync/lafmaliyet/backfill', { from: '2026-02-30', to: day(1) })).status).toBe(422);
  });

  it('yanıt alanları saklanır; "Gönder" kendi gününün sonucunu okur, başka günün başarısı sayılmaz', async () => {
    // Geçiş günü bugünden sonra (sabit tarih yazılınca o gün geçince test kendiliğinden bozuluyordu)
    const switchDay = addDays(today, 10);
    const { insertDay, outbox, lm, dayRow } = await mod();
    dayReply = (date) => ({ status: 200, body: { ok: true, date, lines: 3, matched: 2, unmatched: ['PUMPKIN CHAI LATTE'], counted: false, switchDay: switchDay } });
    const d1 = insertDay(day(20), 10);
    const sent = await h.ok<{ sent: number; answer: Record<string, unknown> }>('kasa', 'POST', `/sync/lafmaliyet/gun/${d1}/push`);
    expect(sent.sent).toBe(1);
    expect(sent.answer).toMatchObject({ date: day(20), lines: 3, matched: 2, unmatched: ['PUMPKIN CHAI LATTE'], counted: false, switchDay: switchDay });
    const row = outbox().find((o) => o.dedupeKey === `gun:${day(20)}`)!;
    expect(row.response).toMatchObject({ counted: false, switchDay: switchDay, matched: 2, unmatched: ['PUMPKIN CHAI LATTE'] });
    expect(dayRow(d1).exportedAt).toBeGreaterThan(0);
    const s = await status();
    expect(s.answer).toMatchObject({ date: day(20), counted: false, switchDay: switchDay, unmatched: ['PUMPKIN CHAI LATTE'] });
    expect(s).not.toHaveProperty('autoPush');
    // Geçiş günü gelecekte: o güne kadar gönderilecek geçmiş gün yok
    expect(s.backfill).toEqual({ from: switchDay, to: day(1), unsent: null });

    // Önde bekleyen başka bir gün gönderilir ama bu gün 409 alır: "Gönder" 502 der, kayıtlı Z yazılır
    const d2 = insertDay(day(19), 11);
    const d3 = insertDay(day(18), 12);
    lm.enqueueDay(d2);
    dayReplies.push(dayReply(day(19)), { status: 409, body: { error: 'z_conflict', date: day(18), zNo: 7 } });
    const rejected = await h.call<{ code: string; error: string }>('kasa', 'POST', `/sync/lafmaliyet/gun/${d3}/push`);
    expect(rejected.status).toBe(502);
    expect(rejected.json.code).toBe('lafmaliyet_push');
    expect(rejected.json.error).toMatch(/HTTP 409 \(z_conflict\)/);
    expect(rejected.json.error).toMatch(/Z 7 kayıtlı, gönderilen Z 12/);
    // Kalıcı ret yeniden denenmez: metin bunu ve yolu söyler, "tekrar denenecek" demez
    expect(rejected.json.error).toMatch(/Kendiliğinden yeniden denenmez: .*Kasa › Geçmiş günler › Z › Gönder ile yeniden gönderin$/);
    expect(rejected.json.error).not.toMatch(/tekrar denenecek|buradan/);
    expect(await status()).toMatchObject({ pending: 1, failing: 1 });
    expect(dayRow(d2).exportedAt).toBeGreaterThan(0);
    expect(dayRow(d3).exportedAt).toBeNull();

    // 401: ipucu (anahtar, saat); yeniden denenir
    const d4 = insertDay(day(17), 13);
    dayReplies.push({ status: 401, body: { error: 'unauthorized' } });
    const unauthorized = await h.call<{ error: string }>('kasa', 'POST', `/sync/lafmaliyet/gun/${d4}/push`);
    expect(unauthorized.status).toBe(502);
    expect(unauthorized.json.error).toMatch(/LAFMALIYET_SYNC_SECRET.*ASILPOS_SYNC_SECRET.*±5 dk/);
    expect(unauthorized.json.error).toMatch(/Giden kutusunda bekliyor, sonra tekrar denenecek$/);
    expect(outbox().find((o) => o.dedupeKey === `gun:${day(17)}`)!.nextAttemptAt).toBeLessThan(Date.now() + 86400_000);

    // Eski lafmaliyet (yalnız ok, date, lines): geçiş günü bilinmiyor; bozuk alan yazılmaz
    const old = lm.readDayAnswer({ ok: true, date: day(5), lines: 4 }, day(5), 1);
    expect(old).toEqual({ date: day(5), at: 1, lines: 4 });
    expect(lm.readDayAnswer({ counted: 'evet', switchDay: '2026-13-01', matched: -1, unmatched: 'x' }, day(5), 1)).toEqual({ date: day(5), at: 1 });
  });

  it('paket hazırlandıktan sonra gün yeniden açılıp kapandıysa eski paket günü "gönderildi" işaretlemez', async () => {
    const { insertDay, lm, db, schema, eq, dayRow, drain } = await mod();
    const id = insertDay(day(30), 20);
    lm.enqueueDay(id);
    db.update(schema.businessDays).set({ closedAt: Date.now() + 60_000 }).where(eq(schema.businessDays.id, id)).run();
    await drain();
    expect(posts(day(30))).toHaveLength(1);
    expect(dayRow(id).exportedAt).toBeNull();
  });

  it('maliyet: 0 bilinmiyor, haritada olmayan ürünün maliyeti boşalır, bozuk gövde haritayı korur', async () => {
    const { db, schema, eq, lm } = await mod();
    const site = h.boot.products.filter((p) => p.extSource === 'laffogato' && p.extId);
    const [a, b, c] = site;
    db.update(schema.products).set({ cost: 999 }).where(eq(schema.products.id, c.id)).run();
    costsReply = {
      status: 200,
      body: {
        version: 1,
        now: new Date().toISOString(),
        items: [
          { siteMenuId: a.extId, slot: 'M', name: a.name, size: 'M', costMinor: 4210, active: true },
          { siteMenuId: a.extId, slot: 'L', name: a.name, size: 'L', costMinor: 0, active: true },
          { siteMenuId: b.extId, slot: 'M', name: b.name, size: 'M', costMinor: 0, active: true },
        ],
      },
    };
    expect(await h.ok('patron', 'POST', '/sync/lafmaliyet/costs/pull')).toEqual({ count: 3, known: 1 });
    const cost = (id: string) => db.select({ cost: schema.products.cost }).from(schema.products).where(eq(schema.products.id, id)).get()!.cost;
    expect(lm.costMap()).toEqual({ [`${a.extId}:M`]: 4210 });
    expect(cost(a.id)).toBe(4210);
    expect(cost(b.id)).toBeNull();
    expect(cost(c.id)).toBeNull();
    const firstAt = (await status()).costsAt!;
    expect(firstAt).toBeGreaterThan(0);

    // Bozuk gövde (başka sürüm, eksik alan) ve HTTP hatası: önceki harita ve ürün maliyetleri kalır, hata görünür
    for (const reply of [
      { status: 200, body: { version: 2, items: [] } },
      { status: 200, body: { version: 1, items: [{ siteMenuId: a.extId, slot: 'X', costMinor: 1 }] } },
      { status: 200, body: null },
      { status: 503, body: { error: 'not_configured' } },
    ]) {
      costsReply = reply;
      const r = await h.call<{ code: string; error: string }>('patron', 'POST', '/sync/lafmaliyet/costs/pull');
      expect(r.status).toBe(502);
      expect(r.json.code).toBe('lafmaliyet_costs');
      expect(lm.costMap()).toEqual({ [`${a.extId}:M`]: 4210 });
      expect(cost(a.id)).toBe(4210);
      const s = await status();
      expect(s.costsAt).toBe(firstAt);
      expect(s.costsError?.message).toBe(r.json.error);
    }
    expect((await status()).costsError?.message).toMatch(/ASILPOS_SYNC_SECRET.*tanımlı değil/);

    // Her gün sonu: aynı iş gününde (05:00 kuralı) yeniden çekilmez; ertesi gün kapanış öncekinden erken olsa da çekilir
    const { setSyncState } = await mod();
    const IST = (s: string) => Date.parse(`${s}+03:00`);
    setSyncState('lafmaliyet.costs', { at: IST('2026-11-02T23:05:00'), map: lm.costMap() });
    costsReply = { status: 200, body: { version: 1, now: '', items: [] } };
    const before = costGets();
    expect(await lm.pullCostsIfStale(IST('2026-11-03T02:00:00'))).toBe(false);
    expect(costGets()).toBe(before);
    expect(await lm.pullCostsIfStale(IST('2026-11-03T22:55:00'))).toBe(true);
    expect(costGets()).toBe(before + 1);
    expect(cost(a.id)).toBeNull();
  });

  it('maliyetin tarihi yalnız maliyet yetkisine gider (Raporlar, patron paneli, bağlantı durumu)', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'Rapor bakan', role: 'garson', permGrant: ['rapor.gor', 'patron.panel', 'senkron.yonet'], pin: '7373' });
    await h.login('rapor', '7373');
    // Bağlantı durumu herkese açık (Genel bakış, menü sayacı) ama maliyetin tarihi ve hatası yalnız maliyet yetkisine
    expect((await status()).costsAt).toBeGreaterThan(0);
    for (const who of ['garson', 'kasa', 'rapor']) {
      const lm = (await h.ok<{ lafmaliyet: Record<string, unknown> }>(who, 'GET', '/sync/status')).lafmaliyet;
      expect(lm).not.toHaveProperty('costsAt');
      expect(lm).not.toHaveProperty('costsError');
      expect(lm).toHaveProperty('configured', true);
    }
    // "Maliyetleri çek" bağlantı yönetimi yetmez, maliyet yetkisi de ister
    expect((await h.call('rapor', 'POST', '/sync/lafmaliyet/costs/pull')).status).toBe(403);
    const range = `from=${today}&to=${today}`;
    const own = await h.ok<Record<string, unknown>>('patron', 'GET', `/reports/products?${range}`);
    expect(own.costsAt).toBeGreaterThan(0);
    expect((await h.ok<Record<string, unknown>>('patron', 'GET', '/reports/patron')).costsAt).toBeGreaterThan(0);
    expect(await h.ok<Record<string, unknown>>('rapor', 'GET', `/reports/products?${range}`)).not.toHaveProperty('costsAt');
    expect(await h.ok<Record<string, unknown>>('rapor', 'GET', '/reports/patron')).not.toHaveProperty('costsAt');
  });

  it('ekran metinleri: geçiş günü, deneme, eşleşmeyenler, eski maliyet', () => {
    expect(answerText({ date: '2026-11-03', at: 0, counted: false, switchDay: '2026-11-10' })).toEqual({
      tone: 'idle',
      text: "lafmaliyet 3 Kasım gününü saymıyor (geçiş günü 10 Kasım): deneme olarak saklandı, hesaplara girmez",
    });
    expect(answerText({ date: '2026-11-03', at: 0, counted: false, switchDay: null }).text).toMatch(/geçiş günü seçilmedi, kasa ModPOS/);
    expect(answerText({ date: '2026-11-12', at: 0, counted: true, switchDay: '2026-11-10' })).toEqual({ tone: 'ok', text: "12 Kasım lafmaliyet'te sayılıyor (geçiş günü 10 Kasım)" });
    expect(answerText({ date: '2026-11-12', at: 0 }).text).toMatch(/geçiş gününü bildirmedi/);
    expect(pushToast({ date: '2026-11-03', at: 0, counted: false, switchDay: null })).toMatch(/deneme/);
    expect(pushToast(null)).toBe("Gün lafmaliyet'e gönderildi");
    expect(unmatchedText(['A', 'B'])).toBe('A, B');
    expect(unmatchedText(['A', 'B', 'C', 'D', 'E', 'F', 'G'])).toBe('A, B, C, D, E ve 2 ad daha');
    // lafmaliyet en çok 50 ad gönderir: gerçek sayı lines - matched
    const fifty = Array.from({ length: 50 }, (_, i) => `URUN ${i + 1}`);
    const many = { date: '2026-11-03', at: 0, lines: 80, matched: 7, unmatched: fifty };
    expect(unmatchedCount(many)).toBe(73);
    expect(unmatchedText(fifty, unmatchedCount(many))).toBe('URUN 1, URUN 2, URUN 3, URUN 4, URUN 5 ve 68 ad daha');
    expect(unmatchedCount({ date: '2026-11-03', at: 0, unmatched: ['A', 'B'] })).toBe(2);
    expect(unmatchedCount({ date: '2026-11-03', at: 0, lines: 4, matched: 4, unmatched: [] })).toBe(0);
    const now = Date.UTC(2026, 10, 20);
    expect(staleCostsText(null, now)).toBeNull();
    expect(staleCostsText(now - 7 * 86_400_000, now)).toBeNull();
    expect(staleCostsText(now - 9 * 86_400_000 - 1000, now)).toMatch(/^Maliyetler 9 gün önce alındı/);
  });
});
