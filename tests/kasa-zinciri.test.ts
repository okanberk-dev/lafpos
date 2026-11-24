import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import { openingSourceText } from '../src/lib/lafmaliyet';
import { type Harness, startApp } from './harness';

/**
 * Kasa zinciri (Faz 3, docs/03-ENTEGRASYON.md §4.6-§4.7): gün açılırken beklenen açılış önceki gerçek günün devridir
 * (lafmaliyet'in `nextOpening`'i ya da LafPOS'un sayımı), en az ₺1,00 farkta neden zorunludur (kör kasiyer tutar görmez,
 * her ret denetime yazılır), açılışın beklenen tutarı, farkı ve nedeni günde saklanır ve gövdeyle gider. Devir lafmaliyet'ten
 * en sık 5 dakikada bir, gün kapalıyken sorulur. Kasa hareketleri gövdede satır satır gider (`cashMoves`); harcamanın
 * kategorisi lafmaliyet'in personel kategorilerinden (en sık 5 dakikada bir çekilir, internetsizken son liste kalır).
 */

interface Reply {
  status: number;
  body: unknown;
}

let h: Harness;
let ladmin: Server;
const calls: { method: string; path: string; query: string; body: { date?: string } | null }[] = [];
let dayReply = (date: string, _body?: { z?: { countedCash?: number | null } } | null): Reply => ({ status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22' } });
let devirReply = (date: string): Reply => ({ status: 200, body: { version: 1, date, nextOpening: null } });
const CATEGORIES = [
  { id: 1, name: 'Nakit malzeme alımı', section: 'mal' },
  { id: 2, name: 'Bakım & onarım', section: 'genel' },
  { id: 3, name: 'Diğer fatura dışı', section: 'genel' },
];
let categoriesReply: Reply = { status: 200, body: { version: 1, now: new Date().toISOString(), items: CATEGORIES } };

const today = businessDate(Date.now());
let back = 0;

beforeAll(async () => {
  ladmin = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? '', path: url.pathname, query: url.search, body });
      const reply =
        url.pathname === '/api/pos/gun'
          ? dayReply(body?.date ?? '', body)
          : url.pathname === '/api/panel/pos/devir'
            ? devirReply(url.searchParams.get('date') ?? '')
            : url.pathname === '/api/panel/pos/gider-kategorileri'
              ? categoriesReply
              : url.pathname === '/api/panel/pos/urunler'
                ? { status: 200, body: { version: 1, now: '', items: [] } }
                : { status: 404, body: { error: 'not_found' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => ladmin.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(ladmin.address() as AddressInfo).port}`, LAFMALIYET_SYNC_SECRET: 'z'.repeat(48) });
  // Gerçek günler: kurulum modu ve eğitim yazarkasası kapalı (kurulum modundaki gün devir vermez)
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false });
  updateSettings({ okcProvider: 'kapali' });
});

afterAll(() => {
  ladmin.close();
  h.cleanup();
});

const devirGets = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/panel/pos/devir');
const categoryGets = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/panel/pos/gider-kategorileri');

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq, isNull } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const lm = await import('../server/sync/lafmaliyet');
  const openRow = () => db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get();
  const dayRow = (id: string) => db.select().from(schema.businessDays).where(eq(schema.businessDays.id, id)).get()!;
  return { db, schema, eq, settings, lm, openRow, dayRow };
}

/** Açık günü geçmiş bir tarihe alıp kapatır (bir tarihe tek Z): sayım `counted` (null: sayımsız); gönderim beklenir */
async function closeBack(counted: number | null) {
  const { db, schema, eq, openRow, lm } = await mod();
  const open = openRow()!;
  db.update(schema.businessDays).set({ date: addDays(today, -60 + ++back) }).where(eq(schema.businessDays.id, open.id)).run();
  await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: counted });
  // Gün sonu giden kutusuna girer, hemen gönderilir: yanıtı (nextOpening) beklenir
  await lm.flushOutbox();
  return open.id;
}

const audit = async () => h.ok<{ action: string; severity: string; message: string; amount: number | null; data: Record<string, unknown> | null }[]>('patron', 'GET', '/admin/audit?limit=200');

interface DayResponse {
  day: { id: string } | null;
  opening?: { suggested?: number; source?: string; ladminSource?: string; fromDate?: string; check?: boolean } | null;
}

describe('açılış önerisi ve nedeni', () => {
  it('gerçek gün yokken öneri yok, açılış serbest; günde beklenen ve fark boş', async () => {
    const { openRow } = await mod();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening ?? null).toBeNull();
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 100000 });
    expect(openRow()).toMatchObject({ openingCash: 100000, expectedOpening: null, openingDiff: null, openingReason: null });
    // Gün açıkken lafmaliyet'e devir sorulmaz
    await h.ok('mudur', 'GET', '/cash/day');
    expect(devirGets()).toHaveLength(0);
  });

  it('önceki gerçek günün sayımı önerilir; kör kasiyer tutarı görmez, yalnız "sayın" der', async () => {
    dayReply = (date) => ({ status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22' } });
    const prev = await closeBack(127950);
    const { dayRow } = await mod();
    const seen = await h.ok<DayResponse>('mudur', 'GET', '/cash/day');
    expect(seen.day).toBeNull();
    expect(seen.opening).toEqual({ suggested: 127950, source: 'lafpos', fromDate: dayRow(prev).date });
    const blind = await h.call<DayResponse>('kasa', 'GET', '/cash/day');
    expect(blind.json.opening).toEqual({ check: true });
    expect(JSON.stringify(blind.json)).not.toMatch(/127950|1279/);
  });

  it('kör kasiyerde ₺1,00 ve üstü fark tutarsız 422 opening_reason_required; her ret denetime yazılır', async () => {
    const r = await h.call<Record<string, unknown>>('kasa', 'POST', '/cash/day/open', { openingCash: 120000 });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: 'opening_reason_required', error: 'Sayımınız beklenenden farklı; nedenini yazın' });
    expect(JSON.stringify(r.json)).not.toMatch(/127950|1279|7950|79,5/);
    const { openRow } = await mod();
    expect(openRow()).toBeUndefined();
    const tried = (await audit()).filter((a) => a.action === 'day.open_attempt');
    expect(tried).toHaveLength(1);
    expect(tried[0]).toMatchObject({ severity: 'uyari', amount: 120000 });
    expect(tried[0].data).toMatchObject({ openingCash: 120000, expected: 127950, diff: -7950, blind: true });
    // Boş neden de neden değildir
    expect((await h.call('kasa', 'POST', '/cash/day/open', { openingCash: 120000, reason: '   ' })).status).toBe(422);
    expect((await audit()).filter((a) => a.action === 'day.open_attempt')).toHaveLength(2);
  });

  it('rakam gören kullanıcıya beklenen ve fark söylenir', async () => {
    const r = await h.call<Record<string, unknown>>('mudur', 'POST', '/cash/day/open', { openingCash: 130000 });
    expect(r.status).toBe(422);
    expect(r.json).toMatchObject({ code: 'opening_reason_required', expected: 127950, diff: 2050 });
    expect(String(r.json.error)).toMatch(/₺20,50 fazla.*₺1\.279,50/);
  });

  it('nedenle açılır: beklenen, fark ve neden günde; denetimde veriyle; gövdede TL', async () => {
    const { openRow } = await mod();
    const opened = await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 120000, reason: 'Sabah bozuk para için 79,50 alındı' });
    expect(openRow()).toMatchObject({ id: opened.id, openingCash: 120000, expectedOpening: 127950, openingDiff: -7950, openingReason: 'Sabah bozuk para için 79,50 alındı' });
    const row = (await audit()).find((a) => a.action === 'day.open')!;
    expect(row.severity).toBe('uyari');
    expect(row.data).toMatchObject({ expected: 127950, diff: -7950, source: 'lafpos', reason: 'Sabah bozuk para için 79,50 alındı' });
    const p = await h.ok<{ z: Record<string, unknown> }>('patron', 'GET', `/sync/lafmaliyet/gun/${opened.id}`);
    expect(p.z).toMatchObject({ openingCash: 1200, expectedOpening: 1279.5, openingDiff: -79.5, openingReason: 'Sabah bozuk para için 79,50 alındı' });
  });

  it('₺1,00 altı fark nedensiz açılır, fark saklanır; sayımsız gün öneri vermez', async () => {
    const { openRow } = await mod();
    await closeBack(150000);
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 149901 });
    expect(openRow()).toMatchObject({ expectedOpening: 150000, openingDiff: -99, openingReason: null });
    // Sayımsız kapanan gün (föy sonra girilecek): beklenen bilinmiyor, açılış serbest
    await closeBack(null);
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening ?? null).toBeNull();
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 5000 });
    expect(openRow()).toMatchObject({ expectedOpening: null, openingDiff: null });
  });
});

describe('lafmaliyet devri (nextOpening)', () => {
  it('gün sonu yanıtındaki nextOpening günün kendi gönderim kaydından okunur ve yerel sayımdan önce gelir', async () => {
    dayReply = (date) => ({ status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22', nextOpening: { amount: 1300, source: 'kasa_raporu' } } });
    const prev = await closeBack(127950);
    const { dayRow, db, schema } = await mod();
    const row = db.select().from(schema.outbox).all().filter((o) => o.dedupeKey === `gun:${dayRow(prev).date}`).at(-1)!;
    expect(row.response).toMatchObject({ nextOpening: { amount: 1300, source: 'kasa_raporu' } });
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 130000, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: dayRow(prev).date });
    // Kör kasiyer devri bağlantı durumundan ya da "Gönder"in yanıtından da öğrenemez
    type Status = { lafmaliyet: { answer: Record<string, unknown> | null } };
    expect((await h.ok<Status>('mudur', 'GET', '/sync/status')).lafmaliyet.answer).toMatchObject({ nextOpening: { amount: 1300 } });
    const blindStatus = await h.ok<Status>('kasa', 'GET', '/sync/status');
    expect(blindStatus.lafmaliyet.answer).not.toHaveProperty('nextOpening');
    expect(JSON.stringify(blindStatus)).not.toMatch(/1300/);
    const pushed = await h.ok<{ answer: Record<string, unknown> | null }>('kasa', 'POST', `/sync/lafmaliyet/gun/${prev}/push`);
    expect(pushed.answer).not.toHaveProperty('nextOpening');
    expect((await h.ok<{ answer: Record<string, unknown> | null }>('mudur', 'POST', `/sync/lafmaliyet/gun/${prev}/push`)).answer).toMatchObject({ nextOpening: { amount: 1300 } });
  });

  it('devir gün kapalıyken en sık 5 dakikada bir sorulur; yanıt yerel sayımı geçer, bozuk yanıt öncekini korur', async () => {
    const { settings, lm } = await mod();
    // Önceki gün kapanınca sorulan devir (önceki testler) 5 dakika dolmadan yinelenmez
    const allow = () => settings.setSyncState('lafmaliyet.devir', { ...(settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir') ?? {}), attemptAt: Date.now() - 6 * 60_000 });
    allow();
    // lafmaliyet'in kasa raporu (panelde düzeltildi) öneriye geçer
    devirReply = (d) => ({ status: 200, body: { version: 1, date: d, nextOpening: { amount: 1250, source: 'kasa_raporu' } } });
    const before = devirGets().length;
    const date = (await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening!.fromDate!;
    await vi.waitFor(() => expect(devirGets()).toHaveLength(before + 1), { timeout: 5000, interval: 25 });
    expect(devirGets().at(-1)!.query).toBe(`?date=${date}`);
    await vi.waitFor(async () => expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 125000, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: date }), { timeout: 5000, interval: 25 });
    // 5 dakika dolmadan yeni istek yok (kör kasiyerin ekranı da sorar)
    await h.ok('mudur', 'GET', '/cash/day');
    await h.ok('kasa', 'GET', '/cash/day');
    expect(await lm.devirIfStale()).toBe(false);
    expect(devirGets()).toHaveLength(before + 1);
    // Bozuk yanıt (başka gün): önceki değer kalır, hata saklanır
    devirReply = () => ({ status: 200, body: { version: 1, date: '2020-01-01', nextOpening: { amount: 1, source: 'lafpos' } } });
    allow();
    expect(await lm.devirIfStale()).toBe(true);
    expect(devirGets()).toHaveLength(before + 2);
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toMatchObject({ suggested: 125000, source: 'lafmaliyet' });
    expect(settings.getSyncState<{ lastError?: string }>('lafmaliyet.devir')!.lastError).toMatch(/devir/i);
    // HTTP hatası da öncekini korur
    devirReply = () => ({ status: 503, body: { error: 'maintenance' } });
    allow();
    expect(await lm.devirIfStale()).toBe(true);
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toMatchObject({ suggested: 125000, source: 'lafmaliyet' });
  });

  it('gönderilmemiş yeniden sayım varken yerel sayım geçerlidir (lafmaliyet eski günü biliyor)', async () => {
    const { db, schema, settings } = await mod();
    const last = db.select().from(schema.businessDays).all().filter((d) => d.closedAt).sort((a, b) => b.zNo - a.zNo)[0]!;
    // lafmaliyet ulaşılamaz: yeniden sayım giden kutusunda bekler
    dayReply = () => ({ status: 503, body: { error: 'maintenance' } });
    await h.ok('mudur', 'POST', `/cash/days/${last.id}/count`, { countedCash: 128000 });
    expect(db.select().from(schema.outbox).all().some((o) => o.dedupeKey === `gun:${last.date}` && !o.sentAt)).toBe(true);
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 128000, source: 'lafpos', fromDate: last.date });
    // Bekleyen kayıt varken devir sorulmaz (yerel sayım kazanır)
    const before = devirGets().length;
    settings.setSyncState('lafmaliyet.devir', { ...settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir')!, attemptAt: 0 });
    await h.ok('mudur', 'GET', '/cash/day');
    await new Promise((r) => setTimeout(r, 100));
    expect(devirGets()).toHaveLength(before);
  });
});

describe('kasa hareketleri satır satır ve harcama kategorisi', () => {
  it('kategoriler istenince çekilir (en sık 5 dakikada bir), harcamaya ad anlık görüntüsüyle yazılır', async () => {
    dayReply = (date) => ({ status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22' } });
    const { db, schema, openRow, settings } = await mod();
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 128000 });
    const first = await h.ok<{ items: { id: number; name: string }[] }>('kasa', 'GET', '/cash/expense-categories');
    await vi.waitFor(() => expect(categoryGets()).toHaveLength(1), { timeout: 5000, interval: 25 });
    expect(first.items.length === 0 || first.items.length === 3).toBe(true);
    await vi.waitFor(async () => expect((await h.ok<{ items: unknown[] }>('kasa', 'GET', '/cash/expense-categories')).items).toEqual(CATEGORIES), { timeout: 5000, interval: 25 });
    expect(categoryGets()).toHaveLength(1);

    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 80000, description: 'Fişsiz', categoryId: 3 });
    const move = db.select().from(schema.cashMovements).all().find((m) => m.dayId === openRow()!.id)!;
    expect(move).toMatchObject({ kind: 'harcama', categoryId: 3, categoryName: 'Diğer fatura dışı' });
    // Kategori yalnız harcamada; bilinmeyen kategori reddedilir
    expect((await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 1000, categoryId: 3 })).json.code).toBe('category_not_allowed');
    expect((await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 1000, description: 'x', categoryId: 99 })).json.code).toBe('invalid_category');

    // İnternet yok / bozuk yanıt: son liste kalır
    categoriesReply = { status: 503, body: { error: 'maintenance' } };
    settings.setSyncState('lafmaliyet.expenseCategories', { ...settings.getSyncState<Record<string, unknown>>('lafmaliyet.expenseCategories')!, attemptAt: 0 });
    await h.ok('kasa', 'GET', '/cash/expense-categories');
    await vi.waitFor(() => expect(categoryGets()).toHaveLength(2), { timeout: 5000, interval: 25 });
    await new Promise((r) => setTimeout(r, 50));
    expect((await h.ok<{ items: unknown[] }>('kasa', 'GET', '/cash/expense-categories')).items).toEqual(CATEGORIES);
    expect(settings.getSyncState<{ lastError?: string }>('lafmaliyet.expenseCategories')!.lastError).toMatch(/503/);
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 2500, description: 'Buz', categoryId: 1 });
  });

  it('gövdede cashMoves: her hareket bir satır, kişi yok; toplamlar Z ile tutar', async () => {
    const { openRow } = await mod();
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 50000, description: 'Patrona' });
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'giris', amount: 3000, description: 'Bozuk para' });
    const id = openRow()!.id;
    const p = await h.ok<{ z: Record<string, number>; cashMoves: { id: string; kind: string; amount: number; description: string; at: string; categoryId: number | null }[] }>('patron', 'GET', `/sync/lafmaliyet/gun/${id}`);
    expect(p.cashMoves.map((m) => [m.kind, m.amount, m.description, m.categoryId])).toEqual([
      ['harcama', 800, 'Fişsiz', 3],
      ['harcama', 25, 'Buz', 1],
      ['teslim', 500, 'Patrona', null],
      ['giris', 30, 'Bozuk para', null],
    ]);
    for (const m of p.cashMoves) {
      expect(m.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(new Date(m.at).toISOString()).toBe(m.at);
      expect(Object.keys(m).sort()).toEqual(['amount', 'at', 'categoryId', 'description', 'id', 'kind']);
    }
    const sum = (k: string) => p.cashMoves.filter((m) => m.kind === k).reduce((a, m) => a + m.amount, 0);
    expect(sum('harcama')).toBeCloseTo(p.z.cashOut, 2);
    expect(sum('teslim')).toBeCloseTo(p.z.handedOver, 2);
    expect(sum('giris')).toBeLessThanOrEqual(p.z.cashIn + 0.001);
    expect(JSON.stringify(p.cashMoves)).not.toMatch(/Kasa|userId/);
  });

  it('hareketsiz günde cashMoves boş dizi olarak gider', async () => {
    const { openRow } = await mod();
    await closeBack(130000);
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 130000 });
    const p = await h.ok<{ cashMoves: unknown[]; z: Record<string, unknown> }>('patron', 'GET', `/sync/lafmaliyet/gun/${openRow()!.id}`);
    expect(p.cashMoves).toEqual([]);
    expect(p.z).toMatchObject({ expectedOpening: 1300, openingDiff: 0, openingReason: null });
  });
});

describe('bugünün günü kapandıktan sonra', () => {
  it('devir sorulmaz: gün 05:00\'e kadar açılamaz, kapalı ekran gece boyu lafmaliyet\'i uyandırmaz', async () => {
    const { settings, lm, db, schema, eq, openRow } = await mod();
    dayReply = (date) => ({ status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22' } });
    const id = openRow()!.id;
    // Bugünün günü kapanır (tarihi kaydırılmaz) ve lafmaliyet'e gider
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 130000 });
    await lm.flushOutbox();
    settings.setSyncState('lafmaliyet.devir', { ...(settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir') ?? {}), attemptAt: 0 });
    const before = devirGets().length;
    const seen = await h.ok<DayResponse & { closedToday: { id: string } | null }>('mudur', 'GET', '/cash/day');
    expect(seen.closedToday?.id).toBe(id);
    expect(await lm.devirIfStale()).toBe(false);
    await new Promise((r) => setTimeout(r, 100));
    expect(devirGets()).toHaveLength(before);
    // Ertesi iş günü (gün dünün tarihine alınır, gönderim kaydıyla): ekran yine sorar
    db.update(schema.businessDays).set({ date: addDays(today, -1) }).where(eq(schema.businessDays.id, id)).run();
    db.update(schema.outbox).set({ dedupeKey: `gun:${addDays(today, -1)}` }).where(eq(schema.outbox.dedupeKey, `gun:${today}`)).run();
    await h.ok('mudur', 'GET', '/cash/day');
    await vi.waitFor(() => expect(devirGets()).toHaveLength(before + 1), { timeout: 5000, interval: 25 });
  });
});

describe('yeniden sayım lafmaliyet\'e gidince', () => {
  // lafmaliyet (§3) devri günün kayıtlı kasa raporundan hesaplar ve raporu yanıttan SONRA yazar (`after()`): gönderimin
  // yanıtı o gönderimin sayımını görmez, önceki gönderimin raporunu söyler. Bu sahte lafmaliyet ikisini de öyle yapar;
  // LafPOS'un otomatik raporu (elle düzeltilmemiş) yeni sayımı alır
  const reports = new Map<string, number>();
  const ladminLike = (date: string, body?: { z?: { countedCash?: number | null } } | null): Reply => {
    const stored = reports.get(date);
    const counted = body?.z?.countedCash ?? null;
    const nextOpening = stored != null ? { amount: stored, source: 'kasa_raporu' } : counted != null ? { amount: counted, source: 'lafpos' } : null;
    if (counted != null) reports.set(date, counted);
    return { status: 200, body: { ok: true, date, counted: true, switchDay: '2026-11-22', nextOpening } };
  };
  const ladminDevir = (date: string): Reply => {
    const stored = reports.get(date);
    return { status: 200, body: { version: 1, date, nextOpening: stored != null ? { amount: stored, source: 'kasa_raporu' } : null } };
  };
  const devirDown = (): Reply => ({ status: 503, body: { error: 'maintenance' } });

  async function sentAnswers(date: string) {
    const { db, schema } = await mod();
    return db
      .select()
      .from(schema.outbox)
      .all()
      .filter((o) => o.dedupeKey === `gun:${date}` && o.sentAt != null)
      .map((o) => o.response as { nextOpening?: unknown });
  }

  /** Önceki test yarıda kaldıysa da açık gün olsun (açılış neden yazılarak) */
  async function ensureOpen() {
    const { openRow } = await mod();
    if (!openRow()) await h.ok('mudur', 'POST', '/cash/day/open', { openingCash: 100000, reason: 'Test' });
  }

  /** Devri hemen sordurur (5 dakika bütçesi sıfırlanır) ve isteğin bitmesini bekler */
  async function askDevir() {
    const { settings, lm } = await mod();
    settings.setSyncState('lafmaliyet.devir', { ...(settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir') ?? {}), attemptAt: 0 });
    expect(await lm.devirIfStale()).toBe(true);
  }

  it('yanıt önceki gönderimin raporunu söylese de yeni sayım geçer: devir okunamazken kör kasiyer doğru tutarla nedensiz açar', async () => {
    const { openRow, dayRow } = await mod();
    dayReply = ladminLike;
    devirReply = devirDown;
    await ensureOpen();
    const id = await closeBack(127950);
    const date = dayRow(id).date;
    expect((await sentAnswers(date)).at(-1)).toMatchObject({ nextOpening: { amount: 1279.5, source: 'lafpos' } });
    // Rapor yokken lafmaliyet kasanın sayımını geri söyler: kaynak lafmaliyet ama kasa raporu değil
    const echoed = (await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening;
    expect(echoed).toEqual({ suggested: 127950, source: 'lafmaliyet', ladminSource: 'lafpos', fromDate: date });
    expect(openingSourceText(echoed as Parameters<typeof openingSourceText>[0])).not.toMatch(/kasa raporu/);
    // Geç gelen masa ya da yeniden sayım: lafmaliyet'e giden yeni sayımın yanıtı eski raporu (₺1.279,50) söyler
    await h.ok('mudur', 'POST', `/cash/days/${id}/count`, { countedCash: 130000 });
    const { lm } = await mod();
    await lm.flushOutbox();
    expect((await sentAnswers(date)).at(-1)).toMatchObject({ nextOpening: { amount: 1279.5, source: 'kasa_raporu' } });
    expect(reports.get(date)).toBe(1300);
    // Ertesi sabah lafmaliyet'e ulaşılamıyor: beklenen kasanın yeni sayımıdır
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 130000, source: 'lafpos', fromDate: date });
    // Kör kasiyer çekmecedeki doğru tutarı yazar: olmayan bir fark için neden istenmez
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 130000 });
    expect(openRow()).toMatchObject({ expectedOpening: 130000, openingDiff: 0, openingReason: null });
  });

  it('yeniden gönderimden önce okunan devir de eskidir; sonra okunan devir lafmaliyet\'in güncel raporudur', async () => {
    const { openRow, dayRow, lm } = await mod();
    dayReply = ladminLike;
    devirReply = ladminDevir;
    await ensureOpen();
    const id = await closeBack(150000);
    const date = dayRow(id).date;
    // Sabah okunan devir: lafmaliyet'in raporu (LafPOS'un ilk sayımı)
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 150000, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: date });
    // Gün yeniden sayılır ve gider; yanıt eski raporu söyler, sonra lafmaliyet'e ulaşılamaz
    await h.ok('mudur', 'POST', `/cash/days/${id}/count`, { countedCash: 152000 });
    await lm.flushOutbox();
    expect((await sentAnswers(date)).at(-1)).toMatchObject({ nextOpening: { amount: 1500, source: 'kasa_raporu' } });
    devirReply = devirDown;
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 152000, source: 'lafpos', fromDate: date });
    // lafmaliyet geri gelince güncel rapor okunur
    devirReply = ladminDevir;
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 152000, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: date });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 152000 });
    expect(openRow()).toMatchObject({ expectedOpening: 152000, openingDiff: 0 });
  });

  it('geç gelen masa: bugünün günü yeniden açılıp kapanınca da yeni sayım geçer; sayımsız yeniden kapanışta lafmaliyet\'in raporu kalır', async () => {
    const { openRow, dayRow, lm, db, schema, eq } = await mod();
    dayReply = ladminLike;
    devirReply = devirDown;
    await ensureOpen();
    // Bugünün günü (tarihi kaydırılmaz) sayılıp kapanır ve gider
    const id = openRow()!.id;
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 127950 });
    await lm.flushOutbox();
    await h.ok('mudur', 'POST', `/cash/days/${id}/reopen`, { reason: 'Geç gelen masa' });
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: 130000 });
    await lm.flushOutbox();
    let at = dayRow(id).date;
    expect((await sentAnswers(at)).at(-1)).toMatchObject({ nextOpening: { amount: 1279.5, source: 'kasa_raporu' } });
    // Ertesi iş günü (gün iki gün önceye alınır; başka günün tarihi değil), lafmaliyet'e ulaşılamıyor
    const move = (to: string) => {
      db.update(schema.businessDays).set({ date: to }).where(eq(schema.businessDays.id, id)).run();
      db.update(schema.outbox).set({ dedupeKey: `gun:${to}` }).where(eq(schema.outbox.dedupeKey, `gun:${at}`)).run();
      at = to;
    };
    const past = addDays(today, -2);
    move(past);
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 130000, source: 'lafpos', fromDate: past });
    // Yeniden açılıp sayımsız kapanırsa (föy sonra) lafmaliyet raporun sayımını korur: onun yanıtı geçer
    move(today);
    await h.ok('mudur', 'POST', `/cash/days/${id}/reopen`, { reason: 'Bir masa daha' });
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
    await lm.flushOutbox();
    expect((await sentAnswers(today)).map((a) => a.nextOpening)).toEqual([
      { amount: 1279.5, source: 'lafpos' },
      { amount: 1279.5, source: 'kasa_raporu' },
      { amount: 1300, source: 'kasa_raporu' },
    ]);
    move(past);
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 130000, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: past });
    await h.ok('mudur', 'POST', '/cash/day/open', { openingCash: 130000 });
  });

  it('panelde düzeltilen rapor (önceki sayımın yankısı değil) yeniden gönderimin yanıtında da geçer', async () => {
    const { dayRow, lm } = await mod();
    dayReply = ladminLike;
    devirReply = devirDown;
    await ensureOpen();
    const id = await closeBack(140000);
    const date = dayRow(id).date;
    // Müdür lafmaliyet'te raporu düzeltti (kapanıştan sonra ₺15,00 teslim): rapor elle değişti, yeniden sayım onu ezmez
    reports.set(date, 1385);
    dayReply = (d, body) => {
      const r = ladminLike(d, body);
      reports.set(d, 1385);
      return r;
    };
    await h.ok('mudur', 'POST', `/cash/days/${id}/count`, { countedCash: 140100 });
    await lm.flushOutbox();
    expect((await sentAnswers(date)).at(-1)).toMatchObject({ nextOpening: { amount: 1385, source: 'kasa_raporu' } });
    await askDevir();
    expect((await h.ok<DayResponse>('mudur', 'GET', '/cash/day')).opening).toEqual({ suggested: 138500, source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate: date });
  });
});

describe('açılış önerisinin kaynağı (Günü aç kartı)', () => {
  it('kasa raporu yalnız lafmaliyet kasa raporundan hesapladıysa anılır', () => {
    const fromDate = '2026-11-22';
    expect(openingSourceText({ source: 'lafmaliyet', ladminSource: 'kasa_raporu', fromDate })).toMatch(/^22 Kasım 2026 Pazar devri, lafmaliyet kasa raporundan$/);
    expect(openingSourceText({ source: 'lafmaliyet', ladminSource: 'lafpos', fromDate })).toMatch(/^22 Kasım 2026 Pazar gün sonu sayımı, lafmaliyet'ten$/);
    expect(openingSourceText({ source: 'lafmaliyet', fromDate })).toMatch(/^22 Kasım 2026 Pazar devri, lafmaliyet'ten$/);
    expect(openingSourceText({ source: 'lafpos', fromDate })).toMatch(/^22 Kasım 2026 Pazar gün sonu sayımı$/);
  });
});
