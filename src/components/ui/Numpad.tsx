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
    <div className={cn('grid grid-cols-3 gap-2', className)}>
      {keys.map((k) => (
        <button
          key={k}
          type="button"
          onClick={() => onKey(k)}
          className={cn(
            'rounded-2xl border border-line bg-surface font-semibold text-ink shadow-sm transition active:scale-95 active:bg-surface-3',
            size === 'lg' ? 'h-16 text-2xl' : 'h-12 text-xl',
            k === 'clear' && 'text-base text-muted',
          )}
        >
          {k === 'back' ? <Delete className="mx-auto size-6" /> : k === 'clear' ? 'Sil' : k}
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
