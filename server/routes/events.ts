import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { LiveEvent } from '@shared/events';
import { type AppEnv, type AuthUser, onSessionsChanged, resolveSession } from '../lib/auth';
import { bus } from '../lib/events';

export const eventRoutes = new Hono<AppEnv>();

/** Bağlantı yoklaması; akış oturumu en geç bu aralıkla yeniden okur */
const PING_MS = 20_000;

/**
 * Canlı olay akışı (SSE). İstemci `fetch` ile bağlanır, böylece oturum jetonu başlıkta gider (adres satırında
 * değil). Uyarılar yalnız patron paneli yetkisi olanlara gider.
 *
 * Oturum yalnız bağlanırken değil sürekli denetlenir (denetim, 26 Eki 2026: çıkış yapan, hesabı kapatılan ya da patron
 * paneli yetkisi alınan kişinin açık akışına kasa rakamlı uyarılar gitmeye devam ediyordu). Oturum ya da yetki
 * değişince (`sessionsChanged`) ve her yoklamada oturum yeniden okunur: oturum bittiyse akış hemen kapanır, istemci
 * yeniden bağlanırken 401 alıp giriş ekranına döner; yetkiler değiştiyse uyarılar yeni yetkiye göre süzülür.
 */
eventRoutes.get('/', (c) => {
  const sessionId = c.get('user').sessionId;
  return streamSSE(c, async (stream) => {
    let user: AuthUser | null = c.get('user');
    let checkedAt = Date.now();
    let wake = () => {};
    const end = () => {
      user = null;
      wake();
    };
    const recheck = () => {
      if (!user) return;
      checkedAt = Date.now();
      user = resolveSession(sessionId);
      if (!user) wake();
    };
    const handler = (e: LiveEvent) => {
      // Yoklama gecikmişse (uyuyan zamanlayıcı) olayı göndermeden önce oturum okunur
      if (user && Date.now() - checkedAt >= PING_MS) recheck();
      if (!user) return;
      if (e.topic === 'alerts' && !user.permissions.has('patron.panel')) return;
      stream.writeSSE({ event: 'live', id: String(e.seq), data: JSON.stringify(e) }).catch(end);
    };
    bus.on('event', handler);
    const off = onSessionsChanged(recheck);
    stream.onAbort(end);
    try {
      await stream.writeSSE({ event: 'hello', data: JSON.stringify({ at: Date.now() }) });
      while (user && !stream.aborted) {
        await new Promise<void>((ok) => {
          const timer = setTimeout(ok, PING_MS);
          wake = () => {
            clearTimeout(timer);
            ok();
          };
        });
        recheck();
        if (!user || stream.aborted) break;
        await stream.writeSSE({ event: 'ping', data: String(Date.now()) }).catch(end);
      }
    } finally {
      bus.off('event', handler);
      off();
    }
  });
});
