import { create } from 'zustand';

/** Bildirimlerin durumu (çizim toast.tsx'te); DOM'a dokunmaz, testler doğrudan çağırır */
export type Tone = 'ok' | 'err' | 'info' | 'warn';

/** Bildirimdeki eylem: "Geri al" gibi; basınca çalışır ve bildirim kapanır */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  action?: ToastAction;
  /** Ekranda kalma süresi (ms); üzerine gelince ya da odaktayken sayaç durur */
  duration?: number;
}

export interface Toast {
  id: number;
  tone: Tone;
  text: string;
  action?: ToastAction;
  duration: number;
  leaving?: boolean;
}

/** Okuma süresi: başarı ve bilgi kısa, uyarı orta, hata uzun (müşteriyle konuşurken kaçmasın) */
const DURATION: Record<Tone, number> = { ok: 4000, info: 4000, warn: 6000, err: 10_000 };
/** Eylemli bildirim (Geri al) en az bu kadar kalır */
const ACTION_MIN = 6000;
const LEAVE_MS = 150;

export const useToasts = create<{
  list: Toast[];
  push: (t: Omit<Toast, 'id' | 'duration'> & { duration?: number }) => number;
  /** Bildirimin eylemi en çok bir kez çalışır: kapanmakta olan (ya da kapanmış) bildirimde hiçbir şey yapmaz */
  act: (id: number) => void;
  leave: (id: number) => void;
  drop: (id: number) => void;
}>((set, get) => ({
  list: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    const duration = t.duration ?? Math.max(DURATION[t.tone], t.action ? ACTION_MIN : 0);
    set((s) => ({ list: [...s.list.filter((x) => !x.leaving).slice(-3), { ...t, id, duration }] }));
    return id;
  },
  act: (id) => {
    const t = get().list.find((x) => x.id === id);
    if (!t || t.leaving) return;
    get().leave(id);
    t.action?.run();
  },
  leave: (id) => {
    if (!get().list.some((x) => x.id === id && !x.leaving)) return;
    set((s) => ({ list: s.list.map((x) => (x.id === id ? { ...x, leaving: true } : x)) }));
    setTimeout(() => get().drop(id), LEAVE_MS);
  },
  drop: (id) => set((s) => ({ list: s.list.filter((x) => x.id !== id) })),
}));
