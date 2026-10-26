import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, Eye, EyeOff, Globe, Pencil, Plus, RefreshCw, Star, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { parseTL, tl } from '@shared/money';
import type { ProductDTO } from '@shared/types';
import { ActionMenu, ActionRow, ActionRows, Badge, BTN, Card, type Column, DataTable, EmptyState, PageHeader, QuickLook, SearchField, StatusTabs } from '@/components/admin/ui';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { PageLoading } from '@/components/ui/misc';
import { del, errorMessage, get, patch, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { fold } from '@/lib/shell';
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
type Category = AdminMenu['categories'][number];
type Tab = 'tumu' | 'satista' | 'tukendi' | 'gizli' | 'site' | 'yerel';

const CHANGE_LABEL: Record<string, string> = { yeni: 'Yeni', fiyat: 'Fiyat', ad: 'Ad', kdv: 'KDV', boy: 'Boy', kalkti: 'Satışta değil', geri: 'Yeniden satışta', diger: 'Diğer' };

const status = (p: ProductDTO) => (p.hidden ? { tone: 'neutral' as const, label: 'POS’ta gizli' } : p.active ? { tone: 'success' as const, label: 'Satışta' } : { tone: 'danger' as const, label: 'Tükendi' });

/** Ürünün kategori renginde baş harfleri (Innex tablosundaki avatar yerine) */
function ProductMark({ name, color }: { name: string; color: string }) {
  return (
    <span aria-hidden="true" className="grid size-9 shrink-0 place-items-center rounded-lg text-xs font-semibold text-white" style={{ background: color || '#616367' }}>
      {name
        .split(/\s+/)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toLocaleUpperCase('tr-TR')}
    </span>
  );
}

/**
 * Ürünler (Innex): durum sekmeleri sayılı, tek satır araç çubuğu, kart içinde tablo, satıra tıklayınca sağdan
 * hızlı bakış ve düzenleme (Innex §3 fikir 8). Siteden gelen ürünün adı, fiyatı, boyu ve KDV'si sitede değişir;
 * burada kasa alanları düzenlenir. Adres ?urun=<id> ile açılır, geri tuşu çekmeceyi kapatır.
 */
export default function MenuAdmin() {
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const data = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => get<AdminMenu>('/admin/menu') });
  const [tab, setTab] = useState<Tab>('tumu');
  const [catId, setCatId] = useState('');
  const [q, setQ] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [syncing, setSyncing] = useState(false);
  const openId = params.get('urun');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'menu'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('urun', id);
    else next.delete('urun');
    setParams(next, { replace: !id && !!openId });
  };

  const all = useMemo(() => data.data?.products ?? [], [data.data]);
  const cats = data.data?.categories ?? [];
  const catOf = (p: ProductDTO) => cats.find((c) => c.id === p.categoryId);
  const counts: Record<Tab, number> = {
    tumu: all.length,
    satista: all.filter((p) => p.active && !p.hidden).length,
    tukendi: all.filter((p) => !p.active && !p.hidden).length,
    gizli: all.filter((p) => p.hidden).length,
    site: all.filter((p) => p.extSource).length,
    yerel: all.filter((p) => !p.extSource).length,
  };
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter((p) => {
      if (k && !fold(`${p.name} ${p.shortName ?? ''} ${p.posName ?? ''}`).includes(k)) return false;
      if (catId && p.categoryId !== catId) return false;
      if (tab === 'satista') return p.active && !p.hidden;
      if (tab === 'tukendi') return !p.active && !p.hidden;
      if (tab === 'gizli') return p.hidden;
      if (tab === 'site') return !!p.extSource;
      if (tab === 'yerel') return !p.extSource;
      return true;
    });
  }, [all, q, catId, tab]);

  const availability = async (p: ProductDTO, active: boolean) => {
    try {
      const r = await post<{ site: string }>(`/sync/products/${p.id}/availability`, { active });
      toast.ok(`${p.name} ${active ? 'satışa açıldı' : 'tükendi'}${r.site === 'guncellendi' ? '; site ve uygulama da güncellendi' : r.site === 'anahtar_yok' ? '; site anahtarı yok, yalnız LafPOS' : ''}`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const quick = async (p: ProductDTO, body: Record<string, unknown>, done?: string) => {
    try {
      await patch(`/admin/products/${p.id}`, body);
      if (done) toast.ok(done);
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
  const selected = openId && openId !== 'yeni' ? all.find((p) => p.id === openId) ?? null : null;
  const cat = cats.find((c) => c.id === catId);

  const columns: Column<ProductDTO>[] = [
    {
      key: 'urun',
      header: 'Ürün',
      cell: (p) => (
        <span className="flex items-center gap-3">
          <ProductMark name={p.name} color={catOf(p)?.color ?? ''} />
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 font-medium text-[var(--admin-text)]">
              <span className="truncate">{p.name}</span>
              {p.favorite && <Star aria-label="Sık kullanılan" className="size-3.5 shrink-0 fill-[var(--admin-warning)] text-[var(--admin-warning)]" />}
            </span>
            <span className="block truncate text-xs text-[var(--admin-text-mute)]">
              {[p.extSource ? 'Siteden' : 'Yerel', p.shortName && `kısa: ${p.shortName}`, p.posName && `lafmaliyet: ${p.posName}`].filter(Boolean).join(' · ')}
            </span>
          </span>
        </span>
      ),
    },
    { key: 'kategori', header: 'Kategori', cell: (p) => <span className="whitespace-nowrap text-[var(--admin-text-soft)]">{catOf(p)?.name ?? '-'}</span>, hideOnPhone: true, hideBelow: 'xl' },
    {
      key: 'fiyat',
      header: 'Fiyat',
      align: 'right',
      cell: (p) => (
        <span className="whitespace-nowrap tabular-nums">
          {tl(p.price)}
          {p.priceL != null && <span className="text-[var(--admin-text-mute)]"> / {tl(p.priceL)}</span>}
          {can('rapor.maliyet') && p.cost != null && <span className="block text-xs text-[var(--admin-text-mute)]">maliyet {tl(p.cost)}</span>}
        </span>
      ),
    },
    { key: 'kdv', header: 'KDV', align: 'right', cell: (p) => <span className="tabular-nums">%{p.kdvRate}</span>, hideOnPhone: true, hideBelow: 'lg' },
    { key: 'porsiyon', header: 'Porsiyon', align: 'right', cell: (p) => <span className="tabular-nums">{p.portionsLeft ?? '-'}</span>, hideOnPhone: true, hideBelow: 'lg' },
    { key: 'durum', header: 'Durum', cell: (p) => <Badge tone={status(p).tone}>{status(p).label}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Ürünler"
        description="Siteden gelen ürünün adı, fiyatı, boyu ve KDV'si laffogato panelinde değişir; burada satış durumu, istasyon, kısa ad, porsiyon ve seçenek grupları düzenlenir"
        actions={
          <>
            <button type="button" className={BTN.ghost} onClick={syncPreview} disabled={syncing}>
              <RefreshCw className={cn('size-4', syncing && 'animate-spin')} aria-hidden="true" />
              Siteyle eşitle
            </button>
            <button type="button" className={BTN.primary} onClick={() => open('yeni')}>
              <Plus className="size-4" aria-hidden="true" />
              Yerel ürün
            </button>
          </>
        }
      />

      <StatusTabs
        label="Ürün durumu"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'tumu', label: 'Tümü', count: counts.tumu },
          { value: 'satista', label: 'Satışta', count: counts.satista },
          { value: 'tukendi', label: 'Tükendi', count: counts.tukendi },
          { value: 'gizli', label: 'POS’ta gizli', count: counts.gizli },
          { value: 'site', label: 'Siteden', count: counts.site },
          { value: 'yerel', label: 'Yerel', count: counts.yerel },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Ürün, kısa ad ya da lafmaliyet adı" label="Ürün ara" />
        <label className="min-w-0 flex-1 sm:w-56 sm:flex-none">
          <span className="sr-only">Kategori</span>
          <Select value={catId} onChange={(e) => setCatId(e.target.value)} className="text-sm pointer-fine:h-9">
            <option value="">Bütün kategoriler</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (gizli)'}
              </option>
            ))}
          </Select>
        </label>
        <span className="ml-auto text-xs text-[var(--admin-text-mute)] tabular-nums">{rows.length} ürün</span>
      </div>

      {cat && <CategoryBar cat={cat} onChange={(body) => patch(`/admin/categories/${cat.id}`, body).then(refresh, (e) => toast.err(errorMessage(e)))} />}

      <DataTable
        caption="Ürünler"
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        onOpen={(p) => open(p.id)}
        selectedKey={openId}
        rowClassName={(p) => p.hidden && 'opacity-70'}
        phoneTitle={(p) => columns[0].cell(p)}
        phoneMeta={(p) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={status(p).tone}>{status(p).label}</Badge>
            <span className="tabular-nums text-[var(--admin-text-soft)]">
              {tl(p.price)}
              {p.priceL != null && ` / ${tl(p.priceL)}`}
            </span>
          </span>
        )}
        actions={(p) => (
          <ActionMenu
            label={`${p.name} eylemleri`}
            items={[
              { key: 'ac', label: 'Hızlı bakış ve düzenle', icon: <Pencil />, onSelect: () => open(p.id) },
              p.active
                ? { key: 'tukendi', label: 'Tükendi işaretle', icon: <Ban />, onSelect: () => availability(p, false) }
                : { key: 'satis', label: 'Satışa aç', icon: <CircleCheck />, onSelect: () => availability(p, true) },
              { key: 'sik', label: p.favorite ? 'Sık kullanılandan çıkar' : 'Sık kullanılana ekle', icon: <Star />, onSelect: () => quick(p, { favorite: !p.favorite }) },
              { key: 'gizle', label: p.hidden ? 'POS’ta göster' : 'POS’ta gizle', icon: p.hidden ? <Eye /> : <EyeOff />, onSelect: () => quick(p, { hidden: !p.hidden }) },
            ]}
          />
        )}
        empty={
          <EmptyState title="Bu süzgeçle ürün yok" action={<button type="button" className={BTN.ghost} onClick={() => (setQ(''), setCatId(''), setTab('tumu'))}>Süzgeci temizle</button>}>
            Arama ya da kategori seçimini değiştirin
          </EmptyState>
        }
      />

      {(selected || openId === 'yeni') && (
        <ProductDrawer
          key={openId}
          product={selected}
          cats={cats}
          groups={data.data?.optionGroups ?? []}
          onClose={() => open(null)}
          onSaved={() => {
            refresh();
            open(null);
          }}
          onAvailability={availability}
          onQuick={quick}
        />
      )}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        size="lg"
        title="Site menüsü"
        subtitle={preview?.status === 'degismedi' ? 'Son eşitlemeden beri sitede değişiklik yok' : `${preview?.preview?.itemCount ?? 0} ürün · ${preview?.preview?.changes.length ?? 0} değişiklik`}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN.ghost} onClick={() => setPreview(null)}>
              Kapat
            </button>
            {preview?.status === 'onizleme' && (
              <button type="button" className={BTN.primary} disabled={syncing} onClick={syncApply}>
                Değişiklikleri uygula
              </button>
            )}
          </div>
        }
      >
        <div className="p-4">
          {preview?.preview?.newCategories.length ? <p className="mb-2 text-sm">Yeni kategoriler: {preview.preview.newCategories.join(', ')}</p> : null}
          {preview?.preview?.changes.length ? (
            <ul className="divide-y divide-[var(--admin-divider)] rounded-xl border border-[var(--admin-border)]">
              {preview.preview.changes.map((ch) => (
                <li key={`${ch.extId}-${ch.kind}`} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <Badge tone={ch.kind === 'yeni' || ch.kind === 'geri' ? 'success' : ch.kind === 'kalkti' ? 'danger' : 'warning'}>{CHANGE_LABEL[ch.kind] ?? ch.kind}</Badge>
                  <span className="flex-1 font-medium">{ch.name}</span>
                  <span className="tabular-nums text-[var(--admin-text-mute)]">{ch.detail}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--admin-text-mute)]">LafPOS menüsü sitedekiyle aynı</p>
          )}
        </div>
      </Modal>
    </>
  );
}

