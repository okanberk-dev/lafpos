import { useQueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { BootstrapDTO } from '@shared/types';
import { post } from './api';
import { sendableOptions } from './boot';
import { flushBatch, type SendBatch, useCart } from './cart';
import { REMOTE } from './remote';
import { toast } from './toast';

/** Gönderimin gövdesi (adisyon ekranının "Gönder"i ve arka plan döngüsü aynı kimlikle aynı gövdeyi yollar) */
export function batchBody(boot: BootstrapDTO, batch: SendBatch, approverPin?: string | null) {
  return {
    items: batch.lines.map((l) => ({ productId: l.productId, size: l.size, qty: l.qty, options: sendableOptions(boot, l.productId, l.options), note: l.note || null, ...(l.priceOverride != null ? { priceOverride: l.priceOverride } : {}) })),
    ...(batch.hold ? { hold: true } : {}),
    clientBatchId: batch.id,
    ...(approverPin ? { approverPin } : {}),
  };
}

/**
 * Bekleyen gönderimlerin (kasaya ulaşılamadı) uygulama düzeyindeki döngüsü: 3 sn'de bir sağlık sorusu, kasa dönünce
 * her adisyonun kaydı aynı kimlikle gider. Garson adisyondan çıkıp başka masaya geçse de sipariş bara ulaşır (denetim
 * bulgu 17/27). Kasa reddederse satırlar o adisyonun sepetine döner ve bildirim çıkar. AppShell'de bir kez çalışır
 */
export function useOutbox(boot: BootstrapDTO) {
  const qc = useQueryClient();
  const hasBatches = useCart((s) => Object.keys(s.batches ?? {}).length > 0);
  useEffect(() => {
    if (!hasBatches || REMOTE) return;
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const up = await fetch('/api/health', { cache: 'no-store' }).then((r) => r.ok, () => false);
        if (!up) return;
        for (const [orderId, batch] of Object.entries(useCart.getState().batches ?? {})) {
          const result = await flushBatch(orderId, batch, () => post(`/orders/${orderId}/items`, batchBody(boot, batch)));
          if (result === 'sent') toast.ok('Bekleyen sipariş kasaya gönderildi');
          if (result === 'rejected') toast.err('Bekleyen sipariş kasada kabul edilmedi; ürünler adisyonun sepetine geri kondu');
          if (result === 'sent' || result === 'rejected') {
            void qc.invalidateQueries({ queryKey: ['kitchen'] });
            void qc.invalidateQueries({ queryKey: ['floor'] });
            void qc.invalidateQueries({ queryKey: ['order', orderId] });
          }
        }
      } finally {
        busy = false;
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [hasBatches, boot, qc]);
}
