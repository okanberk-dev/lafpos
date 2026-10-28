import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl' | 'full';
  /** Arka plana dokununca kapanmasın (ödeme gibi yarım kalmaması gereken akışlar) */
  persistent?: boolean;
  className?: string;
}

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[min(1400px,100vw)] h-[100dvh] sm:h-[94dvh]',
};

export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', persistent, className }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  // Odak ve Escape efekti yalnız açılışa bağlı: onClose (satır içi ok işlevi) ya da persistent her değişince yeniden
  // koşsaydı odak üstteki pencereden (ödeme › gerekçe) alta geri çekilirdi; güncel değerler ref'ten okunur
  const latest = useRef({ onClose, persistent });
  useEffect(() => {
    latest.current = { onClose, persistent };
  });

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !latest.current.persistent) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="animate-fade fixed inset-0 z-50 flex items-end justify-center bg-night/40 sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !persistent) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        className={cn(
          'animate-in flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-2xl border border-line bg-surface shadow-[var(--shadow-pop)] outline-none sm:max-h-[92dvh] sm:rounded-2xl',
          widths[size],
          className,
        )}
      >
        {/* Telefonda alt sayfa: tutamak, sürüklenebilir görünsün */}
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-[var(--admin-border-strong)] sm:hidden" />
        {(title || subtitle) && (
          <div className="flex items-start gap-3 border-b border-[var(--admin-divider)] px-5 py-3.5">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="truncate text-base font-semibold tracking-[-0.01em]">
                  {title}
                </h2>
              )}
              {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              aria-label="Kapat"
              className="-mr-1.5 grid size-11 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-3 hover:text-ink active:bg-[var(--admin-border)]"
            >
              <X className="size-5" />
            </button>
          </div>
        )}
        <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain', !footer && 'max-sm:pb-[env(safe-area-inset-bottom)]')}>{children}</div>
        {footer && <div className="border-t border-[var(--admin-divider)] bg-surface-2 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
