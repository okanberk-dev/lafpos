import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bike, Globe, Minus, Plus, Printer, ReceiptText, ShoppingBag, Store, Trash2, Undo2, UtensilsCrossed } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { CLOSED_PAGE_DEFAULT, type ClosedOrderDetailDTO, type ClosedOrderRow, type ClosedOrdersDTO, HISTORY_QUERY_MAX } from '@shared/history';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { fmtTime } from '@shared/time';
import { PlatformBadge } from '@/components/PlatformBadge';
import { Button } from '@/components/ui/Button';
import { Input, SearchInput } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, EmptyState, ErrorState, FLOAT_CARD, Notice, Skeleton } from '@/components/ui/misc';
import { promptDialog } from '@/components/ui/Confirm';
import { errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { toast } from '@/lib/toast';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { BillReceipt, printNow } from '@/lib/print';
import { orderCardName } from '@/lib/readyToHand';
import { useServiceMode } from '@/lib/serviceMode';
import { joinMeta } from '@/lib/text';

/** "2026-11-22" → "22 Kasım 2026" */
/**
 * Kapanmış siparişi iptal (uzun basış ve dökümdeki düğme): neden sorulur, yetkili onayı (PIN) istenir; ödemeler ve adisyon
 * tek işlemde iptal edilir (server orders.cancelClosedOrder). Yalnız bugünün kasa siparişi
 */
async function cancelClosed(id: string, label: string, total: number, fiscal: boolean): Promise<boolean> {
  const reason = await promptDialog({
    title: 'Siparişi iptal et',
    body: `${label} · ${tl(total)}. Alınan ödemeler ve ürünler iptal edilir; ciroya sayılmaz, denetim kaydına yazılır${fiscal ? '. Yazarkasada kesilen fiş cihazdan ayrıca iptal edilmeli' : ''}`,
    label: 'Neden',
    placeholder: 'Ör. müşteri vazgeçti',
    maxLength: 200,
    required: 'İptal nedenini yazın',
    confirmLabel: 'Siparişi iptal et',
    tone: 'danger',
  });
  if (!reason) return false;
  try {
    const done = await withApproval((pin) => post(`/orders/${id}/cancel-closed`, { reason, approverPin: pin }));
    if (!done) return false;
    toast.ok('Sipariş iptal edildi');
    return true;
  } catch (e) {
    toast.err(errorMessage(e));
    return false;
  }
}

/** Uzun basış (yarım saniye): dokunmatikte ve farede; uzun basıştan sonra gelen tıklama yutulur */
function useLongPress(onLong: () => void, ms = 550) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fired = useRef(false);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  return {
    fired,
    handlers: {
      onPointerDown: () => {
        fired.current = false;
        clear();
        timer.current = setTimeout(() => {
          fired.current = true;
          onLong();
        }, ms);
      },
      onPointerUp: clear,
      onPointerLeave: clear,
      onPointerCancel: clear,
      onContextMenu: (e: { preventDefault: () => void }) => e.preventDefault(),
    },
  };
}

const fmtDay = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Siparişler › Kapanan: günün kapanan adisyonları, en son kapanan üstte, sayfa sayfa. Arama no, masa, müşteri ve ürün
 * adıyla (sunucu günün bütün kapananlarında arar). Önceki günler yalnız rapor yetkisiyle (`rapor.gor`; sunucu da
 * denetler); personel bugünü görür. Karta dokununca adisyonun dökümü: kalemler, iptal ve ikramlar, ödemeler (kör kasada
 * gizli), yazarkasa fişi ve Hesabı yeniden yazdır.
 */
