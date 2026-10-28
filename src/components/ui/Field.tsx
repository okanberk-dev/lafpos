import { AlertCircle, Search, X } from 'lucide-react';
import {
  cloneElement,
  forwardRef,
  isValidElement,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import { cn } from '@/lib/cn';

/**
 * Alanın dört durumu: dinlenme (alan kenarı, 3:1), odak (mavi kenar ve yumuşak halka), hatalı (`aria-invalid`:
 * kırmızı kenar ve halka), devre dışı (soluk, zemin gri). Hata `Field error` ile verilince alana kendiliğinden geçer.
 */
const base =
  'w-full rounded-xl border border-line-strong bg-surface px-3.5 text-[15px] text-ink placeholder:text-muted outline-none transition-[border-color,box-shadow,background-color] duration-150 hover:border-[var(--admin-text-mute)] focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)] aria-invalid:border-[var(--admin-danger)] aria-invalid:hover:border-[var(--admin-danger)] aria-invalid:focus:border-[var(--admin-danger)] aria-invalid:focus:ring-[var(--admin-danger-soft)] [[data-invalid]_&]:border-[var(--admin-danger)] disabled:cursor-not-allowed disabled:bg-surface-2 disabled:opacity-60 disabled:hover:border-line-strong [[data-area=admin]_&]:text-sm';

/** Alanla aynı görünümde kullanılan tek seferlik input'lar için (dışarıdan `className` ile) */
export const fieldClass = base;

/** Form etiketi: tek ölçek (13 px, orta kalınlık); ipucu sağda 12 px gri ("zorunlu", "boşsa sınırsız") */
export function Label({ children, hint, className }: { children: ReactNode; hint?: ReactNode; className?: string }) {
  return (
    // Dar alanda ipucu etiketi ezmez, alta iner; kısa ipucu ("5–120", "zorunlu") tek parça kalır
    <span className={cn('mb-1.5 flex flex-wrap items-baseline justify-between gap-x-2 text-[13px] font-medium text-ink-2', className)}>
      <span className="min-w-0">{children}</span>
      {hint && <span className={cn('text-xs font-normal text-muted', typeof hint === 'string' && hint.length <= 16 && 'whitespace-nowrap')}>{hint}</span>}
    </span>
  );
}

/**
 * Etiketli alan. `error` verilince alan kırmızı kenar alır, ekran okuyucuya bağlanır (`aria-invalid`,
 * `aria-describedby`) ve ileti alanın hemen altında duyurulur. `required` ipucu yoksa "zorunlu" yazar:
 * zorunlu alanı eksik formda düğme sessizce soluk kalmaz, gönderince bu ileti gösterilir.
 */
export function Field({
  label,
  hint,
  error,
  required,
  children,
  className,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  const errorId = useId();
  let control = children;
  // Alanın kendisine (Input, Select, NumberInput ya da yerli input) aria-invalid geçer; alan bir kabın içindeyse
  // kenarı sarmalayıcıdaki data-invalid boyar. Sarmalayıcı hata yokken de durur: hata çıkıp kaybolunca ağaç
  // değişmesin, alan yeniden kurulup yazarken odağı kaybetmesin
  if (error && isValidElement(children) && (typeof children.type !== 'string' || ['input', 'select', 'textarea'].includes(children.type))) {
    const el = children as ReactElement<{ 'aria-invalid'?: boolean; 'aria-describedby'?: string }>;
    control = cloneElement(el, { 'aria-invalid': true, 'aria-describedby': [el.props['aria-describedby'], errorId].filter(Boolean).join(' ') });
  }
  return (
    <label className={cn('block', className)}>
      {label && <Label hint={hint ?? (required ? 'zorunlu' : undefined)}>{label}</Label>}
      <span data-invalid={error ? '' : undefined} className="contents">
        {control}
      </span>
      {error && (
        <span id={errorId} role="alert" className="mt-1.5 flex items-start gap-1 text-[13px] leading-5 text-[var(--admin-danger-ink)]">
          <AlertCircle aria-hidden="true" className="mt-[3px] size-3.5 shrink-0" />
          {error}
        </span>
      )}
    </label>
  );
}

/** Kasa alanları müşteri verisi taşır: tarayıcı önceki müşterileri önermesin diye varsayılan `autoComplete="off"` */
export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, autoComplete = 'off', ...rest }, ref) {
  return <input ref={ref} autoComplete={autoComplete} className={cn(base, 'h-11 [[data-area=admin]_&]:pointer-fine:h-10', className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(base, 'min-h-20 py-2.5', className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(base, 'select-arrow h-11 [[data-area=admin]_&]:pointer-fine:h-10 appearance-none bg-[length:16px] bg-[right_12px_center] bg-no-repeat pr-9', className)} {...rest}>
      {children}
    </select>
  );
}

/**
 * Arama alanı (ürün, müşteri, menü, rapor): büyüteç solda, yazınca sağda "Aramayı temizle", Escape de temizler.
 * Tarayıcı geçmiş aramaları önermez, yazım denetimi yok. `label` ekran okuyucu için zorunlu (görünmez).
 */
export const SearchInput = forwardRef<
  HTMLInputElement,
  Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
    value: string;
    onChange: (v: string) => void;
    label: string;
    wrapperClassName?: string;
    /** Araç çubuğunda fareyle 36 px (yönetimde her zaman); dokunmatikte 44 kalır */
    dense?: boolean;
  }
