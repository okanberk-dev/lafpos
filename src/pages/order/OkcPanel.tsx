import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, MonitorSmartphone, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { onLive } from '@/lib/live';
import { toast } from '@/lib/toast';

export interface ReceiptDTO {
  id: string;
  orderId: string;
  provider: 'tokenx' | 'simulator';
  mode: 'anlik' | 'liste';
  status: 'gonderildi' | 'kilitli' | 'tamamlandi' | 'iptal' | 'hata' | 'silindi' | 'fis_iptal';
  amount: number;
  zNo: number | null;
  receiptNo: number | null;
  error: string | null;
  lockedBy: string | null;
  createdAt: number;
  completedAt: number | null;
}

const PENDING = ['gonderildi', 'kilitli'];

/**
 * Ödeme penceresindeki "Yazarkasa POS'a gönder" bölümü. Adisyon (ya da seçilen kalemler) cihaza sepet olarak
 * gider; ödeme ve mali fiş cihazda alınır, sonuç gelince adisyon kendiliğinden kapanır.
 */
export function OkcPanel({ order, items, onCompleted }: { order: OrderDTO; amount: number; items: { itemId: string; qty: number }[] | null; onCompleted: (closed: boolean) => void }) {
  const boot = useBoot();
  const can = useCan();
  const qc = useQueryClient();
  const provider = boot.integrations.okc.provider;
  const [busy, setBusy] = useState(false);
  const receipts = useQuery({
    queryKey: ['okc', order.id],
    queryFn: () => get<ReceiptDTO[]>(`/okc/orders/${order.id}/receipts`),
    enabled: provider !== 'kapali',
    refetchInterval: (q) => (q.state.data?.some((r) => PENDING.includes(r.status)) ? 4000 : false),
  });
  const pending = receipts.data?.find((r) => PENDING.includes(r.status));
  const notified = useRef<string | null>(null);

  useEffect(() => {
    return onLive((e) => {
      if (e.topic !== 'okc' || e.orderId !== order.id) return;
      qc.invalidateQueries({ queryKey: ['okc', order.id] });
      qc.invalidateQueries({ queryKey: ['order', order.id] });
      if (e.kind === 'okc.paid' && notified.current !== `${e.seq}`) {
        notified.current = `${e.seq}`;
        toast.ok(e.message ?? 'Yazarkasada ödendi');
        onCompleted(!!e.message?.includes('kapandı'));
      }
      if (e.kind === 'okc.cancelled' || e.kind === 'okc.error' || e.kind === 'okc.void') toast.warn(e.message ?? 'Cihaz işlemi iptal edildi');
    });
  }, [order.id, qc, onCompleted]);

  if (provider === 'kapali' || !can('odeme.al')) return null;

  const send = async () => {
    setBusy(true);
    try {
      await post(`/okc/orders/${order.id}/send`, { items });
      await qc.invalidateQueries({ queryKey: ['okc', order.id] });
      toast.info(provider === 'simulator' ? 'Sepet eğitim cihazına gönderildi' : boot.integrations.okc.mode === 'anlik' ? 'Sepet yazarkasaya gönderildi; ödemeyi cihazdan alın' : 'Sepet cihaz listesine eklendi');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  const cancel = async (id: string) => {
    try {
      await post(`/okc/receipts/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['okc', order.id] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const refresh = async (id: string) => {
    try {
      await post(`/okc/receipts/${id}/refresh`);
      await qc.invalidateQueries({ queryKey: ['okc', order.id] });
      await qc.invalidateQueries({ queryKey: ['order', order.id] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const last = receipts.data?.[0];

  return (
    <div className="rounded-2xl border border-line bg-surface-2/60 p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <MonitorSmartphone className="size-4 text-forest-600" />
        Yazarkasa POS {provider === 'simulator' && <span className="rounded-full bg-brass-100 px-2 py-0.5 text-[11px] text-brass-700">eğitim cihazı</span>}
      </div>
      {pending ? (
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-forest-600" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{pending.status === 'kilitli' ? 'Cihazda açıldı, ödeme alınıyor' : 'Cihazda ödeme bekleniyor'}</div>
            <div className="text-xs text-muted">
              {tl(pending.amount)}
              {provider === 'simulator' && (
                <>
                  {' · '}
                  <Link to="/cihaz" className="font-semibold text-forest-600 underline">
                    Eğitim cihazını aç
                  </Link>
                </>
              )}
            </div>
          </div>
          {provider === 'tokenx' && (
            <Button size="sm" variant="ghost" aria-label="Durumu sorgula" onClick={() => refresh(pending.id)}>
              <RefreshCw className="size-4" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="text-burgundy-500" onClick={() => cancel(pending.id)}>
            İptal
          </Button>
        </div>
      ) : (
        <>
          <Button block variant="brass" loading={busy} onClick={send} disabled={order.total - order.paid <= 0}>
            {items?.length ? 'Seçilen kalemleri' : 'Hesabı'} yazarkasaya gönder
          </Button>
          <p className="mt-1.5 text-xs text-muted">Ödeme ve mali fiş cihazda alınır; sonuç gelince adisyon kendiliğinden kapanır</p>
        </>
      )}
      {last && !pending && last.status !== 'gonderildi' && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          {last.status === 'tamamlandi' ? <CheckCircle2 className="size-3.5 text-forest-500" /> : <XCircle className="size-3.5 text-burgundy-500" />}
          <span className="text-muted">
            Son sepet: {last.status === 'tamamlandi' ? `ödendi${last.zNo != null ? ` · Z ${last.zNo}` : ''}${last.receiptNo != null ? ` · fiş ${last.receiptNo}` : ''}` : last.status === 'hata' ? (last.error ?? 'hata') : last.status === 'fis_iptal' ? 'fiş iptal edildi' : 'iptal edildi'}
          </span>
        </div>
      )}
    </div>
  );
}
