import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * İkinci bağımsız inceleme (26 Eki 2026), her bulgu bir testle: üstündekinin PIN'ini değiştirme ve indirim sınırı,
 * ağ geneli PIN kilidinin doğru PIN'leri durdurması, Token kesintisinde takılan sepet, kör kasada hesap yazdırma ve
 * teslimat yanıtları, indirim kaymasının "Servis ücreti" diye gitmesi, oda sayacı çalışırken cihaz ödemesi ve
 * lafmaliyet'e gönderim sürerken basılan "Gönder".
 */
let h: Harness;
let tokenx: Server;
let tokenxMode: 'up' | 'down' = 'up';
let lafmaliyet: Server;
const lmBodies: { date: string }[] = [];
const MUDUR = PINS.mudur;

function jsonServer(handler: (req: { url?: string; method?: string }, send: (code: number, body: unknown) => void) => void): Server {
  return createServer((req, res) => {
    req.resume();
    req.on('end', () =>
      handler(req, (code, body) => {
        res.writeHead(code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      }),
    );
  });
}
const listen = async (s: Server) => {
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
};

beforeAll(async () => {
  // Sahte Token bulutu: 'down' internet ya da Token kesintisi (503)
  tokenx = jsonServer((req, send) => {
    if (tokenxMode === 'down') return send(503, {});
    if (req.url === '/v1/auth/token') return send(200, { status: 0, result: { accessToken: 'tok', expiresIn: 900 } });
    const m = req.url?.match(/^\/v1\/basket\/([^/]+)$/);
    if (m && req.method === 'GET') return send(200, { status: 0, result: { basketID: m[1], deletedAt: null } });
    return send(200, { status: 0, result: {} });
  });
  // Sahte lafmaliyet: yavaş yanıt (gönderim sürerken ikinci istek gelsin)
  lafmaliyet = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () =>
      setTimeout(() => {
        // Gün sonunda maliyetler de günde bir çekilir (GET /api/panel/pos/urunler)
        if (req.method === 'GET') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ version: 1, now: new Date().toISOString(), items: [] }));
          return;
        }
        const body = JSON.parse(raw) as { date: string };
        lmBodies.push(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, date: body.date, lines: 0 }));
      }, 150),
    );
  });
  const tx = await listen(tokenx);
  const lm = await listen(lafmaliyet);
  h = await startApp({
    TOKENX_AUTH_URL: tx,
    TOKENX_BASKET_URL: tx,
    TOKENX_CLIENT_ID: 'id',
    TOKENX_CLIENT_SECRET: 'secret',
    TOKENX_TERMINAL_ID: 'T1',
    LAFMALIYET_URL: lm,
    LAFMALIYET_SYNC_SECRET: 'y'.repeat(48),
  });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});

afterAll(() => {
  tokenx.close();
  lafmaliyet.close();
  h.cleanup();
});

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const audit = (severity: 'alarm') => h.ok<{ action: string }[]>('patron', 'GET', `/admin/audit?severity=${severity}&limit=500`);
async function newOrder(items: { name: string; qty?: number; size?: 'M' | 'L' }[], extra: Record<string, unknown> = {}) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah', ...extra });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) })) });
}

