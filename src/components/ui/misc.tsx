import { AlertTriangle, CheckCircle2, Info, Loader2, RotateCcw, WifiOff } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef } from 'react';
import { ApiError, errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { Illustration, type IllustrationName } from '../Illustration';
import { Button } from './Button';
import { initialsInk } from './initials';

export { initialsInk };

/**
 * Rozet tonu. Kasa adları (green, red, warn, pink, blue, violet) ile yönetim adları (success, danger, warning,
 * accent, primary, info) aynı tonlara çözülür; yeni kodda anlam adı yazın. primary ev yeşilidir (success ile aynı:
 * olumlu, eklenen); accent violet'in eşi, yalnız online sipariş.
 */
export type BadgeTone = 'neutral' | 'green' | 'red' | 'warn' | 'pink' | 'blue' | 'violet' | 'success' | 'danger' | 'warning' | 'info' | 'accent' | 'primary';
type Tone = BadgeTone;
// Durum rozeti: hap biçimi, açık zemin üstünde koyu ton (AA, tests/design-tokens.test.ts). Mavi durum mavisidir (dolu,
// hazırlanıyor, bilgi); mürekkep (ödeme eylemi) rozette kullanılmaz
const tones: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-neutral-soft)] text-ink-2',
  green: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  red: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
  warn: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  pink: 'bg-[var(--admin-hue-rose-soft)] text-[var(--admin-hue-rose)]',
  blue: 'bg-[var(--admin-blue-soft)] text-[var(--admin-blue)]',
  // Online (siteden gelen) sipariş her ekranda mor; pembe yalnız "kısmen ödendi"
  violet: 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]',
  success: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  danger: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
  warning: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  info: 'bg-[var(--admin-info-soft)] text-[var(--admin-info)]',
  accent: 'bg-[var(--admin-accent-soft)] text-[var(--admin-accent-ink)]',
  primary: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
};
const dots: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-text-mute)]',
  green: 'bg-[var(--admin-success)]',
  red: 'bg-[var(--admin-danger)]',
  warn: 'bg-[var(--admin-warning)]',
  pink: 'bg-[var(--admin-hue-rose)]',
  blue: 'bg-[var(--admin-blue)]',
  violet: 'bg-[var(--admin-hue-violet)]',
  success: 'bg-[var(--admin-success)]',
  danger: 'bg-[var(--admin-danger)]',
  warning: 'bg-[var(--admin-warning)]',
  info: 'bg-[var(--admin-info)]',
  accent: 'bg-[var(--admin-accent)]',
  primary: 'bg-[var(--admin-primary)]',
};

/** Durum rozeti (kasa ve yönetimde tek): 22 px, hap, 12 px yazı; `dot` renkli nokta (renk yazının yanında) */
export function Badge({ tone = 'neutral', dot, children, className, title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn('inline-flex min-h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium leading-4', tones[tone], className)}>
      {dot && <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', dots[tone])} />}
      {children}
    </span>
  );
}

/**
 * Boy çipi (ayardaki ad: Orta, Büyük): ürün adının yanında çerçeveli hap; sepet, raporlar, patron ve genel bakışta
 * tek; satır sonuna tek başına düşmez. Ad boşsa (tek boylu ürün) çizilmez
 */
export function SizeTag({ children, className }: { children?: ReactNode; className?: string }) {
  if (!children) return null;
  return <span className={cn('ml-1.5 inline-block shrink-0 whitespace-nowrap rounded-full border border-line px-1.5 align-[2px] text-[11px] font-medium leading-4 text-ink-2', className)}>{children}</span>;
}

/**
 * Baş harf avatarı (personel, kabuk, giriş ekranı): kişinin renginde daire, adın ilk iki harfi; harf beyaz ya
 * da gece mürekkebi, hangisi o zeminde okunursa (`initialsInk`). Boy `className`'den ('size-7 text-[11px]',
 * 'size-11 text-sm'); `children` üstüne biner (durum noktası). Süstür: adı yanındaki yazı söyler
 */
export function Avatar({ name, color, className, children }: { name: string; color: string; className?: string; children?: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className={cn('relative grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold ring-1 ring-inset ring-black/5 dark:ring-white/15', className)}
      style={{ background: color, color: initialsInk(color) }}
    >
      {name.slice(0, 2).toLocaleUpperCase('tr-TR')}
      {children}
    </span>
  );
}