>(function SearchInput({ value, onChange, label, className, wrapperClassName, dense, onKeyDown, ...rest }, ref) {
  // Temizle düğmesi basılınca DOM'dan kalkar: odak alana döner (body'ye düşüp yazılan kaybolmasın, Tab pencereden kaçmasın)
  const inner = useRef<HTMLInputElement | null>(null);
  const setRef = (el: HTMLInputElement | null) => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  return (
    <label className={cn('relative block min-w-0', wrapperClassName)}>
      <span className="sr-only">{label}</span>
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
      <input
        ref={setRef}
        type="search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.preventDefault();
            e.stopPropagation();
            onChange('');
          }
          onKeyDown?.(e);
        }}
        className={cn(base, 'h-11 pl-9 pr-11 [&::-webkit-search-cancel-button]:appearance-none [[data-area=admin]_&]:pointer-fine:h-9 [[data-area=admin]_&]:pointer-fine:pr-9', dense && 'pointer-fine:h-9 pointer-fine:pr-9', className)}
        {...rest}
      />
      {value && (
        <button
          type="button"
          aria-label="Aramayı temizle"
          title="Aramayı temizle"
          onClick={() => {
            onChange('');
            inner.current?.focus();
          }}
          className={cn('absolute right-0 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-xl text-muted hover:text-ink [[data-area=admin]_&]:pointer-fine:size-9', dense && 'pointer-fine:size-9')}
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      )}
    </label>
  );
});

/**
 * Sayı alanı (dakika, adet, yüzde; `decimals` ile ondalık): yazarken serbest (silinip yeniden yazılabilir), alandan çıkınca ya da
 * Enter'da sınırlara sıkıştırılıp `onCommit` çağrılır. Döndürücü oklar yok, rakam sağa yaslı.
 * `commitOnChange`: sınırlar içindeki her geçerli tuşta da `onCommit` (taslak sıkıştırılmaz). Kaydet düğmesi
 * "değişiklik var"a bağlı formda (Ayarlar) yazıp hemen Kaydet'e basınca ilk dokunuş boşa gitmesin diye.
 */
