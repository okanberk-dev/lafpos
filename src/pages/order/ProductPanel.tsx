import { Search, SlidersHorizontal, Star, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tlCompact } from '@shared/money';
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 px-3 pt-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Ürün ara"
            className="h-11 w-full rounded-xl border border-line bg-surface pl-9 pr-9 text-[15px] outline-none focus:border-forest-500"
          />
          {q && (
            <button onClick={() => setQ('')} aria-label="Aramayı temizle" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1 text-muted hover:bg-surface-2">
              <X className="size-4" />
            </button>
          )}
        </div>
      </div>
      <div className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-3">
        {showFavorites && (
          <CategoryChip active={!q && current === FAVORITES} color="#c9983f" onClick={() => setCategoryId(FAVORITES)}>
            <Star className="size-3.5" /> Sık
          </CategoryChip>
        )}
        {categories.map((c) => (
          <CategoryChip key={c.id} active={!q && current === c.id} color={c.color} onClick={() => setCategoryId(c.id)}>
            {c.name}
          </CategoryChip>
        ))}
      </div>
      <div className="scroll-thin grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2.5 overflow-y-auto px-3 pb-4">
        {list.map((p) => (
          <ProductTile key={p.id} p={p} disabled={disabled} onQuickAdd={onQuickAdd} onCustomize={onCustomize} />
        ))}
        {list.length === 0 && <p className="col-span-full py-10 text-center text-sm text-muted">Bu aramada ürün yok</p>}
      </div>
    </div>
  );
}

function CategoryChip({ active, color, onClick, children }: { active: boolean; color: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn('flex shrink-0 items-center gap-1.5 rounded-xl px-3.5 py-2 text-sm font-medium transition', active ? 'text-white shadow-sm' : 'bg-surface-2 text-ink-2 hover:bg-surface-3')}
      style={active ? { background: color } : undefined}
    >
      {children}
    </button>
  );
}

function ProductTile({
  p,
  disabled,
  onQuickAdd,
  onCustomize,
}: {
  p: ProductDTO;
  disabled?: boolean;
  onQuickAdd: (p: ProductDTO, size: Size) => void;
  onCustomize: (p: ProductDTO, size: Size) => void;
}) {
  const boot = useBoot();
  const soldOut = !p.active;
  const hasOptions = p.optionGroupIds.length > 0;
  const twoSizes = p.priceL != null;
  const cat = boot.categories.find((c) => c.id === p.categoryId);
  const accent = p.color ?? cat?.color ?? '#245c43';
  const label = p.shortName?.trim() || p.name;

  return (
    <div
      className={cn(
        'relative flex min-h-[104px] flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]',
        (soldOut || disabled) && 'opacity-50',
      )}
    >
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: accent }} />
      <button
        disabled={soldOut || disabled}
        onClick={() => (twoSizes || !hasOptions ? onQuickAdd(p, twoSizes ? 'M' : 'TEK') : onCustomize(p, 'TEK'))}
        className="flex flex-1 flex-col items-start px-3 pb-1 pt-2.5 text-left active:bg-surface-2"
      >
        <span className="line-clamp-2 text-[15px] font-semibold leading-tight">{label}</span>
        {soldOut ? (
          <span className="mt-1 rounded-full bg-burgundy-100 px-2 py-0.5 text-[11px] font-semibold text-burgundy-600">Tükendi</span>
        ) : p.portionsLeft != null ? (
          <span className="mt-1 rounded-full bg-brass-100 px-2 py-0.5 text-[11px] font-semibold text-brass-700">Son {p.portionsLeft}</span>
        ) : null}
      </button>
      <div className="flex items-stretch border-t border-line">
        {twoSizes ? (
          <>
            <SizeButton disabled={soldOut || disabled} label={boot.settings.sizeLabels.M} price={p.price} onClick={() => onQuickAdd(p, 'M')} />
            <span className="w-px bg-line" />
            <SizeButton disabled={soldOut || disabled} label={boot.settings.sizeLabels.L} price={p.priceL!} onClick={() => onQuickAdd(p, 'L')} />
          </>
        ) : (
          <div className="tabular flex flex-1 items-center px-3 py-2 text-sm font-semibold text-ink-2">{tlCompact(p.price)} ₺</div>
        )}
        {hasOptions && (
          <button
            disabled={soldOut || disabled}
            onClick={() => onCustomize(p, twoSizes ? 'M' : 'TEK')}
            aria-label={`${label} seçenekleri`}
            className="grid w-11 place-items-center border-l border-line text-muted hover:bg-surface-2 hover:text-forest-600"
          >
            <SlidersHorizontal className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function SizeButton({ label, price, onClick, disabled }: { label: string; price: number; onClick: () => void; disabled?: boolean }) {
  return (
    <button disabled={disabled} onClick={onClick} className="flex flex-1 flex-col items-center py-1.5 leading-tight hover:bg-forest-50 active:bg-forest-100 dark:hover:bg-forest-800">
      <span className="text-[11px] text-muted">{label}</span>
      <span className="tabular text-sm font-semibold">{tlCompact(price)} ₺</span>
    </button>
  );
}
