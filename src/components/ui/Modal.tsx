import { type ReactNode, useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';
import { topDialog, trapTab } from '@/lib/focus';
import { CloseButton } from './Button';

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
  /**
   * Başlıkta Kapat yok: kendi vazgeç düğmesi olan soru penceresi (onay, metin isteme). Aynı iş için iki denetim
   * olmaz; Escape ve arka plan yine vazgeçer
   */
  hideClose?: boolean;
  /** Başlıksız pencerenin erişilebilir adı (başlığı gövdede çizen pencere: ödeme sonucu) */
  ariaLabel?: string;
  className?: string;
}

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-lg',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-[min(1400px,100vw)] h-[100dvh] sm:h-[94dvh]',
};

/**
 * Pencere: telefonda alt sayfa, geniş ekranda ortada. Açılınca odak pencereye geçer (içindeki `autoFocus` alanı
 * zaten odaklıysa ona dokunulmaz), Tab pencerenin içinde döner, Escape yalnız en üstteki pencereyi kapatır,
 * kapanınca odak açan düğmeye döner.
 */
export function Modal({ open, onClose, title, subtitle, children, footer, size = 'md', persistent, hideClose, ariaLabel, className }: ModalProps) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descId = useId();
  // Odak ve Escape efekti yalnız açılışa bağlı: onClose (satır içi ok işlevi) ya da persistent her değişince yeniden
  // koşsaydı odak üstteki pencereden (ödeme › gerekçe) alta geri çekilirdi; güncel değerler ref'ten okunur
  const latest = useRef({ onClose, persistent });
  useEffect(() => {
    latest.current = { onClose, persistent };
  });
  // Açan öğe çizim sırasında yakalanır: içerideki autoFocus alanı odağı efektlerden önce alır
  const opener = useRef<HTMLElement | null>(null);
  const downOnBackdrop = useRef(false);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      // Odak pencere dışına düştüyse (kalkan düğme, arka plana tıklama) Tab arka sayfaya geçmez, pencereye döner
      if (e.key === 'Tab') {
        if (panel.current && topDialog() === panel.current && !panel.current.contains(e.target as Node)) {
          e.preventDefault();
          panel.current.focus();
        }
        return;
      }
      if (e.key !== 'Escape' || latest.current.persistent) return;
      // İç içe pencerede (ödeme › gerekçe) yalnız üstteki kapanır
      if (panel.current && topDialog() !== panel.current) return;
      latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const restore = opener.current;
    return () => {
      window.removeEventListener('keydown', onKey);
      if (restore?.isConnected) restore.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <div
      className="animate-fade fixed inset-0 z-50 flex items-end justify-center bg-[var(--scrim)] sm:items-center sm:p-4"
      // Arka plana dokunuş click'te kapatır (basış da arka planda başladıysa): pointerdown'da kapansa aynı dokunuşun
      // click'i alttaki öğeye (hızlı bakıştaki "Tükendi işaretle", satır) düşerdi
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget && !persistent) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-label={title ? undefined : ariaLabel}
        aria-describedby={subtitle ? descId : undefined}
        onKeyDown={(e) => trapTab(e, panel.current)}
        className={cn(
          // Pano penceresi: köşe 22, kenarsız beyaz yüzey ve derin yumuşak gölge (gecede saç teli kenar)
          'animate-in flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-[1.375rem] border border-transparent bg-surface shadow-[var(--shadow-pop)] outline-none sm:max-h-[92dvh] sm:rounded-[1.375rem] dark:border-[var(--admin-border-strong)]',
          widths[size],
          className,
        )}
      >
        {/* Telefonda alt sayfa işareti (sürüklenmez; kapatmak için Kapat ya da arka plan) */}
        <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--admin-border-field)]/50 sm:hidden" />
        {/* Başlık pencerenin tepesi: 18/700 (içerideki bölüm başlığı 16/600), kesilmez, dengeli kırılır; Kapat ilk satırda */}
        {(title || subtitle) && (
          <div className="flex items-start gap-3 border-b border-[var(--admin-divider)] px-5 pb-3.5 pt-4 sm:px-6">
            <div className="min-w-0 flex-1">
              {title && (
                <h2 id={titleId} className="font-headline text-xl font-bold leading-6 tracking-[-0.03em]">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p id={descId} className="mt-0.5 text-[13px] text-muted">
                  {subtitle}
                </p>
              )}
            </div>
            {!hideClose && <CloseButton onClick={onClose} />}
          </div>
        )}
        <div className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain', !footer && 'max-sm:pb-[env(safe-area-inset-bottom)]')}>{children}</div>
        {footer && <div className="border-t border-[var(--admin-divider)] bg-surface px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
