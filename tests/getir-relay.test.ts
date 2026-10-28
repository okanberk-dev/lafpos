import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Getir aktarıcısı (api/uzaktan.ts `getir/*`): Getir'in `x-api-key` başlıklı itmesi (yeni sipariş, iptal) Redis
 * listelerine girer; kasa listeyi kafe anahtarıyla imzalı çeker ve siler. Upstash yerine bellekte liste komutlarını
 * bilen sahte Redis.
 */
const SECRET = 'c'.repeat(40);
const WEBHOOK_SECRET = 'getir-webhook-anahtari-123';
const store = new Map<string, string>();
const lists = new Map<string, string[]>();
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, GETIR_WEBHOOK_SECRET: WEBHOOK_SECRET, GETIR_RESTAURANT_ID: 'rest-1', LAFPOS_UZAKTAN_DEMO: '0', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't' });
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
const auth = { 'x-api-key': WEBHOOK_SECRET, 'content-type': 'application/json' };
const order = { id: 'ord-1', status: 400, confirmationId: '1042', deliveryType: 1, paymentMethod: 1, products: [{ product: 'prd-latte', count: 1, name: { tr: 'Latte' }, priceWithOption: 190, totalPriceWithOption: 190 }], totalPrice: 190, totalDiscountedPrice: 190, restaurant: { id: 'rest-1' } };

describe('Getir aktarıcısı', () => {
  it('x-api-key doğrulaması: bizim anahtarımız, sabit zamanlı; kısa ya da boş anahtar kurulmamış sayılır', async () => {
    const { verifyApiKey } = await api();
    expect(verifyApiKey(WEBHOOK_SECRET, WEBHOOK_SECRET)).toBe(true);
    expect(verifyApiKey(WEBHOOK_SECRET, ` ${WEBHOOK_SECRET} `)).toBe(true);
    expect(verifyApiKey(WEBHOOK_SECRET, 'baska')).toBe(false);
    expect(verifyApiKey(WEBHOOK_SECRET, null)).toBe(false);
    expect(verifyApiKey('', '')).toBe(false);
    expect(verifyApiKey('kisa', 'kisa')).toBe(false);
  });

  it('sipariş itmesi: anahtar yoksa 401, yanlış restoran 400, kimliksiz 400; sipariş ve iptal ayrı listelere; kurulum durumu var/yok', async () => {
    const { POST, GET } = await api();
    const setup = await (await GET(req('uzaktan/kurulum'))).json();
    expect(setup).toMatchObject({ getir: true });
    expect(JSON.stringify(setup)).not.toContain(WEBHOOK_SECRET);
    expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify(order) }))).status).toBe(401);
    expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify(order), headers: { ...auth, 'x-api-key': 'yanlis' } }))).status).toBe(401);
    const wrong = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, restaurant: { id: 'BASKA' } }), headers: auth }));
    expect(wrong.status).toBe(400);
    expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ status: 400 }), headers: auth }))).status).toBe(400);
    expect((await POST(req('getir/order', { method: 'POST', body: '{bozuk', headers: auth }))).status).toBe(400);
    expect((await POST(req('getir/baska', { method: 'POST', body: JSON.stringify(order), headers: auth }))).status).toBe(404);
    const ok = await POST(req('getir/order', { method: 'POST', body: JSON.stringify(order), headers: auth }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true });
    const cancel = await POST(req('getir/cancel', { method: 'POST', body: JSON.stringify({ ...order, status: 900, cancelNote: 'Müşteri vazgeçti', cancelReason: { id: 'r1', messages: { tr: 'Müşteri iptal etti', en: 'Customer cancelled' }, cancelSource: 1 } }), headers: auth }));
    expect(cancel.status).toBe(200);
    expect(lists.get('lafpos:getir:inbox')).toHaveLength(1);
    expect(lists.get('lafpos:getir:status')).toHaveLength(1);
    const item = JSON.parse(lists.get('lafpos:getir:status')![0]!) as Record<string, unknown>;
    expect(item).toMatchObject({ kind: 'cancel', orderId: 'ord-1', reason: 'Müşteri iptal etti', note: 'Müşteri vazgeçti' });
    expect(item.order).toBeUndefined();
    // 512 karakterden uzun kimlik reddedilir
    expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'x'.repeat(513) }), headers: auth }))).status).toBe(400);
  });

  it('gelen kutusu doluysa kırpılmaz: Getir 503 alır ve yeniden dener; aşırı büyük sipariş 400', async () => {
    const { POST } = await api();
    const saved = lists.get('lafpos:getir:inbox') ?? [];
    lists.set('lafpos:getir:inbox', [...saved, ...Array.from({ length: 500 - saved.length }, (_, i) => JSON.stringify({ id: `dolu-${i}`, kind: 'order' }))]);
    const full = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'ord-dolu' }), headers: auth }));
    expect(full.status).toBe(503);
    expect(lists.get('lafpos:getir:inbox')).toHaveLength(500);
    expect(lists.get('lafpos:getir:inbox')![0]).toBe(saved[0]);
    lists.set('lafpos:getir:inbox', saved);
    const huge = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'ord-buyuk', clientNote: 'x'.repeat(300_000) }), headers: auth }));
    expect(huge.status).toBe(400);
  });

  it('kasa gelen kutusunu imzalı çeker (önce iptaller) ve işlediklerini siler; imzasız istek 401', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET, POST } = await api();
    expect((await GET(req('getir/inbox'))).status).toBe(401);
    const url = new URL('https://lafpos.vercel.app/api/getir/inbox');
    const got = await GET(req('getir/inbox', { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(got.status).toBe(200);
    const body = (await got.json()) as { items: { id: string; kind: string; orderId?: string; order?: { id: string } }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ kind: 'cancel', orderId: 'ord-1' });
    expect(body.items[1]).toMatchObject({ kind: 'order', order: { id: 'ord-1', confirmationId: '1042' } });
    const ackUrl = new URL('https://lafpos.vercel.app/api/getir/inbox/ack');
    const ackBody = JSON.stringify({ ids: body.items.map((i) => i.id) });
    const ack = await POST(req('getir/inbox/ack', { method: 'POST', body: ackBody, headers: { ...signedHeaders(SECRET, 'POST', ackUrl, ackBody), 'content-type': 'application/json' } }));
    expect(await ack.json()).toEqual({ ok: true, removed: 2 });
    const empty = (await (await GET(req('getir/inbox', { headers: signedHeaders(SECRET, 'GET', url, '') }))).json()) as { items: unknown[] };
    expect(empty.items).toHaveLength(0);
    // Yemeksepeti kutusu ayrı: Getir çekimi oraya dokunmaz
    expect(lists.get('lafpos:ys:inbox') ?? []).toHaveLength(0);
  });

  it('anahtar tanımsızken aktarıcı kurulmamış (503); kurulum durumu getir: false', async () => {
    const { POST, GET } = await api();
    const saved = process.env.GETIR_WEBHOOK_SECRET;
    try {
      delete process.env.GETIR_WEBHOOK_SECRET;
      expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify(order), headers: auth }))).status).toBe(503);
      expect(await (await GET(req('uzaktan/kurulum'))).json()).toMatchObject({ getir: false });
    } finally {
      process.env.GETIR_WEBHOOK_SECRET = saved;
    }
  });
});
