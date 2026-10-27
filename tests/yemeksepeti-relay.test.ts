import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Yemeksepeti aktarıcısı (api/uzaktan.ts `yemeksepeti/*`): Delivery Hero'nun JWT'li itmesi Redis listesine girer ve
 * `remoteOrderId` ile onaylanır; durum bildirimi de listeye; kasa listeyi kafe anahtarıyla imzalı çeker ve siler.
 * Upstash yerine bellekte liste komutlarını bilen sahte Redis.
 */
const SECRET = 'c'.repeat(40);
const PLUGIN_SECRET = 'dh-plugin-secret-123';
const store = new Map<string, string>();
const lists = new Map<string, string[]>();
let h: Harness;

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** Delivery Hero'nun JWT'si: HS512, `service: middleware` */
function jwt(secret: string, payload: Record<string, unknown> = { service: 'middleware' }, alg: 'HS512' | 'HS256' = 'HS512') {
  const head = `${b64({ typ: 'JWT', alg })}.${b64(payload)}`;
  return `${head}.${createHmac(alg === 'HS512' ? 'sha512' : 'sha256', secret).update(head).digest('base64url')}`;
}

beforeAll(async () => {
  h = await startApp();
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, YEMEKSEPETI_PLUGIN_SECRET: PLUGIN_SECRET, YEMEKSEPETI_REMOTE_ID: 'POS_1', LAFPOS_UZAKTAN_DEMO: '0', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't' });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== 'https://redis.test') return realFetch(input, init);
    const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as (string | number)[];
    const k = String(key);
    let result: unknown = null;
    if (cmd === 'GET') result = store.get(k) ?? null;
    if (cmd === 'SET') (store.set(k, String(rest[0])), (result = 'OK'));
    if (cmd === 'EXPIRE') result = 1;
    if (cmd === 'RPUSH') {
      const l = lists.get(k) ?? [];
      l.push(String(rest[0]));
      lists.set(k, l);
      result = l.length;
    }
    if (cmd === 'LLEN') result = (lists.get(k) ?? []).length;
    if (cmd === 'LTRIM') {
      const l = lists.get(k) ?? [];
      const start = Number(rest[0]);
      lists.set(k, start < 0 ? l.slice(start) : l.slice(start, Number(rest[1]) + 1));
      result = 'OK';
    }
    if (cmd === 'LRANGE') {
      const l = lists.get(k) ?? [];
      const end = Number(rest[1]);
      result = l.slice(Number(rest[0]), end < 0 ? l.length + end + 1 : end + 1);
    }
    if (cmd === 'LREM') {
      const l = lists.get(k) ?? [];
      const i = l.indexOf(String(rest[1]));
      if (i >= 0) l.splice(i, 1);
      result = i >= 0 ? 1 : 0;
    }
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

const api = () => import('../api/uzaktan');
const req = (path: string, init: RequestInit = {}) => new Request(`https://lafpos.vercel.app/api/uzaktan?yol=${path}`, init);
const order = { token: 'tok-1', code: 'n0s1-w0k1', shortCode: '42', expeditionType: 'pickup', products: [{ name: 'Latte', quantity: '1', unitPrice: '190.00', paidPrice: '190.00' }], price: { grandTotal: '190.00' } };

