import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Sitede fiyat ya da Satışta değişince kasa hemen eşitler: menü işareti sürüm sinyaliyle gelir. Online sipariş ve
 * karaoke kapalıyken de gün açıkken (menü otomatik eşitleniyorsa) sinyal okunur; gece hiç istek gitmez.
 */
const SECRET = 'm'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  site.karaokeMarker = null;
  site.menuMarker = 'menu-1';
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('patron', 'PUT', '/sync/settings', { onlineOrdersSync: false, menuAutoSync: true });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

describe('menü işareti', () => {
  it('online sipariş kapalıyken: gün açıkken işaret okunur, değişince menü eşitlemesi tetiklenir; gece istek yok', async () => {
    const orders = await import('../server/sync/laffogato-orders');
    const { bus } = await import('../server/lib/events');
    const events: string[] = [];
    const on = (e: { kind: string }) => events.push(e.kind);
    bus.on('event', on);
    try {
      orders.resetOnlineTimer();
      const signals = () => site.count('GET /api/pos/orders/version');
      // Gün kapalı (ilk kurulum, gece): sinyal sorulmaz
      await orders.onlineOrdersTick();
      expect(signals()).toBe(0);
      await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
      await orders.onlineOrdersTick();
      expect(signals()).toBe(1);
      expect(events).not.toContain('site.menu.changed');
      site.menuMarker = 'menu-2';
      await orders.onlineOrdersTick();
      expect(signals()).toBe(2);
      expect(events).toContain('site.menu.changed');
      // Sipariş çekimi kapalı: liste hiç istenmez
      expect(site.count('GET /api/panel/orders')).toBe(0);
    } finally {
      bus.off('event', on);
    }
  });
});
