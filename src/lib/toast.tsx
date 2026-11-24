import { X } from 'lucide-react';
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

// Mürekkep zeminde yeşil odak halkası 3:1'in altında kalır: halka krem (koyu temada yüzen yüzeyde yine yeşil)
const NIGHT_FOCUS = '[--focus:var(--admin-on-ink)] dark:[--focus:var(--admin-primary)]';
const tones: Record<Tone, string> = {
  // Dört ton da aynı mürekkep zeminli kart; durum rengi (yeşil, kırmızı, amber) yalnız ikon karosunda: açık karo, koyu
  // işaret (mürekkepte de gecede de karo kartın zemininden belirgin, işaret karoda 4.5:1 üstü). Bilgi renksiz. Koyu
  // temada mürekkep zeminde kaybolur: yüzen yüzey
  ok: `${NIGHT_FOCUS} bg-night text-white [&_.toast-ic]:bg-success-300 [&_.toast-ic]:text-night dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&_.toast-ic]:bg-[var(--admin-success)] dark:[&_.toast-ic]:text-[var(--admin-on-ink)]`,
  err: `${NIGHT_FOCUS} bg-night text-white [&_.toast-ic]:bg-danger-300 [&_.toast-ic]:text-night dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&_.toast-ic]:bg-[var(--admin-danger-ink)] dark:[&_.toast-ic]:text-[var(--admin-on-ink)]`,
  info: `${NIGHT_FOCUS} bg-night text-white [&_.toast-ic]:bg-white/14 [&_.toast-ic]:text-white dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&_.toast-ic]:bg-[var(--admin-panel)] dark:[&_.toast-ic]:text-ink`,
  warn: `${NIGHT_FOCUS} bg-night text-white [&_.toast-ic]:bg-warn-300 [&_.toast-ic]:text-night dark:border dark:border-[var(--admin-border-strong)] dark:bg-[var(--surface-raised)] dark:text-ink dark:[&_.toast-ic]:bg-[var(--admin-warning)] dark:[&_.toast-ic]:text-[var(--admin-on-ink)]`,
};

/**
 * İkon karosunun işareti (rare-ui toast'tan): tik (oldu), çarpı (hata), ünlem (uyarı), i (bilgi). Çizgiler `pathLength`
 * 1 ile çizilerek gelir, noktalar büyüyerek (index.css `.toast-tile`); hareket azaltmada hemen yerinde
 */
function Glyph({ tone }: { tone: Tone }) {
  const draw = { className: 'draw', pathLength: 1 } as const;
  const dot = { className: 'dot', r: 1.6, fill: 'currentColor', stroke: 'none' } as const;
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className="size-4">
      {tone === 'ok' && <path {...draw} d="M6 12.5l4 4 8-9" />}
      {tone === 'err' && (
        <>
          <path {...draw} d="M7.5 7.5l9 9" />
          <path {...draw} d="M16.5 7.5l-9 9" />
        </>
      )}
      {tone === 'warn' && (
        <>
          <path {...draw} d="M12 6v7" />
          <circle {...dot} cx="12" cy="18" />
        </>
      )}
      {tone === 'info' && (
        <>
          <circle {...dot} cx="12" cy="6.25" />
          <path {...draw} d="M12 11v7" />
        </>
      )}
    </svg>
  );
}

/** Bildirim kartı (dışa açık: testler sunucuda çizer) */
export function ToastItem({ t }: { t: Toast }) {
  const leave = useToasts((s) => s.leave);
  const act = useToasts((s) => s.act);
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
      // Kart köşesi = karonun köşesi (10) + iç pay (8): köşeler eş merkezli (rare-ui kartının oranı, Keel'in 18'i)
      data-tone={t.tone}
      className={cn('pointer-events-auto flex max-w-md items-start gap-3 rounded-[var(--r-card)] p-2 text-sm font-medium shadow-[var(--shadow-pop)] md:max-w-sm', tones[t.tone], t.leaving ? 'toast-out' : 'toast-in')}
    >
      {/* İkon karosu: durum rengi yalnız burada; işaret çizilerek gelir */}
      <span aria-hidden="true" className="toast-ic toast-tile grid size-8 shrink-0 place-items-center rounded-[10px]">
        <Glyph tone={t.tone} />
      </span>
      <span className="flex min-h-8 flex-1 items-center py-1 leading-snug">{t.text}</span>
      {t.action && (
        <button
          type="button"
          tabIndex={t.leaving ? -1 : undefined}
          aria-disabled={t.leaving || undefined}
          onClick={() => act(t.id)}
          className="-my-0.5 min-h-9 shrink-0 rounded-[10px] bg-white/12 px-3 text-[13px] font-semibold transition-colors hover:bg-white/20 focus-visible:-outline-offset-2 pointer-coarse:-my-1.5 pointer-coarse:min-h-11 pointer-coarse:min-w-11 dark:bg-[var(--admin-panel)] dark:hover:bg-[var(--admin-border)]"
        >
          {t.action.label}
        </button>
      )}
      <button
        type="button"
        tabIndex={t.leaving ? -1 : undefined}
        onClick={() => leave(t.id)}
        aria-label="Kapat"
        className="-my-0.5 -mr-0.5 grid size-9 shrink-0 place-items-center rounded-[10px] opacity-70 transition-opacity hover:opacity-100 focus-visible:-outline-offset-2 pointer-coarse:-my-1.5 pointer-coarse:-mr-1.5 pointer-coarse:size-11"
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
