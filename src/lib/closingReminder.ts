import { CLOSING_REMINDER_MS, closingAtMs } from '@shared/time';
import type { BusinessDayDTO } from '@shared/types';

/**
 * Kapanış saati hatırlatması (sahibin isteği, 25 Kasım 2026): Ayarlar'daki kapanış saatine 30 dakika kala gün açıksa
 * gün sonu yetkisi olanın ekranında sağ altta "Gün sonu al" kartı (src/components/ClosingReminder.tsx). Saf kurallar
 * burada (DOM yok; tests/kapanis-teslim.test.ts):
 *
 * - Kapanış anı açık günün tarihinden (`closingAtMs`): dünden açık kalan gün de "kapanış geçti" görünür, 05:00'e kadarki
 *   kapanış saati ertesi güne düşer (05:00 günün sonu).
 * - Kapanıştan sonra (ya da hatırlatma penceresinde) yeniden açılan gün (kapanıştan sonra gelen müşteri) 30 dakika
 *   hatırlatılmaz; gün yine açık kalırsa kart "geçti" diye döner.
 * - "Sonra" bu cihazda o gün için erteler: kapanıştan önce kapanış dakikasına dek, sonra 15 dakika.
 */
export type ClosingPhase = { kind: 'yaklasiyor'; closeAt: number; minutesLeft: number } | { kind: 'gecti'; closeAt: number } | null;

/** "Sonra"nın kaydı: hangi gün için, ne zamana dek (cihazda; `useLocalPref`) */
export interface ClosingSnooze {
  dayId: string;
  until: number;
}

export const CLOSING_SNOOZE_KEY = 'kapanisHatirlatma';
/** Kapanış geçtikten sonra "Sonra" kartı bu kadar gizler */
export const CLOSING_SNOOZE_AFTER_MS = 15 * 60_000;

export function closingPhase(
  day: Pick<BusinessDayDTO, 'id' | 'date' | 'closedAt' | 'reopenedAt'> | null,
  closingTime: string | null | undefined,
  now: number,
  snooze?: ClosingSnooze | null,
): ClosingPhase {
  if (!closingTime || !/^\d{2}:\d{2}$/.test(closingTime) || !day || day.closedAt) return null;
  const closeAt = closingAtMs(day.date, closingTime);
  const from = closeAt - CLOSING_REMINDER_MS;
  if (now < from) return null;
  if (day.reopenedAt && day.reopenedAt >= from && now < day.reopenedAt + CLOSING_REMINDER_MS) return null;
  if (snooze && snooze.dayId === day.id && now < snooze.until) return null;
  return now < closeAt ? { kind: 'yaklasiyor', closeAt, minutesLeft: Math.max(1, Math.ceil((closeAt - now) / 60_000)) } : { kind: 'gecti', closeAt };
}

/** "Sonra"ya basılınca kart ne zamana dek gizlenir: kapanıştan önce kapanış anına dek, sonra 15 dakika */
export function snoozeUntil(phase: NonNullable<ClosingPhase>, now: number): number {
  return phase.kind === 'yaklasiyor' ? phase.closeAt : now + CLOSING_SNOOZE_AFTER_MS;
}
