import { ArrowUpRight, Loader2, X } from 'lucide-react';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * Tek düğme kaynağı (kasa ve yönetim). Yönetimdeki `BTN` sınıfları da buradan türer (admin/ui.tsx). Biçim gnbsite'ın
 * Area Board kitinden: her düğme hap, ekranın tek ana eylemi mürekkep hap ve sağında yeşil ok halkası (↗, üstüne
 * gelince 45° döner; `.lp-ring`, index.css).
 *   primary        mürekkep hap + ok halkası: ekranın ana eylemi, ekranda bir tane (Kaydet, Giriş, Gönder)
 *   ink            mürekkep hap + ok halkası: ticari son adım (Öde, Ödeme, Nakit al); primary ile aynı aile
 *   secondary      beyaz hap, ince kenar; üstüne gelince kenar mürekkep (kitin .btn'i; yönetimde BTN.ghost)
 *   soft           yeşilin açık tonu, yeşil yazı: ikincil ama öne çıkan eylem ("Tümünü gör", "Değiştir")
 *   ghost          yalnız metin, zemin üzerine gelince
 *   danger         dolu kırmızı: kasada iptal, sil
 *   dangerOutline  kenarlı kırmızı yazı (yönetimde BTN.danger): sakin yıkıcı eylem
 *   dangerGhost    yalnız kırmızı metin (pencerede "İptal", "Sil ve çık")
 *   success        dolu yeşil (barda "Hepsi hazır")
 *   gold           dolu pirinç, mürekkep yazı: ödül (damga kartında Hediye içecek); amber zamanın ve uyarının
 *                  rengi, burada değil
 *   warn           amber yumuşak zemin (uyarıya bağlı eylem)
 *   outline        secondary ile aynı (eski ad)
 * Renk ve ölçü varyanttan gelir; `className` yerleşim içindir (genişlik, kenar boşluğu). Çakışan sınıfta sayfanın
 * verdiği kazanır (cn birleştirir).
 */
export type ButtonVariant = 'primary' | 'ink' | 'secondary' | 'soft' | 'ghost' | 'danger' | 'dangerOutline' | 'dangerGhost' | 'success' | 'gold' | 'warn' | 'outline';
export type ButtonSize = 'sm' | 'md' | 'lg' | 'xl';

// Dört durum: dinlenme, üzerinde, basılı (bir ton koyu), devre dışı; odak halkası index.css'te (ev yeşili, 2 px dışarıda)
const secondary =
  'border border-[var(--admin-border-strong)] bg-surface text-ink hover:border-[var(--admin-text)] active:border-[var(--admin-text)] active:bg-surface-3';
// Kitin ana düğmesi: mürekkep hap, yazı kalın; koyu temada mürekkep açık renktir (yazı koyu)
const INK = 'bg-[var(--admin-ink-fill)] font-semibold text-[var(--admin-on-ink)] hover:bg-[var(--admin-ink-fill-hover)] active:bg-[var(--admin-ink-fill-hover)] active:brightness-95';
const variants: Record<ButtonVariant, string> = {
  primary: INK,
  ink: INK,
  secondary,
  outline: secondary,
  soft: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)] hover:brightness-[0.97] active:brightness-95',
  ghost: 'border border-transparent bg-transparent text-ink-2 hover:border-[var(--admin-border-strong)] hover:bg-surface hover:text-ink active:bg-press',
  danger: 'bg-danger-600 font-semibold text-white hover:bg-danger-700 active:bg-danger-700 active:brightness-95',
  dangerOutline:
    'border border-[var(--admin-danger-line)] bg-surface text-[var(--admin-danger-ink)] hover:border-[var(--admin-danger)] hover:bg-[var(--admin-danger-soft)] active:bg-[var(--admin-danger-soft)] active:brightness-95',
  dangerGhost: 'bg-transparent text-[var(--admin-danger-ink)] hover:bg-[var(--admin-danger-soft)] active:bg-[var(--admin-danger-soft)] active:brightness-95',
  // Koyuda doygun yeşil blok barın en parlak öğesi olmasın: bir ton koyu (beyaz yazı 7:1)
  success: 'bg-success-600 font-semibold text-white hover:bg-success-700 active:bg-success-700 active:brightness-95 dark:bg-success-700 dark:enabled:hover:bg-success-600',
  // Pirinç dolgu ve üstündeki mürekkep iki temada aynı (#E8C877 üstünde #2E2113, ~10:1)
  gold: 'bg-gold-fill font-semibold text-on-gold hover:brightness-95 active:brightness-90',
  warn: 'border border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)] text-[var(--admin-warning)] hover:border-[var(--admin-warning)] active:brightness-95',
};

