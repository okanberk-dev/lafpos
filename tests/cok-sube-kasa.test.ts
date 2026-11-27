import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACILIS_KASA } from '@shared/eski-adlar';
import { SUBE_YOK_METNI } from '@shared/sube';
import { addDays, businessDate } from '@shared/time';
import type { BootstrapDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Çok şubeli kasa (docs/03-ENTEGRASYON.md §4c, B2): yeni kurulum şubesiz açılır ve şubeye bağlı senkron şube belli olana dek
 * istek göndermez (hata döngüsü yok, durum Türkçe söyler); şube gelince bekleyen günler gider. Devir okuması kasanın
 * şubesini sorguda gönderir, başka şubenin yanıtını almaz ve şube değişince önbellek düşer. 409 `wrong_branch` alan gün
 * günde bir, şube değişince hemen yeniden denenir. Bugünkü panelle (şubeyi görmezden gelir, tek anahtar) tel aynı çalışır.
 */

interface Reply {
  status: number;
  body: unknown;
}

let h: Harness;
let ladmin: Server;
const calls: { method: string; path: string; query: URLSearchParams; body: { date?: string; sube?: unknown } | null }[] = [];
let dayReply = (body: { date?: string } | null): Reply => ({ status: 200, body: { ok: true, date: body?.date, counted: true, switchDay: '2026-11-22', nextOpening: null } });
let devirReply = (q: URLSearchParams): Reply => ({ status: 200, body: { version: 1, date: q.get('date'), nextOpening: null } });

const today = businessDate(Date.now());
let back = 0;

beforeAll(async () => {
  ladmin = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : null;
      calls.push({ method: req.method ?? '', path: url.pathname, query: url.searchParams, body });
      const q = url.searchParams;
      const reply: Reply =
        url.pathname === '/api/pos/gun'
          ? dayReply(body)
          : url.pathname === '/api/panel/pos/devir'
            ? devirReply(q)
            : url.pathname === '/api/panel/pos/urunler'
              ? { status: 200, body: { version: 1, items: [] } }
              : url.pathname === '/api/panel/pos/gider-kategorileri'
                ? { status: 200, body: { version: 1, items: [{ id: 1, name: 'Nakit malzeme alımı', section: 'mal' }] } }
                : url.pathname === '/api/panel/pos/personel'
                  ? { status: 200, body: { version: 1, sube: q.get('sube'), items: [] } }
                  : { status: 404, body: { error: 'not_found' } };
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => ladmin.listen(0, '127.0.0.1', r));
  const at = `http://127.0.0.1:${(ladmin.address() as AddressInfo).port}`;
  // Şubesiz yeni kasa; site de bağlı (imzalı uçlar şube ister)
  h = await startApp({ LAFMALIYET_URL: at, LAFMALIYET_SYNC_SECRET: 'z'.repeat(48), LAFFOGATO_URL: at, LAFFOGATO_SYNC_SECRET: 'y'.repeat(48) }, { branch: null });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, okcProvider: 'kapali' });
});

afterAll(() => {
  ladmin.close();
  h.cleanup();
});

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq, isNull } = await import('drizzle-orm');
  const settings = await import('../server/lib/settings');
  const lm = await import('../server/sync/lafmaliyet');
  const openRow = () => db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get();
  return { db, schema, eq, settings, lm, openRow };
}

/** Bir gün açılıp geçmiş bir tarihe alınarak kapatılır (bir tarihe tek Z) */
async function closeBack(counted: number) {
  const { db, schema, eq, openRow } = await mod();
  // Beklenenden farklı açılışın nedeni (kasa zinciri, §4.6)
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: counted, reason: 'Deneme' });
  const open = openRow()!;
  db.update(schema.businessDays).set({ date: addDays(today, -40 + ++back) }).where(eq(schema.businessDays.id, open.id)).run();
  await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: counted });
  return { id: open.id, date: addDays(today, -40 + back) };
}