function CategoryBar({ cat, onChange }: { cat: Category; onChange: (b: Record<string, unknown>) => void }) {
  const boot = useBoot();
  return (
    <Card className="mb-3" bodyClassName="flex flex-wrap items-center gap-x-5 gap-y-3 py-3 sm:py-3">
      <span className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden="true" className="size-3 rounded-full" style={{ background: cat.color }} />
        {cat.name}
        {cat.extSource && <Badge tone="info">Site kategorisi</Badge>}
      </span>
      <label className="flex min-h-11 items-center gap-2 text-sm text-[var(--admin-text-soft)]">
        Renk
        <input type="color" value={cat.color} onChange={(e) => onChange({ color: e.target.value })} className="h-9 w-11 cursor-pointer rounded-md border border-[var(--admin-border)]" />
      </label>
      <label className="flex items-center gap-2 text-sm text-[var(--admin-text-soft)]">
        İstasyon
        <Select value={cat.stationId ?? ''} onChange={(e) => onChange({ stationId: e.target.value || null })} className="w-auto text-sm pointer-fine:h-9">
          <option value="">Yok (bara ya da mutfağa gitmez)</option>
          {boot.stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
      </label>
      <Toggle checked={cat.active} onChange={(v) => onChange({ active: v })} label="POS’ta göster" />
    </Card>
  );
}

/** Hızlı bakış çekmecesi: üstte satış durumu ve fiyat, ortada işlem satırları, altta kasa alanları formu */
function ProductDrawer({
  product,
  cats,
  groups,
  onClose,
  onSaved,
  onAvailability,
  onQuick,
}: {
  product: ProductDTO | null;
  cats: Category[];
  groups: AdminMenu['optionGroups'];
  onClose: () => void;
  onSaved: () => void;
  onAvailability: (p: ProductDTO, active: boolean) => Promise<void>;
  onQuick: (p: ProductDTO, body: Record<string, unknown>, done?: string) => Promise<void>;
}) {
  const boot = useBoot();
  const can = useCan();
  const synced = !!product?.extSource;
  const [saving, setSaving] = useState(false);
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
    stationId: product?.stationId ?? '',
    color: product?.color ?? '',
    groupIds: product?.optionGroupIds ?? [],
  });
  const valid = !!f.name.trim() && (synced || !!parseTL(f.price || '0'));

  const save = async () => {
    setSaving(true);
    try {
      const pos = {
        shortName: f.shortName || null,
        posName: f.posName || null,
        barcode: f.barcode || null,
        portionsLeft: f.portionsLeft === '' ? null : Number(f.portionsLeft),
        stationId: f.stationId || null,
        color: f.color || null,
      };
      const own = { categoryId: f.categoryId, name: f.name, price: parseTL(f.price) ?? 0, priceL: f.priceL ? parseTL(f.priceL) : null, kdvRate: f.kdvRate, isService: f.isService };
      let id = product?.id;
      if (!product) id = (await post<{ id: string }>('/admin/products', { ...own, ...pos })).id;
      else await patch(`/admin/products/${product.id}`, synced ? pos : { ...own, ...pos });
      await put(`/admin/products/${id}/groups`, { groupIds: f.groupIds });
      toast.ok(product ? `${f.name} kaydedildi` : `${f.name} eklendi`);
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!product || !window.confirm(`${product.name} kaldırılsın mı? Satıldıysa gizlenir, satılmadıysa silinir`)) return;
    try {
      await del(`/admin/products/${product.id}`);
      toast.ok(`${product.name} kaldırıldı`);
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const cat = cats.find((c) => c.id === (product?.categoryId ?? f.categoryId));
  const st = product ? status(product) : null;

  return (
    <QuickLook
      open
      onClose={onClose}
      label={product ? `${product.name} ayrıntısı` : 'Yeni yerel ürün'}
      title={product ? product.name : 'Yeni yerel ürün'}
      subtitle={product ? `${synced ? 'Siteden' : 'Yerel'} · ${cat?.name ?? ''}` : 'Yalnız LafPOS’ta satılan ürün (karaoke, etkinlik ücreti gibi)'}
      footer={
        <>
          {product && !synced && (
            <button type="button" className={BTN.danger} onClick={remove}>
              <Trash2 className="size-4" aria-hidden="true" />
              Kaldır
            </button>
          )}
          <div className="flex-1" />
          <button type="button" className={BTN.ghost} onClick={onClose}>
            Vazgeç
          </button>
          <button type="button" className={BTN.primary} onClick={save} disabled={!valid || saving}>
            Kaydet
          </button>
        </>
      }
    >
      {product && st && (
        <div className="mb-5 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl border border-[var(--admin-border)] p-3">
              <div className="text-xs text-[var(--admin-text-mute)]">Satış durumu</div>
              <div className="mt-1">
                <Badge tone={st.tone} dot>
                  {st.label}
                </Badge>
              </div>
            </div>
            <div className="rounded-xl border border-[var(--admin-border)] p-3">
              <div className="text-xs text-[var(--admin-text-mute)]">Fiyat {product.priceL != null ? '(M / L)' : ''}</div>
              <div className="mt-1 text-lg font-bold tabular-nums">
                {tl(product.price)}
                {product.priceL != null && <span className="text-sm font-medium text-[var(--admin-text-mute)]"> / {tl(product.priceL)}</span>}
              </div>
              {can('rapor.maliyet') && product.cost != null && (
                <div className="text-xs text-[var(--admin-text-mute)]">
                  maliyet {tl(product.cost)} · marj %{Math.round(((product.price - product.cost) / product.price) * 100)}
                </div>
              )}
            </div>
          </div>
          <ActionRows>
            {product.active ? (
              <ActionRow icon={<Ban />} hue="rose" label="Tükendi işaretle" value={synced ? 'site de güncellenir' : undefined} onClick={() => onAvailability(product, false)} />
            ) : (
              <ActionRow icon={<CircleCheck />} hue="green" label="Satışa aç" value={synced ? 'site de güncellenir' : undefined} onClick={() => onAvailability(product, true)} />
            )}
            <ActionRow icon={<Star />} hue="amber" label={product.favorite ? 'Sık kullanılandan çıkar' : 'Sık kullanılana ekle'} onClick={() => onQuick(product, { favorite: !product.favorite }, product.favorite ? 'Sık kullanılandan çıktı' : 'Sık kullanılana eklendi')} />
            <ActionRow icon={product.hidden ? <Eye /> : <EyeOff />} hue="violet" label={product.hidden ? 'POS’ta göster' : 'POS’ta gizle'} value={product.hidden ? 'şu an gizli' : undefined} onClick={() => onQuick(product, { hidden: !product.hidden })} />
            {synced && <ActionRow icon={<Globe />} hue="blue" label="Ad, fiyat ve KDV" value="laffogato panelinde" />}
          </ActionRows>
        </div>
      )}

      <div className="space-y-3">
        <h3 className="text-sm font-semibold">{product ? 'Kasa alanları' : 'Ürün bilgisi'}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Ad" className="sm:col-span-2">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={synced} autoFocus={!product} />
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
          <Field label="KDV">
            <Select value={f.kdvRate} onChange={(e) => setF({ ...f, kdvRate: Number(e.target.value) })} disabled={synced}>
              {[0, 1, 10, 20].map((r) => (
                <option key={r} value={r}>
                  %{r}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Fiyat (₺)" hint="M ya da tek boy">
            <Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" disabled={synced} />
          </Field>
          <Field label="L fiyatı (₺)" hint="boş = tek boy">
            <Input value={f.priceL} onChange={(e) => setF({ ...f, priceL: e.target.value })} inputMode="decimal" disabled={synced} />
          </Field>
          <Field label="Kısa ad" hint="düğme ve fişte">
            <Input value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} />
          </Field>
          <Field label="lafmaliyet adı" hint="boşsa AD BOY">
            <Input value={f.posName} onChange={(e) => setF({ ...f, posName: e.target.value })} placeholder="ör. LATTE MEDIUM" />
          </Field>
          <Field label="İstasyon" hint="boşsa kategoriden">
            <Select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
              <option value="">Kategoriden</option>
              {boot.stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Günlük porsiyon" hint="boş = takip yok">
            <Input value={f.portionsLeft} onChange={(e) => setF({ ...f, portionsLeft: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Field>
          <Field label="Barkod">
            <Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} />
          </Field>
          <Field label="Hizmet" hint="karaoke gibi">
            <Toggle checked={f.isService} onChange={(v) => setF({ ...f, isService: v })} disabled={synced} label={f.isService ? 'Evet' : 'Hayır'} />
          </Field>
        </div>
        <div>
          <div className="mb-1.5 text-sm font-medium text-[var(--admin-text-soft)]">Seçenek grupları</div>
          <div className="flex flex-wrap gap-1.5">
            {groups
              .filter((g) => g.active)
              .map((g) => {
                const on = f.groupIds.includes(g.id);
                return (
                  <button
                    key={g.id}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setF({ ...f, groupIds: on ? f.groupIds.filter((x) => x !== g.id) : [...f.groupIds, g.id] })}
                    className={cn(
                      'min-h-11 rounded-full border px-3 text-[13px] font-medium pointer-fine:min-h-8',
                      on ? 'border-[var(--admin-primary)] bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]' : 'border-[var(--admin-border-strong)] text-[var(--admin-text-soft)] hover:border-[var(--admin-border-field)]',
                    )}
                  >
                    {g.name}
                    {g.extSource && <span className="ml-1 text-xs opacity-70">site</span>}
                  </button>
                );
              })}
          </div>
        </div>
      </div>
    </QuickLook>
  );
}
