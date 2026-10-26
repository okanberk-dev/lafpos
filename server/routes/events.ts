import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LiveEvent } from '@shared/events';
import type { AppEnv } from '../lib/auth';
import { bus } from '../lib/events';

export const eventRoutes = new Hono<AppEnv>();

/**
 * Canlı olay akışı (SSE). İstemci `fetch` ile bağlanır, böylece oturum jetonu başlıkta gider (adres satırında
 * değil). Uyarılar yalnız patron paneli yetkisi olanlara gider.
 */
eventRoutes.get('/', (c) => {
  const user = c.get('user');
  const seeAlerts = user.permissions.has('patron.panel');
  return streamSSE(c, async (stream) => {
    let closed = false;
    const handler = (e: LiveEvent) => {
      if (closed) return;
      if (e.topic === 'alerts' && !seeAlerts) return;
      stream.writeSSE({ event: 'live', id: String(e.seq), data: JSON.stringify(e) }).catch(() => {
        closed = true;
      });
    };
    bus.on('event', handler);
    stream.onAbort(() => {
      closed = true;
      bus.off('event', handler);
    });
    await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: Date.now() }) });
    while (!closed && !stream.aborted) {
      await stream.sleep(20_000);
      if (closed || stream.aborted) break;
      await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(() => {
        closed = true;
      });
    }
    bus.off('event', handler);
  });
});
