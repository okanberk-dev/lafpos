import { SlidersHorizontal, Star } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { tlShort } from '@shared/money';
import type { ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/misc';
import { asksOptions, productGroups, useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref } from '@/lib/hooks';
import { DEMO, demoProductImage } from '@/lib/demo';

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

export function ProductPanel({ onQuickAdd, onCustomize }: { onQuickAdd: (p: ProductDTO, size: Size) => void; onCustomize: (p: ProductDTO, size: Size) => void }) {
  const boot = useBoot();
  const [categoryId, setCategoryId] = useLocalPref<string>('order.category', FAVORITES);
  const [q, setQ] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  // Klavyede "/" ürün aramasına götürür (yazı alanındayken değil); Esc aramayı temizler
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName))) return;
      if (document.querySelector('[role="dialog"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  // Listede görselli ürün varsa bütün kartlar görsel alanıyla çizilir: satırlar aynı boyda kalır. Görseller siteden
  // gelir: site bağlantısı kurulmamışken (LAFFOGATO_URL) sunucu onları indirmez, kartlar görselsiz çizilir
  const withImages = boot.settings.productImages && !!boot.integrations.laffogatoUrl && list.some((p) => p.image);

  // Arama sürerken kategoriye dokunmak o kategoriyi gösterir: arama temizlenir (yoksa ızgara arama sonucunda kalır, dokunuş
  // boşa gider)
  const pick = (id: string) => {
    setQ('');
    setCategoryId(id);
  };

  const categoryItems = [
    ...(showFavorites ? [{ id: FAVORITES, name: 'Sık', color: null as string | null, count: favorites.length }] : []),
    ...categories.map((c) => ({ id: c.id, name: c.name, color: c.color, count: counts.get(c.id) ?? 0 })),
  ];

  return (
    // Kitin sahnesi: solda kategorilerin numaralı menüsü, ortada ürün kartları gri sahnenin üstünde (kitin tepsisindeki
    // kartlar gibi); hesap sağdaki beyaz yaprakta (OrderPage). Telefonda sahne zemini, çip şeridi ve kartlar
    <div className="flex h-full min-h-0 bg-[var(--admin-stage)] md:bg-transparent">
      {/* Geniş ekran: kategoriler solda alt alta, numaralı (01, 02…), hepsi görünür */}
      <div className="scroll-thin hidden w-52 shrink-0 overflow-y-auto pr-2.5 xl:block">
        <div role="tablist" aria-orientation="vertical" aria-label="Kategoriler" className="lp-menu lp-menu-col">
          {categoryItems.map((c) => (
            <CategoryRow key={c.id} active={!q && current === c.id} color={c.color} count={c.count} onClick={() => pick(c.id)} favorite={c.id === FAVORITES}>
              {c.name}
            </CategoryRow>
          ))}
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-3 pt-2 md:px-0 md:pt-0">
          {/* Ortak arama alanı (hap; temizle düğmesi, Escape); boşken farede "/" kısayolu ipucu */}
          <div className="relative">
            <SearchInput ref={searchRef} value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ara" className="border-[var(--admin-border-strong)]" />
            {!q && (
              <kbd aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-line bg-surface-2 px-1.5 text-xs font-medium text-muted pointer-fine:inline-block">
                /
              </kbd>
            )}
          </div>
        </div>
        {/* Rayın sağı solarak biter: devamı olduğu belli olur; seçili çip görünür alana kaydırılır */}
        <div
          role="tablist"
          aria-label="Kategoriler"
          className="no-scrollbar flex snap-x snap-proximity scroll-px-3 gap-1.5 overflow-x-auto px-3 py-2 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] md:px-0 md:py-3 xl:hidden"
        >
          {categoryItems.map((c) => (
            <CategoryChip key={c.id} active={!q && current === c.id} color={c.color} onClick={() => pick(c.id)}>
              {c.id === FAVORITES && <Star aria-hidden="true" className="size-3.5" />}
              {c.name}
            </CategoryChip>
          ))}
        </div>
        <div
          key={q ? 'arama' : current}
          className={cn(
            // 150 px: 768 px tablette hesap yaprağının yanında iki sütun, bilgisayarda üç-dört
            'lp-enter scroll-thin grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(132px,1fr))] gap-2.5 overflow-y-auto px-3 pb-3 pt-1 md:px-0 md:pb-1 xl:pt-3',
          )}
        >
          {list.map((p) => (
            <ProductTile key={p.id} p={p} withImage={withImages} onQuickAdd={onQuickAdd} onCustomize={onCustomize} />
          ))}
          {list.length === 0 && (
            <div className="col-span-full rounded-[1.125rem] bg-surface">
              {q.trim() ? (
                <EmptyState
                  compact
                  art="arama"
                  title={`“${q.trim()}” ile eşleşen ürün yok`}
                  action={
                    <Button size="sm" variant="ghost" onClick={() => setQ('')}>
                      Aramayı temizle
                    </Button>
                  }
                >
                  Adın, kısa adın ya da barkodun bir bölümünü yazın
                </EmptyState>
              ) : (
                <EmptyState compact art="kategori" title="Bu kategoride satışta ürün yok" />
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Dikey kategori satırı (kitin numaralı menüsü): 01, 02… numara, kategori rengi küçük nokta, sağda ürün sayısı; seçili
 * satırın solunda mürekkep nokta ve satır içeri kayar
 */
function CategoryRow({ active, color, count, favorite, onClick, children }: { active: boolean; color: string | null; count: number; favorite?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={active} onClick={onClick} className="lp-menu-item min-h-11 text-[15px] focus-visible:-outline-offset-2">
      {favorite ? (
        <Star aria-hidden="true" className="size-3.5 shrink-0 stroke-2 text-[var(--laf-bean)]" />
      ) : (
        // Kategori rengi koyu kartta kaybolmasın: ince halka
        <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/25" style={{ background: color ?? 'var(--admin-border-field)' }} />
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="n text-sm">{count}</span>
    </button>
  );
}

/** Kategori çipi (telefon, tablet; kitin çipi): beyaz hap; seçili mürekkep dolgu. Kategori rengi yalnız küçük nokta */
function CategoryChip({ active, color, onClick, children }: { active: boolean; color?: string | null; onClick: () => void; children: React.ReactNode }) {
  const ref = useRef<HTMLButtonElement>(null);
  // Seçili kategori (sayfa yenilenince de) rayda görünür kalsın
  useEffect(() => {
    if (active) ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [active]);
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex min-h-11 shrink-0 snap-start items-center gap-1.5 rounded-full border px-4 font-headline text-[15px] tracking-[-0.015em] whitespace-nowrap transition-[color,border-color,background-color] duration-150 active:brightness-95 pointer-fine:min-h-10',
        active ? 'border-[var(--admin-ink-fill)] bg-[var(--admin-ink-fill)] font-semibold text-[var(--admin-on-ink)]' : 'border-[var(--admin-border-strong)] bg-surface font-medium text-ink-2 hover:border-[var(--admin-text)] hover:text-ink',
      )}
    >
      {color && <span aria-hidden="true" className="size-2 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/25" style={{ background: color }} />}
      {children}
    </button>
  );
}

/**
 * Ürün kartı: dokununca eklenir (iki boyluda boy düğmeleri; zorunlu seçimi olan iki boylu ürün seçenek penceresiyle). Görselli düzende üstte sitedeki ürün fotoğrafı
 * (dekupaj, gri sahnede), görseli olmayan üründe adın baş harfleri. Seçenekli üründe köşede seçenek düğmesi;
 * durum (tükendi, son porsiyon) küçük rozet.
 */
function ProductTile({
  p,
  withImage,
  onQuickAdd,
  onCustomize,
}: {
  p: ProductDTO;
  withImage: boolean;
  onQuickAdd: (p: ProductDTO, size: Size) => void;
  onCustomize: (p: ProductDTO, size: Size) => void;
}) {
  const boot = useBoot();
  const [broken, setBroken] = useState(false);
  // Dekupaj (saydam köşe) gri sahnede ortada durur; fotoğraf sahneyi doldurur
  const [photo, setPhoto] = useState(false);
  const soldOut = !p.active;
  // Açık gruplardan (asksOptions ve needsChoice ile aynı kaynak): tek grubu kapatılmış ürün hızlı eklenir, simgesi çıkmaz
  const hasOptions = productGroups(boot, p).length > 0;
  const twoSizes = p.priceL != null;
  const label = p.shortName?.trim() || p.name;
  // Zorunlu seçim (Türk kahvesinde şeker) varsa ya da ayar "Seçenekli her üründe" ise kart ve boy düğmesi hemen
  // eklemez, seçenek penceresini o boy seçili açar. Yalnız isteğe bağlı seçeneği olan ürün (tek boylu da) tek dokunuşla
  // eklenir, sunucu varsayılanı yazar (Normal süt); değişiklik köşedeki seçenek düğmesinden. Fiyatı 0 olan açık ürün
  // (etkinlik ücreti, özel pasta) fiyat girilsin diye hep pencereyle
  const ask = asksOptions(boot, p) || (!twoSizes && p.price <= 0);
  const addSize = (size: Size) => (ask ? onCustomize(p, size) : onQuickAdd(p, size));
  const src = !p.image || broken ? null : DEMO ? demoProductImage(p.image) : `/media/products/${p.id}?v=${imageVersion(p.image)}`;
  // Görseli olmayan üründe baş harfler kategori renginin açık tonunda (kart ızgarada kategorisiyle tanınır)
  const hue = boot.categories.find((c) => c.id === p.categoryId)?.color;

  return (
    <div
      className={cn(
        'group relative flex flex-col rounded-[1.125rem] border border-transparent bg-surface shadow-[var(--shadow-card)] transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-px hover:border-[var(--admin-text)] has-[button:active]:scale-[0.985] has-[button:active]:border-[var(--admin-text)] motion-reduce:hover:translate-y-0 motion-reduce:has-[button:active]:scale-100 dark:border-[var(--admin-border)]',
        withImage ? 'min-h-[176px]' : 'min-h-[88px]',
        soldOut && 'opacity-50',
      )}
    >
      {/* Kategorinin rengi kartın tepesinde kısa bir şerit: ızgara canlı, kart kategorisiyle tanınır */}
      {hue && <span aria-hidden="true" className="pointer-events-none absolute left-4 top-0 h-1 w-8 rounded-b-full" style={{ background: hue }} />}
      <button
        disabled={soldOut}
        onClick={() => addSize(twoSizes ? 'M' : 'TEK')}
        aria-haspopup={ask ? 'dialog' : undefined}
        // İki boylu kartta ad tek satırsa düğme 41 px kalıyordu: dokunmatikte 44 (kart da pencereyi açabilir)
        className={cn('flex min-h-11 flex-1 flex-col items-stretch rounded-[1.125rem] text-left transition-colors duration-150 active:bg-press pointer-fine:min-h-0', !withImage && hasOptions && 'pr-12')}
      >
        {withImage && (
          <span
            aria-hidden="true"
            className="relative mx-1.5 mt-1.5 grid h-[88px] place-items-center overflow-hidden rounded-xl bg-surface-2"
            style={!src && hue ? { background: `color-mix(in oklab, ${hue} 12%, var(--surface-2))` } : undefined}
          >
            {src ? (
              <img
                src={src}
                alt=""
                loading="lazy"
                decoding="async"
                draggable={false}
                onError={() => setBroken(true)}
                onLoad={(e) => setPhoto(isOpaque(e.currentTarget))}
                // Görsel sabit: süs yakınlaşma yok; basılı durumu kartın kendi ölçeği verir
                className={photo ? 'size-full object-cover' : 'h-[80px] w-full object-contain'}
              />
            ) : (
              <span className="text-xl font-semibold tracking-tight text-[var(--admin-border-field)]/80" style={hue ? { color: `color-mix(in oklab, ${hue} 55%, var(--surface-2))` } : undefined}>
                {initials(label)}
              </span>
            )}
          </span>
        )}
        <span className={cn('flex flex-1 flex-col items-start gap-1.5 px-3 pb-2.5', withImage ? 'pt-2' : 'justify-between pt-2.5')}>
          <span className="line-clamp-2 font-headline text-[16px] font-bold leading-[1.15] tracking-[-0.025em]">{label}</span>
          {soldOut ? (
            <span className="rounded-full bg-[var(--admin-danger-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--admin-danger-ink)]">Tükendi</span>
          ) : p.portionsLeft != null ? (
            <span className="tabular rounded-full bg-[var(--admin-warning-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--admin-warning)]">Son {p.portionsLeft}</span>
          ) : null}
          {!twoSizes && <span className="tabular mt-auto font-headline text-[17px] font-bold tracking-[-0.03em] text-ink">{tlShort(p.price)}</span>}
        </span>
      </button>
      {hasOptions && (
        <button
          disabled={soldOut}
          onClick={() => onCustomize(p, twoSizes ? 'M' : 'TEK')}
          aria-label={`${label} seçenekleri`}
          title="Seçenekler"
          className={cn(
            'absolute right-0 top-0 grid size-11 place-items-center text-ink-2 transition-colors duration-150 hover:text-primary active:text-primary',
            withImage ? 'rounded-xl' : 'rounded-2xl',
          )}
        >
          {withImage ? (
            // Fotoğrafın üstünde okunur kalsın: beyaz hap; dokunma alanı yine 44 px
            <span className="grid size-9 place-items-center rounded-full bg-surface/90 text-ink-2 shadow-[0_1px_3px_rgb(59_42_30/0.18)] backdrop-blur-sm">
              <SlidersHorizontal className="size-[18px]" />
            </span>
          ) : (
            <SlidersHorizontal className="size-[18px]" />
          )}
        </button>
      )}
      {twoSizes && (
        <div className="grid grid-cols-2 gap-2 px-2 pb-2">
          <SizeButton disabled={soldOut} dialog={ask} label={boot.settings.sizeLabels.M} price={p.price} onClick={() => addSize('M')} />
          <SizeButton disabled={soldOut} dialog={ask} label={boot.settings.sizeLabels.L} price={p.priceL!} onClick={() => addSize('L')} />
        </div>
      )}
    </div>
  );
}

function SizeButton({ label, price, onClick, disabled, dialog }: { label: string; price: number; onClick: () => void; disabled?: boolean; dialog?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      aria-label={`${label} ${tlShort(price)}`}
      aria-haspopup={dialog ? 'dialog' : undefined}
      className="flex min-h-11 flex-col items-center justify-center rounded-full bg-surface-3 leading-tight transition-[background-color,color,box-shadow] duration-150 hover:bg-[var(--admin-ink-fill)] hover:text-[var(--admin-on-ink)] active:bg-[var(--admin-ink-fill)] active:text-[var(--admin-on-ink)] pointer-fine:min-h-10"
    >
      <span className="text-[11px] font-medium opacity-75">{label}</span>
      <span className="tabular font-headline text-[14px] font-bold">{tlShort(price)}</span>
    </button>
  );
}