export function ClosedOrders() {
  const can = useCan();
  const mode = useServiceMode();
  const reports = can('rapor.gor');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);
  const [date, setDate] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const qc = useQueryClient();

  const list = useInfiniteQuery({
    queryKey: ['orders', 'kapanan', date, q],
    initialPageParam: '',
    queryFn: ({ pageParam }) =>
      get<ClosedOrdersDTO>(`/history/orders?${new URLSearchParams({ limit: String(CLOSED_PAGE_DEFAULT), ...(date ? { date } : {}), ...(q ? { q } : {}), ...(pageParam ? { before: pageParam } : {}) })}`),
    getNextPageParam: (last) => last.next ?? undefined,
    // Arama ya da gün değişirken eski liste ekranda kalır (iskelet yanıp sönmez)
    placeholderData: (prev) => prev,
  });
  const first = list.data?.pages[0];
  const rows = list.data?.pages.flatMap((p) => p.rows) ?? [];
  const today = first?.today ?? '';
  const shownDate = first?.date ?? date;
  const isToday = !date || date === today;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        <SearchInput
          label="Kapanan adisyonlarda ara"
          placeholder="No, masa, müşteri ya da ürün ara"
          value={search}
          onChange={setSearch}
          maxLength={HISTORY_QUERY_MAX}
          wrapperClassName="min-w-0 flex-1 basis-60 sm:max-w-md"
        />
        {/* Önceki günler rapor yetkisiyle: personel yalnız bugünü görür */}
        {reports && (
          <label className="flex min-w-0 items-center gap-2 text-sm text-ink-2">
            <span className="shrink-0">Gün</span>
            <Input type="date" aria-label="Gün" value={date || today} max={today || undefined} onChange={(e) => setDate(e.target.value === today ? '' : e.target.value)} className="w-auto min-w-0" />
          </label>
        )}
        {reports && !isToday && (
          <Button variant="secondary" onClick={() => setDate('')}>
            Bugüne dön
          </Button>
        )}
      </div>
      {first && rows.length > 0 && (
        <p role="status" className="tabular text-sm text-muted">
          {joinMeta([isToday ? 'Bugün' : fmtDay(shownDate), q ? `${first.count} adisyon bulundu` : `${first.count} kapanan adisyon`])}
        </p>
      )}

      {list.isPending ? (
        <div role="status" aria-label="Kapanan adisyonlar yükleniyor…" className="lp-cards">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-[92px] rounded-2xl" />
          ))}
        </div>
      ) : list.isError && !list.data ? (
        <ErrorState className={FLOAT_CARD} title="Kapanan adisyonlar alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          art="fis"
          className={FLOAT_CARD}
          title={q ? 'Aramayla eşleşen adisyon yok' : isToday ? 'Bugün kapanan adisyon yok' : `${fmtDay(shownDate)} günü kapanan adisyon yok`}
          action={
            q ? (
              <Button variant="secondary" onClick={() => setSearch('')}>
                Aramayı temizle
              </Button>
            ) : undefined
          }
        >
          {q ? `“${q}” bu günün kapananlarında yok. Adisyon no, masa, müşteri ya da ürün adıyla arayın` : 'Ödemesi alınan adisyonlar gün boyunca burada listelenir'}
        </EmptyState>
      ) : (
        <>
          <div className={cn('lp-cards animate-fade', list.isFetching && !list.isFetchingNextPage && 'opacity-70')}>
            {rows.map((r) => (
              <ClosedCard
                key={r.id}
                r={r}
                mode={mode}
                onOpen={() => setOpenId(r.id)}
                onCancel={
                  isToday && r.source === 'pos' && !r.extPaid
                    ? () => {
                        const { name, head } = orderCardName(r, mode);
                        void cancelClosed(r.id, head ? name : `${name} #${r.extNo ?? r.no}`, r.total, r.receiptNo != null).then((ok) => ok && void qc.invalidateQueries({ queryKey: ['orders'] }));
                      }
                    : undefined
                }
              />
            ))}
          </div>
          {list.hasNextPage && (
            <Button variant="secondary" className="self-center" loading={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
              Daha eski adisyonlar
            </Button>
          )}
          {list.isError && <Notice tone="danger">Liste yenilenemedi; bağlantı gelince yeniden denenir</Notice>}
        </>
      )}
      <ClosedDetail id={openId} today={today} onClose={() => setOpenId(null)} />
    </div>
  );
}

