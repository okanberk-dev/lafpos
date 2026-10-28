import { ChevronRight, MoreHorizontal, X } from 'lucide-react';
import { type CSSProperties, type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Yönetim paneli kiti: Innex (docs/ADMIN-INNEX.md §1.5), laffogato'nun `src/components/admin/ui`
 * sınıflarıyla aynı ölçüler. Dokunmatikte her hedef 44 px, farede 36 px, "Sıkı görünüm"de 32 px.
 * Telefonda (md altı) tablo satır kartına, çekmece alt sayfaya döner.
 */

/* Odak halkası her yerde aynı (index.css :focus-visible): 2 px birincil, 2 px dışarıda; burada yalnız açıkça yazılır */
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--admin-primary)]';
const COMPACT_H = 'pointer-fine:[[data-density=compact]_&]:min-h-8';

const BUTTON_BASE = `inline-flex min-h-11 items-center justify-center gap-2 rounded-lg py-1.5 text-sm font-medium whitespace-nowrap transition-[color,background-color,border-color,filter,transform] duration-150 active:scale-[0.98] motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 disabled:active:scale-100 disabled:active:brightness-100 pointer-fine:min-h-9 [&>svg]:shrink-0 ${COMPACT_H} ${FOCUS}`;

export const BTN = {
  primary: `${BUTTON_BASE} bg-[var(--admin-primary)] px-3.5 text-[var(--admin-on-primary)] hover:bg-[var(--admin-primary-hover)] active:brightness-95 disabled:bg-[var(--admin-panel)] disabled:text-[var(--admin-text-mute)] disabled:opacity-100`,
  ghost: `${BUTTON_BASE} border border-[var(--admin-border-strong)] bg-[var(--admin-surface)] px-3 text-[var(--admin-text)] hover:border-[var(--admin-border-field)] hover:bg-[var(--admin-surface-2)] active:bg-[var(--admin-panel)]`,
  soft: `${BUTTON_BASE} bg-[var(--admin-primary-soft)] px-3 text-[var(--admin-primary)] hover:brightness-95 active:brightness-90`,
  danger: `${BUTTON_BASE} border border-[var(--admin-danger)]/35 bg-[var(--admin-surface)] px-3 text-[var(--admin-danger-ink)] hover:border-[var(--admin-danger)] hover:bg-[var(--admin-danger)] hover:text-white active:brightness-95`,
  icon: `${BUTTON_BASE} size-11 shrink-0 border border-[var(--admin-border-strong)] bg-[var(--admin-surface)] text-[var(--admin-text-soft)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-text)] active:bg-[var(--admin-panel)] pointer-fine:size-9`,
  menu: `flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-[var(--admin-text)] hover:bg-[var(--admin-surface-2)] focus-visible:bg-[var(--admin-surface-2)] focus-visible:outline-none disabled:opacity-50 pointer-fine:min-h-9 ${COMPACT_H}`,
  menuDanger: `flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm text-[var(--admin-danger-ink)] hover:bg-[var(--admin-danger-soft)] focus-visible:bg-[var(--admin-danger-soft)] focus-visible:outline-none pointer-fine:min-h-9 ${COMPACT_H}`,
} as const;

