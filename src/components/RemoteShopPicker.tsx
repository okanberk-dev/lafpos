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
    <label className="relative inline-flex min-h-11 items-center">
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
        // Üst çubuğun öteki düğmeleri gibi zeminde beyaz hap (44 px); açılan liste Keel'in yüzen yüzeyi (.k-select)
        className="k-select select-arrow h-11 max-w-[12rem] truncate rounded-[var(--r-segment)] border-0 bg-[var(--k-tab-bg)] bg-[length:16px] bg-[right_10px_center] bg-no-repeat pl-8 pr-8 text-sm font-medium text-ink"
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
