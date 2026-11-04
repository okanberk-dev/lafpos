import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Check, ChefHat, Globe, PackageCheck, Phone, RefreshCw, ShoppingBag, Store, UtensilsCrossed } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { tl } from '@shared/money';
import { fmtAgo, fmtTime } from '@shared/time';
import { isCounterFirst } from '@shared/service-mode';
import type { OrderDTO } from '@shared/types';
import { Button, buttonClass } from '@/components/ui/Button';
import { Select } from '@/components/ui/Field';
import { Badge, type BadgeTone, EmptyState, ErrorState, Notice, PageHeader, Skeleton, Tabs } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { deliverItems } from '@/lib/handoff';
import { orderCardName, readyToHand, stageFromBar } from '@/lib/readyToHand';
import { useServiceMode } from '@/lib/serviceMode';
import { useTick } from '@/lib/hooks';
import { fmtPhone, joinMeta, telHref } from '@/lib/text';
import { toast } from '@/lib/toast';
import { PlatformBadge } from '@/components/PlatformBadge';

type Tab = 'acik' | 'online' | 'paket' | 'kapanan';

type DeliveryStatus = NonNullable<OrderDTO['deliveryStatus']>;

const DELIVERY_FLOW: Record<DeliveryStatus, { next: 'hazir' | 'yolda' | 'teslim'; label: string } | null> = {
  hazirlaniyor: { next: 'hazir', label: 'Hazır' },
  hazir: { next: 'yolda', label: 'Yola çıktı' },
  yolda: { next: 'teslim', label: 'Teslim edildi' },
  teslim: null,
};

/** Sıradaki aşama: gel-al'da yol yok, müşteri tezgâhtan alır (hazırdan doğrudan teslime; platformun aşamalarını sunucu sırayla yazar) */
function flowOf(o: OrderDTO) {
  if (!o.deliveryStatus) return null;
  if (o.type === 'gelal' && o.deliveryStatus === 'hazir') return { next: 'teslim', label: 'Teslim edildi' } as const;
  return DELIVERY_FLOW[o.deliveryStatus];
}

/** Aşama rozeti: bar ekranının dili (hazırlanıyor ve yolda mavi, hazır yeşil, teslim edildi gri) */
const DELIVERY_BADGE: Record<DeliveryStatus, { tone: BadgeTone; label: string }> = {
  hazirlaniyor: { tone: 'blue', label: 'Hazırlanıyor' },
  hazir: { tone: 'green', label: 'Hazır' },
  yolda: { tone: 'blue', label: 'Yolda' },
  teslim: { tone: 'neutral', label: 'Teslim edildi' },
};

