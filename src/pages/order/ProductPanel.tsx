import { Plus, SlidersHorizontal, Star, Tag } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { tlShort } from '@shared/money';
import type { ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { SearchInput } from '@/components/ui/Field';
import { EmptyState } from '@/components/ui/misc';
import { asksOptions, productGroups, useBoot } from '@/lib/boot';
import { categoryIcon } from '@/lib/categoryIcon';
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
    ...(showFavorites ? [{ id: FAVORITES, name: 'Sık kullanılanlar', count: favorites.length }] : []),
    ...categories.map((c) => ({ id: c.id, name: c.name, count: counts.get(c.id) ?? 0 })),
  ];

  return (
    // Pano: solda alt menü kartında kategoriler (yönetimin alt menüsüyle tek bileşen: `.lp-subnav`, `.lp-menu-col`,
    // `.lp-menu-item`; ikon, ad, sağda ürün sayısı; seçili açık nane), ortada ürün kartları zeminde; hesap sağdaki
    // yaprakta (OrderPage). Tablette ve telefonda kategoriler aynı sekme şeridi (üst çubuğun sekmeleriyle aynı)
    <div className="flex h-full min-h-0 gap-[var(--grid-gap)] bg-[var(--admin-stage)] md:bg-transparent">
      {/* Geniş ekran: alt menü kartı (genişlik --side-w), kategoriler alt alta, sığmazsa kart kendi içinde kayar */}
      <nav aria-label="Menü" className="lp-subnav hidden w-[var(--side-w)] shrink-0 xl:block">
        <div className="lp-menu lp-menu-col">
          <span className="lp-menu-label">Kategoriler</span>
          <div role="tablist" aria-orientation="vertical" aria-label="Kategoriler" className="flex flex-col gap-0.5">
            {categoryItems.map((c) => (
              <CategoryItem key={c.id} active={!q && current === c.id} count={c.count} name={c.name} favorite={c.id === FAVORITES} onClick={() => pick(c.id)} />
            ))}
          </div>
        </div>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="px-3 pt-2 md:px-0 md:pt-0">
          {/* Ortak arama alanı (hap; temizle düğmesi, Escape); boşken farede "/" kısayolu ipucu */}
          <div className="relative">
            <SearchInput ref={searchRef} value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ara" className="h-11 rounded-[0.875rem] border-[var(--admin-border)] bg-surface shadow-[var(--shadow-control)]" />
            {!q && (
              <kbd aria-hidden="true" className="pointer-events-none absolute right-4 top-1/2 hidden -translate-y-1/2 rounded-md border border-line bg-surface-2 px-1.5 text-xs font-medium text-muted pointer-fine:inline-block">
                /
              </kbd>
            )}
          </div>
        </div>
        {/* Tablet ve telefon: aynı sekmeler yatay şeritte; sağı solarak biter (devamı belli olur), seçili sekme görünür alana kaydırılır */}
        <div
          role="tablist"
          aria-label="Kategoriler"
          className="lp-menu snap-x snap-proximity scroll-px-3 px-3 py-2.5 [mask-image:linear-gradient(to_right,#000_calc(100%-28px),transparent)] md:px-0 md:py-3 xl:hidden"
        >
          {categoryItems.map((c) => (
            <CategoryItem key={c.id} strip active={!q && current === c.id} count={c.count} name={c.name} favorite={c.id === FAVORITES} onClick={() => pick(c.id)} />
          ))}
        </div>
        <div
          key={q ? 'arama' : current}
          className={cn(
            // Karo ızgarası (`.lp-tiles`, en dar sütun --tile-min 140): 768 px tablette hesabın yanında iki sütun,
            // bilgisayarda üç-dört
            'lp-enter lp-tiles scroll-thin min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-1 md:px-1 md:pb-2 xl:pt-3.5',
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
 * Kategori satırı (yönetimin alt menüsüyle tek bileşen, operatör 20 Kas 2026: "componentleri bir yap, farklı olmasın"):
 * `.lp-menu-item`: tek renk ikon (adından eşlenir, yoksa etiket), ad, sağda ürün sayısı; üstüne gelince çok açık gri,
 * seçili açık nane zeminde yeşil ve kalın. Geniş ekranda alt menü kartında alt alta, darda yatay sekme şeridinde
 * (`strip`: seçili sekme görünür alana kaydırılır)
 */
function CategoryItem({ active, count, name, favorite, strip, onClick }: { active: boolean; count: number; name: string; favorite?: boolean; strip?: boolean; onClick: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (strip && active) ref.current?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
  }, [strip, active]);
  const Icon = favorite ? Star : (categoryIcon(name) ?? Tag);
  return (
    <button ref={ref} type="button" role="tab" aria-selected={active} onClick={onClick} className={cn('lp-menu-item focus-visible:-outline-offset-2', strip && 'snap-start')}>
      <Icon aria-hidden="true" />
      {/* Şeritte yer dar: sık kullanılanlar yıldızla "Sık" */}
      <span className="min-w-0 flex-1 truncate">{favorite && strip ? 'Sık' : name}</span>
      {!strip && <span className="n">{count}</span>}
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
        // Pano kartı: beyaz, köşe 20, kenarsız ve yumuşak gölgeli; üstüne gelince kalkar, basılıyken hafif küçülür
        // Pano kartı: beyaz, köşe 20, ince çerçeve ve çok hafif gölge; üstüne gelince çerçeve ev yeşili, kart kalkar
        'group relative flex flex-col rounded-[1.25rem] border border-[var(--admin-border)] bg-surface shadow-[var(--shadow-control)] transition-[border-color,transform,box-shadow] duration-150 hover:-translate-y-0.5 hover:border-[var(--admin-primary-line)] hover:shadow-[var(--shadow-lift)] has-[button:active]:scale-[0.985] has-[button:active]:border-[var(--admin-primary)] motion-reduce:hover:translate-y-0 motion-reduce:has-[button:active]:scale-100',
        withImage ? 'min-h-[176px]' : 'min-h-[96px]',
        soldOut && 'opacity-50',
      )}
    >
      {/* Kategorinin rengi kartın tepesinde kısa bir şerit: aramada ve sık kullanılanlarda kart kategorisiyle tanınır */}
      {hue && <span aria-hidden="true" className="pointer-events-none absolute left-4 top-0 h-1 w-7 rounded-b-full" style={{ background: hue }} />}
      <button
        disabled={soldOut}
        onClick={() => addSize(twoSizes ? 'M' : 'TEK')}
        aria-haspopup={ask ? 'dialog' : undefined}
        // İki boylu kartta ad tek satırsa düğme 41 px kalıyordu: dokunmatikte 44 (kart da pencereyi açabilir)
        className="flex min-h-11 flex-1 flex-col items-stretch rounded-[1.25rem] text-left transition-colors duration-150 active:bg-press pointer-fine:min-h-0"
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
        <span className={cn('flex flex-1 flex-col items-start gap-1.5 px-3.5 pb-3', withImage ? 'pt-2' : 'justify-between pt-3')}>
          {/* Seçenek düğmesi sağ üstte: ad onun altına girmesin */}
          <span className={cn('line-clamp-2 font-headline text-[15px] font-semibold leading-[1.2] tracking-[-0.015em]', !withImage && hasOptions && 'pr-8')}>{label}</span>
          {soldOut ? (
            <span className="rounded-lg bg-[var(--admin-danger-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--admin-danger-ink)]">Tükendi</span>
          ) : p.portionsLeft != null ? (
            <span className="tabular rounded-lg bg-[var(--admin-warning-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--admin-warning)]">Son {p.portionsLeft}</span>
          ) : null}
          {!twoSizes && (
            // Fiyat solda kalın; sağda ekle işareti (panonun yumuşak tonlu ikon dairesi): kartın tamamı ekler, daire yalnız işaret
            <span className="mt-auto flex w-full items-center justify-between gap-2">
              <span className="tabular font-headline text-[17px] font-bold tracking-[-0.03em] text-ink">{tlShort(p.price)}</span>
              {!soldOut && (
                <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--admin-primary-soft)] text-[var(--admin-primary)] transition-colors duration-150 group-hover:bg-[var(--admin-ink-fill)] group-hover:text-[var(--admin-on-ink)]">
                  <Plus className="size-4 stroke-[2.25]" />
                </span>
              )}
            </span>
          )}
        </span>
      </button>
      {hasOptions && (
        <button
          disabled={soldOut}
          onClick={() => onCustomize(p, twoSizes ? 'M' : 'TEK')}
          aria-label={`${label} seçenekleri`}
          title="Seçenekler"
          className={cn(
            'absolute right-0.5 top-0.5 grid size-11 place-items-center text-ink-2 transition-colors duration-150 hover:text-primary active:text-primary',
            withImage ? 'rounded-xl' : 'rounded-2xl',
          )}
        >
          {/* Seçenekler: yumuşak tonlu daire (panonun ikon dairesi); fotoğrafın üstünde beyaz. Dokunma alanı 44 px */}
          <span className={cn('grid size-8 place-items-center rounded-full', withImage ? 'bg-surface/90 shadow-[0_1px_3px_rgb(15_35_28/0.18)] backdrop-blur-sm' : 'bg-surface-2')}>
            <SlidersHorizontal className="size-4" />
          </span>
        </button>
      )}
      {twoSizes && (
        <div className="grid grid-cols-2 gap-2 px-2.5 pb-2.5">
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
      className="flex min-h-11 flex-col items-center justify-center rounded-xl bg-[var(--admin-primary-soft)] leading-tight text-[var(--admin-primary)] transition-[background-color,color,box-shadow] duration-150 hover:bg-[var(--admin-ink-fill)] hover:text-[var(--admin-on-ink)] active:bg-[var(--admin-ink-fill)] active:text-[var(--admin-on-ink)] pointer-fine:min-h-10"
    >
      <span className="text-[11px] font-medium opacity-80">{label}</span>
      <span className="tabular font-headline text-[14px] font-bold text-ink [button:hover>&]:text-[var(--admin-on-ink)] [button:active>&]:text-[var(--admin-on-ink)]">{tlShort(price)}</span>
    </button>
  );
}
