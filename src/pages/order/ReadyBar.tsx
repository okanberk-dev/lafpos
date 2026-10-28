import { useQueryClient } from '@tanstack/react-query';
import { Check, PackageCheck } from 'lucide-react';
import { useState } from 'react';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { deliverItems, readyToHand } from '@/lib/handoff';

/**
 * Hazır tezgâh ya da gel-al siparişi (kapanmış self servis satışı da): kasada "Teslim edildi". Çağrı ekranından ve bar
 * ekranının Hazır sekmesinden düşer; bildirimde "Geri al". Yeşil hazır dili bar ekranıyla aynı.
 */
export function ReadyBar({ order, name }: { order: OrderDTO; name: string }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const ids = readyToHand(order);
  if (!ids.length) return null;
  const qty = order.items.filter((i) => ids.includes(i.id)).reduce((a, i) => a + i.qty, 0);
  const hand = async () => {
    setBusy(true);
    try {
      await deliverItems(ids, name, () => qc.invalidateQueries({ queryKey: ['order', order.id] }));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex items-center gap-3 border-b border-[var(--admin-success-line)] bg-[var(--admin-success-soft)] px-4 py-2.5">
      <Check aria-hidden="true" className="size-4 shrink-0 text-[var(--admin-success)]" />
      <span className="min-w-0 flex-1 text-sm font-semibold text-[var(--admin-success)]">{qty} ürün hazır</span>
      <Button size="sm" variant="primary" icon={<PackageCheck className="size-4" />} loading={busy} onClick={() => void hand()}>
        Teslim edildi
      </Button>
    </div>
  );
}
