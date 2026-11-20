import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, Lock, MonitorSmartphone, Plus, Receipt, Split, Utensils, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { parseTL, tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { Button, buttonClass } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, PageHeader } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { onLive } from '@/lib/live';
import { beep } from '@/lib/sound';
import { toast } from '@/lib/toast';

interface BasketItem {
  name: string;
  price: number;
  quantity: number;
  taxPercent: number;
  sectionNo: number;
  adjust?: { totalValue?: number };
}
interface SimReceipt {
  id: string;
  orderId: string;
  status: string;
  amount: number;
  zNo: number | null;
  receiptNo: number | null;
  lockedBy: string | null;
  createdAt: number;
  basket: { title?: string; filter?: string; checkNumber?: number; items: BasketItem[] };
}

// Ödeme türleri mürekkep tuş (ödeme ticari son adım, DESIGN); türü ikon ayırır. Cihaz ekranı uygulamanın temasında
const TYPES = [
  { type: 1, label: 'Nakit', icon: Banknote },
  { type: 3, label: 'Kredi kartı', icon: CreditCard },
  { type: 7, label: 'Yemek kartı', icon: Utensils },
];
/** Cihazın büyük tuşu: köşe 14, basınca bir ton koyu; istek sürerken kilitli */
const KEY = 'flex items-center justify-center gap-2 rounded-xl font-semibold transition-[background-color,filter,opacity] duration-150 active:brightness-90 disabled:cursor-not-allowed disabled:opacity-60 disabled:active:brightness-100';
const INK_KEY = 'bg-[var(--admin-ink-fill)] text-[var(--admin-on-ink)] hover:bg-[var(--admin-ink-fill-hover)]';
const PLAIN_KEY = 'bg-surface-3 text-ink hover:bg-[var(--admin-border)]';

/**
 * Eğitim cihazı: Token ÖKC'nin LafPOS içindeki benzeri. Ayar "simülatör" iken kasadan gönderilen sepetler burada
 * belirir; ödeme alınınca sonuç gerçek cihazdaki gibi (Z no, fiş no, ödeme kalemleri) adisyona işlenir.
 */
