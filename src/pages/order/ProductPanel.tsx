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
      <div role="tablist" aria-label="Kategoriler" className="no-scrollbar flex gap-1.5 overflow-x-auto px-3 py-3">
        {showFavorites && (
          <CategoryChip active={!q && current === FAVORITES} onClick={() => setCategoryId(FAVORITES)}>
            <Star className="size-3.5" strokeWidth={1.75} /> Sık
          </CategoryChip>
        )}
        {categories.map((c) => (
          <CategoryChip key={c.id} active={!q && current === c.id} color={c.color} onClick={() => setCategoryId(c.id)}>
            {c.name}
          </CategoryChip>
        ))}
      </div>
      <div className="scroll-thin grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(148px,1fr))] gap-2 overflow-y-auto border-t border-[var(--admin-divider)] bg-surface-2 p-3">
        {list.map((p) => (
          <ProductTile key={p.id} p={p} disabled={disabled} onQuickAdd={onQuickAdd} onCustomize={onCustomize} />
        ))}
        {list.length === 0 && <p className="col-span-full py-10 text-center text-sm text-muted">Bu aramada ürün yok</p>}
      </div>
    </div>
  );
}

/** Kategori çipi: Innex durum sekmesi gibi (beyaz, ince kenar; seçili koyu kenar). Kategori rengi yalnız küçük nokta */
function CategoryChip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: React.ReactNode }) {
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
 * Ürün kartı: dokununca eklenir (iki boyluda boy düğmeleri). Seçenekli üründe köşede seçenek düğmesi;
 * renkli şerit ve bölünmüş alt satır yok, durum (tükendi, son porsiyon) küçük rozet.
 */
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
  const label = p.shortName?.trim() || p.name;
  const off = soldOut || disabled;

  return (
    <div className={cn('relative flex min-h-[104px] flex-col rounded-xl border border-line bg-surface transition-colors hover:border-[var(--admin-border-field)]', off && 'opacity-50')}>
      <button
        disabled={off}
        onClick={() => (twoSizes || !hasOptions ? onQuickAdd(p, twoSizes ? 'M' : 'TEK') : onCustomize(p, 'TEK'))}
        className={cn('flex flex-1 flex-col items-start gap-1 rounded-xl px-3 pb-2.5 pt-2.5 text-left active:bg-surface-2', hasOptions && 'pr-11')}
      >
        <span className="line-clamp-2 text-sm font-semibold leading-snug">{label}</span>
        {soldOut ? (
          <span className="rounded-md bg-[var(--admin-danger-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--admin-danger-ink)]">Tükendi</span>
        ) : p.portionsLeft != null ? (
          <span className="tabular rounded-md bg-[var(--admin-warning-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--admin-warning)]">Son {p.portionsLeft}</span>
        ) : null}
        {!twoSizes && <span className="tabular mt-auto text-sm font-semibold text-ink-2">{tlShort(p.price)}</span>}
      </button>
      {hasOptions && (
        <button
          disabled={off}
          onClick={() => onCustomize(p, twoSizes ? 'M' : 'TEK')}
          aria-label={`${label} seçenekleri`}
          title="Seçenekler"
          className="absolute right-0 top-0 grid size-11 place-items-center rounded-xl text-muted transition-colors hover:text-primary"
        >
          <SlidersHorizontal className="size-4" strokeWidth={1.75} />
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
