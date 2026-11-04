import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ArrowRightLeft,
  Ban,
  ChevronRight,
  CircleDollarSign,
  Droplets,
  Gift,
  HandCoins,
  Merge,
  MonitorUp,
  MoreHorizontal,
  MoreVertical,
  PackageX,
  Percent,
  Plus,
  Printer,
  RotateCcw,
  Send,
  ShoppingBag,
  Split,
  StickyNote,
  TableProperties,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { COMP_CLOSE_LABEL, COMP_CONFIRM_LABEL, COMP_DONE_TOAST, COMP_HINT, COMP_KINDS, compCloseSubtitle, compReasonsOf } from '@shared/comp';
import { tl, tlShort } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import type { CompKind, FloorStateDTO, OrderDTO, ProductDTO, Size } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { Button, buttonClass, IconButton } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Modal } from '@/components/ui/Modal';
import { Textarea, Toggle } from '@/components/ui/Field';
import { Badge, type BadgeTone, EmptyState, ErrorState, PageLoading } from '@/components/ui/misc';
import { get, patch, post, put } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { sendableOptions, soldOutDefault, useBoot } from '@/lib/boot';
import { type PendingLine, restoreLines, useCart, usePending } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { joinMeta } from '@/lib/text';
import { previewTotals } from '@/lib/estimate';
import { useMediaQuery, useTick } from '@/lib/hooks';
import { BillReceipt, printNow } from '@/lib/print';
import { toast } from '@/lib/toast';
import { ORDER_TYPE_LABEL } from '@shared/labels';
import { sendDisplay, useCustomerDisplay, useDisplayCode } from '@/lib/display';
import { CartPanel } from './CartPanel';
import { CustomerModal } from './CustomerModal';
import { OnlineOrderBar } from './OnlineOrderBar';
import { OdenmezModal } from './OdenmezModal';
import { OptionsModal } from './OptionsModal';
import { PaymentModal } from './PaymentModal';
import { ProductPanel } from './ProductPanel';
import { ReadyBar } from './ReadyBar';
import { GuestsModal, MoveModal, OrderDiscountModal, ReasonModal, TransferModal } from './TableOps';
import { useOrder } from './useOrder';
import { REMOTE } from '@/lib/remote';
import { openCounterSale } from '@/lib/counter';
import { asksNumarator, callFor, callText, isCounterFirst, numaratorLabel } from '@shared/service-mode';
import { useSetNavOrigin } from '@/lib/nav';
import { useServiceMode } from '@/lib/serviceMode';
import { NumaratorModal } from './NumaratorModal';
import { appUrl } from '@/lib/demo';
import { PlatformBadge } from '@/components/PlatformBadge';
import { RoomBox } from './RoomBox';

type Dialog = null | 'tukendi' | 'menu' | 'ekran' | 'odeme' | 'tasi' | 'bol' | 'indirim' | 'kisi' | 'iptal' | CompKind | 'yenidenac' | 'not' | 'musteri' | 'cikis' | 'numarator';

/** İşlemler menüsündeki ciro dışı kapanış ikonları (ödeme ekranıyla aynı) */
const COMP_ICON: Record<CompKind, React.ReactNode> = { ikram: <Gift className="size-5" />, odenmez: <HandCoins className="size-5" />, zayi: <Droplets className="size-5" /> };

/** İşlemler menüsünün bölümleri: adisyonun kendisi, ciro dışı kapanış, ekranlar; yıkıcı eylem en altta, çizgiyle ayrı */
type MenuGroup = 'adisyon' | 'ciro' | 'ekran' | 'tehlike';
const MENU_GROUPS: [MenuGroup, string | null][] = [
  ['adisyon', 'Adisyon'],
  ['ciro', 'Ciro dışı kapat'],
  ['ekran', 'Ekran ve menü'],
  ['tehlike', null],
];

/**
 * Ödeme düğmesinin yazısı. Dar hesap kartında (telefon, tablet) eylem küçük, tutar altında: büyük tutar da kapsülün
 * içinde kalır. Bilgisayarda tek satır ("Öde · ₺580,00"). Ayraç dar ekranda yalnız ekran okuyucuda kalır: düğmenin adı
 * her boyda "Öde · ₺580,00"
 */
function PayLabel({ action, amount, inline }: { action: string; amount: number; inline?: boolean }) {
  // Satırın tamamını alan düğmede (inline) her boyda tek satır
  return (
    <span className={cn('flex min-w-0 items-center leading-tight', inline ? 'flex-row gap-1' : 'flex-col lg:flex-row lg:gap-1')}>
      <span className={cn(!inline && 'max-lg:text-[13px] max-lg:font-medium')}>
        {action}
        <span className={cn(!inline && 'max-lg:sr-only')}> ·</span>
      </span>
      <span className="tabular">{tl(amount)}</span>
    </span>
  );
}

