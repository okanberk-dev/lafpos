/**
 * Sitenin sipariş zili (laffogato `src/lib/admin/order-alerts-core.ts`): sitenin panelinde ve köşkün bar ekranında
 * personelin tanıdığı motif. Yalnız sayılar (DOM yok; testler sabitler); çalan `src/lib/sound.ts` `ring`.
 */

/** Vurulan metal çubuğun uyumsuz üst tınıları (1 : 2,76 : 5,40), her biri daha kısık: sinüs vurulmuş gibi çalar */
export const BELL_PARTIALS: ReadonlyArray<{ ratio: number; gain: number }> = [
  { ratio: 1, gain: 1 },
  { ratio: 2.76, gain: 0.4 },
  { ratio: 5.4, gain: 0.16 },
];
/** Do6, Mi6, Sol6: parlak, yükselen üçlü ("ding ding ding") */
export const RING_NOTES_HZ: readonly number[] = [1046.5, 1318.5, 1568];
const RING_NOTE_GAP_S = 0.11;
const RING_RUN_GAP_S = 0.5;
/** Sitenin ölçtüğü çıkış zinciri: tam düzeyde tepe 0,92, kırpılan örnek yok */
export const RING_CHAIN = { masterGain: 1.7, threshold: -9, knee: 6, ratio: 6, attack: 0.002, release: 0.2 } as const;

export interface BellNote {
  /** Döngünün başından saniye */
  at: number;
  freq: number;
  /** Temel tınının tepe kazancı (düzeyden önce) */
  peak: number;
  /** Sessizliğe iniş, saniye */
  decay: number;
}

/** Motif: üç hızlı yükselen nota, iki kez; sonuncusu uzun çınlar */
export function ringMotif(): BellNote[] {
  const notes: BellNote[] = [];
  for (let run = 0; run < 2; run += 1) {
    RING_NOTES_HZ.forEach((freq, i) => {
      notes.push({ at: Number((run * RING_RUN_GAP_S + i * RING_NOTE_GAP_S).toFixed(3)), freq, peak: 0.5, decay: i === RING_NOTES_HZ.length - 1 ? 0.6 : 0.32 });
    });
  }
  return notes;
}
