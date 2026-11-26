import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Getir aktarıcısı (api/uzaktan.ts `getir/*`): Getir'in `x-api-key` başlıklı itmesi (yeni sipariş, iptal) Redis
 * listelerine girer; kasa listeyi kafe anahtarıyla imzalı çeker ve siler. Gelen kutusu restorana ayrılır: ortamda
 * tanımlı restoranın (GETIR_RESTAURANT_ID, GETIR_<ŞUBE>_RESTAURANT_ID) kaydı kendi listesine, kasa `?restoran=` ile yalnız
 * kendininkini çeker ve siler. Upstash yerine bellekte liste komutlarını bilen sahte Redis.
 */
const SECRET = 'c'.repeat(40);
const WEBHOOK_SECRET = 'getir-webhook-anahtari-123';
const store = new Map<string, string>();
const lists = new Map<string, string[]>();
/** Anahtar → son EXPIRE süresi (sn) */
const expires = new Map<string, number>();
let h: Harness;
/** Restoranın kendi listesi: adda kimliğin SHA-256 özetinin ilk 16 hanesi (api/uzaktan.ts restaurantLists) */
const own = (list: 'inbox' | 'status', id = 'rest-1') => `lafpos:getir:${list}:r:${createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16)}`;

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
    if (cmd === 'EXPIRE') (expires.set(k, Number(rest[0])), (result = 1));
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
    // Restoran ortamda tanımlı (eski öneksiz GETIR_RESTAURANT_ID): kendi listeleri, ortak liste boş
    expect(lists.get(own('inbox'))).toHaveLength(1);
    expect(lists.get(own('status'))).toHaveLength(1);
    expect(lists.get('lafpos:getir:inbox') ?? []).toHaveLength(0);
    const item = JSON.parse(lists.get(own('status'))![0]!) as Record<string, unknown>;
    // İptal kaydında restoran kimliği de var: ortak kutuda kasa başka restoranın iptalini ayırır
    expect(item).toMatchObject({ kind: 'cancel', orderId: 'ord-1', reason: 'Müşteri iptal etti', restaurantId: 'rest-1' });
    // İptalin serbest metin notu (müşterinin ya da temsilcinin yazdığı) saklanmaz: kasa okumaz, kişisel veri taşıyabilir
    expect(item.note).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('Müşteri vazgeçti');
    expect(item.order).toBeUndefined();
    // 512 karakterden uzun kimlik reddedilir
    expect((await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'x'.repeat(513) }), headers: auth }))).status).toBe(400);
  });

  it('gelen kutusu doluysa kırpılmaz: Getir 503 alır ve yeniden dener; aşırı büyük sipariş 400', async () => {
    const { POST } = await api();
    const key = own('inbox');
    const saved = lists.get(key) ?? [];
    lists.set(key, [...saved, ...Array.from({ length: 500 - saved.length }, (_, i) => JSON.stringify({ id: `dolu-${i}`, kind: 'order' }))]);
    const full = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'ord-dolu' }), headers: auth }));
    expect(full.status).toBe(503);
    expect(lists.get(key)).toHaveLength(500);
    expect(lists.get(key)![0]).toBe(saved[0]);
    lists.set(key, saved);
    const huge = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'ord-buyuk', clientNote: 'x'.repeat(300_000) }), headers: auth }));
    expect(huge.status).toBe(400);
  });

  it('kasa gelen kutusunu imzalı çeker (önce iptaller) ve işlediklerini siler; imzasız istek 401', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET, POST } = await api();
    expect((await GET(req('getir/inbox'))).status).toBe(401);
    const url = new URL('https://lafpos.vercel.app/api/getir/inbox?restoran=rest-1');
    const got = await GET(req('getir/inbox&restoran=rest-1', { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(got.status).toBe(200);
    const body = (await got.json()) as { items: { id: string; kind: string; orderId?: string; order?: { id: string } }[]; total: number };
    expect(body.total).toBe(2);
    expect(body.items[0]).toMatchObject({ kind: 'cancel', orderId: 'ord-1' });
    expect(body.items[1]).toMatchObject({ kind: 'order', order: { id: 'ord-1', confirmationId: '1042' } });
    const ackUrl = new URL('https://lafpos.vercel.app/api/getir/inbox/ack?restoran=rest-1');
    const ackBody = JSON.stringify({ ids: body.items.map((i) => i.id) });
    const ack = await POST(req('getir/inbox/ack&restoran=rest-1', { method: 'POST', body: ackBody, headers: { ...signedHeaders(SECRET, 'POST', ackUrl, ackBody), 'content-type': 'application/json' } }));
    expect(await ack.json()).toEqual({ ok: true, removed: 2 });
    const empty = (await (await GET(req('getir/inbox&restoran=rest-1', { headers: signedHeaders(SECRET, 'GET', url, '') }))).json()) as { items: unknown[] };
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
  it('Getir\'e verilen anahtar kafenin ana anahtarına ya da Yemeksepeti anahtarına eşitse aktarıcı kurulmamış sayılır (503, kurulum getir: false)', async () => {
    const { POST, GET } = await api();
    const saved = { getir: process.env.GETIR_WEBHOOK_SECRET, ys: process.env.YEMEKSEPETI_PLUGIN_SECRET };
    try {
      for (const [k, v] of [['GETIR_WEBHOOK_SECRET', SECRET], ['YEMEKSEPETI_PLUGIN_SECRET', WEBHOOK_SECRET]] as const) {
        process.env.GETIR_WEBHOOK_SECRET = WEBHOOK_SECRET;
        delete process.env.YEMEKSEPETI_PLUGIN_SECRET;
        process.env[k] = v;
        const key = process.env.GETIR_WEBHOOK_SECRET!;
        const r = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id: 'ord-esit' }), headers: { ...auth, 'x-api-key': key } }));
        expect(r.status).toBe(503);
        expect(await (await GET(req('uzaktan/kurulum'))).json()).toMatchObject({ getir: false });
      }
    } finally {
      process.env.GETIR_WEBHOOK_SECRET = saved.getir;
      if (saved.ys === undefined) delete process.env.YEMEKSEPETI_PLUGIN_SECRET;
      else process.env.YEMEKSEPETI_PLUGIN_SECRET = saved.ys;
    }
    expect(lists.get(own('inbox')) ?? []).toHaveLength(0);
  });

  it('kişisel veri en aza iner: konum ve kurye saklanmaz, Getir kuryesinde telefon ve adres de, kendi kuryemizde tek telefon (maskesiz yalnız başka yoksa); kayıt başına 1 gün, liste 1 gün etkinliksiz düşer (en çok 2 gün)', async () => {
    const { POST, GET } = await api();
    const { signedHeaders } = await import('../server/lib/signature');
    const client = { id: 'cl-1', name: 'Ayşe K.', contactPhoneNumber: '+90 (850) 000-00000 / 123456', clientPhoneNumber: '+90 (850) 000-00000 / 654321', clientUnmaskedPhoneNumber: '+905321112233', deliveryAddress: { address: 'Gül Sk. 4' }, location: { lat: 40.8, lon: 29.3 } };
    const courier = { id: 'c1', status: 300, name: 'Kurye', location: { lat: 40.81, lon: 29.31 } };
    // Süresi geçmiş eski kayıt kutunun başında (bir günden eski)
    lists.set(own('inbox'), [JSON.stringify({ id: 'eski', kind: 'order', receivedAt: Date.now() - 1.5 * 86400_000, order: { id: 'ord-eski' } })]);
    for (const [id, deliveryType] of [['ord-getir-kurye', 1], ['ord-kendi-kurye', 2]] as const) {
      const r = await POST(req('getir/order', { method: 'POST', body: JSON.stringify({ ...order, id, deliveryType, client, courier }), headers: auth }));
      expect(r.status).toBe(200);
    }
    const stored = lists.get(own('inbox'))!.map((r) => JSON.parse(r) as { id: string; order: Record<string, unknown> });
    expect(stored.map((x) => x.order.id)).toEqual(['ord-getir-kurye', 'ord-kendi-kurye']);
    const [g, k] = stored.map((x) => x.order);
    expect(JSON.stringify(stored)).not.toMatch(/"lat"|"lon"|location/);
    expect(g!.courier).toBeUndefined();
    expect(g!.client).toEqual({ name: 'Ayşe K.' });
    expect(k!.client).toEqual({ name: 'Ayşe K.', contactPhoneNumber: client.contactPhoneNumber, deliveryAddress: client.deliveryAddress });
    expect(JSON.stringify(stored)).not.toContain(client.clientUnmaskedPhoneNumber);
    expect(g!).toMatchObject({ confirmationId: '1042', totalPrice: 190, restaurant: { id: 'rest-1' } });
    // Liste süresi 1 gün: itme ve çekim olmasa da kayıt en çok 2 gün kalır
    expect(expires.get(own('inbox'))).toBe(86_400);
    expect(expires.get(own('status'))).toBe(86_400);
    // Maskeli numara yoksa kasanın okuyacağı tek numara maskesiz olandır
    const { slimGetirOrder } = await api();
    const only = slimGetirOrder({ id: 'x', deliveryType: 2, client: { name: 'A', clientUnmaskedPhoneNumber: '+905321112233' } });
    expect(only.client).toEqual({ name: 'A', contactPhoneNumber: '+905321112233', deliveryAddress: undefined });
    // Çekimde de: kutuda kalmış (Kapalı modda kimse çekmedi) eski kayıt verilmez ve silinir
    const l = lists.get(own('inbox'))!;
    l.push(JSON.stringify({ id: 'eski-2', kind: 'order', receivedAt: Date.now() - 1.5 * 86400_000, order: { id: 'ord-eski-2' } }));
    const url = new URL('https://lafpos.vercel.app/api/getir/inbox?restoran=rest-1');
    const body = (await (await GET(req('getir/inbox&restoran=rest-1', { headers: signedHeaders(SECRET, 'GET', url, '') }))).json()) as { items: { id: string }[] };
    expect(body.items.map((i) => i.id)).toEqual(stored.map((x) => x.id));
    expect(lists.get(own('inbox'))).toHaveLength(2);
    lists.set(own('inbox'), []);
  });
});

