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

export function PageLoading({ label = 'Yükleniyor…' }: { label?: string }) {
  return (
    <div role="status" className="grid h-full min-h-40 place-items-center text-muted">
      <div className="flex items-center gap-2 text-sm">
        <Spinner />
        {label}
      </div>
    </div>
  );
}

/** Boş durum: ne olmadığını ve nasıl dolacağını söyler; ikon yumuşak kutuda (kasa ve yönetimde aynı dil) */
export function EmptyState({ icon, title, children, action, compact }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-12')}>
      {icon && (
        <span aria-hidden="true" className="mb-3 grid size-12 place-items-center rounded-2xl bg-surface-3 text-muted [&>svg]:size-6 [&>svg]:stroke-[1.5]">
          {icon}
        </span>
      )}
      <p className="text-sm font-semibold text-ink">{title}</p>
      {children && <div className="mt-1 max-w-[32ch] text-[13px] leading-relaxed text-muted">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Yükleme iskeleti: liste ya da kart yerine duran soluk bloklar (spinner yerine; index.css .skeleton) */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton block', className)} />;
}

export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Yükleniyor" className={cn('space-y-3 p-4', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-9 rounded-lg" />
          <span className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-[46%]" />
            <Skeleton className="h-3 w-[28%]" />
          </span>
          <Skeleton className="h-3.5 w-14" />
        </div>
      ))}
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
