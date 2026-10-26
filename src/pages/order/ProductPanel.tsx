import { Search, SlidersHorizontal, Star, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tlShort } from '@shared/money';
import type { ProductDTO, Size } from '@shared/types';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref } from '@/lib/hooks';

const FAVORITES = '__sik__';

/** Türkçe duyarsız arama anahtarı */
const fold = (s: string) =>
  s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');

/** Görsel adresinin kısa özeti: site görseli değiştirince kart yeni kopyayı ister */
function imageVersion(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/** Görselin sol üst köşesi saydam değilse fotoğraftır (dekupaj değil). Görsel aynı kökenden, tuval okunabilir */
function isOpaque(img: HTMLImageElement): boolean {
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 1;
    const ctx = c.getContext('2d');
    if (!ctx) return false;
    ctx.drawImage(img, 0, 0, 1, 1, 0, 0, 1, 1);
    return ctx.getImageData(0, 0, 1, 1).data[3] > 250;
  } catch {
    return false;
  }
}

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toLocaleUpperCase('tr-TR'))
    .join('');

export function ProductPanel({
  onQuickAdd,
  onCustomize,
  disabled,
}: {
  onQuickAdd: (p: ProductDTO, size: Size) => void;
  onCustomize: (p: ProductDTO, size: Size) => void;
  disabled?: boolean;
}) {
  const boot = useBoot();
  const [categoryId, setCategoryId] = useLocalPref<string>('order.category', FAVORITES);
  const [q, setQ] = useState('');

  const visible = useMemo(() => boot.products.filter((p) => !p.hidden), [boot.products]);
  const categories = useMemo(() => boot.categories.filter((c) => c.active && visible.some((p) => p.categoryId === c.id)), [boot.categories, visible]);
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of visible) m.set(p.categoryId, (m.get(p.categoryId) ?? 0) + 1);
    return m;
  }, [visible]);
  const favorites = visible.filter((p) => p.favorite);
  const showFavorites = favorites.length > 0;
  const current = categoryId === FAVORITES && !showFavorites ? (categories[0]?.id ?? '') : categoryId;

  const list = useMemo(() => {
    if (q.trim()) {
      const k = fold(q.trim());
      return visible.filter((p) => fold(`${p.name} ${p.shortName ?? ''} ${p.barcode ?? ''}`).includes(k)).slice(0, 60);
    }
    if (current === FAVORITES) return favorites;
    return visible.filter((p) => p.categoryId === current);
  }, [q, current, visible, favorites]);
  // Listede görselli ürün varsa bütün kartlar görsel alanıyla çizilir: satırlar aynı boyda kalır
  const withImages = boot.settings.productImages && list.some((p) => p.image);

  const categoryItems = [
    ...(showFavorites ? [{ id: FAVORITES, name: 'Sık', color: null as string | null, count: favorites.length }] : []),
    ...categories.map((c) => ({ id: c.id, name: c.name, color: c.color, count: counts.get(c.id) ?? 0 })),
  ];

  return (
    <div className="flex h-full min-h-0">
      {/* Geniş ekran: kategoriler solda alt alta, hepsi görünür (Innex kenar çubuğu satırı gibi) */}
      <div role="tablist" aria-orientation="vertical" aria-label="Kategoriler" className="scroll-thin hidden w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-[var(--admin-divider)] p-2 xl:flex">
        {categoryItems.map((c) => (
          <CategoryRow key={c.id} active={!q && current === c.id} color={c.color} count={c.count} onClick={() => setCategoryId(c.id)} favorite={c.id === FAVORITES}>
            {c.name}
          </CategoryRow>
        ))}
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-3 pt-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" strokeWidth={1.75} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Ürün ara"
              aria-label="Ürün ara"
              className="h-11 w-full rounded-xl border border-[var(--admin-border-strong)] bg-surface pl-9 pr-11 text-[15px] outline-none transition placeholder:text-muted focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)]"
            />
            {q && (
              <button onClick={() => setQ('')} aria-label="Aramayı temizle" className="absolute right-0 top-0 grid size-11 place-items-center rounded-xl text-muted hover:text-ink">
                <X className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div role="tablist" aria-label="Kategoriler" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-3 xl:hidden">
          {categoryItems.map((c) => (
            <CategoryChip key={c.id} active={!q && current === c.id} color={c.color} onClick={() => setCategoryId(c.id)}>
              {c.id === FAVORITES && <Star className="size-3.5" strokeWidth={1.75} />}
              {c.name}
            </CategoryChip>
          ))}
        </div>
        <div
          className={cn(
            'scroll-thin grid min-h-0 flex-1 auto-rows-min gap-2 overflow-y-auto border-t border-[var(--admin-divider)] bg-surface-2 p-3 xl:mt-3',
            withImages ? 'grid-cols-[repeat(auto-fill,minmax(150px,1fr))]' : 'grid-cols-[repeat(auto-fill,minmax(148px,1fr))]',
          )}
        >
          {list.map((p) => (
            <ProductTile key={p.id} p={p} withImage={withImages} disabled={disabled} onQuickAdd={onQuickAdd} onCustomize={onCustomize} />
          ))}
          {list.length === 0 && <p className="col-span-full py-10 text-center text-sm text-muted">Bu aramada ürün yok</p>}
        </div>
      </div>
    </div>
  );
}

/** Dikey kategori satırı: seçili satır gri, renksiz; kategori rengi yalnız nokta, sağda ürün sayısı */
function CategoryRow({ active, color, count, favorite, onClick, children }: { active: boolean; color: string | null; count: number; favorite?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'flex min-h-11 w-full shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm transition-colors pointer-fine:min-h-10',
        active ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-surface-2 hover:text-ink',
      )}
    >
      {favorite ? (
        <Star aria-hidden="true" className="size-3.5 shrink-0 text-[var(--laf-bean)]" strokeWidth={2} />
      ) : (
        <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color ?? 'var(--admin-border-field)' }} />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="tabular text-xs font-medium text-muted">{count}</span>
    </button>
  );
}