export function NumberInput({
  value,
  onCommit,
  min,
  max,
  fallback,
  commitOnChange,
  decimals = 0,
  className,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'min' | 'max'> & {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  /** Boş bırakılınca konacak değer (yoksa önceki değer) */
  fallback?: number;
  commitOnChange?: boolean;
  /** Ondalık hane (yüzde komisyon gibi); varsayılan tam sayı. Virgül ya da nokta kabul edilir, virgülle gösterilir */
  decimals?: number;
}) {
  const show = (n: number) => (decimals ? String(n).replace('.', ',') : String(n));
  const [draft, setDraft] = useState(show(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(show(value));
    // show yalnız decimals'a bağlı; değer değişince taslak yenilenir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  const parse = (text: string) => Number(text.replace(',', '.'));
  const round = (n: number) => (decimals ? Math.round(n * 10 ** decimals) / 10 ** decimals : Math.round(n));
  const commit = () => {
    const raw = draft.trim() === '' ? (fallback ?? value) : parse(draft);
    let n = Number.isFinite(raw) ? round(raw) : value;
    if (min != null) n = Math.max(min, n);
    if (max != null) n = Math.min(max, n);
    setDraft(show(n));
    if (n !== value) onCommit(n);
  };
  const change = (text: string) => {
    const next = decimals ? text.replace(/[^0-9.,]/g, '') : text.replace(/[^0-9]/g, '');
    setDraft(next);
    if (!commitOnChange || next === '') return;
    const n = parse(next);
    // Yazarken sınır dışı ara değer (ör. en az 5 iken "1") kaydedilmez; alandan çıkınca sıkıştırılır
    if (Number.isFinite(n) && n === round(n) && (min == null || n >= min) && (max == null || n <= max) && n !== value) onCommit(n);
  };
  return (
    <Input
      type="text"
      inputMode={decimals ? 'decimal' : 'numeric'}
      pattern={decimals ? undefined : '[0-9]*'}
      value={draft}
      onChange={(e) => change(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className={cn('tabular text-right', className)}
      {...rest}
    />
  );
}

/**
 * Anahtar: etiket sola yaslı (çok satırda da), isteğe bağlı 12 px ipucu ikinci satır; anahtarın kendisi üstte hizalı.
 * `block`: satır boyu, etiket solda tam genişlik, anahtar sağda (ayar listeleri, dar ekrandaki uzun metin).
 */
export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
  className,
  block,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
  className?: string;
  block?: boolean;
}) {
  const track = (
    <span className={cn('relative mt-px h-[26px] w-11 shrink-0 rounded-full transition-colors duration-150', checked ? 'bg-primary group-hover:bg-[var(--admin-primary-hover)]' : 'bg-line-strong group-hover:bg-[var(--admin-text-mute)]')}>
      <span className={cn('absolute left-0.5 top-0.5 size-[22px] rounded-full bg-white shadow-[0_1px_2px_rgb(12_14_27/0.25)] transition-transform duration-150 ease-out motion-reduce:transition-none', checked && 'translate-x-[18px]')} />
    </span>
  );
  const text = label && (
    <span className="min-w-0 flex-1 pt-[3px] leading-5 text-ink [[data-area=admin]_&]:pt-0.5">
      <span className="block">{label}</span>
      {hint && <span className="mt-0.5 block text-xs leading-4 text-muted">{hint}</span>}
    </span>
  );
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        'group inline-flex min-h-11 max-w-full items-start gap-3 text-left text-[15px] disabled:cursor-not-allowed disabled:opacity-50 pointer-fine:min-h-0 [[data-area=admin]_&]:text-sm',
        !!label && 'py-0.5',
        block && 'flex w-full justify-between',
        className,
      )}
    >
      {block ? (
        <>
          {text}
          {track}
        </>
      ) : (
        <>
          {track}
          {text}
        </>
      )}
    </button>
  );
}

/**
 * Yan yana seçenek düğmeleri (ödeme yolu, kasa sekmesi): gri ray, seçili beyaz hap; köşeler eş merkezli (ray 8,
 * boşluk 2, hap 6). Hap odağı rayın içinde çizilir (kaydırmalı ray dış halkayı kırpar). `label` grubu adlandırır.
 * Kısa etiketler tek satırda kalır, sığmazsa ray kayar. `wrap`: uzun etiketli seçenekler (yazarkasa bağlantısı ve
 * ödeme yeri) rayı tam genişlikte eşit böler, etiket kendi içinde kırılır, telefonda alt alta dizilir; hiçbiri gizli
 * kaydırıcıda kalmaz.
 */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
  size = 'md',
  label,
  wrap,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
  size?: 'sm' | 'md';
  label?: string;
  wrap?: boolean;
}) {
  return (
    <div
      role={label ? 'group' : undefined}
      aria-label={label}
      className={cn(wrap ? 'flex w-full gap-0.5 max-sm:flex-col' : 'no-scrollbar inline-flex max-w-full overflow-x-auto', 'rounded-lg bg-surface-3 p-0.5', className)}
    >
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={cn(
            'inline-flex items-center justify-center rounded-md font-medium',
            wrap ? 'min-w-0 flex-1 whitespace-normal py-1.5 text-center leading-snug max-sm:flex-auto' : 'shrink-0 whitespace-nowrap',
            'transition-[color,background-color,box-shadow] duration-150 focus-visible:-outline-offset-2 pointer-coarse:min-h-11',
            size === 'sm' ? 'min-h-7 px-2.5 text-xs' : 'min-h-9 px-3.5 text-sm [[data-area=admin]_&]:text-[13px]',
            value === o.value ? 'bg-surface text-ink shadow-[0_1px_2px_rgb(12_14_27/0.08),0_0_0_1px_rgb(12_14_27/0.04)]' : 'text-muted hover:text-ink',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
