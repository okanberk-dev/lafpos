import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * LafPOS Uzaktan'a itme (server/sync/cloud.ts): değişmeyen özet gitmez (gece boşta yalnız 15 dk'da bir), gün açıkken
 * nabız yine gider; gövde gzip'li tam özet. Kasa bilgisayarı boşta işlemci yemesin diye. Aralıklar
 * docs/07-UZAKTAN-ERISIM.md §4'te yazdığı gibi
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

/** Saat ileri alınmış gibi (Date.now); gerisi gerçek. `pinClock` çağrıldıysa onun anından sayar */
function later(ms: number) {
  const now = (anchor ?? Date.now()) + ms;
  vi.spyOn(Date, 'now').mockReturnValue(now);
}

/**
 * Testin saatini sabitler: gerçek saat, ama 05:00 iş günü sınırına (İstanbul, UTC+3) 45 dk'dan yakınsa sınırın 1 saat
 * sonrası. Testler saati 30 dk'ya kadar ileri alır; 04:30-05:00 arası koşan CI'da gün değişiyor, özet "değişti" sayılıp
 * nabız gidiyordu (22 Kasım 2026, main CI)
 */
let anchor: number | null = null;
function pinClock() {
  const DAY = 86_400_000;
  const now = Date.now();
  const intoDay = (now + 3 * 3_600_000) % DAY;
  const untilBoundary = (5 * 3_600_000 - intoDay + DAY) % DAY;
  anchor = untilBoundary < 45 * 60_000 ? now + untilBoundary + 3_600_000 : now;
  vi.spyOn(Date, 'now').mockReturnValue(anchor);
}
afterEach(() => {
  anchor = null;
});

describe('LafPOS Uzaktan itmesi', () => {
  it('değişmeyen özet gitmez; zaman damgaları değişiklik sayılmaz', async () => {
    const { pushSnapshot, resetCloudSync, buildSnapshot, snapshotHash } = await import('../server/sync/cloud');
    resetCloudSync();
    pinClock();
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

  it('gün kapalıyken nabız yalnız değişiklikte; 15 dk\'da bir yine de gider', async () => {
    const { pushSnapshot, resetCloudSync, KEEPALIVE_MS } = await import('../server/sync/cloud');
    expect(KEEPALIVE_MS).toBe(15 * 60_000);
    resetCloudSync();
    pinClock();
    pushes = [];
    expect(await pushSnapshot()).toBe('sent');
    later(10 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('unchanged');
    vi.restoreAllMocks();
    later(14 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('unchanged');
    vi.restoreAllMocks();
    // Üçüncü nabız birkaç saniye erken düşse de iter (yoksa dördüncüye, 20. dakikaya kalırdı)
    later(15 * 60_000 - 5_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('sent');
    expect(pushes).toHaveLength(2);
    // Sayaç son itmeden yeniden başlar: ilk itmeden 25 dk sonra, son itmeden 10 dk sonra gitmez
    vi.restoreAllMocks();
    later(25 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('unchanged');
    vi.restoreAllMocks();
    later(30 * 60_000);
    expect(await pushSnapshot({ heartbeat: true })).toBe('sent');
    expect(pushes).toHaveLength(3);
  });

  it('belge (docs/07 §4) koddaki aralıkları yazar', async () => {
    const { MIN_INTERVAL_MS, HEARTBEAT_MS, KEEPALIVE_MS } = await import('../server/sync/cloud');
    const doc = readFileSync(new URL('../docs/07-UZAKTAN-ERISIM.md', import.meta.url), 'utf8');
    const s4 = doc.slice(doc.indexOf('## 4.'), doc.indexOf('## 5.'));
    expect(s4).toContain(`en sık ${MIN_INTERVAL_MS / 1000} sn'de bir`);
    expect(s4).toContain(`${HEARTBEAT_MS / 60_000} dk'da bir nabızla`);
    expect(s4).toContain(`son itmenin üstünden ${KEEPALIVE_MS / 60_000} dk geçtiyse`);
    expect(s4).toContain(`boşta ${KEEPALIVE_MS / 60_000} dk'da`);
    // Eski cümle: boşta değişmeyen özet 5 dk'da bir gitmez
    expect(s4).not.toMatch(/boşta 5 dk'da bir/);
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
