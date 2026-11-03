import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, CheckCircle2, Loader2, MonitorSmartphone, RefreshCw, XCircle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { tl, tlShort } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Badge } from '@/components/ui/misc';
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
 * Adisyonun yazarkasa sepetleri ve bekleyeni (cihazda ödeme sürüyor). Ödeme penceresi ve yazarkasa kutusu aynı
 * sorguyu paylaşır: sepet beklerken pencere ödemeyi, ciro dışı kapanışı ve ödeme iptalini kapatır (sunucu okc_pending
 * der). Yazarkasa kapalıysa ya da `enabled` değilse sorulmaz; bekleyen sepet varken 4 sn'de bir yenilenir.
 */
export function useOkcReceipts(order: OrderDTO, enabled = true) {
  const boot = useBoot();
  const provider = boot.integrations.okc.provider;
  const receipts = useQuery({
    queryKey: ['okc', order.id],
    queryFn: () => get<ReceiptDTO[]>(`/okc/orders/${order.id}/receipts`),
    enabled: enabled && provider !== 'kapali',
    refetchInterval: (q) => (q.state.data?.some((r) => PENDING.includes(r.status)) ? 4000 : false),
  });
  return { data: receipts.data, pending: receipts.data?.find((r) => PENDING.includes(r.status)) };
}

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
  /** Sepet iptali sürüyor (cihaza sorulur, gerekirse yetkili onayı): ikinci dokunuş gitmez */
  const [cancelling, setCancelling] = useState(false);
  const receipts = useOkcReceipts(order);
  const pending = receipts.pending;
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
    if (cancelling) return;
    setCancelling(true);
    try {
      await post(`/okc/receipts/${id}/cancel`);
      await qc.invalidateQueries({ queryKey: ['okc', order.id] });
    } catch (e) {
      // İnternet ya da Token kesintisi: sepet cihazdan silinemiyor. Yetkili onayıyla LafPOS'ta iptal sayılır ki adisyon
      // nakit alınabilsin ve gün kapanabilsin; cihazda yine de ödeme alınırsa yönetici alarm görür
      if (e instanceof ApiError && e.code === 'okc_delete') {
        const ok = await confirmDialog({
          title: 'Sepet LafPOS’ta iptal sayılsın mı',
          body: (
            <>
              <p>{e.message}</p>
              <p className="mt-2">Cihaza ulaşılamıyor. Cihazda bu sepetten ödeme alınmadığından emin olun; alınırsa yönetici alarm görür</p>
            </>
          ),
          confirmLabel: 'Sepeti iptal say',
        });
        if (!ok) return;
        try {
          const done = await withApproval((pin) => post(`/okc/receipts/${id}/cancel`, { force: true, approverPin: pin }));
          if (done === null) return;
          toast.warn('Sepet LafPOS’ta iptal sayıldı; adisyonu kasadan alabilirsiniz');
          await qc.invalidateQueries({ queryKey: ['okc', order.id] });
          await qc.invalidateQueries({ queryKey: ['order', order.id] });
        } catch (err) {
          toast.err(errorMessage(err));
        }
        return;
      }
      toast.err(errorMessage(e));
    } finally {
      setCancelling(false);
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
  // Sunucunun gönderim kuralı (okc_partial, split_active): gidemeyecek sepet için düğme yerine ne yapılacağı yazılır.
  // Cihazın ödemesi de kalem taşımayabilir: tamamlanmış fiş varken hangisinin LafPOS'ta alındığı bilinmez, karar sunucuda
  const splitOpen = !!order.split?.shares.length;
  const amountPaidHere = !!receipts.data && !receipts.data.some((r) => r.status === 'tamamlandi') && order.payments.some((p) => !p.refundedAt && !p.items?.length);
  const blocked = items?.length
    ? splitOpen
      ? 'Hesap kişilere bölünmüş: payları “Paylaş”tan alın ya da paylaşımı kaldırın'
      : null
    : amountPaidHere
      ? splitOpen
        ? 'Pay LafPOS’ta alındı: kalan payları da burada alın'
        : 'Adisyonda tutar olarak alınmış ödeme var: kalanı burada alın ya da kalemleri “Kalem seç” ile cihaza gönderin'
      : null;

  return (
    <div className="rounded-xl border border-line p-3">
      <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
        <span className="grid size-7 place-items-center rounded-lg bg-surface-3 text-ink-2">
          <MonitorSmartphone className="size-4" />
        </span>
        Yazarkasa POS {provider === 'simulator' && <Badge tone="warning">Eğitim cihazı</Badge>}
      </div>
      {pending ? (
        // Dar ekranda eylemler durumun altına iner (durum yazısı iki kelimelik sütuna ezilmez)
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Loader2 aria-hidden="true" className="size-5 shrink-0 animate-spin text-muted" />
          <div role="status" className="min-w-0 flex-1 basis-44 text-sm">
            <div className="font-medium">{pending.status === 'kilitli' ? 'Cihazda açıldı, ödeme alınıyor…' : 'Cihazda ödeme bekleniyor…'}</div>
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
          <div className="ml-auto flex items-center gap-1">
            {provider === 'tokenx' && (
              <IconButton size="sm" label="Durumu sorgula" onClick={() => refresh(pending.id)}>
                <RefreshCw className="size-4" />
              </IconButton>
            )}
            <Button size="sm" variant="dangerGhost" loading={cancelling} onClick={() => void cancel(pending.id)}>
              Sepeti iptal et
            </Button>
          </div>
        </div>
      ) : blocked ? (
        <p className="text-[13px] text-ink-2">{blocked}</p>
      ) : (
        <>
          {/* Dar ekranda uzun yazı ("Seçilen kalemleri…") kapsülün kenarına dayanmaz, iki satıra iner */}
          <Button
            block
            variant="secondary"
            icon={<MonitorSmartphone className="size-4" />}
            loading={busy}
            onClick={send}
            disabled={order.total - order.paid <= 0}
            className="h-auto min-h-11 whitespace-normal py-2 leading-tight"
          >
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
          {/* Kasiyerin iptal ettiği sepet hata değil: gri yasak işareti; kırmızı yalnız cihaz hatası */}
          {last.status === 'tamamlandi' ? (
            <CheckCircle2 className="size-3.5 shrink-0 text-[var(--admin-success)]" />
          ) : last.status === 'hata' ? (
            <XCircle className="size-3.5 shrink-0 text-[var(--admin-danger-ink)]" />
          ) : (
            <Ban className="size-3.5 shrink-0 text-muted" />
          )}
          <span className="text-muted">
            Son sepet: {last.status === 'tamamlandi' ? `ödendi${last.zNo != null ? ` · Z ${last.zNo}` : ''}${last.receiptNo != null ? ` · ${last.docKind === 'bilgi_fisi' ? 'bilgi fişi' : 'fiş'} ${last.receiptNo}` : ''}${last.docId ? ` · ${last.docKind === 'e_fatura' ? 'e-Fatura' : 'e-Arşiv'} ${last.docId}` : ''}` : last.status === 'hata' ? (last.error ?? 'hata') : last.status === 'fis_iptal' ? 'fiş iptal edildi' : 'iptal edildi'}
          </span>
        </div>
      )}
    </div>
  );
}
