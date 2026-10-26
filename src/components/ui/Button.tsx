import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'warn' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl';

// Innex (docs/ADMIN-INNEX.md §1.5): birincil dolu mavi, ikincil beyaz ve ince kenarlı, ghost yalnız metin
const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-ink hover:bg-[var(--admin-primary-hover)]',
  secondary: 'border border-[var(--admin-border-strong)] bg-surface text-ink hover:border-[var(--admin-border-field)] hover:bg-surface-2',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-3 hover:text-ink',
  outline: 'border border-[var(--admin-border-strong)] bg-surface text-ink hover:border-[var(--admin-border-field)] hover:bg-surface-2',
  danger: 'bg-danger-600 text-white hover:bg-danger-700',
  success: 'bg-success-600 text-white hover:bg-success-700',
  warn: 'border border-warn-200 bg-warn-100 text-warn-700 hover:bg-warn-200 dark:border-transparent dark:bg-warn-800 dark:text-warn-300',
};

const sizes: Record<Size, string> = {
  // Dokunmatikte en az 44 px (AGENTS.md kural 8); yönetim panelinde fareyle Innex'in 36 px'i
  sm: 'h-9 px-3 text-sm gap-1.5 rounded-lg pointer-coarse:h-11 pointer-coarse:min-w-11',
  md: 'h-11 px-4 text-[15px] gap-2 rounded-xl [[data-area=admin]_&]:text-sm [[data-area=admin]_&]:pointer-fine:h-9',
  lg: 'h-14 px-5 text-base gap-2 rounded-xl',
  xl: 'h-16 px-6 text-lg gap-3 rounded-2xl',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
  loading?: boolean;
  block?: boolean;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  icon,
  loading,
  block,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex select-none items-center justify-center font-medium transition-[background-color,border-color,transform] duration-100 active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100',
        variants[variant],
        sizes[size],
        block && 'w-full',
        className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

export function IconButton({
  label,
  className,
  variant = 'ghost',
  size = 'md',
  children,
  ...rest
}: Omit<ButtonProps, 'icon'> & { label: string }) {
  const square: Record<Size, string> = { sm: 'w-9 px-0', md: 'w-11 px-0', lg: 'w-14 px-0', xl: 'w-16 px-0' };
  return (
    <Button aria-label={label} title={label} variant={variant} size={size} className={cn(square[size], className)} {...rest}>
      {children}
    </Button>
  );
}
