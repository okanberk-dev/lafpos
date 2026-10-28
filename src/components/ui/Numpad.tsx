import { Delete } from 'lucide-react';
import { cn } from '@/lib/cn';

interface NumpadProps {
  onKey: (key: string) => void;
  /** "," tuşu (tutar girişi) ya da "00" (hızlı tutar) gösterilsin mi */
  decimal?: boolean;
  doubleZero?: boolean;
  className?: string;
  size?: 'md' | 'lg';
}

/** Dokunmatik sayı tuş takımı. Tuşlar: 0-9, ",", "00", "back", "clear". */
export function Numpad({ onKey, decimal, doubleZero, className, size = 'lg' }: NumpadProps) {
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimal ? ',' : doubleZero ? '00' : 'clear', '0', 'back'];
  return (
    // Innex segment dili: gri tepsi üstünde beyaz tuşlar; sınırı kenarlık değil zemin farkı çizer, kol mesafesinden seçilir
    <div className={cn('grid grid-cols-3 gap-1.5 rounded-xl bg-surface-3 p-1.5', className)}>
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          aria-label={k === 'back' ? 'Geri sil' : undefined}
          className={cn(
            'tabular rounded-lg bg-surface font-medium text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08)] transition-[background-color,transform,box-shadow] duration-100 hover:bg-surface-2 active:scale-[0.97] active:bg-surface-2 active:shadow-none motion-reduce:active:scale-100',
            size === 'lg' ? 'h-16 text-2xl' : 'h-12 text-xl',
            k === 'clear' && 'text-[15px] text-ink-2',
          )}
        >
          {k === 'back' ? <Delete className="mx-auto size-5" /> : k === 'clear' ? 'Sil' : k}
        </button>
      ))}
    </div>
  );
}

/** Numpad tuşunu metin değerine uygular (tutar alanları için virgül ve iki hane sınırı). */
export function applyNumpadKey(value: string, key: string, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  const max = opts.maxLength ?? 9;
  if (key === 'back') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (key === ',') {
    if (!opts.decimal || value.includes(',')) return value;
    return (value || '0') + ',';
  }
  const next = value === '0' && key !== '00' ? key : value + key;
  if (opts.decimal && next.includes(',')) {
    const [, frac] = next.split(',');
    if (frac.length > 2) return value;
  }
  return next.length > max ? value : next;
}
