import { createHash, createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Yemeksepeti aktarıcısı (api/uzaktan.ts `yemeksepeti/*`): Delivery Hero'nun JWT'li itmesi Redis listesine girer ve
 * `remoteOrderId` ile onaylanır; durum bildirimi de listeye; kasa listeyi kafe anahtarıyla imzalı çeker ve siler.
 * Gelen kutusu restorana ayrılır: ortamda tanımlı restoranın kaydı kendi listesine, kasa `?restoran=` ile yalnız
 * kendininkini çeker ve siler. Upstash yerine bellekte liste komutlarını bilen sahte Redis.
 */
const SECRET = 'c'.repeat(40);
const PLUGIN_SECRET = 'dh-plugin-secret-123';
const store = new Map<string, string>();
const lists = new Map<string, string[]>();
let h: Harness;

/** Restoranın kendi listesi: adda kimliğin SHA-256 özetinin ilk 16 hanesi (api/uzaktan.ts restaurantLists) */
const own = (list: 'inbox' | 'status', id: string) => `lafpos:ys:${list}:r:${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}`;

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
    // Sipariş ve iptal ayrı listelerde (iptal, bekletilen siparişlerin arkasında kalmasın); restoran ortamda tanımlı
    // (eski öneksiz YEMEKSEPETI_REMOTE_ID): kendi listeleri, ortak liste boş
    expect(lists.get(own('inbox', 'POS_1'))).toHaveLength(1);
    expect(lists.get(own('status', 'POS_1'))).toHaveLength(1);
    expect(lists.get('lafpos:ys:inbox') ?? []).toHaveLength(0);
    // 512 karakterden uzun belirteç reddedilir (kırpılıp eşleşmez hale gelmesin)
    const long = await PUT(req(`yemeksepeti/remoteId/POS_1/remoteOrder/${'x'.repeat(513)}/posOrderStatus`, { method: 'PUT', body: JSON.stringify({ status: 'ORDER_CANCELLED' }), headers: auth }));
    expect(long.status).toBe(400);
    // Boş gövdeli (null) JWT başlığı ya da yükü: 401, çökme yok
    const nullJwt = `${Buffer.from('null').toString('base64url')}.${Buffer.from('null').toString('base64url')}.x`;
    expect((await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify(order), headers: { authorization: `Bearer ${nullJwt}` } }))).status).toBe(401);
  });

  it('gelen kutusu doluysa kırpılmaz: Delivery Hero 503 alır ve yeniden dener; aşırı büyük sipariş 400', async () => {
    const { POST } = await api();
    const auth = { authorization: `Bearer ${jwt(PLUGIN_SECRET)}`, 'content-type': 'application/json' };
    const key = own('inbox', 'POS_1');
    const saved = lists.get(key) ?? [];
    lists.set(key, [...saved, ...Array.from({ length: 500 - saved.length }, (_, i) => JSON.stringify({ id: `dolu-${i}`, kind: 'status' }))]);
    const full = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify({ ...order, token: 'tok-dolu' }), headers: auth }));
    expect(full.status).toBe(503);
    expect(lists.get(key)).toHaveLength(500);
    expect(lists.get(key)![0]).toBe(saved[0]);
    lists.set(key, saved);
    const huge = await POST(req('yemeksepeti/order/POS_1', { method: 'POST', body: JSON.stringify({ ...order, token: 'tok-buyuk', comments: { customerComment: 'x'.repeat(300_000) } }), headers: auth }));
    expect(huge.status).toBe(400);
  });

  it('kasa gelen kutusunu imzalı çeker ve işlediklerini siler; imzasız istek 401', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET, POST } = await api();
    expect((await GET(req('yemeksepeti/inbox'))).status).toBe(401);
    // Restoranın kimliği imzalı sorguda: imzasız ya da sorgusu değiştirilmiş istek 401
    const url = new URL('https://lafpos.vercel.app/api/yemeksepeti/inbox?restoran=POS_1');
    expect((await GET(req('yemeksepeti/inbox&restoran=BASKA', { headers: signedHeaders(SECRET, 'GET', url, '') }))).status).toBe(401);
    const got = await GET(req('yemeksepeti/inbox&restoran=POS_1', { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(got.status).toBe(200);
    const body = (await got.json()) as { items: { id: string; kind: string; remoteId: string; order?: { token: string }; remoteOrderId?: string; status?: string }[]; total: number };
    expect(body.total).toBe(2);
    // Önce iptaller, sonra siparişler
    expect(body.items[0]).toMatchObject({ kind: 'status', remoteOrderId: 'tok-1', status: 'ORDER_CANCELLED' });
    expect(body.items[1]).toMatchObject({ kind: 'order', remoteId: 'POS_1', order: { token: 'tok-1' } });
    const ackUrl = new URL('https://lafpos.vercel.app/api/yemeksepeti/inbox/ack?restoran=POS_1');
    const ackBody = JSON.stringify({ ids: body.items.map((i) => i.id) });
    const ack = await POST(req('yemeksepeti/inbox/ack&restoran=POS_1', { method: 'POST', body: ackBody, headers: { ...signedHeaders(SECRET, 'POST', ackUrl, ackBody), 'content-type': 'application/json' } }));
    expect(await ack.json()).toEqual({ ok: true, removed: 2 });
    const empty = (await (await GET(req('yemeksepeti/inbox&restoran=POS_1', { headers: signedHeaders(SECRET, 'GET', url, '') }))).json()) as { items: unknown[] };
    expect(empty.items).toHaveLength(0);
  });
});

