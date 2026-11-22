import { useQueryClient } from '@tanstack/react-query';
import { PackageSearch } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type AvailabilityResultDTO, availabilityNotice } from '@shared/tukendi';
import { errorMessage, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { fold } from '@/lib/shell';
import { toast } from '@/lib/toast';
import { Button } from './ui/Button';
import { SearchInput } from './ui/Field';
import { EmptyState, Tabs } from './ui/misc';
import { Modal } from './ui/Modal';

type Tab = 'urun' | 'secenek';

/**
 * Kasadan ve bardan "tükendi" (ModPOS "Ürünü Satışa Kapatma" yetkisi gibi, `urun.tukendi`). Siteden gelen ürün
 * sitede ve uygulamada da tükenir; internet yokken kasada hemen geçerli olur, site internet gelince güncellenir
 * (shared/tukendi.ts); tükenenler listenin başında. Sitenin kapattığı ürünü ("Sitede satışta değil")
 * yalnız menü yetkisi olan açar: kasiyerde düğmesi yok, sunucu da reddeder. Seçenekler sekmesi (yulaf sütü bitti)
 * yalnız LafPOS'ta değişir: seçenek penceresinde gri görünür, kasa satışı almaz.
 */
export function SoldOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const boot = useBoot();
  const can = useCan();
  const manager = can('menu.yonet');
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>('urun');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  // Kasada satılan bir ürüne bağlı gruplar; başlığın yanında hangi ürünlerde olduğu (iki "Şeker" grubu karışmasın).
  // Sitenin "hiçbiri" seçeneği (Şurup yok) tükenmez: listelenmez
  const groups = useMemo(() => {
    const sold = boot.products.filter((p) => !p.hidden && !p.isService);
    return boot.optionGroups
      .map((g) => ({ ...g, items: g.items.filter((i) => i.code !== 'none'), usedBy: sold.filter((p) => p.optionGroupIds.includes(g.id)).map((p) => p.shortName?.trim() || p.name) }))
      .filter((g) => g.usedBy.length > 0 && g.items.length > 0);
  }, [boot.optionGroups, boot.products]);
  const optionTab = tab === 'secenek' && groups.length > 0;
  const rows = useMemo(() => {
    if (optionTab) return [];
    const k = fold(q.trim());
    return boot.products
      .filter((p) => !p.hidden && !p.isService && (!k || fold(p.name).includes(k)))
      .sort((a, b) => Number(a.active) - Number(b.active) || a.name.localeCompare(b.name, 'tr'));
  }, [boot.products, q, optionTab]);
  const optionRows = useMemo(() => {
    if (!optionTab) return [];
    const k = fold(q.trim());
    return groups
      .map((g) => ({ ...g, items: !k || fold(g.name).includes(k) ? g.items : g.items.filter((i) => fold(i.name).includes(k)) }))
      .filter((g) => g.items.length > 0);
  }, [groups, q, optionTab]);
  const soldProducts = boot.products.filter((p) => !p.active && !p.hidden).length;
  const soldOptions = groups.reduce((a, g) => a + g.items.filter((i) => i.soldOut).length, 0);

  const set = async (id: string, name: string, active: boolean) => {
    setBusy(id);
    try {
      const r = await post<AvailabilityResultDTO>(`/sync/products/${id}/availability`, { active });
      // İnternet yoksa uyarı tonunda: "İnternet yok: kasada uygulandı, site internet gelince güncellenecek"
      const notice = availabilityNotice(name, active, r);
      toast[notice.tone](notice.text);
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const setOption = async (id: string, name: string, soldOut: boolean) => {
    setBusy(id);
    try {
      await post(`/option-items/${id}/sold-out`, { soldOut });
      toast.ok(`${name} ${soldOut ? 'tükendi' : 'satışa açıldı'}`);
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const noun = optionTab ? 'seçenek' : 'ürün';
  const sold = optionTab ? soldOptions : soldProducts;
  const searching = !!q.trim();
  return (
    // Başlık sekmeyle değişmez (e2e pencereyi "Tükenen ürünler" adıyla bulur); hangi listede olunduğunu alt satır söyler
    <Modal open={open} onClose={onClose} title="Tükenen ürünler" subtitle={sold ? `${sold} ${noun} tükendi` : `Tükenen ${noun} yok`} size="md">
      <div className="sticky top-0 z-10 space-y-2 border-b border-line bg-surface p-3">
        {groups.length > 0 && (
          <Tabs<Tab>
            label="Tükenenler"
            value={tab}
            onChange={setTab}
            options={[
              { value: 'urun', label: 'Ürünler', count: soldProducts },
              { value: 'secenek', label: 'Seçenekler', count: soldOptions },
            ]}
          />
        )}
        <SearchInput value={q} onChange={setQ} label={optionTab ? 'Seçenek ara' : 'Ürün ara'} placeholder={optionTab ? 'Seçenek ara (yulaf, karamel…)' : 'Ürün ara'} />
      </div>
      {(optionTab ? optionRows.length : rows.length) === 0 && (
        // Sonuçsuz arama her yerde boş fincan tabağıyla (DESIGN §2 çizimler); hiç ürün yoksa simge
        <EmptyState
          compact
          art={searching ? 'arama' : undefined}
          icon={searching ? undefined : <PackageSearch />}
          title={searching ? `“${q.trim()}” ile eşleşen ${noun} yok` : `Kasada satılan ${noun} yok`}
          action={searching ? <Button size="sm" variant="ghost" onClick={() => setQ('')}>Aramayı temizle</Button> : undefined}
        />
      )}
      {optionTab &&
        optionRows.map((g) => (
          <section key={g.id} aria-label={g.name}>
            <h3 className="flex items-baseline gap-2 border-b border-line bg-surface-2 px-4 py-1.5">
              <span className="shrink-0 text-[13px] font-semibold text-ink">{g.name}</span>
              <span className="min-w-0 truncate text-xs text-muted">{g.usedBy.length > 2 ? `${g.usedBy.slice(0, 2).join(', ')} ve ${g.usedBy.length - 2} ürün daha` : g.usedBy.join(', ')}</span>
            </h3>
            <ul className="divide-y divide-line border-b border-line">
              {g.items.map((i) => (
                <li key={i.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{i.name}</span>
                    {i.soldOut && <span className="text-xs font-semibold text-[var(--admin-danger-ink)]">Tükendi</span>}
                  </span>
                  {/* Kırmızı durumu söyler (adın altındaki "Tükendi"), eylemi değil: işaretleme sakin, satışa açma yeşilin açık tonu */}
                  <Button variant={i.soldOut ? 'soft' : 'secondary'} loading={busy === i.id} disabled={!!busy && busy !== i.id} onClick={() => setOption(i.id, `${i.name} (${g.name})`, !i.soldOut)} className="shrink-0 text-sm font-semibold">
                    {i.soldOut ? 'Satışa aç' : 'Tükendi'}
                  </Button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      <ul className="divide-y divide-line">
        {rows.map((p) => {
          const siteClosed = !p.active && p.soldOutBy === 'site';
          return (
            <li key={p.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                {!p.active && <span className="text-xs font-semibold text-[var(--admin-danger-ink)]">{siteClosed ? 'Sitede satışta değil' : 'Tükendi'}</span>}
              </span>
              {siteClosed && !manager ? (
                <span className="shrink-0 text-xs text-muted">Yönetici açar</span>
              ) : (
                <Button variant={p.active ? 'secondary' : 'soft'} loading={busy === p.id} disabled={!!busy && busy !== p.id} onClick={() => set(p.id, p.name, !p.active)} className="shrink-0 text-sm font-semibold">
                  {p.active ? 'Tükendi' : 'Satışa aç'}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
