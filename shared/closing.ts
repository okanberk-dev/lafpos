import { CLOSING_REMINDER_MS, closingAtMs } from './time';
import type { BusinessDayDTO } from './types';

/**
 * Kapanış saati hatırlatmasının saf kuralı (sahibin isteği, 25 Kasım 2026): Ayarlar'daki kapanış saatine 30 dakika kala
 * gün açıksa. Kasadaki kart (src/components/ClosingReminder.tsx, src/lib/closingReminder.ts) ve patronun telefonuna
 * giden bildirim (server/sync/bildirim.ts `closingNoticeTick`) aynı kuralı okur: ekranla telefon aynı şeyi söyler.
 * DOM yok; tests/kapanis-teslim.test.ts.
 *
 * - Kapanış anı açık günün tarihinden (`closingAtMs`): dünden açık kalan gün de "kapanış geçti" görünür, 05:00'e kadarki
 *   kapanış saati ertesi güne düşer (05:00 günün sonu).
 * - Kapanıştan sonra (ya da hatırlatma penceresinde) yeniden açılan gün (kapanıştan sonra gelen müşteri) 30 dakika
 *   hatırlatılmaz; gün yine açık kalırsa "geçti" diye döner.
 * - "Sonra" (yalnız kasadaki kart) bu cihazda o gün için erteler.
 */
export type ClosingPhase = { kind: 'yaklasiyor'; closeAt: number; minutesLeft: number } | { kind: 'gecti'; closeAt: number } | null;

/** "Sonra"nın kaydı: hangi gün için, ne zamana dek (cihazda; `useLocalPref`) */
export interface ClosingSnooze {
  dayId: string;
  until: number;
}

type ClosingDay = Pick<BusinessDayDTO, 'id' | 'date' | 'closedAt' | 'reopenedAt'>;

export function closingPhase(day: ClosingDay | null | undefined, closingTime: string | null | undefined, now: number, snooze?: ClosingSnooze | null): ClosingPhase {
  if (!closingTime || !/^\d{2}:\d{2}$/.test(closingTime) || !day || day.closedAt) return null;
  const closeAt = closingAtMs(day.date, closingTime);
  const from = closeAt - CLOSING_REMINDER_MS;
  if (now < from) return null;
  if (day.reopenedAt && day.reopenedAt >= from && now < day.reopenedAt + CLOSING_REMINDER_MS) return null;
  if (snooze && snooze.dayId === day.id && now < snooze.until) return null;
  return now < closeAt ? { kind: 'yaklasiyor', closeAt, minutesLeft: Math.max(1, Math.ceil((closeAt - now) / 60_000)) } : { kind: 'gecti', closeAt };
}

/**
 * Hatırlatmanın kimliği: gün, kapanış anı ve son yeniden açılış. Telefon bildirimi ve kasanın uyarı sesi her kimlik için
 * bir kez: gün başına bir kez, yeniden açılan günde (ya da kapanış saati değişince) bir kez daha
 */
export function closingKey(day: Pick<BusinessDayDTO, 'id' | 'reopenedAt'>, closeAt: number): string {
  return `${day.id}:${closeAt}:${day.reopenedAt ?? 0}`;
}