const gunPosts = () => calls.filter((c) => c.method === 'POST' && c.path === '/api/pos/gun');
const devirGets = () => calls.filter((c) => c.method === 'GET' && c.path === '/api/panel/pos/devir');

describe('şubesiz yeni kasa: şubeye bağlı senkron bekler', () => {
  it('kapanan gün giden kutusunda bekler; gönderim, devir, personel, site ve platform anahtarı istek atmaz', async () => {
    const { settings, lm } = await mod();
    expect(settings.getSettings().branchId).toBeNull();
    await closeBack(50000);
    expect(await lm.flushOutbox()).toEqual({ sent: 0, failed: 0 });
    expect(gunPosts()).toHaveLength(0);
    // Durum hata değil: şubenin seçilmediğini söyler, giden kutusunda gün bekler
    const st = lm.lafmaliyetStatus();
    expect(st).toMatchObject({ configured: true, branch: null, pending: 1, failing: 0, lastError: null });
    expect(await lm.devirIfStale()).toBe(false);
    expect(devirGets()).toHaveLength(0);
    // Elle işlemler açık nedenle reddedilir (409 no_branch)
    const { db, schema } = await mod();
    const day = db.select().from(schema.businessDays).all().at(-1)!;
    const push = await h.call<{ code: string; error: string }>('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`);
    expect(push.status).toBe(409);
    expect(push.json).toMatchObject({ code: 'no_branch', error: SUBE_YOK_METNI });
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/backfill', { from: addDays(today, -30), to: addDays(today, -1) })).json.code).toBe('no_branch');
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/lafmaliyet/modpos/pull')).json.code).toBe('no_branch');
    expect((await h.call<{ code: string }>('patron', 'GET', '/admin/ladmin-personel')).json.code).toBe('no_branch');
    const { modposTick } = await import('../server/sync/modpos');
    expect(await modposTick()).toBe('skip');
    const { pullConnections } = await import('../server/sync/baglanti-dagitim');
    expect(await pullConnections()).toBeNull();
    // Site imzalı uçları şube ister: bağlı görünmez, elle çekim nedenini söyler
    const { siteSigned } = await import('../server/sync/laffogato-link');
    expect(siteSigned()).toBe(false);
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).integrations.laffogatoPanel).toBe(false);
    expect((await h.call<{ code: string }>('patron', 'POST', '/sync/karaoke/refresh')).json.code).toBe('no_branch');
    // Hiçbir şubeli uca istek gitmedi
    expect(calls.filter((c) => c.path !== '/api/panel/pos/urunler' && c.path !== '/api/panel/pos/gider-kategorileri')).toHaveLength(0);
  });

  it('Bağlantı bilgileri şube kurulumunun durumunu ve şubenin seçilmediğini söyler', async () => {
    const v = await h.ok<{ kurulum: { sube: string | null; kodBekliyor: boolean; durum: unknown; merkezUyarisi: string | null } }>('mudur', 'GET', '/admin/baglanti');
    expect(v.kurulum).toEqual({ sube: null, subeAdi: null, kodBekliyor: false, durum: null, merkezUyarisi: null });
  });

  it('şube seçilince bekleyen gün kasanın şubesiyle hemen gider', async () => {
    const { lm } = await mod();
    const r = await h.call('patron', 'PUT', '/admin/settings', { branchId: 'kadikoy' });
    expect(r.status).toBe(200);
    await expect.poll(() => gunPosts().length, { timeout: 5000, interval: 25 }).toBe(1);
    expect(gunPosts()[0]!.body?.sube).toBe('kadikoy');
    await expect.poll(() => lm.lafmaliyetStatus().pending, { timeout: 5000, interval: 25 }).toBe(0);
    expect(lm.lafmaliyetStatus().branch).toBe('kadikoy');
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).branchName).toBe('Kadikoy');
  });
});

