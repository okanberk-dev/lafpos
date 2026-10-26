import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import type { OrderDTO } from '@shared/types';
import { ApiError, errorMessage, get } from '@/lib/api';
import { withApproval } from '@/lib/approval';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';

const isOrder = (x: unknown): x is OrderDTO => !!x && typeof x === 'object' && 'items' in x && 'totals' in x;

/**
 * Adisyon sorgusu ve işlem yardımcısı. `act`, sunucu yetkili onayı isterse PIN sorar, dönen güncel adisyonu
 * önbelleğe yazar ve hatayı Türkçe bildirir.
 */
export function useOrder(id: string) {
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['order', id], queryFn: () => get<OrderDTO>(`/orders/${id}`), refetchInterval: REMOTE ? 10_000 : 60_000 });

  const setOrder = useCallback((o: OrderDTO) => qc.setQueryData(['order', o.id], o), [qc]);

  const act = useCallback(
    async <T,>(fn: (approverPin?: string) => Promise<T>, okMessage?: string): Promise<T | null> => {
      try {
        const res = await withApproval(fn);
        if (res === null) return null;
        if (isOrder(res)) setOrder(res);
        else if (res && typeof res === 'object' && 'order' in res && isOrder((res as { order: unknown }).order)) setOrder((res as { order: OrderDTO }).order);
        qc.invalidateQueries({ queryKey: ['floor'] });
        if (okMessage) toast.ok(okMessage);
        return res;
      } catch (e) {
        toast.err(errorMessage(e));
        // Çakışma: adisyon başka cihazda değişmiş (pay, kalem, durum); ekran güncel hâli göstersin
        if (e instanceof ApiError && e.status === 409) void qc.invalidateQueries({ queryKey: ['order', id] });
        return null;
      }
    },
    [qc, setOrder, id],
  );

  return { ...query, order: query.data, act, setOrder };
}
