import { Delete } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { isTopLayer, isTypingTarget } from '@/lib/focus';
import { numpadKeyOf } from '@/lib/numpad';

export { applyNumpadKey } from '@/lib/numpad';

interface NumpadProps {
  onKey: (key: string) => void;
  /** "," tuşu (tutar girişi) ya da "00" (hızlı tutar) gösterilsin mi */
  decimal?: boolean;
  doubleZero?: boolean;
  className?: string;
  size?: 'md' | 'lg';
  /**
   * Son hücrede birincil onay tuşu (giriş ekranı: "Giriş"). Verilince alt sıra "Sil · 0 · onay" olur; "," ve "00"
   * gösterilmez. Devre dışıyken de okunur (açık mavi zemin, mavi yazı)
   */
  confirm?: { label: string; disabled?: boolean; onPress: () => void };
  /**
   * Fiziksel klavye de girsin (kasa bilgisayarı): rakamlar, "," ve sayısal tuş takımının ondalığı, Backspace, Delete,
   * Enter (`confirm` ya da `onEnter`; ikisi de yoksa Enter tuş takımında hiçbir şey yapmaz). Yazı alanı odaktayken ve
   * üstte başka pencere açıkken dinlemez
   */
  keyboard?: boolean;
  onEnter?: () => void;
}

/** Dokunmatik sayı tuş takımı. Tuşlar: 0-9, ",", "00", "back", "clear". */
export function Numpad({ onKey, decimal, doubleZero, className, size = 'lg', confirm, keyboard, onEnter }: NumpadProps) {
  const root = useRef<HTMLDivElement>(null);
  const keys = confirm ? ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'] : ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? ',' : doubleZero ? '00' : 'clear', '0', 'back'];
  useNumpadKeys({
    enabled: !!keyboard,
    root,
    decimal,
    onKey,
    onEnter: confirm ? () => !confirm.disabled && confirm.onPress() : onEnter,
  });
  return (
    // Innex segment dili: gri tepsi üstünde beyaz tuşlar; köşeler eş merkezli (tepsi 12, boşluk 4, tuş 8)
    <div ref={root} data-numpad-enter="" className={cn('grid grid-cols-3 gap-1 rounded-2xl bg-surface-3 p-1', className)}>
      {keys.map((k) => {
        if (k === 'ok' && confirm) {
          return (
            <button
              key={k}
              type="button"
              disabled={confirm.disabled}
              onClick={confirm.onPress}
              className={cn(
                'rounded-lg bg-primary text-base font-semibold text-primary-ink transition-[background-color,transform] duration-150 hover:bg-[var(--admin-primary-hover)] active:scale-[0.97] active:bg-[var(--admin-primary-hover)] motion-reduce:active:scale-100 disabled:bg-[var(--admin-primary-soft)] disabled:text-primary disabled:active:scale-100',
                size === 'lg' ? 'h-16' : 'h-12',
              )}
            >
              {confirm.label}
            </button>
          );
        }
        return (
          <button
            key={k}
            type="button"
            onClick={() => onKey(k)}
            aria-label={k === 'back' ? 'Geri sil' : undefined}
            className={cn(
              'tabular rounded-lg bg-surface font-medium text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08)] transition-[background-color,transform,box-shadow] duration-150 hover:bg-[var(--hover-solid)] active:scale-[0.97] active:bg-[var(--hover-solid)] active:shadow-none motion-reduce:active:scale-100',
              size === 'lg' ? 'h-16 text-2xl' : 'h-12 text-xl',
              k === 'clear' && 'text-[15px] text-ink-2',
            )}
          >
            {k === 'back' ? <Delete aria-hidden="true" className="mx-auto size-5" /> : k === 'clear' ? 'Sil' : k}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Tuş takımına fiziksel klavyeden giriş: 0-9 → rakam, "," ve sayısal tuş takımının ondalık tuşu → "," (`decimal`;
 * ana sıradaki "." binlik ayırıcıdır, yok sayılır), Backspace → "back", Delete → "clear", Enter → `onEnter`. Odak bir
 * yazı alanındaysa, Ctrl/⌘/Alt basılıysa ya da `root` en üst katmanda değilse (üstte onay penceresi açık) dinlemez.
 * Numpad'in `keyboard` prop'u bunu kendisi kurar; tuş takımı ekranda yokken de girilecekse (kasa açılış nakdi) sayfa
 * doğrudan çağırır.
 */
export function useNumpadKeys({
  enabled = true,
  root,
  decimal,
  onKey,
  onEnter,
}: {
  enabled?: boolean;
  root?: React.RefObject<HTMLElement | null>;
  decimal?: boolean;
  onKey: (key: string) => void;
  onEnter?: () => void;
}) {
  const latest = useRef({ onKey, onEnter, decimal });
  useEffect(() => {
    latest.current = { onKey, onEnter, decimal };
  });
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      if (root && !isTopLayer(root.current)) return;
      const { onKey: key, onEnter: enter, decimal: dec } = latest.current;
      const action = numpadKeyOf(e, dec);
      if (!action) return;
      if (action.type === 'enter') {
        // Tuş takımının kendi tuşu ya da tutar alanı (`data-numpad-enter`) farede tıklanıp odakta kaldıysa Enter onu
        // yeniden basmaz (son rakam yinelenmez: %10 → %100): onay varsa onaylar, yoksa hiçbir şey yapmaz
        const inPad = e.target instanceof Element && !!e.target.closest('[data-numpad-enter]');
        if (!enter) {
          if (inPad) e.preventDefault();
          return;
        }
        // Odaktaki başka düğmenin kendi Enter'ı (Vazgeç, Kapat) tuş takımını onaylamasın
        if ((e.target instanceof HTMLButtonElement || e.target instanceof HTMLAnchorElement) && !inPad) return;
        e.preventDefault();
        // Basılı tutulan Enter tekrar etmez (ödeme, kasa hareketi iki kez gitmesin)
        if (!e.repeat) enter();
        return;
      }
      e.preventDefault();
      if (action.type === 'key') key(action.key);
    };
    window.addEventListener('keydown', onDown);
    return () => window.removeEventListener('keydown', onDown);
  }, [enabled, root]);
}

/**
 * PIN noktaları (giriş ekranı, yetkili onayı): dolu koyu, boş gri halkalı; `min`'den sonraki isteğe bağlı haneler
 * boşken soluk. Kaç hane girildiği ekran okuyucuya söylenir.
 */
export function PinDots({ length = 6, filled, min = 4, className }: { length?: number; filled: number; min?: number; className?: string }) {
  return (
    <div role="status" aria-live="polite" aria-label={`${filled} hane girildi`} className={cn('flex justify-center gap-3', className)}>
      {Array.from({ length }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn('size-3.5 rounded-full transition-colors duration-150', i < filled ? 'bg-ink' : 'bg-surface-3 ring-1 ring-inset ring-line', i >= min && i >= filled && 'opacity-40')}
        />
      ))}
    </div>
  );
}
