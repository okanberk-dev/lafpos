import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Store } from 'lucide-react';
import { useState } from 'react';
import { chooseShop, REMOTE, remoteShopsQuery, storedShop } from '@/lib/remote';

/**
 * Uzaktan görünümün dükkân seçicisi (Merkez'e bağlı birden çok kasa): üst çubukta, yalnız birden çok dükkân veri
 * gönderiyorsa. Seçim tarayıcıda saklanır; değişince bütün sorgular seçili dükkândan yeniden okunur. Tek dükkânda hiçbir
 * şey çizilmez (sade kabuk)
 */
export function RemoteShopPicker() {
  const qc = useQueryClient();
  const q = useQuery({ ...remoteShopsQuery, enabled: REMOTE });
  const [value, setValue] = useState(() => storedShop() ?? '');
  const shops = q.data ?? [];
  if (shops.length < 2) return null;
  const current = shops.some((s) => s.id === value) ? value : '';
  return (
    <label className="relative inline-flex min-h-11 items-center pointer-fine:min-h-9">
      <span className="sr-only">Dükkân</span>
      <Store aria-hidden="true" className="pointer-events-none absolute left-2.5 size-4 text-muted" />
      <select
        value={current}
        onChange={(e) => {
          const id = e.target.value || null;
          setValue(e.target.value);
          chooseShop(id);
          void qc.invalidateQueries({ predicate: (x) => x.queryKey[0] !== 'uzaktan' || x.queryKey[1] !== 'dukkanlar' });
        }}
        className="h-11 max-w-[11rem] appearance-none truncate rounded-[var(--r-control)] border border-line bg-surface pl-8 pr-3 text-sm font-medium text-ink pointer-fine:h-9"
      >
        <option value="">Son veri gelen</option>
        {shops.map((s) => (
          <option key={s.id} value={s.id}>
            {s.ad || `Dükkân ${s.id.slice(0, 4)}`}
          </option>
        ))}
      </select>
    </label>
  );
}
