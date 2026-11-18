import { ArrowUpRight, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { topDialog, trapTab } from '@/lib/focus';

/**
 * Araçlar çekmecesi (gnbsite Area Board kitinin Tools çekmecesi): tam ekran espresso gecesi, kremalı dalga çizgili zemin,
 * yukarıdan perde gibi iner; satırlar iri ve sakin (büyük harf yok), üstüne gelince ve etkin ekranda sağda yeşil ok
 * halkası belirir.
 * Ekranlar, bu cihaz (tema, tam ekran) ve oturum (kilitle). Escape ve Kapat kapatır, Tab çekmecede döner, kapanınca odak
 * açan düğmeye döner. Bantta odak halkası açık yeşil (ev yeşili gecede 3:1'in sınırında)
 */
export function ToolsDrawer({ open, onClose, subtitle, children, foot }: { open: boolean; onClose: () => void; subtitle?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const restore = opener.current;
    // Odak etkin ekranın satırına (yoksa çekmeceye): klavyeyle açan kişi bulunduğu yerden devam eder
    (panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && topDialog() === panel.current) latest.current();
    };
    window.addEventListener('keydown', onKey);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      html.style.overflow = prev;
      if (restore?.isConnected) restore.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Araçlar"
      tabIndex={-1}
      onKeyDown={(e) => trapTab(e, panel.current)}
      style={{ '--focus': 'var(--band-accent)' } as CSSProperties}
      className="lp-drawer fixed inset-0 z-[60] overflow-y-auto overscroll-contain text-[var(--band-text)] outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[1480px] flex-col px-5 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] sm:px-7">
        <header className="flex items-center justify-between gap-4 pb-2 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-[var(--band-muted)]">Araçlar</p>
            {subtitle && <div className="mt-0.5 truncate text-sm text-[var(--band-text)]">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            title="Kapat"
            className="grid size-11 shrink-0 place-items-center rounded-full border border-[var(--band-line)] text-[var(--band-text)] transition-colors duration-150 hover:border-[var(--band-muted)] hover:bg-[var(--band-2)]"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>
        <div className="flex-1 pb-6">{children}</div>
        {foot && <footer className="border-t border-[var(--band-line)] py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs text-[var(--band-muted)]">{foot}</footer>}
      </div>
    </div>,
    document.body,
  );
}

/** Çekmecenin grubu: soluk küçük etiket, altında satırlar (geniş ekranda üç, tablette iki sütun, telefonda tek) */
export function DrawerGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={label} className={cn('mt-7', className)}>
      <h2 className="mb-1 font-sans text-[13px] font-semibold tracking-normal text-[var(--band-muted)]">{label}</h2>
      <div className="grid gap-x-10 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/** Çekmece satırı: iri ad, altında isteğe bağlı küçük açıklama; satırlar sırayla gecikmeli iner */
export const drawerRow =
  'lp-drawer-row group relative flex min-h-[4.25rem] w-full items-center gap-4 border-b border-[var(--band-line)] py-2 pl-0.5 pr-0.5 text-left text-[var(--band-text)] no-underline transition-[padding] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:pl-3 focus-visible:pl-3 focus-visible:-outline-offset-2';

export function DrawerLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block font-headline text-[clamp(1.375rem,2.2vw,1.875rem)] font-bold leading-tight tracking-[-0.03em]">{children}</span>
      {hint && <span className="mt-1 block text-[13px] font-normal leading-4 text-[var(--band-muted)]">{hint}</span>}
    </span>
  );
}

/** Satırın sağındaki yeşil ok halkası: üstüne gelince, odakta ve etkin ekranda belirir (kitin çekmece oku) */
export function DrawerArrow() {
  return (
    <span
      aria-hidden="true"
      className="grid size-10 shrink-0 -rotate-45 scale-0 place-items-center rounded-full bg-[var(--ok-ring)] text-[var(--ok-arrow)] transition-transform duration-300 group-hover:rotate-0 group-hover:scale-100 group-focus-visible:rotate-0 group-focus-visible:scale-100 group-aria-[current=page]:rotate-0 group-aria-[current=page]:scale-100 motion-reduce:transition-none"
    >
      <ArrowUpRight className="size-4 stroke-[2.25]" />
    </span>
  );
}
