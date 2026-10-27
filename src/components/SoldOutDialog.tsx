import { useQueryClient } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { errorMessage, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { fold } from '@/lib/shell';
import { toast } from '@/lib/toast';
import { Modal } from './ui/Modal';

/**
 * Kasadan ve bardan "tükendi" (ModPOS "Ürünü Satışa Kapatma" yetkisi gibi, `urun.tukendi`). Siteden gelen ürün
 * sitede ve uygulamada da tükenir; tükenenler listenin başında. Sitenin kapattığı ürünü ("Sitede satışta değil")
 * yalnız menü yetkisi olan açar: kasiyerde düğmesi yok, sunucu da reddeder.
 */
export function SoldOutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const boot = useBoot();
  const can = useCan();
  const manager = can('menu.yonet');
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return boot.products
      .filter((p) => !p.hidden && !p.isService && (!k || fold(p.name).includes(k)))
      .sort((a, b) => Number(a.active) - Number(b.active) || a.name.localeCompare(b.name, 'tr'));
  }, [boot.products, q]);

  const set = async (id: string, name: string, active: boolean) => {
    setBusy(id);
    try {
      const r = await post<{ site: string }>(`/sync/products/${id}/availability`, { active });
      toast.ok(`${name} ${active ? 'satışa açıldı' : 'tükendi'}${r.site === 'guncellendi' ? '; site ve uygulama da güncellendi' : ''}`);
      await qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Tükenen ürünler" subtitle={`${boot.products.filter((p) => !p.active && !p.hidden).length} ürün tükendi`} size="md">
      <div className="sticky top-0 z-10 border-b border-line bg-surface p-3">
        <label className="relative block">
          <span className="sr-only">Ürün ara</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Ürün ara" className="h-11 w-full rounded-xl border border-line-strong bg-surface pl-9 pr-3 text-[15px]" />
        </label>
      </div>
      <ul className="divide-y divide-line">
        {rows.map((p) => {
          const siteClosed = !p.active && p.soldOutBy === 'site';
          return (
            <li key={p.id} className="flex min-h-14 items-center gap-3 px-4 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                {!p.active && <span className="text-xs font-semibold text-danger-500">{siteClosed ? 'Sitede satışta değil' : 'Tükendi'}</span>}
              </span>
              {siteClosed && !manager ? (
                <span className="shrink-0 text-xs text-muted">Yönetici açar</span>
              ) : (
                <button
                  type="button"
                  disabled={busy === p.id}
                  onClick={() => set(p.id, p.name, !p.active)}
                  className={cn('h-11 shrink-0 rounded-xl px-4 text-sm font-semibold disabled:opacity-50', p.active ? 'border border-danger-200 text-[var(--admin-danger-ink)] hover:bg-[var(--admin-danger-soft)]' : 'bg-primary text-primary-ink hover:bg-[var(--admin-primary-hover)]')}
                >
                  {p.active ? 'Tükendi' : 'Satışa aç'}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}
