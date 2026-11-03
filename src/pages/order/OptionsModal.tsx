import { Pencil } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { parseTL, tl, tlCompact, tlShort } from '@shared/money';
import type { ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Input, Stepper } from '@/components/ui/Field';
import { Badge } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { defaultPicks, editingPicks, estimateUnit, menuUnit, missingChoice, pickHint, pickNote, pickSingle, productGroups, reconcilePicks, useBoot } from '@/lib/boot';
import type { PendingLine } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';

const QUICK_NOTES = ['Az buzlu', 'Buzsuz', 'Çok sıcak', 'Ilık', 'Ayrı tabakta', 'Paket', 'Kremasız'];

/**
 * Sitenin alerjen anahtarları (TGK Ek-1, laffogato src/lib/menu/allergens.ts) ve seçeneklerdeki `nuts` etiketi:
 * personel müşteriye okur, anahtar ("sut, sert_kabuklu") değil ad yazılır. Bilinmeyen anahtar alt çizgisiz kalır
 */
const ALLERGEN_LABEL: Record<string, string> = {
  gluten: 'Gluten',
  kabuklular: 'Kabuklular',
  yumurta: 'Yumurta',
  balik: 'Balık',
  yer_fistigi: 'Yer fıstığı',
  soya: 'Soya',
  sut: 'Süt',
  sert_kabuklu: 'Sert kabuklu meyveler',
  kereviz: 'Kereviz',
  hardal: 'Hardal',
  susam: 'Susam',
  sulfit: 'Sülfit',
  aci_bakla: 'Acı bakla',
  yumusakcalar: 'Yumuşakçalar',
  nuts: 'Kuruyemiş',
};
const allergenLabel = (key: string) => ALLERGEN_LABEL[key] ?? key.replace(/_/g, ' ');

type Picks = Record<string, number>; // itemId -> adet (tek seçimde 1)

