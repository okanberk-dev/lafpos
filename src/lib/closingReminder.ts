import type { ClosingPhase } from '@shared/closing';

export { type ClosingPhase, type ClosingSnooze, closingKey, closingPhase } from '@shared/closing';

/**
 * Kapanış saati hatırlatması (sahibin isteği, 25 Kasım 2026): Ayarlar'daki kapanış saatine 30 dakika kala gün açıksa
 * gün sonu yetkisi olanın ekranında sağ altta "Gün sonu al" kartı (src/components/ClosingReminder.tsx). Ne zaman çıktığı
 * shared/closing.ts'te (patronun telefonuna giden bildirimle ortak); burada yalnız kasadaki kartın kuralları (DOM yok;
 * tests/kapanis-teslim.test.ts):
 *
 * - "Sonra" bu cihazda o gün için erteler: kapanıştan önce kapanış dakikasına dek, sonra 15 dakika.
 * - Kart ilk göründüğünde bu cihazda bir kez kısa uyarı sesi: aynı hatırlatma için ikinci kez çalmaz ("Sonra"dan dönen
 *   kart, yenilenen sayfa, ikinci sekme), yeniden açılan günde bir kez daha. Sesli uyarılar kapalıysa, ses düzeyi 0'sa
 *   ya da tarayıcı sesi henüz açmadıysa (sayfaya dokunulmadı) çalmaz; ses açılınca kart hâlâ görünüyorsa çalar.
 */

export const CLOSING_SNOOZE_KEY = 'kapanisHatirlatma';
/** Kapanış geçtikten sonra "Sonra" kartı bu kadar gizler */
export const CLOSING_SNOOZE_AFTER_MS = 15 * 60_000;
/** Bu cihazda uyarı sesinin son çaldığı hatırlatmanın kimliği (`closingKey`; `useLocalPref` öneki) */
export const CLOSING_SOUND_KEY = 'kapanisSesi';

/** "Sonra"ya basılınca kart ne zamana dek gizlenir: kapanıştan önce kapanış anına dek, sonra 15 dakika */
export function snoozeUntil(phase: NonNullable<ClosingPhase>, now: number): number {
  return phase.kind === 'yaklasiyor' ? phase.closeAt : now + CLOSING_SNOOZE_AFTER_MS;
}

/**
 * Kartın uyarı sesi şimdi çalsın mı: bu hatırlatma (`key`) için bu cihazda çalmadıysa, sesli uyarılar açık ve ses
 * düzeyi 0'dan büyükse ve tarayıcı sesi açtıysa
 */
export function closingSoundDue(key: string, lastPlayed: string | null, prefs: { sound: boolean; volume: number }, unlocked: boolean): boolean {
  return key !== lastPlayed && prefs.sound && prefs.volume > 0 && unlocked;
}