/** Kategori çipi (telefon, tablet): Innex durum sekmesi gibi; seçili koyu kenar. Kategori rengi yalnız küçük nokta */
function CategoryChip({ active, color, onClick, children }: { active: boolean; color?: string | null; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-lg border bg-surface px-3 text-sm whitespace-nowrap transition-[color,border-color] pointer-fine:min-h-9',
        active ? 'border-ink font-semibold text-ink' : 'border-line font-medium text-ink-2 hover:border-[var(--admin-border-field)] hover:text-ink',
      )}
    >
      {color && <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: color }} />}
      {children}
    </button>
  );
}

/**
 * Ürün kartı: dokununca eklenir (iki boyluda boy düğmeleri). Görselli düzende üstte sitedeki ürün fotoğrafı
 * (dekupaj, gri sahnede), görseli olmayan üründe adın baş harfleri. Seçenekli üründe köşede seçenek düğmesi;
 * durum (tükendi, son porsiyon) küçük rozet.
 */
function ProductTile({
  p,
  withImage,
  disabled,
  onQuickAdd,
  onCustomize,
}: {
  p: ProductDTO;
  withImage: boolean;
  disabled?: boolean;
  onQuickAdd: (p: ProductDTO, size: Size) => void;
  onCustomize: (p: ProductDTO, size: Size) => void;
}) {
  const boot = useBoot();
  const [broken, setBroken] = useState(false);
  // Dekupaj (saydam köşe) gri sahnede ortada durur; fotoğraf sahneyi doldurur
  const [photo, setPhoto] = useState(false);
  const soldOut = !p.active;
  const hasOptions = p.optionGroupIds.length > 0;
  const twoSizes = p.priceL != null;
  const label = p.shortName?.trim() || p.name;
  const off = soldOut || disabled;
  const src = p.image && !broken ? `/media/products/${p.id}?v=${imageVersion(p.image)}` : null;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-xl border border-line bg-surface transition-[border-color,box-shadow] hover:border-[var(--admin-border-field)] hover:shadow-[0_1px_2px_rgb(12_14_27/0.06)]',
        withImage ? 'min-h-[176px]' : 'min-h-[104px]',
        off && 'opacity-50',
      )}
    >
      <button
        disabled={off}
        onClick={() => (twoSizes || !hasOptions ? onQuickAdd(p, twoSizes ? 'M' : 'TEK') : onCustomize(p, 'TEK'))}
        className={cn('flex flex-1 flex-col items-stretch rounded-xl text-left active:bg-surface-2', !withImage && hasOptions && 'pr-11')}
      >
        {withImage && (
          <span aria-hidden="true" className="relative mx-1.5 mt-1.5 grid h-[88px] place-items-center overflow-hidden rounded-lg bg-surface-2">
            {src ? (
              <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setBroken(true)}
                onLoad={(e) => setPhoto(isOpaque(e.currentTarget))}
                className={cn(
                  'transition-transform duration-200 ease-out group-hover:scale-[1.04] motion-reduce:transition-none',
                  photo ? 'size-full object-cover' : 'h-[80px] w-full object-contain',
                )}
              />
            ) : (
              <span className="text-xl font-semibold tracking-tight text-[var(--admin-border-field)]">{initials(label)}</span>
            )}
          </span>
        )}
        <span className={cn('flex flex-1 flex-col items-start gap-1 px-3 pb-2.5', withImage ? 'pt-2' : 'pt-2.5')}>
          <span className="line-clamp-2 text-sm font-semibold leading-snug">{label}</span>
          {soldOut ? (
            <span className="rounded-md bg-[var(--admin-danger-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--admin-danger-ink)]">Tükendi</span>
          ) : p.portionsLeft != null ? (
            <span className="tabular rounded-md bg-[var(--admin-warning-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--admin-warning)]">Son {p.portionsLeft}</span>
          ) : null}
          {!twoSizes && <span className="tabular mt-auto text-sm font-semibold text-ink-2">{tlShort(p.price)}</span>}
        </span>
      </button>
      {hasOptions && (
        <button
          disabled={off}
          onClick={() => onCustomize(p, twoSizes ? 'M' : 'TEK')}
          aria-label={`${label} seçenekleri`}
          title="Seçenekler"
          className={cn(
            'absolute right-0 top-0 grid size-11 place-items-center text-muted transition-colors hover:text-primary',
            withImage ? 'rounded-lg' : 'rounded-xl',
          )}
        >
          {withImage ? (
            // Fotoğrafın üstünde okunur kalsın: beyaz hap; dokunma alanı yine 44 px
            <span className="grid size-8 place-items-center rounded-lg bg-surface/90 text-ink-2 shadow-[0_1px_3px_rgb(12_14_27/0.18)] backdrop-blur-sm">
              <SlidersHorizontal className="size-4" strokeWidth={1.75} />
            </span>
          ) : (
            <SlidersHorizontal className="size-4" strokeWidth={1.75} />
          )}
        </button>
      )}
      {twoSizes && (
        <div className="grid grid-cols-2 gap-1 px-1.5 pb-1.5">
          <SizeButton disabled={off} label={boot.settings.sizeLabels.M} price={p.price} onClick={() => onQuickAdd(p, 'M')} />
          <SizeButton disabled={off} label={boot.settings.sizeLabels.L} price={p.priceL!} onClick={() => onQuickAdd(p, 'L')} />
        </div>
      )}
    </div>
  );
}

function SizeButton({ label, price, onClick, disabled }: { label: string; price: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label} ${tlShort(price)}`}
      className="flex min-h-11 flex-col items-center justify-center rounded-lg bg-surface-3 leading-tight transition-colors hover:bg-[var(--admin-primary-soft)] hover:text-primary active:bg-[var(--admin-primary-soft)] pointer-fine:min-h-10"
    >
      <span className="text-[11px] text-muted">{label}</span>
      <span className="tabular text-[13px] font-semibold">{tlShort(price)}</span>
    </button>
  );
}
