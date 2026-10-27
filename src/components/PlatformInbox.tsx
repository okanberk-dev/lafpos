import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Bike, PackageCheck, TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import { tl } from '@shared/money';
import { COURIER_LABEL, PLATFORM_LABEL, type PlatformLiveStatus, type PlatformOrderDTO, type PlatformSettings, type PlatformId, REJECT_REASONS } from '@shared/platforms';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { beep } from '@/lib/sound';
import { toast } from '@/lib/toast';
import { PlatformBadge } from './PlatformBadge';

export interface PlatformsData {
  settings: Record<PlatformId, PlatformSettings>;
  orders: PlatformOrderDTO[];
  /** Canlı bağlantı durumu (eski sunucu göndermez) */
  live?: Record<PlatformId, PlatformLiveStatus>;
}

export function usePlatforms(enabled = true) {
  return useQuery({ queryKey: ['platforms'], queryFn: () => get<PlatformsData>('/platforms'), enabled, refetchInterval: 30_000 });
}

const left = (expiresAt: number | null, now: number) => {
  if (expiresAt == null) return null;
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/**
 * Paket platformlarından onay bekleyen siparişler: her ekranın üstünde şerit, dokununca kabul / ret. Platformun kabul
 * süresi geri sayılır (Getir 5 dk, Yemeksepeti ~15 dk); süre dolunca sipariş platformda iptal olur.
 */
export function PlatformInbox() {
  const can = useCan();
  const allowed = can('paket.yonet');
  const data = usePlatforms(allowed);
  const [open, setOpen] = useState(false);
  const now = useTick(1000);

  useEffect(() => {
    if (!allowed) return;
    return onLive((e) => {
      if (e.topic === 'delivery' && e.kind === 'platform.new') {
        beep('yeni');
        if (e.message) toast.info(e.message);
      }
    });
  }, [allowed]);

  const pending = (data.data?.orders ?? []).filter((o) => o.status === 'bekliyor');
  if (!allowed || !pending.length) return null;
  const first = pending[0];
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex min-h-11 w-full shrink-0 items-center gap-2 border-b border-[var(--admin-warning)]/30 bg-[var(--admin-warning-soft)] px-4 py-1.5 text-left text-sm text-[var(--admin-warning)]"
      >
        <Bell className="size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate font-medium">
          {pending.length === 1 ? 'Platform siparişi onay bekliyor' : `${pending.length} platform siparişi onay bekliyor`}
          <span className="font-normal max-sm:hidden">
            {' '}
            · {PLATFORM_LABEL[first.platform]} {first.payload.code} · {tl(first.payload.customerTotal)}
          </span>
        </span>
        {first.expiresAt && <span className="tabular shrink-0 font-semibold">{left(first.expiresAt, now)}</span>}
        <span className="shrink-0 font-semibold underline underline-offset-2">Gör</span>
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Onay bekleyen platform siparişleri" size="md">
        <div className="space-y-3 p-4">
          {pending.map((o) => (
            <PendingCard key={o.id} order={o} now={now} defaultPrep={data.data?.settings[o.platform].prepMinutes ?? 20} onDone={() => pending.length === 1 && setOpen(false)} />
          ))}
        </div>
      </Modal>
    </>
  );
}