describe('Yemeksepeti aktarıcısı', () => {
  it('JWT doğrulaması: anahtar, service iddiası ve süre', async () => {
    const { verifyMiddlewareJwt } = await api();
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, `Bearer ${jwt(PLUGIN_SECRET)}`)).toBe(true);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, jwt(PLUGIN_SECRET, { service: 'middleware' }, 'HS256'))).toBe(true);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, `Bearer ${jwt('baska')}`)).toBe(false);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, `Bearer ${jwt(PLUGIN_SECRET, { service: 'panel' })}`)).toBe(false);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, `Bearer ${jwt(PLUGIN_SECRET, { service: 'middleware', exp: Math.floor(Date.now() / 1000) - 10 })}`)).toBe(false);
    expect(verifyMiddlewareJwt('', `Bearer ${jwt('')}`)).toBe(false);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, null)).toBe(false);
    expect(verifyMiddlewareJwt(PLUGIN_SECRET, 'Bearer a.b')).toBe(false);
  });

  it('sipariş itmesi: JWT yoksa 401, yanlış restoran 400, doğru istek remoteOrderId ile onaylanır; durum bildirimi kuyruğa', async () => {
    const { POST, PUT, GET } = await api();
    const setup = await (await GET(req('uzaktan/kurulum'))).json();
    expect(setup).toMatchObject({ yemeksepeti: true });
    const auth = { authorization: `Bearer ${jwt(PLUGIN_SECRET)}`, 'content-type': 'application/json' };
    expect((await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify(order) }))).status).toBe(401);
    const wrong = await POST(req('yemeksepeti/order/BASKA', { method: 'POST', body: JSON.stringify(order), headers: auth }));
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ reason: 'MENU_ACCOUNT_SETTINGS' });
    const noToken = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify({ code: 'x' }), headers: auth }));
    expect(noToken.status).toBe(400);
    const ok = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify(order), headers: auth }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ remoteResponse: { remoteOrderId: 'tok-1' } });
    const st = await PUT(req('yemeksepeti/remoteId/POS_1/remoteOrder/tok-1/posOrderStatus', { method: 'PUT', body: JSON.stringify({ status: 'ORDER_CANCELLED', message: 'Customer cancelled' }), headers: auth }));
    expect(st.status).toBe(200);
    // Kasanın kullanmadığı durumlar (kurye geldi gibi) kutuya girmez
    const other = await PUT(req('yemeksepeti/remoteId/POS_1/remoteOrder/tok-1/posOrderStatus', { method: 'PUT', body: JSON.stringify({ status: 'COURIER_ARRIVED_AT_VENDOR' }), headers: auth }));
    expect(other.status).toBe(200);
    expect(lists.get('lafpos:ys:inbox')).toHaveLength(2);
    // Boş gövdeli (null) JWT başlığı ya da yükü: 401, çökme yok
    const nullJwt = `${Buffer.from('null').toString('base64url')}.${Buffer.from('null').toString('base64url')}.x`;
    expect((await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify(order), headers: { authorization: `Bearer ${nullJwt}` } }))).status).toBe(401);
  });

  it('gelen kutusu doluysa kırpılmaz: Delivery Hero 503 alır ve yeniden dener; aşırı büyük sipariş 400', async () => {
    const { POST } = await api();
    const auth = { authorization: `Bearer ${jwt(PLUGIN_SECRET)}`, 'content-type': 'application/json' };
    const saved = lists.get('lafpos:ys:inbox') ?? [];
    lists.set('lafpos:ys:inbox', [...saved, ...Array.from({ length: 500 - saved.length }, (_, i) => JSON.stringify({ id: `dolu-${i}`, kind: 'status' }))]);
    const full = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify({ ...order, token: 'tok-dolu' }), headers: auth }));
    expect(full.status).toBe(503);
    expect(lists.get('lafpos:ys:inbox')).toHaveLength(500);
    expect(lists.get('lafpos:ys:inbox')![0]).toBe(saved[0]);
    lists.set('lafpos:ys:inbox', saved);
    const huge = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify({ ...order, token: 'tok-buyuk', comments: { customerComment: 'x'.repeat(300_000) } }), headers: auth }));
    expect(huge.status).toBe(400);
  });

  it('kasa gelen kutusunu imzalı çeker ve işlediklerini siler; imzasız istek 401', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET, POST } = await api();
    expect((await GET(req('yemeksepeti/inbox'))).status).toBe(401);
    const url = new URL('https://lafpos.vercel.app/api/yemeksepeti/inbox');
    const got = await GET(req('yemeksepeti/inbox', { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(got.status).toBe(200);
    const body = (await got.json()) as { items: { id: string; kind: string; remoteId: string; order?: { token: string }; remoteOrderId?: string; status?: string }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ kind: 'order', remoteId: 'POS_1', order: { token: 'tok-1' } });
    expect(body.items[1]).toMatchObject({ kind: 'status', remoteOrderId: 'tok-1', status: 'ORDER_CANCELLED' });
    const ackUrl = new URL('https://lafpos.vercel.app/api/yemeksepeti/inbox/ack');
    const ackBody = JSON.stringify({ ids: body.items.map((i) => i.id) });
    const ack = await POST(req('yemeksepeti/inbox/ack', { method: 'POST', body: ackBody, headers: { ...signedHeaders(SECRET, 'POST', ackUrl, ackBody), 'content-type': 'application/json' } }));
    expect(await ack.json()).toEqual({ ok: true, removed: 2 });
    const empty = (await (await GET(req('yemeksepeti/inbox', { headers: signedHeaders(SECRET, 'GET', url, '') }))).json()) as { items: unknown[] };
    expect(empty.items).toHaveLength(0);
  });
});
