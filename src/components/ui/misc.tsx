import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

type Tone = 'neutral' | 'green' | 'red' | 'warn' | 'pink' | 'blue' | 'violet';
// Innex durum rozeti: 6 px köşe, açık zemin üstünde koyu ton (AA, tests/design-tokens.test.ts)
const tones: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-neutral-soft)] text-ink-2',
  green: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  red: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
  warn: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  pink: 'bg-[var(--admin-hue-rose-soft)] text-[var(--admin-hue-rose)]',
  blue: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
  // Online (siteden gelen) sipariş her ekranda mor; pembe yalnız "kısmen ödendi"
  violet: 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]',
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

/**
 * Boş durum: ne olmadığını ve nasıl dolacağını söyler; ikon yumuşak kutuda. Üç boy: kart içinde `compact`
 * (küçük yuvarlak ikon, 13 px başlık), sayfa gövdesinde varsayılan, uzaktan okunan ekranda (bar) `large`
 */
export function EmptyState({
  icon,
  title,
  children,
  action,
  compact,
  large,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : large ? 'px-6 py-16' : 'px-6 py-12', className)}>
      {icon && (
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center bg-surface-3 text-muted [&>svg]:stroke-[1.5]',
            compact ? 'mb-2 size-9 rounded-full [&>svg]:size-4' : large ? 'mb-4 size-16 rounded-2xl [&>svg]:size-8' : 'mb-3 size-12 rounded-2xl [&>svg]:size-6',
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn(compact ? 'text-[13px] font-medium text-ink-2' : large ? 'text-lg font-semibold text-ink' : 'text-sm font-semibold text-ink')}>{title}</p>
      {children && <div className={cn('max-w-[32ch] text-pretty text-muted', compact ? 'mt-0.5 text-xs' : large ? 'mt-1.5 text-[15px]' : 'mt-1 text-[13px] leading-relaxed')}>{children}</div>}
      {action && <div className={compact ? 'mt-3' : 'mt-4'}>{action}</div>}
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

/**
 * KPI karosu: kasa, patron, raporlar ve müşteri kartında tek ölçek (13 px etiket, 24 px rakam; `strong` 30 px).
 * Durum zemini yalnız anlam taşıyınca (kasa farkı tuttu / tutmadı); kelime rakam yerine konmaz, ipucuya iner
 */
export function Stat({ label, value, hint, tone, strong, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad'; strong?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        'rounded-2xl border p-4',
        tone === 'bad'
          ? 'border-danger-200 bg-[var(--admin-danger-soft)] dark:border-transparent'
          : tone === 'ok'
            ? 'border-success-200 bg-[var(--admin-success-soft)] dark:border-transparent'
            : tone === 'warn'
              ? 'border-warn-200 bg-[var(--admin-warning-soft)] dark:border-transparent'
              : 'border-line bg-surface',
        className,
      )}
    >
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div className={cn('tabular mt-1 font-semibold tracking-[-0.01em]', strong ? 'text-3xl' : 'text-2xl')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/** Sayfa başlığı: Innex 18/600 ve 13 px açıklama; kasa ve yönetimde aynı ölçek (admin/ui.tsx PageHeader ile) */
export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 pb-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-[13px] text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/**
 * Sekme ve filtre çipi (bölümler, istasyonlar, sipariş listeleri): Innex "etkin satır gri ve renksiz". Seçili gri
 * zemin, diğerleri düz; sayı hapı sıfırsa gizli. Dar ekranda ray yatay kayar, çipler kırılmaz
 */
export function Tabs<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
  size = 'md',
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; count?: number; icon?: ReactNode }[];
  className?: string;
  label: string;
  size?: 'sm' | 'md';
}) {
  return (
    <div role="tablist" aria-label={label} className={cn('no-scrollbar flex gap-1 overflow-x-auto', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150 active:bg-surface-3',
              size === 'sm' ? 'min-h-9 pointer-coarse:min-h-11' : 'min-h-11 pointer-fine:min-h-9',
              on ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-surface-2 hover:text-ink',
            )}
          >
            {o.icon}
            {o.label}
            {!!o.count && (
              <span className={cn('tabular min-w-5 rounded-md px-1.5 py-px text-center text-xs font-medium', on ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08)]' : 'bg-surface-3 text-ink-2')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
