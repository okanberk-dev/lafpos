import { inArray } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { db, schema } from '../db/client';
import { pavoEodRunning } from '../okc/providers/pavo';

/**
 * "Satış ya da ödeme sürerken güncelleme kurulmaz" (sahibin kuralı, 22 Kas 2026). Kasa meşgul sayılır:
 *  - bir satış/ödeme isteği o an işleniyorsa (adisyon, kalem, ödeme, kasa, yazarkasa yazmaları),
 *  - son yazmanın üstünden `QUIET_MS` geçmediyse (art arda dokunuşların arası),
 *  - yazarkasa cihazında bekleyen sepet varsa (müşteri kartını okutuyor),
 *  - cihazda banka gün sonu sürüyorsa (Pavo `/PerformEOD`, gün kapanınca arka planda, en çok 3 dk): sunucu o sırada
 *    yeniden başlarsa gün sonunun sonucu belirsiz kalır, kâğıdı basılmaz (inceleme, 23 Kas 2026).
 * Yalnız bellekte ve bu süreçte: güncelleyici (bekçi) kurmadan hemen önce `/api/kasa/guncelleme-durumu` ile sorar,
 * "Şimdi güncelle" de aynı soruyla reddedilir. Okuma (GET) ve güncellemenin kendi istekleri sayılmaz
 */
export const QUIET_MS = 5_000;
const SALE_PATH = /^\/api\/(orders|collect|kitchen|day|days|eod|movements|shift-counts|cash|okc)(\/|$)/;
const OKC_PENDING = ['gonderildi', 'kilitli'] as const;

let inflight = 0;
let lastWrite = 0;

export const activityMiddleware: MiddlewareHandler = async (c, next) => {
  const m = c.req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS' || !SALE_PATH.test(c.req.path)) return next();
  inflight++;
  try {
    await next();
  } finally {
    inflight--;
    lastWrite = Date.now();
  }
};

/** Yazarkasa cihazında bekleyen sepet var mı (ödeme yarıda) */
export function okcPending(): boolean {
  try {
    return !!db
      .select({ id: schema.fiscalReceipts.id })
      .from(schema.fiscalReceipts)
      .where(inArray(schema.fiscalReceipts.status, [...OKC_PENDING]))
      .limit(1)
      .get();
  } catch {
    return false;
  }
}

export function busyNow(now = Date.now()): boolean {
  return inflight > 0 || now - lastWrite < QUIET_MS || okcPending() || pavoEodRunning();
}

/** Testler için: sayaçları sıfırlar */
export function resetActivity() {
  inflight = 0;
  lastWrite = 0;
}
