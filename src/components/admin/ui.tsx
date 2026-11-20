import { ChevronRight, MoreHorizontal } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { buttonClass, CloseButton } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/Field';
import { fitFigure, Badge as KitBadge, EmptyState as KitEmptyState, RAIL_FADE, Skeleton, useRail } from '@/components/ui/misc';
import type { IllustrationName } from '@/components/Illustration';
import { useStageHeader } from '@/components/ui/Stage';
import { cn } from '@/lib/cn';
import { topDialog, trapTab } from '@/lib/focus';

/**
 * Yönetim paneli kiti: yerleşim Innex'ten (docs/ADMIN-INNEX.md §1.5), görünüm LafPOS Pano (DESIGN.md §4-5: Inter, zeminde
 * yüzen beyaz kartlar, saç teli çerçeve, ev yeşili seçim ve ana eylem; köşe merdiveni kart 18, karo 12, denetim 10,
 * rozet 6). Dokunmatikte her hedef 44 px, farede 36 px, "Sıkı görünüm"de 32 px. Telefonda (md altı) tablo satır kartına,
 * çekmece alt sayfaya döner.
 */

/* Odak halkası her yerde aynı (index.css :focus-visible): 2 px birincil, 2 px dışarıda; burada yalnız açıkça yazılır */
const FOCUS = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--focus)]';
const COMPACT_H = 'pointer-fine:[[data-density=compact]_&]:min-h-8';

/**
 * Düğme sınıfları `ui/Button.tsx`'in `buttonClass`'ından (tek kaynak): yeni kodda `<Button variant=…>` ya da
 * bağlantıda `buttonClass(…)` yazın. Eşleme: primary = primary, ghost = secondary (beyaz, kenarlı), soft = soft,
 * danger = dangerOutline, icon = IconButton variant="secondary". Menü öğeleri yalnız burada.
 */
const MENU_ITEM = `flex min-h-11 w-full items-center gap-2.5 rounded-xl px-3 py-1.5 text-left text-sm disabled:opacity-50 pointer-fine:min-h-9 focus-visible:outline-2 focus-visible:-outline-offset-2 ${COMPACT_H}`;

export const BTN = {
  primary: buttonClass('primary', 'md'),
  ghost: buttonClass('secondary', 'md'),
  soft: buttonClass('soft', 'md'),
  danger: buttonClass('dangerOutline', 'md'),
  icon: buttonClass('secondary', 'md', { square: true, className: 'text-[var(--admin-text-soft)] hover:text-[var(--admin-text)]' }),
  // Menü öğesi: üzerinde ve klavye odağında gri zemin, odakta ayrıca içe çizilen halka (oklarla gezerken görünür)
  menu: `${MENU_ITEM} text-[var(--admin-text)] hover:bg-[var(--admin-panel)] focus-visible:bg-[var(--admin-panel)] focus-visible:outline-[var(--focus)]`,
  menuDanger: `${MENU_ITEM} text-[var(--admin-danger-ink)] hover:bg-[var(--admin-danger-soft)] focus-visible:bg-[var(--admin-danger-soft)] focus-visible:outline-[var(--admin-danger)]`,
} as const;

/** Satırda tekrar eden küçük denetim (⋯, metin eylemi): sakin, köşe 10 (kitin ikon düğmeleri gibi), dokunmatikte 44 px, farede 32 px */
export const ROW_ICON = `inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-btn)] text-[var(--admin-text-mute)] transition-colors hover:bg-[var(--admin-panel)] hover:text-[var(--admin-text)] pointer-fine:min-h-8 pointer-fine:min-w-8 ${FOCUS}`;

/**
 * Kart (pano kartı; tablo ve form kabı): köşe 18, beyaz. Zeminde (pano yaprağı) kenarsız ve yumuşak gölgeli, beyaz
 * yaprağın içinde saç teli kenarlı ve gölgesiz (--card-line, --card-shadow; index.css)
 */
export const CARD = 'rounded-[var(--r-card)] border border-[var(--card-line)] bg-[var(--admin-surface)] shadow-[var(--card-shadow)]';
export const LABEL = 'text-xs font-medium text-[var(--admin-text-mute)]';
export const NUM = 'tabular-nums';
/** Karakter karakter okunan ad (env değişkeni, klasör, adres): sistem eş genişlikli, gri kutu */
export const CODE = 'rounded bg-[var(--admin-surface-2)] px-1 py-px font-mono text-[0.92em] text-[var(--admin-text)] [overflow-wrap:anywhere]';

