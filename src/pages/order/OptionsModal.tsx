import { Minus, Pencil, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parseTL, tl, tlCompact, tlShort } from '@shared/money';
import type { OptionGroupDTO, ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Badge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { defaultPicks, estimateUnit, menuUnit, missingChoice, productGroups, useBoot } from '@/lib/boot';
import type { PendingLine } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';

const QUICK_NOTES = ['Az buzlu', 'Buzsuz', 'Çok sıcak', 'Ilık', 'Ayrı tabakta', 'Paket', 'Kremasız'];

type Picks = Record<string, number>; // itemId -> adet (tek seçimde 1)

// Seçenek ve hızlı not çipleri aynı dilde: 8 px köşe, seçilince mavi; amber bu sistemde durum rengidir, seçim rengi değil
const CHIP = 'min-h-11 rounded-lg border px-3.5 text-sm font-medium transition-colors duration-150 pointer-fine:min-h-10';
const CHIP_ON = 'border-primary bg-[var(--admin-primary-soft)] text-primary';
const CHIP_OFF = 'border-line bg-surface text-ink hover:border-[var(--admin-border-field)] active:bg-press';

/** Ürün seçenekleri: boy, süt, kavrum, şurup, ekstra shot, şeker, not ve adet. */
export function OptionsModal({
  product,
  initialSize,
  editing,
  onClose,
  onSubmit,
}: {
  product: ProductDTO | null;
  initialSize: Size;
  editing?: PendingLine | null;
  onClose: () => void;
  onSubmit: (line: Omit<PendingLine, 'key'>) => void;
}) {
  const boot = useBoot();
  const fine = useFinePointer();
  // Zorunlu grup (şeker) boyun hemen altında: telefonda pencerenin dibinde kalıp gözden kaçmasın
  const groups = useMemo(() => (product ? productGroups(boot, product).sort((a, b) => Number(b.required) - Number(a.required)) : []), [boot, product]);
  const [size, setSize] = useState<Size>(initialSize);
  const [picks, setPicks] = useState<Picks>({});
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(1);
  // Elle fiyat (açık ürün, pazarlıklı satış): boşsa menü fiyatı. Sunucu yetki ister, denetim kaydına yazar
  const [priceText, setPriceText] = useState('');
  // Elle fiyat bölümü yalnız açık üründe (fiyatı 0) ya da zaten elle fiyat yazılmışsa açık; diğer üründe küçük düğmenin ardında
  const [priceOpen, setPriceOpen] = useState(false);

  useEffect(() => {
    if (!product) return;
    if (editing) {
      setSize(editing.size);
      setPicks(Object.fromEntries(editing.options.map((o) => [o.itemId, o.qty ?? 1])));
      setNote(editing.note);
      setQty(editing.qty);
      setPriceText(editing.priceOverride != null ? String(editing.priceOverride / 100).replace('.', ',') : '');
      setPriceOpen(editing.priceOverride != null || product.price === 0);
    } else {
      setSize(product.priceL != null ? (initialSize === 'L' ? 'L' : 'M') : 'TEK');
      setPicks(defaultPicks(groups));
      setNote('');
      setQty(1);
      setPriceText('');
      setPriceOpen(product.price === 0);
    }
  }, [product, editing, initialSize, groups]);

  if (!product) return null;
  const options = Object.entries(picks)
    .filter(([, n]) => n > 0)
    .map(([itemId, n]) => ({ itemId, qty: n }));
  const override = priceText.trim() ? parseTL(priceText) : null;
  const unit = override ?? estimateUnit(boot, product, size, options);
  // Zorunlu grup (şeker) seçilmeden Ekle kapalı: sunucu boş grupta varsayılanı yazardı, kasiyer sormadan geçmesin
  const missing = missingChoice(groups, picks);

  // Tek seçimlik grup radyo düğmesi gibi davranır: dokunulan seçilir, gruptaki diğerleri kalkar
  const pickSingle = (g: OptionGroupDTO, itemId: string) => {
    const next = { ...picks };
    for (const i of g.items) delete next[i.id];
    next[itemId] = 1;
    setPicks(next);
  };
  const setCount = (itemId: string, n: number) => setPicks({ ...picks, [itemId]: n });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={product.name}
      subtitle={product.description ?? undefined}
      footer={
        // Eksik zorunlu seçimin yazısı Ekle'nin altında kendi satırında (bilgi cümlesi devre dışı düğmede durmaz)
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <div className="flex items-center rounded-xl border border-line bg-surface">
            <button aria-label="Azalt" className="grid size-11 place-items-center rounded-l-xl transition-colors duration-150 hover:bg-hover active:bg-press" onClick={() => setQty(Math.max(1, qty - 1))}>
              <Minus className="size-4" />
            </button>
            <span className="tabular w-8 text-center text-lg font-semibold">{qty}</span>
            <button aria-label="Artır" className="grid size-11 place-items-center rounded-r-xl transition-colors duration-150 hover:bg-hover active:bg-press" onClick={() => setQty(Math.min(99, qty + 1))}>
              <Plus className="size-4" />
            </button>
          </div>
          <div className="flex-1" />
          <Button variant="primary" size="lg" disabled={!!missing} aria-describedby={missing ? 'secenek-eksik' : undefined} onClick={() => onSubmit({ productId: product.id, size, qty, options, note: note.trim(), priceOverride: override })}>
            {editing ? 'Güncelle' : 'Ekle'} · {tl(unit * qty)}
          </Button>
          {missing && (
            <p id="secenek-eksik" className="basis-full text-right text-sm font-medium text-ink-2">
              {missing.name} seçin
            </p>
          )}
        </div>
      }
    >
      <div className="space-y-5 p-5">
        {product.priceL != null && (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink-2">Boy</h3>
            <div className="grid grid-cols-2 gap-2">
              {(['M', 'L'] as const).map((s) => (
                <button
                  key={s}
                  aria-pressed={size === s}
                  onClick={() => setSize(s)}
                  className={cn('rounded-xl border p-3 text-left transition-colors duration-150', size === s ? 'border-primary bg-[var(--admin-primary-soft)] text-primary' : 'border-line bg-surface hover:border-[var(--admin-border-field)] active:bg-press')}
                >
                  <div className="font-semibold">{boot.settings.sizeLabels[s]}</div>
                  <div className="tabular text-sm text-muted">{tlShort(s === 'L' ? product.priceL! : product.price)}</div>
                </button>
              ))}
            </div>
          </section>
        )}

        {groups.map((g) => (
          <section key={g.id}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-ink-2">
              {g.name}
              {g.required && g.kind !== 'counter' && <Badge>Zorunlu</Badge>}
            </h3>
            {g.kind === 'counter' ? (
              <div className="flex flex-wrap gap-2">
                {g.items.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-1.5">
                    <span className="font-medium">
                      {i.name}
                      {i.price > 0 && <span className="ml-1 text-sm text-muted">+{tlShort(i.price)}</span>}
                    </span>
                    <div className="flex items-center gap-1">
                      <button aria-label="Azalt" className="grid size-9 place-items-center rounded-lg bg-surface-3 transition-colors duration-150 active:bg-[var(--admin-border)] pointer-coarse:size-11" onClick={() => setCount(i.id, Math.max(0, (picks[i.id] ?? 0) - 1))}>
                        <Minus className="size-4" />
                      </button>
                      <span className="tabular w-6 text-center font-semibold">{picks[i.id] ?? 0}</span>
                      <button aria-label="Artır" className="grid size-9 place-items-center rounded-lg bg-surface-3 transition-colors duration-150 active:bg-[var(--admin-border)] pointer-coarse:size-11" onClick={() => setCount(i.id, Math.min(i.maxQty, (picks[i.id] ?? 0) + 1))}>
                        <Plus className="size-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-2">
                {g.items.map((i) => {
                  const on = !!picks[i.id];
                  return (
                    <button
                      key={i.id}
                      aria-pressed={on}
                      onClick={() => (g.kind === 'single' ? pickSingle(g, i.id) : setCount(i.id, on ? 0 : 1))}
                      className={cn(CHIP, on ? CHIP_ON : CHIP_OFF)}
                    >
                      {i.name}
                      {i.price > 0 && <span className={cn('tabular ml-1', on ? 'text-primary/80' : 'text-muted')}>+{tlCompact(i.price)}</span>}
                      {i.allergens.includes('nuts') && <span className="ml-1 text-[11px] text-[var(--admin-warning)]">(kuruyemiş)</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ))}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink-2">Not</h3>
          <div className="mb-2 flex flex-wrap gap-2">
            {QUICK_NOTES.map((n) => (
              <button
                key={n}
                aria-pressed={note.includes(n)}
                onClick={() => setNote(note.includes(n) ? note.replace(n, '').replace(/\s*·\s*$/, '').replace(/^\s*·\s*/, '').trim() : note ? `${note} · ${n}` : n)}
                className={cn(CHIP, note.includes(n) ? CHIP_ON : CHIP_OFF)}
              >
                {n}
              </button>
            ))}
          </div>
          <Input value={note} onChange={(e) => setNote(e.target.value.slice(0, 200))} placeholder="Ör. az şekerli, bardakta" aria-label="Bara ve mutfağa not" />
        </section>
        {priceOpen ? (
          <section>
            <h3 className="mb-2 text-sm font-semibold text-ink-2">Birim fiyat</h3>
            <Input
              value={priceText}
              onChange={(e) => setPriceText(e.target.value.replace(/[^\d.,]/g, '').slice(0, 9))}
              inputMode="decimal"
              placeholder={`${tl(menuUnit(boot, product, size, options))} (menü fiyatı)`}
              aria-label="Elle birim fiyat"
              className="tabular"
              autoFocus={fine && product.price === 0 && !editing}
            />
            <p className="mt-1 text-xs text-muted">Yetkili onayı ister ve denetim kaydına düşer</p>
          </section>
        ) : (
          <Button variant="ghost" size="sm" icon={<Pencil className="size-4" />} onClick={() => setPriceOpen(true)} className="-ml-3">
            Elle fiyat
          </Button>
        )}
        {product.allergens && product.allergens.length > 0 && <p className="text-xs text-muted">Alerjen: {product.allergens.join(', ')}</p>}
      </div>
    </Modal>
  );
}