/**
 * Devre dışı: dolu düğme soluk saydamlık yerine gri zemin ve okunur yazı alır (çoğu zaman talimat taşır:
 * "Ödeme türü seçin"; açıkta 5.4:1). Kenarlı ve metin düğmeler yarı saydam. Yüklenirken bunlar uygulanmaz.
 */
const FILLED_DISABLED = 'disabled:border-transparent disabled:bg-surface-3 disabled:text-muted disabled:shadow-none';
const disabledStyles: Record<ButtonVariant, string> = {
  primary: FILLED_DISABLED,
  ink: FILLED_DISABLED,
  danger: FILLED_DISABLED,
  success: FILLED_DISABLED,
  gold: FILLED_DISABLED,
  secondary: 'disabled:opacity-50',
  outline: 'disabled:opacity-50',
  soft: 'disabled:opacity-50',
  ghost: 'disabled:opacity-50',
  dangerOutline: 'disabled:opacity-50',
  dangerGhost: 'disabled:opacity-50',
  warn: 'disabled:opacity-50',
};

// Dokunmatikte en az 44 px (AGENTS.md kural 8); yönetimde fareyle 36 px, "Sıkı görünüm"de 32 px. Köşe --r-btn: kasada
// kapsül (sitenin --r-btn'i), yönetim ve raporlarda 6 px dikdörtgen (kurumsal yüzey, index.css)
const COMPACT = '[[data-area=admin][data-density=compact]_&]:pointer-fine:h-8';
const sizes: Record<ButtonSize, string> = {
  sm: `h-9 px-3.5 text-sm gap-1.5 rounded-[var(--r-btn)] pointer-coarse:h-11 pointer-coarse:min-w-11 ${COMPACT}`,
  md: `h-11 px-5 text-[15px] gap-2 rounded-[var(--r-btn)] [[data-area=admin]_&]:text-sm [[data-area=admin]_&]:pointer-fine:h-9 [[data-area=admin]_&]:pointer-fine:px-4 ${COMPACT}`,
  lg: 'h-14 px-6 text-base gap-2 rounded-[var(--r-btn)]',
  xl: 'h-16 px-7 text-lg gap-3 rounded-[var(--r-btn)]',
};
/** Kare ikon düğmesi: genişlik yükseklikle aynı adımda (yönetimde fareyle 36, sıkıda 32); dar satırda daralmaz (44 px) */
const squares: Record<ButtonSize, string> = {
  sm: 'w-9 shrink-0 px-0 pointer-coarse:w-11 [[data-area=admin][data-density=compact]_&]:pointer-fine:w-8',
  md: 'w-11 shrink-0 px-0 [[data-area=admin]_&]:pointer-fine:w-9 [[data-area=admin][data-density=compact]_&]:pointer-fine:w-8',
  lg: 'w-14 shrink-0 px-0',
  xl: 'w-16 shrink-0 px-0',
};
const spinnerSize: Record<ButtonSize, string> = { sm: 'size-4', md: 'size-4', lg: 'size-5', xl: 'size-6' };
/**
 * Ok halkalı düğmenin ölçüsü: sağ pay küçülür, halka düğmenin içinde 6 px boşlukla durur (kit: 42 px düğmede 30 px
 * halka). Dokunmatikte 44, yönetimde fareyle 36, sıkı görünümde 32 px düğmeye göre
 */
const ringSizes: Record<ButtonSize, string> = {
  sm: 'pl-3.5 pr-1 gap-2.5 [--ring:1.75rem] pointer-coarse:[--ring:2rem] [[data-area=admin][data-density=compact]_&]:pointer-fine:[--ring:1.5rem]',
  md: 'pl-5 pr-1.5 gap-3 [--ring:2rem] [[data-area=admin]_&]:pointer-fine:pl-4 [[data-area=admin]_&]:pointer-fine:pr-1 [[data-area=admin]_&]:pointer-fine:[--ring:1.75rem] [[data-area=admin][data-density=compact]_&]:pointer-fine:[--ring:1.5rem]',
  lg: 'pl-6 pr-2 gap-3 [--ring:2.5rem]',
  xl: 'pl-7 pr-2 gap-4 [--ring:3rem]',
};
/** Ok halkası taşıyan varyantlar: ekranın ana eylemi ve ödeme */
const RING: ButtonVariant[] = ['primary', 'ink'];

