import { Plus, Save, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';
import { parseTL } from '@shared/money';
import { Button, IconButton } from '@/components/ui/Button';
import { Field, Input, Label, NumberInput, SearchInput, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { errorMessage, post, put } from '@/lib/api';
import { fold } from '@/lib/shell';
import { toast } from '@/lib/toast';

export type OptionKind = 'single' | 'multi' | 'counter';
type EditItem = { id?: string; name: string; price: string; isDefault: boolean; maxQty: number };

/** Düzenleyicinin taslağı: tutarlar yazıldığı gibi (virgüllü), kayıtta kuruşa çevrilir */
export interface OptionGroupDraft {
  id?: string;
  name: string;
  kind: OptionKind;
  required: boolean;
  maxSelect: number;
  sort: number;
  active: boolean;
  items: EditItem[];
  /** Bağlı ürünler; düzenleyiciye `products` verilmediyse gönderilmez, bağlar değişmez */
  productIds: string[];
}

export const newGroupDraft = (): OptionGroupDraft => ({ name: '', kind: 'single', required: false, maxSelect: 1, sort: 50, active: true, items: [{ name: '', price: '', isDefault: true, maxQty: 1 }], productIds: [] });

/** Var olan yerel grubun taslağı (yalnız etkin seçenekleri) */
export function groupDraft(
  g: { id: string; name: string; kind: OptionKind; required: boolean; maxSelect: number; sort: number; active: boolean },
  items: { id: string; name: string; price: number; isDefault: boolean; maxQty: number }[],
  productIds: string[],
): OptionGroupDraft {
  const { id, name, kind, required, maxSelect, sort, active } = g;
  return {
    id,
    name,
    kind,
    required,
    maxSelect,
    sort,
    active,
    items: items.map((i) => ({ id: i.id, name: i.name, price: i.price ? String(i.price / 100).replace('.', ',') : '', isDefault: i.isDefault, maxQty: i.maxQty })),
    productIds,
  };
}

/**
 * Seçenek grubu penceresi (Seçenekler sayfası ve ürün çekmecesindeki "Yeni grup"): ad, tür, seçenekler ve ek
 * fiyatları, grubun açık olup olmadığı ve `products` verildiyse bağlı ürünler. Kayıt tek istektir; grup, seçenekleri
 * ve ürün bağları sunucuda aynı işlemde yazılır, ek fiyat değişikliği denetim kaydına düşer.
 */
export function OptionGroupEditor({
  initial,
  onClose,
  onSaved,
  products,
  note,
  canClose = true,
}: {
  initial: OptionGroupDraft;
  onClose: () => void;
  onSaved: (saved: { id: string; name: string }) => void;
  /** Ürünler çoklu seçimi; kategori sırasıyla gelir */
  products?: { id: string; name: string; category?: string }[];
  /** Pencerenin altındaki açıklama */
  note?: ReactNode;
  /**
   * "Grup açık" anahtarı gösterilsin mi. Ürün çekmecesinden açılan yeni grup hep açıktır: kapalı kaydedilse ürüne
   * görünmeden bağlanır, çekmecede çipi çıkmaz, oradan çıkarılamazdı
   */
  canClose?: boolean;
}) {
  const [edit, setEdit] = useState(initial);
  const [saving, setSaving] = useState(false);
  // Eksik alan Kaydet'e basınca alanın altında söylenir (düğme sessizce soluk kalmaz)
  const [tried, setTried] = useState(false);
  const [q, setQ] = useState('');
  const errors = { name: edit.name.trim() ? null : 'Grup adı gerekli', items: edit.items.some((i) => i.name.trim()) ? null : 'En az bir seçenek yazın' };
  const shown = useMemo(() => {
    const k = fold(q.trim());
    return (products ?? []).filter((p) => !k || fold(`${p.name} ${p.category ?? ''}`).includes(k));
  }, [products, q]);
  const setItem = (i: number, patch: Partial<EditItem>) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
  const toggleProduct = (id: string) => setEdit({ ...edit, productIds: edit.productIds.includes(id) ? edit.productIds.filter((x) => x !== id) : [...edit.productIds, id] });

  const save = async () => {
    if (errors.name || errors.items) {
      setTried(true);
      return;
    }
    const name = edit.name.trim();
    // Adı boş kalan satır gönderilmez (sunucu boş adı reddeder)
    const body = {
      name,
      kind: edit.kind,
      required: edit.required,
      maxSelect: edit.maxSelect,
      sort: edit.sort,
      active: edit.active,
      items: edit.items.filter((i) => i.name.trim()).map((i, idx) => ({ id: i.id, name: i.name.trim(), price: parseTL(i.price || '0') ?? 0, isDefault: i.isDefault, maxQty: i.maxQty, sort: idx, active: true })),
      ...(products ? { productIds: edit.productIds } : {}),
    };
    setSaving(true);
    try {
      let id = edit.id;
      if (id) await put(`/admin/option-groups/${id}`, body);
      else id = (await post<{ id: string }>('/admin/option-groups', body)).id;
      onSaved({ id, name });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={edit.id ? 'Seçenek grubu' : 'Yeni seçenek grubu'}
      footer={
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
            Kaydet
          </Button>
        </div>
      }
    >
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Ad" required error={tried ? errors.name : null}>
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ör. bardak" maxLength={40} />
          </Field>
          <Field label="Tür">
            <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as OptionKind })}>
              <option value="single">Tek seçim</option>
              <option value="multi">Çoklu seçim</option>
              <option value="counter">Adetli (ör. ekstra şeker)</option>
            </Select>
          </Field>
          <Field label="Zorunlu">
            <Toggle checked={edit.required} onChange={(v) => setEdit({ ...edit, required: v })} label={edit.required ? 'Evet' : 'Hayır'} />
          </Field>
        </div>
        <div className="space-y-2">
          {/* Sütun adları: satırdaki alanlar yalnız yer tutucu taşımasın */}
          <div className="flex items-center gap-2 text-xs font-medium text-[var(--admin-text-mute)]" aria-hidden="true">
            <span className="min-w-0 flex-1">Seçenek</span>
            <span className="w-20 shrink-0 text-right">Ek fiyat (₺)</span>
            {edit.kind === 'single' && <span className="w-[4.5rem] shrink-0 text-center">Varsayılan</span>}
            {edit.kind === 'counter' && <span className="w-16 shrink-0 text-right">En çok</span>}
            <span className="w-11 shrink-0 pointer-fine:w-9" />
          </div>
          {edit.items.map((it, i) => (
            <div key={i} className="flex items-center gap-2">
              <Input value={it.name} onChange={(e) => setItem(i, { name: e.target.value })} placeholder="Ör. yulaf sütü" aria-label={`${i + 1}. seçenek adı`} maxLength={40} className="min-w-0 flex-1" />
              <Input value={it.price} onChange={(e) => setItem(i, { price: e.target.value })} placeholder="0" aria-label={`${i + 1}. seçenek ek fiyatı (₺)`} className="tabular w-20 shrink-0 text-right" inputMode="decimal" />
              {edit.kind === 'single' && (
                // Bütün hücre dokunma alanı (44 px); sütun adı üstte, ekran okuyucuya satırın kendi adı
                <label className="flex min-h-11 w-[4.5rem] shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-hover pointer-fine:min-h-9">
                  <input type="radio" name="varsayilan" checked={it.isDefault} onChange={() => setEdit({ ...edit, items: edit.items.map((x, j) => ({ ...x, isDefault: j === i })) })} className="size-4 accent-[var(--admin-primary)]" />
                  <span className="sr-only">{`${i + 1}. seçenek varsayılan`}</span>
                </label>
              )}
              {edit.kind === 'counter' && <NumberInput value={it.maxQty} min={1} max={9} fallback={1} aria-label={`${i + 1}. seçenekten en çok adet`} onCommit={(maxQty) => setItem(i, { maxQty })} className="w-16 shrink-0" />}
              <IconButton label={`${i + 1}. seçeneği sil`} className="text-[var(--admin-text-mute)] hover:text-[var(--admin-danger-ink)]" onClick={() => setEdit({ ...edit, items: edit.items.filter((_, j) => j !== i) })}>
                <Trash2 className="size-4" />
              </IconButton>
            </div>
          ))}
          {tried && errors.items && (
            <p role="alert" className="text-[13px] text-[var(--admin-danger-ink)]">
              {errors.items}
            </p>
          )}
          <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit({ ...edit, items: [...edit.items, { name: '', price: '', isDefault: false, maxQty: 1 }] })}>
            Seçenek ekle
          </Button>
        </div>
        {products && (
          <div role="group" aria-label="Ürünler">
            <Label hint={edit.productIds.length ? `${edit.productIds.length} ürün seçili` : 'kasada bu ürünlerde sorulur'}>Ürünler</Label>
            <SearchInput dense value={q} onChange={setQ} label="Ürün ara" placeholder="Ürün ya da kategori ara" wrapperClassName="mb-2" />
            <ul className="scroll-thin max-h-[min(16rem,40dvh)] divide-y divide-[var(--admin-divider)] overflow-y-auto overscroll-contain rounded-xl border border-[var(--admin-border)]">
              {shown.map((p) => (
                <li key={p.id}>
                  <label className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-hover">
                    <input type="checkbox" checked={edit.productIds.includes(p.id)} onChange={() => toggleProduct(p.id)} className="size-4 shrink-0 accent-[var(--admin-primary)]" />
                    <span className="min-w-0 flex-1 truncate text-[var(--admin-text)]">{p.name}</span>
                    {p.category && <span className="max-w-[45%] shrink-0 truncate text-xs text-[var(--admin-text-mute)]">{p.category}</span>}
                  </label>
                </li>
              ))}
              {!shown.length && <li className="px-3 py-3 text-sm text-[var(--admin-text-mute)]">{q.trim() ? `“${q.trim()}” ile eşleşen ürün yok` : 'Menüde ürün yok'}</li>}
            </ul>
          </div>
        )}
        {canClose && <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Grup açık" hint="Kapalı grup kasada sorulmaz; ürün bağları durur" />}
        {note && <p className="text-xs text-[var(--admin-text-mute)]">{note}</p>}
      </div>
    </Modal>
  );
}
