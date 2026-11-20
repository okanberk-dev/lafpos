import { useSyncExternalStore } from 'react';
import { ALERT_PREFS_DEFAULT, type AlertPrefs, parseAlertPrefs } from './siteAlerts';

export { ALERT_PREFS_DEFAULT, type AlertPrefs, parseAlertPrefs, VOLUME_STEPS, type VolumeStep, volumeStep } from './siteAlerts';

/**
 * Bu cihazın sesli uyarı tercihleri (Araçlar › Sesli uyarılar): ses açık mı, ses düzeyi, hangi uyarılar. Tarayıcıda
 * saklanır (kasa, garsonun telefonu ve bar tableti farklı ister); bütün bileşenler aynı kaydı okur, başka sekmede
 * değişince `storage` olayıyla burada da değişir. Saklanamazsa (özel pencere) bu sekmede bellekte kalır.
 *
 * Varsayılan açık: uyarı sesi zaten bu yüzden var; ayarı hiç bulmamış kişi de online siparişi duymalı (laffogato
 * `sound-pref.ts`'in kuralı). Okuma kuralı (`parseAlertPrefs`) src/lib/siteAlerts.ts'te (DOM'suz, testler çağırır).
 */

/** `useLocalPref` ile aynı önek (lafpos.pref.<ad>) */
export const ALERT_PREFS_KEY = 'lafpos.pref.siteAlerts';

const listeners = new Set<() => void>();
/** Saklanamayan tarayıcıda bu sekmenin seçimi */
let fallback: string | null = null;
/** useSyncExternalStore aynı kayıtta aynı nesneyi ister */
let cache: { raw: string | null; value: AlertPrefs } = { raw: null, value: ALERT_PREFS_DEFAULT };

function readRaw(): string | null {
  try {
    return localStorage.getItem(ALERT_PREFS_KEY) ?? fallback;
  } catch {
    return fallback;
  }
}

export function readAlertPrefs(): AlertPrefs {
  const raw = readRaw();
  if (raw !== cache.raw) cache = { raw, value: parseAlertPrefs(raw) };
  return cache.value;
}

export function writeAlertPrefs(patch: Partial<AlertPrefs>) {
  const raw = JSON.stringify({ ...readAlertPrefs(), ...patch });
  fallback = raw;
  try {
    localStorage.setItem(ALERT_PREFS_KEY, raw);
  } catch {
    /* özel pencere: bu sekmede bellekte */
  }
  for (const fn of listeners) fn();
}

export function subscribeAlertPrefs(fn: () => void): () => void {
  listeners.add(fn);
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === ALERT_PREFS_KEY) fn();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
  };
}

export function useAlertPrefs(): AlertPrefs {
  return useSyncExternalStore(subscribeAlertPrefs, readAlertPrefs, () => ALERT_PREFS_DEFAULT);
}
