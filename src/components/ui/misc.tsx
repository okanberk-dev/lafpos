import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'green' | 'red' | 'brass' | 'pink' | 'blue';
const tones: Record<Tone, string> = {
  neutral: 'bg-surface-3 text-ink-2',
  green: 'bg-forest-100 text-forest-700 dark:bg-forest-800 dark:text-forest-100',
  red: 'bg-burgundy-100 text-burgundy-600 dark:bg-burgundy-800 dark:text-burgundy-100',
  brass: 'bg-brass-100 text-brass-700 dark:bg-brass-700 dark:text-brass-50',
  pink: 'bg-rose-100 text-rose-700',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900 dark:text-sky-100',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={cn('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium', tones[tone], className)}>{children}</span>;
}

export function Card({ children, className, title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]', className)}>
      {(title || actions) && (
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <h3 className="min-w-0 flex-1 truncate font-semibold">{title}</h3>
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
    <div className="rounded-2xl border border-line bg-surface p-4 shadow-[var(--shadow-card)]">
      <div className="text-sm text-muted">{label}</div>
      <div className="tabular mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && (
        <div className={cn('mt-1 text-xs', tone === 'up' ? 'text-forest-500' : tone === 'down' ? 'text-burgundy-500' : 'text-muted')}>{hint}</div>
      )}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
