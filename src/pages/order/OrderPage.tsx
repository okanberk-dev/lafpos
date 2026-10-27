import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CircleDollarSign,
  Droplets,
  Gift,
  Globe,
  HandCoins,
  Merge,
  MonitorUp,
  MoreVertical,
  PackageX,
  Percent,
  Printer,
  RotateCcw,
  Send,
  Split,
  StickyNote,
  TableProperties,
  Trash2,
  UserRound,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { COMP_CLOSE_LABEL, COMP_CONFIRM_LABEL, COMP_DONE_TOAST, COMP_HINT, COMP_KINDS, compCloseSubtitle, compReasonsOf } from '@shared/comp';
import { tl } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import type { CompKind, OrderDTO, ProductDTO, Size } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Toggle } from '@/components/ui/Field';
import { Badge, PageLoading } from '@/components/ui/misc';
import { errorMessage, patch, post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { type PendingLine, useCart, usePending } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { previewTotals } from '@/lib/estimate';
import { useMediaQuery, useTick } from '@/lib/hooks';
import { BillReceipt, printNow } from '@/lib/print';
import { toast } from '@/lib/toast';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { sendDisplay, useCustomerDisplay, useDisplayCode } from '@/lib/display';
import { CartPanel } from './CartPanel';
import { CustomerModal } from './CustomerModal';
import { OnlineOrderBar } from './OnlineOrderBar';
import { OptionsModal } from './OptionsModal';
import { PaymentModal } from './PaymentModal';
import { ProductPanel } from './ProductPanel';
import { GuestsModal, MoveModal, OrderDiscountModal, ReasonModal, TransferModal } from './TableOps';
import { useOrder } from './useOrder';
import { REMOTE } from '@/lib/remote';
import { openCounterSale } from '@/lib/counter';
import { asksNumarator, callFor, callText, numaratorLabel } from '@shared/service-mode';
import { useServiceMode } from '@/lib/serviceMode';
import { NumaratorModal } from './NumaratorModal';
import { appUrl } from '@/lib/demo';
import { PlatformBadge } from '@/components/PlatformBadge';
import { RoomBox } from './RoomBox';

type Dialog = null | 'tukendi' | 'menu' | 'ekran' | 'odeme' | 'tasi' | 'bol' | 'indirim' | 'kisi' | 'iptal' | CompKind | 'yenidenac' | 'not' | 'musteri' | 'cikis' | 'numarator';

/** İşlemler menüsündeki ciro dışı kapanış ikonları (ödeme ekranıyla aynı) */
const COMP_ICON: Record<CompKind, React.ReactNode> = { ikram: <Gift className="size-5" />, odenmez: <HandCoins className="size-5" />, zayi: <Droplets className="size-5" /> };

export default function OrderPage() {
  const { id = '' } = useParams();
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Tablet dikeyde de ürünler ve adisyon yan yana (impeccable adapt: tablette liste + ayrıntı)
  const wide = useMediaQuery('(min-width: 768px)');
  const now = useTick(30_000);
  const { order, isLoading, isError, act } = useOrder(id);
  const pending = usePending(id);
  const cart = useCart();
  const [tab, setTab] = useState<'menu' | 'adisyon'>(REMOTE ? 'adisyon' : 'menu');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [options, setOptions] = useState<{ product: ProductDTO; size: Size; editing: PendingLine | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [noteText, setNoteText] = useState('');
  const mode = useServiceMode();
  // Yarı self servis: masa no / numaratör bir kez sorulur; "Numarasız devam" denen adisyonda yeniden sorulmaz
  const numaratorAsked = useRef(new Set<string>());
  // Gönderim akışı tek seferlik: masa no kaydedilirken ya da kalemler giderken ikinci basış kalemi yinelemez
  const flowBusy = useRef(false);
  const [afterNumarator, setAfterNumarator] = useState<null | 'send' | 'pay'>(null);

  const table = useMemo(() => boot.tables.find((t) => t.id === order?.tableId), [boot.tables, order?.tableId]);
  const pendingCount = pending.reduce((a, l) => a + l.qty, 0);
  // Müşteri ekranı (bu cihaz yansıtıyorsa): kalemler ve gönderilmemişler dahil tahmini tutar
  const [displayCode, setDisplayCode] = useDisplayCode();
  const call = order ? callFor(order, mode) : null;
  const displayLabel = order ? (table?.name ?? (call ? callText(call) : ORDER_TYPE_LABEL[order.type])) : '';
  useCustomerDisplay(boot, order, pending, displayLabel);

  if (isLoading) return <PageLoading />;
  if (isError || !order) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-semibold">Adisyon bulunamadı</p>
          <Button className="mt-4" onClick={() => navigate('/')}>
            Ana ekrana dön
          </Button>
        </div>
      </div>
    );
  }

  const isOpen = order.status === 'acik';
  const isOnline = order.source === 'laffogato';
  const editable = !REMOTE && isOpen && !isOnline && can('siparis.al');
  const due = order.total - order.paid;
  const backPath = order.tableId ? '/masalar' : '/siparisler';
  const title =
    order.tableName ??
    (isOnline
      ? (order.extLabel ?? 'Online')
      : order.type === 'tezgah'
        ? `Tezgâh${order.numarator ? ` · ${numaratorLabel(order.numarator)}` : ''}`
        : order.type === 'gelal'
          ? `Gel-al${order.deliveryName ? ` · ${order.deliveryName}` : ''}${order.numarator ? ` · ${numaratorLabel(order.numarator)}` : ''}`
          : `Paket${order.deliveryName ? ` · ${order.deliveryName}` : ''}`);
  const titleBadge = order.platform ? <PlatformBadge platform={order.platform} code={order.platformCode} className="shrink-0" /> : null;

  const quickAdd = (p: ProductDTO, size: Size) => {
    cart.add(order.id, { productId: p.id, size, qty: 1, options: [], note: '' });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const send = async (): Promise<boolean> => {
    if (!pending.length) return false;
    setSending(true);
    const res = await act(
      (pin) =>
        post<OrderDTO>(`/orders/${order.id}/items`, {
          items: pending.map((l) => ({ productId: l.productId, size: l.size, qty: l.qty, options: l.options, note: l.note || null, ...(l.priceOverride != null ? { priceOverride: l.priceOverride } : {}) })),
          approverPin: pin,
        }),
      `${pendingCount} ürün gönderildi`,
    );
    setSending(false);
    if (!res) return false;
    cart.clear(order.id);
    qc.invalidateQueries({ queryKey: ['kitchen'] });
    if (!wide) setTab('adisyon');
    return true;
  };

  // Tezgâhta tek ekran: "Öde" kalemleri bara gönderir ve ödemeyi açar; satış kapanınca ekran yeni satışa hazırdır
  const counter = order.type === 'tezgah' && !isOnline;
  // Yarı self servis: tezgâh satışında gönderimden önce masa no / numaratör (bar fişine numara yerine o yazılır)
  const numaratorOn = asksNumarator(mode) && counter;
  const promptNumarator = (next: 'send' | 'pay') => {
    if (!numaratorOn || order.numarator || numaratorAsked.current.has(order.id)) return false;
    setAfterNumarator(next);
    setDialog('numarator');
    return true;
  };
  const once = async (fn: () => Promise<void>) => {
    if (flowBusy.current) return;
    flowBusy.current = true;
    setSending(true);
    try {
      await fn();
    } finally {
      flowBusy.current = false;
      setSending(false);
    }
  };
  const sendAndPay = () =>
    once(async () => {
      if (promptNumarator('pay')) return;
      if (await send()) setDialog('odeme');
    });
  const sendOnly = () =>
    void once(async () => {
      if (promptNumarator('send')) return;
      await send();
    });
  const saveNumarator = (value: string | null) => once(() => saveNumaratorNow(value));
  const saveNumaratorNow = async (value: string | null) => {
    numaratorAsked.current.add(order.id);
    const next = afterNumarator;
    setAfterNumarator(null);
    setDialog(null);
    if (value !== order.numarator) {
      // Satış akışında ayrı bildirim yok (ödeme ekranı masayı gösterir); düzenlemede onay
      const res = await act(() => put<OrderDTO>(`/orders/${order.id}/numarator`, { numarator: value }), next ? undefined : value ? `${numaratorLabel(value)} yazıldı` : 'Masa no kaldırıldı');
      if (!res && next) return;
    }
    if (next === 'pay') {
      if (await send()) setDialog('odeme');
    } else if (next === 'send') await send();
  };
  const nextSale = async () => {
    try {
      const next = await openCounterSale();
      navigate(`/adisyon/${next.id}`, { replace: true });
    } catch {
      navigate(backPath);
    }
  };

  const goBack = () => {
    if (pending.length) return setDialog('cikis');
    navigate(backPath);
  };

  const printBill = async () => {
    const res = await act(() => post<OrderDTO>(`/orders/${order.id}/bill`));
    if (res) printNow(<BillReceipt order={res} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} />);
  };

  // Ciro dışı kapanış sunucudaki kalemlere uygulanır: gönderilmemiş satırlar önce gönderilir ya da silinir (sessizce düşmesin)
  const compable = editable && order.paid === 0 && !order.room && (pending.length > 0 || order.items.some((i) => !i.voided && !i.complimentary));
  const compAll = (kind: CompKind) => (pending.length ? toast.warn('Önce gönderilmemiş kalemleri gönderin ya da silin') : setDialog(kind));
  const menuItems: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void; show: boolean; danger?: boolean }[] = [
    { icon: <Merge className="size-5" />, label: 'Masa taşı / birleştir', onClick: () => setDialog('tasi'), show: editable },
    { icon: <Split className="size-5" />, label: 'Hesabı böl / kalem taşı', onClick: () => setDialog('bol'), show: editable && order.items.some((i) => !i.voided) },
    { icon: <Percent className="size-5" />, label: order.discountType ? 'Adisyon indirimini değiştir' : 'Adisyon indirimi', onClick: () => setDialog('indirim'), show: editable },
    { icon: <Users className="size-5" />, label: `Kişi sayısı (${order.guests})`, onClick: () => setDialog('kisi'), show: editable },
    { icon: <UserRound className="size-5" />, label: order.customer ? `Müşteri: ${order.customer.name}` : 'Müşteri ekle', hint: boot.integrations.localStamps ? 'Açık hesap ve damga kartı için' : 'Açık hesap ve sipariş geçmişi için', onClick: () => setDialog('musteri'), show: isOpen && !isOnline },
    { icon: <MonitorUp className="size-5" />, label: displayCode ? 'Müşteri ekranı: açık' : 'Müşteri ekranı', hint: 'İkinci ekran ya da müşteriye dönük tablet', onClick: () => setDialog('ekran'), show: !isOnline },
    {
      icon: <TableProperties className="size-5" />,
      label: order.numarator ? `Masa no: ${order.numarator}` : 'Masa no / numaratör',
      hint: 'Hazır olunca personel bu masaya götürür',
      onClick: () => setDialog('numarator'),
      show: !REMOTE && !isOnline && (order.type === 'tezgah' || order.type === 'gelal') && (order.status === 'acik' || order.status === 'kapali') && (asksNumarator(mode) || !!order.numarator),
    },
    { icon: <StickyNote className="size-5" />, label: 'Adisyon notu', onClick: () => { setNoteText(order.note ?? ''); setDialog('not'); }, show: editable },
    { icon: <Printer className="size-5" />, label: 'Hesap yazdır', onClick: printBill, show: !isOnline && order.items.some((i) => !i.voided) },
    { icon: <CircleDollarSign className="size-5" />, label: 'Sıfır tutarlı adisyonu kapat', onClick: () => act(() => post(`/orders/${order.id}/close`), 'Adisyon kapandı').then((r) => r && navigate(backPath)), show: isOpen && !isOnline && order.total === 0 && order.items.length > 0 },
    { icon: <RotateCcw className="size-5" />, label: 'Yeniden aç', hint: 'Yetkili onayı ister', onClick: () => setDialog('yenidenac'), show: order.status === 'kapali' && !isOnline },
    { icon: <PackageX className="size-5" />, label: 'Tükenen ürünler', hint: 'Ürünü tükendi işaretle ya da satışa aç', onClick: () => setDialog('tukendi'), show: can('urun.tukendi') || can('menu.yonet') },
    // Ciro dışı kapanış (ikram, ödenmez, zayi): ödeme alınmamış adisyonun bütün kalemleri (kısmen ödenmişte kalan kalem kalem yazılır)
    ...COMP_KINDS.map((kind) => ({ icon: COMP_ICON[kind], label: COMP_CLOSE_LABEL[kind], hint: COMP_HINT[kind], onClick: () => compAll(kind), show: compable })),
    { icon: <Ban className="size-5" />, label: 'Adisyonu iptal et', hint: 'Bütün kalemler iptal olur', onClick: () => setDialog('iptal'), show: editable && order.paid === 0, danger: true },
  ];

  // Innex başlık şeridi: geri, başlık ve künye, sağda işlemler
  const header = (
    <div className="flex items-center gap-1.5 border-b border-[var(--admin-divider)] bg-surface px-2 py-2">
      <button onClick={goBack} aria-label="Geri" className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 hover:bg-surface-3 hover:text-ink">
        <ArrowLeft className="size-5" strokeWidth={1.75} />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="flex min-w-0 items-center gap-2 text-base font-semibold tracking-[-0.01em]">
            {titleBadge}
            <span className="truncate">{title}</span>
          </h1>
          <span className="tabular text-[13px] text-muted">#{isOnline ? (order.extNo ?? order.no) : order.no}</span>
          {order.status !== 'acik' && <Badge tone={order.status === 'kapali' ? 'green' : 'red'}>{order.status === 'kapali' ? 'Kapandı' : order.status === 'iptal' ? 'İptal' : 'Birleşti'}</Badge>}
          {isOnline && (
            <Badge tone="pink">
              <Globe className="size-3" /> Sitede ödendi
            </Badge>
          )}
        </div>
        <div className="truncate text-xs text-muted">
          {order.guests} kişi · {order.waiterName ?? '—'} · {fmtTime(order.openedAt)} ({fmtElapsed(order.openedAt, now)})
          {order.customer && ` · ${order.customer.name}`}
          {order.note && ` · Not: ${order.note}`}
        </div>
      </div>
      {!REMOTE && (
        <button onClick={() => setDialog('menu')} aria-label="İşlemler" className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 hover:bg-surface-3 hover:text-ink">
          <MoreVertical className="size-5" strokeWidth={1.75} />
        </button>
      )}
    </div>
  );

  const actionBar = (
    <div className="safe-bottom grid grid-cols-2 gap-2 border-t border-[var(--admin-divider)] bg-surface p-3">
      {pending.length > 0 && counter && can('odeme.al') ? (
        <div className="col-span-2 grid grid-cols-[auto_1fr_1.3fr] gap-2">
          <Button size="lg" aria-label="Gönderilmemişleri sil" title="Vazgeç" icon={<Trash2 className="size-4" />} onClick={() => cart.clear(order.id)} />
          <Button size="lg" loading={sending} icon={<Send className="size-4" />} onClick={sendOnly}>
            Gönder
          </Button>
          <Button size="lg" variant="primary" loading={sending} onClick={() => void sendAndPay()}>
            Öde · {tl((previewTotals(boot, order, pending)?.total ?? order.total) - order.paid)}
          </Button>
        </div>
      ) : pending.length > 0 ? (
        <>
          <Button size="lg" onClick={() => cart.clear(order.id)}>
            Vazgeç
          </Button>
          <Button size="lg" variant="primary" loading={sending} icon={<Send className="size-4" />} onClick={sendOnly}>
            Gönder ({pendingCount})
          </Button>
        </>
      ) : isOpen && !isOnline && !REMOTE ? (
        <>
          <Button size="lg" icon={<Printer className="size-4" />} onClick={printBill} disabled={!order.items.some((i) => !i.voided)}>
            Hesap
          </Button>
          <Button size="lg" variant="primary" disabled={due <= 0 || !can('odeme.al')} onClick={() => setDialog('odeme')}>
            {can('odeme.al') ? `Ödeme · ${tl(due)}` : 'Ödemeyi kasa alır'}
          </Button>
        </>
      ) : (
        <Button size="lg" className="col-span-2" onClick={() => navigate(backPath)}>
          Kapat
        </Button>
      )}
    </div>
  );

  const right = (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {isOnline && <OnlineOrderBar order={order} act={act} />}
      {table?.kind === 'oda' && (order.room || editable) && <RoomBox order={order} table={table} editable={editable} act={act} now={now} onClosed={() => navigate(backPath)} />}
      <CartPanel order={order} pending={pending} onEditPending={(l) => { const p = boot.products.find((x) => x.id === l.productId); if (p) setOptions({ product: p, size: l.size, editing: l }); }} act={act} />
      {actionBar}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {wide ? (
        // Innex: iki beyaz kart; solda katalog, sağda adisyon (başlığıyla)
        <div className="flex min-h-0 flex-1 gap-2">
          {/* Uzaktan salt okunur: katalog yok, adisyon tam genişlikte */}
          {!REMOTE && (
            <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface">
              <ProductPanel disabled={!editable} onQuickAdd={quickAdd} onCustomize={(p, size) => setOptions({ product: p, size, editing: null })} />
            </section>
          )}
          <section className={cn('flex shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface', REMOTE ? 'mx-auto w-full max-w-2xl' : 'w-[clamp(320px,42vw,440px)]')}>
            {header}
            {right}
          </section>
        </div>
      ) : (
        <>
          {header}
          <div role="tablist" aria-label="Adisyon görünümü" className={cn('grid grid-cols-2 border-b border-line bg-surface', REMOTE && 'hidden')}>
            {(['menu', 'adisyon'] as const).map((k) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
                className={cn('relative min-h-12 py-2.5 text-sm font-medium', tab === k ? 'font-semibold text-ink after:absolute after:inset-x-6 after:bottom-0 after:h-0.5 after:rounded-full after:bg-ink' : 'text-muted')}
              >
                {k === 'menu' ? 'Menü' : `Adisyon${pendingCount ? ` (+${pendingCount})` : ''} · ${tl(previewTotals(boot, order, pending)?.total ?? order.total)}`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {tab === 'menu' && editable ? (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  <ProductPanel onQuickAdd={quickAdd} onCustomize={(p, size) => setOptions({ product: p, size, editing: null })} />
                </div>
                {pending.length > 0 && actionBar}
              </div>
            ) : (
              <div className="flex h-full flex-col">{right}</div>
            )}
          </div>
        </>
      )}

      {options && (
        <OptionsModal
          product={options.product}
          initialSize={options.size}
          editing={options.editing}
          onClose={() => setOptions(null)}
          onSubmit={(line) => {
            if (options.editing) cart.update(order.id, options.editing.key, line);
            else cart.add(order.id, line);
            setOptions(null);
          }}
        />
      )}

      <Modal open={dialog === 'menu'} onClose={() => setDialog(null)} title="İşlemler" size="sm">
        <div className="grid gap-1.5 p-3">
          {menuItems
            .filter((m) => m.show)
            .map((m) => (
              <button
                key={m.label}
                onClick={() => {
                  setDialog(null);
                  m.onClick();
                }}
                className={cn('flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-surface-2', m.danger && 'text-[var(--admin-danger-ink)]')}
              >
                <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', m.danger ? 'bg-[var(--admin-danger-soft)]' : 'bg-surface-3 text-ink-2')}>{m.icon}</span>
                <span>
                  <span className="block text-sm font-medium">{m.label}</span>
                  {m.hint && <span className="block text-xs text-muted">{m.hint}</span>}
                </span>
              </button>
            ))}
        </div>
      </Modal>

      <SoldOutDialog open={dialog === 'tukendi'} onClose={() => setDialog(null)} />

      <Modal open={dialog === 'ekran'} onClose={() => setDialog(null)} title="Müşteri ekranı" subtitle="Müşteri siparişini ve tutarı görür; ödeme bitince teşekkür eder" size="sm">
        <div className="space-y-4 p-5">
          <Toggle
            checked={!!displayCode}
            onChange={(v) => {
              if (!v) sendDisplay(displayCode, { kind: 'idle' });
              setDisplayCode(v ? 'kasa' : '');
            }}
            label="Bu cihazdaki adisyonlar müşteri ekranına yansısın"
          />
          <Button block icon={<MonitorUp className="size-4" />} onClick={() => window.open(appUrl('/musteri-ekrani?ekran=kasa'), 'lafpos-musteri')}>
            Ekranı yeni pencerede aç
          </Button>
          <p className="text-xs text-muted">
            İkinci monitörde pencereyi oraya taşıyıp tam ekran yapın. Müşteriye dönük tablette tarayıcıda {window.location.origin}/musteri-ekrani adresini açın; personel girişi gerekmez.
          </p>
        </div>
      </Modal>

      <NumaratorModal
        open={dialog === 'numarator'}
        initial={order.numarator}
        flow={afterNumarator != null}
        onClose={() => {
          setAfterNumarator(null);
          setDialog(null);
        }}
        onConfirm={(v) => void saveNumarator(v)}
      />
      <PaymentModal
        order={order}
        open={dialog === 'odeme'}
        onClose={() => setDialog(null)}
        act={act}
        onDone={(closed, opts) => {
          setDialog(null);
          if (closed) {
            cart.clear(order.id);
            // Ciro dışı kapanışta (ikram, ödenmez, zayi) tahsilat yok: müşteri ekranı tutarla teşekkür etmez, hoş geldinize döner
            sendDisplay(displayCode, opts?.comp ? { kind: 'idle' } : { kind: 'thanks', total: order.total });
            if (counter) void nextSale();
            else navigate(backPath);
          }
        }}
      />
      <MoveModal order={order} open={dialog === 'tasi'} onClose={() => setDialog(null)} act={act} onMoved={(target) => { setDialog(null); if (target) navigate(`/adisyon/${target}`, { replace: true }); }} />
      <TransferModal order={order} open={dialog === 'bol'} onClose={() => setDialog(null)} act={act} onDone={() => setDialog(null)} />
      <OrderDiscountModal order={order} open={dialog === 'indirim'} onClose={() => setDialog(null)} act={act} />
      <GuestsModal order={order} open={dialog === 'kisi'} onClose={() => setDialog(null)} act={act} />
      <CustomerModal order={order} open={dialog === 'musteri'} onClose={() => setDialog(null)} act={act} />
      <ReasonModal
        open={dialog === 'iptal'}
        title="Adisyonu iptal et"
        subtitle="Bütün kalemler iptal edilir ve patron paneline düşer"
        reasons={boot.settings.voidReasons}
        confirmLabel="İptal et"
        danger
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          const res = await act((pin) => post(`/orders/${order.id}/cancel`, { reason, approverPin: pin }), 'Adisyon iptal edildi');
          if (res) {
            cart.clear(order.id);
            navigate(backPath);
          }
        }}
      />
      {COMP_KINDS.map((kind) => (
        <ReasonModal
          key={kind}
          open={dialog === kind}
          title={COMP_CLOSE_LABEL[kind]}
          subtitle={compCloseSubtitle(kind, tl(order.total))}
          reasons={compReasonsOf(boot.settings, kind)}
          confirmLabel={COMP_CONFIRM_LABEL[kind]}
          onClose={() => setDialog(null)}
          onConfirm={async (reason) => {
            const res = await act((pin) => post(`/orders/${order.id}/comp`, { kind, reason, approverPin: pin }), COMP_DONE_TOAST[kind]);
            if (res) {
              cart.clear(order.id);
              navigate(backPath);
            }
          }}
        />
      ))}
      <ReasonModal
        open={dialog === 'yenidenac'}
        title="Adisyonu yeniden aç"
        subtitle="Kapanmış adisyonu açmak yetkili onayı ister ve kayda geçer"
        reasons={['Ödeme türü yanlış girildi', 'Ürün eklenecek', 'Hesap yanlış kapandı']}
        confirmLabel="Yeniden aç"
        onClose={() => setDialog(null)}
        onConfirm={async (reason) => {
          await act((pin) => post(`/orders/${order.id}/reopen`, { reason, approverPin: pin }), 'Adisyon yeniden açıldı');
          setDialog(null);
        }}
      />
      <Modal open={dialog === 'not'} onClose={() => setDialog(null)} title="Adisyon notu" size="sm">
        <div className="space-y-3 p-4">
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value.slice(0, 300))} className="min-h-24 w-full rounded-xl border border-line-strong bg-surface p-3 outline-none focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)]" placeholder="Ör. Doğum günü, pastayı 21:00'de getir" />
          <Button
            variant="primary"
            block
            onClick={async () => {
              try {
                await act(() => patch(`/orders/${order.id}`, { note: noteText }));
                setDialog(null);
              } catch (e) {
                toast.err(errorMessage(e));
              }
            }}
          >
            Kaydet
          </Button>
        </div>
      </Modal>
      <Modal open={dialog === 'cikis'} onClose={() => setDialog(null)} title="Gönderilmemiş ürünler var" subtitle={`${pendingCount} ürün henüz bara/mutfağa gitmedi`} size="sm">
        <div className="grid gap-2 p-4">
          <Button variant="primary" size="lg" icon={<Send className="size-4" />} onClick={async () => { await send(); setDialog(null); navigate(backPath); }}>
            Gönder ve çık
          </Button>
          <Button size="lg" onClick={() => navigate(backPath)}>
            Bu cihazda beklesin
          </Button>
          <Button variant="ghost" className="text-[var(--admin-danger-ink)]" onClick={() => { cart.clear(order.id); navigate(backPath); }}>
            Sil ve çık
          </Button>
        </div>
      </Modal>
    </div>
  );
}
