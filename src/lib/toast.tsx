import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { create } from 'zustand';
import { cn } from './cn';

type Tone = 'ok' | 'err' | 'info' | 'warn';
interface Toast {
  id: number;
  tone: Tone;
  text: string;
}

const useToasts = create<{ list: Toast[]; push: (t: Omit<Toast, 'id'>) => void; drop: (id: number) => void }>((set) => ({
  list: [],
  push: (t) => {
    const id = Date.now() + Math.random();
    set((s) => ({ list: [...s.list.slice(-3), { ...t, id }] }));
    setTimeout(() => set((s) => ({ list: s.list.filter((x) => x.id !== id) })), t.tone === 'err' ? 6000 : 3200);
  },
  drop: (id) => set((s) => ({ list: s.list.filter((x) => x.id !== id) })),
}));

export const toast = {
  ok: (text: string) => useToasts.getState().push({ tone: 'ok', text }),
  err: (text: string) => useToasts.getState().push({ tone: 'err', text }),
  info: (text: string) => useToasts.getState().push({ tone: 'info', text }),
  warn: (text: string) => useToasts.getState().push({ tone: 'warn', text }),
};

const icons = { ok: CheckCircle2, err: AlertTriangle, info: Info, warn: AlertTriangle };
const tones: Record<Tone, string> = {
  // Innex araç ipucu gibi koyu; durum rengi ikonda (uyarı ve hata kendi renginde)
  ok: 'bg-night text-white [&>svg:first-child]:text-success-300 dark:bg-surface-3 dark:text-ink',
  err: 'bg-danger-600 text-white',
  info: 'bg-night text-white dark:bg-surface-3 dark:text-ink',
  warn: 'border border-warn-200 bg-warn-100 text-warn-700 dark:border-transparent dark:bg-warn-800 dark:text-warn-300',
};

export function Toaster() {
  const list = useToasts((s) => s.list);
  const drop = useToasts((s) => s.drop);
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-4 sm:bottom-6">
      {list.map((t) => {
        const Icon = icons[t.tone];
        return (
          <div key={t.id} className={cn('animate-in pointer-events-auto flex max-w-md items-start gap-3 rounded-xl px-4 py-3 text-sm font-medium shadow-[var(--shadow-pop)]', tones[t.tone])}>
            <Icon className="mt-0.5 size-4 shrink-0" />
            <span className="flex-1 leading-snug">{t.text}</span>
            <button onClick={() => drop(t.id)} aria-label="Kapat" className="opacity-70 hover:opacity-100">
              <X className="size-4" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