describe('ikinci inceleme', () => {
  it('patron olmayan yetkili üstündekinin PIN\'ini değiştiremez, kapatamaz; indirim sınırını aşamaz', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'Vardiya sorumlusu', role: 'garson', permGrant: ['personel.yonet'], pin: '5555' });
    await h.login('sorumlu', '5555');
    const users = await h.ok<{ id: string; name: string }[]>('patron', 'GET', '/admin/users');
    const mudur = users.find((u) => u.name === 'Müdür')!;
    for (const body of [{ pin: '7788' }, { active: false }, { name: 'Eski müdür' }]) {
      const r = await h.call<{ code: string }>('sorumlu', 'PATCH', `/admin/users/${mudur.id}`, body);
      expect(r.status, JSON.stringify(body)).toBe(403);
      expect(r.json.code).toBe('escalation');
    }
    expect((await h.call('', 'POST', '/auth/login', { pin: '7788' })).status).toBe(401);
    // Üstündeki rolü de boşaltamaz
    expect((await h.call<{ code: string }>('sorumlu', 'PUT', '/admin/roles/mudur', { permissions: [] })).json.code).toBe('escalation');

    // Altındakini yönetir: açar, PIN'ini değiştirir; indirim sınırı kendisininkini (%10) aşamaz
    expect((await h.call<{ code: string }>('sorumlu', 'POST', '/admin/users', { name: 'Kukla', role: 'garson', pin: '6161', maxDiscountPct: 100 })).json.code).toBe('escalation');
    const yeni = await h.ok<{ id: string }>('sorumlu', 'POST', '/admin/users', { name: 'Yeni garson', role: 'garson', pin: '6162' });
    await h.ok('sorumlu', 'PATCH', `/admin/users/${yeni.id}`, { pin: '6163' });
    expect((await h.call<{ code: string }>('sorumlu', 'PATCH', `/admin/users/${yeni.id}`, { maxDiscountPct: 50 })).json.code).toBe('escalation');
    await h.ok('sorumlu', 'PATCH', `/admin/users/${yeni.id}`, { maxDiscountPct: 5 });
  });

  it('PIN: seyrek yazım hataları kimseyi kilitlemez; ağ kilidi kafedeki cihazı ve yetkili onayını durdurmaz', async () => {
    const auth = await import('../server/lib/auth');
    auth.resetFailures();
    const t0 = Date.now();
    let offset = 0;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => t0 + offset);
    try {
      // Gün boyu 30 yazım hatası, her birinin ardından doğru PIN (9 dakika arayla)
      for (let i = 0; i < 30; i++) {
        offset = i * 9 * 60_000;
        expect((await h.call('', 'POST', '/auth/login', { pin: '9090' })).status).toBe(401);
        expect((await h.call('', 'POST', '/auth/login', { pin: PINS.kasa })).status, `hata ${i + 1}`).toBe(200);
      }
      // Ağdan tarama: 6 tanınmayan adres × 5 deneme, bir dakika içinde
      for (let a = 0; a < 6; a++) for (let k = 0; k < 5; k++) auth.recordFailure('giris', `10.9.9.${a}`);
      expect(() => auth.assertNotLocked('giris', '10.9.9.77')).toThrow(/Çok fazla hatalı PIN/);
      // Kafedeki cihaz (doğru PIN'le girmiş adres) girmeye ve onay almaya devam eder
      expect((await h.call('', 'POST', '/auth/login', { pin: PINS.kasa })).status).toBe(200);
      expect((await h.call('kasa', 'POST', '/auth/approve', { pin: MUDUR, permission: 'siparis.iptal' })).status).toBe(200);
      expect((await audit('alarm')).some((x) => x.action === 'auth.global_lock')).toBe(true);
    } finally {
      clock.mockRestore();
      auth.resetFailures();
    }
  });

  it('kör kasa: hesap yazdırma ve teslimat yanıtı kapanmış adisyonun ödemesini de göstermez', async () => {
    const o = await newOrder([{ name: 'Türk Kahvesi' }]);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
    expect((await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/bill`)).payments).toEqual([]);
    expect((await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/bill`)).payments).toHaveLength(1);

    let p = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'paket', deliveryName: 'Ece', deliveryPhone: '05321112233', deliveryAddress: 'Tuzla' });
    p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: method('Nakit').id, amount: p.total });
    expect((await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/delivery`, {})).payments).toEqual([]);
  });

  it('indirim kayması cihaza "Servis ücreti" diye gitmez; sepet adisyonun kalanını tam kapatır', async () => {
    let o = await newOrder([{ name: 'Latte', size: 'M' }, { name: 'Türk Kahvesi' }]);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 2000, reason: 'Kampanya', approverPin: MUDUR });
    const latte = o.items.find((i) => i.name === 'Latte')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, amount: o.totals.lineNet[latte.id], items: [{ itemId: latte.id, qty: 1 }] });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    expect(o.totals.service).toBe(0);
    const sent = await h.ok<{ receipt: { id: string; amount: number; basket: { items: { name: string }[] } } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(sent.receipt.basket.items.some((i) => i.name === 'Servis ücreti')).toBe(false);
    expect(sent.receipt.amount).toBe(o.total - o.paid);
    await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
    const after = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${o.id}`);
    expect(after).toMatchObject({ status: 'kapali', paid: o.total });
  });

  it('oda sayacı çalışırken hesap cihaza gitmez; kapanmış adisyona oda ücreti yazılmaz', async () => {
    const room = h.boot.tables.find((t) => t.kind === 'oda')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'masa', tableId: room.id });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk Kahvesi').id, qty: 1 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/room/start`);
    const blocked = await h.call<{ code: string }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(blocked.json.code).toBe('room_running');
    // Eski veride kapanmış ama sayacı çalışan adisyon: ücret yazılmaz, önce yeniden açılmalı
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.orders).set({ status: 'kapali' }).where(eq(schema.orders.id, o.id)).run();
    expect((await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/room/stop`)).json.code).toBe('order_closed');
    db.update(schema.orders).set({ status: 'acik' }).where(eq(schema.orders.id, o.id)).run();
    const stopped = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/room/stop`);
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: stopped.total });
  });

  it('Token kesintisinde takılan sepet yetkili onayıyla AsilPOS\'ta iptal sayılır, adisyon nakit alınır', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'tokenx', mode: 'anlik' });
    const o = await newOrder([{ name: 'Türk Kahvesi' }]);
    const sent = await h.ok<{ receipt: { id: string; status: string } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, {});
    expect(sent.receipt.status).toBe('gonderildi');
    tokenxMode = 'down';
    try {
      expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/cancel`, {})).json.code).toBe('okc_delete');
      expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/cancel`, { force: true })).json.code).toBe('approval_required');
      const forced = await h.ok<{ status: string }>('kasa', 'POST', `/okc/receipts/${sent.receipt.id}/cancel`, { force: true, approverPin: MUDUR });
      expect(forced.status).toBe('silindi');
      expect((await audit('alarm')).some((x) => x.action === 'okc.force_cancel')).toBe(true);
      const paid = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: o.total });
      expect(paid.closed).toBe(true);
    } finally {
      tokenxMode = 'up';
      await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    }
  });

  it('lafmaliyet\'e gönderim sürerken basılan "Gönder" bitmesini bekler, günü gerçekten gönderir', async () => {
    // Kurulum modunda (örnek PIN'ler, eğitim simülatörü) gün lafmaliyet'e gitmez
    const { updateSettings } = await import('../server/lib/settings');
    updateSettings({ demoMode: false, okcProvider: 'kapali' });
    const x = await h.ok<{ summary: { expectedCash: number } }>('mudur', 'GET', '/cash/day');
    const closed = await h.ok<{ day: { id: string; date: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: x.summary.expectedCash });
    // Kapanıştaki gönderim yavaş sunucuda sürüyor; "Gönder" onu bekleyip yeniden gönderir
    const pushed = await h.ok<{ sent: number; failed: number }>('kasa', 'POST', `/sync/lafmaliyet/gun/${closed.day.id}/push`);
    expect(pushed.sent).toBeGreaterThanOrEqual(1);
    expect(lmBodies.filter((b) => b.date === closed.day.date).length).toBeGreaterThanOrEqual(1);
    const { db, schema } = await import('../server/db/client');
    expect(db.select().from(schema.outbox).all().filter((r) => r.sentAt == null)).toEqual([]);
  });
});
