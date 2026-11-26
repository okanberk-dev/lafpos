import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { LiveEvent } from '@shared/events';
import { type Harness, PINS, startApp } from './harness';

/**
 * İkinci inceleme: yeniden açılan gün öbür cihazlara yayılır (kurulum verisi `settings` olayıyla tazelenir) ve
 * otomatik gün sonu yeniden açılmış günü hemen kapatmaz; unutulan gün bir sonraki turda yine kapanır.
 */
let h: Harness;
const IST = (local: string) => new Date(`${local}+03:00`).getTime();

beforeAll(async () => {
  h = await startApp();
});
afterAll(() => {
  vi.useRealTimers();
  h.cleanup();
});

async function relogin() {
  for (const [who, pin] of Object.entries(PINS)) await h.login(who, pin);
}

describe('yeniden açılan gün', () => {
  it('olay yayılır; otomatik gün sonu yeni açılmış günü kapatmaz, unutulursa ertesi turda kapatır', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date'] });
    vi.setSystemTime(IST('2026-10-26T20:00:00'));
    await relogin();
    await h.ok('patron', 'PUT', '/admin/settings', { autoDayEnd: true, autoDayEndHour: 3, menuAutoSync: false, onlineOrdersSync: false });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });

    vi.setSystemTime(IST('2026-10-27T02:00:00'));
    await relogin();
    const closed = await h.ok<{ day: { id: string; date: string } }>('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    expect(closed.day.date).toBe('2026-10-26');

    vi.setSystemTime(IST('2026-10-27T03:05:00'));
    await relogin();
    const { bus } = await import('../server/lib/events');
    const seen: string[] = [];
    const listen = (e: LiveEvent) => seen.push(`${e.topic}:${e.kind}`);
    bus.on('event', listen);
    const reopened = await h.ok<{ reopenedAt: number | null }>('kasa', 'POST', `/cash/days/${closed.day.id}/reopen`, { reason: 'Geç gelen müşteri', approverPin: PINS.mudur });
    bus.off('event', listen);
    expect(seen).toContain('settings:day.reopened');
    expect(reopened.reopenedAt).toBe(IST('2026-10-27T03:05:00'));

    delete process.env.ASILPOS_NO_JOBS;
    const { startJobs, stopJobs } = await import('../server/jobs');
    startJobs();
    try {
      await vi.advanceTimersByTimeAsync(61_000);
      expect((await h.ok<{ day: { id: string } | null }>('kasa', 'GET', '/cash/day')).day?.id).toBe(closed.day.id);

      // Ertesi gece aynı saatte gün hâlâ açıksa (unutulmuş) otomatik gün sonu kapatır
      vi.setSystemTime(IST('2026-10-28T03:00:30'));
      await vi.advanceTimersByTimeAsync(61_000);
      await relogin();
      expect((await h.ok<{ day: unknown }>('kasa', 'GET', '/cash/day')).day).toBeNull();
    } finally {
      stopJobs();
      process.env.ASILPOS_NO_JOBS = '1';
      vi.useRealTimers();
    }
  });
});

describe('otomatik gün sonu saati', () => {
  it('yarım saat seçilebilir (22.5 = 22:30); çeyrek saat reddedilir', async () => {
    await relogin();
    await h.ok('patron', 'PUT', '/admin/settings', { autoDayEndHour: 22.5 });
    expect((await h.ok<{ autoDayEndHour: number }>('patron', 'GET', '/admin/settings')).autoDayEndHour).toBe(22.5);
    expect((await h.call('patron', 'PUT', '/admin/settings', { autoDayEndHour: 22.25 })).status).toBe(422);
    await h.ok('patron', 'PUT', '/admin/settings', { autoDayEndHour: 6 });
  });
});
