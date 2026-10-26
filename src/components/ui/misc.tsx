import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'green' | 'red' | 'warn' | 'pink' | 'blue';
// Innex durum rozeti: 6 px köşe, açık zemin üstünde koyu ton (AA, tests/design-tokens.test.ts)
const tones: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-neutral-soft)] text-ink-2',
  green: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  red: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
  warn: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  pink: 'bg-[var(--admin-hue-rose-soft)] text-[var(--admin-hue-rose)]',
  blue: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface', className)}>
      {(title || actions) && (
        <header className="flex min-h-12 items-center gap-3 border-b border-[var(--admin-divider)] px-4 py-2.5">
          <h3 className="min-w-0 flex-1 truncate text-[15px] font-semibold">{title}</h3>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-muted', className)} />;
}

export function PageLoading({ label = 'Yükleniyor' }: { label?: string }) {
  return (
    <div className="grid h-full min-h-40 place-items-center text-muted">
      <div className="flex items-center gap-2 text-sm">
        <Spinner />
        {label}
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      {icon && <div className="mb-1 text-muted [&>svg]:size-10">{icon}</div>}
      <p className="font-semibold">{title}</p>
      {children && <div className="max-w-sm text-sm text-muted">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'up' | 'down' | 'flat' }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className="tabular mt-1 text-2xl font-bold tracking-tight">{value}</div>
      {hint && (
        <div className={cn('mt-1 text-xs', tone === 'up' ? 'text-brand-500' : tone === 'down' ? 'text-danger-500' : 'text-muted')}>{hint}</div>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
