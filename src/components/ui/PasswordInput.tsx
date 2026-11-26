import { type ChangeEvent, type CSSProperties, forwardRef, type InputHTMLAttributes, type Ref, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { passwordStrength, STRENGTH_LABELS, type StrengthLevel } from './passwordStrength';

/**
 * Şifre kutusu (rare-ui password-input'tan): gizliyken nokta, gösterilince her karakter noktasının yerinde belirir; göz
 * düğmesi açılıp kapanır; yeni şifre alanında güç çubuğu. AsilPOS uyarlaması:
 * - **Gizliyken gerçek karakter DOM'a yazılmaz.** rare-ui karakterleri saydam bırakıyordu (sayfayı okuyan her betik
 *   şifreyi görür); burada gizliyken yalnız noktalar çizilir, karakterler yalnız "Şifreyi göster"den sonra. Alanın
 *   değeri de `value` özniteliğine yazılmaz (React denetimli alanda yazıyordu): değer yalnız alanın kendisinde.
 * - Gerçek `<input>` yerinde durur (saydam yazı): `name`, `id`, `autoComplete` aynı, parola yöneticisi ve form gönderimi
 *   bozulmaz. Tarayıcı kendisi doldurunca (otomatik doldurma) kendi noktaları görünür, kişi yazınca bu çizim devralır.
 * - Kitin alanıyla aynı görünüm (Field.tsx: kenar, odakta ev yeşili kenar ve nane hâle, hata kırmızı); 44 px dokunmatik
 *   hedef; renkler Keel belirteçlerinden (rare-ui'nin turuncusu yok).
 * - Hareket yalnız CSS ile (index.css `.pw-*`): satış ekranına hareket kütüphanesi inmez; hareket azaltmada hepsi anında.
 * - Güç çubuğu (`strength`) yalnız yeni şifre alanında: "Şifre gücü" ve "Zayıf / Orta / İyi / Güçlü".
 * Çağıranın `value` + `onChange(e)` sözleşmesi `<Input type="password">` ile aynı.
 */

export interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'size' | 'value' | 'defaultValue'> {
  value?: string;
  defaultValue?: string;
  /** Güç çubuğu: yalnız yeni şifre alanında (girişte değil) */
  strength?: boolean;
  /** Bundan kısa şifre Zayıf (ör. Uzaktan üyeliği en az 10 karakter) */
  strengthMin?: number;
  /** Güç çubuğunun başlığı; Uzaktan'ın "Parola"sında "Parola gücü" */
  strengthLabel?: string;
  /** Göz düğmesinin adı; PIN alanında "PIN'i göster" / "PIN'i gizle" */
  showLabel?: string;
  hideLabel?: string;
  /** PIN gibi kısa rakamlarda karakterler arası geniş */
  wide?: boolean;
  defaultVisible?: boolean;
}

// Göz kapalıyken kirpikler (rare-ui'nin çizgileri)
const LASHES = ['M4.4 14.6 3 16.4', 'M9 16.6 8.5 19', 'M15 16.6l.5 2.4', 'M19.6 14.6l1.4 1.8'];
const BAR = ['bg-[var(--admin-danger)]', 'bg-[var(--admin-warning)]', 'bg-[var(--admin-success)]', 'bg-[var(--admin-success)]'];

function Eye({ open }: { open: boolean }) {
  const box: CSSProperties = { transformBox: 'fill-box', transformOrigin: 'center' };
  const line = (shown: boolean): CSSProperties => ({ strokeDasharray: 1, strokeDashoffset: shown ? 0 : 1, opacity: shown ? 1 : 0 });
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="pw-eye size-5 overflow-visible">
      {/* Açık göz: badem ve bebek; kapanınca kapak iner (dikeyde ezilir) */}
      <path d="M2 12C4 7.8 7.5 5.5 12 5.5s8 2.3 10 6.5c-2 4.2-5.5 6.5-10 6.5S4 16.2 2 12Z" style={{ ...box, transform: open ? 'none' : 'scaleY(0.1)', opacity: open ? 1 : 0 }} />
      <circle cx={12} cy={12} r={3} style={{ ...box, transform: open ? 'none' : 'scale(0)' }} />
      {/* Kapalı göz: alt kapak ve kirpikler çizilerek gelir */}
      <path d="M2 12c2 3.4 5.5 5.2 10 5.2s8-1.8 10-5.2" pathLength={1} style={line(!open)} />
      {LASHES.map((d) => (
        <path key={d} d={d} pathLength={1} style={line(!open)} />
      ))}
    </svg>
  );
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}

