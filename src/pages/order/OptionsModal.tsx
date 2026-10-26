import { Minus, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { tl, tlCompact } from '@shared/money';
import type { OptionGroupDTO, ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { estimateUnit, productGroups, useBoot } from '@/lib/boot';
import type { PendingLine } from '@/lib/cart';
import { cn } from '@/lib/cn';

const QUICK_NOTES = ['Az buzlu', 'Buzsuz', 'Çok sıcak', 'Ilık', 'Ayrı tabakta', 'Paket', 'Kremasız'];

type Picks = Record<string, number>; // itemId -> adet (tek seçimde 1)

function defaultPicks(groups: OptionGroupDTO[]): Picks {
  const p: Picks = {};
  for (const g of groups) {
    if (g.kind === 'single') {
      const d = g.items.find((i) => i.isDefault) ?? (g.required ? g.items[0] : undefined);
      if (d) p[d.id] = 1;
    }
  }
  return p;
}

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
  const groups = useMemo(() => (product ? productGroups(boot, product) : []), [boot, product]);
  const [size, setSize] = useState<Size>(initialSize);
  const [picks, setPicks] = useState<Picks>({});
  const [note, setNote] = useState('');
  const [qty, setQty] = useState(1);

  useEffect(() => {
    if (!product) return;
    if (editing) {
      setSize(editing.size);
      setPicks(Object.fromEntries(editing.options.map((o) => [o.itemId, o.qty ?? 1])));
      setNote(editing.note);
      setQty(editing.qty);
    } else {
      setSize(product.priceL != null ? (initialSize === 'L' ? 'L' : 'M') : 'TEK');
      setPicks(defaultPicks(groups));
      setNote('');
      setQty(1);
    }
  }, [product, editing, initialSize, groups]);

  if (!product) return null;
  const options = Object.entries(picks)
    .filter(([, n]) => n > 0)
    .map(([itemId, n]) => ({ itemId, qty: n }));
  const unit = estimateUnit(boot, product, size, options);

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
        <div className="flex items-center gap-3">
          <div className="flex items-center rounded-xl border border-line bg-surface">
            <button aria-label="Azalt" className="grid size-11 place-items-center" onClick={() => setQty(Math.max(1, qty - 1))}>
              <Minus className="size-4" />
            </button>
            <span className="tabular w-8 text-center text-lg font-semibold">{qty}</span>
            <button aria-label="Artır" className="grid size-11 place-items-center" onClick={() => setQty(Math.min(99, qty + 1))}>
              <Plus className="size-4" />
            </button>
          </div>
          <div className="flex-1" />
          <Button variant="primary" size="lg" onClick={() => onSubmit({ productId: product.id, size, qty, options, note: note.trim() })}>
            {editing ? 'Güncelle' : 'Ekle'} · {tl(unit * qty)}
          </Button>
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
                  onClick={() => setSize(s)}
                  className={cn('rounded-2xl border-2 p-3 text-left transition', size === s ? 'border-forest-600 bg-forest-50 dark:bg-forest-800' : 'border-line bg-surface')}
                >
                  <div className="font-semibold">{boot.settings.sizeLabels[s]}</div>
                  <div className="tabular text-sm text-muted">{tlCompact(s === 'L' ? product.priceL! : product.price)} ₺</div>
                </button>
              ))}
            </div>
          </section>
        )}

        {groups.map((g) => (
          <section key={g.id}>
            <h3 className="mb-2 text-sm font-semibold text-ink-2">{g.name}</h3>
            {g.kind === 'counter' ? (
              <div className="flex flex-wrap gap-2">
                {g.items.map((i) => (
                  <div key={i.id} className="flex items-center gap-3 rounded-2xl border border-line bg-surface px-3 py-2">
                    <span className="font-medium">
                      {i.name}
                      {i.price > 0 && <span className="ml-1 text-sm text-muted">+{tlCompact(i.price)} ₺</span>}
                    </span>
                    <div className="flex items-center gap-1">
                      <button aria-label="Azalt" className="grid size-9 place-items-center rounded-lg bg-surface-2" onClick={() => setCount(i.id, Math.max(0, (picks[i.id] ?? 0) - 1))}>
                        <Minus className="size-4" />
                      </button>
                      <span className="tabular w-6 text-center font-semibold">{picks[i.id] ?? 0}</span>
                      <button aria-label="Artır" className="grid size-9 place-items-center rounded-lg bg-surface-2" onClick={() => setCount(i.id, Math.min(i.maxQty, (picks[i.id] ?? 0) + 1))}>
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
                      onClick={() => (g.kind === 'single' ? pickSingle(g, i.id) : setCount(i.id, on ? 0 : 1))}
                      className={cn('rounded-xl border-2 px-3.5 py-2 text-sm font-medium transition', on ? 'border-forest-600 bg-forest-600 text-white' : 'border-line bg-surface text-ink')}
                    >
                      {i.name}
                      {i.price > 0 && <span className={cn('ml-1', on ? 'text-white/80' : 'text-muted')}>+{tlCompact(i.price)}</span>}
                      {i.allergens.includes('nuts') && <span className={cn('ml-1 text-[11px]', on ? 'text-white/80' : 'text-brass-600')}>(kuruyemiş)</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        ))}

        <section>
          <h3 className="mb-2 text-sm font-semibold text-ink-2">Not</h3>
          <div className="mb-2 flex flex-wrap gap-1.5">
            {QUICK_NOTES.map((n) => (
              <button
                key={n}
                onClick={() => setNote(note.includes(n) ? note.replace(n, '').replace(/\s*·\s*$/, '').replace(/^\s*·\s*/, '').trim() : note ? `${note} · ${n}` : n)}
                className={cn('rounded-full border px-3 py-1 text-sm', note.includes(n) ? 'border-brass-500 bg-brass-50 text-brass-700' : 'border-line text-ink-2')}
              >
                {n}
              </button>
            ))}
          </div>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value.slice(0, 200))}
            placeholder="Bara/mutfağa not"
            className="h-11 w-full rounded-xl border border-line-strong bg-surface px-3.5 outline-none focus:border-forest-500"
          />
        </section>
        {product.allergens && product.allergens.length > 0 && <p className="text-xs text-muted">Alerjen: {product.allergens.join(', ')}</p>}
      </div>
    </Modal>
  );
}
