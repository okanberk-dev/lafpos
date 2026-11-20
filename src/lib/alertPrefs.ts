import { useSyncExternalStore } from 'react';

/**
 * Bu cihazın sesli uyarı tercihleri (Araçlar › Sesli uyarılar): ses açık mı, ses düzeyi, hangi uyarılar. Tarayıcıda
 * saklanır (kasa, garsonun telefonu ve bar tableti farklı ister); bütün bileşenler aynı kaydı okur, başka sekmede
 * değişince `storage` olayıyla burada da değişir. Saklanamazsa (özel pencere) bu sekmede bellekte kalır.
 *
 * Varsayılan açık: uyarı sesi zaten bu yüzden var; ayarı hiç bulmamış kişi de online siparişi duymalı (laffogato
 * `sound-pref.ts`'in kuralı).
 */
export interface AlertPrefs {
  /** Bütün uyarı sesleri (kapalıyken şerit ve bildirim yine görünür) */
  sound: boolean;
  /** 0..1 */
  volume: number;
  /** Online sipariş (uygulama, web, masa QR): yeni gelince zil, siteden kalkınca sakin ses */
  online: boolean;
  /** Sitedeki karaoke rezervasyonu: yeni, iptal, saati değişen */
  karaoke: boolean;
}

export const ALERT_PREFS_DEFAULT: AlertPrefs = { sound: true, volume: 0.8, online: true, karaoke: true };

/** Ses düzeyinin üç adımı (Araçlar'daki seçim); varsayılan Orta */
export const VOLUME_STEPS = [
  { value: 'kisik', label: 'Kısık', volume: 0.35 },
  { value: 'orta', label: 'Orta', volume: 0.8 },
  { value: 'yuksek', label: 'Yüksek', volume: 1 },
] as const;
export type VolumeStep = (typeof VOLUME_STEPS)[number]['value'];

/** Kayıtlı düzeye en yakın adım */
export function volumeStep(volume: number): VolumeStep {
  let best: (typeof VOLUME_STEPS)[number] = VOLUME_STEPS[1];
  for (const s of VOLUME_STEPS) if (Math.abs(s.volume - volume) < Math.abs(best.volume - volume)) best = s;
  return best.value;
}

/** `useLocalPref` ile aynı önek (lafpos.pref.<ad>) */
export const ALERT_PREFS_KEY = 'lafpos.pref.siteAlerts';

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Saklanan metni okur; bozuk ya da eksik alan varsayılanına döner */
export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (!raw) return ALERT_PREFS_DEFAULT;
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ALERT_PREFS_DEFAULT;
    v = parsed as Record<string, unknown>;
  } catch {
    return ALERT_PREFS_DEFAULT;
  }
  const volume = typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : ALERT_PREFS_DEFAULT.volume;
  return {
    sound: bool(v.sound, ALERT_PREFS_DEFAULT.sound),
    volume,
    online: bool(v.online, ALERT_PREFS_DEFAULT.online),
    karaoke: bool(v.karaoke, ALERT_PREFS_DEFAULT.karaoke),
  };
}

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
