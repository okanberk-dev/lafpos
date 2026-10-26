import { X } from 'lucide-react';
import { type ReactNode, useEffect, useRef } from 'react';
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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !persistent) onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus?.();
    };
  }, [open, onClose, persistent]);

  if (!open) return null;
  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-espresso/45 backdrop-blur-[2px] sm:items-center sm:p-4"
      onPointerDown={(e) => {
        if (e.target === e.currentTarget && !persistent) onClose();
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        className={cn(
          'animate-in flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-3xl bg-surface shadow-[var(--shadow-pop)] outline-none sm:max-h-[92dvh] sm:rounded-3xl',
          widths[size],
          className,
        )}
      >
        {(title || subtitle) && (
          <div className="flex items-start gap-3 border-b border-line px-5 py-4">
            <div className="min-w-0 flex-1">
              {title && <h2 className="truncate text-lg font-semibold">{title}</h2>}
              {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
            </div>
            <button
              onClick={onClose}
              aria-label="Kapat"
              className="-mr-1 grid size-10 place-items-center rounded-full text-muted hover:bg-surface-2"
            >
              <X className="size-5" />
            </button>
          </div>
        )}
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">{children}</div>
        {footer && <div className="border-t border-line bg-surface-2/60 px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