export type Tone = 'neutral' | 'primary' | 'accent' | 'info' | 'success' | 'warning' | 'danger';

/** Açık tonlu zemin (zaman çizelgesi dairesi): rozetle aynı eşleme, primary ev yeşili, accent yalnız online (mor) */
export const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-[var(--admin-neutral-soft)] text-[var(--admin-text-soft)]',
  primary: 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]',
  accent: 'bg-[var(--admin-accent-soft)] text-[var(--admin-accent-ink)]',
  info: 'bg-[var(--admin-info-soft)] text-[var(--admin-info)]',
  success: 'bg-[var(--admin-success-soft)] text-[var(--admin-success)]',
  warning: 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]',
  danger: 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]',
};

import type { Hue } from './hues';
import { KPI_LAST_ODD, kpiCellSpan, kpiGridCols } from '@/lib/kpiGrid';

export type { Hue };
const HUE: Record<Hue, string> = {
  neutral: 'bg-[var(--admin-panel)] text-[var(--admin-text-soft)]',
  blue: 'bg-[var(--admin-hue-blue-soft)] text-[var(--admin-hue-blue)]',
  amber: 'bg-[var(--admin-hue-amber-soft)] text-[var(--admin-hue-amber)]',
  rose: 'bg-[var(--admin-hue-rose-soft)] text-[var(--admin-hue-rose)]',
  violet: 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]',
  green: 'bg-[var(--admin-hue-green-soft)] text-[var(--admin-hue-green)]',
};

/** Durum rozeti: açık zemin üstünde renkli metin, hap, 22 px (kasa rozetiyle tek bileşen: ui/misc.tsx) */
export function Badge({ tone = 'neutral', dot, children, className, title }: { tone?: Tone; dot?: boolean; children: ReactNode; className?: string; title?: string }) {
  return (
    <KitBadge tone={tone} dot={dot} className={className} title={title}>
      {children}
    </KitBadge>
  );
}

/**
 * İkon kutusu (KPI hücresi, hızlı bakış satırı, bölüm listesi): varsayılan nötr taş; renk yalnız anlam taşıyınca
 * (hues.ts): mor online, mavi açık / dolu, yeşil ciro ve olumlu, pembe kayıp / iptal, amber gecikme ve bekleyen;
 * durumsuz sayı ve süre nötr
 */
