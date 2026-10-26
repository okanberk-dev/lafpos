import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, RefreshCw, Search, Star } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { ProductDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, PageHeader, PageLoading } from '@/components/ui/misc';
import { del, errorMessage, get, patch, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

interface AdminMenu {
  categories: { id: string; name: string; color: string; stationId: string | null; sort: number; active: boolean; extSource: string | null; customizable: boolean }[];
  products: ProductDTO[];
  optionGroups: { id: string; name: string; kind: string; extSource: string | null; active: boolean }[];
}
interface Preview {
  status: 'degismedi' | 'onizleme' | 'uygulandi';
  preview?: { changes: { kind: string; productId: string | null; extId: string; name: string; detail: string }[]; newCategories: string[]; itemCount: number; siteUpdatedAt: string | null };
  result?: { created: number; updated: number; deactivated: number };
}

const CHANGE_LABEL: Record<string, string> = { yeni: 'Yeni', fiyat: 'Fiyat', ad: 'Ad', kdv: 'KDV', boy: 'Boy', kalkti: 'Satışta değil', geri: 'Yeniden satışta', diger: 'Diğer' };

export default function MenuAdmin() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => get<AdminMenu>('/admin/menu') });
  const [catId, setCatId] = useState<string>('');
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<ProductDTO | null>(null);
  const [creating, setCreating] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'menu'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const products = useMemo(() => {
    const all = data.data?.products ?? [];
    const k = q.trim().toLocaleLowerCase('tr-TR');
    return all.filter((p) => (k ? p.name.toLocaleLowerCase('tr-TR').includes(k) : !catId || p.categoryId === catId));
  }, [data.data, q, catId]);

  const availability = async (p: ProductDTO, active: boolean) => {
    try {
      const r = await post<{ site: string }>(`/sync/products/${p.id}/availability`, { active });
      toast.ok(`${p.name} ${active ? 'satışa açıldı' : 'tükendi'}${r.site === 'guncellendi' ? '; site ve uygulama da güncellendi' : r.site === 'anahtar_yok' ? '; site anahtarı yok, yalnız LafPOS' : ''}`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const quick = async (p: ProductDTO, body: Record<string, unknown>) => {
    try {
      await patch(`/admin/products/${p.id}`, body);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const syncPreview = async () => {
    setSyncing(true);
    try {
      setPreview(await post<Preview>('/sync/menu/preview'));
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };
  const syncApply = async () => {
    setSyncing(true);
    try {
      const r = await post<Preview>('/sync/menu/apply');
      toast.ok(r.status === 'degismedi' ? 'Site menüsü değişmemiş' : `Menü eşitlendi: ${r.result?.created ?? 0} yeni, ${r.result?.updated ?? 0} güncel`);
      setPreview(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

  if (data.isLoading) return <PageLoading />;
  const cats = data.data?.categories ?? [];

  return (
    <div>
      <PageHeader
        title="Menü"
        subtitle="Siteden gelen ürünlerin fiyatı, adı ve KDV'si sitede değişir; burada kasa alanları (istasyon, kısa ad, renk, sık kullanılan, porsiyon) düzenlenir"
        actions={
          <>
            <Button icon={<RefreshCw className={cn('size-4', syncing && 'animate-spin')} />} onClick={syncPreview} disabled={syncing}>
              Siteyle eşitle
            </Button>
            <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              Yerel ürün
            </Button>
          </>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara" className="w-56 pl-9" />
        </div>
        <div className="no-scrollbar flex gap-1 overflow-x-auto">
          <button onClick={() => setCatId('')} className={cn('shrink-0 rounded-lg px-3 py-1.5 text-sm', !catId ? 'bg-forest-700 text-cream' : 'bg-surface-2')}>
            Tümü
          </button>
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCatId(c.id)} className={cn('shrink-0 rounded-lg px-3 py-1.5 text-sm', catId === c.id ? 'bg-forest-700 text-cream' : 'bg-surface-2', !c.active && 'opacity-50')}>
              {c.name}
            </button>
          ))}
        </div>
      </div>
      {catId && (
        <CategoryBar
          cat={cats.find((c) => c.id === catId)!}
          onChange={async (body) => {
            try {
              await patch(`/admin/categories/${catId}`, body);
              refresh();
            } catch (e) {
              toast.err(errorMessage(e));
            }
          }}
        />
      )}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2">Ürün</th>
                <th className="px-2 py-2">Fiyat</th>
                <th className="px-2 py-2">KDV</th>
                <th className="px-2 py-2">Satışta</th>
                <th className="px-2 py-2">İstasyon</th>
                <th className="px-2 py-2 text-center">Sık</th>
                <th className="px-2 py-2 text-center">POS'ta gizle</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id} className={cn('border-b border-line/60 last:border-0', p.hidden && 'opacity-60')}>
                  <td className="px-4 py-2">
                    <div className="flex items-center gap-2 font-medium">
                      {p.name}
                      {p.extSource ? (
                        <Badge tone="green">
                          <Globe className="size-3" /> Site
                        </Badge>
                      ) : (
                        <Badge>Yerel</Badge>
                      )}
                      {p.isService && <Badge tone="pink">Hizmet</Badge>}
                    </div>
                    <div className="text-xs text-muted">
                      {[p.shortName && `Kısa: ${p.shortName}`, p.posName && `lafmaliyet: ${p.posName}`, p.portionsLeft != null && `Porsiyon: ${p.portionsLeft}`].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td className="tabular px-2 py-2">
                    {tl(p.price)}
                    {p.priceL != null && <span className="text-muted"> / {tl(p.priceL)}</span>}
                    {can('rapor.maliyet') && p.cost != null && <div className="text-xs text-muted">maliyet {tl(p.cost)}</div>}
                  </td>
                  <td className="px-2 py-2">%{p.kdvRate}</td>
                  <td className="px-2 py-2">
                    <Toggle checked={p.active} onChange={(v) => availability(p, v)} />
                  </td>
                  <td className="px-2 py-2">
                    <select value={p.stationId ?? ''} onChange={(e) => quick(p, { stationId: e.target.value || null })} className="h-9 rounded-lg border border-line bg-surface px-2 text-sm">
                      <option value="">Kategoriden</option>
                      {boot.stations.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <button aria-label="Sık kullanılan" onClick={() => quick(p, { favorite: !p.favorite })}>
                      <Star className={cn('size-5', p.favorite ? 'fill-brass-400 text-brass-500' : 'text-line-strong')} />
                    </button>
                  </td>
                  <td className="px-2 py-2 text-center">
                    <input type="checkbox" checked={p.hidden} onChange={(e) => quick(p, { hidden: e.target.checked })} className="size-4" />
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEdit(p)}>
                      Düzenle
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      {edit && <ProductModal product={edit} groups={data.data?.optionGroups ?? []} cats={cats} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); refresh(); }} />}
      {creating && <ProductModal product={null} groups={data.data?.optionGroups ?? []} cats={cats} onClose={() => setCreating(false)} onSaved={() => { setCreating(false); refresh(); }} />}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        size="lg"
        title="Site menüsü"
        subtitle={preview?.status === 'degismedi' ? 'Son eşitlemeden beri sitede değişiklik yok' : `${preview?.preview?.itemCount ?? 0} ürün · ${preview?.preview?.changes.length ?? 0} değişiklik`}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setPreview(null)}>Kapat</Button>
            {preview?.status === 'onizleme' && (
              <Button variant="primary" loading={syncing} onClick={syncApply}>
                Değişiklikleri uygula
              </Button>
            )}
          </div>
        }
      >
        <div className="p-4">
          {preview?.preview?.newCategories.length ? <p className="mb-2 text-sm">Yeni kategoriler: {preview.preview.newCategories.join(', ')}</p> : null}
          {preview?.preview?.changes.length ? (
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {preview.preview.changes.map((ch) => (
                <li key={`${ch.extId}-${ch.kind}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Badge tone={ch.kind === 'yeni' || ch.kind === 'geri' ? 'green' : ch.kind === 'kalkti' ? 'red' : 'brass'}>{CHANGE_LABEL[ch.kind] ?? ch.kind}</Badge>
                  <span className="flex-1 font-medium">{ch.name}</span>
                  <span className="tabular text-muted">{ch.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">LafPOS menüsü sitedekiyle aynı</p>
          )}
        </div>
      </Modal>
    </div>
  );
}

function CategoryBar({ cat, onChange }: { cat: AdminMenu['categories'][number]; onChange: (b: Record<string, unknown>) => void }) {
  const boot = useBoot();
  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-2.5 text-sm">
      <span className="font-semibold">{cat.name}</span>
      {cat.extSource && <Badge tone="green">Site kategorisi</Badge>}
      <label className="flex items-center gap-2">
        Renk <input type="color" value={cat.color} onChange={(e) => onChange({ color: e.target.value })} className="h-8 w-10 rounded" />
      </label>
      <label className="flex items-center gap-2">
        İstasyon
        <select value={cat.stationId ?? ''} onChange={(e) => onChange({ stationId: e.target.value || null })} className="h-8 rounded-lg border border-line bg-surface px-2">
          <option value="">Yok (bara/mutfağa gitmez)</option>
          {boot.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
      </label>
      <Toggle checked={cat.active} onChange={(v) => onChange({ active: v })} label="POS'ta göster" />
    </div>
  );
}

function ProductModal({
  product,
  cats,
  groups,
  onClose,
  onSaved,
}: {
  product: ProductDTO | null;
  cats: AdminMenu['categories'];
  groups: AdminMenu['optionGroups'];
  onClose: () => void;
  onSaved: () => void;
}) {
  const synced = !!product?.extSource;
  const [f, setF] = useState({
    categoryId: product?.categoryId ?? cats.find((c) => !c.extSource)?.id ?? cats[0]?.id ?? '',
    name: product?.name ?? '',
    price: product ? String(product.price / 100).replace('.', ',') : '',
    priceL: product?.priceL != null ? String(product.priceL / 100).replace('.', ',') : '',
    kdvRate: product?.kdvRate ?? 10,
    isService: product?.isService ?? false,
    shortName: product?.shortName ?? '',
    posName: product?.posName ?? '',
    barcode: product?.barcode ?? '',
    portionsLeft: product?.portionsLeft != null ? String(product.portionsLeft) : '',
    color: product?.color ?? '',
    groupIds: product?.optionGroupIds ?? [],
  });
  const save = async () => {
    try {
      const pos = {
        shortName: f.shortName || null,
        posName: f.posName || null,
        barcode: f.barcode || null,
        portionsLeft: f.portionsLeft === '' ? null : Number(f.portionsLeft),
        color: f.color || null,
      };
      let id = product?.id;
      if (!product) {
        const r = await post<{ id: string }>('/admin/products', { categoryId: f.categoryId, name: f.name, price: parseTL(f.price) ?? 0, priceL: f.priceL ? parseTL(f.priceL) : null, kdvRate: f.kdvRate, isService: f.isService, ...pos });
        id = r.id;
      } else if (synced) {
        await patch(`/admin/products/${product.id}`, pos);
      } else {
        await patch(`/admin/products/${product.id}`, { categoryId: f.categoryId, name: f.name, price: parseTL(f.price) ?? 0, priceL: f.priceL ? parseTL(f.priceL) : null, kdvRate: f.kdvRate, isService: f.isService, ...pos });
      }
      await put(`/admin/products/${id}/groups`, { groupIds: f.groupIds });
      toast.ok('Ürün kaydedildi');
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const remove = async () => {
    if (!product || !window.confirm(`${product.name} kaldırılsın mı? Satıldıysa gizlenir, satılmadıysa silinir`)) return;
    try {
      await del(`/admin/products/${product.id}`);
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      title={product ? product.name : 'Yerel ürün'}
      subtitle={synced ? 'Siteden geliyor: ad, fiyat, boy ve KDV laffogato yönetim panelinde değişir' : 'Yalnız LafPOS\'ta satılan ürün (ör. karaoke, etkinlik ücreti)'}
      footer={
        <div className="flex items-center gap-2">
          {product && !synced && (
            <Button variant="ghost" className="text-burgundy-500" onClick={remove}>
              Kaldır
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" onClick={save} disabled={!f.name.trim() || (!synced && !parseTL(f.price || '0'))}>
            Kaydet
          </Button>
        </div>
      }
    >
      <div className="grid gap-3 p-5 sm:grid-cols-2">
        <Field label="Ad">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={synced} />
        </Field>
        <Field label="Kategori">
          <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })} disabled={synced}>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Fiyat (M ya da tek boy, ₺)">
          <Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" disabled={synced} />
        </Field>
        <Field label="L fiyatı (₺)" hint="boş = tek boy">
          <Input value={f.priceL} onChange={(e) => setF({ ...f, priceL: e.target.value })} inputMode="decimal" disabled={synced} />
        </Field>
        <Field label="KDV">
          <Select value={f.kdvRate} onChange={(e) => setF({ ...f, kdvRate: Number(e.target.value) })} disabled={synced}>
            {[0, 1, 10, 20].map((r) => (
              <option key={r} value={r}>
                %{r}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Hizmet" hint="karaoke gibi; lafmaliyet'te HİZMET">
          <Toggle checked={f.isService} onChange={(v) => setF({ ...f, isService: v })} disabled={synced} label={f.isService ? 'Evet' : 'Hayır'} />
        </Field>
        <Field label="Kısa ad" hint="düğme ve fişte">
          <Input value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} />
        </Field>
        <Field label="lafmaliyet adı" hint="boşsa AD BOY">
          <Input value={f.posName} onChange={(e) => setF({ ...f, posName: e.target.value })} placeholder="ör. LATTE MEDIUM" />
        </Field>
        <Field label="Barkod">
          <Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
        </Field>
        <Field label="Günlük porsiyon" hint="boş = takip yok; 0'da tükenir">
          <Input value={f.portionsLeft} onChange={(e) => setF({ ...f, portionsLeft: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-sm font-medium text-ink-2">Seçenek grupları</div>
          <div className="flex flex-wrap gap-1.5">
            {groups
              .filter((g) => g.active)
              .map((g) => {
                const on = f.groupIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    onClick={() => setF({ ...f, groupIds: on ? f.groupIds.filter((x) => x !== g.id) : [...f.groupIds, g.id] })}
                    className={cn('rounded-full border px-3 py-1.5 text-sm', on ? 'border-forest-600 bg-forest-600 text-white' : 'border-line')}
                  >
                    {g.name}
                    {g.extSource && <span className="ml-1 text-xs opacity-70">site</span>}
                  </button>
                );
              })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