describe('Getir gelen kutusu şubeye ayrılır', () => {
  /** Kasanın imzalı çekimi ve silmesi; `restoran` yoksa eski kasa (sorgusuz) */
  async function pull(restoran?: string) {
    const { signedHeaders } = await import('../server/lib/signature');
    const { GET } = await api();
    const q = restoran == null ? '' : `?restoran=${encodeURIComponent(restoran)}`;
    const url = new URL(`https://lafpos.vercel.app/api/getir/inbox${q}`);
    const res = await GET(req(`getir/inbox${q.replace('?', '&')}`, { headers: signedHeaders(SECRET, 'GET', url, '') }));
    expect(res.status).toBe(200);
    return (await res.json()) as { items: { id: string; kind: string; orderId?: string; restaurantId?: string; order?: { id: string; restaurant?: { id: string } } }[]; total: number };
  }
  async function ack(ids: string[], restoran?: string) {
    const { signedHeaders } = await import('../server/lib/signature');
    const { POST } = await api();
    const q = restoran == null ? '' : `?restoran=${encodeURIComponent(restoran)}`;
    const url = new URL(`https://lafpos.vercel.app/api/getir/inbox/ack${q}`);
    const body = JSON.stringify({ ids });
    return (await (await POST(req(`getir/inbox/ack${q.replace('?', '&')}`, { method: 'POST', body, headers: { ...signedHeaders(SECRET, 'POST', url, body), 'content-type': 'application/json' } }))).json()) as { removed: number };
  }
  async function push(restaurant: string, id: string, status = 200) {
    const { POST } = await api();
    for (const path of ['getir/order', 'getir/cancel']) {
      const r = await POST(req(path, { method: 'POST', body: JSON.stringify({ ...order, id, restaurant: { id: restaurant } }), headers: auth }));
      expect(r.status).toBe(status);
    }
  }

  it('şubenin GETIR_<ŞUBE>_RESTAURANT_ID\'si de tanınır (eski öneksiz ad da); her restoranın kaydı kendi listesine; kasa başka şubenin kaydını silemez; eski kasa hepsini görür', async () => {
    lists.clear();
    process.env.GETIR_MARINA_RESTAURANT_ID = 'rest-marina';
    try {
      await push('rest-marina', 'ord-m');
      await push('rest-1', 'ord-1');
      // Ortamda tanımsız restoran: 400 (bugünkü gibi)
      await push('rest-bilinmeyen', 'ord-x', 400);
      expect(lists.get(own('inbox', 'rest-marina'))).toHaveLength(1);
      expect(lists.get(own('status', 'rest-marina'))).toHaveLength(1);
      expect(lists.get(own('inbox'))).toHaveLength(1);
      expect(lists.get('lafpos:getir:inbox') ?? []).toHaveLength(0);
      expect(lists.get('lafpos:getir:status') ?? []).toHaveLength(0);
      const marina = await pull('rest-marina');
      expect(marina.items.map((i) => i.kind)).toEqual(['cancel', 'order']);
      expect(marina.items.map((i) => i.orderId ?? i.order?.id)).toEqual(['ord-m', 'ord-m']);
      expect(marina.items[0]).toMatchObject({ restaurantId: 'rest-marina' });
      const other = await pull('rest-1');
      expect(other.items.map((i) => i.orderId ?? i.order?.id)).toEqual(['ord-1', 'ord-1']);
      // Marina kasası öteki restoranın kayıt kimliklerini gönderse de silinmez
      expect(await ack(other.items.map((i) => i.id), 'rest-marina')).toMatchObject({ removed: 0 });
      expect((await pull('rest-1')).total).toBe(2);
      // Sorgusuz eski kasa: ortak listeyle birlikte bütün restoranlarınki
      const old = await pull();
      expect(old.total).toBe(4);
      expect(old.items.map((i) => i.kind)).toEqual(['cancel', 'cancel', 'order', 'order']);
      expect(await ack(marina.items.map((i) => i.id), 'rest-marina')).toMatchObject({ removed: 2 });
      expect((await pull('rest-marina')).total).toBe(0);
      expect((await pull('rest-1')).total).toBe(2);
    } finally {
      delete process.env.GETIR_MARINA_RESTAURANT_ID;
      lists.clear();
    }
  });

  it('ortamda restoran kimliği yoksa süzgeç yok ve kutu ortak (bugünkü davranış)', async () => {
    lists.clear();
    const saved = process.env.GETIR_RESTAURANT_ID;
    delete process.env.GETIR_RESTAURANT_ID;
    try {
      await push('rest-herhangi', 'ord-h');
      expect(lists.get('lafpos:getir:inbox')).toHaveLength(1);
      expect(lists.get('lafpos:getir:status')).toHaveLength(1);
      expect((await pull('rest-herhangi')).total).toBe(2);
      expect((await pull()).total).toBe(2);
    } finally {
      process.env.GETIR_RESTAURANT_ID = saved;
      lists.clear();
    }
  });
});
