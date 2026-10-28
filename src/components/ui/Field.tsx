import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { cn } from '@/lib/cn';

// Alanın üç durumu: dinlenme (ince gri kenar), odak (mavi kenar ve yumuşak halka), devre dışı (soluk, zemin gri)
const base =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink placeholder:text-muted outline-none transition-[border-color,box-shadow,background-color] duration-150 hover:border-[var(--admin-text-mute)] focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60 disabled:hover:border-line-strong [[data-area=admin]_&]:text-sm';

/** Alanla aynı görünümde kullanılan tek seferlik input'lar için (dışarıdan `className` ile) */
export const fieldClass = base;

export function Label({ children, hint, className }: { children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    <span className={cn('mb-1.5 flex items-baseline justify-between gap-2 text-sm font-medium text-ink-2', className)}>
      <span>{children}</span>
      {hint && <span className="text-xs font-normal text-muted">{hint}</span>}
    </span>
  );
}

export function Field({ label, hint, error, children, className }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cn('block', className)}>
      {label && <Label hint={hint}>{label}</Label>}
      {children}
      {error && <span className="mt-1 block text-xs text-danger-500">{error}</span>}
    </label>
  );
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(base, 'h-11 [[data-area=admin]_&]:pointer-fine:h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(base, 'min-h-20 py-2.5', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(base, 'select-arrow h-11 [[data-area=admin]_&]:pointer-fine:h-10 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', className)} {...rest}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="group inline-flex min-h-11 items-center gap-3 text-[15px] disabled:cursor-not-allowed disabled:opacity-50 pointer-fine:min-h-0 [[data-area=admin]_&]:text-sm"
    >
      <span className={cn('relative h-[26px] w-11 shrink-0 rounded-full transition-colors duration-150', checked ? 'bg-primary group-hover:bg-[var(--admin-primary-hover)]' : 'bg-line-strong group-hover:bg-[var(--admin-text-mute)]')}>
        <span className={cn('absolute left-0.5 top-0.5 size-[22px] rounded-full bg-white shadow-[0_1px_2px_rgb(12_14_27/0.25)] transition-transform duration-150 ease-out motion-reduce:transition-none', checked && 'translate-x-[18px]')} />
      </span>
      {label && <span className="text-ink">{label}</span>}
    </button>
  );
}

/** Yan yana seçenek düğmeleri (ödeme türü, rapor aralığı gibi) */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div className={cn('inline-flex rounded-xl bg-surface-3 p-1', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'rounded-md font-medium transition-[color,background-color,box-shadow] duration-150 pointer-coarse:min-h-11',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-1.5 text-sm',
            value === o.value ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08),0_0_0_1px_rgb(12_14_27/0.04)]' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
