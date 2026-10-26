import { useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CircleDollarSign,
  Globe,
  Merge,
  Mic2,
  MoreVertical,
  Percent,
  Play,
  Printer,
  RotateCcw,
  Send,
  Split,
  Square,
  StickyNote,
  UserRound,
  Users,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { tl } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import type { OrderDTO, ProductDTO, Size } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Badge, PageLoading } from '@/components/ui/misc';
import { errorMessage, patch, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { type PendingLine, useCart, usePending } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { useMediaQuery, useTick } from '@/lib/hooks';
import { BillReceipt, printNow } from '@/lib/print';
import { toast } from '@/lib/toast';
import { CartPanel } from './CartPanel';
import { CustomerModal } from './CustomerModal';
import { OnlineOrderBar } from './OnlineOrderBar';
import { OptionsModal } from './OptionsModal';
import { PaymentModal } from './PaymentModal';
import { ProductPanel } from './ProductPanel';
import { GuestsModal, MoveModal, OrderDiscountModal, ReasonModal, TransferModal } from './TableOps';
import { useOrder } from './useOrder';

type Dialog = null | 'menu' | 'odeme' | 'tasi' | 'bol' | 'indirim' | 'kisi' | 'iptal' | 'yenidenac' | 'not' | 'musteri' | 'cikis';

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
  const [tab, setTab] = useState<'menu' | 'adisyon'>('menu');
  const [dialog, setDialog] = useState<Dialog>(null);
  const [options, setOptions] = useState<{ product: ProductDTO; size: Size; editing: PendingLine | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [noteText, setNoteText] = useState('');

  const table = useMemo(() => boot.tables.find((t) => t.id === order?.tableId), [boot.tables, order?.tableId]);
  const pendingCount = pending.reduce((a, l) => a + l.qty, 0);

  if (isLoading) return <PageLoading />;
  if (isError || !order) {
    return (
      <div className="grid h-full place-items-center p-6 text-center">
        <div>
          <p className="font-semibold">Adisyon bulunamadı</p>
          <Button className="mt-4" onClick={() => navigate('/masalar')}>
            Masalara dön
          </Button>
        </div>
      </div>
    );
  }

  const isOpen = order.status === 'acik';
  const isOnline = order.source === 'laffogato';
  const editable = isOpen && !isOnline && can('siparis.al');
  const due = order.total - order.paid;
  const backPath = order.tableId ? '/masalar' : '/siparisler';
  const title = order.tableName ?? (isOnline ? (order.extLabel ?? 'Online') : order.type === 'tezgah' ? 'Tezgâh' : order.type === 'gelal' ? `Gel-al${order.deliveryName ? ` · ${order.deliveryName}` : ''}` : `Paket${order.deliveryName ? ` · ${order.deliveryName}` : ''}`);

  const quickAdd = (p: ProductDTO, size: Size) => {
    cart.add(order.id, { productId: p.id, size, qty: 1, options: [], note: '' });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const send = async () => {
    if (!pending.length) return;
    setSending(true);
    const res = await act(
      (pin) =>
        post<OrderDTO>(`/orders/${order.id}/items`, {
          items: pending.map((l) => ({ productId: l.productId, size: l.size, qty: l.qty, options: l.options, note: l.note || null })),
          approverPin: pin,
        }),
      `${pendingCount} ürün gönderildi`,
    );
    setSending(false);
    if (res) {
      cart.clear(order.id);
      qc.invalidateQueries({ queryKey: ['kitchen'] });
      if (!wide) setTab('adisyon');
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

  const roomAction = async (action: 'start' | 'stop') => {
    await act((pin) => post<OrderDTO>(`/orders/${order.id}/room/${action}`, { approverPin: pin }), action === 'start' ? 'Oda sayacı başladı' : 'Oda ücreti adisyona eklendi');
  };

  const menuItems: { icon: React.ReactNode; label: string; hint?: string; onClick: () => void; show: boolean; danger?: boolean }[] = [
    { icon: <Merge className="size-5" />, label: 'Masa taşı / birleştir', onClick: () => setDialog('tasi'), show: editable },
    { icon: <Split className="size-5" />, label: 'Hesabı böl / kalem taşı', onClick: () => setDialog('bol'), show: editable && order.items.some((i) => !i.voided) },
    { icon: <Percent className="size-5" />, label: order.discountType ? 'Adisyon indirimini değiştir' : 'Adisyon indirimi', onClick: () => setDialog('indirim'), show: editable },
    { icon: <Users className="size-5" />, label: `Kişi sayısı (${order.guests})`, onClick: () => setDialog('kisi'), show: editable },
    { icon: <UserRound className="size-5" />, label: order.customer ? `Müşteri: ${order.customer.name}` : 'Müşteri ekle', hint: 'Açık hesap ve damga kartı için', onClick: () => setDialog('musteri'), show: isOpen && !isOnline },
    { icon: <StickyNote className="size-5" />, label: 'Adisyon notu', onClick: () => { setNoteText(order.note ?? ''); setDialog('not'); }, show: editable },
    { icon: <Printer className="size-5" />, label: 'Hesap yazdır', onClick: printBill, show: !isOnline && order.items.some((i) => !i.voided) },
    { icon: <CircleDollarSign className="size-5" />, label: 'Sıfır tutarlı adisyonu kapat', onClick: () => act(() => post(`/orders/${order.id}/close`), 'Adisyon kapandı').then((r) => r && navigate(backPath)), show: isOpen && !isOnline && order.total === 0 && order.items.length > 0 },
    { icon: <RotateCcw className="size-5" />, label: 'Yeniden aç', hint: 'Yetkili onayı ister', onClick: () => setDialog('yenidenac'), show: order.status === 'kapali' && !isOnline },
    { icon: <Ban className="size-5" />, label: 'Adisyonu iptal et', hint: 'Bütün kalemler iptal olur', onClick: () => setDialog('iptal'), show: editable && order.paid === 0, danger: true },
  ];

  const header = (
    <div className="flex items-center gap-2 border-b border-line bg-surface px-3 py-2.5">
      <button onClick={goBack} aria-label="Geri" className="grid size-11 place-items-center rounded-xl hover:bg-surface-2">
        <ArrowLeft className="size-5" />
      </button>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h1 className="truncate text-lg font-semibold">{title}</h1>
          <span className="text-sm text-muted">#{isOnline ? (order.extNo ?? order.no) : order.no}</span>
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
      {table?.kind === 'oda' && editable && (
        <Button
          variant={order.room ? 'danger' : 'brass'}
          icon={order.room ? <Square className="size-4" /> : <Play className="size-4" />}
          onClick={() => roomAction(order.room ? 'stop' : 'start')}
        >
          {order.room ? `Odayı durdur · ${fmtElapsed(order.room.startedAt, now)}` : 'Oda sayacını başlat'}
        </Button>
      )}
      <button onClick={() => setDialog('menu')} aria-label="İşlemler" className="grid size-11 place-items-center rounded-xl hover:bg-surface-2">
        <MoreVertical className="size-5" />
      </button>
    </div>
  );

  const actionBar = (
    <div className="safe-bottom grid grid-cols-2 gap-2 border-t border-line bg-surface p-3">
      {pending.length > 0 ? (
        <>
          <Button size="lg" onClick={() => cart.clear(order.id)}>
            Vazgeç
          </Button>
          <Button size="lg" variant="primary" loading={sending} icon={<Send className="size-4" />} onClick={send}>
            Gönder ({pendingCount})
          </Button>
        </>
      ) : isOpen && !isOnline ? (
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
      {table?.kind === 'oda' && order.room && (
        <div className="flex items-center gap-2 border-b border-line bg-burgundy-50 px-4 py-2 text-sm text-burgundy-600 dark:bg-burgundy-800/40 dark:text-burgundy-100">
          <Mic2 className="size-4" /> Oda {fmtTime(order.room.startedAt)}'den beri açık · saatlik {tl(order.room.hourlyRate)}
        </div>
      )}
      <CartPanel order={order} pending={pending} onEditPending={(l) => { const p = boot.products.find((x) => x.id === l.productId); if (p) setOptions({ product: p, size: l.size, editing: l }); }} act={act} />
      {actionBar}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {header}
      {wide ? (
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 flex-1 bg-bg">
            <ProductPanel disabled={!editable} onQuickAdd={quickAdd} onCustomize={(p, size) => setOptions({ product: p, size, editing: null })} />
          </div>
          <div className="flex w-[clamp(300px,42vw,430px)] shrink-0 flex-col border-l border-line">{right}</div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 border-b border-line bg-surface">
            {(['menu', 'adisyon'] as const).map((k) => (
              <button key={k} onClick={() => setTab(k)} className={cn('min-h-12 py-2.5 text-sm font-semibold', tab === k ? 'border-b-2 border-forest-600 text-forest-700 dark:text-forest-300' : 'text-muted')}>
                {k === 'menu' ? 'Menü' : `Adisyon${pendingCount ? ` (+${pendingCount})` : ''} · ${tl(order.total)}`}
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
                className={cn('flex items-center gap-3 rounded-2xl px-4 py-3 text-left hover:bg-surface-2', m.danger && 'text-burgundy-500')}
              >
                {m.icon}
                <span>
                  <span className="block font-medium">{m.label}</span>
                  {m.hint && <span className="block text-xs text-muted">{m.hint}</span>}
                </span>
              </button>
            ))}
        </div>
      </Modal>

      <PaymentModal
        order={order}
        open={dialog === 'odeme'}
        onClose={() => setDialog(null)}
        act={act}
        onDone={(closed) => {
          setDialog(null);
          if (closed) {
            cart.clear(order.id);
            navigate(backPath);
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
          <textarea value={noteText} onChange={(e) => setNoteText(e.target.value.slice(0, 300))} className="min-h-24 w-full rounded-xl border border-line-strong bg-surface p-3 outline-none focus:border-forest-500" placeholder="Ör. Doğum günü, pastayı 21:00'de getir" />
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
          <Button variant="ghost" className="text-burgundy-500" onClick={() => { cart.clear(order.id); navigate(backPath); }}>
            Sil ve çık
          </Button>
        </div>
      </Modal>
    </div>
  );
}
