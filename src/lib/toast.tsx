import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from './cn';
import { type Toast, type ToastOptions, type Tone, useToasts } from './toastStore';

export type { ToastAction, ToastOptions } from './toastStore';

/**
 * Kısa geri bildirim. `toast.ok('Ayarlar kaydedildi')`; geri alınabilen eylemde onay penceresi yerine:
 *   toast.ok('3 ürün silindi', { action: { label: 'Geri al', run: () => cart.restore(saved) } })
 * Dönen kimlikle erken kapatılır: `toast.dismiss(id)`.
 */
export const toast = {
  ok: (text: string, opts?: ToastOptions) => useToasts.getState().push({ tone: 'ok', text, ...opts }),
  err: (text: string, opts?: ToastOptions) => useToasts.getState().push({ tone: 'err', text, ...opts }),
  info: (text: string, opts?: ToastOptions) => useToasts.getState().push({ tone: 'info', text, ...opts }),
  warn: (text: string, opts?: ToastOptions) => useToasts.getState().push({ tone: 'warn', text, ...opts }),
  dismiss: (id: number) => useToasts.getState().leave(id),
};

const icons = { ok: CheckCircle2, err: AlertTriangle, info: Info, warn: AlertTriangle };
// Mürekkep zeminde yeşil odak halkası 3:1'in altında kalır: halka krem (koyu temada yüzen yüzeyde yine yeşil)
const NIGHT_FOCUS = '[--focus:var(--admin-on-ink)] dark:[--focus:var(--admin-primary)]';
const tones: Record<Tone, string> = {
  // Dört ton da aynı mürekkep zeminli hap; durum rengi (yeşil, kırmızı, amber) yalnız ikonda, bilgi renksiz. Koyu
  // temada mürekkep zeminde kaybolur: yüzen yüzey
  ok: `${NIGHT_FOCUS} bg-night text-white [&>svg:first-child]:text-success-300 dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&>svg:first-child]:text-[var(--admin-success)]`,
  err: `${NIGHT_FOCUS} bg-night text-white [&>svg:first-child]:text-danger-300 dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&>svg:first-child]:text-[var(--admin-danger)]`,
  info: `${NIGHT_FOCUS} bg-night text-white dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink`,
  warn: `${NIGHT_FOCUS} bg-night text-white [&>svg:first-child]:text-warn-300 dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&>svg:first-child]:text-[var(--admin-warning)]`,
};

function ToastItem({ t }: { t: Toast }) {
  const leave = useToasts((s) => s.leave);
  const act = useToasts((s) => s.act);
  const Icon = icons[t.tone];
  // Sayaç üzerine gelince ve odaktayken durur, ayrılınca kalan süreyle sürer
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const remaining = useRef(t.duration);
  const startedAt = useRef(0);
  const holds = useRef({ hover: false, focus: false });
  const run = () => {
    if (timer.current || holds.current.hover || holds.current.focus) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => leave(t.id), Math.max(800, remaining.current));
  };
  const pause = () => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current -= Date.now() - startedAt.current;
  };
  const hold = (k: 'hover' | 'focus', on: boolean) => {
    holds.current[k] = on;
    if (on) pause();
    else run();
  };
  useEffect(() => {
    run();
    return () => {
      // Söküm sonrası yeniden kurulumda (StrictMode) run() yeni sayaç kurabilsin
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      onPointerEnter={() => hold('hover', true)}
      onPointerLeave={() => hold('hover', false)}
      onFocus={() => hold('focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) hold('focus', false);
      }}
      // Kapanırken (150 ms) dokunuşu yine bildirim alır, hiçbir şey olmaz: act() ve leave() kapanmakta olanı yok sayar
      // ("Geri al"a çift dokunuş eylemi iki kez çalıştırmaz). inert ya da pointer-events-none dokunuşu alttaki ürüne,
      // pencerenin arka planına geçirirdi
      className={cn('pointer-events-auto flex max-w-md items-start gap-3 rounded-2xl px-4 py-3 text-sm font-medium shadow-[var(--shadow-pop)] md:max-w-sm', tones[t.tone], t.leaving ? 'toast-out' : 'toast-in')}
    >
      <Icon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 leading-snug">{t.text}</span>
      {t.action && (
        <button
          type="button"
          tabIndex={t.leaving ? -1 : undefined}
          aria-disabled={t.leaving || undefined}
          onClick={() => act(t.id)}
          className="-my-1.5 min-h-8 shrink-0 rounded-full px-2 text-sm font-semibold underline-offset-2 hover:underline focus-visible:-outline-offset-2 pointer-coarse:-my-3 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        tabIndex={t.leaving ? -1 : undefined}
        onClick={() => leave(t.id)}
        aria-label="Kapat"
        className="-my-2 -mr-2 grid size-9 shrink-0 place-items-center rounded-full opacity-70 transition-opacity hover:opacity-100 focus-visible:-outline-offset-2 pointer-coarse:-my-3 pointer-coarse:size-11"
      >
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}

export function Toaster() {
  const list = useToasts((s) => s.list);
  const calm = list.filter((t) => t.tone === 'ok' || t.tone === 'info');
  const urgent = list.filter((t) => t.tone === 'err' || t.tone === 'warn');
  return (
    // Telefonda alt sekmenin üstü (başparmak): sekme çubuğu 57 px artı ev çubuğu payı, bildirim 72 px artı aynı pay
    // (ev çubuklu iPhone'da da sekme ikonlarının hapına binmez). Ekranın altında `data-action-bar` işaretli eylem
    // şeridi varsa bildirim o şeridin de üstünde durur: şeridin boyunu bilen ekran onu html'de `--action-bar-h` yazar
    // (adisyon: hızlı işlemler ve bir ya da iki satırlık eylem şeridi, telefonda sepet çubuğu; ölçülür), bilmeyen için
    // 6rem (Roller ve yetkiler'in kaydetme şeridi). Hesap yazdır, Gönder ve Öde örtülmez. Tablet ve bilgisayarda
    // üst orta: başlık solda, eylemler sağda, orta boş (sağ üst arama kutusunu, sayfa düğmelerini ve tam ekran
    // pencerenin Kapat'ını örtmesin). İki canlı bölge: başarı ve bilgi sırayı bekler, hata ve uyarı hemen okunur
    <div className="pointer-events-none fixed inset-x-0 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-md:[html:has([data-action-bar])_&]:bottom-[calc(4.5rem+var(--action-bar-h,6rem)+env(safe-area-inset-bottom))] z-[60] flex flex-col items-center gap-2 px-4 md:bottom-auto md:top-3">
      <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-2">
        {urgent.map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </div>
      <div role="status" aria-live="polite" className="flex w-full flex-col items-center gap-2">
        {calm.map((t) => (
          <ToastItem key={t.id} t={t} />
        ))}
      </div>
    </div>
  );
}