function ClosedCard({ r, mode, onOpen, onCancel }: { r: ClosedOrderRow; mode: ReturnType<typeof useServiceMode>; onOpen: () => void; onCancel?: () => void }) {
  // Uzun basınca "Siparişi iptal et" (bugünün kasa siparişi); kısa dokunuş dökümü açar
  const long = useLongPress(() => onCancel?.());
  const Icon = r.source === 'laffogato' ? Globe : r.type === 'paket' ? Bike : r.type === 'gelal' ? ShoppingBag : r.type === 'masa' ? UtensilsCrossed : Store;
  const { name, head } = orderCardName(r, mode);
  const hasBadges = !!r.platform || r.extPaid || r.methods.length > 0 || r.receiptNo != null || r.voided > 0 || r.comped > 0 || !!r.customerName;
  return (
    <button
      type="button"
      data-order-card=""
      {...(onCancel ? long.handlers : {})}
      aria-description={onCancel ? 'Uzun basınca iptal' : undefined}
      onClick={() => {
        if (long.fired.current) {
          long.fired.current = false;
          return;
        }
        onOpen();
      }}
      className="flex flex-col rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface p-4 text-left shadow-[var(--card-shadow)] transition-[border-color,box-shadow] duration-150 hover:shadow-[var(--shadow-lift)] active:bg-press"
    >
      <span className="flex w-full items-start gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg [&>svg]:size-[18px]', r.source === 'laffogato' ? 'bg-[var(--admin-hue-violet-soft)] text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
          <Icon aria-hidden="true" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">
            {name}
            {!head && <span className="tabular font-normal text-muted"> #{r.extNo ?? r.no}</span>}
          </span>
          <span className="block text-[13px] text-muted">{joinMeta([r.itemCount > 0 && `${r.itemCount} ürün`, r.closedAt && `kapanış ${fmtTime(r.closedAt)}`])}</span>
        </span>
        <span className="tabular text-right font-semibold">{tl(r.total)}</span>
      </span>
      {r.summary && (
        <span className="mt-2 block truncate text-sm text-ink-2">
          {r.summary}
          {r.more > 0 && <span className="text-muted"> +{r.more}</span>}
        </span>
      )}
      {hasBadges && (
        <span className="mt-2 flex flex-wrap gap-1.5">
          {r.platform && <PlatformBadge platform={r.platform} code={r.platformCode} />}
          {r.extPaid && <Badge tone="violet">Sitede ödendi</Badge>}
          {r.customerName && <Badge>{r.customerName}</Badge>}
          {r.methods.length > 0 && <Badge>{r.methods.join(', ')}</Badge>}
          {r.receiptNo != null && <Badge tone="blue">Fiş {r.receiptNo}</Badge>}
          {r.voided > 0 && <Badge tone="red">{r.voided} iptal</Badge>}
          {r.comped > 0 && <Badge tone="warn">{r.comped} ikram</Badge>}
        </span>
      )}
    </button>
  );
}

/** Kapanan adisyonun dökümü (salt okunur): kalemler, toplamlar, ödemeler ve yazarkasa fişleri */
function ClosedDetail({ id, today, onClose }: { id: string | null; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [iade, setIade] = useState(false);
  const boot = useBoot();
  const mode = useServiceMode();
  const navigate = useNavigate();
  const detail = useQuery({ queryKey: ['orders', 'kapanan', 'detay', id], queryFn: () => get<ClosedOrderDetailDTO>(`/history/orders/${id}`), enabled: !!id });
  const d = detail.data;
  const o = d?.order;
  const title = o ? (() => {
    const { name, head } = orderCardName(o, mode);
    return head ? name : `${name} #${o.extNo ?? o.no}`;
  })() : 'Adisyon';
  const sizeLabel = (s: string) => boot.settings.sizeLabels[s as 'M' | 'L'] ?? s;
  const payments = o?.payments ?? [];

  return (
    <Modal
      open={!!id}
      onClose={onClose}
      title={title}
      subtitle={o ? joinMeta([d && fmtDay(d.date), `açılış ${fmtTime(o.openedAt)}`, o.closedAt && `kapanış ${fmtTime(o.closedAt)}`, o.waiterName]) : undefined}
      footer={
        o ? (
          <div className="flex w-full flex-wrap gap-2">
            <Button variant="secondary" className="flex-1" onClick={() => navigate(`/adisyon/${o.id}`)}>
              Adisyonu aç
            </Button>
            <Button variant="primary" className="flex-1" icon={<Printer className="size-4" />} onClick={() => printNow(<BillReceipt order={o} boot={boot} sizeLabel={sizeLabel} />)}>
              Hesabı yeniden yazdır
            </Button>
            {d && d.date === today && o.status === 'kapali' && o.source === 'pos' && !o.extPaid && (
              <Button variant="secondary" className="basis-full" icon={<Undo2 className="size-4" />} onClick={() => setIade(true)}>
                Kalem iade et
              </Button>
            )}
            {d && d.date === today && o.status === 'kapali' && o.source === 'pos' && !o.extPaid && (
              <Button
                variant="danger"
                className="basis-full"
                icon={<Trash2 className="size-4" />}
                onClick={() =>
                  void cancelClosed(o.id, title, o.total, d.receipts.some((r) => !r.cancelled)).then((ok) => {
                    if (!ok) return;
                    void qc.invalidateQueries({ queryKey: ['orders'] });
                    onClose();
                  })
                }
              >
                Siparişi iptal et
              </Button>
            )}
          </div>
        ) : undefined
      }
    >
      {detail.isPending ? (
        <div role="status" aria-label="Adisyon yükleniyor…" className="flex flex-col gap-2">
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-12 rounded-xl" />
          <Skeleton className="h-24 rounded-xl" />
        </div>
      ) : detail.isError || !o || !d ? (
        <ErrorState title="Adisyon alınamadı" error={detail.error} retrying={detail.isFetching} onRetry={() => void detail.refetch()} />
      ) : (
        <div className="flex flex-col gap-4">
          <section aria-labelledby="kapanan-kalemler">
            <h3 id="kapanan-kalemler" className="mb-1.5 text-sm font-semibold text-muted">
              Kalemler
            </h3>
            <ul className="divide-y divide-[var(--admin-divider)] rounded-xl border border-line">
              {o.items.map((i) => (
                <li key={i.id} className={cn('flex items-start gap-3 px-3 py-2.5', i.voided && 'bg-[var(--admin-danger-soft)]')}>
                  <span className="tabular min-w-7 rounded-md bg-surface-3 px-1.5 text-center font-semibold">{i.qty}</span>
                  <span className="min-w-0 flex-1">
                    <span className={cn('block font-medium', i.voided && 'line-through opacity-70')}>
                      {i.name}
                      {i.size !== 'TEK' && <span className="text-ink-2"> · {sizeLabel(i.size)}</span>}
                    </span>
                    {i.optionsText && <span className="block text-sm text-ink-2">{i.optionsText}</span>}
                    {i.note && <span className="block text-sm text-ink-2">Not: {i.note}</span>}
                    {i.voided && <span className="block text-sm font-semibold text-[var(--admin-danger-ink)]">İptal{i.voidReason ? `: ${i.voidReason}` : ''}</span>}
                    {i.complimentary && !i.voided && <span className="block text-sm font-semibold text-[var(--admin-warning)]">İkram{i.compReason ? `: ${i.compReason}` : ''}</span>}
                  </span>
                  <span className={cn('tabular shrink-0 text-right', (i.voided || i.complimentary) && 'text-muted line-through')}>{tl(i.unitPrice * i.qty)}</span>
                </li>
              ))}
            </ul>
          </section>

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
            {o.totals.lineDiscounts + o.totals.orderDiscount > 0 && (
              <>
                <dt className="text-ink-2">İndirim{o.discountReason ? ` (${o.discountReason})` : ''}</dt>
                <dd className="tabular text-right">−{tl(o.totals.lineDiscounts + o.totals.orderDiscount)}</dd>
              </>
            )}
            {o.totals.service > 0 && (
              <>
                <dt className="text-ink-2">Servis</dt>
                <dd className="tabular text-right">{tl(o.totals.service)}</dd>
              </>
            )}
            <dt className="font-semibold">Toplam</dt>
            <dd className="tabular text-right font-semibold">{tl(o.extPaid ? (o.extTotal ?? 0) : o.total)}</dd>
          </dl>

          <section aria-labelledby="kapanan-odemeler">
            <h3 id="kapanan-odemeler" className="mb-1.5 text-sm font-semibold text-muted">
              Ödemeler
            </h3>
            {d.paymentsHidden ? (
              <p className="text-sm text-ink-2">Ödeme dökümü bu rolde gösterilmiyor (kör kasa)</p>
            ) : o.extPaid ? (
              <p className="text-sm text-ink-2">Sitede online ödendi</p>
            ) : payments.length === 0 ? (
              <p className="text-sm text-ink-2">Ödeme kaydı yok (ikram ya da ciro dışı kapanış)</p>
            ) : (
              <ul className="divide-y divide-[var(--admin-divider)] rounded-xl border border-line">
                {payments.map((p) => (
                  <li key={p.id} className={cn('flex items-start gap-3 px-3 py-2.5', p.refundedAt && 'text-muted')}>
                    <span className="min-w-0 flex-1">
                      <span className={cn('block font-medium', p.refundedAt && 'line-through')}>{p.methodName}</span>
                      <span className="block text-sm text-ink-2">{joinMeta([fmtTime(p.createdAt), p.userName && `alan ${p.userName}`, p.refundedAt && `iptal edildi${p.refundReason ? `: ${p.refundReason}` : ''}`])}</span>
                    </span>
                    <span className="tabular shrink-0 text-right">{tl(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {d.receipts.length > 0 && (
            <section aria-labelledby="kapanan-fis">
              <h3 id="kapanan-fis" className="mb-1.5 text-sm font-semibold text-muted">
                Yazarkasa fişi
              </h3>
              <ul className="flex flex-col gap-1 text-sm">
                {d.receipts.map((r) => (
                  <li key={r.id} className="flex items-center gap-2">
                    <ReceiptText aria-hidden="true" className="size-4 text-muted" />
                    <span className={cn('tabular', r.cancelled && 'line-through')}>{joinMeta([r.zNo != null && `Z ${r.zNo}`, r.receiptNo != null && `Fiş ${r.receiptNo}`, fmtTime(r.at), r.amount != null && tl(r.amount)])}</span>
                    {r.cancelled && <Badge tone="red">İptal edildi</Badge>}
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
      {o && (
        <IadePenceresi
          open={iade}
          order={o}
          fiscal={!!d?.receipts.some((r) => !r.cancelled)}
          onClose={() => setIade(false)}
          onDone={() => {
            setIade(false);
            void qc.invalidateQueries({ queryKey: ['orders'] });
          }}
        />
      )}
    </Modal>
  );
}

/**
 * Kalem kalem iade (sahip, 22 Kas 2026): kalemleri adetle seç, neden yaz; yetkili onayıyla tek işlemde iade
 * (`POST /orders/:id/refund-items`): kalan aynı ödeme türleriyle yeniden yazılır, nakit iade kasadan düşer
 */
function IadePenceresi({ open, order, fiscal, onClose, onDone }: { open: boolean; order: OrderDTO; fiscal: boolean; onClose: () => void; onDone: () => void }) {
  const [adet, setAdet] = useState<Record<string, number>>({});
  const [neden, setNeden] = useState('');
  const [busy, setBusy] = useState(false);
  const kalemler = order.items.filter((i) => !i.voided && !i.complimentary);
  const secili = kalemler.filter((i) => (adet[i.id] ?? 0) > 0);
  const tutar = secili.reduce((a, i) => a + (adet[i.id] ?? 0) * i.unitPrice, 0);
  const degis = (id: string, d: number, max: number) => setAdet((a) => ({ ...a, [id]: Math.max(0, Math.min(max, (a[id] ?? 0) + d)) }));
  const gonder = async () => {
    if (!secili.length) return toast.err('İade edilecek kalemi seçin');
    if (!neden.trim()) return toast.err('İade nedenini yazın');
    setBusy(true);
    try {
      const done = await withApproval((pin) => post(`/orders/${order.id}/refund-items`, { items: secili.map((i) => ({ itemId: i.id, qty: adet[i.id] })), reason: neden.trim(), approverPin: pin }));
      if (done) {
        toast.ok(`${tl(tutar)} iade edildi`);
        setAdet({});
        setNeden('');
        onDone();
      }
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Kalem iade et"
      subtitle={fiscal ? 'Yazarkasada kesilen fişin iadesi cihazdan ayrıca yapılır; kart iadesi banka POS’undan' : 'Nakit iade kasadan çıkış sayılır'}
      footer={
        <div className="grid w-full grid-cols-2 gap-2 sm:flex sm:justify-end">
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="danger" loading={busy} disabled={!secili.length} onClick={() => void gonder()}>
            {secili.length ? `${tl(tutar)} iade et` : 'İade et'}
          </Button>
        </div>
      }
    >
      <div className="space-y-3 p-5">
        <ul className="divide-y divide-[var(--admin-divider)] rounded-[var(--r-tile)] border border-[var(--admin-border)]">
          {kalemler.map((i) => (
            <li key={i.id} className="flex min-h-14 items-center gap-3 px-3">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{i.name}</span>
                <span className="block text-xs text-muted">
                  {i.qty} adet · {tl(i.unitPrice)}
                </span>
              </span>
              <Button variant="ghost" aria-label={`${i.name} bir azalt`} icon={<Minus className="size-4" />} disabled={!(adet[i.id] ?? 0)} onClick={() => degis(i.id, -1, i.qty)} />
              <span className="tabular w-6 text-center font-semibold">{adet[i.id] ?? 0}</span>
              <Button variant="ghost" aria-label={`${i.name} bir artır`} icon={<Plus className="size-4" />} disabled={(adet[i.id] ?? 0) >= i.qty} onClick={() => degis(i.id, 1, i.qty)} />
            </li>
          ))}
        </ul>
        <Input value={neden} onChange={(e) => setNeden(e.target.value)} maxLength={200} placeholder="İade nedeni (ör. müşteri vazgeçti)" aria-label="İade nedeni" />
      </div>
    </Modal>
  );
}
