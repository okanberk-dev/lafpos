import type { OrderItemDTO } from '@shared/types';

/**
 * Adisyonun kalemleri duruma göre gruplar (bir bakışta okunsun): Gönderilmedi (cihazdaki sepet, ayrı), Barda (bar ya da
 * mutfak bekliyor ya da hazırlıyor), Hazır (alınmayı bekliyor), Teslim (servis edildi ya da bara gitmeyen kalem) ve en
 * altta İptal. Sıra hep bu; boş grup çizilmez. Grubun içinde kalemler eklendikleri sırada (en eski üstte).
 */
export type CartGroupKey = 'barda' | 'hazir' | 'teslim' | 'iptal';

export const CART_GROUP_LABEL: Record<CartGroupKey | 'gonderilmedi', string> = {
  gonderilmedi: 'Gönderilmedi',
  barda: 'Barda',
  hazir: 'Hazır',
  teslim: 'Teslim',
  iptal: 'İptal edilenler',
};

/** Kalemin grubu: iptal her şeyden önce; bara gitmeyen kalem (istasyonsuz) doğrudan teslim sayılır */
export function cartGroupOf(i: Pick<OrderItemDTO, 'voided' | 'stationId' | 'status'>): CartGroupKey {
  if (i.voided) return 'iptal';
  if (!i.stationId) return 'teslim';
  if (i.status === 'hazir') return 'hazir';
  if (i.status === 'servis') return 'teslim';
  return 'barda';
}

const ORDER: CartGroupKey[] = ['barda', 'hazir', 'teslim', 'iptal'];

export function groupCartItems<T extends Pick<OrderItemDTO, 'voided' | 'stationId' | 'status'>>(items: readonly T[]): { key: CartGroupKey; label: string; items: T[] }[] {
  const by = new Map<CartGroupKey, T[]>();
  for (const i of items) {
    const k = cartGroupOf(i);
    (by.get(k) ?? by.set(k, []).get(k)!).push(i);
  }
  return ORDER.filter((k) => by.has(k)).map((k) => ({ key: k, label: CART_GROUP_LABEL[k], items: by.get(k)! }));
}
