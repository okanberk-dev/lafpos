import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CircleCheck, Coffee, ExternalLink, Eye, EyeOff, Globe, Pencil, Plus, RefreshCw, Save, Star, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { netMarginPct, parseTL, tl } from '@shared/money';
import { type AvailabilityResultDTO, availabilityNotice } from '@shared/tukendi';
import type { ProductDTO } from '@shared/types';
import { newGroupDraft, OptionGroupEditor } from '@/components/admin/OptionGroupEditor';
import { ActionMenu, ActionRow, ActionRows, Badge, Card, CARD, CODE, type Column, DataTable, EmptyState, PageHeader, QuickLook, SearchField, SetupNotes, StatusTabs, TableSkeleton } from '@/components/admin/ui';
import { Button, buttonClass } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Chip, Field, Input, Label, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, Notice } from '@/components/ui/misc';
import { del, errorMessage, get, patch, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer, useMediaQuery } from '@/lib/hooks';
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
  /** İmzalı panel alınamadı: fiyat ve ürünler uygulanır, Satışta bilgisi değişmez */
  warning?: string;
}
type Category = AdminMenu['categories'][number];
/** Durum sekmeleri yalnız satış durumu; kaynak (siteden, yerel) ayrı süzgeç: ikisi aynı ürünü kesişen iki boyut */
type Tab = 'tumu' | 'satista' | 'tukendi' | 'gizli';
type Source = '' | 'site' | 'yerel';

const CHANGE_LABEL: Record<string, string> = { yeni: 'Yeni', fiyat: 'Fiyat', ad: 'Ad', kdv: 'KDV', boy: 'Boy', kalkti: 'Satışta değil', geri: 'Yeniden satışta', diger: 'Diğer' };

const status = (p: ProductDTO) =>
  p.hidden
    ? { tone: 'neutral' as const, label: 'POS’ta gizli' }
    : p.active
      ? { tone: 'success' as const, label: 'Satışta' }
      : { tone: 'danger' as const, label: p.soldOutBy === 'site' ? 'Sitede satışta değil' : 'Tükendi' };

/**
 * Ürünün baş harfleri kategori renginin açık tonunda (kasadaki ürün kartıyla aynı dil): dolu renk ve beyaz harf
 * listenin en yüksek sesiydi, açık seçilmiş kategori renginde de okunmazdı. Harf, kategori rengiyle mürekkebin
 * karışımı: iki temada ve her renkte okunur
 */
function ProductMark({ name, color }: { name: string; color: string }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-9 shrink-0 place-items-center rounded-lg text-xs font-semibold"
      style={
        color
          ? { background: `color-mix(in oklab, ${color} 14%, var(--admin-surface-2))`, color: `color-mix(in oklab, ${color} 45%, var(--admin-text))` }
          : { background: 'var(--admin-panel)', color: 'var(--admin-text-soft)' }
      }
    >
      {name
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((w) => w[0])
        .join('')
        .toLocaleUpperCase('tr-TR')}
    </span>
  );
}

/** Boş hücre: tire değil, kitin soluk uzun çizgisi */
/** Ürünün kaynağı ve öteki adları (tek satır): dar sütunda kısalır, tam hali ipucunda */
function ProductSource({ p }: { p: ProductDTO }) {
  const text = [p.extSource ? 'Siteden' : 'Yerel', p.shortName && `kısa: ${p.shortName}`, p.posName && `lafmaliyet: ${p.posName}`].filter(Boolean).join(' · ');
  return (
    <span className="block truncate text-xs text-[var(--admin-text-mute)]" title={text}>
      {text}
    </span>
  );
}

const EMPTY = <span className="text-[var(--admin-text-mute)]">—</span>;