function PendingCard({ order, now, defaultPrep, onDone }: { order: PlatformOrderDTO; now: number; defaultPrep: number; onDone: () => void }) {
  const qc = useQueryClient();
  const [prep, setPrep] = useState(defaultPrep);
  const [rejecting, setRejecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = order.payload;
  const preps = [...new Set([10, 15, 20, 30, 45, defaultPrep])].sort((a, b) => a - b);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast.ok(ok);
      onDone();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
      qc.invalidateQueries({ queryKey: ['platforms'] });
      qc.invalidateQueries({ queryKey: ['orders'] });
    }
  };
  const remaining = left(order.expiresAt, now);
  return (
    <section className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-center gap-2">
        <PlatformBadge platform={order.platform} code={p.code} />
        <span className="text-sm text-muted">
          {p.courier === 'platform' ? <Bike className="mr-1 inline size-4" /> : <PackageCheck className="mr-1 inline size-4" />}
          {COURIER_LABEL[p.courier]} · {p.paymentLabel}
        </span>
        <span className="flex-1" />
        {remaining && <span className={cn('tabular text-sm font-semibold', (order.expiresAt ?? 0) - now < 60_000 ? 'text-[var(--admin-danger-ink)]' : 'text-ink-2')}>{remaining}</span>}
      </div>
      <ul className="mt-2 space-y-1 text-sm">
        {p.lines.map((l, i) => (
          <li key={i} className="flex gap-2">
            <span className="tabular w-7 shrink-0 font-semibold">{l.qty}×</span>
            <span className="min-w-0 flex-1">
              {l.name}
              {(l.modifiers.length > 0 || l.note) && <span className="block text-xs text-muted">{[...l.modifiers, l.note].filter(Boolean).join(' · ')}</span>}
            </span>
            <span className="tabular shrink-0 text-ink-2">{tl(l.unitPrice * l.qty)}</span>
          </li>
        ))}
      </ul>
      <div className="mt-2 space-y-0.5 border-t border-line pt-2 text-sm">
        {p.restaurantDiscount > 0 && <Row l="Kampanya (bizden)" r={`−${tl(p.restaurantDiscount)}`} />}
        {p.platformDiscount > 0 && <Row l="Kampanya (platformdan)" r={`−${tl(p.platformDiscount)}`} />}
        <Row l="Müşteri öder" r={tl(p.customerTotal)} strong />
      </div>
      {(p.customer.name || p.note || p.customer.address) && (
        <p className="mt-2 text-xs text-muted">{[p.customer.name, p.customer.address, p.customer.phone, p.note].filter(Boolean).join(' · ')}</p>
      )}
      {order.unmatched.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[var(--admin-warning-soft)] p-2 text-xs text-[var(--admin-warning)]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          Kasada karşılığı olmayan: {order.unmatched.join(', ')}. Kabulde "Platform ürünü" satırı olur, adı notta yazar
        </p>
      )}
      {order.soldOut.length > 0 && (
        <p className="mt-2 flex items-start gap-1.5 rounded-lg bg-[var(--admin-danger-soft)] p-2 text-xs text-[var(--admin-danger-ink)]">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          Kasada tükenmiş: {order.soldOut.join(', ')}. Ürünü satışa açın ya da "Ürün tükendi" ile reddedin
        </p>
      )}
      {rejecting ? (
        <div className="mt-3 space-y-2">
          <p className="text-sm font-medium">Neden reddediyorsunuz?</p>
          <div className="flex flex-wrap gap-1.5">
            {REJECT_REASONS.map((r) => (
              <Button key={r} size="sm" disabled={busy} onClick={() => run(() => post(`/platforms/orders/${order.id}/reject`, { reason: r }), 'Sipariş reddedildi')}>
                {r}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="ghost" onClick={() => setRejecting(false)}>
            Vazgeç
          </Button>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Hazırlık süresi">
            <span className="mr-1 text-sm text-muted">Hazırlık</span>
            {preps.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setPrep(m)}
                aria-pressed={prep === m}
                className={cn('min-h-11 rounded-lg border px-3 text-sm pointer-fine:min-h-9', prep === m ? 'border-ink font-semibold' : 'border-line text-ink-2')}
              >
                {m} dk
              </button>
            ))}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Button disabled={busy} onClick={() => setRejecting(true)}>
              Reddet
            </Button>
            <Button variant="primary" loading={busy} onClick={() => run(() => post(`/platforms/orders/${order.id}/accept`, { prepMinutes: prep }), `${PLATFORM_LABEL[order.platform]} ${p.code} kabul edildi`)}>
              Kabul et · {prep} dk
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

function Row({ l, r, strong }: { l: string; r: string; strong?: boolean }) {
  return (
    <div className={cn('flex justify-between', strong && 'font-semibold')}>
      <span>{l}</span>
      <span className="tabular">{r}</span>
    </div>
  );
}