describe('Yemeksepeti gelen kutusu şubeye ayrılır', () => {
  const auth = () => ({ authorization: `Bearer ${jwt(PLUGIN_SECRET)}`, 'content-type': 'application/json' });
  /** Kasanın imzalı çekimi; `restoran` yoksa eski kasa (sorgusuz) */
  async function pull(restoran?: string) {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET } = await api();
    const q = restoran == null ? '' : `?restoran=${encodeURIComponent(restoran)}`;
    const url = new URL(`https://lafpos.vercel.app/api/yemeksepeti/inbox${q}`);
    const res = await GET(req(`yemeksepeti/inbox${q.replace('?', '&')}`, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { id: string; kind: string; remoteId: string; order?: { token: string }; remoteOrderId?: string }[]; total: number };
  }
  async function ack(ids: string[], restoran?: string) {
    const { signedHeaders } = await import('../server/lib/signature');
    const { POST } = await api();
    const q = restoran == null ? '' : `?restoran=${encodeURIComponent(restoran)}`;
    const url = new URL(`https://lafpos.vercel.app/api/yemeksepeti/inbox/ack${q}`);
    const body = JSON.stringify({ ids });
    return (await (await POST(req(`yemeksepeti/inbox/ack${q.replace('?', '&')}`, { method: 'POST', body, headers: { ...signedHeaders(SECRET, 'POST', url, body), 'content-type': 'application/json' } }))).json()) as { removed: number };
  }
  async function push(remoteId: string, token: string) {
    const { POST, PUT } = await api();
    expect((await POST(req(`yemeksepeti/order/${remoteId}`, { method: 'POST', body: JSON.stringify({ ...order, token }), headers: auth() }))).status).toBe(200);
    expect((await PUT(req(`yemeksepeti/remoteId/${remoteId}/remoteOrder/${token}/posOrderStatus`, { method: 'PUT', body: JSON.stringify({ status: 'ORDER_CANCELLED' }), headers: auth() }))).status).toBe(200);
  }
  const ENV = { YEMEKSEPETI_MARINA_REMOTE_ID: 'POS_MARINA', YEMEKSEPETI_TUZLA_REMOTE_ID: 'POS_TUZLA' };

  it('her restoranın kaydı kendi listesine; kasa yalnız kendininkini çeker ve siler, başka şubenin kaydını silemez; eski kasa hepsini görür', async () => {
    lists.clear();
    Object.assign(process.env, ENV);
    try {
      await push('POS_MARINA', 'tok-m');
      await push('POS_TUZLA', 'tok-t');
      expect(lists.get(own('inbox', 'POS_MARINA'))).toHaveLength(1);
      expect(lists.get(own('status', 'POS_MARINA'))).toHaveLength(1);
      expect(lists.get(own('inbox', 'POS_TUZLA'))).toHaveLength(1);
      expect(lists.get(own('status', 'POS_TUZLA'))).toHaveLength(1);
      expect(lists.get('lafpos:ys:inbox') ?? []).toHaveLength(0);
      expect(lists.get('lafpos:ys:status') ?? []).toHaveLength(0);
      // Ham kimlik anahtara girmez
      expect([...lists.keys()].join(' ')).not.toContain('POS_MARINA');
      // Marina kasası yalnız kendi kaydını görür (önce iptal)
      const marina = await pull('POS_MARINA');
      expect(marina.total).toBe(2);
      expect(marina.items.map((i) => [i.kind, i.remoteId])).toEqual([['status', 'POS_MARINA'], ['order', 'POS_MARINA']]);
      const tuzla = await pull('POS_TUZLA');
      expect(tuzla.items.map((i) => i.remoteId)).toEqual(['POS_TUZLA', 'POS_TUZLA']);
      // Marina kasası Tuzla'nın kayıt kimliklerini gönderse de silinmez (yalnız kendi listelerinde siler)
      expect(await ack(tuzla.items.map((i) => i.id), 'POS_MARINA')).toMatchObject({ removed: 0 });
      expect((await pull('POS_TUZLA')).total).toBe(2);
      // Ortamda tanımsız restoran ortak listeyi okur (bugünkü davranış); orada kayıt yok
      expect((await pull('POS_BILINMEYEN')).items).toHaveLength(0);
      // Sorgusuz eski kasa: ortak listeyle birlikte bütün restoranlarınki (güncellenene dek sipariş kaçmasın)
      const old = await pull();
      expect(old.total).toBe(4);
      expect(old.items.map((i) => i.kind)).toEqual(['status', 'status', 'order', 'order']);
      expect(new Set(old.items.map((i) => i.remoteId))).toEqual(new Set(['POS_MARINA', 'POS_TUZLA']));
      // Kendi kaydını siler
      expect(await ack(marina.items.map((i) => i.id), 'POS_MARINA')).toMatchObject({ removed: 2 });
      expect((await pull('POS_MARINA')).total).toBe(0);
      expect((await pull('POS_TUZLA')).total).toBe(2);
      // Eski kasanın silmesi bütün listelerde (eski davranış)
      expect(await ack(tuzla.items.map((i) => i.id))).toMatchObject({ removed: 2 });
      expect((await pull()).total).toBe(0);
    } finally {
      for (const k of Object.keys(ENV)) delete process.env[k];
    }
  });

  it('ortamda restoran kimliği yoksa süzgeç yok ve kutu ortak (bugünkü davranış): her kasa ortak listeyi okur', async () => {
    lists.clear();
    const saved = process.env.YEMEKSEPETI_REMOTE_ID;
    delete process.env.YEMEKSEPETI_REMOTE_ID;
    try {
      await push('POS_HERHANGI', 'tok-h');
      expect(lists.get('lafpos:ys:inbox')).toHaveLength(1);
      expect(lists.get('lafpos:ys:status')).toHaveLength(1);
      expect((await pull('POS_HERHANGI')).total).toBe(2);
      expect((await pull()).total).toBe(2);
      const got = await pull('POS_HERHANGI');
      expect(await ack(got.items.map((i) => i.id), 'POS_HERHANGI')).toMatchObject({ removed: 2 });
    } finally {
      process.env.YEMEKSEPETI_REMOTE_ID = saved;
    }
  });
});
