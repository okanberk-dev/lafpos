import { SwipeRow } from '@/components/ui/SwipeRow';
import { ArrowRightLeft, Check, ChefHat, CircleDot, Droplets, Gift, HandCoins, Percent, StickyNote, Undo2, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { COMP_LABEL, compReasonsOf } from '@shared/comp';
import { tl } from '@shared/money';
import { holdsUntilPaid } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { CompKind, OrderDTO, OrderItemDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Chip, Input, Label, Segmented, Stepper } from '@/components/ui/Field';
import { EmptyState, SizeTag } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { post, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { estimateUnit, pendingOptionsText, pendingProblem, useBoot } from '@/lib/boot';
import { type PendingLine, useCart } from '@/lib/cart';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/hooks';
import { previewTotals } from '@/lib/estimate';
import { REMOTE } from '@/lib/remote';
import { parseTL } from '@shared/money';
import { groupTyped } from '@/lib/numpad';
import { OdenmezModal } from './OdenmezModal';
import { TypedAmount } from './TypedAmount';
import { CART_GROUP_LABEL, type CartGroupKey, groupCartItems } from './cartGroups';

/**
 * Boy rozeti yalnız iki boyu olan üründe (ya da Büyük seçildiyse): tek boylu üründe "Orta" bilgi taşımaz, Türk kahvesinin
 * "Orta" şekeriyle aynı satırda iki kez okunuyordu
 */
function twoSizes(boot: { products: { id: string; priceL: number | null }[] }, productId: string | null | undefined, size: string): size is 'M' | 'L' {
  if (size === 'TEK') return false;
  if (size === 'L') return true;
  return boot.products.find((p) => p.id === productId)?.priceL != null;
}

// Kalemin bardaki durumu, bar ekranıyla aynı dil: hazırlanıyor mavi, hazır yeşil (amber yalnız zamana); ikon ve yazı da var
/** Grup başlığının noktası: barda kobalt (hazırlanıyor), hazır yeşil, teslim nötr, iptal kırmızı; Gönderilmedi amber */
const GROUP_DOT: Record<CartGroupKey, string> = {
  odeme: 'bg-[var(--admin-warning)]',
  barda: 'bg-blue-ink',
  hazir: 'bg-[var(--admin-success)]',
  teslim: 'bg-[var(--admin-border-field)]',
  iptal: 'bg-[var(--admin-danger)]',
};

const STATUS: Record<OrderItemDTO['status'], { label: string; cls: string }> = {
  yeni: { label: 'Bara gitti', cls: 'text-muted' },
  hazirlaniyor: { label: 'Hazırlanıyor', cls: 'text-blue-ink' },
  hazir: { label: 'Hazır', cls: 'text-[var(--admin-success)]' },
  servis: { label: 'Serviste', cls: 'text-muted' },
};

/**
 * Ciro dışı kalemin işareti, ikonu İşlemler ve ödeme ekranındakiyle aynı: ücretsiz verilen (ikram, ödenmez) pirinç
 * (hediye ve ödülün, damga kartının rengi), zayi (kayıp) amber. Pembe yalnız masa planında "kısmen ödendi", kırmızı
 * iptal; burada kullanılmaz
 */
const COMP_MARK: Record<CompKind, { Icon: typeof Gift; cls: string }> = {
  ikram: { Icon: Gift, cls: 'text-gold-ink' },
  odenmez: { Icon: HandCoins, cls: 'text-gold-ink' },
  zayi: { Icon: Droplets, cls: 'text-warning-ink' },
};

export function CartPanel({
  order,
  pending,
  onEditPending,
  onMoveItem,
  canNote = false,
  act,
}: {
  order: OrderDTO;
  pending: PendingLine[];
  onEditPending: (line: PendingLine) => void;
  /** Kalem işlemlerinden "Taşı": kalemi başka hesaba ya da masaya taşıma penceresi bu kalem seçili açılır */
  onMoveItem?: (item: OrderItemDTO) => void;
  /** Gönderilmiş kaleme not: sipariş işi (sunucu `siparis.al` ister); yalnız ödeme alan rolde kalem penceresinde yok */
  canNote?: boolean;
  act: <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const boot = useBoot();
  const cart = useCart();
  const can = useCan();
  // Self ve yarı self servis, ayrıca masa servisinde kasanın kendi tezgâh satışı: "Öde" kalemleri ödeme bekleyen olarak
  // ekler, ödeme alınınca bara gider (holdsUntilPaid). Ödeme alamayan rolün (garson) tek düğmesi "Bara gönder": ona
  // eski ipucu
  const payFirst = holdsUntilPaid(order) && can('odeme.al');
  const barOn = boot.settings.barEnabled !== false;
  // "Ödemeden gönder" istek sürerken kilitli: çift dokunuş ikinci isteği yollayıp başarının ardından hata göstermesin
  const releasing = useRef(false);
  const [sendingHeld, setSendingHeld] = useState(false);
  const sendHeldNow = async () => {
    if (releasing.current) return;
    releasing.current = true;
    setSendingHeld(true);
    try {
      await act(() => post<OrderDTO>(`/orders/${order.id}/release`, {}), 'Bara gönderildi');
    } finally {
      releasing.current = false;
      setSendingHeld(false);
    }
  };
  const [itemSheet, setItemSheet] = useState<OrderItemDTO | null>(null);
  const t = order.totals;
  const due = order.total - order.paid;

  const preview = previewTotals(boot, order, pending);
  // Boş adisyon yönergesi ekranın yerleşimine göre: geniş ekranda ürünler solda, telefonda Menü sekmesinde
  const wide = useMediaQuery('(min-width: 768px)');

  const visibleItems = order.items.filter((i) => !i.voided || i.voidAfterSend || Date.now() - (i.createdAt ?? 0) < 3600_000);
  const empty = visibleItems.length === 0 && pending.length === 0 && order.paid === 0;
  // Kalemler duruma göre gruplu (bir bakışta): Gönderilmedi (cihazdaki sepet, en üstte), Barda, Hazır, Teslim, İptal
  const groups = groupCartItems(visibleItems);
  const groupHead = 'sticky top-0 z-[1] flex items-center gap-1.5 bg-surface px-4 pb-1 pt-3 font-sans text-xs font-medium tracking-normal text-muted';

  // Yeni eklenen kalem uzun adisyonda da görünsün: gönderilmemişler bloğu görünür alana kayar
  const pendingRef = useRef<HTMLElement>(null);
  const pendingQty = pending.reduce((a, l) => a + l.qty, 0);
  useEffect(() => {
    if (!pending.length) return;
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    pendingRef.current?.scrollIntoView({ block: 'end', behavior: reduce ? 'auto' : 'smooth' });
  }, [pending.length, pendingQty]);

  // Ödeme sürerken büyük rakam kalan tutar; kapanmış ya da ödenmemiş adisyonda toplam
  const partlyPaid = order.paid > 0 && !order.extPaid && due > 0 && !preview;

  return (
    // En az 12 rem (kalem listesi en az 3 rem, altında toplamlar): alçak ekranda (yatay telefon, kapanış kartı varken)
    // toplamlar eylem şeridinin üstüne binmez; yer kalmazsa hesap yaprağı bütünüyle kayar (OrderPage `right`)
    <div data-cart-panel="" className="flex min-h-48 flex-1 flex-col">
      <div className="scroll-thin flex min-h-12 flex-1 flex-col overflow-y-auto">
        {empty && (
          <EmptyState art="fincan" title="Adisyon boş" className="my-auto">
            {wide ? 'Soldan ürün seçin. ' : '“Ürün ekle”ye dokunup ürün seçin. '}
            {/* Bar ekranı ayardan kapalıysa (barEnabled) sipariş bara gitmez: kaydetmeyi ya da ödemeyi söyler */}
            {!barOn ? (payFirst ? 'Ödeme alınınca satış tamamlanır' : '“Kaydet”e basınca ürünler adisyona yazılır') : payFirst ? 'Ödeme alınınca sipariş bara gider' : '“Bara gönder”e basınca sipariş bara ve mutfağa gider'}
          </EmptyState>
        )}
        {pending.length > 0 && (
          // Gönderilmemişler (bu cihazın sepeti) en üstte, öteki gruplarla aynı sade başlıkla: amber yalnız noktada
          // (operatör 20 Kas 2026: "satış kısmını minimalist, temiz"; amber zemin ve dört ayrı uyarı kalktı)
          <section ref={pendingRef} aria-label={CART_GROUP_LABEL.gonderilmedi}>
            <h3 className={groupHead}>
              <span aria-hidden="true" className="size-1.5 rounded-full bg-[var(--admin-warning)]" />
              {CART_GROUP_LABEL.gonderilmedi}
              <span className="tabular font-normal">· {pendingQty}</span>
            </h3>
            <ul className="divide-y divide-[var(--admin-divider)]">
              {pending.map((l) => {
                const p = boot.products.find((x) => x.id === l.productId);
                if (!p) return null;
                const unit = l.priceOverride ?? estimateUnit(boot, p, l.size, l.options);
                const text = [pendingOptionsText(boot, p, l.options), l.priceOverride != null ? 'elle fiyat' : ''].filter(Boolean).join(' · ');
                // Sunucunun reddedeceği satır (seçeneği tükendi, grubu kapandı): Gönder'in 409 / 400 bildirimi satırı
                // adlandırmaz, burada kırmızı yazar; dokununca düzenleme penceresi açılır
                const problem = pendingProblem(boot, p, l.options);
                const name = p.shortName || p.name;
                return (
                  // Dar hesap kartında (telefon, tablet) ad, seçenek ve not ilk satırın tamamını alır; adet ve tutar altta.
                  // Bilgisayarda tek satır. Odak sırası geniş düzenin sırası (adet, ad, tutar)
                  // Sola kaydırınca satır silinir (SwipeRow); adet düğmesi de siler
                  <SwipeRow key={l.key} onRemove={() => cart.remove(order.id, l.key)} className="animate-in" rowClassName="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 py-2 lg:flex-nowrap">
                    <Stepper
                      quiet
                      value={l.qty}
                      min={1}
                      max={99}
                      label={`${name} adedi`}
                      onChange={(n) => cart.update(order.id, l.key, { qty: n })}
                      onRemove={() => cart.remove(order.id, l.key)}
                    />
                    {/* Satırın kendisi düzenlemeye açar (seçenek, not, fiyat) */}
                    <button
                      className="order-first flex min-h-11 min-w-0 basis-full items-center gap-2 rounded-[var(--r-btn)] text-left transition-colors duration-150 hover:bg-hover active:bg-press lg:order-none lg:flex-1 lg:basis-0 lg:px-2"
                      onClick={() => onEditPending(l)}
                      aria-label={`${name} düzenle`}
                      aria-describedby={problem ? `sorun-${l.key}` : undefined}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {name}
                          {twoSizes(boot, l.productId, l.size) && <SizeTag>{boot.settings.sizeLabels[l.size]}</SizeTag>}
                        </span>
                        {(text || l.note) && <span className="block truncate text-xs text-ink-2">{[text, l.note && `Not: ${l.note}`].filter(Boolean).join(' · ')}</span>}
                        {problem && (
                          <span id={`sorun-${l.key}`} className="block truncate text-xs font-medium text-[var(--admin-danger-ink)]">
                            {problem}
                          </span>
                        )}
                      </span>
                    </button>
                    <span className="tabular ml-auto whitespace-nowrap text-right text-sm font-semibold">{tl(unit * l.qty)}</span>
                  </SwipeRow>
                );
              })}
            </ul>
          </section>
        )}
        {groups.map((g) => (
          <section key={g.key} aria-label={g.label}>
            <h3 className={groupHead}>
              <span aria-hidden="true" className={cn('size-1.5 rounded-full', GROUP_DOT[g.key])} />
              {g.label}
              <span className="tabular font-normal">· {g.items.reduce((a, i) => a + i.qty, 0)}</span>
              {/* Ödeme bekleyen: ödeme alınınca kendiliğinden bara gider; kasiyer isterse ödemeden gönderir */}
              {g.key === 'odeme' && order.status === 'acik' && !REMOTE && can('siparis.al') && (
                <Button variant="ghost" size="sm" onClick={() => void sendHeldNow()} disabled={sendingHeld} aria-busy={sendingHeld || undefined} className="-my-2 ml-auto px-2.5 font-semibold text-primary hover:text-primary">
                  Ödemeden gönder
                </Button>
              )}
            </h3>
            {g.key === 'odeme' && <p className="px-4 pb-1.5 text-xs text-muted">Ödeme alınınca bara ve mutfağa gider</p>}
            <ul className="divide-y divide-[var(--admin-divider)]">
              {g.items.map((i) => (
                <li key={i.id}>
                  <button
                    onClick={() => !i.voided && !order.extPaid && order.status === 'acik' && setItemSheet(i)}
                    className={cn('flex min-h-12 w-full items-start gap-3 px-4 py-2.5 text-left transition-colors duration-150', !i.voided && order.status === 'acik' && 'hover:bg-hover active:bg-press')}
                  >
                    <span className={cn('tabular h-7 min-w-7 rounded-[var(--r-chip)] px-1.5 text-center text-[13px] font-semibold leading-7', i.voided ? 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]' : 'bg-surface-2 text-ink-2')}>
                      {i.qty}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block text-sm font-medium leading-snug', i.voided && 'text-muted line-through')}>
                        {i.name}
                        {twoSizes(boot, i.productId, i.size) && <SizeTag>{boot.settings.sizeLabels[i.size]}</SizeTag>}
                      </span>
                      {/* Seçenekler soluk tek satır, not ayrı satırda: kalem bir bakışta okunur, çip kalabalığı yok */}
                      {i.optionsText && <span className="mt-0.5 block text-xs text-ink-2">{i.optionsText}</span>}
                      {i.note && <span className="mt-0.5 block text-xs text-ink-2">Not: {i.note}</span>}
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs font-medium">
                        {i.voided ? (
                          <span className="text-[var(--admin-danger-ink)]">İptal: {i.voidReason}</span>
                        ) : (
                          <>
                            {/* Durum grubun başlığında; Barda'da bekliyor mu hazırlanıyor mu ayrıca yazar */}
                            {i.stationId && (g.key === 'barda' || order.extStage === 'gone') && (
                              <span className={cn('inline-flex items-center gap-0.5', STATUS[i.status].cls)}>
                                {i.status === 'hazir' ? <Check className="size-3.5" /> : i.status === 'servis' ? <CircleDot className="size-3.5" /> : <ChefHat className="size-3.5" />}
                                {/* Sitenin listesinden kalkan online sipariş servis edildi sayılmaz */}
                                {order.extStage === 'gone' && i.status === 'servis' ? 'Siteden kalktı' : STATUS[i.status].label}
                              </span>
                            )}
                            <span className="tabular font-normal text-muted">{fmtTime(i.sentAt)}</span>
                            {i.complimentary && <CompMark kind={i.compKind ?? 'ikram'} person={i.compPerson?.name} />}
                            {/* İndirim durum değil: nötr ve adıyla (mavi "Hazırlanıyor"la tek durum gibi okunmasın) */}
                            {i.discount > 0 && <span className="tabular text-ink-2">−{tl(i.discount)} indirim</span>}
                            {i.happyHour && <span className="text-[var(--admin-warning)]">Happy hour</span>}
                            {i.paidQty > 0 && <span className="text-[var(--admin-success)]">{i.paidQty === i.qty ? 'Ödendi' : `${i.paidQty} ödendi`}</span>}
                          </>
                        )}
                      </span>
                    </span>
                    <span className={cn('tabular whitespace-nowrap pt-0.5 text-right font-headline text-[15px] font-semibold', (i.voided || i.complimentary) && 'text-muted line-through')}>{tl(i.qty * i.unitPrice)}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>

      {/* Boş adisyonda "Toplam ₺0,00" yazılmaz: boş durum yeter */}
      {!empty && (
      <div className="border-t border-[var(--admin-divider)] px-4 py-3 text-sm">
        {(t.lineDiscounts + t.orderDiscount > 0 || t.complimentary > 0 || t.service > 0) && (
          <div className="mb-1.5 space-y-0.5 text-[13px] text-muted">
            <Row l="Ara toplam" r={tl(t.gross)} />
            {t.lineDiscounts + t.orderDiscount > 0 && <Row l={`İndirim${order.discountReason ? ` (${order.discountReason})` : ''}`} r={`−${tl(t.lineDiscounts + t.orderDiscount)}`} />}
            {/* Yalnız ikram varsa "İkram"; ödenmez ya da zayi de varsa hepsi birlikte "Ciro dışı" */}
            {t.complimentary > 0 && <Row l={order.items.some((i) => i.complimentary && !i.voided && i.compKind && i.compKind !== 'ikram') ? 'Ciro dışı' : 'İkram'} r={tl(t.complimentary)} />}
            {t.service > 0 && <Row l={`Servis %${order.serviceRate}`} r={tl(t.service)} />}
          </div>
        )}
        {partlyPaid && (
          <div className="mb-1 space-y-0.5 text-[13px] text-muted">
            <Row l="Toplam" r={tl(order.total)} />
            <Row l="Ödenen" r={tl(order.paid)} />
          </div>
        )}
        {/* Büyük sayı: etiket solda küçük (gönderilmemiş varken "tahmini"), tutar kalın ve sıkı */}
        <div className="flex items-end justify-between gap-3">
          <span className="pb-1 text-[13px] font-medium text-muted">
            {partlyPaid ? 'Kalan' : 'Toplam'}
            {preview && <span className="font-normal"> · tahmini</span>}
          </span>
          <span className="tabular font-headline text-[32px] font-bold leading-none tracking-[-0.05em]">{tl(partlyPaid ? due : preview ? preview.total : order.extPaid ? (order.extTotal ?? 0) : order.total)}</span>
        </div>
        {/* Tamamı ödendiyse vurgu sıfıra ("Kalan ₺0,00") değil ödemeye: yeşil "Ödendi". Gönderilmemiş ürün varken (yeniden
            açılmış, ödenmiş adisyona ekleme) tutar artacak: "Ödendi" değil, tahmini toplamdan kalan */}
        {order.paid > 0 &&
          !order.extPaid &&
          !partlyPaid &&
          (preview ? (
            <div className="mt-1 space-y-0.5 text-[13px] text-muted">
              <Row l="Ödenen" r={tl(order.paid)} />
              <Row l={<span className="font-semibold text-ink">Kalan</span>} r={<span className="font-semibold text-ink">{tl(Math.max(0, preview.total - order.paid))}</span>} />
            </div>
          ) : (
            <div className="mt-1 flex justify-between text-[13px] font-medium text-[var(--admin-success)]">
              <span className="inline-flex items-center gap-1">
                <Check aria-hidden="true" className="size-3.5" />
                Ödendi
              </span>
              <span className="tabular">{tl(order.paid)}</span>
            </div>
          ))}
      </div>
      )}

      <ItemSheet item={itemSheet} order={order} onClose={() => setItemSheet(null)} onMove={onMoveItem} canNote={canNote} act={act} />
    </div>
  );
}

const Row = ({ l, r }: { l: React.ReactNode; r: React.ReactNode }) => (
  <div className="flex justify-between">
    <span>{l}</span>
    <span className="tabular">{r}</span>
  </div>
);

/** Gönderilmiş kaleme dokununca: iptal, ikram, zayi, indirim. */
function ItemSheet({
  item,
  order,
  onClose,
  onMove,
  canNote,
  act,
}: {
  item: OrderItemDTO | null;
  order: OrderDTO;
  onClose: () => void;
  onMove?: (item: OrderItemDTO) => void;
  canNote: boolean;
  act: <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;
}) {
  const boot = useBoot();
  const can = useCan();
  const [mode, setMode] = useState<null | 'iptal' | 'ikram' | 'zayi' | 'indirim' | 'not'>(null);
  /** Not kipinde yazılan not (kalemin notuyla başlar) */
  const [noteText, setNoteText] = useState('');
  /** Ödenmez kişi seçicisi açık (kalem penceresinin yerine) */
  const [odenmez, setOdenmez] = useState(false);
  const [qty, setQty] = useState(1);
  const [reason, setReason] = useState('');
  const [discType, setDiscType] = useState<'percent' | 'amount'>('percent');
  const [discValue, setDiscValue] = useState('');
  /** Süren iptal, ikram, zayi ya da indirim isteği: çift dokunuş ya da ikinci Enter ikinci adedi yazmasın */
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);

  if (!item) return null;
  const unpaid = item.qty - item.paidQty;
  const close = () => {
    setMode(null);
    setOdenmez(false);
    setReason('');
    setDiscValue('');
    setQty(1);
    onClose();
  };
  // İstek sürerken pencere kapanmaz (Escape, arka plan, X): kapanıp başka kaleme geçilse, paylaşılan busy o kalemi
  // kilitler, süren isteğin sonundaki close() da onun penceresini kapatırdı
  const dismiss = () => {
    if (!busyRef.current) close();
  };
  const reasons = mode === 'iptal' ? boot.settings.voidReasons : mode === 'indirim' ? boot.settings.discountReasons : mode && mode !== 'not' ? compReasonsOf(boot.settings, mode) : [];

  // Boş ya da 0 değer indirimi kaldırır: yalnız kalemde indirim varken ve nedensiz ("İndirimi kaldır"). İndirimsiz kalemde
  // %0 ile "Uygula" açık kalıp olmayan bir kaldırmayı bildirmesin; değer yazılınca neden ister
  const clearing = mode === 'indirim' && (discValue === '' || discValue === '0');
  const removesDiscount = clearing && item.discount > 0;
  // Not kipinde değişiklik yeter (boş not siler); öteki kiplerde neden zorunlu
  const ready = mode === 'not' ? noteText.trim() !== (item.note ?? '') : clearing ? removesDiscount : !!reason.trim();
  const submit = async () => {
    if (busyRef.current || !ready) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await send();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const send = async () => {
    const base = `/orders/${order.id}/items/${item.id}`;
    let res: unknown = null;
    if (mode === 'iptal') res = await act((pin) => post(`${base}/void`, { qty, reason, approverPin: pin }), 'Kalem iptal edildi');
    if (mode === 'ikram' || mode === 'zayi') res = await act((pin) => post(`${base}/comp`, { qty, reason, kind: mode, approverPin: pin }), mode === 'zayi' ? 'Zayi yazıldı' : 'İkram edildi');
    if (mode === 'not') res = await act(() => put(`${base}/note`, { note: noteText.trim() || null }), noteText.trim() ? 'Not kaydedildi' : 'Not silindi');
    if (mode === 'indirim') {
      const value = discType === 'percent' ? Number(discValue.replace(',', '.')) : (parseTL(discValue) ?? 0);
      res = await act((pin) => post(`${base}/discount`, { type: discType, value, reason, approverPin: pin }), value > 0 ? 'İndirim uygulandı' : 'İndirim kaldırıldı');
    }
    if (res) close();
  };

  const itemTitle = `${item.qty}× ${item.name}${item.size !== 'TEK' ? ` ${boot.settings.sizeLabels[item.size]}` : ''}`;
  if (odenmez) {
    // Ödenmez kayıtlı bir kişiye yazılır: kişi, neden ve adet tek pencerede
    return (
      <OdenmezModal
        open
        title={`Ödenmez yaz · ${itemTitle}`}
        subtitle={`${tl(item.unitPrice)} adet başı; seçilen kişinin adına ciro dışı yazılır`}
        qtyMax={unpaid}
        confirmLabel={(n) => `${n} adet ödenmez`}
        onClose={() => setOdenmez(false)}
        onConfirm={async ({ person, reason: why, qty: n }) => {
          const res = await act((pin) => post(`/orders/${order.id}/items/${item.id}/comp`, { qty: n, reason: why, kind: 'odenmez', person, approverPin: pin }), 'Ödenmez yazıldı');
          if (res) close();
        }}
      />
    );
  }
  return (
    <Modal
      open
      onClose={dismiss}
      persistent={busy}
      size="sm"
      title={itemTitle}
      subtitle={[item.optionsText, tl(item.qty * item.unitPrice)].filter(Boolean).join(' · ')}
      // Geri ve onay pencerenin altında sabit (seçenek ve onay pencereleriyle aynı): telefonda tuş takımıyla kayıp gitmez
      footer={
        mode ? (
          <div className="grid grid-cols-2 gap-2">
            <Button onClick={() => setMode(null)} disabled={busy}>
              Geri
            </Button>
            <Button variant={mode === 'iptal' ? 'danger' : 'primary'} disabled={!ready} loading={busy} onClick={() => void submit()}>
              {mode === 'iptal' ? `${qty} adet iptal` : mode === 'ikram' ? `${qty} adet ikram` : mode === 'zayi' ? `${qty} adet zayi` : mode === 'not' ? 'Notu kaydet' : removesDiscount ? 'İndirimi kaldır' : 'Uygula'}
            </Button>
          </div>
        ) : undefined
      }
    >
      {!mode ? (
        // İşlemler menüsüyle aynı dil: ikonlar nötr karoda, yalnız iptal kırmızı ve en altta. Sıra: ciro dışı (ikram,
        // ödenmez, zayi), indirim, taşı, not, iptal
        <div className="grid gap-2 p-4">
          {item.complimentary ? (
            <SheetButton
              icon={<Undo2 />}
              title={item.compKind === 'ikram' || !item.compKind ? 'İkramı geri al' : `${COMP_LABEL[item.compKind]} kaydını geri al`}
              onClick={async () => (await act((pin) => post(`/orders/${order.id}/items/${item.id}/comp`, { undo: true, reason: '', approverPin: pin }), `${COMP_LABEL[item.compKind ?? 'ikram']} geri alındı`)) && close()}
            />
          ) : (
            <>
              <SheetButton icon={<Gift />} title="İkram et" hint="Ücret alınmaz, ikram raporuna girer" onClick={() => setMode('ikram')} disabled={unpaid < 1} />
              <SheetButton icon={<HandCoins />} title="Ödenmez yaz" hint="Personel yemeği, patron hesabı; kayıtlı kişinin adına" onClick={() => setOdenmez(true)} disabled={unpaid < 1} />
              <SheetButton icon={<Droplets />} title="Zayi yaz" hint="Döküldü, yanlış hazırlandı; ciro dışı, zayi raporuna girer" onClick={() => setMode('zayi')} disabled={unpaid < 1} />
            </>
          )}
          <SheetButton icon={<Percent />} title={item.discount > 0 ? `İndirimi değiştir (${tl(item.discount)})` : 'Kaleme indirim'} onClick={() => setMode('indirim')} disabled={item.complimentary || item.paidQty > 0} />
          {onMove && <SheetButton icon={<ArrowRightLeft />} title="Taşı" hint="Ayrı hesaba ya da başka masaya" onClick={() => { const it = item; close(); onMove(it); }} disabled={unpaid < 1} />}
          {canNote && (
            <SheetButton
              icon={<StickyNote />}
              title={item.note ? 'Notu değiştir' : 'Not ekle'}
              hint={item.note ? `Not: ${item.note}` : 'Bar fişinde görünür'}
              onClick={() => {
                setNoteText(item.note ?? '');
                setMode('not');
              }}
            />
          )}
          <SheetButton danger icon={<XCircle />} title="İptal et" hint={can('siparis.iptal') ? 'Gerekçe ile' : 'Hazırlanmaya başladıysa yetkili onayı ister'} onClick={() => setMode('iptal')} disabled={unpaid < 1} />
          {item.paidQty > 0 && <p className="px-1 text-xs text-muted">{item.paidQty} adedin ödemesi alındı; bu adetler değiştirilemez</p>}
        </div>
      ) : (
        <div className="space-y-4 p-4">
          {mode === 'not' && (
            <div>
              <Label hint="en çok 200">Not</Label>
              <Input
                value={noteText}
                autoFocus
                aria-label="Kalemin notu"
                placeholder="Örn. az buzlu, ayrı tabakta"
                onChange={(e) => setNoteText(e.target.value.slice(0, 200))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.repeat) void submit();
                }}
                enterKeyHint="done"
              />
              <p className="mt-1.5 text-xs text-muted">Bar fişinde ve hesapta görünür; boş bırakılırsa not silinir</p>
            </div>
          )}
          {mode !== 'indirim' && mode !== 'not' && unpaid > 1 && (
            <div className="flex items-center justify-between gap-3">
              <Label className="mb-0">Adet</Label>
              <Stepper value={qty} onChange={setQty} min={1} max={unpaid} label="Adet" />
            </div>
          )}
          {mode === 'indirim' && (
            <div className="space-y-2">
              <Segmented
                label="İndirim türü"
                className="flex w-full [&>button]:flex-1"
                value={discType}
                onChange={setDiscType}
                options={[
                  { value: 'percent', label: 'Yüzde (%)' },
                  { value: 'amount', label: 'Tutar (₺)' },
                ]}
              />
              {/* İşaret başta, sönük (₺120, %10); klavyeyle de yazılır */}
              <output aria-label={discType === 'percent' ? 'İndirim yüzdesi' : 'İndirim tutarı'} aria-live="polite" className="tabular font-headline block rounded-xl border border-line-strong bg-surface-2 px-4 py-3 text-right text-3xl font-semibold">
                {discType === 'percent' ? (
                  <>
                    <span className="mr-0.5 align-baseline text-[0.6em] font-medium text-muted">%</span>
                    {groupTyped(discValue)}
                  </>
                ) : (
                  <TypedAmount text={discValue} />
                )}
              </output>
              {/* Enter, Uygula etkinse uygular; değilse hiçbir şey yapmaz (odaktaki rakamı yinelemez). Boş değerle Enter
                  indirimi kaldırmaz: kaldırma yazılmış bir 0 ya da Uygula düğmesiyle açıkça yapılır */}
              <Numpad
                size="md"
                keyboard
                decimal={discType === 'amount'}
                onEnter={() => {
                  if (discValue !== '') void submit();
                }}
                onKey={(k) => setDiscValue(applyNumpadKey(discValue, k, { decimal: discType === 'amount', maxLength: discType === 'percent' ? 3 : 8 }))}
              />
            </div>
          )}
          {mode !== 'not' && (
          <div>
            <Label hint={removesDiscount ? 'kaldırırken gerekmez' : undefined}>Neden</Label>
            {/* Hazır neden: kitin mürekkep çipi (adisyon indirimi, iptal ve ret nedeniyle aynı) */}
            <div className="flex flex-wrap gap-1.5">
              {reasons.map((r) => (
                <Chip
                  key={r}
                  tone="ink"
                  on={reason === r}
                  onClick={() => {
                    setReason(r);
                    // Hazır indirim nedeni (Öğrenci, Çalışan) yüzdesini de yazar: tek dokunuş, sonra Uygula
                    if (mode === 'indirim' && boot.settings.discountPresetPct > 0) {
                      setDiscType('percent');
                      setDiscValue(String(boot.settings.discountPresetPct));
                    }
                  }}
                >
                  {mode === 'indirim' && boot.settings.discountPresetPct > 0 ? `${r} %${boot.settings.discountPresetPct}` : r}
                </Chip>
              ))}
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value.slice(0, 200))} placeholder="Ya da nedeni yazın" aria-label="Neden" className="mt-2" />
          </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** Gönderilmiş kalemin ciro dışı işareti (ikram, ödenmez, zayi): ikon ve adıyla */
/** İkram, ödenmez, zayi işareti; ödenmezde kimin adına yazıldığı yanında ("Ödenmez · Garson") */
function CompMark({ kind, person }: { kind: CompKind; person?: string | null }) {
  const { Icon, cls } = COMP_MARK[kind];
  return (
    <span className={cn('inline-flex items-center gap-0.5', cls)}>
      <Icon aria-hidden="true" className="size-3.5" />
      {COMP_LABEL[kind]}
      {kind === 'odenmez' && person && <span className="font-normal text-ink-2"> · {person}</span>}
    </span>
  );
}

/** Kalem penceresinin satırı: ikon nötr karoda (İşlemler menüsü gibi); yıkıcı olan (iptal) kırmızı karo ve yazı */
function SheetButton({ icon, title, hint, onClick, disabled, danger }: { icon: React.ReactNode; title: string; hint?: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'flex min-h-12 items-center gap-3 rounded-xl border border-line px-3 py-2 text-left transition-colors duration-150 enabled:hover:border-[var(--admin-border-field)] enabled:hover:bg-hover enabled:active:bg-press disabled:cursor-not-allowed disabled:opacity-40',
        danger && 'text-[var(--admin-danger-ink)]',
      )}
    >
      <span aria-hidden="true" className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', danger ? 'bg-[var(--admin-danger-soft)]' : 'bg-surface-3 text-ink-2')}>
        {icon}
      </span>
      <span>
        <span className="block text-sm font-medium">{title}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </span>
    </button>
  );
}
