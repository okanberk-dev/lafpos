import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * LafPOS Uzaktan (api/uzaktan.ts): kafedeki sunucunun imzalı itmesi, patron parolasıyla giriş, salt okunur
 * uçlar. Upstash yerine bellekte sahte Redis; imza kuralı sunucununkiyle aynı olmalı.
 */
const SECRET = 'x'.repeat(40);
const PASSWORD = 'kahve-parola-123';
const store = new Map<string, string>();
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't' });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input) !== 'https://redis.test') return realFetch(input, init);
    const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
    let result: unknown = null;
    if (cmd === 'GET') result = store.get(key!) ?? null;
    if (cmd === 'SET') (store.set(key!, rest[0]!), (result = 'OK'));
    if (cmd === 'INCR') (store.set(key!, String(Number(store.get(key!) ?? 0) + 1)), (result = Number(store.get(key!))));
    if (cmd === 'DEL') (store.delete(key!), (result = 1));
    if (cmd === 'EXPIRE') result = 1;
    return new Response(JSON.stringify({ result }), { status: 200 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

async function api() {
  return import('../api/uzaktan');
}
const req = (path: string, init: RequestInit = {}) => new Request(`https://lafpos.vercel.app/api/uzaktan?yol=${path}`, init);

describe('LafPOS Uzaktan', () => {
  it('imza kuralı sunucununkiyle aynı; asıl yol ?yol= ile geri kurulur', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { verifyPush, originalUrl } = await api();
    const url = new URL('https://lafpos.vercel.app/api/uzaktan/push');
    const body = '{"gz":"abc"}';
    const headers = new Headers(signedHeaders(SECRET, 'POST', url, body));
    const seen = originalUrl('https://lafpos.vercel.app/api/uzaktan?yol=uzaktan/push');
    expect(seen.pathname).toBe('/api/uzaktan/push');
    expect(verifyPush(SECRET, { method: 'POST', headers }, seen, body)).toBe(true);
    expect(verifyPush(SECRET, { method: 'POST', headers }, seen, '{"gz":"başka"}')).toBe(false);
    expect(verifyPush('y'.repeat(40), { method: 'POST', headers }, seen, body)).toBe(false);
  });

  it('itme, giriş, salt okunur uçlar; özette maliyet yok', async () => {
    const { signedHeaders } = await import('../server/lib/signature');
    const { buildSnapshot } = await import('../server/sync/cloud');
    const { GET, POST } = await api();
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, size: 'M', qty: 1 }] });

    const snap = buildSnapshot();
    expect(snap.orders[o.id]).toBeTruthy();
    expect(snap.bootstrap.products.some((p) => 'cost' in p)).toBe(false);

    // Kafeden gelmeden okunamaz; imzasız itme reddedilir
    const body = JSON.stringify({ gz: gzipSync(JSON.stringify(snap)).toString('base64') });
    expect((await POST(req('uzaktan/push', { method: 'POST', body }))).status).toBe(401);
    const signed = new Headers({ ...signedHeaders(SECRET, 'POST', new URL('https://lafpos.vercel.app/api/uzaktan/push'), body), 'content-type': 'application/json' });
    expect((await POST(req('uzaktan/push', { method: 'POST', body, headers: signed }))).status).toBe(200);

    // Parola
    expect((await POST(req('uzaktan/giris', { method: 'POST', body: JSON.stringify({ parola: 'yanlis' }), headers: { 'x-forwarded-for': '1.1.1.1' } }))).status).toBe(401);
    const login = await POST(req('uzaktan/giris', { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '1.1.1.1' } }));
    const { token } = (await login.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };

    expect((await GET(req('bootstrap'))).status).toBe(401);
    const boot = (await (await GET(req('bootstrap', { headers: auth }))).json()) as { me: { id: string }; products: unknown[] };
    expect(boot.me.id).toBe('uzaktan');
    expect(boot.products.length).toBeGreaterThan(50);
    expect((await GET(req(`orders/${o.id}`, { headers: auth }))).status).toBe(200);
    expect((await GET(req('reports/patron', { headers: auth }))).status).toBe(200);
    const write = await POST(req(`orders/${o.id}/items`, { method: 'POST', body: '{}', headers: auth }));
    expect(write.status).toBe(403);
    expect(((await write.json()) as { code: string }).code).toBe('remote_readonly');
  });

  it('parola denemesi IP başına sınırlı', async () => {
    const { POST } = await api();
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await POST(req('uzaktan/giris', { method: 'POST', body: '{"parola":"x"}', headers: { 'x-forwarded-for': '9.9.9.9' } }))).status;
    expect(last).toBe(429);
  });
});
