import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, MonitorSmartphone, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { tl, tlShort } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { ApiError, errorMessage, get, post } from '@/lib/api';
import { withApproval } from '@/lib/approval';
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
  docKind: 'okc_fis' | 'bilgi_fisi' | 'e_arsiv' | 'e_fatura' | null;
  docId: string | null;
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
      // İnternet ya da Token kesintisi: sepet cihazdan silinemiyor. Yetkili onayıyla LafPOS'ta iptal sayılır ki adisyon
      // nakit alınabilsin ve gün kapanabilsin; cihazda yine de ödeme alınırsa yönetici alarm görür
      if (e instanceof ApiError && e.code === 'okc_delete') {
        const ok = window.confirm(`${e.message}\n\nCihaza ulaşılamıyor. Sepet LafPOS'ta iptal sayılsın mı? Cihazda bu sepetten ödeme alınmadığından emin olun.`);
        if (!ok) return;
        try {
          const done = await withApproval((pin) => post(`/okc/receipts/${id}/cancel`, { force: true, approverPin: pin }));
          if (done === null) return;
          toast.warn("Sepet LafPOS'ta iptal sayıldı; adisyonu kasadan alabilirsiniz");
          await qc.invalidateQueries({ queryKey: ['okc', order.id] });
          await qc.invalidateQueries({ queryKey: ['order', order.id] });
        } catch (err) {
          toast.err(errorMessage(err));
        }
        return;
      }
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
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-surface-3 text-ink-2">
          <MonitorSmartphone className="size-4" />
        </span>
        Yazarkasa POS {provider === 'simulator' && <span className="rounded-md bg-[var(--admin-warning-soft)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--admin-warning)]">eğitim cihazı</span>}
      </div>
      {pending ? (
        <div className="flex items-center gap-3">
          <Loader2 className="size-5 animate-spin text-primary" />
          <div className="min-w-0 flex-1 text-sm">
            <div className="font-medium">{pending.status === 'kilitli' ? 'Cihazda açıldı, ödeme alınıyor' : 'Cihazda ödeme bekleniyor'}</div>
            <div className="text-xs text-muted">
              {tl(pending.amount)}
              {provider === 'simulator' && (
                <>
                  {' · '}
                  <Link to="/cihaz" className="font-semibold text-primary underline">
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
          <Button size="sm" variant="ghost" className="text-[var(--admin-danger-ink)]" onClick={() => cancel(pending.id)}>
            İptal
          </Button>
        </div>
      ) : (
        <>
          <Button block variant="secondary" icon={<MonitorSmartphone className="size-4" />} loading={busy} onClick={send} disabled={order.total - order.paid <= 0}>
            {items?.length ? 'Seçilen kalemleri' : 'Hesabı'} yazarkasaya gönder
          </Button>
          {/* Paylaşımlı hesap cihazda tek mali fiştir: paylar cihazda ayrı ayrı ödeme olarak alınır. LafPOS'ta pay
              alındıysa hesap artık bütün olarak gitmez (sunucu okc_partial der); ipucu yalnız hiç ödeme yokken */}
          {!items?.length && order.paid === 0 && order.split && order.split.shares.length > 1 ? (
            <p className="tabular mt-1.5 text-xs text-ink-2">
              Paylaşımlı hesap: cihazda {order.split.shares.length} ayrı ödeme alın ({order.split.shares.map((s) => tlShort(s)).join(' · ')}); fiş tek kesilir
            </p>
          ) : (
            <p className="mt-1.5 text-xs text-muted">Ödeme ve mali fiş cihazda alınır; sonuç gelince adisyon kendiliğinden kapanır</p>
          )}
        </>
      )}
      {last && !pending && last.status !== 'gonderildi' && (
        <div className="mt-2 flex items-center gap-1.5 text-xs">
          {last.status === 'tamamlandi' ? <CheckCircle2 className="size-3.5 text-[var(--admin-success)]" /> : <XCircle className="size-3.5 text-[var(--admin-danger-ink)]" />}
          <span className="text-muted">
            Son sepet: {last.status === 'tamamlandi' ? `ödendi${last.zNo != null ? ` · Z ${last.zNo}` : ''}${last.receiptNo != null ? ` · ${last.docKind === 'bilgi_fisi' ? 'bilgi fişi' : 'fiş'} ${last.receiptNo}` : ''}${last.docId ? ` · ${last.docKind === 'e_fatura' ? 'e-Fatura' : 'e-Arşiv'} ${last.docId}` : ''}` : last.status === 'hata' ? (last.error ?? 'hata') : last.status === 'fis_iptal' ? 'fiş iptal edildi' : 'iptal edildi'}
          </span>
        </div>
      )}
    </div>
  );
}
