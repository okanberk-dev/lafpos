import { Bike, ChefHat, Globe, PackageCheck, UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { post } from '@/lib/api';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;

const FULFILL = { table: { label: 'Masaya', icon: UtensilsCrossed }, pickup: { label: 'Gel-al', icon: PackageCheck }, delivery: { label: 'Kurye', icon: Bike } };

/** Sitede ödenmiş online sipariş: yalnız aşama değişir, tahsilat yok. */
export function OnlineOrderBar({ order, act }: { order: OrderDTO; act: Act }) {
  const [busy, setBusy] = useState<string | null>(null);
  const f = FULFILL[order.extFulfillment ?? 'pickup'];
  const stage = order.extStage;
  const run = async (action: 'preparing' | 'ready' | 'delivered', ok: string) => {
    setBusy(action);
    await act(() => post(`/sync/online/${order.id}/stage`, { action }), ok);
    setBusy(null);
  };
  const readyLabel = order.extFulfillment === 'table' ? 'Masaya götürüldü' : order.extFulfillment === 'delivery' ? 'Kuryeye verildi' : 'Hazır';
  return (
    <div className="border-b border-line bg-rose-50 px-4 py-3 dark:bg-rose-700/15">
      <div className="flex items-center gap-2 text-sm">
        <Globe className="size-4 text-rose-700" />
        <span className="font-semibold text-rose-700">Sitede ödendi · {tl(order.extTotal ?? 0)}</span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-1 text-xs text-ink-2">
          <f.icon className="size-3.5" /> {f.label}
          {order.scheduledFor && ` · ${new Date(order.scheduledFor).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`}
        </span>
      </div>
      {order.status === 'acik' && (
        <div className="mt-2 flex gap-2">
          {stage === 'new' && (
            <Button size="sm" icon={<ChefHat className="size-4" />} loading={busy === 'preparing'} onClick={() => run('preparing', 'Hazırlanıyor')}>
              Hazırlanıyor
            </Button>
          )}
          {(stage === 'new' || stage === 'preparing') && (
            <Button size="sm" variant="primary" loading={busy === 'ready'} onClick={() => run('ready', readyLabel)}>
              {readyLabel}
            </Button>
          )}
          {stage === 'ready' && order.extFulfillment === 'pickup' && (
            <Button size="sm" variant="primary" loading={busy === 'delivered'} onClick={() => run('delivered', 'Teslim edildi')}>
              Teslim edildi
            </Button>
          )}
        </div>
      )}
      {order.status === 'kapali' && stage === 'gone' && (
        <p className="mt-2 text-sm font-medium text-ink-2">Siteden kalktı: sitede tamamlandı, iptal edildi ya da süresi geçti</p>
      )}
      <p className="mt-1.5 text-xs text-muted">Bu sipariş LafPOS'ta tahsil edilmez ve Z'ye girmez; ödeme sitede alındı</p>
    </div>
  );
}