// Seçenek ve hızlı not çipleri aynı dilde: 10 px köşe, seçilince ev yeşili; amber bu sistemde durum rengidir, seçim rengi değil
const CHIP = 'min-h-11 rounded-lg border px-3.5 text-sm font-medium transition-colors duration-150 pointer-fine:min-h-10';
const CHIP_ON = 'border-primary bg-[var(--admin-primary-soft)] text-primary';
const CHIP_OFF = 'border-line bg-surface text-ink hover:border-[var(--admin-border-field)] active:bg-press';
// Kasada tükenen seçenek: gri, seçilemez, yanında "Tükendi" (Tükenen ürünler › Seçenekler)
const CHIP_SOLD = 'border-line bg-surface-2 text-muted disabled:cursor-not-allowed';
const SOLD_BADGE = 'ml-1.5 rounded-full bg-[var(--admin-danger-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--admin-danger-ink)]';

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

  // Menü olayı (bardan seçenek tükendi) açılış verisini yeniler, groups yeni dizi olur. Başlangıç seçimi yalnız pencere
  // açılırken ya da ürün, düzenlenen satır, başlangıç boyu değişince kurulur; gruplar o anki halinden okunur. Yoksa
  // seçim, not ve adet sessizce sıfırlanır, seçiliyken tükenen Yulaf uyarısız normal süte dönerdi
  const groupsRef = useRef(groups);
  useEffect(() => {
    groupsRef.current = groups;
  }, [groups]);

  useEffect(() => {
    if (!product) return;
    if (editing) {
      setSize(editing.size);
      // Bu arada tükenen seçenek seçili kalır: grubu uyarır, Güncelle kasiyer bırakana ya da başkasını seçene dek kapalı.
      // Grubu kapanan ya da kaldırılan seçenek düşer (sunucu 400 döner, bütün bekleyen satırlar takılırdı); isteğe bağlı
      // grubun tükenen varsayılanı (önseçili gelmiş Normal süt) bırakılır, grup boş gider
      setPicks(reconcilePicks(groupsRef.current, editingPicks(editing.options)));
      setNote(editing.note);
      setQty(editing.qty);
      setPriceText(editing.priceOverride != null ? String(editing.priceOverride / 100).replace('.', ',') : '');
      setPriceOpen(editing.priceOverride != null || product.price === 0);
    } else {
      setSize(product.priceL != null ? (initialSize === 'L' ? 'L' : 'M') : 'TEK');
      setPicks(defaultPicks(groupsRef.current));
      setNote('');
      setQty(1);
      setPriceText('');
      setPriceOpen(product.price === 0);
    }
  }, [product, editing, initialSize]);

  // Pencere açıkken ürünün bir grubu kapanır ya da açılırsa, seçenek tükenir ya da satışa açılırsa (Yönetim ›
  // Seçenekler, Tükenen ürünler; menü olayı) seçim, not ve adet korunarak uzlaştırılır: kapanan grubun seçimi atılır
  // (yoksa gönderim 400 alırdı), önseçili Normal süt tükenince bırakılır (Ekle açık kalır, süt yazılmaz), seçimi boşalan
  // isteğe bağlı grubun varsayılanı seçili gelir (ücretli varsayılan ekranda seçili görünmeden fiyata girmesin).
  // Yukarıdaki efektten sonra çalışır
  useEffect(() => {
    if (!product) return;
    setPicks((cur) => reconcilePicks(groups, cur));
  }, [product, groups]);

  if (!product) return null;
  const options = Object.entries(picks)
    .filter(([, n]) => n > 0)
    .map(([itemId, n]) => ({ itemId, qty: n }));
  const override = priceText.trim() ? parseTL(priceText) : null;
  const unit = override ?? estimateUnit(boot, product, size, options);
  // Zorunlu grup (şeker) seçilmeden Ekle kapalı: sunucu boş grupta varsayılanı yazardı, kasiyer sormadan geçmesin
  const missing = missingChoice(groups, picks);
  const hinted = groups.find((g) => pickHint(g, picks));
  const waiting = !!hinted;
  // Ekle neden kapalı: alt çubukta yazar (telefonda grup başlığındaki ipucu ekranın dışında kalabilir)
  const reason = missing ? `${missing.name} seçin` : hinted ? `${hinted.name}: ${pickHint(hinted, picks)}` : null;

  const setCount = (itemId: string, n: number) => setPicks({ ...picks, [itemId]: n });

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={product.name}
      subtitle={product.description ?? undefined}
      footer={
        // Eksik zorunlu seçimin ya da tükenen seçimin yazısı Ekle'nin altında kendi satırında (bilgi cümlesi devre dışı
        // düğmede durmaz)
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Stepper value={qty} onChange={setQty} min={1} max={99} label="Adet" />
          <div className="flex-1" />
          <Button variant="primary" size="lg" disabled={waiting || !!missing} aria-describedby={reason ? 'secenek-eksik' : undefined} onClick={() => onSubmit({ productId: product.id, size, qty, options, note: note.trim(), priceOverride: override })}>
            {editing ? 'Güncelle' : 'Ekle'} · {tl(unit * qty)}
          </Button>
          {/* Canlı bölge hep yerinde (boşken görünmez): tükenen seçim sonradan geldiğinde de okunur */}
          <p id="secenek-eksik" role="status" className={cn('basis-full text-right text-sm font-medium', !reason ? 'sr-only' : missing ? 'text-ink-2' : 'text-[var(--admin-danger-ink)]')}>
            {reason}
          </p>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        {/* Alerjen bilgisi gösterilmek zorunda ve personel okur: pencerenin ilk satırı, anahtar değil ad */}
        {product.allergens?.length ? (
          <p className="text-[13px] text-ink-2">
            <span className="font-medium text-ink">Alerjen:</span> {product.allergens.map(allergenLabel).join(', ')}
          </p>
        ) : null}
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

        {groups.map((g) => {
          // Çok seçimlik grubun sınırı (sunucu fazlasını "en çok N seçim" diye reddeder, ancak satır gidince): dolunca
          // seçilmemiş çipler kapanır, bir seçim bırakılınca yeniden açılır
          const full = g.kind === 'multi' && g.items.filter((i) => picks[i.id]).length >= g.maxSelect;
          return (
            <section key={g.id}>
              <h3 className="mb-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm font-semibold text-ink-2">
                {g.name}
                {g.required && g.kind !== 'counter' && <Badge>Zorunlu</Badge>}
                {g.kind === 'multi' && g.maxSelect < g.items.length && <span className="text-xs font-medium text-muted">en çok {g.maxSelect}</span>}
                {pickHint(g, picks) ? (
                  <span className="text-xs font-medium text-[var(--admin-danger-ink)]">{pickHint(g, picks)}</span>
                ) : (
                  // İsteğe bağlı grubun tükenen varsayılanı: yalnız bilgi, Ekle açık (sunucu o grup için seçenek yazmaz)
                  pickNote(g, picks) && <span className="text-xs font-medium text-muted">{pickNote(g, picks)}</span>
                )}
              </h3>
              {g.kind === 'counter' ? (
                <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                  {g.items.map((i) => {
                    // Tek kalemli sayaçta (Şeker, Ekstra shot) kalemin adı grubun başlığıyla aynı: yinelenmez, yalnız ek fiyat
                    const named = !(g.items.length === 1 && i.name === g.name);
                    return (
                      <div key={i.id} className="inline-flex items-center gap-3">
                        <Stepper value={picks[i.id] ?? 0} onChange={(n) => setCount(i.id, n)} min={0} max={i.maxQty} disabledUp={i.soldOut} label={i.name} />
                        {(named || i.soldOut || i.price > 0) && (
                          <span className={cn('text-[15px]', i.soldOut ? 'text-muted' : 'text-ink')}>
                            {named && <span className="font-medium">{i.name}</span>}
                            {i.soldOut ? (
                              <span className={cn(SOLD_BADGE, !named && 'ml-0')}>Tükendi</span>
                            ) : (
                              i.price > 0 && <span className={cn('tabular text-sm text-muted', named && 'ml-1')}>+{tlCompact(i.price)}</span>
                            )}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {g.items.map((i) => {
                    const on = !!picks[i.id];
                    // Seçiliyken tükenen (başka kasa işaretledi ya da sepetteki satır düzenleniyor) bırakılabilsin diye yalnız
                    // seçili değilken kapalı; seçiliyse gri zeminde mavi çerçeve
                    const sold = i.soldOut && !on;
                    return (
                      <button
                        key={i.id}
                        aria-pressed={on}
                        disabled={sold || (full && !on)}
                        onClick={() => (g.kind === 'single' ? setPicks(pickSingle(g, picks, i.id)) : setCount(i.id, on ? 0 : 1))}
                        className={cn(CHIP, i.soldOut ? cn(CHIP_SOLD, on && 'border-primary active:bg-press') : on ? CHIP_ON : CHIP_OFF, full && !on && !i.soldOut && 'cursor-not-allowed opacity-50')}
                      >
                        {i.name}
                        {i.soldOut ? (
                          <span className={SOLD_BADGE}>Tükendi</span>
                        ) : (
                          i.price > 0 && <span className={cn('tabular ml-1', on ? 'text-primary/80' : 'text-muted')}>+{tlCompact(i.price)}</span>
                        )}
                        {i.allergens.includes('nuts') && <span className="ml-1 text-[11px] text-[var(--admin-warning)]">(kuruyemiş)</span>}
                      </button>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

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
      </div>
    </Modal>
  );
}
