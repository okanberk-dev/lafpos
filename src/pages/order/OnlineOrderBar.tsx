import { Bike, CalendarClock, ChefHat, Globe, PackageCheck, UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { post } from '@/lib/api';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;

const FULFILL = { table: { label: 'Masaya', icon: UtensilsCrossed }, pickup: { label: 'Gel-al', icon: PackageCheck }, delivery: { label: 'Kurye', icon: Bike } };

/** Sitede ödenmiş online sipariş: yalnız aşama değişir, tahsilat yok. "Sitede ödendi" yalnız burada (başlıkta yinelenmez) */
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
    // Online her ekranda mor (Siparişler'deki "Sitede ödendi" rozetiyle aynı); pembe masa planında "kısmen ödendi" demek.
    // Kenar öteki durum şeritleri (hazır, gönderilmedi) gibi kendi çizgi belirteci
    <div className="border-b border-violet-line bg-violet-soft px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <Globe aria-hidden="true" className="size-4 text-violet-ink" />
        <span className="font-semibold text-violet-ink">
          Sitede ödendi · <span className="tabular">{tl(order.extTotal ?? 0)}</span>
        </span>
        <span className="flex-1" />
        <span className="inline-flex items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 text-ink-2">
            <f.icon aria-hidden="true" className="size-3.5" /> {f.label}
          </span>
          {/* Planlı saat zamandır: amber (bar ekranındaki planlı saatle aynı dil) */}
          {order.scheduledFor && (
            <span className="tabular inline-flex items-center gap-1 font-medium text-warning-ink">
              <CalendarClock aria-hidden="true" className="size-3.5" />
              {fmtTime(Date.parse(order.scheduledFor))}
            </span>
          )}
        </span>
      </div>
      {order.status === 'acik' && (
        <div className="mt-2 flex flex-wrap gap-2">
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
      <p className="mt-1.5 text-xs text-muted">LafPOS’ta tahsil edilmez, Z’ye girmez</p>
    </div>
  );
}