export default function OrdersPage() {
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const now = useTick(30_000);
  const mode = useServiceMode();
  // Hazır tezgâh ve gel-al siparişi kasadan da teslim edilir (Geri al bildirimde)
  const canHand = can('mutfak.ekran') || can('siparis.al');
  // Yalnız paket yetkisi olan (kurye) kendi işinde açılır: Açık'taki tezgâh satışlarında yapabileceği bir şey yok
  const [tab, setTab] = useState<Tab>(() => (canHand ? 'acik' : 'paket'));
  const open = useQuery({ queryKey: ['orders', 'acik'], queryFn: () => get<OrderDTO[]>('/orders?status=acik&limit=200'), refetchInterval: 60_000 });
  const closed = useQuery({ queryKey: ['orders', 'kapali'], queryFn: () => get<OrderDTO[]>('/orders?status=kapali&limit=300'), enabled: tab === 'kapanan' });
  // Önce ödenmiş (kapanmış) tezgâh ve gel-al satışı hazır olunca teslim bekler (self servis): Açık'ta da görünür. Sunucu
  // bar ekranının Hazır sekmesinin koşuluyla süzer (`ready=1`: son 30 dakikada hazır, açık günün); yalnız teslim edebilene
  const paidReady = useQuery({
    queryKey: ['orders', 'kapali', 'teslim'],
    queryFn: () => get<OrderDTO[]>('/orders?status=kapali&type=tezgah,gelal&ready=1&limit=200'),
    enabled: canHand,
    refetchInterval: 60_000,
  });
  const refreshOnline = useMutation({
    mutationFn: () => post('/sync/online/refresh'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['orders'] }),
    onError: (e) => toast.err(errorMessage(e)),
  });
  const [handing, setHanding] = useState<string | null>(null);
  const hand = async (o: OrderDTO, ids: string[], name: string) => {
    setHanding(o.id);
    try {
      await deliverItems(ids, name, () => qc.invalidateQueries({ queryKey: ['orders'] }));
    } finally {
      setHanding(null);
    }
  };
  const delivery = async (o: OrderDTO, body: Record<string, unknown>) => {
    try {
      await post(`/orders/${o.id}/delivery`, body);
      qc.invalidateQueries({ queryKey: ['orders'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const all = open.data ?? [];
  // Kapanmış, hazır kalemi teslim bekleyen tezgâh ve gel-al satışı (önce ödenen): en üstte, "Ödendi" rozetiyle. Teslim
  // yetkisi olmayan (kurye) düğmesiz kart görmez
  const awaitingHand = canHand ? (paidReady.data ?? []) : [];
  const openPos = all.filter((o) => o.type !== 'masa' && o.source === 'pos');
  // Liste sorgusu: boş durum yalnız veri gelip boşsa; yüklenirken iskelet, alınamazsa hata (sahte "yok" değil)
  const list = tab === 'kapanan' ? closed : open;
  const rows =
    tab === 'acik'
      ? [...awaitingHand, ...openPos]
      : tab === 'online'
        ? all.filter((o) => o.source === 'laffogato')
        : tab === 'paket'
          ? all.filter((o) => o.type === 'paket' || o.type === 'gelal')
          : (closed.data ?? []);
  const couriers = boot.users.filter((u) => u.active && (u.role === 'kurye' || u.role === 'garson'));
  // Boş durum ekranın sözüyle ve bu kişinin yapabileceğiyle: self modlarda satış Satış ekranından açılır, kurye açmaz.
  // Paket yalnız paket yetkisiyle açılır (Masalar'da düğmesi de yalnız ona; garson yalnız gel-al açar)
  const opens = can('siparis.al');
  const opensPaket = can('paket.yonet');
  const empty =
    tab === 'kapanan'
      ? { title: 'Bugün kapanan adisyon yok', body: 'Ödemesi alınan adisyonlar gün boyunca burada listelenir' }
      : tab === 'online'
        ? { title: 'Açık online sipariş yok', body: 'Uygulama ve web siparişleri hazırlanırken burada görünür' }
        : tab === 'paket'
          ? {
              title: 'Açık paket ya da gel-al siparişi yok',
              body: !opens || isCounterFirst(mode) ? 'Gel-al ve paket siparişleri açılınca burada görünür' : opensPaket ? 'Masalar ekranından gel-al ya da paket açın' : 'Masalar ekranından gel-al açın',
            }
          : {
              title: 'Açık sipariş yok',
              body: !opens
                ? 'Tezgâh, gel-al ve paket siparişleri açılınca burada görünür'
                : isCounterFirst(mode)
                  ? 'Satış ekranından yeni satış açın'
                  : opensPaket
                    ? 'Masalar ekranından tezgâh satışı, gel-al ya da paket açın'
                    : 'Masalar ekranından tezgâh satışı ya da gel-al açın',
            };

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      {/* Telefonda ekranın adını üst şerit yazar: başlık ve açıklama yalnız ekran okuyucuda, sekmeler hemen üstte. Eylem
          yalnız varsa verilir (boş parça eylem sayılır, alt boşluğu tutardı) */}
      <PageHeader
        title="Siparişler"
        subtitle="Tezgâh, gel-al, paket ve sitede verilen online siparişler"
        compactOnPhone
        actions={
          boot.integrations.laffogatoPanel ? (
            <Button icon={<RefreshCw className={cn('size-4', refreshOnline.isPending && 'animate-spin')} />} onClick={() => refreshOnline.mutate()}>
              Online siparişleri yenile
            </Button>
          ) : undefined
        }
      />
      {/* Telefonda ray ekran kenarına taşar: kırpılan sekme kenarda biter (kaydırma işareti), sayfa boşluğunda yarım kalmaz */}
      <Tabs<Tab>
        label="Sipariş listesi"
        className="-mx-4 mb-3 px-4 md:mx-0 md:px-0"
        value={tab}
        onChange={setTab}
        options={[
          { value: 'acik', label: 'Açık', count: awaitingHand.length + openPos.length },
          { value: 'online', label: 'Online', count: all.filter((o) => o.source === 'laffogato').length },
          { value: 'paket', label: 'Paket ve gel-al', count: all.filter((o) => o.type === 'paket' || o.type === 'gelal').length },
          { value: 'kapanan', label: 'Kapanan' },
        ]}
      />
      {tab === 'online' && !boot.integrations.laffogatoPanel && (
        <Notice
          tone="info"
          className="mb-3"
          action={
            can('ayar.yonet') || can('senkron.yonet') ? (
              <Link to="/yonetim/entegrasyon" className={buttonClass('secondary', 'sm')}>
                Bağlantıyı kur
              </Link>
            ) : undefined
          }
        >
          {boot.integrations.laffogatoUrl ? 'Site bağlantı anahtarı tanımlı olmadığı için uygulama ve web siparişleri buraya düşmüyor' : 'Site bağlantısı kurulmadığı için uygulama ve web siparişleri buraya düşmüyor'}
        </Notice>
      )}
      {list.isPending ? (
        <div role="status" aria-label="Siparişler yükleniyor…" className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <ErrorState title={tab === 'kapanan' ? 'Kapanan adisyonlar alınamadı' : 'Siparişler alınamadı'} error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState art="fis" title={empty.title}>
          {empty.body}
        </EmptyState>
      ) : (
        // Tablette dikeyde iki sütun (608 px), dar telefonda taşmaz
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,280px),1fr))] gap-3 animate-fade">
          {rows.map((o) => {
            const Icon = o.source === 'laffogato' ? Globe : o.type === 'paket' ? Bike : o.type === 'gelal' ? ShoppingBag : o.type === 'masa' ? UtensilsCrossed : Store;
            const flow = flowOf(o);
            // Ödeme bekleyen kalem (tezgâh satışında "Öde") bara henüz gitmedi: "barda" sayılmaz, ayrı rozet
            const pendingKitchen = o.items.filter((i) => !i.voided && i.stationId && !i.held && (i.status === 'yeni' || i.status === 'hazirlaniyor')).length;
            const awaitingPay = o.status === 'acik' && o.items.some((i) => i.held && !i.voided);
            const readyIds = canHand ? readyToHand(o) : [];
            // Adet olarak ("2 ürün" yazan kartta "2 hazır")
            const readyQty = o.items.filter((i) => readyIds.includes(i.id)).reduce((a, i) => a + i.qty, 0);
            // Self modlarda kasanın tezgâh ve gel-al siparişinin çağrı numarası ("No 34"; müşteri onunla bekler), adıyla;
            // paket platformunun gel-al'ında platformun kısa kodu (müşteri LafPOS numarasını bilmez, çağrı ekranı gibi)
            const { name, head } = orderCardName(o, mode);
            const paidAhead = o.status === 'kapali' && tab !== 'kapanan';
            const itemCount = o.items.filter((i) => !i.voided).reduce((a, i) => a + i.qty, 0);
            const methods = [...new Set(o.payments.filter((p) => !p.refundedAt).map((p) => p.methodName))];
            const hasBadges = paidAhead || !!o.platform || o.extPaid || o.extStage === 'gone' || awaitingPay || pendingKitchen > 0 || readyIds.length > 0 || !!o.deliveryStatus || methods.length > 0;
            // Kasanın gel-al siparişinde bara kalem gittiyse aşama bardan izlenir (kalemlerin hepsi teslim edilince
            // "Teslim edildi"): elle aşama düğmesi yok, teslim kalemin Teslim edildi düğmesiyle (sunucu da reddeder)
            const stageButton = flow && !stageFromBar(o);
            const courierPick = o.type === 'paket' && couriers.length > 0;
            return (
              // Kaynak rengi: POS gri, online mor (Masalar yan paneliyle aynı); kalın tutar yalnız dolu adisyonda
              <div key={o.id} className="flex flex-col rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)] p-3.5 transition-[border-color] duration-150 hover:border-[var(--admin-border-field)]">
                {/* Kartın dokunulan yüzü: basılı ton dokunmatikte de geri bildirir (kenar payı içeriği yerinde tutar) */}
                <button onClick={() => navigate(`/adisyon/${o.id}`)} className="-m-1.5 flex items-start gap-3 rounded-xl p-1.5 text-left transition-colors duration-150 hover:bg-hover active:bg-press">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', o.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
                    <Icon />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold">
                      {name}
                      {!head && <span className="tabular font-normal text-muted"> #{o.extNo ?? o.no}</span>}
                    </span>
                    {/* Açıkta geçen süre (açılış saati ipucunda), kapananda kapanış saati; boş parça düşer */}
                    <span className="block text-[13px] text-muted" title={`Açılış ${fmtTime(o.openedAt)}`}>
                      {joinMeta([itemCount > 0 && `${itemCount} ürün`, o.status === 'acik' ? fmtAgo(o.openedAt, now) : o.closedAt && `kapanış ${fmtTime(o.closedAt)}`])}
                    </span>
                  </span>
                  {itemCount === 0 ? (
                    <span className="text-[13px] leading-6 text-muted">Boş</span>
                  ) : (
                    <span className="tabular text-right font-semibold">
                      {tl(o.extPaid ? (o.extTotal ?? 0) : o.total)}
                      {o.paid > 0 && o.paid < o.total && <span className="block text-xs font-medium text-[var(--admin-hue-rose)]">{tl(o.total - o.paid)} kaldı</span>}
                    </span>
                  )}
                </button>
                {hasBadges && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {paidAhead && <Badge tone="green">Ödendi</Badge>}
                    {o.platform && <PlatformBadge platform={o.platform} code={o.platformCode} />}
                    {o.extPaid && <Badge tone="violet">Sitede ödendi</Badge>}
                    {o.extStage === 'gone' && <Badge>Siteden kalktı</Badge>}
                    {awaitingPay && <Badge tone="warn">Ödeme bekliyor</Badge>}
                    {pendingKitchen > 0 && (
                      <Badge>
                        <ChefHat aria-hidden="true" className="size-3" />
                        {pendingKitchen} barda
                      </Badge>
                    )}
                    {/* Gel-al'ın aşama rozeti zaten "Hazır" diyorsa sayı yinelenmez */}
                    {readyIds.length > 0 && o.deliveryStatus !== 'hazir' && (
                      <Badge tone="green">
                        <Check aria-hidden="true" className="size-3" />
                        {readyQty} hazır
                      </Badge>
                    )}
                    {o.deliveryStatus && (
                      <Badge tone={DELIVERY_BADGE[o.deliveryStatus].tone}>
                        {o.deliveryStatus === 'hazir' && <Check aria-hidden="true" className="size-3" />}
                        {DELIVERY_BADGE[o.deliveryStatus].label}
                      </Badge>
                    )}
                    {methods.length > 0 && <Badge>{methods.join(', ')}</Badge>}
                  </div>
                )}
                {(o.deliveryAddress || o.deliveryPhone) && (
                  <div className="mt-2 rounded-xl bg-surface-2 p-2.5 text-sm">
                    {o.deliveryPhone && (
                      <a href={telHref(o.deliveryPhone)} className="flex min-h-11 items-center gap-1.5 font-medium text-primary pointer-fine:min-h-0">
                        <Phone className="size-3.5" /> {fmtPhone(o.deliveryPhone)}
                      </a>
                    )}
                    {o.deliveryAddress && <div className="mt-1 text-ink-2">{o.deliveryAddress}</div>}
                  </div>
                )}
                {readyIds.length > 0 && (
                  <Button variant="primary" className="mt-3" icon={<PackageCheck className="size-4" />} loading={handing === o.id} onClick={() => void hand(o, readyIds, head ? name : `${name} #${o.no}`)}>
                    Teslim edildi
                  </Button>
                )}
                {o.status === 'acik' && (o.type === 'paket' || o.type === 'gelal') && (can('paket.yonet') || can('siparis.al')) && (courierPick || stageButton) && (
                  <div className="mt-3 flex gap-2">
                    {courierPick && (
                      <Select value={o.courierId ?? ''} onChange={(e) => delivery(o, { courierId: e.target.value || null })} aria-label="Kurye" className="min-w-0 flex-1">
                        <option value="">Kurye seç</option>
                        {couriers.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </Select>
                    )}
                    {/* Kurye seçimi yoksa aşama düğmesi satırı doldurur (Teslim edildi düğmesi gibi) */}
                    {stageButton && (
                      <Button variant="primary" className={cn(!courierPick && 'flex-1')} onClick={() => delivery(o, { deliveryStatus: flow.next })}>
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