/**
 * Ürünler (Innex): durum sekmeleri sayılı, tek satır araç çubuğu, kart içinde tablo, satıra tıklayınca sağdan
 * hızlı bakış ve düzenleme (Innex §3 fikir 8). Siteden gelen ürünün adı, fiyatı, boyu ve KDV'si sitede değişir;
 * burada kasa alanları düzenlenir. Adres ?urun=<id> ile açılır, geri tuşu çekmeceyi kapatır.
 */
export default function MenuAdmin() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const data = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => get<AdminMenu>('/admin/menu') });
  const [tab, setTab] = useState<Tab>('tumu');
  const [catId, setCatId] = useState('');
  const [source, setSource] = useState<Source>('');
  // Kaynak seçimi telefonda gizli (sm altında, Tailwind'in sm'i 40rem): gizliyken süzmez. Yoksa yatay tutulan telefonda
  // seçilen "Yerel" dikeye dönünce görünür bir denetim olmadan listeyi süzmeye devam eder, siteden gelen ürünler
  // kaybolmuş görünürdü
  const sourceShown = useMediaQuery('(min-width: 40rem)');
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
  const counts = {
    tumu: all.length,
    satista: all.filter((p) => p.active && !p.hidden).length,
    tukendi: all.filter((p) => !p.active && !p.hidden).length,
    gizli: all.filter((p) => p.hidden).length,
    site: all.filter((p) => p.extSource).length,
    yerel: all.filter((p) => !p.extSource).length,
  };
  // Kaynak süzgeci yalnız iki tür de varken (site bağlantısı yokken her ürün yereldir) ve seçimi göründüğü genişlikte
  const bySource = counts.site > 0 && counts.yerel > 0;
  const src: Source = bySource && sourceShown ? source : '';
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter((p) => {
      // lafmaliyet adı da aranır (yer tutucuda yazmasa da)
      if (k && !fold(`${p.name} ${p.shortName ?? ''} ${p.posName ?? ''}`).includes(k)) return false;
      if (catId && p.categoryId !== catId) return false;
      if (src === 'site' && !p.extSource) return false;
      if (src === 'yerel' && p.extSource) return false;
      if (tab === 'satista') return p.active && !p.hidden;
      if (tab === 'tukendi') return !p.active && !p.hidden;
      if (tab === 'gizli') return p.hidden;
      return true;
    });
  }, [all, q, catId, src, tab]);
  // Porsiyon sütunu yalnız günlük porsiyonu izlenen ürün varken (yoksa baştan sona boş sütun)
  const portions = all.some((p) => p.portionsLeft != null);

  const availability = async (p: ProductDTO, active: boolean) => {
    try {
      const r = await post<AvailabilityResultDTO>(`/sync/products/${p.id}/availability`, { active });
      const notice = availabilityNotice(p.name, active, r, { admin: true });
      toast[notice.tone](notice.text);
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
      if (r.warning) toast.warn(`Menü eşitlendi; ${r.warning}`);
      else toast.ok(r.status === 'degismedi' ? 'Site menüsü değişmemiş' : `Menü eşitlendi: ${r.result?.created ?? 0} yeni, ${r.result?.updated ?? 0} güncel`);
      setPreview(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSyncing(false);
    }
  };

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
              {/* Gizli ürün soluk değil (metin AA altına, ⋯ devre dışı görünürdü): ikon ve sakin ad; durum rozeti de söyler */}
              <span className={cn('truncate', p.hidden && 'text-[var(--admin-text-soft)]')} title={p.name}>
                {p.name}
              </span>
              {p.hidden && <EyeOff role="img" aria-label="POS’ta gizli" className="size-3.5 shrink-0 text-[var(--admin-text-mute)]" />}
              {p.favorite && <Star aria-label="Sık kullanılan" className="size-3.5 shrink-0 fill-[var(--admin-warning)] text-[var(--admin-warning)]" />}
            </span>
            <ProductSource p={p} />
          </span>
        </span>
      ),
    },
    { key: 'kategori', header: 'Kategori', cell: (p) => <span className="whitespace-nowrap text-[var(--admin-text-soft)]">{catOf(p)?.name ?? EMPTY}</span>, hideOnPhone: true, hideBelow: 'xl' },
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
    ...(portions ? [{ key: 'porsiyon', header: 'Porsiyon', align: 'right' as const, cell: (p: ProductDTO) => <span className="tabular-nums">{p.portionsLeft ?? EMPTY}</span>, hideOnPhone: true, hideBelow: 'lg' as const }] : []),
    { key: 'durum', header: 'Durum', cell: (p) => <Badge tone={status(p).tone}>{status(p).label}</Badge> },
  ];

  const siteUrl = boot.integrations.laffogatoUrl;
  const localButton = (primary: boolean) => (
    <Button variant={primary ? 'primary' : 'secondary'} icon={<Plus className="size-4" />} onClick={() => open('yeni')}>
      Yerel ürün
    </Button>
  );
  const header = (
    <PageHeader
      title="Ürünler"
      description={siteUrl ? 'Ad, fiyat ve KDV sitede değişir; burada satış durumu, istasyon, kısa ad ve porsiyon' : 'Site bağlantısı kurulmadı; burada satış durumu, istasyon, kısa ad, porsiyon ve yerel ürünler'}
      actions={
        // Site bağlantısı yokken (LAFFOGATO_URL, varsayılan kapalı) eşitleme hep "kurulmadı" der ve sitede eklenen ürün
        // kasaya gelmez: iki düğme de yok, çalışan tek eylem (Yerel ürün) birincil olur
        siteUrl ? (
          <>
            <Button icon={<RefreshCw className="size-4" />} loading={syncing} onClick={syncPreview}>
              Siteyle eşitle
            </Button>
            {localButton(false)}
            <a href={`${siteUrl.replace(/\/+$/, '')}/admin/menu/yeni`} target="_blank" rel="noreferrer" className={buttonClass('primary')}>
              <ExternalLink className="size-4" aria-hidden="true" />
              Sitede ürün ekle
            </a>
          </>
        ) : (
          localButton(true)
        )
      }
    />
  );
  // Başlık ve eylemler hemen görünür; liste gelene dek tablo iskeleti
  if (data.isPending)
    return (
      <>
        {header}
        <TableSkeleton />
      </>
    );
  if (data.isError && !data.data)
    return (
      <>
        {header}
        <ErrorState className={CARD} title="Ürünler alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      </>
    );
  const clearFilters = () => {
    setQ('');
    setCatId('');
    setSource('');
    setTab('tumu');
  };

  return (
    <>
      {header}

      <StatusTabs
        label="Ürün durumu"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'tumu', label: 'Tümü', count: counts.tumu },
          { value: 'satista', label: 'Satışta', count: counts.satista },
          { value: 'tukendi', label: 'Tükendi', count: counts.tukendi },
          { value: 'gizli', label: 'POS’ta gizli', count: counts.gizli },
        ]}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Ürün ya da kısa ad ara" label="Ürün ara" />
        <label className="min-w-0 flex-1 sm:w-56 sm:flex-none">
          <span className="sr-only">Kategori</span>
          <Select value={catId} onChange={(e) => setCatId(e.target.value)} className="[[data-area=admin]_&]:pointer-fine:h-9">
            <option value="">Bütün kategoriler</option>
            {cats.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.active ? '' : ' (gizli)'}
              </option>
            ))}
          </Select>
        </label>
        {/* Telefonda yok: iki seçim kutusu yan yana sığmaz; satır kartı kaynağı zaten yazar ("Siteden", "Yerel"). Gizliyken
            seçili kaynak da süzmez (sourceShown) */}
        {bySource && (
          <label className="hidden min-w-0 sm:block sm:w-44">
            <span className="sr-only">Kaynak</span>
            <Select value={source} onChange={(e) => setSource(e.target.value as Source)} className="[[data-area=admin]_&]:pointer-fine:h-9">
              <option value="">Siteden ve yerel</option>
              <option value="site">Siteden ({counts.site})</option>
              <option value="yerel">Yerel ({counts.yerel})</option>
            </Select>
          </label>
        )}
        <span className="ml-auto text-xs text-[var(--admin-text-mute)] tabular-nums">{rows.length} ürün</span>
      </div>

      {cat && (
        <CategoryBar
          // Kategori değişince renk taslağı taşınmasın (bekleyen renk öteki kategoriye yazılmasın)
          key={cat.id}
          cat={cat}
          onChange={(body) =>
            patch(`/admin/categories/${cat.id}`, body).then(
              () => {
                refresh();
                // Bütün kasalarda kategoriyi gizler ya da açar: sessiz kalmaz
                if ('active' in body) toast.ok(body.active ? `${cat.name} POS’ta yeniden görünüyor` : `${cat.name} POS’ta gizlendi; ürünleri kasada görünmez`);
                return true;
              },
              (e) => {
                toast.err(errorMessage(e));
                return false;
              },
            )
          }
        />
      )}

      <DataTable
        caption="Ürünler"
        rows={rows}
        columns={columns}
        rowKey={(p) => p.id}
        onOpen={(p) => open(p.id)}
        selectedKey={openId}
        phoneTitle={(p) => columns[0].cell(p)}
        phoneMeta={(p) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={status(p).tone}>{status(p).label}</Badge>
            {/* Fiyat satır kartının rakamı: mürekkepte ve orta kalın (masaüstündeki Fiyat sütunu gibi), L fiyatı soluk */}
            <span className="font-medium tabular-nums text-[var(--admin-text)]">
              {tl(p.price)}
              {p.priceL != null && <span className="font-normal text-[var(--admin-text-mute)]"> / {tl(p.priceL)}</span>}
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
          all.length === 0 ? (
            // İlk kurulum: süzgeç değil, menü boş; ürünün nereden geleceğini söyler
            <EmptyState
              icon={<Coffee />}
              title="Menüde ürün yok"
              action={
                siteUrl ? (
                  <Button variant="primary" icon={<RefreshCw className="size-4" />} loading={syncing} onClick={syncPreview}>
                    Siteyle eşitle
                  </Button>
                ) : (
                  <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('yeni')}>
                    Yerel ürün ekle
                  </Button>
                )
              }
            >
              {siteUrl ? 'Ürünler laffogato panelinde eklenir; eşitleyince buraya gelir' : 'Site bağlantısı kurulmadı. Yalnız kafede satılan hizmetler için yerel ürün ekleyin'}
            </EmptyState>
          ) : (
            <EmptyState art="arama" title={q.trim() ? `“${q.trim()}” ile eşleşen ürün yok` : 'Bu süzgeçte ürün yok'} action={<Button onClick={clearFilters}>Süzgeci temizle</Button>}>
              Aramayı ya da süzgeçleri değiştirin
            </EmptyState>
          )
        }
      />

      <div className="mt-4">
        <SetupNotes summary="Menü nasıl çalışır">
          <p>Ürünler tek yerde, laffogato panelinde eklenir; site, uygulama ve kasa aynı menüyü okur. Süt, şurup ve shot site kodundaki sabit listeden gelir; kasaya özel seçenek grubu Seçenekler’de ya da ürünün çekmecesinde (Yeni grup) açılır.</p>
          <p>Yerel ürün yalnız kafede satılan hizmetler içindir (karaoke, etkinlik ücreti gibi).</p>
          <p>
            Site bağlantısı (<code className={CODE}>LAFFOGATO_URL</code>) yoksa sitede eklenen ürün kasaya gelmez. Ayrıntı: <code className={CODE}>docs/06-TEK-SISTEM.md</code>
          </p>
        </SetupNotes>
      </div>

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
          onGroupCreated={refresh}
        />
      )}

      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        size="lg"
        title="Site menüsü"
        subtitle={preview?.status === 'degismedi' ? 'Son eşitlemeden beri sitede değişiklik yok' : `${preview?.preview?.itemCount ?? 0} ürün · ${preview?.preview?.changes.length ?? 0} değişiklik`}
        footer={
          // Telefonda eşit genişlikte düğmeler (onay penceresi gibi); geniş ekranda sağa yaslı
          <div className="flex justify-end gap-2 max-sm:[&>*]:flex-1">
            <Button onClick={() => setPreview(null)}>Kapat</Button>
            {preview?.status === 'onizleme' && (
              <Button variant="primary" loading={syncing} onClick={syncApply}>
                Değişiklikleri uygula
              </Button>
            )}
          </div>
        }
      >
        {/* Gövde payı pencerenin başlık ve alt şeridiyle aynı (20, genişte 24): içerik başlıkla aynı hizada başlar */}
        <div className="px-5 py-4 sm:px-6">
          {preview?.warning ? (
            <Notice tone="warn" className="mb-3">
              {preview.warning}
            </Notice>
          ) : null}
          {preview?.preview?.newCategories.length ? (
            <p className="mb-3 text-sm text-[var(--admin-text-soft)]">
              Yeni kategoriler: <span className="font-medium text-[var(--admin-text)]">{preview.preview.newCategories.join(', ')}</span>
            </p>
          ) : null}
          {preview?.preview?.changes.length ? (
            // Kart içindeki karo (köşe --r-tile); satır tablo satırı gibi en az 44 px, uzun ad dar ekranda kırılır
            <ul className="divide-y divide-[var(--admin-divider)] rounded-[var(--r-tile)] border border-[var(--admin-border)]">
              {preview.preview.changes.map((ch) => (
                <li key={`${ch.extId}-${ch.kind}`} className="flex min-h-11 items-center gap-3 px-3.5 py-2.5 text-sm">
                  <Badge tone={ch.kind === 'yeni' || ch.kind === 'geri' ? 'success' : ch.kind === 'kalkti' ? 'danger' : 'warning'}>{CHANGE_LABEL[ch.kind] ?? ch.kind}</Badge>
                  <span className="min-w-0 flex-1 break-words font-medium text-[var(--admin-text)]">{ch.name}</span>
                  <span className="shrink-0 text-right text-[13px] tabular-nums text-[var(--admin-text-mute)]">{ch.detail}</span>
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

function CategoryBar({ cat, onChange }: { cat: Category; onChange: (b: Record<string, unknown>) => Promise<boolean> }) {
  const boot = useBoot();
  // Renk seçici sürüklerken her harekette olay verir: renk taslakta kalır, el durunca (400 ms) bir kez yazılır. Sunucunun
  // rengi taslağa yetişene dek taslak gösterilir (seçici arada eski renge zıplamaz); yazılamazsa sunucununkine döner
  const [draft, setDraft] = useState<string | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
  useEffect(() => {
    if (draft == null) return;
    if (draft.toLowerCase() === cat.color.toLowerCase()) {
      setDraft(null);
      return;
    }
    const t = setTimeout(() => void latest.current({ color: draft }).then((ok) => !ok && setDraft(null)), 400);
    return () => clearTimeout(t);
  }, [draft, cat.color]);
  const color = draft ?? cat.color;
  return (
    // Kategorinin adı solda, ayarları sağda tek kümede (ayar çubuğu). Telefonda ad üstte; Renk ve İstasyon bir satırda,
    // İstasyon kalan yeri alır (uzun "Yok (bara...)" seçeneği kartın dışına taşmaz), anahtar altta
    <Card className="mb-3" bodyClassName="flex flex-wrap items-center gap-x-6 gap-y-3 py-3 sm:py-3">
      <span className="flex min-w-0 items-center gap-2 text-sm font-semibold text-[var(--admin-text)] sm:mr-auto">
        <span aria-hidden="true" className="size-3 shrink-0 rounded-full ring-1 ring-black/10 dark:ring-white/25" style={{ background: color }} />
        <span className="truncate">{cat.name}</span>
        {cat.extSource && <Badge tone="info">Site kategorisi</Badge>}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3 max-sm:w-full">
        <label className="flex min-h-11 items-center gap-2 text-[13px] font-medium text-[var(--admin-text-soft)] pointer-fine:min-h-9">
          Renk
          {/* Alanların kenarı ve gölgesi (3:1); renk karesi köşeleri eş merkezli: kutu 10, iç boşluk 4, kare 6 */}
          <input
            type="color"
            value={color}
            onChange={(e) => setDraft(e.target.value)}
            className="h-11 w-12 cursor-pointer rounded-[var(--r-control)] border border-[var(--admin-border-field)] bg-[var(--admin-surface)] p-1 shadow-[var(--shadow-control)] outline-none transition-[border-color,box-shadow] duration-150 hover:border-[var(--admin-text-mute)] focus-visible:border-[var(--admin-primary)] focus-visible:shadow-[0_0_0_3px_var(--admin-primary-soft)] pointer-fine:h-9 pointer-fine:w-11 [&::-moz-color-swatch]:rounded-[var(--r-chip)] [&::-moz-color-swatch]:border-0 [&::-webkit-color-swatch-wrapper]:p-0 [&::-webkit-color-swatch]:rounded-[var(--r-chip)] [&::-webkit-color-swatch]:border-0"
          />
        </label>
        <label className="flex min-w-0 flex-1 basis-40 items-center gap-2 text-[13px] font-medium text-[var(--admin-text-soft)] sm:flex-none sm:basis-auto">
          İstasyon
          <Select value={cat.stationId ?? ''} onChange={(e) => onChange({ stationId: e.target.value || null })} className="min-w-0 flex-1 sm:w-auto sm:flex-none [[data-area=admin]_&]:pointer-fine:h-9">
            <option value="">Yok (bara ya da mutfağa gitmez)</option>
            {boot.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </label>
        <Toggle checked={cat.active} onChange={(v) => onChange({ active: v })} label="POS’ta göster" />
      </div>
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
  onGroupCreated,
}: {
  product: ProductDTO | null;
  cats: Category[];
  groups: AdminMenu['optionGroups'];
  onClose: () => void;
  onSaved: () => void;
  onAvailability: (p: ProductDTO, active: boolean) => Promise<void>;
  onQuick: (p: ProductDTO, body: Record<string, unknown>, done?: string) => Promise<void>;
  /** Çekmeceden yeni seçenek grubu açıldı: liste yenilenir, çip görünür */
  onGroupCreated: () => void;
}) {
  const boot = useBoot();
  const can = useCan();
  const fine = useFinePointer();
  const synced = !!product?.extSource;
  const [saving, setSaving] = useState(false);
  // Eksik alan sessizce soluk düğme yerine Kaydet'e basınca alanın altında söylenir
  const [tried, setTried] = useState(false);
  const [newGroup, setNewGroup] = useState(false);
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
  const nameError = !f.name.trim() ? 'Ad gerekli' : null;
  const priceError = synced ? null : !parseTL(f.price || '0') ? 'Fiyat gerekli (ör. 85 ya da 85,50)' : null;

  const save = async () => {
    if (nameError || priceError) {
      setTried(true);
      return;
    }
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
      // Seçenek grupları ürünle tek istekte (sunucuda tek işlem); değişmediyse gönderilmez, bağlar olduğu gibi kalır
      const links = f.groupIds.join('|') !== (product?.optionGroupIds ?? []).join('|') ? { groupIds: f.groupIds } : {};
      if (!product) await post('/admin/products', { ...own, ...pos, ...links });
      else await patch(`/admin/products/${product.id}`, { ...(synced ? pos : { ...own, ...pos }), ...links });
      toast.ok(product ? `${f.name} kaydedildi` : `${f.name} eklendi`);
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const remove = async () => {
    if (!product || !(await confirmDialog({ title: `${product.name} kaldırılsın mı`, body: 'Satıldıysa gizlenir, hiç satılmadıysa silinir', confirmLabel: 'Ürünü kaldır' }))) return;
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
            <Button variant="dangerOutline" icon={<Trash2 className="size-4" />} onClick={() => void remove()}>
              Kaldır
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
            Kaydet
          </Button>
        </>
      }
    >
      {product && st && (
        <div className="mb-6 space-y-3">
          {/* Özet tek karoda iki hücre (köşe --r-tile, arada saç teli): rozet ile fiyatın boyu farklı, iki ayrı kutuda
              durum kutusu yarı boş görünürdü. Etiket 13/500 soluk, rakam 20/700 */}
          <div className="grid grid-cols-2 divide-x divide-[var(--admin-divider)] rounded-[var(--r-tile)] border border-[var(--admin-border)]">
            <div className="min-w-0 p-3.5">
              <div className="text-[13px] font-medium text-[var(--admin-text-mute)]">Satış durumu</div>
              <div className="mt-2">
                <Badge tone={st.tone} dot>
                  {st.label}
                </Badge>
              </div>
            </div>
            <div className="min-w-0 p-3.5">
              <div className="text-[13px] font-medium text-[var(--admin-text-mute)]">{product.priceL != null ? 'Fiyat (M / L)' : 'Fiyat'}</div>
              <div className="mt-1 text-xl font-bold leading-7 tracking-[-0.02em] tabular-nums text-[var(--admin-text)]">
                {tl(product.price)}
                {product.priceL != null && <span className="text-sm font-medium tracking-normal text-[var(--admin-text-mute)]"> / {tl(product.priceL)}</span>}
              </div>
              {/* Site ürününde KDV formda yok (sitede değişir): oran burada okunur */}
              <div className="text-xs text-[var(--admin-text-mute)]">%{product.kdvRate} KDV dahil</div>
              {/* Maliyet KDV hariç (lafmaliyet): marj KDV hariç fiyattan, M / tek boy fiyatıyla (maliyet M'nin; L'nin
                  maliyeti ayrı tutulmaz). Raporlar › Ürünler'in brüt kârıyla aynı kural */}
              {can('rapor.maliyet') && product.cost != null && (
                <div className="text-xs text-[var(--admin-text-mute)]">
                  maliyet {tl(product.cost)}
                  {netMarginPct(product.price, product.kdvRate, product.cost) != null && ` · KDV hariç marj %${netMarginPct(product.price, product.kdvRate, product.cost)}${product.priceL != null ? ' (M)' : ''}`}
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
        {/* Bölüm başlığı kart başlığının ölçüsünde (16/600): 13 px alan etiketlerinden ayrılır */}
        <h3 className="text-base font-semibold leading-6 tracking-[-0.015em] text-[var(--admin-text)]">{product ? 'Kasa alanları' : 'Ürün bilgisi'}</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {/* Siteden gelen üründe ad, kategori, KDV ve fiyat sitede değişir (yukarıda okunur): devre dışı beş alan kasa
              alanlarını aşağı itmesin diye hiç çizilmez; kayıt da yalnız kasa alanlarını gönderir */}
          {!synced && (
            <>
              <Field label="Ad" className="sm:col-span-2" required error={tried ? nameError : null}>
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus={!product && fine} />
              </Field>
              <Field label="Kategori">
                <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
                  {cats.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="KDV">
                <Select value={f.kdvRate} onChange={(e) => setF({ ...f, kdvRate: Number(e.target.value) })}>
                  {[0, 10, 20].map((r) => (
                    <option key={r} value={r}>
                      %{r}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Fiyat (₺)" hint="M ya da tek boy" error={tried ? priceError : null}>
                <Input value={f.price} onChange={(e) => setF({ ...f, price: e.target.value })} inputMode="decimal" />
              </Field>
              <Field label="L fiyatı (₺)" hint="boşsa tek boy">
                <Input value={f.priceL} onChange={(e) => setF({ ...f, priceL: e.target.value })} inputMode="decimal" />
              </Field>
              <Toggle block checked={f.isService} onChange={(v) => setF({ ...f, isService: v })} label="Hizmet ürünü" hint="Karaoke, etkinlik ücreti gibi" className="sm:col-span-2" />
            </>
          )}
          <Field label="Kısa ad" hint="düğme ve fişte">
            <Input value={f.shortName} onChange={(e) => setF({ ...f, shortName: e.target.value })} />
          </Field>
          <Field label="lafmaliyet adı" hint={product?.priceL != null || (!synced && f.priceL) ? 'boy eki eklenir' : 'boşsa AD BOY'}>
            <Input value={f.posName} onChange={(e) => setF({ ...f, posName: e.target.value })} placeholder="Ör. LATTE" spellCheck={false} />
          </Field>
          {/* İpucu yok: boş seçenek zaten "Kategoriden" der. Uzun ipucu alanın altına inip satırı yanındaki Günlük
              porsiyon'dan uzatıyordu */}
          <Field label="İstasyon">
            <Select value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
              <option value="">Kategoriden</option>
              {boot.stations.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>
          {/* Kısa ipucu tek satırda kalır: alan yanındaki İstasyon'la aynı hizada */}
          <Field label="Günlük porsiyon" hint="boşsa sınırsız">
            <Input value={f.portionsLeft} onChange={(e) => setF({ ...f, portionsLeft: e.target.value.replace(/\D/g, '') })} inputMode="numeric" />
          </Field>
          {/* Tek sayılı son alan iki sütunu kaplar: sağında boş yarım satır kalmaz */}
          <Field label="Barkod" className="sm:col-span-2">
            <Input value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} spellCheck={false} />
          </Field>
        </div>
        <div>
          <Label>Seçenek grupları</Label>
          <div className="flex flex-wrap gap-1.5">
            {groups
              .filter((g) => g.active)
              .map((g) => {
                const on = f.groupIds.includes(g.id);
                // Kitin seçim çipi (Seçenekler'deki gün ve kategori çipiyle aynı): kapsül, yeşil seçim
                return (
                  <Chip key={g.id} on={on} onClick={() => setF({ ...f, groupIds: on ? f.groupIds.filter((x) => x !== g.id) : [...f.groupIds, g.id] })}>
                    {g.name}
                    {/* Kaynak işareti çipin renginde (soluk yazı değil); ekran okuyucuya "Siteden" */}
                    {g.extSource && <Globe role="img" aria-label="Siteden" className="size-3.5 shrink-0" />}
                  </Chip>
                );
              })}
            {/* Ekleme çipi seçim çipleriyle aynı boyda ve köşede (--r-btn); kesikli kenar "yeni" der */}
            <button
              type="button"
              onClick={() => setNewGroup(true)}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-[var(--r-btn)] border border-dashed border-[var(--admin-border-field)] px-3.5 text-[13px] font-medium text-[var(--admin-text-soft)] transition-colors duration-150 hover:border-[var(--admin-text-mute)] hover:bg-surface-2 hover:text-[var(--admin-text)] active:bg-press pointer-fine:min-h-9"
            >
              <Plus aria-hidden="true" className="size-3.5" />
              Yeni grup
            </button>
          </div>
        </div>
      </div>
      {newGroup && (
        <OptionGroupEditor
          initial={newGroupDraft()}
          canClose={false}
          note="Kaydedince grup bu ürün için seçilir; ürünü kaydedince bağlanır"
          onClose={() => setNewGroup(false)}
          onSaved={({ id, name }) => {
            setF((cur) => ({ ...cur, groupIds: [...cur.groupIds, id] }));
            setNewGroup(false);
            onGroupCreated();
            toast.ok(`${name} grubu eklendi; ürünü kaydedince bağlanır`);
          }}
        />
      )}
    </QuickLook>
  );
}
