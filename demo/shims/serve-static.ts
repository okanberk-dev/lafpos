import type { MiddlewareHandler } from 'hono';

/** Tarayıcı demosunda arayüzü sunucu değil sayfa kendisi taşır (server/app.ts bu yola girmez) */
export function serveStatic(): MiddlewareHandler {
  return async (_c, next) => next();
}