describe('devir okuması şubeli (?sube) ve yankı denetimli', () => {
  /** Devrin 5 dakikalık bütçesi açılır */
  async function allow() {
    const { settings } = await mod();
    const s = settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir');
    if (s) settings.setSyncState('lafmaliyet.devir', { ...s, attemptAt: 0 });
  }

  it('sorguda kasanın şubesi gider; şubesini söylemeyen bugünkü panelin yanıtı alınır', async () => {
    const { lm, settings } = await mod();
    const { date } = await closeBack(70000);
    await lm.flushOutbox();
    devirReply = (q) => ({ status: 200, body: { version: 1, date: q.get('date'), nextOpening: { amount: 650, source: 'kasa_raporu' } } });
    await allow();
    expect(await lm.devirIfStale()).toBe(true);
    const last = devirGets().at(-1)!;
    expect(last.query.get('date')).toBe(date);
    expect(last.query.get('sube')).toBe('kadikoy');
    expect(settings.getSyncState('lafmaliyet.devir')).toMatchObject({ date, sube: 'kadikoy', nextOpening: { amount: 65000, source: 'kasa_raporu' }, lastError: null });
    const opening = (await h.ok<{ opening?: { suggested?: number; source?: string } }>('mudur', 'GET', '/cash/day')).opening;
    expect(opening).toMatchObject({ suggested: 65000, source: 'lafmaliyet' });
  });

  it('aynı şubeyi geri söyleyen yanıt alınır; başka şubeyi söyleyen alınmaz, önceki değer kalır', async () => {
    const { lm, settings } = await mod();
    devirReply = (q) => ({ status: 200, body: { version: 1, date: q.get('date'), sube: 'kadikoy', nextOpening: { amount: 710, source: 'kasa_raporu' } } });
    await allow();
    await lm.devirIfStale();
    expect(settings.getSyncState('lafmaliyet.devir')).toMatchObject({ nextOpening: { amount: 71000 }, lastError: null });
    devirReply = (q) => ({ status: 200, body: { version: 1, date: q.get('date'), sube: 'moda', nextOpening: { amount: 1, source: 'kasa_raporu' } } });
    await allow();
    await lm.devirIfStale();
    const s = settings.getSyncState<{ nextOpening: { amount: number }; lastError: string }>('lafmaliyet.devir')!;
    expect(s.nextOpening.amount).toBe(71000);
    expect(s.lastError).toMatch(/"moda" şubesinin devrini gönderdi, bu kasa "kadikoy"/);
    // Çok şubeli panelin 409 wrong_branch'i şubeyi söyler, değer yine kalır
    devirReply = () => ({ status: 409, body: { error: 'wrong_branch', sube: 'kadikoy', expected: 'marina' } });
    await allow();
    await lm.devirIfStale();
    const s2 = settings.getSyncState<{ nextOpening: { amount: number }; lastError: string }>('lafmaliyet.devir')!;
    expect(s2.nextOpening.amount).toBe(71000);
    expect(s2.lastError).toMatch(/"marina" şubesinin sayıyor, kasa "kadikoy"/);
  });

  it('başka şube için okunan devir kullanılmaz; şube değişince devir önbelleği düşer', async () => {
    const { lm, settings, db } = await mod();
    const { expectedOpening } = await import('../server/services/devir');
    // Bu şubenin devri (710 TL) yerel sayımı (700 TL) geçer
    expect(expectedOpening(db)).toMatchObject({ amount: 71000, source: 'lafmaliyet' });
    // Önbellekteki devir başka şubeninse kullanılmaz: öneri yerel sayıma döner
    const s = settings.getSyncState<Record<string, unknown>>('lafmaliyet.devir')!;
    settings.setSyncState('lafmaliyet.devir', { ...s, sube: 'moda' });
    expect(expectedOpening(db)).toMatchObject({ amount: 70000, source: ACILIS_KASA });
    settings.setSyncState('lafmaliyet.devir', s);
    // Şube değişince (patron onayıyla; günler kabul edildi, kimlik kilitli) devir durumu silinir, yeni şube için sorulur
    const r = await h.call('patron', 'PUT', '/admin/settings', { branchId: 'moda', confirmBranchChange: true });
    expect(r.status).toBe(200);
    expect(settings.getSyncState('lafmaliyet.devir')).toBeNull();
    // Gönderilen günün yanıtı da kadikoy'un: moda kasasında yerel sayım geçer
    expect(expectedOpening(db)).toMatchObject({ amount: 70000, source: ACILIS_KASA });
    devirReply = (q) => ({ status: 200, body: { version: 1, date: q.get('date'), sube: q.get('sube'), nextOpening: { amount: 720, source: 'kasa_raporu' } } });
    expect(await lm.devirIfStale()).toBe(true);
    expect(devirGets().at(-1)!.query.get('sube')).toBe('moda');
    expect(settings.getSyncState('lafmaliyet.devir')).toMatchObject({ sube: 'moda', nextOpening: { amount: 72000 } });
    expect(expectedOpening(db)).toMatchObject({ amount: 72000, source: 'lafmaliyet' });
  });

  it('maliyet ve gider kategorileri okumasında şube sorguda (isteğe bağlı; bugünkü panel görmezden gelir)', async () => {
    const { lm } = await mod();
    await lm.pullCosts();
    await lm.categoriesIfStale(Date.now() + 3600_000);
    const costs = calls.filter((c) => c.path === '/api/panel/pos/urunler').at(-1)!;
    const cats = calls.filter((c) => c.path === '/api/panel/pos/gider-kategorileri').at(-1)!;
    expect(costs.query.get('sube')).toBe('moda');
    expect(cats.query.get('sube')).toBe('moda');
  });
});