/** Satırda tekrar eden küçük denetim (⋯, metin eylemi): sakin, dokunmatikte 44 px, farede 32 px */
export const ROW_ICON = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-[var(--admin-text-mute)] transition-colors hover:bg-[var(--admin-panel)] hover:text-[var(--admin-text)] pointer-fine:min-h-8 pointer-fine:min-w-8 ${FOCUS}`;

export const CARD = 'rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)]';
export const LABEL = 'text-xs font-medium text-[var(--admin-text-mute)]';
export const NUM = 'tabular-nums';

export type Tone = 'neutral' | 'primary' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-neutral-soft)] text-[var(--admin-text-soft)]',
  primary: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
  accent: 'bg-[var(--admin-accent-soft)] text-[var(--admin-accent-ink)]',
  info: 'bg-[var(--admin-info-soft)] text-[var(--admin-info)]',
  success: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  warning: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  danger: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
};

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-text-mute)]',
  primary: 'bg-[var(--admin-primary)]',
  accent: 'bg-[var(--admin-accent)]',
  info: 'bg-[var(--admin-info)]',
  success: 'bg-[var(--admin-success)]',
  warning: 'bg-[var(--admin-warning)]',
  danger: 'bg-[var(--admin-danger)]',
};

import type { Hue } from './hues';

export type { Hue };
const HUE: Record<Hue, string> = {
  blue: 'bg-[var(--admin-hue-blue-soft)] text-[var(--admin-hue-blue)]',
  amber: 'bg-[var(--admin-hue-amber-soft)] text-[var(--admin-hue-amber)]',
  rose: 'bg-[var(--admin-hue-rose-soft)] text-[var(--admin-hue-rose)]',
  violet: 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]',
  green: 'bg-[var(--admin-hue-green-soft)] text-[var(--admin-hue-green)]',
};

/** Durum rozeti: açık zemin üstünde renkli metin, köşe 6, 22 px */
export function Badge({ tone = 'neutral', dot, children, className, title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex min-h-[22px] items-center gap-1.5 rounded-md px-2 py-0.5 text-xs font-medium leading-4 whitespace-nowrap', TONE_SOFT[tone], className)}>
      {dot && <span aria-hidden="true" className={cn('size-1.5 rounded-full', TONE_DOT[tone])} />}
      {children}
    </span>
  );
}

/** Renkli ikon kutusu (KPI hücresi, hızlı bakış satırı, komut paleti) */
export function IconBox({ hue = 'blue', children, size = 'md' }: { hue?: Hue; children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'inline-grid shrink-0 place-items-center rounded-lg',
        size === 'sm' ? 'size-6 [&>svg]:size-3.5' : size === 'lg' ? 'size-10 [&>svg]:size-5' : 'size-7 [&>svg]:size-4',
        HUE[hue],
      )}
    >
      {children}
    </span>
  );
}

/** Sayfa başlığı şeridi: solda başlık ve açıklama, sağda önce ikincil sonra birincil düğme; kart boyu çizgi */
export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="-mx-4 mb-5 border-b border-[var(--admin-border)] px-4 pb-4 sm:-mx-5 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-[-0.01em] text-[var(--admin-text)]">{title}</h1>
          {description && <p className="mt-0.5 max-w-[72ch] text-[13px] text-[var(--admin-text-mute)]">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 sm:shrink-0 sm:justify-end max-sm:[&>*]:flex-1">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, bodyClassName, flush }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClassName?: string; flush?: boolean }) {
  return (
    <section className={cn(CARD, 'min-w-0', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 pt-4 sm:px-5">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[15px] font-semibold leading-6 tracking-[-0.01em] text-[var(--admin-text)]">{title}</h2>}
            {subtitle && <p className="text-xs text-[var(--admin-text-mute)]">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(flush ? (title || actions ? 'pt-3' : '') : 'p-4 sm:p-5 pointer-fine:[[data-density=compact]_&]:p-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface KpiCell {
  key: string;
  label: string;
  icon: ReactNode;
  hue: Hue;
  value: ReactNode;
  /** Değişim hapı: iyi haber yeşil, kötü haber kırmızı */
  delta?: { text: string; good: boolean } | null;
  /** Hiçbir rakam tek başına durmaz: dün, geçen hafta, toplam... */
  reference?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}

/** KPI şeridi: tek kart, hücreler arasında 1 px çizgi (kartın grisi 1 px boşluktan görünür) */
export function KpiStrip({ cells, className }: { cells: KpiCell[]; className?: string }) {
  const cols = cells.length >= 5 ? 'md:grid-cols-3 xl:grid-cols-5' : cells.length === 4 ? 'md:grid-cols-4' : 'md:grid-cols-3';
  return (
    <div className={cn('grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-[var(--admin-border)] bg-[var(--admin-border)]', cols, '[&>*:last-child:nth-child(odd)]:max-md:col-span-2', className)}>
      {cells.map((c) => {
        const body = (
          <>
            <span className="flex items-center gap-2">
              <IconBox hue={c.hue}>{c.icon}</IconBox>
              <span className="min-w-0 truncate text-[13px] font-medium text-[var(--admin-text-soft)]">{c.label}</span>
            </span>
            <span className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className={cn('text-2xl font-bold tracking-[-0.02em] text-[var(--admin-text)]', NUM)}>{c.value}</span>
              {c.delta && <Badge tone={c.delta.good ? 'success' : 'danger'}>{c.delta.text}</Badge>}
            </span>
            {c.reference && <span className="mt-1 block text-xs text-[var(--admin-text-mute)]">{c.reference}</span>}
          </>
        );
        const cls = cn('block min-w-0 bg-[var(--admin-surface)] p-4 text-left', c.active && 'bg-[var(--admin-primary-soft)]/60 shadow-[inset_0_-2px_0_var(--admin-primary)]');
        return c.onClick ? (
          <button key={c.key} type="button" onClick={c.onClick} aria-pressed={c.active} className={cn(cls, 'transition-colors hover:bg-[var(--admin-surface-2)]', FOCUS)}>
            {body}
          </button>
        ) : (
          <div key={c.key} className={cls}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

export interface TabOption<T extends string> {
  value: T;
  label: ReactNode;
  count?: number;
}

/** Durum sekmeleri: Innex kutu çipleri, etkin olan koyu kenarlı, sayaç gri (etkinde koyu) */
export function StatusTabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: TabOption<T>[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <div className="inline-flex min-w-max gap-1.5 sm:min-w-0 sm:flex-wrap">
        {tabs.map((t) => {
          const on = t.value === value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => onChange(t.value)}
              className={cn(
                'inline-flex min-h-9 items-center gap-1.5 rounded-lg border bg-[var(--admin-surface)] px-2.5 text-[13px] whitespace-nowrap transition-[color,border-color] pointer-coarse:min-h-11',
                COMPACT_H,
                FOCUS,
                on ? 'border-[var(--admin-text)] font-semibold text-[var(--admin-text)]' : 'border-[var(--admin-border)] font-medium text-[var(--admin-text-soft)] hover:border-[var(--admin-border-field)] hover:text-[var(--admin-text)]',
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={cn('min-w-5 rounded-md px-1.5 py-px text-center text-xs font-medium leading-4', NUM, on ? 'bg-[var(--admin-text)] text-[var(--admin-surface)]' : 'bg-[var(--admin-panel)] text-[var(--admin-text-soft)]')}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Segment denetimi: gri ray, seçili beyaz hap (dönem, görünüm) */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; className?: string }) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('no-scrollbar inline-flex max-w-full overflow-x-auto rounded-lg bg-[var(--admin-panel)] p-0.5', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex min-h-9 shrink-0 items-center justify-center rounded-md px-3 text-[13px] font-medium whitespace-nowrap transition-colors pointer-coarse:min-h-11',
              COMPACT_H,
              FOCUS,
              on ? 'bg-[var(--admin-surface)] text-[var(--admin-text)] shadow-[0_1px_2px_rgba(12,14,27,0.08),0_0_0_1px_rgba(12,14,27,0.04)]' : 'text-[var(--admin-text-mute)] hover:text-[var(--admin-text)]',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Kabın dışına taşan açılır katman: tetikleyicinin altında (yer yoksa üstünde), sabit konumda, portalda */
function usePopoverPosition(open: boolean, anchor: React.RefObject<HTMLElement | null>, width = 224) {
  const [style, setStyle] = useState<CSSProperties>({});
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const place = () => {
      const r = anchor.current!.getBoundingClientRect();
      const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
      const below = window.innerHeight - r.bottom;
      setStyle(below > 260 || below > r.top ? { position: 'fixed', left, top: r.bottom + 4, width } : { position: 'fixed', left, bottom: window.innerHeight - r.top + 4, width });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, anchor, width]);
  return style;
}

export interface MenuItem {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

/** Satır eylemleri (⋯). Menü köşe 10 px, hafif gölge; Escape ve dışarı tıklama kapatır, oklar gezdirir. */
export function ActionMenu({ items, label, trigger }: { items: MenuItem[]; label: string; trigger?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const style = usePopoverPosition(open, btn);
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const onDown = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        btn.current?.focus();
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const list = [...(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const i = list.indexOf(document.activeElement as HTMLButtonElement);
        list[(i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length]?.focus();
      }
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={btn}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className={trigger ? BTN.ghost : cn(ROW_ICON, open && 'bg-[var(--admin-panel)] text-[var(--admin-text)]')}
      >
        {trigger ?? <MoreHorizontal className="size-4" />}
      </button>
      {open &&
        createPortal(
          <div ref={menu} role="menu" style={style} className="z-[60] rounded-[10px] border border-[var(--admin-border)] bg-[var(--admin-surface)] p-1 shadow-[var(--shadow-pop)]">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  it.onSelect();
                }}
                className={it.danger ? BTN.menuDanger : BTN.menu}
              >
                {it.icon && <span className="shrink-0 [&>svg]:size-4">{it.icon}</span>}
                {it.label}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right' | 'center';
  width?: string;
  className?: string;
  /** Telefondaki satır kartında gösterilmez */
  hideOnPhone?: boolean;
  /** Tablette sığmayan ikincil sütun: bu genişliğin altında gizlenir */
  hideBelow?: 'lg' | 'xl';
}

const hideCls = (c: { hideBelow?: 'lg' | 'xl' }) => (c.hideBelow === 'lg' ? 'hidden lg:table-cell' : c.hideBelow === 'xl' ? 'hidden xl:table-cell' : '');

const alignCls = (a?: Column<unknown>['align']) => (a === 'right' ? 'text-right' : a === 'center' ? 'text-center' : 'text-left');
const fromControl = (e: MouseEvent) => !!(e.target as HTMLElement).closest('button, a, input, select, textarea, label, [role="switch"], [role="menu"]');

/**
 * Innex tablosu: kart içinde, başlık satırı soluk kuyuda 13 px gri, satır ayracı #F2F2F2, son sütun
 * yapışkan eylem. Telefonda satır kartı: başlık ve rozet, altında ikincil satır, sağda eylem menüsü.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onOpen,
  selectedKey,
  actions,
  caption,
  empty,
  phoneTitle,
  phoneMeta,
  phoneAside,
  rowClassName,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  onOpen?: (row: T) => void;
  selectedKey?: string | null;
  /** Son sütundaki eylemler (genelde ActionMenu) */
  actions?: (row: T) => ReactNode;
  caption: string;
  empty?: ReactNode;
  phoneTitle?: (row: T) => ReactNode;
  phoneMeta?: (row: T) => ReactNode;
  phoneAside?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | false | undefined;
}) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Kayıt yok" />}</>;
  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      <div className="hidden overflow-x-auto md:block" data-overflow-ok>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="bg-[var(--admin-surface-2)]">
              {columns.map((c) => (
                <th key={c.key} scope="col" style={c.width ? { width: c.width } : undefined} className={cn('h-10 px-4 text-[13px] font-medium whitespace-nowrap text-[var(--admin-text-mute)]', alignCls(c.align), hideCls(c), c.className)}>
                  {c.header}
                </th>
              ))}
              {actions && <th scope="col" className="sticky right-0 w-14 bg-[var(--admin-surface-2)] px-2"><span className="sr-only">Eylemler</span></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const k = rowKey(r);
              const selected = selectedKey === k;
              return (
                <tr
                  key={k}
                  aria-selected={onOpen ? selected : undefined}
                  onClick={onOpen ? (e) => !fromControl(e) && onOpen(r) : undefined}
                  className={cn('group border-t border-[var(--admin-divider)]', onOpen && 'cursor-pointer', selected ? 'bg-[var(--admin-primary-soft)]/50' : 'hover:bg-[var(--admin-surface-2)]', rowClassName?.(r))}
                >
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn('px-4 py-3 align-middle pointer-fine:[[data-density=compact]_&]:py-2', alignCls(c.align), hideCls(c), c.className)}>
                      {i === 0 && onOpen ? (
                        <button type="button" onClick={() => onOpen(r)} className={cn('flex w-full items-center rounded text-left pointer-coarse:min-h-11', FOCUS)}>
                          {c.cell(r)}
                        </button>
                      ) : (
                        c.cell(r)
                      )}
                    </td>
                  ))}
                  {actions && (
                    <td className={cn('sticky right-0 px-2 text-right shadow-[-10px_0_10px_-10px_rgba(12,14,27,0.18)]', selected ? 'bg-[var(--admin-primary-soft)]' : 'bg-[var(--admin-surface)] group-hover:bg-[var(--admin-surface-2)]')}>{actions(r)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-[var(--admin-divider)] md:hidden" aria-label={caption}>
        {rows.map((r) => {
          const k = rowKey(r);
          const body = (
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-start gap-2">
                <span className="min-w-0 flex-1 font-medium text-[var(--admin-text)]">{(phoneTitle ?? columns[0].cell)(r)}</span>
                {phoneAside && <span className={cn('shrink-0 text-sm font-semibold', NUM)}>{phoneAside(r)}</span>}
              </span>
              {phoneMeta ? (
                <span className="text-xs text-[var(--admin-text-mute)]">{phoneMeta(r)}</span>
              ) : (
                <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--admin-text-mute)]">
                  {columns
                    .slice(1)
                    .filter((c) => !c.hideOnPhone)
                    .map((c) => (
                      <span key={c.key} className="inline-flex items-center gap-1">
                        {c.header}: <span className="text-[var(--admin-text-soft)]">{c.cell(r)}</span>
                      </span>
                    ))}
                </span>
              )}
            </span>
          );
          return (
            <li key={k} className={cn('flex items-center gap-1 pr-1', selectedKey === k && 'bg-[var(--admin-primary-soft)]/50', rowClassName?.(r))}>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(r)} className={cn('flex min-h-16 min-w-0 flex-1 items-center gap-2 py-3 pl-4 text-left', FOCUS)}>
                  {body}
                  {!actions && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-text-mute)]" />}
                </button>
              ) : (
                <div className="flex min-h-16 min-w-0 flex-1 items-center py-3 pl-4">{body}</div>
              )}
              {actions && <div className="shrink-0">{actions(r)}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Boş durum: ne olmadığını ve nasıl dolacağını söyler. Kartın içindeyse `bare` (iç içe kart olmaz). */
export function EmptyState({ icon, title, children, action, bare }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode; bare?: boolean }) {
  return (
    <div className={cn(!bare && CARD, 'flex flex-col items-center gap-2 text-center', bare ? 'px-4 py-8' : 'px-6 py-12')}>
      {icon && <IconBox hue="blue" size="lg">{icon}</IconBox>}
      <p className="mt-1 text-[15px] font-semibold text-[var(--admin-text)]">{title}</p>
      {children && <div className="max-w-sm text-[13px] text-[var(--admin-text-mute)]">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Hızlı bakış çekmecesi: geniş ekranda sağdan, telefonda alttan; karartma %20 */
export function QuickLook({ open, onClose, title, subtitle, children, footer, label }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; label: string }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="absolute inset-0 bg-[#0c0e1b]/20" aria-hidden="true" onPointerDown={onClose} />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="animate-in absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-2xl border border-[var(--admin-border)] bg-[var(--admin-surface)] shadow-[var(--shadow-pop)] outline-none md:inset-y-2 md:left-auto md:right-2 md:max-h-none md:w-[min(460px,calc(100vw-1rem))] md:rounded-xl"
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-[var(--admin-border-strong)] md:hidden" aria-hidden="true" />
        <div className="flex items-start gap-3 border-b border-[var(--admin-border)] px-4 py-3 sm:px-5">
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold text-[var(--admin-text)]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-xs text-[var(--admin-text-mute)]">{subtitle}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Kapat" className={ROW_ICON}>
            <X className="size-4" />
          </button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-4 sm:px-5">{children}</div>
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--admin-border)] px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-5">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Gri kap içinde beyaz işlem satırları (hızlı bakış): renkli ikon kutusu, etiket, sağda değer ya da › */
export function ActionRows({ children }: { children: ReactNode }) {
  return <div className="space-y-1.5 rounded-xl bg-[var(--admin-panel)] p-1.5">{children}</div>;
}

export function ActionRow({ icon, hue = 'blue', label, value, onClick, danger, disabled }: { icon: ReactNode; hue?: Hue; label: ReactNode; value?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  const inner = (
    <>
      <IconBox hue={danger ? 'rose' : hue}>{icon}</IconBox>
      <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', danger ? 'text-[var(--admin-danger-ink)]' : 'text-[var(--admin-text)]')}>{label}</span>
      {value != null && <span className="shrink-0 text-[13px] text-[var(--admin-text-mute)]">{value}</span>}
      {onClick && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-text-mute)]" />}
    </>
  );
  const cls = 'flex min-h-12 w-full items-center gap-3 rounded-lg bg-[var(--admin-surface)] px-3 py-2 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} disabled={disabled} className={cn(cls, 'transition-colors hover:bg-[var(--admin-surface-2)] disabled:opacity-50', FOCUS)}>
      {inner}
    </button>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

export interface TimelineItem {
  key: string;
  tone: Tone;
  icon: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  time: ReactNode;
  meta?: ReactNode;
}

/** Zaman çizelgesi (denetim kaydı): kesikli dikey çizgi, türüne göre açık tonlu ikon dairesi, sağda saat */
export function Timeline({ items }: { items: TimelineItem[] }) {
  return (
    <ol className="relative">
      {items.map((it, i) => (
        <li key={it.key} className="relative flex gap-3 pb-5 last:pb-0">
          {i < items.length - 1 && <span aria-hidden="true" className="absolute bottom-0 left-[15px] top-8 border-l border-dashed border-[var(--admin-border-field)]/60" />}
          <span aria-hidden="true" className={cn('relative z-[1] grid size-8 shrink-0 place-items-center rounded-full [&>svg]:size-4', TONE_SOFT[it.tone])}>
            {it.icon}
          </span>
          <div className="min-w-0 flex-1 pt-1">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
              <p className="text-sm font-semibold text-[var(--admin-text)]">{it.title}</p>
              <span className={cn('text-xs text-[var(--admin-text-mute)]', NUM)}>{it.time}</span>
            </div>
            {it.description && <p className="mt-0.5 text-[13px] text-[var(--admin-text-soft)]">{it.description}</p>}
            {it.meta && <div className="mt-1.5">{it.meta}</div>}
          </div>
        </li>
      ))}
    </ol>
  );
}

/** Etiket solda, değer sağda satırı (kayıt özetleri) */
export function DefRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--admin-divider)] py-2.5 text-sm last:border-0">
      <span className="shrink-0 whitespace-nowrap text-[var(--admin-text-mute)]">{label}</span>
      <span className="min-w-0 text-right font-medium text-[var(--admin-text)]">{children}</span>
    </div>
  );
}

/** Liste araç çubuğu: büyüteçli arama ve satırın kendi denetimleri tek satırda */
export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return (
    <label className="relative block min-w-0 basis-full sm:max-w-xs sm:flex-1 sm:basis-auto">
      <span className="sr-only">{label}</span>
      <svg aria-hidden="true" viewBox="0 0 24 24" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--admin-text-mute)]" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn('h-11 w-full rounded-lg border border-[var(--admin-border-field)]/60 bg-[var(--admin-surface)] pl-9 pr-3 text-sm text-[var(--admin-text)] placeholder:text-[var(--admin-text-mute)] pointer-fine:h-9', FOCUS)}
      />
    </label>
  );
}