export default function OrderPage() {
  const { id = '' } = useParams();
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Tablet dikeyde de ürünler ve adisyon yan yana (impeccable adapt: tablette liste + ayrıntı)
  const wide = useMediaQuery('(min-width: 768px)');
  const now = useTick(30_000);
  const { order, isLoading, isError, error, refetch, isFetching, act } = useOrder(id);
  const pending = usePending(id);
  const cart = useCart();
  const [tab, setTab] = useState<'menu' | 'adisyon'>(REMOTE ? 'adisyon' : 'menu');
  const [dialog, setDialog] = useState<Dialog>(null);
  /** Kalem işlemlerinden "Taşı": taşıma penceresi bu kalem seçili açılır */
  const [moveItem, setMoveItem] = useState<{ itemId: string; qty: number } | null>(null);
  const [options, setOptions] = useState<{ product: ProductDTO; size: Size; editing: PendingLine | null } | null>(null);
  const [sending, setSending] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const mode = useServiceMode();
  // Yarı self servis: masa no / numaratör bir kez sorulur; "Numarasız devam" denen adisyonda yeniden sorulmaz
  const numaratorAsked = useRef(new Set<string>());
  // Gönderim akışı tek seferlik: masa no kaydedilirken ya da kalemler giderken ikinci basış kalemi yinelemez
  const flowBusy = useRef(false);
  const [afterNumarator, setAfterNumarator] = useState<null | 'send' | 'pay'>(null);
  // Telefonda ürünler ve sepet arasında geçiş odağı kaybetmesin: basılan düğme görünümle sökülür, odak öteki görünümün
  // geçiş düğmesine geçer (sepette "Ürün ekle", ürünlerde sepet çubuğu)
  const cartBarRef = useRef<HTMLButtonElement>(null);
  const addProductRef = useRef<HTMLButtonElement>(null);
  const focusOnSwitch = useRef(false);
  const showView = (next: 'menu' | 'adisyon') => {
    if (next !== tab) focusOnSwitch.current = true;
    setTab(next);
  };
  useEffect(() => {
    if (!focusOnSwitch.current) return;
    focusOnSwitch.current = false;
    (tab === 'adisyon' ? addProductRef : cartBarRef).current?.focus();
  }, [tab]);
  // Telefonda bildirim alttaki eylem bloğunun (hızlı işlemler ve eylem şeridi ya da sepet çubuğu) üstünde durur: bloğun
  // boyu html'de --action-bar-h (lib/toast.tsx); şerit bir ya da iki satır, hızlı işlemli ya da değil. Blok sökülünce silinir
  const measureActionBar = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--action-bar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--action-bar-h');
    };
  }, []);

  const table = useMemo(() => boot.tables.find((t) => t.id === order?.tableId), [boot.tables, order?.tableId]);
  const pendingCount = pending.reduce((a, l) => a + l.qty, 0);
  // Müşteri ekranı (bu cihaz yansıtıyorsa): kalemler ve gönderilmemişler dahil tahmini tutar
  const [displayCode, setDisplayCode] = useDisplayCode();
  const call = order ? callFor(order, mode) : null;
  const displayLabel = order ? (table?.name ?? (call ? callText(call) : ORDER_TYPE_LABEL[order.type])) : '';
  useCustomerDisplay(boot, order, pending, displayLabel);
  // Menüde geldiği ekran etkin görünür (rayda ve alt sekmede): masa adisyonu Masalar, self modda tezgâh satışı Tezgâh
  // satışı, gerisi Siparişler
  useSetNavOrigin(order ? (order.tableId ? '/masalar' : order.type === 'tezgah' && isCounterFirst(mode) ? '/satis' : '/siparisler') : null);
  const me = useAuth((s) => s.me);
  const hasItems = !!order?.items.some((i) => !i.voided);
  // Kalemsiz, ödemesiz açık adisyon (masa açıldı, sipariş yok; boş tezgâh satışı): eylem şeridi aşağıda. Çalışan oda
  // sayacı boş sayılmaz (ücret işler)
  const blank = !!order && order.status === 'acik' && order.source !== 'laffogato' && !REMOTE && !hasItems && !pending.length && order.paid === 0 && !order.room;
  // Boş masa adisyonunun düğmesi masadaki öteki hesaplara göre adlanır (sharesTable, aşağıda): masa planı yalnız o zaman
  // ve güncel sorulur. Önbellek sayfa yeniden yüklenince ya da Patron'dan açılınca boştur, Masalar kapalıyken eskir
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), enabled: blank && !!order?.tableId && can('siparis.al') });

  if (isLoading) return <PageLoading />;
  if (!order) {
    const home = (
      <Link to="/" className={buttonClass('secondary', 'sm')}>
        Ana ekrana dön
      </Link>
    );
    return (
      <div className="grid h-full place-items-center p-6">
        {/* Bağlantı hatası "bulunamadı" diye okunmasın: hata ise yeniden dene, yoksa ana ekrana */}
        {isError && !(error && 'status' in error && error.status === 404) ? (
          <ErrorState title="Adisyon alınamadı" error={error} retrying={isFetching} onRetry={() => void refetch()} action={home} />
        ) : (
          <EmptyState title="Adisyon bulunamadı" action={home}>
            Kapanmış ya da başka bir adisyonla birleşmiş olabilir
          </EmptyState>
        )}
      </div>
    );
  }

  const isOpen = order.status === 'acik';
  const isOnline = order.source === 'laffogato';
  const editable = !REMOTE && isOpen && !isOnline && can('siparis.al');
  const due = order.total - order.paid;
  const backPath = order.tableId ? '/masalar' : '/siparisler';
  // Başlıkta en önemli bilgi: masa, yoksa numaratör (siparişin gideceği masa), yoksa tip ve ad; tip künye satırına iner
  const title =
    order.tableName ??
    (isOnline
      ? (order.extLabel ?? 'Online')
      : order.numarator
        ? numaratorLabel(order.numarator)
        : order.type === 'tezgah'
          ? 'Tezgâh'
          : order.type === 'gelal'
            ? `Gel-al${order.deliveryName ? ` · ${order.deliveryName}` : ''}`
            : `Paket${order.deliveryName ? ` · ${order.deliveryName}` : ''}`);
  const titleType = !order.tableName && !isOnline && order.numarator ? `${ORDER_TYPE_LABEL[order.type]}${order.deliveryName ? ` · ${order.deliveryName}` : ''}` : null;
  const orderNo = isOnline ? (order.extNo ?? order.no) : order.no;
  const titleBadge = order.platform ? <PlatformBadge platform={order.platform} code={order.platformCode} className="shrink-0" /> : null;

  const quickAdd = (p: ProductDTO, size: Size) => {
    // Varsayılan seçeneği tükendi (normal süt bitti): pencere açılır, kasiyer başkasını seçer
    if (soldOutDefault(boot, p)) return setOptions({ product: p, size, editing: null });
    cart.add(order.id, { productId: p.id, size, qty: 1, options: [], note: '' });
    if (navigator.vibrate) navigator.vibrate(8);
  };

  const send = async (): Promise<boolean> => {
    if (!pending.length) return false;
    // Yalnız gönderilen adetler sepetten düşer: istek sürerken eklenen ya da "Geri al"la geri konan satır beklemede kalır
    const sent = new Map(pending.map((l) => [l.key, l.qty]));
    // Pencerenin önseçtiği, sonra tükenen Normal süt gitmez: o grup boş gider, sunucu süt yazmaz (gitse 409 alır, bütün
    // satırlar takılırdı)
    setSending(true);
    const res = await act(
      (pin) =>
        post<OrderDTO>(`/orders/${order.id}/items`, {
          items: pending.map((l) => ({ productId: l.productId, size: l.size, qty: l.qty, options: sendableOptions(boot, l.productId, l.options), note: l.note || null, ...(l.priceOverride != null ? { priceOverride: l.priceOverride } : {}) })),
          approverPin: pin,
        }),
      `${pendingCount} ürün gönderildi`,
    );
    setSending(false);
    if (!res) return false;
    cart.consume(order.id, sent);
    qc.invalidateQueries({ queryKey: ['kitchen'] });
    if (!wide) showView('adisyon');
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

  // Gönderilmemişleri silmek geri alınabilir: onay penceresi yerine bildirimde "Geri al" (6 sn)
  // Gönderim sürerken silinmez: bara giden kalemler "Geri al" ile yeniden bekleyen satır olmasın
  const discardPending = () => {
    if (sending) return;
    const saved = pending;
    const orderId = order.id;
    cart.clear(orderId);
    toast.ok(`${pendingCount} ürün silindi`, {
      action: { label: 'Geri al', run: () => useCart.setState((st) => ({ byOrder: { ...st.byOrder, [orderId]: restoreLines(st.byOrder[orderId] ?? [], saved) } })) },
    });
  };

  const goBack = () => {
    if (pending.length) return setDialog('cikis');
    navigate(backPath);
  };

  const printBill = async () => {
    const res = await act(() => post<OrderDTO>(`/orders/${order.id}/bill`));
    if (res) printNow(<BillReceipt order={res} boot={boot} sizeLabel={(s) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s} />);
  };

  // Tutarı sıfır, kalemi olan adisyon (hepsi ikram ya da tam indirim): "Ödeme · ₺0,00" yerine kapanış; tezgâhta sonra
  // yeni satış (ödemeyle kapanan satış gibi). Sunucu sipariş yetkisi ister (editable). Çalışan oda sayacının ücreti henüz
  // tutarda değil: o zaman ödeme yolu kalır; gönderilmemiş satır da tutarı değiştirir. Kalemi hiç kalmamış adisyon
  // kapanmaz, boşaltılır (aşağıda, iptal olarak)
  const zeroClose = editable && hasItems && due <= 0 && !order.room && !pending.length;
  const closeZero = () =>
    void once(async () => {
      const done = await act(() => post<OrderDTO>(`/orders/${order.id}/close`), 'Adisyon kapandı');
      if (!done) return;
      cart.clear(order.id);
      // Tahsilat yok: müşteri ekranı teşekkür etmez, hoş geldinize döner (ödeme penceresinin ciro dışı kapanışı gibi). Yeni
      // satışta sayfa kaldırılmaz, boş satış da ekrana bir şey göndermez: kapanan adisyon ekranda kalırdı
      sendDisplay(displayCode, { kind: 'idle' });
      if (counter) await nextSale();
      else navigate(backPath);
    });

  // Ciro dışı kapanış sunucudaki kalemlere uygulanır: gönderilmemiş satırlar önce gönderilir ya da silinir (sessizce düşmesin)
  const compable = editable && order.paid === 0 && !order.room && (pending.length > 0 || order.items.some((i) => !i.voided && !i.complimentary));
  const compAll = (kind: CompKind) => (pending.length ? toast.warn('Önce gönderilmemiş kalemleri gönderin ya da silin') : setDialog(kind));
  const menuItems: { group: MenuGroup; icon: React.ReactNode; label: string; hint?: string; onClick: () => void; show: boolean; danger?: boolean }[] = [
    { group: 'adisyon', icon: <Merge className="size-5" />, label: 'Masa taşı / birleştir', onClick: () => setDialog('tasi'), show: editable },
    { group: 'adisyon', icon: <Split className="size-5" />, label: 'Hesabı böl / kalem taşı', onClick: () => setDialog('bol'), show: editable && order.items.some((i) => !i.voided) },
    { group: 'adisyon', icon: <Percent className="size-5" />, label: order.discountType ? 'Adisyon indirimini değiştir' : 'Adisyon indirimi', onClick: () => setDialog('indirim'), show: editable },
    // Kişi sayısı yalnız masada anlamlı (raporlar da yalnız masa adisyonunun kişisini sayar)
    { group: 'adisyon', icon: <Users className="size-5" />, label: `Kişi sayısı: ${order.guests}`, onClick: () => setDialog('kisi'), show: editable && order.type === 'masa' },
    { group: 'adisyon', icon: <UserRound className="size-5" />, label: order.customer ? `Müşteri: ${order.customer.name}` : 'Müşteri ekle', hint: boot.integrations.localStamps ? 'Açık hesap ve damga kartı için' : 'Açık hesap ve sipariş geçmişi için', onClick: () => setDialog('musteri'), show: isOpen && !isOnline },
    {
      group: 'adisyon',
      icon: <TableProperties className="size-5" />,
      label: order.numarator ? `Masa no: ${order.numarator}` : 'Masa no / numaratör',
      hint: 'Hazır olunca personel bu masaya götürür',
      onClick: () => setDialog('numarator'),
      show: !REMOTE && !isOnline && (order.type === 'tezgah' || order.type === 'gelal') && (order.status === 'acik' || order.status === 'kapali') && (asksNumarator(mode) || !!order.numarator),
    },
    { group: 'adisyon', icon: <StickyNote className="size-5" />, label: order.note ? 'Notu değiştir' : 'Not ekle', onClick: () => { setNoteText(order.note ?? ''); setDialog('not'); }, show: editable },
    { group: 'adisyon', icon: <Printer className="size-5" />, label: 'Hesap yazdır', onClick: printBill, show: !isOnline && order.items.some((i) => !i.voided) },
    { group: 'adisyon', icon: <CircleDollarSign className="size-5" />, label: 'Adisyonu kapat', hint: 'Ödenecek tutar yok', onClick: closeZero, show: zeroClose },
    { group: 'adisyon', icon: <RotateCcw className="size-5" />, label: 'Yeniden aç', hint: 'Yetkili onayı ister', onClick: () => setDialog('yenidenac'), show: order.status === 'kapali' && !isOnline },
    // Ciro dışı kapanış (ikram, ödenmez, zayi): ödeme alınmamış adisyonun bütün kalemleri (kısmen ödenmişte kalan kalem kalem yazılır)
    ...COMP_KINDS.map((kind) => ({ group: 'ciro' as const, icon: COMP_ICON[kind], label: COMP_CLOSE_LABEL[kind], hint: COMP_HINT[kind], onClick: () => compAll(kind), show: compable })),
    { group: 'ekran', icon: <MonitorUp className="size-5" />, label: displayCode ? 'Müşteri ekranı: açık' : 'Müşteri ekranı', hint: 'İkinci ekran ya da müşteriye dönük tablet', onClick: () => setDialog('ekran'), show: !isOnline },
    { group: 'ekran', icon: <PackageX className="size-5" />, label: 'Tükenen ürünler', hint: 'Ürünü ya da seçeneği tükendi işaretle, satışa aç', onClick: () => setDialog('tukendi'), show: can('urun.tukendi') || can('menu.yonet') },
    { group: 'tehlike', icon: <Ban className="size-5" />, label: 'Adisyonu iptal et', hint: 'Bütün kalemler iptal olur', onClick: () => setDialog('iptal'), show: editable && order.paid === 0, danger: true },
  ];
  const menuSections = MENU_GROUPS.map(([group, label]) => ({ group, label, items: menuItems.filter((m) => m.show && m.group === group) })).filter((s) => s.items.length > 0);

  // Durum çipleri: başlığın altında, bir bakışta (kapanmış, iptal, birleşmiş; hesap yazdırıldı, kısmen ödendi, bölündü,
  // gönderilmemiş ürün). Online siparişin "Sitede ödendi"si hemen altındaki mor şeritte, burada yinelenmez
  const chips: { key: string; tone: BadgeTone; label: string }[] = [
    ...(order.status !== 'acik'
      ? [{ key: 'durum', tone: (order.status === 'kapali' ? 'green' : order.status === 'iptal' ? 'red' : 'neutral') as BadgeTone, label: order.status === 'kapali' ? 'Kapandı' : order.status === 'iptal' ? 'İptal' : 'Birleşti' }]
      : []),
    ...(isOpen && !isOnline && order.billPrintedAt ? [{ key: 'hesap', tone: 'warn' as const, label: 'Hesap yazdırıldı' }] : []),
    ...(isOpen && order.paid > 0 && due > 0 ? [{ key: 'kismen', tone: 'pink' as const, label: 'Kısmen ödendi' }] : []),
    ...(isOpen && order.split ? [{ key: 'bolundu', tone: 'neutral' as const, label: `${order.split.people} kişiye bölündü` }] : []),
    ...(pendingCount > 0 ? [{ key: 'bekleyen', tone: 'warn' as const, label: `${pendingCount} ürün gönderilmedi` }] : []),
  ];
  // Başlık: Gabarito masa adı ve numara; künye (kişi, garson, açılış saati ve süresi, müşteri, not); durum çipleri
  const header = (
    // Telefonda tam ekran: ana ekrandan açılan uygulamada çentik ve durum çubuğu payı
    <div className="border-b border-[var(--admin-divider)] bg-surface px-2 pb-2.5 pt-[max(0.5rem,env(safe-area-inset-top))]">
      <div className="flex items-start gap-1.5">
        <IconButton label="Geri" onClick={goBack}>
          <ArrowLeft className="size-5" />
        </IconButton>
        <div className="min-w-0 flex-1 pt-1">
          <div className="flex min-w-0 items-baseline gap-2">
            {titleBadge && <span className="self-center">{titleBadge}</span>}
            <h1 className="min-w-0 truncate font-headline text-xl font-bold leading-tight tracking-[-0.01em] lg:text-[22px]">{title}</h1>
            <span className="tabular shrink-0 text-[13px] text-muted">#{orderNo}</span>
          </div>
          {/* Künye: boş parça düşer ("—" ve "0 dk" yok); kişi sayısı yalnız masada anlamlı */}
          <div className="mt-0.5 truncate text-xs text-muted">
            {joinMeta([
              titleType,
              order.type === 'masa' && `${order.guests} kişi`,
              order.waiterName,
              `açılış ${fmtTime(order.openedAt)}`,
              isOpen && now - order.openedAt >= 60_000 && fmtElapsed(order.openedAt, now),
              order.customer?.name,
              order.note && `Not: ${order.note}`,
            ])}
          </div>
          {chips.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {chips.map((c) => (
                <Badge key={c.key} tone={c.tone}>
                  {c.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {!REMOTE && (
          // Telefonda İşlemler başlıkta (ürünler görünümünde de erişilir); tablet ve bilgisayarda hızlı işlemlerin sonunda
          <div className="md:hidden">
            <IconButton label="İşlemler" onClick={() => setDialog('menu')}>
              <MoreVertical className="size-5" />
            </IconButton>
          </div>
        )}
      </div>
    </div>
  );

  // Boş adisyonda (blank, yukarıda) devre dışı "Hesap" ve "Ödeme · ₺0,00" çizilmez. Masada tek eylem masayı boşaltmak
  // (sunucu boş adisyonu nedensiz kapatır, kayda "boş adisyon kapatıldı" yazar); tezgâhta şerit yok, boş durum yeter.
  // Masada başka adisyon da varsa (ayrı hesap) masa boşalmaz, yalnız bu boş hesap kapanır. Masa planı henüz gelmediyse
  // söz nötr ("Boş hesabı kapat"): masa dolu kalırken "Masa boşaltıldı" denmesin
  const tableChecks = order.tableId ? floor.data?.tables[order.tableId] : undefined;
  const sharesTable = !!order.tableId && (!floor.data || (tableChecks ?? []).some((o) => o.id !== order.id));
  const isRoom = table?.kind === 'oda';
  const place = table?.name ?? (isRoom ? 'Oda' : 'Masa');
  const [blankLabel, blankAsk, blankDone] =
    order.type !== 'masa'
      ? ['Boş siparişi kapat', 'Boş sipariş kapatılsın mı', 'Sipariş kapatıldı']
      : sharesTable
        ? ['Boş hesabı kapat', 'Boş hesap kapatılsın mı', 'Hesap kapatıldı']
        : isRoom
          ? ['Odayı boşalt', `${place} boşaltılsın mı`, 'Oda boşaltıldı']
          : ['Masayı boşalt', `${place} boşaltılsın mı`, 'Masa boşaltıldı'];
  // Başkasının adisyonunda önce sorulur: başka bir cihazda girilen ya da "Bu cihazda beklesin" denen ürünler bu cihazdan
  // görünmez; boşaltılınca o cihazın Gönder'i "Bu adisyon kapalı" alır, sipariş yeniden girilir. Kendi adisyonunda
  // (yanlış masa açıldı) tek dokunuş
  const ownCheck = !!me && order.waiterId === me.id;
  const clearBlank = async () => {
    if (flowBusy.current) return;
    if (
      !ownCheck &&
      !(await confirmDialog({
        title: blankAsk,
        body: order.waiterName ? `${order.waiterName} başka bir cihazda ürün giriyor olabilir; gönderilmemiş ürünler kaybolur` : 'Başka bir cihazda gönderilmemiş ürün varsa kaybolur',
        confirmLabel: blankLabel,
      }))
    )
      return;
    await once(async () => {
      const done = await act(() => post<OrderDTO>(`/orders/${order.id}/cancel`, { reason: '' }), blankDone);
      if (done) navigate(backPath);
    });
  };
  const backButton = (
    <Button size="lg" block icon={<ArrowLeft className="size-4" />} onClick={() => navigate(backPath)}>
      {order.tableId ? 'Masalara dön' : 'Siparişlere dön'}
    </Button>
  );
  // Gönderilmemişleri silmek: kare çöp kutusu (geri alınabilir); birincil düğme satırın kalanını alır
  const discardButton = (
    <IconButton label="Gönderilmemişleri sil" variant="secondary" size="lg" disabled={sending} onClick={discardPending}>
      <Trash2 className="size-4" />
    </IconButton>
  );
  // Tek birincil eylem mürekkep "Öde · ₺X" (gönderilmemiş varsa önce gönderir); gönderilmemiş kalem varken ikincil
  // "Bara gönder (N)". Ödeme alamayan (garson) için birincil eylem göndermek ya da hesabı yazdırmak. Tutar gönderilmemişler
  // dahil tahmini (sunucu gönderince yeniden hesaplar). Izgara izleri en küçük 0: büyük tutar da kartın içinde kalır
  const canPay = can('odeme.al');
  const payNow = (previewTotals(boot, order, pending)?.total ?? order.total) - order.paid;
  const sendLabel = `Bara gönder (${pendingCount})`;
  const barContent = blank ? (
    counter ? null : editable ? (
      <Button size="lg" block icon={<X className="size-4" />} loading={sending} onClick={() => void clearBlank()}>
        {blankLabel}
      </Button>
    ) : (
      backButton
    )
  ) : pending.length > 0 && canPay ? (
    // İki satır: üstte ikincil eylemler (sil, Bara gönder), altta tek birincil eylem satırın tamamında: ikisi de tam
    // yazılır (dar hesap kartında üç düğme yan yana sığmıyordu)
    <div className="grid gap-2">
      <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
        <IconButton label="Gönderilmemişleri sil" variant="secondary" disabled={sending} onClick={discardPending}>
          <Trash2 className="size-4" />
        </IconButton>
        <Button loading={sending} icon={<Send className="size-4" />} onClick={sendOnly} className="min-w-0">
          <span className="truncate">{sendLabel}</span>
        </Button>
      </div>
      <Button size="lg" variant="ink" block loading={sending} onClick={() => void sendAndPay()}>
        <PayLabel action="Öde" amount={payNow} inline />
      </Button>
    </div>
  ) : pending.length > 0 ? (
    <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
      {discardButton}
      <Button size="lg" variant="primary" loading={sending} icon={<Send className="size-4" />} onClick={sendOnly}>
        {sendLabel}
      </Button>
    </div>
  ) : isOpen && !isOnline && !REMOTE && !canPay && !zeroClose ? (
    // Garson ödeme alamaz: birincil eylemi hesabı yazdırmak; devre dışı bir "Öde" düğmesi yerine kısa açıklama. Tutarı
    // sıfır adisyonu kapatmak ödeme değil, sipariş işi: o zaman aşağıdaki kapanış şeridi
    <>
      <Button size="lg" variant="primary" block icon={<Printer className="size-4" />} onClick={printBill} disabled={!hasItems}>
        Hesap yazdır
      </Button>
      <p className="-mt-0.5 text-center text-xs text-muted">Ödemeyi kasa alır</p>
    </>
  ) : isOpen && !isOnline && !REMOTE ? (
    zeroClose ? (
      <Button size="lg" variant="ink" block loading={sending} onClick={closeZero}>
        Adisyonu kapat
      </Button>
    ) : (
      <Button size="lg" variant="ink" block disabled={due <= 0} onClick={() => setDialog('odeme')}>
        <PayLabel action="Öde" amount={due} inline />
      </Button>
    )
  ) : (
    backButton
  );
  // Eylem şeridi: hızlı işlemlerle birlikte ölçülen alt blokta (aşağıda `right`)
  const actionBar = barContent && (
    <div className="grid gap-2 border-t border-[var(--admin-divider)] bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      {barContent}
    </div>
  );

  // Hızlı işlemler, sakin bir sırada ve tek dokunuşla: Böl, İndirim, Taşı, Hesap yazdır, İşlemler. Garsonun birincil
  // eylemi hesabı yazdırmaksa burada yinelenmez; İşlemler telefonda başlıkta (ürünler görünümünde de erişilsin)
  const printIsPrimary = isOpen && !isOnline && !canPay && !zeroClose && !pending.length;
  const quickActions = [
    { key: 'bol', label: 'Böl', icon: <Split />, onClick: () => setDialog('bol'), show: editable && order.items.some((i) => !i.voided && i.qty - i.paidQty > 0) },
    { key: 'indirim', label: 'İndirim', icon: <Percent />, onClick: () => setDialog('indirim'), show: editable && hasItems },
    { key: 'tasi', label: 'Taşı', icon: <ArrowRightLeft />, onClick: () => setDialog('tasi'), show: editable },
    { key: 'yazdir', label: 'Hesap yazdır', icon: <Printer />, onClick: printBill, show: !isOnline && !REMOTE && hasItems && !printIsPrimary },
    { key: 'islemler', label: 'İşlemler', icon: <MoreHorizontal />, onClick: () => setDialog('menu'), show: !REMOTE, wideOnly: true },
  ].filter((q) => q.show);
  const quickRow = quickActions.some((q) => !q.wideOnly) || (wide && quickActions.length > 0) ? (
    <div role="group" aria-label="Hızlı işlemler" className="flex gap-1 border-t border-[var(--admin-divider)] px-2 pt-2">
      {quickActions.map((q) => (
        <button
          key={q.key}
          type="button"
          onClick={q.onClick}
          className={cn(
            'flex min-h-[52px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1 text-center text-[11px] font-medium leading-tight text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-press [&>svg]:size-[18px] [&>svg]:shrink-0',
            q.wideOnly && 'max-md:hidden',
          )}
        >
          {q.icon}
          {/* Dar kartta iki satıra kırılır ("Hesap / yazdır"), kesilmez */}
          <span className="max-w-full text-balance break-words">{q.label}</span>
        </button>
      ))}
    </div>
  ) : null;

  // Telefonda önce ürünler: alttaki yapışkan sepet çubuğu ("3 ürün · ₺780 · Sepet") sepeti açar. Kalemsiz adisyonda da
  // durur: oda sayacı (Başlat), "Masayı boşalt" ve boş durum sepette. Gönderilmemiş ürün varsa yanında "Bara gönder"
  // (sepeti açmadan gönderilir; adedi çantadaki sayaçta, erişilebilir adı "Bara gönder (N)"): 360-390 px telefonda tutar
  // kısa yazılır ve kesilmez
  const itemCount = order.items.filter((i) => !i.voided).reduce((a, i) => a + i.qty, 0) + pendingCount;
  const cartTotal = previewTotals(boot, order, pending)?.total ?? order.total;
  const cartBar = (
    <div ref={measureActionBar} data-action-bar="" className="flex items-stretch gap-2 border-t border-[var(--admin-divider)] bg-surface px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
      <button
        ref={cartBarRef}
        type="button"
        onClick={() => showView('adisyon')}
        aria-label={`Sepet: ${itemCount} ürün, ${tl(cartTotal)}`}
        className="flex min-h-12 min-w-0 flex-1 items-center gap-2.5 rounded-2xl border border-line-strong bg-surface-2 px-3 text-left transition-colors duration-150 active:bg-press"
      >
        <span aria-hidden="true" className="relative grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink">
          <ShoppingBag className="size-[18px]" />
          {/* Gönderilmemiş adet amber sayaçta: yumuşak zemin, koyu amber yazı (iki temada da okunur) */}
          {pendingCount > 0 && (
            <span className="tabular absolute -right-1.5 -top-1.5 min-w-5 rounded-full bg-[var(--admin-warning-soft)] px-1 text-center text-[11px] font-semibold leading-5 text-[var(--admin-warning)] ring-1 ring-[var(--admin-warning-line)]">
              {pendingCount}
            </span>
          )}
        </span>
        <span aria-hidden="true" className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-xs text-muted">{itemCount > 0 ? `${itemCount} ürün` : 'Sepet boş'}</span>
          <span className="tabular block whitespace-nowrap font-headline text-lg font-bold">{tlShort(cartTotal)}</span>
        </span>
        <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-0.5 text-sm font-semibold text-ink">
          {pending.length === 0 && 'Sepet'}
          <ChevronRight className="size-4" />
        </span>
      </button>
      {pending.length > 0 && (
        <Button size="lg" variant="primary" loading={sending} icon={<Send className="size-4" />} onClick={sendOnly} aria-label={sendLabel} className="shrink-0 px-4">
          Bara gönder
        </Button>
      )}
    </div>
  );

  const right = (
    <div className="flex min-h-0 flex-1 flex-col bg-surface">
      {isOnline && <OnlineOrderBar order={order} act={act} />}
      {!REMOTE && (can('mutfak.ekran') || can('siparis.al')) && <ReadyBar order={order} name={call ? callText(call) : `${title} #${orderNo}`} />}
      {table?.kind === 'oda' && (order.room || editable) && <RoomBox order={order} table={table} editable={editable} act={act} now={now} onClosed={() => navigate(backPath)} />}
      <CartPanel
        order={order}
        pending={pending}
        onEditPending={(l) => {
          const p = boot.products.find((x) => x.id === l.productId);
          if (p) setOptions({ product: p, size: l.size, editing: l });
        }}
        // Taşı ve not sipariş işi: ürün eklenemeyen adisyonda (yalnız ödeme alan rol, kapanmış, online) kalem penceresinde yok
        onMoveItem={
          editable
            ? (item) => {
                setMoveItem({ itemId: item.id, qty: item.qty - item.paidQty });
                setDialog('bol');
              }
            : undefined
        }
        canNote={editable}
        act={act}
      />
      {(quickRow || actionBar) && (
        // Telefonda bildirim bu bloğun üstünde durur (data-action-bar, boyu --action-bar-h): Gönder, Öde ve hızlı
        // işlemleri örtmez
        <div ref={measureActionBar} data-action-bar="">
          {quickRow}
          {actionBar}
        </div>
      )}
    </div>
  );

  return (
    <div className="flex h-full flex-col">
      {wide ? (
        // Innex: iki beyaz kart; solda katalog, sağda adisyon (başlığıyla)
        <div className="flex min-h-0 flex-1 gap-3">
          {/* Ürün eklenemeyen adisyonda (kapanmış, online, uzaktan, siparişe yetkisiz rol) katalog çizilmez: soluk ama
              aranabilir yarım ekran yerine adisyon ortada */}
          {editable && (
            <section className="min-w-0 flex-1 overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]">
              <ProductPanel onQuickAdd={quickAdd} onCustomize={(p, size) => setOptions({ product: p, size, editing: null })} />
            </section>
          )}
          <section className={cn('flex shrink-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-card)]', editable ? 'w-[clamp(300px,40vw,440px)]' : 'mx-auto w-full max-w-2xl')}>
            {header}
            {right}
          </section>
        </div>
      ) : (
        <>
          {header}
          <div className="min-h-0 flex-1">
            {tab === 'menu' && editable ? (
              <div className="flex h-full flex-col">
                <div className="min-h-0 flex-1">
                  <ProductPanel onQuickAdd={quickAdd} onCustomize={(p, size) => setOptions({ product: p, size, editing: null })} />
                </div>
                {cartBar}
              </div>
            ) : (
              <div className="flex h-full flex-col">
                {editable && (
                  // Sepetten ürünlere dönüş: başlığın Geri'si masalara gider, bu düğme menüye
                  <button
                    ref={addProductRef}
                    type="button"
                    onClick={() => showView('menu')}
                    className="flex min-h-11 items-center gap-2 border-b border-[var(--admin-divider)] bg-surface px-4 text-sm font-semibold text-primary transition-colors duration-150 active:bg-press"
                  >
                    <Plus aria-hidden="true" className="size-4" />
                    Ürün ekle
                  </button>
                )}
                {right}
              </div>
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
        <div className="px-3 pb-3">
          {menuSections.map((s, si) => (
            <section key={s.group} className={cn(s.group === 'tehlike' && 'mt-2 border-t border-[var(--admin-divider)] pt-2', !s.label && si === 0 && 'pt-3')}>
              {s.label && <h3 className={cn('px-3 pb-1 font-sans text-xs font-medium tracking-normal text-muted', si === 0 ? 'pt-3' : 'pt-4')}>{s.label}</h3>}
              <div className="grid gap-1">
                {s.items.map((m) => (
                  <button
                    key={m.label}
                    onClick={() => {
                      setDialog(null);
                      m.onClick();
                    }}
                    className={cn('flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors duration-150 hover:bg-hover active:bg-press', m.danger && 'text-[var(--admin-danger-ink)]')}
                  >
                    <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', m.danger ? 'bg-[var(--admin-danger-soft)]' : 'bg-surface-3 text-ink-2')}>
                      {m.icon}
                    </span>
                    <span>
                      <span className="block text-sm font-medium">{m.label}</span>
                      {m.hint && <span className="block text-xs text-muted">{m.hint}</span>}
                    </span>
                  </button>
                ))}
              </div>
            </section>
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
          {/* Adres uygulamanın kökünden (demoda /demo öneki korunur); tablete elle yazılacağı için koyu ve kırılabilir */}
          <p className="text-xs text-muted">
            İkinci monitörde pencereyi oraya taşıyıp tam ekran yapın. Müşteriye dönük tablette tarayıcıda{' '}
            <span className="break-all font-medium text-ink-2">{new URL(appUrl('/musteri-ekrani'), window.location.origin).href}</span> adresini açın; personel girişi gerekmez
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
            // Ciro dışı kapanışta (ikram, ödenmez, zayi) tahsilat yok: müşteri ekranı tutarla teşekkür etmez, hoş geldinize döner.
            // Bara giden kalemi olan self servis satışında teşekkür çağrı numarasını da söyler ("No 34", "Masa 12")
            const thanksCall = call && !order.platform && order.items.some((i) => !i.voided && i.stationId) ? callText(call) : null;
            sendDisplay(displayCode, opts?.comp ? { kind: 'idle' } : { kind: 'thanks', total: order.total, ...(thanksCall ? { call: thanksCall } : {}) });
            if (counter) void nextSale();
            else navigate(backPath);
          }
        }}
      />
      <MoveModal order={order} open={dialog === 'tasi'} onClose={() => setDialog(null)} act={act} onMoved={(target) => { setDialog(null); if (target) navigate(`/adisyon/${target}`, { replace: true }); }} />
      <TransferModal
        order={order}
        open={dialog === 'bol'}
        initial={moveItem}
        onClose={() => {
          setDialog(null);
          setMoveItem(null);
        }}
        act={act}
        onDone={() => {
          setDialog(null);
          setMoveItem(null);
        }}
      />
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
      <OdenmezModal
        open={dialog === 'odenmez'}
        title="Ödenmez kapat · kimin adına?"
        subtitle={compCloseSubtitle('odenmez', tl(order.total))}
        confirmLabel={() => COMP_CONFIRM_LABEL.odenmez}
        onClose={() => setDialog(null)}
        onConfirm={async ({ person, reason }) => {
          const res = await act((pin) => post(`/orders/${order.id}/comp`, { kind: 'odenmez', reason, person, approverPin: pin }), COMP_DONE_TOAST.odenmez);
          if (res) {
            cart.clear(order.id);
            navigate(backPath);
          }
        }}
      />
      {COMP_KINDS.filter((kind) => kind !== 'odenmez').map((kind) => (
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
      {/* Not yalnız kaydedilince kapanır (act hatada bildirir, null döner; yazılan not kaybolmaz); istek sürerken kapanmaz */}
      <Modal
        open={dialog === 'not'}
        onClose={() => setDialog(null)}
        persistent={savingNote}
        title="Adisyon notu"
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setDialog(null)} disabled={savingNote}>
              Vazgeç
            </Button>
            <Button
              variant="primary"
              loading={savingNote}
              onClick={async () => {
                setSavingNote(true);
                const saved = await act(() => patch<OrderDTO>(`/orders/${order.id}`, { note: noteText }));
                setSavingNote(false);
                if (saved) setDialog(null);
              }}
            >
              Kaydet
            </Button>
          </div>
        }
      >
        <div className="p-4">
          <Textarea value={noteText} onChange={(e) => setNoteText(e.target.value.slice(0, 300))} className="min-h-24" placeholder="Ör. doğum günü, pastayı 21:00’de getir" aria-label="Adisyon notu" />
        </div>
      </Modal>
      <Modal open={dialog === 'cikis'} onClose={() => setDialog(null)} title="Gönderilmemiş ürünler var" subtitle={`${pendingCount} ürün henüz bara ya da mutfağa gitmedi`} size="sm">
        <div className="grid gap-2 p-4">
          {/* Tek seferlik (once): çift dokunuş kalemleri bara iki kez göndermez; gönderilemezse pencere açık kalır */}
          <Button
            variant="primary"
            size="lg"
            icon={<Send className="size-4" />}
            loading={sending}
            onClick={() =>
              void once(async () => {
                if (!(await send())) return;
                setDialog(null);
                navigate(backPath);
              })
            }
          >
            Gönder ve çık
          </Button>
          <Button size="lg" onClick={() => navigate(backPath)}>
            Bu cihazda beklesin
          </Button>
          {/* Gönderim sürerken silinmez (discardPending): düğme de kapalı, "sildim" sanılıp kalemler bara gitmesin */}
          <Button variant="dangerGhost" disabled={sending} onClick={() => { discardPending(); navigate(backPath); }}>
            Sil ve çık
          </Button>
        </div>
      </Modal>
    </div>
  );
}
