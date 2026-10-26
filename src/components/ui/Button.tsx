import { Loader2 } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'brass' | 'outline';
type Size = 'sm' | 'md' | 'lg' | 'xl';

const variants: Record<Variant, string> = {
  primary: 'bg-primary text-primary-ink hover:brightness-110 active:brightness-95',
  secondary: 'bg-surface-2 text-ink hover:bg-surface-3 border border-line',
  ghost: 'bg-transparent text-ink-2 hover:bg-surface-2',
  outline: 'bg-surface text-ink border border-line-strong hover:bg-surface-2',
  danger: 'bg-burgundy-600 text-white hover:bg-burgundy-500 active:bg-burgundy-700',
  success: 'bg-forest-500 text-white hover:bg-forest-400',
  brass: 'bg-brass-500 text-espresso hover:bg-brass-400',
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
        'inline-flex select-none items-center justify-center font-medium transition-[filter,background-color,transform] duration-100 active:scale-[0.98] disabled:opacity-45 disabled:active:scale-100',
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
