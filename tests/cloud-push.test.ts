import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * LafPOS Uzaktan'a itme (server/sync/cloud.ts): değişmeyen özet gitmez (gece boşta istek yok), gün açıkken nabız yine
 * gider, saatte bir yine de gider; gövde gzip'li tam özet. Kasa bilgisayarı boşta işlemci yemesin diye
 */
const CLOUD = 'https://lafpos-uzak.test';
let h: Harness;
let pushes: { at: number }[] = [];

beforeAll(async () => {
  h = await startApp();
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: 'c'.repeat(40) });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    if (!String(input).startsWith(CLOUD)) return realFetch(input, init);
    const { gz } = JSON.parse(String(init!.body)) as { gz: string };
    pushes.push(JSON.parse(gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')) as { at: number });
    return new Response('{"ok":true}', { status: 200 });
  });
});
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

/** Saat ileri alınmış gibi (Date.now); gerisi gerçek */
function later(ms: number) {
  const now = Date.now() + ms;
  vi.spyOn(Date, 'now').mockReturnValue(now);
}

describe('LafPOS Uzaktan itmesi', () => {
  it('değişmeyen özet gitmez; zaman damgaları değişiklik sayılmaz', async () => {
    const { pushSnapshot, resetCloudSync, buildSnapshot, snapshotHash } = await import('../server/sync/cloud');
    resetCloudSync();
    pushes = [];
    expect(await pushSnapshot()).toBe('sent');
    expect(pushes).toHaveLength(1);
    expect(await pushSnapshot()).toBe('unchanged');
    expect(await pushSnapshot({ heartbeat: true })).toBe('unchanged');
    expect(pushes).toHaveLength(1);

    const before = snapshotHash(buildSnapshot());
    later(2 * 60_000);
    expect(snapshotHash(buildSnapshot())).toBe(before);
  });

  it('gün kapalıyken nabız yalnız değişiklikte; saatte bir yine de gider', async () => {
    const { pushSnapshot, resetCloudSync } = await import('../server/sync/cloud');
    resetCloudSync();
    pushes = [];
    expect(await pushSnapshot()).toBe('sent');
    later(30 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('unchanged');
    vi.restoreAllMocks();
    later(61 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('sent');
    expect(pushes).toHaveLength(2);
  });

  it('gün açıkken nabız değişmese de gider; değişiklik hemen gider', async () => {
    const { pushSnapshot, resetCloudSync } = await import('../server/sync/cloud');
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    resetCloudSync();
    pushes = [];
    expect(await pushSnapshot()).toBe('sent');
    expect(await pushSnapshot()).toBe('unchanged');
    expect(await pushSnapshot({ heartbeat: true })).toBe('sent');

    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, size: 'M', qty: 1 }] });
    expect(await pushSnapshot()).toBe('sent');
    expect(pushes).toHaveLength(3);
    expect(Object.keys((pushes[2] as unknown as { orders: Record<string, unknown> }).orders)).toContain(o.id);

    // Açık adisyon ve barda bekleyen kalemle de yalnız saatin ilerlemesi değişiklik sayılmaz
    const { buildSnapshot, snapshotHash } = await import('../server/sync/cloud');
    const before = snapshotHash(buildSnapshot());
    later(3 * 60_000);
    expect(snapshotHash(buildSnapshot())).toBe(before);
  });

  it('gönderilemeyen özet bir sonrakinde yeniden denenir', async () => {
    const { pushSnapshot, resetCloudSync, cloudState } = await import('../server/sync/cloud');
    resetCloudSync();
    pushes = [];
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 503 }));
    expect(await pushSnapshot()).toBe('failed');
    expect(cloudState().lastError).toBe('HTTP 503');
    vi.unstubAllGlobals();
    vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => {
      const { gz } = JSON.parse(String(init!.body)) as { gz: string };
      pushes.push(JSON.parse(gunzipSync(Buffer.from(gz, 'base64')).toString('utf8')) as { at: number });
      return new Response('{"ok":true}', { status: 200 });
    });
    expect(await pushSnapshot()).toBe('sent');
    expect(cloudState().lastError).toBeNull();
    expect(pushes).toHaveLength(1);
  });
});