export default function DevicePage() {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const baskets = useQuery({ queryKey: ['okc', 'sim'], queryFn: () => get<SimReceipt[]>('/okc/simulator/baskets'), refetchInterval: 5000 });
  const recent = useQuery({ queryKey: ['okc', 'sim-recent'], queryFn: () => get<SimReceipt[]>('/okc/simulator/recent') });
  const [openId, setOpenId] = useState<string | null>(null);
  const [split, setSplit] = useState<{ type: number; amount: string }[] | null>(null);
  // Süren cihaz isteği (ödeme ya da iptal edilen fiş): ikinci dokunuş ikinci kez ödemez
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic === 'okc') {
          if (e.kind === 'okc.sent') beep('yeni');
          qc.invalidateQueries({ queryKey: ['okc', 'sim'] });
          qc.invalidateQueries({ queryKey: ['okc', 'sim-recent'] });
        }
      }),
    [qc],
  );

  const current = useMemo(() => baskets.data?.find((b) => b.id === openId) ?? null, [baskets.data, openId]);
  useEffect(() => {
    if (openId && baskets.data && !baskets.data.some((b) => b.id === openId)) setOpenId(null);
  }, [baskets.data, openId]);

  if (boot.integrations.okc.provider !== 'simulator') {
    return (
      <div className="p-6">
        <EmptyState
          icon={<MonitorSmartphone />}
          title="Eğitim cihazı kapalı"
          action={
            can('ayar.yonet') && (
              <Link to="/yonetim/yazarkasa" className={buttonClass('secondary', 'sm')}>
                Yazarkasa ayarları
              </Link>
            )
          }
        >
          Yazarkasa şu an {boot.integrations.okc.provider === 'tokenx' ? 'gerçek cihaza (TokenX) bağlı' : boot.integrations.okc.provider === 'pavo' ? 'gerçek cihaza (Pavo) bağlı' : 'kapalı'}. Denemek için Yönetim › Yazarkasa POS’ta eğitim cihazını seçin
        </EmptyState>
      </div>
    );
  }

  const open = async (b: SimReceipt) => {
    setOpenId(b.id);
    setSplit(null);
    try {
      await post(`/okc/simulator/baskets/${b.id}/lock`, { locked: true });
    } catch {
      /* kilit yalnız gösterim için */
    }
  };
  const close = async () => {
    if (current) await post(`/okc/simulator/baskets/${current.id}/lock`, { locked: false }).catch(() => undefined);
    setOpenId(null);
  };
  const pay = async (payments: { type: number; amount: number }[]) => {
    if (!current || busy) return;
    setBusy('pay');
    try {
      await post(`/okc/simulator/baskets/${current.id}/pay`, { payments });
      beep('tamam');
      toast.ok('Fiş basıldı, ödeme LafPOS’a işlendi');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['okc'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const cancel = async (id: string, voidReceipt = false) => {
    if (busy) return;
    setBusy(id);
    try {
      // Fiş iptali ödeme iptalidir: yetkisi yoksa yetkili PIN’i istenir
      const done = await withApproval((pin) => post(`/okc/simulator/baskets/${id}/cancel`, { voidReceipt, approverPin: pin }));
      if (done === null) return;
      toast.warn(voidReceipt ? 'Fiş iptal edildi; LafPOS ödemesi geri alındı' : 'Cihazda ödemeden vazgeçildi');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['okc'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const splitTotal = (split ?? []).reduce((a, s) => a + (parseTL(s.amount) ?? 0), 0);

  return (
    <Stage leafLabel="Eğitim cihazı">
    <div className="lp-leaf-pad">
      <PageHeader title="Eğitim cihazı" subtitle="Token ÖKC benzeri: kasadan gönderilen sepetler burada ödenir. Gerçek cihaz bağlanınca bu ekran kullanılmaz" />
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,420px)_1fr]">
        {/* Cihazın çerçevesi gece mürekkebi; ekran uygulamanın temasında. İnce açık halka çerçeveyi koyu sayfadan ayırır */}
        <div className="mx-auto w-full max-w-[420px] rounded-[2.2rem] border-[10px] border-night bg-night p-1 shadow-[var(--shadow-pop)] ring-1 ring-white/10">
          <div className="min-h-[560px] overflow-hidden rounded-[1.6rem] bg-surface text-ink">
            <div className="flex items-center justify-between bg-surface-3 px-4 py-2 text-xs text-ink-2">
              <span className="font-semibold">Token ÖKC · eğitim</span>
              <span className="tabular">{fmtTime(Date.now())}</span>
            </div>
            {!current ? (
              <div className="p-3">
                <div className="mb-2 px-1 text-xs font-medium text-muted">Açık sepetler</div>
                {baskets.isPending ? (
                  <ListSkeleton rows={2} className="p-1" />
                ) : baskets.isError && !baskets.data ? (
                  <ErrorState compact title="Sepetler alınamadı" error={baskets.error} retrying={baskets.isFetching} onRetry={() => void baskets.refetch()} />
                ) : baskets.data.length === 0 ? (
                  <EmptyState compact icon={<Receipt />} title="Kasadan sepet bekleniyor…">
                    Kasada “Hesabı yazarkasaya gönder” deyince burada belirir
                  </EmptyState>
                ) : (
                  <div className="space-y-2">
                    {baskets.data.map((b) => (
                      <button
                        key={b.id}
                        onClick={() => open(b)}
                        className="flex w-full items-center gap-3 rounded-xl bg-surface-3 p-3 text-left transition-colors duration-150 hover:bg-[var(--admin-border)] focus-visible:-outline-offset-2 active:bg-[var(--admin-border)]"
                      >
                        <Receipt aria-hidden="true" className="size-5 text-primary" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate font-semibold">{b.basket.title ?? 'Sepet'}</div>
                          <div className="text-xs text-muted">
                            #{b.basket.checkNumber} · {b.basket.filter} · {fmtTime(b.createdAt)}
                          </div>
                        </div>
                        <div className="tabular font-semibold">{tl(b.amount)}</div>
                        {b.status === 'kilitli' && <Lock className="size-4 text-muted" aria-label="Kilitli" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="flex min-h-[520px] flex-col p-3">
                <Button size="sm" variant="ghost" icon={<ArrowLeft className="size-4" />} className="-ml-1 mb-2 self-start" onClick={close}>
                  Listeye dön
                </Button>
                <div className="font-semibold">
                  {current.basket.title} · #{current.basket.checkNumber}
                </div>
                <div className="scroll-thin mt-2 flex-1 space-y-1 overflow-y-auto font-mono text-[13px]">
                  {current.basket.items.map((it, i) => (
                    <div key={i}>
                      <div className="flex justify-between">
                        <span>
                          {it.quantity / 1000} x {it.name}
                        </span>
                        <span>{tl(it.price * (it.quantity / 1000))}</span>
                      </div>
                      <div className="flex justify-between text-[11px] text-muted">
                        <span>
                          KDV %{it.taxPercent / 100} · kısım {it.sectionNo}
                        </span>
                        {it.adjust?.totalValue ? <span>İND. -{tl(it.adjust.totalValue)}</span> : null}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="my-3 flex justify-between border-t border-dashed border-line pt-2 text-lg font-bold">
                  <span>TOPLAM</span>
                  <span className="tabular">{tl(current.amount)}</span>
                </div>
                {!split ? (
                  <div className="grid grid-cols-2 gap-2">
                    {TYPES.map((t) => (
                      <button key={t.type} disabled={!!busy} aria-busy={busy === 'pay' || undefined} onClick={() => pay([{ type: t.type, amount: current.amount }])} className={cn(KEY, INK_KEY, 'h-14')}>
                        <t.icon aria-hidden="true" className="size-5" /> {t.label}
                      </button>
                    ))}
                    <button disabled={!!busy} onClick={() => setSplit([{ type: 3, amount: '' }, { type: 1, amount: '' }])} className={cn(KEY, PLAIN_KEY, 'h-14')}>
                      <Split aria-hidden="true" className="size-5" /> Böl
                    </button>
                    <Button variant="dangerGhost" block icon={<XCircle className="size-4" />} className="col-span-2" disabled={!!busy} onClick={() => cancel(current.id)}>
                      Ödemeden vazgeç
                    </Button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {split.map((s, i) => (
                      <div key={i} className="grid grid-cols-2 gap-2">
                        <Select value={s.type} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, type: Number(e.target.value) } : x)))} aria-label="Ödeme türü">
                          {TYPES.map((t) => (
                            <option key={t.type} value={t.type}>
                              {t.label}
                            </option>
                          ))}
                        </Select>
                        <Input value={s.amount} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="Tutar" inputMode="decimal" aria-label="Tutar" className="tabular min-w-0 text-right" />
                      </div>
                    ))}
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} className="-ml-1" onClick={() => setSplit([...split, { type: 3, amount: '' }])}>
                        Ödeme ekle
                      </Button>
                      {/* Toplam tutunca yeşil, aşınca kırmızı; eksikken gri (henüz yazılıyor) */}
                      <span className={cn('tabular font-medium', splitTotal === current.amount ? 'text-success-ink' : splitTotal > current.amount ? 'text-danger-ink' : 'text-muted')}>
                        {tl(splitTotal)} / {tl(current.amount)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button className={cn(KEY, PLAIN_KEY, 'h-12 font-medium')} onClick={() => setSplit(null)}>
                        Geri
                      </button>
                      <button
                        disabled={splitTotal !== current.amount || !!busy}
                        aria-busy={busy === 'pay' || undefined}
                        className={cn(KEY, INK_KEY, 'h-12 disabled:bg-surface-3 disabled:text-muted disabled:opacity-100')}
                        onClick={() => pay(split.map((s) => ({ type: s.type, amount: parseTL(s.amount) ?? 0 })).filter((s) => s.amount > 0))}
                      >
                        Öde ve fiş bas
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="space-y-3">
          <Card title="Gerçek cihazda akış aynı">
            <ol className="list-decimal space-y-1 p-4 pl-9 text-sm leading-relaxed text-ink-2">
              <li>Kasada “Hesabı yazarkasaya gönder” denir; sepet (ürünler, KDV kısımları, indirimler) cihaza gider</li>
              <li>Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar</li>
              <li>Sonuç (Z no, fiş no, ödeme kalemleri) LafPOS’a gelir; adisyon kendiliğinden kapanır</li>
              <li>Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır ve patron paneline alarm düşer</li>
            </ol>
          </Card>
          <Card title="Son fişler">
            {recent.isPending ? (
              <ListSkeleton rows={3} />
            ) : recent.isError && !recent.data ? (
              <ErrorState compact title="Son fişler alınamadı" error={recent.error} retrying={recent.isFetching} onRetry={() => void recent.refetch()} />
            ) : recent.data.length === 0 ? (
              <EmptyState compact title="Henüz fiş yok">
                Cihazda alınan ödemeler burada listelenir
              </EmptyState>
            ) : (
              <ul className="divide-y divide-[var(--admin-divider)]">
                {recent.data.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.basket.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted">
                        {r.status === 'tamamlandi' ? <span>{`Z ${r.zNo} · fiş ${r.receiptNo}`}</span> : <Badge tone={r.status === 'fis_iptal' ? 'red' : 'neutral'}>{r.status === 'fis_iptal' ? 'Fiş iptal' : 'Vazgeçildi'}</Badge>}
                        <span>{fmtTime(r.createdAt)}</span>
                      </span>
                    </span>
                    <span className={cn('tabular shrink-0 font-semibold', r.status !== 'tamamlandi' && 'text-muted line-through decoration-1')}>{tl(r.amount)}</span>
                    {r.status === 'tamamlandi' && (
                      <Button size="sm" variant="dangerGhost" loading={busy === r.id} disabled={!!busy} onClick={() => cancel(r.id, true)}>
                        Fiş iptal
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
    </Stage>
  );
}
