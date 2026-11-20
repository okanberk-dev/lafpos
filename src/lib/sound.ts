/**
 * Uyarı sesleri (WebAudio, dosya gerekmez): bar ekranı ve kasanın kısa sesleri (`beep`) ve diğer sistemlerden gelen
 * online siparişin zili (`ring`). Zil sitenin panelindeki (laffogato `/admin`) ve köşkün bar ekranındaki zille aynı
 * motif: personel onu tanıyor (laffogato `src/components/admin/order-alert-sound.ts`, `order-alerts-core.ts`).
 *
 * Tarayıcı sesi ancak sayfaya bir dokunuştan sonra açar: kabuk ilk dokunuşta `unlockAudio` çağırır
 * (src/components/SiteInbox.tsx); o andan sonra sekme arkadayken de çalar.
 */
let ctx: AudioContext | null = null;
/** Zilin çıkışı: ana kazanç → sıkıştırıcı → hoparlör (üst üste binen notalar yüksek ama kırpılmadan) */
let ringOut: GainNode | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const fn of listeners) fn();
};

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      ctx = new Ctor();
      ctx.addEventListener?.('statechange', notify);
    }
    if (ctx.state === 'suspended') void ctx.resume().then(notify, () => undefined);
    return ctx;
  } catch {
    return null;
  }
}

/** Tarayıcılar sesi ilk dokunuştan sonra açar: dokunuşta (pointerdown, keydown, "Sesi dene") çağırın. */
export function unlockAudio(): Promise<boolean> {
  const a = audio();
  if (!a) return Promise.resolve(false);
  if (a.state === 'running') return Promise.resolve(true);
  return a.resume().then(
    () => {
      notify();
      return audioUnlocked();
    },
    () => false,
  );
}

/** Ses çalabiliyor mu (bağlam çalışıyor); dokunuştan önce false */
export function audioUnlocked(): boolean {
  return ctx?.state === 'running';
}

/** Kilit durumu değişince haber (useSyncExternalStore için) */
export function onAudioChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Üstel geçiş sıfıra inemez: sessizlik */
const FLOOR = 0.0001;

/**
 * Kısa ses. `yeni` iki yükselen nota, `iptal` üç inen kare dalga, `tamam` iki nota, `tek` tek sakin nota (siteden kalkan
 * sipariş, saati değişen rezervasyon). `volume` 0..1 (cihazın ses düzeyi; verilmezse tam)
 */
export function beep(kind: 'yeni' | 'iptal' | 'tamam' | 'tek' = 'yeni', volume = 1) {
  if (!(volume > 0)) return;
  const a = audio();
  if (!a) return;
  const notes = kind === 'yeni' ? [880, 1320] : kind === 'iptal' ? [440, 330, 220] : kind === 'tek' ? [660] : [660, 990];
  const peak = Math.max(FLOOR * 2, 0.25 * Math.min(1, volume));
  notes.forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = kind === 'iptal' ? 'square' : 'sine';
    osc.frequency.value = freq;
    const start = a.currentTime + i * 0.16;
    const length = kind === 'tek' ? 0.32 : 0.14;
    gain.gain.setValueAtTime(FLOOR, start);
    gain.gain.exponentialRampToValueAtTime(peak, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(FLOOR, start + length);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + length + 0.01);
  });
}

// ─── Zil (sitenin sipariş zili) ─────────────────────────────────────────────

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
/** Sitenin ölçtüğü zincir: tam düzeyde tepe 0,92, kırpılan örnek yok */
const RING_CHAIN = { masterGain: 1.7, threshold: -9, knee: 6, ratio: 6, attack: 0.002, release: 0.2 } as const;

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

function ringOutput(a: AudioContext): GainNode {
  if (ringOut && ringOut.context === a) return ringOut;
  const comp = a.createDynamicsCompressor();
  comp.threshold.value = RING_CHAIN.threshold;
  comp.knee.value = RING_CHAIN.knee;
  comp.ratio.value = RING_CHAIN.ratio;
  comp.attack.value = RING_CHAIN.attack;
  comp.release.value = RING_CHAIN.release;
  comp.connect(a.destination);
  const master = a.createGain();
  master.gain.value = RING_CHAIN.masterGain;
  master.connect(comp);
  ringOut = master;
  return master;
}

/**
 * Bir kez zil (`level` 0..1: cihazın ses düzeyi çarpı masa siparişinde 1, diğerinde 0,8). Ses açılmamışsa (dokunuş
 * yok) çalmaz ve false döner; her hata sessiz.
 */
export function ring(level = 1): boolean {
  if (!(level > 0)) return false;
  const a = audio();
  if (!a || a.state !== 'running') return false;
  try {
    const out = ringOutput(a);
    const t0 = a.currentTime + 0.03;
    for (const note of ringMotif()) {
      const start = t0 + note.at;
      for (const partial of BELL_PARTIALS) {
        const decay = note.decay / Math.sqrt(partial.ratio);
        const peak = Math.max(FLOOR * 2, note.peak * partial.gain * Math.min(1, level));
        const osc = a.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(note.freq * partial.ratio, start);
        const gain = a.createGain();
        gain.gain.setValueAtTime(FLOOR, start);
        gain.gain.exponentialRampToValueAtTime(peak, start + 0.004);
        gain.gain.exponentialRampToValueAtTime(FLOOR, start + decay);
        osc.connect(gain);
        gain.connect(out);
        osc.start(start);
        osc.stop(start + decay + 0.02);
      }
    }
    return true;
  } catch {
    return false;
  }
}