describe('409 wrong_branch: günde bir ve şube değişince hemen yeniden', () => {
  it('ret kalıcı park edilmez: ertesi gün yeniden denenir, metin ne yapılacağını söyler', async () => {
    const { lm, db, schema, eq } = await mod();
    dayReply = () => ({ status: 409, body: { error: 'wrong_branch', sube: 'moda', expected: 'marina' } });
    const { date } = await closeBack(80000);
    await lm.flushOutbox();
    const row = db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `gun:${date}`)).get()!;
    expect(row.sentAt).toBeNull();
    expect(row.response).toEqual({ parked: 'wrong_branch' });
    const wait = row.nextAttemptAt - Date.now();
    expect(wait).toBeGreaterThan(lm.WRONG_BRANCH_RETRY_MS - 60_000);
    expect(wait).toBeLessThanOrEqual(lm.WRONG_BRANCH_RETRY_MS);
    expect(row.lastError).toMatch(/günde bir kendiliğinden yeniden denenir/);
    // Elle "Gönder"in yanıtı da kaydın sonra yeniden deneneceğini söyler
    const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.date, date)).get()!;
    const push = await h.call<{ error: string }>('patron', 'POST', `/sync/lafmaliyet/gun/${day.id}/push`);
    expect(push.status).toBe(502);
    expect(push.json.error).toMatch(/sonra tekrar denenecek/);
  });

  it('şube değişince (ya da panel şubeyi bağlayınca) bekleyen gün hemen gider', async () => {
    const { lm, db, schema, eq } = await mod();
    const pending = db.select().from(schema.outbox).where(eq(schema.outbox.target, 'lafmaliyet')).all().filter((r) => !r.sentAt);
    expect(pending).toHaveLength(1);
    dayReply = (body) => ({ status: 200, body: { ok: true, date: body?.date, counted: true } });
    const before = gunPosts().length;
    const r = await h.call('patron', 'PUT', '/admin/settings', { branchId: 'marina', confirmBranchChange: true });
    expect(r.status).toBe(200);
    await expect.poll(() => gunPosts().length, { timeout: 5000, interval: 25 }).toBe(before + 1);
    expect(gunPosts().at(-1)!.body?.sube).toBe('marina');
    await expect.poll(() => lm.lafmaliyetStatus().pending, { timeout: 5000, interval: 25 }).toBe(0);
    // Gönderilen kaydın işareti yanıtla ezildi
    expect(db.select().from(schema.outbox).where(eq(schema.outbox.id, pending[0]!.id)).get()!.response).not.toHaveProperty('parked');
  });

  it('başka kalıcı ret (z_conflict) eskisi gibi park edilir, şube değişimi onu göndermez', async () => {
    const { lm, db, schema, eq } = await mod();
    dayReply = () => ({ status: 409, body: { error: 'z_conflict', zNo: 1 } });
    const { date } = await closeBack(90000);
    await lm.flushOutbox();
    const row = db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `gun:${date}`)).get()!;
    expect(row.nextAttemptAt - Date.now()).toBeGreaterThan(300 * 86400_000);
    expect(row.response).toBeNull();
    expect(lm.retryWrongBranch()).toBe(0);
  });
});

