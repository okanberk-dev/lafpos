import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Globe, PackageCheck, Phone, RefreshCw, ShoppingBag, Store, UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { numaratorLabel } from '@shared/service-mode';
import { tl } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { Badge, EmptyState, PageHeader, PageLoading, Tabs } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { PlatformBadge } from '@/components/PlatformBadge';

type Tab = 'acik' | 'online' | 'paket' | 'kapanan';

const DELIVERY_FLOW: Record<string, { next: 'hazir' | 'yolda' | 'teslim'; label: string } | null> = {
  hazirlaniyor: { next: 'hazir', label: 'Hazır' },
  hazir: { next: 'yolda', label: 'Yola çıktı' },
  yolda: { next: 'teslim', label: 'Teslim edildi' },
  teslim: null,
};

export default function OrdersPage() {
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useTick(30_000);
  const [tab, setTab] = useState<Tab>('acik');
  const open = useQuery({ queryKey: ['orders', 'acik'], queryFn: () => get<OrderDTO[]>('/orders?status=acik&limit=200'), refetchInterval: 60_000 });
  const closed = useQuery({ queryKey: ['orders', 'kapali'], queryFn: () => get<OrderDTO[]>('/orders?status=kapali&limit=300'), enabled: tab === 'kapanan' });
  const refreshOnline = useMutation({
    mutationFn: () => post('/sync/online/refresh'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
    onError: (e) => toast.err(errorMessage(e)),
  });
  const delivery = async (o: OrderDTO, body: Record<string, unknown>) => {
    try {
      await post(`/orders/${o.id}/delivery`, body);
      qc.invalidateQueries({ queryKey: ['orders'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  if (open.isLoading) return <PageLoading />;
  const all = open.data ?? [];
  const rows =
    tab === 'acik'
      ? all.filter((o) => o.type !== 'masa' && o.source === 'pos')
      : tab === 'online'
        ? all.filter((o) => o.source === 'laffogato')
        : tab === 'paket'
          ? all.filter((o) => o.type === 'paket' || o.type === 'gelal')
          : (closed.data ?? []);
  const couriers = boot.users.filter((u) => u.active && (u.role === 'kurye' || u.role === 'garson'));

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <PageHeader
        title="Siparişler"
        subtitle="Tezgâh, gel-al, paket ve sitede verilen online siparişler"
        actions={
          <>
            {boot.integrations.laffogatoPanel && (
              <Button icon={<RefreshCw className={cn('size-4', refreshOnline.isPending && 'animate-spin')} />} onClick={() => refreshOnline.mutate()}>
                Online siparişleri yenile
              </Button>
            )}
          </>
        }
      />
      <Tabs<Tab>
        label="Sipariş listesi"
        className="mb-3"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'acik', label: 'Açık', count: all.filter((o) => o.type !== 'masa' && o.source === 'pos').length },
          { value: 'online', label: 'Online', count: all.filter((o) => o.source === 'laffogato').length },
          { value: 'paket', label: 'Paket ve gel-al', count: all.filter((o) => o.type === 'paket' || o.type === 'gelal').length },
          { value: 'kapanan', label: 'Kapanan' },
        ]}
      />
      {tab === 'online' && !boot.integrations.laffogatoPanel && (
        <div className="mb-3 flex flex-col gap-2 rounded-2xl border border-dashed border-line-strong p-4 text-sm text-muted sm:flex-row sm:items-center">
          <span className="flex-1 text-pretty">
            {boot.integrations.laffogatoUrl ? 'Site bağlantı anahtarı tanımlı olmadığı için uygulama ve web siparişleri buraya düşmüyor' : 'Site bağlantısı kurulmadığı için uygulama ve web siparişleri buraya düşmüyor'}
          </span>
          {can('ayar.yonet') || can('senkron.yonet') ? (
            <Link to="/yonetim/entegrasyon" className="inline-flex min-h-11 items-center font-medium text-primary hover:underline pointer-fine:min-h-0">
              Site ve lafmaliyet
            </Link>
          ) : null}
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState icon={<PackageCheck />} title={tab === 'kapanan' ? 'Bugün kapanan adisyon yok' : tab === 'online' ? 'Açık online sipariş yok' : tab === 'paket' ? 'Açık paket ya da gel-al siparişi yok' : 'Açık tezgâh siparişi yok'}>
          {tab === 'online' ? 'Uygulama ve web siparişleri hazırlanırken burada görünür' : tab === 'kapanan' ? 'Bugün kapanan adisyonlar burada listelenir' : 'Masalar ekranından tezgâh satışı, gel-al ya da paket açın'}
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3 animate-fade">
          {rows.map((o) => {
            const Icon = o.source === 'laffogato' ? Globe : o.type === 'paket' ? Bike : o.type === 'gelal' ? ShoppingBag : o.type === 'masa' ? UtensilsCrossed : Store;
            const flow = o.deliveryStatus ? DELIVERY_FLOW[o.deliveryStatus] : null;
            const pendingKitchen = o.items.filter((i) => !i.voided && i.stationId && (i.status === 'yeni' || i.status === 'hazirlaniyor')).length;
            const itemCount = o.items.filter((i) => !i.voided).reduce((a, i) => a + i.qty, 0);
            const methods = [...new Set(o.payments.filter((p) => !p.refundedAt).map((p) => p.methodName))];
            const hasBadges = !!o.platform || o.extPaid || o.extStage === 'gone' || pendingKitchen > 0 || !!o.deliveryStatus || methods.length > 0;
            return (
              // Kaynak rengi: POS gri, online mor (Masalar yan paneliyle aynı); kalın tutar yalnız dolu adisyonda
              <div key={o.id} className="flex flex-col rounded-2xl border border-line bg-surface p-3.5 transition-[border-color] hover:border-[var(--admin-border-field)]">
                <button onClick={() => navigate(`/adisyon/${o.id}`)} className="flex items-start gap-3 rounded-lg text-left">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', o.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
                    <Icon strokeWidth={1.75} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {o.tableName ?? o.extLabel ?? o.deliveryName ?? (o.numarator ? numaratorLabel(o.numarator) : ORDER_TYPE_LABEL[o.type])}{' '}
                      <span className="tabular font-normal text-muted">#{o.extNo ?? o.no}</span>
                    </span>
                    <span className="block text-[13px] text-muted">
                      {fmtTime(o.openedAt)} · {o.status === 'acik' ? fmtElapsed(o.openedAt, now) : 'kapandı'} · {itemCount} ürün
                    </span>
                  </span>
                  {itemCount === 0 ? (
                    <span className="text-xs text-muted">Boş</span>
                  ) : (
                    <span className="tabular text-right font-semibold">
                      {tl(o.extPaid ? (o.extTotal ?? 0) : o.total)}
                      {o.paid > 0 && o.paid < o.total && <span className="block text-xs font-medium text-[var(--admin-hue-rose)]">{tl(o.total - o.paid)} kaldı</span>}
                    </span>
                  )}
                </button>
                {hasBadges && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {o.platform && <PlatformBadge platform={o.platform} code={o.platformCode} />}
                    {o.extPaid && <Badge tone="violet">Sitede ödendi</Badge>}
                    {o.extStage === 'gone' && <Badge>Siteden kalktı</Badge>}
                    {pendingKitchen > 0 && <Badge tone="warn">{pendingKitchen} hazırlanıyor</Badge>}
                    {o.deliveryStatus && <Badge tone={o.deliveryStatus === 'teslim' ? 'green' : 'blue'}>{{ hazirlaniyor: 'Hazırlanıyor', hazir: 'Hazır', yolda: 'Yolda', teslim: 'Teslim edildi' }[o.deliveryStatus]}</Badge>}
                    {methods.length > 0 && <Badge>{methods.join(', ')}</Badge>}
                  </div>
                )}
                {(o.deliveryAddress || o.deliveryPhone) && (
                  <div className="mt-2 rounded-xl bg-surface-2 p-2.5 text-sm">
                    {o.deliveryPhone && (
                      <a href={`tel:${o.deliveryPhone}`} className="flex items-center gap-1.5 font-medium text-brand-600">
                        <Phone className="size-3.5" /> {o.deliveryPhone}
                      </a>
                    )}
                    {o.deliveryAddress && <div className="mt-1 text-ink-2">{o.deliveryAddress}</div>}
                  </div>
                )}
                {o.status === 'acik' && (o.type === 'paket' || o.type === 'gelal') && (can('paket.yonet') || can('siparis.al')) && (
                  <div className="mt-3 flex gap-2">
                    {o.type === 'paket' && couriers.length > 0 && (
                      <Select value={o.courierId ?? ''} onChange={(e) => delivery(o, { courierId: e.target.value || null })} aria-label="Kurye" className="h-10 min-w-0 flex-1 text-sm pointer-coarse:h-11">
                        <option value="">Kurye seç</option>
                        {couriers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    )}
                    {flow && (
                      <Button size="sm" variant="primary" className="h-10" onClick={() => delivery(o, { deliveryStatus: flow.next })}>
                        {flow.label}
                      </Button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
