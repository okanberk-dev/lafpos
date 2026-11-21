import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Patrona telefon bildirimi: kasa olayı imzalı iter (server/sync/bildirim.ts), site abonelere Web Push atar
 * (api/_bildirim.ts). Eşikler, internetsiz kuyruk, abonelik için gerçek oturum, geçersizleşen aboneliğin silinmesi,
 * Merkez'in güncelleme sorunu bildirimi.
 */
const CLOUD = 'https://bildirim.test';
const SECRET = 'b'.repeat(40);
const PASSWORD = 'bildirim-parola-1';
const store = new Map<string, string>();
const pushed: { endpoint: string; payload: { title: string; body: string } }[] = [];
let offline = false;
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0', VAPID_PUBLIC_KEY: 'BPub', VAPID_PRIVATE_KEY: 'priv' });
  const { setPushSender } = await import('../api/_bildirim');
  setPushSender(async (sub, payload) => {
    if (sub.endpoint.endsWith('/gitti')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
    return { statusCode: 201 };
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
      let result: unknown = null;
      if (cmd === 'GET') result = store.get(key!) ?? null;
      if (cmd === 'SET') (store.set(key!, rest[0]!), (result = 'OK'));
      if (cmd === 'INCR') (store.set(key!, String(Number(store.get(key!) ?? 0) + 1)), (result = Number(store.get(key!))));
      if (cmd === 'DEL') (store.delete(key!), (result = 1));
      return new Response(JSON.stringify({ result }));
    }
    if (url.startsWith(CLOUD)) {
      if (offline) throw new TypeError('fetch failed');
      const { POST } = await import('../api/uzaktan');
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: init!.body as string, headers: init!.headers as Record<string, string> }));
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

const flush = () => new Promise((r) => setTimeout(r, 30));
async function cloud(method: 'GET' | 'POST', path: string, body?: unknown, token?: string) {
  const { GET, POST } = await import('../api/uzaktan');
  const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return method === 'GET' ? GET(req) : POST(req);
}
async function token() {
  const res = await cloud('POST', 'uzaktan/giris', { parola: PASSWORD });
  return ((await res.json()) as { token: string }).token;
}
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

describe('telefon bildirimi', () => {
  it('abonelik yalnız gerçek oturumla; açık anahtar herkese', async () => {
    expect(await (await cloud('GET', 'uzaktan/bildirim/anahtar')).json()).toEqual({ ready: true, publicKey: 'BPub' });
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/1') })).status).toBe(401);
    const t = await token();
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: { endpoint: 'http://kotu' } }, t)).status).toBe(400);
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/1') }, t)).status).toBe(200);
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/gitti') }, t)).status).toBe(200);
  });

  it('imzasız olay reddedilir', async () => {
    expect((await cloud('POST', 'uzaktan/bildirim', { kind: 'iptal', title: 'x', body: 'y' })).status).toBe(401);
  });

  it('eşik altı iptal gitmez; eşik üstü iptal patrona gider, geçersiz abonelik silinir', async () => {
    const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, qty: 1 }, { productId: product('Mocha').id, qty: 30 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items.find((i) => i.name === 'Latte')!.id}/void`, { reason: 'Vazgeçti', approverPin: PINS.mudur });
    await flush();
    expect(pushed).toHaveLength(0);
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items.find((i) => i.name === 'Mocha')!.id}/void`, { reason: 'Yanlış masa', approverPin: PINS.mudur });
    await flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.title).toMatch(/^Büyük iptal: ₺/);
    expect(pushed[0]!.payload.body).toContain(`Adisyon ${o.no}`);
    // Neden bildirime girmez
    expect(JSON.stringify(pushed[0])).not.toContain('Yanlış masa');
    expect(Object.keys(JSON.parse(store.get('lafpos:bildirim:aboneler')!))).toEqual(['https://push.test/1']);
  });

  it('kapalıyken gitmez; internet yokken kuyrukta bekler, dönünce gider', async () => {
    await h.ok('patron', 'PUT', '/sync/bildirim', { enabled: false });
    const { notify, flushNotices, pendingNotices } = await import('../server/sync/bildirim');
    pushed.length = 0;
    await notify({ kind: 'deneme', title: 'kapalı', body: '' });
    expect(pushed).toHaveLength(0);
    await h.ok('patron', 'PUT', '/sync/bildirim', { enabled: true, cashDiffMin: 1000 });
    offline = true;
    await notify({ kind: 'deneme', title: 'bekleyen', body: '' });
    expect(pendingNotices()).toBe(1);
    offline = false;
    expect(await flushNotices()).toBe(1);
    expect(pendingNotices()).toBe(0);
    expect(pushed.map((p) => p.payload.title)).toEqual([expect.stringContaining('bekleyen')]);
  });

  it('gün sonunda kasa farkı eşiği geçince; ayar yetkisi yoksa ayar değişmez', async () => {
    pushed.length = 0;
    expect((await h.call('garson', 'PUT', '/sync/bildirim', { enabled: false })).status).toBe(403);
    // Kalemleri iptal edilen adisyon kapanır; nakit bir satış, kasada ₺20 eksik sayılır (eşik ₺10)
    const open = (await h.ok<OrderDTO[]>('kasa', 'GET', '/orders?status=acik')).filter((o) => o.status === 'acik');
    for (const o of open) await h.ok('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Deneme', approverPin: PINS.mudur });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: h.boot.paymentMethods.find((m) => m.name === 'Nakit')!.id, amount: o.total });
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: o.total - 2000 });
    await flush();
    const kasa = pushed.find((p) => /^Kasa eksik: ₺20/.test(p.payload.title));
    expect(kasa?.payload.body).toMatch(/beklenen .*sayılan/);
  });

  it('Merkez: güncelleme eski sürüme dönünce patrona bir kez', async () => {
    pushed.length = 0;
    const { identity, merkezBeat } = await import('../server/sync/merkez');
    const { env } = await import('../server/env');
    Object.assign(env, { merkezUrl: CLOUD });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(env.dataDir, 'guncelleme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'durum.json'), JSON.stringify({ durum: 'geri-dondu', mesaj: 'Yeni sürüm açılmadı; eski sürüm çalışıyor' }));
    expect(identity().id).toBeTruthy();
    expect(await merkezBeat()).toBe(true);
    expect(await merkezBeat()).toBe(true);
    expect(pushed.filter((p) => p.payload.title.startsWith('Güncelleme sorunu'))).toHaveLength(1);
    Object.assign(env, { merkezUrl: '' });
  });

  it('son bildirimler listesi gerçek oturumla okunur', async () => {
    const t = await token();
    const list = (await (await cloud('GET', 'uzaktan/bildirim/son', undefined, t)).json()) as { kind: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect((await cloud('GET', 'uzaktan/bildirim/son')).status).toBe(401);
  });
});