/**
 * Kasa kartı: başlık şeridi ve altında çizgi (`divided`, varsayılan; içerik çoğu zaman satır listesi). Çizgisiz
 * Innex başlığı için `divided={false}`: o zaman içerik kendi üst boşluğunu verir.
 */
export function Card({ children, className, title, subtitle, actions, divided = true }: { children: ReactNode; className?: string; title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; divided?: boolean }) {
  return (
    <section className={cn('rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]', className)}>
      {(title || actions) && (
        <header className={cn('flex min-h-[52px] items-center gap-3 px-4', divided ? 'border-b border-[var(--admin-divider)] py-2.5' : 'pb-1 pt-4')}>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[15px] font-semibold leading-6">{title}</h3>
            {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 aria-hidden="true" className={cn('size-5 animate-spin text-muted', className)} />;
}

/**
 * Sayfa yükleniyor: yerel sunucuda çoğu istek 20-50 ms sürer, gösterge `delay` (ms, varsayılan 300) dolmadan
 * görünmez (yanıp sönmesin). Öğe hemen DOM'dadır; yalnız görünürlüğü gecikir. Metin "…" ile biter.
 */
export function PageLoading({ label = 'Yükleniyor…', delay = 300 }: { label?: string; delay?: number }) {
  return (
    <div role="status" className="grid h-full min-h-40 place-items-center text-muted">
      <div className={cn('flex items-center gap-2 text-sm', delay > 0 && 'animate-delayed')} style={delay > 0 ? ({ '--delay': `${delay}ms` } as CSSProperties) : undefined}>
        <Spinner />
        {label}
      </div>
    </div>
  );
}

/**
 * Boş durum: ne olmadığını ve nasıl dolacağını söyler; ikon gri kutuda (boşluk vurgulanmaz) ya da `art` ile sitenin
 * çizimi (fiş, boş fincan tabağı, kek standı…). Üç boy: kart içinde `compact`, sayfa gövdesinde varsayılan, uzaktan
 * okunan ekranda (bar) `large`. Eylem: ilk kullanımda birincil düğme, süzgeçte ghost. Yönetimdeki EmptyState
 * (admin/ui.tsx) bunu sarar.
 */
export function EmptyState({
  icon,
  art,
  title,
  children,
  action,
  compact,
  large,
  className,
}: {
  icon?: ReactNode;
  /** Simge yerine sitenin çizimi */
  art?: IllustrationName;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  compact?: boolean;
  large?: boolean;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : large ? 'px-6 py-16' : 'px-6 py-12', className)}>
      {art ? (
        <Illustration name={art} className={cn(compact ? 'mb-3 size-16' : large ? 'mb-5 size-32' : 'mb-4 size-24')} />
      ) : icon && (
        <span
          aria-hidden="true"
          className={cn(
            'grid place-items-center bg-surface-3 text-muted',
            compact ? 'mb-2.5 size-9 rounded-lg [&>svg]:size-4' : large ? 'mb-4 size-16 rounded-2xl [&>svg]:size-8' : 'mb-3 size-11 rounded-xl [&>svg]:size-5',
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn('text-balance font-headline text-ink', compact ? 'text-[15px] font-semibold' : large ? 'text-xl font-bold' : 'text-base font-bold')}>{title}</p>
      {children && <div className={cn('max-w-[36ch] text-pretty text-muted', compact ? 'mt-0.5 text-[13px]' : large ? 'mt-1.5 text-[15px]' : 'mt-1 text-[13px] leading-relaxed')}>{children}</div>}
      {action && <div className={compact ? 'mt-3' : 'mt-4'}>{action}</div>}
    </div>
  );
}

/**
 * Veri alınamadı: boş durumla aynı iskelet ve aynı yazı ölçeği (üç boy: kart içinde `compact`, sayfada varsayılan,
 * tam ekranda ya da uzaktan okunan ekranda `large`), renk yalnız ikonda. "Sipariş yok" yerine bunu göster: bağlantı
 * koptuğunda sahte boşluk yanlış karar verdirir. Ağ hatasında WifiOff, sunucu hatasında üçgen; ileti
 * `errorMessage(error)`. Sayfa kalıbı:
 *   if (q.isPending) return <iskelet />;
 *   if (q.isError && !q.data) return <ErrorState title="Siparişler alınamadı" error={q.error} onRetry={() => q.refetch()} />;
 */
export function ErrorState({
  title,
  error,
  children,
  onRetry,
  retrying,
  action,
  compact,
  large,
  className,
}: {
  title: ReactNode;
  error?: unknown;
  /** İletinin yerine açıklama (ör. kurulum adımı) */
  children?: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  /** Yeniden denemenin yanında ikinci eylem (ör. Çıkış) */
  action?: ReactNode;
  compact?: boolean;
  large?: boolean;
  className?: string;
}) {
  const network = error instanceof ApiError && error.status === 0;
  const Icon = network ? WifiOff : AlertTriangle;
  return (
    <div role="alert" className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : large ? 'px-6 py-16' : 'px-6 py-12', className)}>
      <span
        aria-hidden="true"
        className={cn(
          'grid place-items-center bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
          compact ? 'mb-2.5 size-9 rounded-lg [&>svg]:size-4' : large ? 'mb-4 size-16 rounded-2xl [&>svg]:size-8' : 'mb-3 size-11 rounded-xl [&>svg]:size-5',
        )}
      >
        <Icon />
      </span>
      <p className={cn('text-balance font-headline text-ink', compact ? 'text-[15px] font-semibold' : large ? 'text-xl font-bold' : 'text-base font-bold')}>{title}</p>
      {(children || error != null) && (
        <div className={cn('max-w-[36ch] text-pretty text-muted', compact ? 'mt-0.5 text-[13px]' : large ? 'mt-1.5 text-[15px]' : 'mt-1 text-[13px] leading-relaxed')}>{children ?? errorMessage(error)}</div>
      )}
      {(onRetry || action) && (
        <div className={cn('flex flex-wrap items-center justify-center gap-2', compact ? 'mt-3' : 'mt-4')}>
          {onRetry && (
            // Tam ekranda tek büyük eylem; kart ve sayfada sayfanın ikinci eylemiyle (`action`, sm) aynı boy
            <Button size={large ? 'md' : 'sm'} icon={<RotateCcw className="size-4" />} loading={retrying} onClick={onRetry}>
              Yeniden dene
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}

export type NoticeTone = 'warn' | 'danger' | 'info' | 'success';
const noticeTones: Record<NoticeTone, { box: string; icon: string; Icon: typeof Info }> = {
  warn: { box: 'border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)]', icon: 'text-[var(--admin-warning)]', Icon: AlertTriangle },
  danger: { box: 'border-[var(--admin-danger-line)] bg-[var(--admin-danger-soft)]', icon: 'text-[var(--admin-danger-ink)]', Icon: AlertTriangle },
  info: { box: 'border-[var(--admin-info-line)] bg-[var(--admin-info-soft)]', icon: 'text-[var(--admin-info)]', Icon: Info },
  success: { box: 'border-[var(--admin-success-line)] bg-[var(--admin-success-soft)]', icon: 'text-[var(--admin-success)]', Icon: CheckCircle2 },
};

/**
 * Uyarı kutusu (gün açılmadı, yetkili onayı, bağlantı koptu): yumuşak zemin, durum çizgisi, metin mürekkepte, renk
 * ikonda (Innex rozet dili). Her iki temada tek tarif; `dark:` yaması gerekmez. `action` sağda (ör. "Günü aç").
 * Kalıcı bir durumu anlatır; anlık sonuç için toast.
 */
export function Notice({ tone = 'warn', icon, title, action, children, className, role }: { tone?: NoticeTone; icon?: ReactNode; title?: ReactNode; action?: ReactNode; children?: ReactNode; className?: string; role?: 'status' | 'alert' | 'note' }) {
  const t = noticeTones[tone];
  return (
    <div role={role} className={cn('flex items-start gap-3 rounded-xl border px-4 py-3 text-sm text-ink', t.box, className)}>
      <span aria-hidden="true" className={cn('mt-0.5 shrink-0 [&>svg]:size-4', t.icon)}>
        {icon ?? <t.Icon />}
      </span>
      <div className="min-w-0 flex-1 leading-5">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5 text-ink-2')}>{children}</div>}
      </div>
      {action && <div className="-my-1 shrink-0 self-center">{action}</div>}
    </div>
  );
}

/** Yükleme iskeleti: liste ya da kart yerine duran soluk bloklar (spinner yerine; index.css .skeleton) */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cn('skeleton block', className)} />;
}

export function ListSkeleton({ rows = 4, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Yükleniyor…" className={cn('space-y-3 p-4', className)}>
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
 * Gösterim rakamının sığması (Stat, yönetimdeki KPI şeridi): rakam tek satırdır (eksi işareti ayrı satıra düşmez) ve
 * karodan taşmaz. Karo `@container`; rakam karonun iç genişliğinin %17'sine kadar küçülür (sınıf
 * `text-[length:min(28px,var(--fit,17cqi))]`): 390 px telefonun iki sütunlu karosunda ₺113.250,00 ve -₺12.480,00
 * sığar, geniş karoda boy değişmez, aynı ızgaradaki karolar aynı boyda kalır. 11 karakterden uzun değer (₺1.250.000,00,
 * "312 sa 45 dk") yalnız kendisi biraz daha küçülür: uzun tutar Gabarito kalında karakter başına ~0,5 em, karonun
 * %95'ine sığar.
 */
export function fitFigure(value: ReactNode): CSSProperties | undefined {
  const length = typeof value === 'string' || typeof value === 'number' ? String(value).length : 0;
  return length > 11 ? ({ '--fit': `${(190 / length).toFixed(2)}cqi` } as CSSProperties) : undefined;
}

/**
 * KPI karosu: kasa, patron, raporlar ve müşteri kartında tek ölçek (13 px etiket, Gabarito 28 px rakam; `strong` 34
 * px, dar karoda `fitFigure` ile küçülür). Durum zemini yalnız anlam taşıyınca (kasa farkı tuttu / tutmadı); kelime
 * rakam yerine konmaz, ipucuya iner. Tonlu karonun kenarı durum çizgisi (iki temada da görünür)
 */
export function Stat({ label, value, hint, tone, strong, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: 'ok' | 'warn' | 'bad'; strong?: boolean; className?: string }) {
  return (
    <div
      className={cn(
        '@container rounded-2xl border p-4 shadow-[var(--shadow-card)]',
        tone === 'bad'
          ? 'border-[var(--admin-danger-line)] bg-[var(--admin-danger-soft)]'
          : tone === 'ok'
            ? 'border-[var(--admin-success-line)] bg-[var(--admin-success-soft)]'
            : tone === 'warn'
              ? 'border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)]'
              : 'border-line bg-surface',
        className,
      )}
    >
      <div className="text-[13px] font-medium text-muted">{label}</div>
      <div
        style={fitFigure(value)}
        className={cn('tabular mt-1.5 whitespace-nowrap font-headline font-bold leading-none tracking-[-0.02em]', strong ? 'text-[length:min(34px,var(--fit,17cqi))]' : 'text-[length:min(28px,var(--fit,17cqi))]')}
      >
        {value}
      </div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

/**
 * Sayfa başlığı: Gabarito 22/700 (telefonda 20) ve 13 px açıklama; kasa ve yönetimde aynı ölçek (admin/ui.tsx PageHeader ile).
 * `compactOnPhone`: telefonda (md altı) başlık ve açıklama yalnız ekran okuyucuda; ekranın adını kabuğun üst şeridi
 * zaten yazar (yönetimdeki PageHeader gibi); eylem yoksa alt boşluk da kalkar
 */
export function PageHeader({ title, subtitle, actions, compactOnPhone }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; compactOnPhone?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-3 pb-4 sm:flex-row sm:flex-wrap sm:items-end', compactOnPhone && !actions && 'max-md:pb-0')}>
      {/* Başlığın taban genişliği 18rem: eylemler sığmazsa alt satıra iner, açıklama düğmelerin yanında dar sütuna ezilmez */}
      <div className={cn('min-w-0 sm:flex-[1_1_18rem]', compactOnPhone && 'max-md:sr-only')}>
        <h1 className="text-xl font-bold sm:text-[22px]">{title}</h1>
        {subtitle && <p className="mt-0.5 text-pretty text-[13px] text-muted">{subtitle}</p>}
      </div>
      {/* Telefonda eylemler kendi satırında, eşit genişlikte; geniş ekranda sağda */}
      {actions && <div className="flex flex-wrap items-center gap-2 max-sm:[&>*]:flex-1">{actions}</div>}
    </div>
  );
}

/** Rayın kenar payı: seçili öğe kenara bu kadar yaklaşmaz, solma da bu genişlikte (RAIL_FADE) */
const RAIL_EDGE = 24;

/**
 * Yatay kayan ray (sekme, filtre çipi, segment): dönen ref kaydırılan öğeye (rayın kendisi) verilir, sınıfına
 * `RAIL_FADE` eklenir. Seçim değişince (ve açılışta) seçili öğe (`aria-selected` ya da `aria-checked`) görünmüyorsa
 * yalnız rayın `scrollLeft`'i değişir, kenarda 24 px pay kalır; `scrollIntoView` yok, sayfa kaymaz (yenilemeden ya
 * da KPI'dan açılan rapor çipi ekran dışında kalmaz). Ray taşarken kaydırılmış başta `data-fade-start`, gizli içerik
 * kalan sonda `data-fade-end` durur; kaydırınca, ray ya da öğeleri boyut değiştirince ve öğe eklenip çıkınca yenilenir.
 */
export function useRail<T extends HTMLElement>(selected: unknown) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const rail = ref.current;
    if (!rail || rail.scrollWidth <= rail.clientWidth + 1) return;
    const el = rail.querySelector('[aria-selected=true], [aria-checked=true]');
    if (!el) return;
    const r = rail.getBoundingClientRect();
    const e = el.getBoundingClientRect();
    if (e.left < r.left + RAIL_EDGE) rail.scrollLeft -= r.left + RAIL_EDGE - e.left;
    else if (e.right > r.right - RAIL_EDGE) rail.scrollLeft += e.right - (r.right - RAIL_EDGE);
  }, [selected]);
  useEffect(() => {
    const rail = ref.current;
    if (!rail) return;
    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      rail.toggleAttribute('data-fade-start', max > 1 && rail.scrollLeft > 1);
      rail.toggleAttribute('data-fade-end', max > 1 && rail.scrollLeft < max - 1);
    };
    update();
    rail.addEventListener('scroll', update, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    ro?.observe(rail);
    for (const child of rail.children) ro?.observe(child);
    // Rayın boyunu değiştirmeden eklenen ya da kalkan sekme (ör. veri gelince açılan liste) de solmayı yeniler
    const mo =
      typeof MutationObserver === 'undefined'
        ? null
        : new MutationObserver((records) => {
            for (const m of records) {
              m.addedNodes.forEach((n) => n instanceof Element && ro?.observe(n));
              m.removedNodes.forEach((n) => n instanceof Element && ro?.unobserve(n));
            }
            update();
          });
    mo?.observe(rail, { childList: true });
    return () => {
      rail.removeEventListener('scroll', update);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, []);
  return ref;
}

/** Kayan rayın gizli içerik kalan kenarı 24 px'te solar (useRail'in koyduğu data-fade-start / data-fade-end) */
export const RAIL_FADE =
  'data-[fade-end]:[mask-image:linear-gradient(to_right,#000_calc(100%_-_24px),transparent)] data-[fade-start]:[mask-image:linear-gradient(to_left,#000_calc(100%_-_24px),transparent)] data-[fade-start]:data-[fade-end]:[mask-image:linear-gradient(to_right,transparent,#000_24px,#000_calc(100%_-_24px),transparent)]';

/**
 * Bölüm sekmesi (bölümler, istasyonlar, sipariş listeleri): hap biçimi, etkin olan gri zeminde ve kalın, renksiz;
 * diğerleri düz; sayı hapı sıfırsa gizli. Dar ekranda ray yatay kayar, çipler kırılmaz; seçili sekme rayın içinde
 * görünür kalır, içeriğin gizlendiği kenar solar (useRail); odak halkası çipin içinde. Sayılı filtre çipi (koyu
 * kenarlı seçili) yönetimdeki StatusTabs'tır.
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
  const rail = useRail<HTMLDivElement>(value);
  return (
    <div ref={rail} role="tablist" aria-label={label} className={cn('no-scrollbar flex gap-1 overflow-x-auto', RAIL_FADE, className)}>
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
              'inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3.5 text-sm transition-colors duration-150 focus-visible:-outline-offset-2 active:bg-press [[data-area=admin]_&]:text-[13px]',
              size === 'sm' ? 'min-h-9 pointer-coarse:min-h-11' : 'min-h-11 pointer-fine:min-h-9',
              on ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-hover hover:text-ink',
            )}
          >
            {o.icon}
            {o.label}
            {!!o.count && (
              // Etkin sekmenin sayısı beyaz hap (gri zeminde); yeşil dolu hap "N hazır"ın, sayı onunla karışmasın
              <span className={cn('tabular min-w-5 rounded-full px-1.5 py-px text-center text-xs font-medium', on ? 'bg-surface text-ink shadow-[var(--rim)]' : 'bg-surface-3 text-ink-2')}>{o.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
