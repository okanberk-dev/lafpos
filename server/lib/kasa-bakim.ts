import { getSyncState, setSyncState } from './settings';

/**
 * Kasa penceresinin bakım arası (Yönetim › Ağ ve uzaktan erişim › Bu bilgisayar): kasa bekçisi (app\kasa-yazici.ps1)
 * kapatılan kasa penceresini yeniden açmaz (#195, 28 Kas 2026, sahibin isteği; #144'ten beri 15 sn içinde açıyordu).
 * Bekçi yalnız kasa kısayolunun bıraktığı açma isteğini sunucu gelince yerine getirir. Bakım için (Windows ayarı, yazıcı
 * kurulumu, başka bir program) yetkili bu süreyi verir; bekçi bu süre boyunca pencereyi açmaz, süre bitince isteği yine
 * yerine getirir. Kalıcı kapatma yok: unutulsa da ara en geç 15 dakikada biter. Sync state `kasa.bakim`
 */
const KASA_BAKIM_KEY = 'kasa.bakim';
export const KASA_BAKIM_MS = 15 * 60_000;

export interface KasaBakim {
  until: number;
  by: string;
}

/** Süren bakım arası; yoksa ya da bittiyse null */
export function kasaBakim(now = Date.now()): KasaBakim | null {
  const s = getSyncState<KasaBakim>(KASA_BAKIM_KEY);
  return s && typeof s.until === 'number' && s.until > now ? s : null;
}

/** Bakım arasını başlatır (15 dk; yeniden basılırsa süre baştan) ya da bitirir */
export function setKasaBakim(on: boolean, by: string, now = Date.now()): KasaBakim | null {
  // Bitirmek: süre şimdiye çekilir (satır silinmez; değer boş olamaz)
  const next = { until: on ? now + KASA_BAKIM_MS : now, by };
  setSyncState(KASA_BAKIM_KEY, next);
  return on ? next : null;
}