export function IconBox({ hue = 'neutral', children, size = 'md' }: { hue?: Hue; children: ReactNode; size?: 'sm' | 'md' | 'lg' }) {
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

/**
 * Sayfa başlığı. Sahnenin içinde (AdminShell, Stage.tsx) başlık ve açıklama sol sütunun başına, eylemler ana
 * eylemin yeri olur (portal); `children` (sekme, not) yaprakta kalır. Sahne dışında (yönetimin yaprağı, telefondaki
 * bölüm listesi) ölçülü başlık: Inter 28 (geniş ekranda 30) / 700; telefonda başlığı kabuğun üst şeridi yazar, h1 yalnız
 * ekran okuyucuya kalır.
 */
export function PageHeader({ title, description, actions, children }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  const staged = useStageHeader({ title, subtitle: description, actions });
  if (staged) return children ? <>{staged}<div className="mb-5">{children}</div></> : <>{staged}</>;
  const titleOnly = !description && !actions && !children;
  return (
    // Pano başlığı: zeminin üstünde, çizgisiz; başlık ve açıklama kartların, çiplerin sol kenarıyla aynı hizada (iç
    // pay yok). Tablette de eylemler sığdıkça başlığın sağında (ana eylem başlık satırının en sağında; boş yeri başlık
    // sütunu alır); sığmayınca (yedi dönemli segment) başlığın altına, sola yaslı kendi satırına iner (sayfanın
    // w-full'ü o satırı doldurur); başlık sütunu 20rem'in altına ezilmez
    <div className={cn('mb-5', titleOnly && 'max-md:mb-0')}>
      <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end md:justify-between">
        <div className={cn('min-w-0 md:flex-[999_1_20rem]', !description && 'max-md:contents')}>
          <h1 className="font-headline text-[28px] font-bold leading-tight tracking-[-0.035em] text-[var(--admin-text)] max-md:sr-only xl:text-[30px]">{title}</h1>
          {description && <p className="mt-1.5 max-w-[72ch] text-[13px] text-[var(--admin-text-mute)] max-md:mt-0 max-md:line-clamp-2">{description}</p>}
        </div>
        {actions && <div className="flex min-w-0 flex-wrap items-center gap-2 md:grow max-sm:[&>*]:flex-1">{actions}</div>}
      </div>
      {children}
    </div>
  );
}

/**
 * Yönetim kartı: çizgisiz Innex başlığı; `divided` başlığın altına çizgi koyar (içerik satır listesiyse). Başlık
 * eylemlerle (arama, CSV, rozet) dikeyde ortalı: yanındaki 36/44 px denetimin üstünde yüzmez. Başlık bloğunun taban
 * genişliği 9rem: geniş eylem (segment, arama ve CSV) telefonda sığmazsa alt satıra iner, açıklama kelime kelime
 * dar sütuna ezilmez
 */
export function Card({
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName,
  flush,
  divided,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  flush?: boolean;
  divided?: boolean;
}) {
  return (
    <section className={cn(CARD, 'min-w-0', className)}>
      {(title || actions) && (
        <header className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pt-4 sm:px-5 sm:pt-5', divided && 'border-b border-[var(--admin-divider)] pb-3')}>
          <div className="min-w-0 flex-[1_1_9rem]">
            {title && <h2 className="text-base font-semibold leading-6 tracking-[-0.015em] text-[var(--admin-text)]">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-[var(--admin-text-mute)]">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn(flush ? (title || actions ? 'pt-3' : '') : 'p-4 sm:p-5 pointer-fine:[[data-density=compact]_&]:py-4', bodyClassName)}>{children}</div>
    </section>
  );
}

export interface KpiCell {
  key: string;
  label: string;
  icon: ReactNode;
  /**
   * İkon kutusunun tonu, verilmezse nötr. Renk yalnız anlam taşıyınca: mor online, mavi açık / dolu, yeşil ciro ve
   * olumlu, pembe kayıp / iptal, amber gecikme ve bekleyen; durumsuz sayı ve süre nötr
   */
  hue?: Hue;
  value: ReactNode;
  /** Değişim hapı: iyi haber yeşil, kötü haber kırmızı */
  delta?: { text: string; good: boolean } | null;
  /** Hiçbir rakam tek başına durmaz: dün, geçen hafta, toplam... */
  reference?: ReactNode;
  onClick?: () => void;
  active?: boolean;
}

/**
 * KPI şeridi (pano): her hücre kendi kartı (köşe 18, zeminde yüzer), aralarında 12 px. İkon yumuşak tonlu dairede,
 * değişim rozeti rakamın sağında (panonun "+12,8%" rozeti). Beş hücre
 * tablette 3 + 2 dizilir (altı sütunlu ızgarada 2 ve 3 sütun kaplar), boş gri hücre kalmaz. Etiket satırı 32 px'tir
 * ve etiket en çok iki satıra kırılır (kesilmez): hücreler arasında rakamlar aynı hizada kalır. Rakam tek satır, dar
 * hücrede küçülür (`fitFigure`). Tıklanan hücre etiketinin yanında › taşır: dokunmatikte üzerine gelme yok.
 */
export function KpiStrip({ cells, className }: { cells: KpiCell[]; className?: string }) {
  const n = cells.length;
  return (
    <div className={cn('grid grid-cols-2 gap-[var(--tile-gap)]', kpiGridCols(n), KPI_LAST_ODD, className)}>
      {cells.map((c, i) => {
        const body = (
          <>
            <span className="flex min-h-8 w-full items-center gap-2">
              <IconBox hue={c.hue}>{c.icon}</IconBox>
              <span className="line-clamp-2 min-w-0 text-[13px] font-medium leading-4 text-[var(--admin-text-mute)]">{c.label}</span>
              {c.onClick && <ChevronRight aria-hidden="true" className="ml-auto size-4 shrink-0 text-[var(--admin-text-mute)]" />}
            </span>
            <span className="mt-3 flex w-full flex-wrap items-baseline gap-x-2 gap-y-1">
              <span style={fitFigure(c.value)} className={cn('whitespace-nowrap font-headline text-[length:min(30px,var(--fit,17cqi))] font-bold leading-[0.9] tracking-[-0.04em] text-[var(--admin-text)]', NUM)}>
                {c.value}
              </span>
              {c.delta && <Badge tone={c.delta.good ? 'success' : 'danger'}>{c.delta.text}</Badge>}
            </span>
            {c.reference && <span className="mt-1 block w-full text-xs text-[var(--admin-text-mute)]">{c.reference}</span>}
          </>
        );
        const span = kpiCellSpan(n, i);
        const cls = cn(CARD, '@container flex min-w-0 flex-col items-stretch justify-start p-4 text-left sm:p-5', span, c.active && 'border-[var(--admin-ink-fill)] shadow-[inset_0_0_0_1px_var(--admin-ink-fill)]');
        return c.onClick ? (
          <button key={c.key} type="button" onClick={c.onClick} aria-pressed={c.active} className={cn(cls, 'transition-colors', !c.active && 'hover:bg-[var(--hover-solid)]', FOCUS, 'focus-visible:-outline-offset-2')}>
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

/**
 * Durum sekmeleri (kitin süzgeç çipi): beyaz çipler (köşe 10), etkin olan ev yeşili dolgu, sayaç soluk. Telefonda ray ekran
 * kenarına uzanır ve yatay kayar: seçili sekme rayın içinde görünür kalır, içeriğin gizlendiği kenar solar (useRail)
 */
export function StatusTabs<T extends string>({ value, onChange, tabs, label }: { value: T; onChange: (v: T) => void; tabs: TabOption<T>[]; label: string }) {
  const rail = useRail<HTMLDivElement>(value);
  return (
    <div ref={rail} role="tablist" aria-label={label} className={cn('no-scrollbar -mx-4 mb-4 overflow-x-auto px-4 sm:mx-0 sm:px-0', RAIL_FADE)}>
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
                'inline-flex min-h-9 items-center gap-1.5 rounded-[var(--r-btn)] border bg-[var(--admin-surface)] px-3.5 text-[13px] whitespace-nowrap transition-[color,border-color,background-color,box-shadow] pointer-coarse:min-h-11',
                COMPACT_H,
                FOCUS,
                'focus-visible:-outline-offset-2',
                on
                  ? 'border-[var(--admin-ink-fill)] bg-[var(--admin-ink-fill)] font-semibold text-[var(--admin-on-ink)] shadow-[var(--shadow-action)]'
                  : 'border-[var(--admin-border-strong)] font-medium text-[var(--admin-text-soft)] shadow-[var(--shadow-control)] hover:border-[var(--admin-border-field)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-text)]',
              )}
            >
              {t.label}
              {t.count !== undefined && (
                <span className={cn('min-w-5 rounded-[var(--r-chip)] px-1.5 py-px text-center text-xs font-medium leading-4', NUM, on ? 'bg-[color-mix(in_oklab,var(--admin-on-ink)_18%,transparent)] text-[var(--admin-on-ink)]' : 'bg-[var(--admin-panel)] text-[var(--admin-text-soft)]')}>{t.count}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Segment denetimi (kitin .seg'i): açık gri hap ray, ince kenar, seçili ev yeşili hap (dönem, görünüm). Telefonda ray tam genişlikte ve satıra kırılır
 * (yedi dönem iki satır; hiçbir seçenek gizli kaydırıcıda kalmaz), seçenekler satırı doldurur; köşe eş merkezli
 * (hap 22 + ray boşluğu 3). Daha geniş ekranda sığmayan ray kayar: seçili seçenek görünür kalır, gizli kenar solar
 * (useRail). Radyo grubu klavyesi: Tab gruba seçili seçenekte girer, oklar ve Home/End seçenekler arasında gezer,
 * Enter ya da boşluk seçer (seçim kendiliğinden değişmez: dönem ya da mod istemeden kaydedilmesin).
 */
export function Segmented<T extends string>({ value, onChange, options, label, className }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string; className?: string }) {
  const rail = useRail<HTMLDivElement>(value);
  const tabStop = Math.max(0, options.findIndex((o) => o.value === value));
  const move = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const radios = [...e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    const at = radios.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const last = radios.length - 1;
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (at === last ? 0 : at + 1) : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (at === 0 ? last : at - 1) : e.key === 'Home' ? 0 : e.key === 'End' ? last : -1;
    if (to < 0) return;
    e.preventDefault();
    radios[to].focus();
  };
  return (
    <div
      ref={rail}
      role="radiogroup"
      aria-label={label}
      onKeyDown={move}
      className={cn('no-scrollbar inline-flex max-w-full gap-0.5 overflow-x-auto rounded-[var(--r-segment)] border border-[var(--admin-border)] bg-[var(--admin-surface-2)] p-[3px] max-sm:flex max-sm:w-full max-sm:flex-wrap max-sm:rounded-[min(26px,var(--r-segment))] max-sm:pointer-fine:rounded-[min(22px,var(--r-segment))]', RAIL_FADE, className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={i === tabStop ? 0 : -1}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex min-h-9 shrink-0 items-center justify-center rounded-[var(--r-segment)] px-3.5 text-[13px] font-medium whitespace-nowrap transition-colors pointer-coarse:min-h-11 max-sm:grow',
              COMPACT_H,
              FOCUS,
              'focus-visible:-outline-offset-2',
              on ? 'bg-[var(--admin-ink-fill)] font-semibold text-[var(--admin-on-ink)]' : 'text-[var(--admin-text-soft)] hover:bg-[var(--hover)] hover:text-[var(--admin-text)]',
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

/**
 * Satır eylemleri (⋯). Menü köşe 14 px, yüzen gölge; Escape, Tab ve dışarı tıklama kapatır, oklar gezdirir. Menü
 * portalda (body sonunda): Tab'da odak önce ⋯'ye döner, sıra oradan sürer (menü açık kalıp sayfanın üstünde kalmaz).
 */
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
      if (e.key === 'Tab') {
        // Varsayılan Tab hareketi ⋯'den başlar: Shift+Tab önceki, Tab sonraki denetime gider
        setOpen(false);
        btn.current?.focus();
        return;
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
          <div ref={menu} role="menu" style={style} className="animate-fade z-[60] rounded-2xl border border-[var(--admin-border)] bg-[var(--surface-raised)] p-1.5 shadow-[var(--shadow-pop)] dark:border-[var(--admin-border-strong)]">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                role="menuitem"
                disabled={it.disabled}
                onClick={() => {
                  setOpen(false);
                  // Odak önce ⋯ düğmesine döner: açılan çekmece ya da onay penceresi açanı doğru yakalar, kapanınca
                  // odak satıra geri gelir (menü öğesi DOM'dan kalkınca body'ye düşmesin)
                  btn.current?.focus();
                  it.onSelect();
                }}
                className={it.danger ? BTN.menuDanger : BTN.menu}
              >
                {/* İkon küçük yumuşak karede (panonun ikon karesi); tehlikeli öğede kırmızının açık tonu */}
                {it.icon && (
                  <span aria-hidden="true" className={cn('grid size-7 shrink-0 place-items-center rounded-lg [&>svg]:size-4', it.danger ? 'bg-[var(--admin-danger-soft)]' : 'bg-[var(--admin-surface-2)] text-[var(--admin-text-soft)]')}>
                    {it.icon}
                  </span>
                )}
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
 * Innex tablosu: kart içinde, başlık satırı zeminsiz 12,5 px soluk, satır ayracı (--admin-divider), sağa yaslı sütun
 * tablo rakamıyla (tutar ve oranlar alt alta hizalı), son sütun yapışkan eylem, seçili satır açık nane ve solda ev
 * yeşili çizgi. Telefonda satır kartı: başlık ve rozet, altında ikincil satır, sağda eylem menüsü; seçili kart da aynı
 * çizgiyi taşır, basılınca zemin bir ton koyulaşır (dokunmatikte üzerine gelme yok).
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
  phoneLead,
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
  /** Telefondaki satır kartında başlığın solunda: avatar ya da renk karesi; başlık ve alt satır onun yanında hizalanır */
  phoneLead?: (row: T) => ReactNode;
  rowClassName?: (row: T) => string | false | undefined;
}) {
  if (!rows.length) return <>{empty ?? <EmptyState title="Henüz kayıt yok" />}</>;
  return (
    <div className={cn(CARD, 'overflow-hidden')}>
      {/* Konumlu kap: hücredeki mutlak konumlu ekran okuyucu metni (sr-only) sayfaya göre değil tabloya göre durur,
          tablo kayarken sayfayı yana genişletmez */}
      <div className="relative hidden overflow-x-auto md:block" data-overflow-ok>
        <table className="w-full border-collapse text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            {/* Başlık şeridi kasada kuyuda, kurumsal yüzeyde zeminsiz: yalnız başlık ve satır çizgileri */}
            <tr className="border-b border-[var(--admin-border)] bg-[var(--table-head-bg)]">
              {columns.map((c) => (
                <th key={c.key} scope="col" style={c.width ? { width: c.width } : undefined} className={cn('h-12 px-4 text-[12.5px] font-medium whitespace-nowrap text-[var(--admin-text-mute)]', alignCls(c.align), hideCls(c), c.className)}>
                  {c.header}
                </th>
              ))}
              {actions && <th scope="col" className="sticky right-0 w-14 bg-[var(--admin-surface)] px-2"><span className="sr-only">Eylemler</span></th>}
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
                  className={cn('group border-t border-[var(--admin-divider)] transition-colors duration-150', onOpen && 'cursor-pointer', selected ? 'bg-[color-mix(in_oklab,var(--admin-primary-soft)_45%,var(--admin-surface))] shadow-[inset_3px_0_0_var(--admin-primary)]' : 'hover:bg-[var(--hover-solid)]', rowClassName?.(r))}
                >
                  {columns.map((c, i) => (
                    <td key={c.key} className={cn('px-4 py-3.5 align-middle pointer-fine:[[data-density=compact]_&]:py-2', alignCls(c.align), c.align === 'right' && NUM, hideCls(c), c.className)}>
                      {i === 0 && onOpen ? (
                        <button type="button" onClick={() => onOpen(r)} className={cn('flex w-full items-center rounded-lg text-left pointer-coarse:min-h-11', FOCUS)}>
                          {c.cell(r)}
                        </button>
                      ) : (
                        c.cell(r)
                      )}
                    </td>
                  ))}
                  {actions && (
                    <td className={cn('sticky right-0 px-2 text-right shadow-[-10px_0_10px_-10px_rgba(15,35,28,0.16)]', selected ? 'bg-[color-mix(in_oklab,var(--admin-primary-soft)_45%,var(--admin-surface))]' : 'bg-[var(--admin-surface)] group-hover:bg-[var(--hover-solid)]')}>{actions(r)}</td>
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
          const lead = phoneLead && <span className="shrink-0 self-start pr-1">{phoneLead(r)}</span>;
          return (
            <li key={k} className={cn('flex items-center gap-1 pr-1 transition-colors duration-150', onOpen && 'has-[>button:active]:bg-[var(--hover-solid)]', selectedKey === k && 'bg-[color-mix(in_oklab,var(--admin-primary-soft)_45%,var(--admin-surface))] shadow-[inset_3px_0_0_var(--admin-primary)]', rowClassName?.(r))}>
              {onOpen ? (
                <button type="button" onClick={() => onOpen(r)} className={cn('flex min-h-16 min-w-0 flex-1 items-center gap-2 py-3 pl-4 text-left', FOCUS, 'focus-visible:-outline-offset-2')}>
                  {lead}
                  {body}
                  {!actions && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-text-mute)]" />}
                </button>
              ) : (
                <div className="flex min-h-16 min-w-0 flex-1 items-center gap-2 py-3 pl-4">
                  {lead}
                  {body}
                </div>
              )}
              {actions && <div className="shrink-0">{actions(r)}</div>}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Boş durum: kasadakiyle tek bileşen (ui/misc.tsx), gri ikon kutusu. Sayfada kart içinde durur; kartın içindeyse
 * `bare` (iç içe kart olmaz, kompakt boy).
 */
export function EmptyState({ icon, art, title, children, action, bare }: { icon?: ReactNode; art?: IllustrationName; title: ReactNode; children?: ReactNode; action?: ReactNode; bare?: boolean }) {
  return (
    <KitEmptyState compact={bare} icon={icon} art={art} title={title} action={action} className={cn(!bare && CARD)}>
      {children}
    </KitEmptyState>
  );
}

/**
 * Hızlı bakış çekmecesi: geniş ekranda sağdan, telefonda alttan; hafif karartma. Odak kuralları Modal'la aynı:
 * içerideki autoFocus alanı korunur, yazarken (canlı yenileme, her tuşta üst bileşenin yeniden çizimi) odak
 * alandan kopmaz, Tab çekmecede döner, Escape yalnız en üstteki katmanı kapatır.
 */
export function QuickLook({ open, onClose, title, subtitle, children, footer, label }: { open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; label: string }) {
  const panel = useRef<HTMLDivElement>(null);
  // onClose çoğu yerde satır içi ok işlevi: efekt ona bağlansaydı her çizimde odak panele geri çekilirdi
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  const opener = useRef<HTMLElement | null>(null);
  const downOnScrim = useRef(false);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;
  useEffect(() => {
    if (!open) return;
    const restore = opener.current;
    if (!panel.current?.contains(document.activeElement)) panel.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      // Odak çekmece dışına düştüyse Tab arka sayfaya geçmez, çekmeceye döner
      if (e.key === 'Tab') {
        if (panel.current && topDialog() === panel.current && !panel.current.contains(e.target as Node)) {
          e.preventDefault();
          panel.current.focus();
        }
        return;
      }
      if (e.key !== 'Escape' || (panel.current && topDialog() !== panel.current)) return;
      latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (restore?.isConnected) restore.focus?.();
    };
  }, [open]);
  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-50">
      {/* Karartmaya dokunuş click'te kapatır (basış da karartmada başladıysa): pointerdown'da kapansa aynı dokunuşun
          click'i alttaki satıra düşer, başka bir kaydın çekmecesini açardı */}
      <div
        className="animate-fade absolute inset-0 bg-[var(--scrim-soft)]"
        aria-hidden="true"
        onPointerDown={(e) => {
          downOnScrim.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (downOnScrim.current && e.target === e.currentTarget) onClose();
          downOnScrim.current = false;
        }}
      />
      <div
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onKeyDown={(e) => trapTab(e, panel.current)}
        className="animate-in absolute inset-x-0 bottom-0 flex max-h-[92dvh] flex-col overflow-hidden rounded-t-[var(--r-stage)] border border-transparent bg-[var(--admin-surface)] shadow-[var(--shadow-pop)] outline-none md:inset-y-3 md:left-auto md:right-3 md:max-h-none md:w-[min(480px,calc(100vw-1.5rem))] md:rounded-[var(--r-stage)] dark:border-[var(--admin-border-strong)]"
      >
        <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-[var(--admin-border-field)]/50 md:hidden" aria-hidden="true" />
        {/* Başlık şeridi pencereyle (Modal) aynı: 19/700 başlık, 13 px alt satır, Kapat başlığın ilk satırında */}
        <div className="flex items-start gap-3 border-b border-[var(--admin-divider)] px-5 pb-3.5 pt-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 text-xl font-bold leading-6 tracking-[-0.03em] text-[var(--admin-text)]">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[13px] text-[var(--admin-text-mute)]">{subtitle}</p>}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">{children}</div>
        {/* Alt şerit: telefonda üç düğme (Kaldır, Vazgeç, Kaydet) tek satıra sığmazsa ana eylem (son düğme) kendi satırında
            tam genişlikte; sola yaslı tek başına kalmaz */}
        {footer && <div className="flex flex-wrap items-center gap-2 border-t border-[var(--admin-divider)] bg-[var(--admin-surface)] px-5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:px-6 max-sm:[&>button:last-child]:grow">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/**
 * Gri kap içinde beyaz işlem satırları (hızlı bakış): ikon kutusu, etiket, sağda değer ya da ›. Köşeler eş merkezli:
 * kap 18 (--r-card), iç boşluk 6, satır 12 (--r-tile); satırlar arası 4 px
 */
export function ActionRows({ children }: { children: ReactNode }) {
  return <div className="space-y-1 rounded-[var(--r-card)] bg-[var(--admin-surface-2)] p-1.5 ring-1 ring-inset ring-[var(--admin-border)]">{children}</div>;
}

export function ActionRow({ icon, hue = 'neutral', label, value, onClick, danger, disabled }: { icon: ReactNode; hue?: Hue; label: ReactNode; value?: ReactNode; onClick?: () => void; danger?: boolean; disabled?: boolean }) {
  const inner = (
    <>
      <IconBox hue={danger ? 'rose' : hue}>{icon}</IconBox>
      <span className={cn('min-w-0 flex-1 truncate text-sm font-medium', danger ? 'text-[var(--admin-danger-ink)]' : 'text-[var(--admin-text)]')}>{label}</span>
      {value != null && <span className="shrink-0 text-[13px] text-[var(--admin-text-mute)]">{value}</span>}
      {onClick && <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-text-mute)]" />}
    </>
  );
  const cls = 'flex min-h-12 w-full items-center gap-3 rounded-[var(--r-tile)] bg-[var(--admin-surface)] px-3 py-2 text-left';
  return onClick ? (
    <button type="button" onClick={onClick} disabled={disabled} className={cn(cls, 'transition-colors hover:bg-[var(--hover-solid)] disabled:opacity-50', FOCUS)}>
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

/**
 * Kurulum bilgisi (env değişkeni, belge yolu, komut): ana akıştan çıkar, sayfa sonunda kapalı durur.
 * İçerik kaybolmaz; açan kişi okur.
 */
export function SetupNotes({ children, summary = 'Kurulum adımları', open }: { children: ReactNode; summary?: ReactNode; open?: boolean }) {
  return (
    // Kartlarla aynı kap (CARD: köşe --r-card, saç teli, zeminde aynı hafif gölge): sayfadaki son kart gibi durur, açılınca
    // içi kartın gövdesi
    <details open={open} className={cn(CARD, 'group')}>
      <summary className={cn('flex min-h-12 cursor-pointer list-none items-center gap-2 rounded-[var(--r-card)] px-4 text-[13px] font-medium text-[var(--admin-text-soft)] transition-colors duration-150 hover:text-[var(--admin-text)] sm:px-5 pointer-fine:min-h-11 [&::-webkit-details-marker]:hidden', FOCUS)}>
        <ChevronRight aria-hidden="true" className="size-4 shrink-0 transition-transform duration-150 group-open:rotate-90 motion-reduce:transition-none" />
        {summary}
      </summary>
      <div className="space-y-2 pb-4 pl-10 pr-4 text-xs leading-5 text-[var(--admin-text-soft)] sm:pl-11 sm:pr-5">{children}</div>
    </details>
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

/**
 * Liste araç çubuğu: büyüteçli arama ve satırın kendi denetimleri tek satırda. Alan kitin ortak arama alanı
 * (ui/Field.tsx SearchInput): kenar ve odak öteki alanlarla aynı, yazınca temizle düğmesi, Escape temizler
 */
export function SearchField({ value, onChange, placeholder, label }: { value: string; onChange: (v: string) => void; placeholder: string; label: string }) {
  return <SearchInput dense value={value} onChange={onChange} placeholder={placeholder} label={label} wrapperClassName="basis-full sm:max-w-xs sm:flex-1 sm:basis-auto" />;
}

/**
 * KPI şeridi iskeleti (Raporlar, Genel bakış ilk yüklemede): şeridin aynısı, her hücre kendi kartı, aralık --tile-gap;
 * hücre ölçüsü aynı (32 px etiket satırı, 28 px rakam, 16 px referans satırı): veri gelince şerit zıplamaz
 */
export function KpiStripSkeleton({ count = 5, className }: { count?: number; className?: string }) {
  return (
    <div role="status" aria-label="Yükleniyor…" className={cn('grid grid-cols-2 gap-[var(--tile-gap)]', kpiGridCols(count), KPI_LAST_ODD, className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className={cn(CARD, 'p-4 sm:p-5', kpiCellSpan(count, i))}>
          <span className="flex min-h-8 items-center gap-2">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-3.5 w-20" />
          </span>
          <Skeleton className="mt-3 h-7 w-28 max-w-full" />
          <Skeleton className="mt-2 h-3 w-32 max-w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * Tablo iskeleti (Ürünler, Personel, Ödeme türleri ilk yüklemede): kart kabuğu, tablonun başlık şeridi (48 px, zeminsiz,
 * alt çizgi) ve satırı (64 px) aynı boyda: veri gelince tablo zıplamaz; satır başına ikon ve iki çizgi
 */
export function TableSkeleton({ rows = 8, className }: { rows?: number; className?: string }) {
  return (
    <div role="status" aria-label="Yükleniyor…" className={cn(CARD, 'overflow-hidden', className)}>
      <div className="h-12 border-b border-[var(--admin-border)] bg-[var(--table-head-bg)]" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-16 items-center gap-3 border-t border-[var(--admin-divider)] px-4 [&:nth-child(2)]:border-t-0">
          <Skeleton className="size-9 rounded-lg" />
          <span className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-40 max-w-[60%]" />
            <Skeleton className="h-3 w-24 max-w-[40%]" />
          </span>
          <Skeleton className="hidden h-3.5 w-16 sm:block" />
        </div>
      ))}
    </div>
  );
}
