/** Bar ekranı ve online sipariş için kısa uyarı sesleri (WebAudio, dosya gerekmez). */
let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

/** Tarayıcılar sesi ilk dokunuştan sonra açar: ekranda bir kez çağırın. */
export function unlockAudio() {
  audio();
}

export function beep(kind: 'yeni' | 'iptal' | 'tamam' = 'yeni') {
  const a = audio();
  if (!a) return;
  const notes = kind === 'yeni' ? [880, 1320] : kind === 'iptal' ? [440, 330, 220] : [660, 990];
  notes.forEach((freq, i) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = kind === 'iptal' ? 'square' : 'sine';
    osc.frequency.value = freq;
    const start = a.currentTime + i * 0.16;
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + 0.15);
  });
}