// `#__PURE__`: kasa build'inde Uzaktan girişi ağaçtan atılınca bu modül de ana pakete inmez (kullanan ekranla gelir)
const PasswordField = /*#__PURE__*/ forwardRef<HTMLInputElement, PasswordInputProps>(function PasswordInput(
  {
    value,
    defaultValue,
    onChange,
    strength = false,
    strengthMin,
    strengthLabel = 'Şifre gücü',
    showLabel = 'Şifreyi göster',
    hideLabel = 'Şifreyi gizle',
    wide = false,
    defaultVisible = false,
    placeholder,
    disabled,
    autoComplete = 'current-password',
    className,
    id,
    onFocus,
    onBlur,
    onSelect,
    onScroll,
    'aria-describedby': describedBy,
    ...rest
  },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? `pw-${autoId}`;
  const meterId = `${inputId}-guc`;
  const input = useRef<HTMLInputElement | null>(null);
  const [own, setOwn] = useState(defaultValue ?? '');
  const [visible, setVisible] = useState(defaultVisible);
  const [focused, setFocused] = useState(false);
  const [sel, setSel] = useState({ start: 0, end: 0, scroll: 0 });
  const frame = useRef(0);
  const text = value ?? own;
  const latest = useRef(text);
  const chars = Array.from(text);
  const level: StrengthLevel = strength ? passwordStrength(text, strengthMin) : 0;

  // Değer alana özniteliksiz yazılır (bkz. üstteki not): denetimli alanda çağıranın değeri esas
  useLayoutEffect(() => {
    latest.current = text;
    const el = input.current;
    if (el && el.value !== text) el.value = text;
  }, [text]);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const read = useCallback(() => {
    const el = input.current;
    if (!el) return;
    // Seçim ofsetleri UTF-16 birimi, çizim kod noktası sayar
    const start = Array.from(el.value.slice(0, el.selectionStart ?? 0)).length;
    const end = Array.from(el.value.slice(0, el.selectionEnd ?? 0)).length;
    const scroll = el.scrollLeft;
    setSel((c) => (c.start === start && c.end === end && c.scroll === scroll ? c : { start, end, scroll }));
  }, []);
  // Hemen oku (imleç tuşla birlikte gitsin), kaydırma oturunca bir kez daha
  const sync = useCallback(() => {
    read();
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(read);
  }, [read]);

  const change = (e: ChangeEvent<HTMLInputElement>) => {
    if (value === undefined) setOwn(e.target.value);
    onChange?.(e);
    // Çağıran yazılanı süzdüyse (PIN'de yalnız rakam) ve değeri değişmediyse React yeniden çizmez: alan çağıranın
    // değerine döner
    const el = e.target;
    queueMicrotask(() => {
      if (value !== undefined && el.value !== latest.current) el.value = latest.current;
      sync();
    });
  };

  const toggle = () => {
    const el = input.current;
    const start = el?.selectionStart ?? null;
    const end = el?.selectionEnd ?? null;
    setVisible((v) => !v);
    // Tür değişince bazı tarayıcılar seçimi bırakır
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      if (el && start !== null && end !== null && document.activeElement === el) el.setSelectionRange(start, end);
      read();
    });
  };

  const cell = wide ? 'calc(1ch + 0.3em)' : '1ch';
  const caretKey = `${sel.end}:${chars.length}`;

  return (
    <div data-slot="password-input" data-visible={visible || undefined} className="w-full">
      <div
        className={cn(
          // Kitin alanı (Field.tsx base): kenar ayrı katmanda, böylece alan ve düğme dokunmatikte tam 44 px
          'group/pw relative flex h-10 w-full items-stretch rounded-xl bg-surface text-sm text-ink shadow-[var(--shadow-control)] transition-[box-shadow,background-color] duration-150 focus-within:shadow-[0_0_0_3px_var(--admin-primary-soft)] has-[input[aria-invalid=true]:focus]:shadow-[0_0_0_3px_var(--admin-danger-soft)] pointer-coarse:h-11 pointer-coarse:text-[15px] [[data-area=admin]_&]:text-sm [[data-area=admin]_&]:pointer-fine:h-9',
          disabled && 'cursor-not-allowed bg-surface-2 opacity-60 shadow-none',
          className,
        )}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 rounded-xl border border-line-strong transition-colors duration-150 group-hover/pw:border-[var(--admin-text-mute)] group-focus-within/pw:border-[var(--admin-primary)] group-has-[input[aria-invalid=true]]/pw:border-[var(--admin-danger)] [[data-invalid]_&]:border-[var(--admin-danger)]"
        />
        <span className="relative min-w-0 flex-1 font-mono">
          <input
            ref={(el) => {
              input.current = el;
              setRef(ref, el);
            }}
            {...rest}
            id={inputId}
            type={visible ? 'text' : 'password'}
            placeholder={placeholder}
            disabled={disabled}
            autoComplete={autoComplete}
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            aria-describedby={[describedBy, strength && meterId].filter(Boolean).join(' ') || undefined}
            onChange={change}
            onSelect={(e) => {
              sync();
              onSelect?.(e);
            }}
            onScroll={(e) => {
              sync();
              onScroll?.(e);
            }}
            onFocus={(e) => {
              setFocused(true);
              sync();
              onFocus?.(e);
            }}
            onBlur={(e) => {
              setFocused(false);
              onBlur?.(e);
            }}
            style={{ letterSpacing: wide ? '0.3em' : 0 }}
            className="peer absolute inset-0 size-full rounded-xl bg-transparent pl-3.5 pr-1 font-mono text-[length:inherit] text-transparent caret-transparent outline-none [-webkit-text-fill-color:transparent] selection:bg-transparent placeholder:text-transparent disabled:cursor-not-allowed autofill:shadow-[inset_0_0_0_100px_var(--admin-surface)] autofill:[-webkit-text-fill-color:var(--admin-text)] [&::-ms-reveal]:hidden"
          />
          {/* Çizim: gizliyken yalnız noktalar; karakterler yalnız gösterilince. Tarayıcı doldurduysa onun noktaları */}
          <span aria-hidden="true" data-slot="password-display" className="pointer-events-none absolute inset-y-0 left-3.5 right-1 overflow-hidden peer-autofill:hidden">
            {!text && placeholder && <span className="absolute inset-y-0 left-0 flex items-center truncate font-sans text-muted">{placeholder}</span>}
            <span className="relative flex h-full items-center" style={{ transform: `translateX(${-sel.scroll}px)` }}>
              {focused && sel.end > sel.start && (
                <span
                  className="absolute top-1/2 h-5 -translate-y-1/2 rounded bg-[color-mix(in_srgb,var(--admin-primary)_28%,transparent)]"
                  style={{ left: `calc(${sel.start} * ${cell})`, width: `calc(${sel.end - sel.start} * ${cell})` }}
                />
              )}
              {chars.map((ch, i) => (
                <span key={i} className="relative grid h-full shrink-0 place-items-center" style={{ width: cell }}>
                  <span className="pw-dot absolute size-[0.42em] rounded-full bg-current" style={{ opacity: visible ? 0 : 1, transform: visible ? 'scale(0.4)' : 'none' }} />
                  {visible && <span className="pw-char whitespace-pre">{ch}</span>}
                </span>
              ))}
              {focused && sel.start === sel.end && (
                // Yeniden kurulunca yanıp sönme baştan başlar: yazarken imleç sabit
                <span key={caretKey} className="pw-caret absolute top-1/2 -ml-px h-5 w-0.5 -translate-y-1/2 rounded-full bg-[var(--admin-primary)]" style={{ left: `calc(${sel.end} * ${cell})` }} />
              )}
            </span>
          </span>
        </span>
        <button
          type="button"
          aria-label={visible ? hideLabel : showLabel}
          aria-controls={inputId}
          disabled={disabled}
          // Odak alanda kalsın (telefonda klavye kapanmasın)
          onPointerDown={(e) => e.preventDefault()}
          onClick={toggle}
          className="relative grid w-10 shrink-0 place-items-center rounded-xl text-muted transition-colors duration-150 hover:text-ink focus-visible:-outline-offset-2 disabled:cursor-not-allowed pointer-coarse:w-11"
        >
          <Eye open={visible} />
        </button>
      </div>
      {strength && (
        // Yer baştan ayrılır (yazmaya başlayınca form kaymaz). Ad değil açıklama: alana aria-describedby ile bağlı ("Şifre gücü İyi")
        <div id={meterId} aria-hidden="true" data-level={level} className="mt-2 flex flex-col gap-1.5 px-0.5">
          <span className="flex gap-1.5">
            {STRENGTH_LABELS.map((name, i) => (
              <span key={name} className="h-1 flex-1 overflow-hidden rounded-full bg-[var(--admin-border)]">
                <span className={cn('pw-bar block h-full origin-left rounded-full', level ? BAR[level - 1] : 'bg-transparent')} style={{ transform: `scaleX(${i < level ? 1 : 0})`, transitionDelay: `${i * 40}ms` }} />
              </span>
            ))}
          </span>
          <span className="flex items-center justify-between text-xs">
            <span className="text-muted">{strengthLabel}</span>
            <span className="font-semibold text-ink">{level ? STRENGTH_LABELS[level - 1] : ''}</span>
          </span>
        </div>
      )}
    </div>
  );
});

/**
 * `labelOutside`: Field bu işareti görünce `<label>` ile yalnız etiketin yazısını sarar ve alana `for` ile bağlar. Göz
 * düğmesi etiketin içinde kalsaydı adı alanın adına karışırdı ("Parola Parolayı göster")
 */
export const PasswordInput = /*#__PURE__*/ Object.assign(PasswordField, { labelOutside: true as const });
