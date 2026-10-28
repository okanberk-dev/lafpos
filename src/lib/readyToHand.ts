import type { OrderDTO } from '@shared/types';

/**
 * Kasadan (adisyon, Siparişler) teslim edilebilen hazır kalemler: kasanın tezgâh ve gel-al siparişi. Site ve paket
 * platformu siparişinin teslimi kendi akışında (site düğmesi, teslim aşaması). Kalemin durumu esastır, gel-al'ın
 * aşaması değil: teslim edilmiş siparişe sonradan eklenen kalem hazır olunca yine teslim edilir.
 */
export function readyToHand(o: OrderDTO): string[] {
  if (o.source !== 'pos' || o.platform || (o.type !== 'tezgah' && o.type !== 'gelal')) return [];
  if (o.status !== 'acik' && o.status !== 'kapali') return [];
  return o.items.filter((i) => !i.voided && i.stationId && i.status === 'hazir').map((i) => i.id);
}
