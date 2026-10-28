import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Banknote, CreditCard, Lock, MonitorSmartphone, Receipt, Split, Utensils, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Card, EmptyState, PageHeader } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
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

// Cihaz ekranı LafPOS'un koyu temasıyla çizilir (sarmalayıcı `dark`); renkler belirteçlerden
const TYPES = [
  { type: 1, label: 'Nakit', icon: Banknote, color: 'bg-primary text-primary-ink' },
  { type: 3, label: 'Kredi kartı', icon: CreditCard, color: 'bg-[var(--admin-info)] text-white' },
  { type: 7, label: 'Yemek kartı', icon: Utensils, color: 'bg-warn-600 text-white' },
];

/**
 * Eğitim cihazı: Token ÖKC'nin LafPOS içindeki benzeri. Ayar "simülatör" iken kasadan gönderilen sepetler burada
 * belirir; ödeme alınınca sonuç gerçek cihazdaki gibi (Z no, fiş no, ödeme kalemleri) adisyona işlenir.
 */
export default function DevicePage() {
  const boot = useBoot();
  const qc = useQueryClient();
  const baskets = useQuery({ queryKey: ['okc', 'sim'], queryFn: () => get<SimReceipt[]>('/okc/simulator/baskets'), refetchInterval: 5000 });
  const recent = useQuery({ queryKey: ['okc', 'sim-recent'], queryFn: () => get<SimReceipt[]>('/okc/simulator/recent') });
  const [openId, setOpenId] = useState<string | null>(null);
  const [split, setSplit] = useState<{ type: number; amount: string }[] | null>(null);

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
        <EmptyState icon={<MonitorSmartphone />} title="Eğitim cihazı kapalı">
          Yazarkasa bağlantısı "{boot.integrations.okc.provider === 'tokenx' ? 'TokenX (gerçek cihaz)' : 'kapalı'}" durumda. Yönetim › Yazarkasa POS'tan simülatörü seçebilirsiniz.
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
    if (!current) return;
    try {
      await post(`/okc/simulator/baskets/${current.id}/pay`, { payments });
      beep('tamam');
      toast.ok('Fiş basıldı, ödeme LafPOS\'a işlendi');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['okc'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const cancel = async (id: string, voidReceipt = false) => {
    try {
      // Fiş iptali ödeme iptalidir: yetkisi yoksa yetkili PIN'i istenir
      const done = await withApproval((pin) => post(`/okc/simulator/baskets/${id}/cancel`, { voidReceipt, approverPin: pin }));
      if (done === null) return;
      toast.warn(voidReceipt ? 'Fiş iptal edildi; LafPOS ödemesi geri alındı' : 'Cihazda ödemeden vazgeçildi');
      setOpenId(null);
      qc.invalidateQueries({ queryKey: ['okc'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const splitTotal = (split ?? []).reduce((a, s) => a + (parseTL(s.amount) ?? 0), 0);

  return (
    <div className="scroll-thin h-full overflow-y-auto p-4 md:p-6">
      <PageHeader title="Eğitim cihazı" subtitle="Token ÖKC benzeri: kasadan gönderilen sepetler burada ödenir. Gerçek cihaz bağlanınca bu ekran kullanılmaz" />
      <div className="grid gap-6 lg:grid-cols-[minmax(320px,420px)_1fr]">
        <div className="dark mx-auto w-full max-w-[420px] rounded-[2.2rem] border-[10px] border-night bg-night p-1 shadow-[var(--shadow-pop)]">
          <div className="min-h-[560px] overflow-hidden rounded-[1.6rem] bg-surface text-ink">
            <div className="flex items-center justify-between bg-surface-3 px-4 py-2 text-xs text-ink-2">
              <span className="font-semibold">Token ÖKC · eğitim</span>
              <span className="tabular">{fmtTime(Date.now())}</span>
            </div>
            {!current ? (
              <div className="p-3">
                <div className="mb-2 px-1 text-xs font-medium text-muted">Açık sepetler</div>
                {(baskets.data ?? []).length === 0 && <EmptyState compact icon={<Receipt />} title="Kasadan sepet bekleniyor">Kasada "Hesabı yazarkasaya gönder" deyince burada belirir</EmptyState>}
                <div className="space-y-2">
                  {baskets.data?.map((b) => (
                    <button key={b.id} onClick={() => open(b)} className="flex w-full items-center gap-3 rounded-xl bg-surface-3 p-3 text-left transition-colors duration-100 active:bg-[var(--admin-border)]">
                      <Receipt className="size-5 text-primary" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">{b.basket.title ?? 'Sepet'}</div>
                        <div className="text-xs text-muted">
                          #{b.basket.checkNumber} · {b.basket.filter} · {fmtTime(b.createdAt)}
                        </div>
                      </div>
                      <div className="tabular font-semibold">{tl(b.amount)}</div>
                      {b.status === 'kilitli' && <Lock className="size-4 text-[var(--admin-warning)]" aria-label="Kilitli" />}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div className="flex min-h-[520px] flex-col p-3">
                <button onClick={close} className="mb-2 inline-flex items-center gap-1 text-sm text-[#8fa89a]">
                  <ArrowLeft className="size-4" /> Listeye dön
                </button>
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
                      <div className="flex justify-between text-[11px] text-[#8fa89a]">
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
                      <button key={t.type} onClick={() => pay([{ type: t.type, amount: current.amount }])} className={cn('flex h-14 items-center justify-center gap-2 rounded-xl font-semibold transition-[filter] duration-100 active:brightness-90', t.color)}>
                        <t.icon className="size-5" /> {t.label}
                      </button>
                    ))}
                    <button onClick={() => setSplit([{ type: 3, amount: '' }, { type: 1, amount: '' }])} className="flex h-14 items-center justify-center gap-2 rounded-xl bg-surface-3 font-semibold transition-colors duration-100 active:bg-[var(--admin-border)]">
                      <Split className="size-5" /> Böl
                    </button>
                    <button onClick={() => cancel(current.id)} className="col-span-2 flex h-11 items-center justify-center gap-2 rounded-xl text-sm text-[var(--admin-danger-ink)] transition-colors duration-100 active:bg-surface-3">
                      <XCircle className="size-4" /> Ödemeden vazgeç
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {split.map((s, i) => (
                      <div key={i} className="flex gap-2">
                        <select value={s.type} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, type: Number(e.target.value) } : x)))} aria-label="Ödeme türü" className="select-arrow h-11 appearance-none rounded-lg bg-surface-3 bg-[length:16px] bg-[right_8px_center] bg-no-repeat pl-2 pr-8">
                          {TYPES.map((t) => (
                            <option key={t.type} value={t.type}>
                              {t.label}
                            </option>
                          ))}
                        </select>
                        <input value={s.amount} onChange={(e) => setSplit(split.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} placeholder="Tutar" inputMode="decimal" aria-label="Tutar" className="tabular h-11 min-w-0 flex-1 rounded-lg bg-surface-3 px-3 text-right" />
                      </div>
                    ))}
                    <div className="flex justify-between text-sm">
                      <button className="min-h-11 text-primary" onClick={() => setSplit([...split, { type: 3, amount: '' }])}>
                        + Ödeme ekle
                      </button>
                      <span className={cn('tabular self-center', splitTotal === current.amount ? 'text-[var(--admin-success)]' : 'text-[var(--admin-warning)]')}>
                        {tl(splitTotal)} / {tl(current.amount)}
                      </span>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <button className="h-12 rounded-xl bg-surface-3 transition-colors duration-100 active:bg-[var(--admin-border)]" onClick={() => setSplit(null)}>
                        Geri
                      </button>
                      <button
                        disabled={splitTotal !== current.amount}
                        className="h-12 rounded-xl bg-primary font-semibold text-primary-ink transition-[filter] duration-100 active:brightness-90 disabled:opacity-40"
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
              <li>Kasada "Hesabı yazarkasaya gönder" denir; sepet (ürünler, KDV kısımları, indirimler) cihaza gider.</li>
              <li>Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar.</li>
              <li>Sonuç (Z no, fiş no, ödeme kalemleri) LafPOS'a gelir; adisyon kendiliğinden kapanır.</li>
              <li>Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır ve patron paneline alarm düşer.</li>
            </ol>
          </Card>
          <Card title="Son fişler">
            <ul className="divide-y divide-line">
              {(recent.data ?? []).map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{r.basket.title}</span>
                    <span className="text-xs text-muted">
                      {r.status === 'tamamlandi' ? `Z ${r.zNo} · fiş ${r.receiptNo}` : r.status === 'fis_iptal' ? 'Fiş iptal' : 'Vazgeçildi'} · {fmtTime(r.createdAt)}
                    </span>
                  </span>
                  <span className="tabular font-semibold">{tl(r.amount)}</span>
                  {r.status === 'tamamlandi' && (
                    <Button size="sm" variant="ghost" className="text-danger-500" onClick={() => cancel(r.id, true)}>
                      Fiş iptal
                    </Button>
                  )}
                </li>
              ))}
              {recent.data?.length === 0 && (
                <li>
                  <EmptyState compact title="Henüz fiş yok">
                    Cihazda alınan ödemeler burada listelenir
                  </EmptyState>
                </li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </div>
  );
}