const BASE =
  'relative inline-flex select-none items-center justify-center whitespace-nowrap font-medium transition-[background-color,border-color,color,filter,transform] duration-150 ease-out active:scale-[0.97] motion-reduce:active:scale-100 [&>svg]:shrink-0';
const DISABLED_BASE = 'disabled:cursor-not-allowed disabled:active:scale-100 disabled:active:brightness-100';

/**
 * Düğme sınıfları, `<Link>` / `<NavLink>` / `<a>` gibi düğme olmayan öğe için: `className={buttonClass('primary')}`.
 * `square` ikon düğmesi genişliği verir.
 */
export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', opts: { square?: boolean; block?: boolean; loading?: boolean; ring?: boolean; className?: string } = {}): string {
  return cn(
    BASE,
    variants[variant],
    opts.loading ? 'cursor-progress' : cn(DISABLED_BASE, disabledStyles[variant]),
    sizes[size],
    opts.ring && ringSizes[size],
    opts.square && squares[size],
    // Geniş ana düğmede yazı solda, halka sağda (kitin .btn.primary.full'ı)
    opts.block && (opts.ring ? 'w-full justify-between' : 'w-full'),
    opts.className,
  );
}

/** Ok halkası: düğmenin son çocuğu, süs (ad yazıdadır) */
export function Ring() {
  return (
    <span aria-hidden="true" className="lp-ring">
      <ArrowUpRight />
    </span>
  );
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  /** İstek sürerken: düğme kilitlenir ama soluklaşmaz, genişliği değişmez, ortada döner gösterge */
  loading?: boolean;
  block?: boolean;
  /** Ok halkası (primary ve ink'te kendiliğinden); kare ikon düğmesinde yok */
  ring?: boolean;
}

export function Button({ variant = 'secondary', size = 'md', icon, loading, block, ring, className, children, disabled, type = 'button', ...rest }: ButtonProps) {
  // Ana eylemde baştaki ikon yok (kit): yön ve anlamı halkadaki ok taşır
  const ringed = (ring ?? RING.includes(variant)) && children != null && children !== false;
  return (
    <button type={type} disabled={disabled || loading} aria-busy={loading || undefined} className={buttonClass(variant, size, { block, loading, ring: ringed, className })} {...rest}>
      {loading ? (
        <>
          {/* Etiket yerinde kalır (genişlik ve erişilebilir ad), yalnız görünmez; gösterge ortada */}
          <span className="inline-flex items-center justify-center gap-[inherit] opacity-0">
            {!ringed && icon}
            {children}
            {ringed && <Ring />}
          </span>
          <Loader2 aria-hidden="true" className={cn('absolute inset-0 m-auto animate-spin', spinnerSize[size])} />
        </>
      ) : (
        <>
          {!ringed && icon}
          {children}
          {ringed && <Ring />}
        </>
      )}
    </button>
  );
}

export function IconButton({ label, className, variant = 'ghost', size = 'md', children, ...rest }: Omit<ButtonProps, 'icon'> & { label: string }) {
  return (
    <Button aria-label={label} title={label} variant={variant} size={size} ring={false} className={cn(squares[size], className)} {...rest}>
      {children}
    </Button>
  );
}

/**
 * Pencere, çekmece ve alt sayfanın tek Kapat düğmesi: dokunmatikte 44, yönetimde fareyle 36 (sıkı görünümde 32) px,
 * ikon 20 px. Dikey eksi boşluk düğmeyi başlığın 24 px'lik ilk satırına ortalar (şerit `items-start`): uzun başlık
 * ya da alt satır kırılınca Kapat başlığın yanında kalır, şerit düğme yüzünden büyümez
 */
export function CloseButton({ onClick, label = 'Kapat', className }: { onClick: () => void; label?: string; className?: string }) {
  return (
    // Kitin kapat düğmesi: mürekkep halkalı daire; üstüne gelince dolar
    <IconButton
      label={label}
      onClick={onClick}
      variant="secondary"
      className={cn('-my-2.5 -mr-1.5 shrink-0 border-[1.5px] border-[var(--admin-text)] text-ink hover:border-[var(--admin-ink-fill)] hover:bg-[var(--admin-ink-fill)] hover:text-[var(--admin-on-ink)] [[data-area=admin]_&]:pointer-fine:-my-1.5 [[data-area=admin][data-density=compact]_&]:pointer-fine:-my-1', className)}
    >
      <X className="size-[18px]" />
    </IconButton>
  );
}