describe('anahtar değişince şube retiyle bekleyen gün hemen yeniden', () => {
  it('aynı şubeye yeni anahtar (ladmin kurulumu, Bağlantı bilgileri): yeni anahtarla açılan sunucu bekleyen günü öne alır', async () => {
    const { lm, db, schema, eq, settings } = await mod();
    const { env } = await import('../server/env');
    // Bir önceki açılış bağlantının özetini yazdı
    lm.lafmaliyetBaglantisiDegisti();
    dayReply = () => ({ status: 409, body: { error: 'wrong_branch', sube: 'marina', expected: 'tuzla' } });
    const { date } = await closeBack(95000);
    await lm.flushOutbox();
    const row = () => db.select().from(schema.outbox).where(eq(schema.outbox.dedupeKey, `gun:${date}`)).get()!;
    expect(row().response).toEqual({ parked: 'wrong_branch' });
    expect(row().lastError).toMatch(/şube ya da anahtar düzelince hemen gider/);
    // Aynı bağlantıyla yeniden açılış: gün günlük denemesini bekler
    expect(lm.lafmaliyetBaglantisiDegisti()).toBe(0);
    expect(row().nextAttemptAt - Date.now()).toBeGreaterThan(lm.WRONG_BRANCH_RETRY_MS - 60_000);
    // Şube aynı, anahtar yeni: bekçi sunucuyu yeni ayarlarla başlattı
    const old = env.lafmaliyetToken;
    env.lafmaliyetToken = 'n'.repeat(48);
    try {
      expect(lm.lafmaliyetBaglantisiDegisti()).toBe(1);
      expect(row().nextAttemptAt).toBeLessThanOrEqual(Date.now());
      // Tutulan yalnız özet, anahtarın kendisi değil
      expect(JSON.stringify(settings.getSyncState('lafmaliyet.baglantiIzi'))).not.toContain('n'.repeat(48));
      dayReply = (body) => ({ status: 200, body: { ok: true, date: body?.date, counted: true } });
      const before = gunPosts().length;
      await lm.flushOutbox();
      // Yalnız şube retiyle bekleyen gün gitti; z_conflict ile park edilen öne alınmadı
      expect(gunPosts().length).toBe(before + 1);
      expect(gunPosts().at(-1)!.body?.date).toBe(date);
      expect(row().sentAt).not.toBeNull();
      expect(lm.lafmaliyetBaglantisiDegisti()).toBe(0);
    } finally {
      env.lafmaliyetToken = old;
    }
  });

  it('açılışta zamanlayıcılardan önce çalışır', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const index = readFileSync(join(__dirname, '../server/index.ts'), 'utf8');
    expect(index.indexOf('lafmaliyetBaglantisiDegisti()')).toBeGreaterThan(index.indexOf('runMigrations();'));
    expect(index.indexOf('lafmaliyetBaglantisiDegisti()')).toBeLessThan(index.indexOf('startJobs();'));
  });
});
