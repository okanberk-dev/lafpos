import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * İnternet dönüşü (server/sync/catch-up.ts, server/lib/internet.ts): internetsizken lafmaliyet'e gidemeyen gün sonu
 * giden kutusunda bekler, durum "İnternet yok · N kayıt bekliyor" der; internet dönünce artan beklemeyi beklemeden bir
 * kez ve tam bir kez gider, durum "Bekleyenler gönderildi" der. Kalıcı reddedilen kayıt yeniden denenmez; iki dönüş
 * arasında 5 dakika (AGENTS.md kural 6).
 */
let h: Harness;
let server: Server;
let offline = true;
const posts: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    // İnternet yok: bağlantı yanıtsız kapanır (fetch "fetch failed" verir)
    if (offline) return req.socket.destroy();
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const date = raw ? (JSON.parse(raw) as { date: string }).date : undefined;
      if (req.method === 'POST' && req.url === '/api/pos/gun') posts.push(date!);
      res.writeHead(200, { 'content-type': 'application/json' });
      // lafmaliyet'in 200'ü gönderilen günü yineler (yoksa AsilPOS gönderildi saymaz)
      res.end(JSON.stringify({ ok: true, date }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LAFMALIYET_SYNC_SECRET: 'm'.repeat(48) });
});

afterAll(() => {
  server.close();
  h.cleanup();
});

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { ulid } = await import('../server/lib/ids');
  const lm = await import('../server/sync/lafmaliyet');
  // Kurulum modunda gün lafmaliyet'e gitmez
  (await import('../server/lib/settings')).updateSettings({ demoMode: false, okcProvider: 'kapali' });
  const net = await import('../server/lib/internet');
  const cu = await import('../server/sync/catch-up');
  let n = 0;
  /** Kapanmış gerçek bir geçmiş gün (satışsız) giden kutusuna girer */
  const closedDay = (date: string) => {
    const id = ulid();
    const at = Date.now() - 3600_000;
    db.insert(schema.businessDays).values({ id, date, zNo: 900 + ++n, openedAt: at, openingCash: 0, closedAt: at + 60_000, trainingDay: false }).run();
    return lm.enqueueDay(id)!;
  };
  const row = (key: string) => db.select().from(schema.outbox).all().find((r) => r.target === 'lafmaliyet' && r.dedupeKey === key)!;
  const until = async (cond: () => boolean, ms = 3000) => {
    for (const end = Date.now() + ms; !cond() && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  };
  return { db, schema, lm, net, cu, closedDay, row, until };
}

describe('internet dönüşü', () => {
  it('internetsiz: gün sonu kuyrukta, durum "internet yok · 1 kayıt"; dönünce tam bir kez gider', async () => {
    const { lm, net, cu, closedDay, row, until } = await mod();
    const timers = cu.startCatchUp();
    for (const t of timers) clearInterval(t);
    const key = closedDay('2026-08-01');
    expect(await lm.flushOutbox()).toEqual({ sent: 0, failed: 1 });
    expect(row(key).sentAt).toBeNull();
    expect(row(key).nextAttemptAt).toBeGreaterThan(Date.now() + 60_000);
    expect(cu.internetStatus()).toMatchObject({ configured: true, state: 'yok', pending: { lafmaliyet: 1, total: 1 }, sent: null });
    const shell = await h.ok<{ state: string; pending: number }>('garson', 'GET', '/sync/internet');
    expect(shell).toMatchObject({ state: 'yok', pending: 1 });

    // İnternet yokken TCP denemesi bağlanamazsa durum değişmez
    await cu.probeTick(async () => false);
    expect(net.internetState().state).toBe('yok');
    expect(posts).toEqual([]);

    // Dönüş: deneme bağlanır, eşitleme artan beklemeyi (2 dk) beklemeden çalışır
    offline = false;
    await cu.probeTick(async () => true);
    await until(() => !!row(key).sentAt);
    expect(row(key).sentAt).not.toBeNull();
    expect(posts).toEqual(['2026-08-01']);
    await until(() => !!cu.internetStatus().sent);
    expect(cu.internetStatus()).toMatchObject({ state: 'var', pending: { total: 0 }, sent: { count: 1 } });
    const status = await h.ok<{ internet: { sent: { count: number } }; lafmaliyet: { push: { lastSuccessAt: number } } }>('patron', 'GET', '/sync/status');
    expect(status.internet.sent.count).toBe(1);
    expect(status.lafmaliyet.push.lastSuccessAt).toBeGreaterThan(0);

    // Aynı anda gelen eşitlemeler ve dakikalık tur aynı günü ikinci kez göndermez
    await Promise.all([cu.catchUp(), lm.flushOutbox(), lm.flushOutbox()]);
    expect(posts).toEqual(['2026-08-01']);
  });

  it('kalıcı reddedilen kayıt sayılmaz ve yeniden denenmez; iki dönüş arasında 5 dakika', async () => {
    const { db, schema, lm, net, cu, closedDay, row, until } = await mod();
    const { eq } = await import('drizzle-orm');
    const parkedKey = closedDay('2026-08-02');
    db.update(schema.outbox)
      .set({ attempts: 1, lastError: 'lafmaliyet reddetti (422)', nextAttemptAt: Date.now() + 365 * 86400_000 })
      .where(eq(schema.outbox.dedupeKey, parkedKey))
      .run();
    expect(cu.pendingCounts().lafmaliyet).toBe(0);

    // İnternet yine gitti: yeni gün kuyrukta bekler
    offline = true;
    const key = closedDay('2026-08-03');
    await lm.flushOutbox();
    expect(net.internetState().state).toBe('yok');
    offline = false;
    net.noteReachable();
    // Önceki eşitlemenin üstünden 5 dakika geçmedi: hemen gönderilmez
    await new Promise((r) => setTimeout(r, 200));
    expect(row(key).sentAt).toBeNull();
    expect(cu.CATCH_UP_MIN_GAP_MS).toBe(5 * 60_000);
    // Süre dolunca (burada elle) bir kez gider; reddedilen gün gitmez
    cu.resetCatchUp();
    await cu.catchUp();
    await until(() => !!row(key).sentAt);
    expect(posts.filter((d) => d === '2026-08-03')).toHaveLength(1);
    expect(posts).not.toContain('2026-08-02');
    expect(row(parkedKey).sentAt).toBeNull();
  });

  it('ağ hatası ile sunucu hatası ayrılır: yanıt gelen istek interneti "var" sayar', async () => {
    const { net } = await mod();
    expect(net.isNetworkError(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }))).toBe(true);
    expect(net.isNetworkError(Object.assign(new Error('zaman aşımı'), { name: 'TimeoutError' }))).toBe(true);
    expect(net.isNetworkError(new Error('HTTP 500'))).toBe(false);
    expect(net.isNetworkError('metin')).toBe(false);
  });
});
