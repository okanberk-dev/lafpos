import type { OrderDTO } from '@shared/types';
import { post } from './api';

const KEY = 'lafpos.counterDraft';

/**
 * Tezgâh satışı açar. Bu cihazın (sekmenin) son boş tezgâh adisyonu varsa sunucu onu yeniden kullanır: art arda
 * basış ya da satış sonrası "Yeni satış" boş adisyon biriktirmez, aynı PIN'le açık iki kasa da aynı adisyonu almaz.
 */
export async function openCounterSale(): Promise<OrderDTO> {
  let reuse: string | null = null;
  try {
    reuse = sessionStorage.getItem(KEY);
  } catch {
    /* depolama yok: yeni adisyon açılır */
  }
  const order = await post<OrderDTO>('/orders', { type: 'tezgah', ...(reuse ? { reuse } : {}) });
  try {
    sessionStorage.setItem(KEY, order.id);
  } catch {
    /* yeniden kullanılmaz, sorun değil */
  }
  return order;
}
