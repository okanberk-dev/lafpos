import type { OrderDTO } from '@shared/types';
import { errorMessage, post } from './api';
import { toast } from './toast';

/**
 * Kasadan (adisyon, Siparişler) teslim edilebilen hazır kalemler: kasanın tezgâh ve gel-al siparişi. Site ve paket
 * platformu siparişinin teslimi kendi akışında (site düğmesi, teslim aşaması); teslim aşamasına geçmiş gel-al da yok.
 */
export function readyToHand(o: OrderDTO): string[] {
  if (o.source !== 'pos' || o.platform || (o.type !== 'tezgah' && o.type !== 'gelal')) return [];
  if ((o.status !== 'acik' && o.status !== 'kapali') || o.deliveryStatus === 'teslim') return [];
  return o.items.filter((i) => !i.voided && i.stationId && i.status === 'hazir').map((i) => i.id);
}

/**
 * "Teslim edildi": hazır kalemler servise geçer, sipariş çağrı ekranından ve bar ekranının Hazır sekmesinden hemen
 * düşer, hazırdan teslime süresi yazılır. Onay penceresi yok; bildirimdeki "Geri al" aynı kalemleri hazıra döndürür
 * (hazır olduğu an korunur, hazır uyarısı yinelenmez). `name` bildirimin öznesi ("No 34", "Masa 12").
 */
export async function deliverItems(itemIds: string[], name: string, refresh: () => unknown): Promise<boolean> {
  if (!itemIds.length) return false;
  try {
    await post('/kitchen/status', { itemIds, status: 'servis' });
  } catch (e) {
    toast.err(errorMessage(e));
    return false;
  }
  void refresh();
  toast.ok(`${name} teslim edildi`, {
    action: {
      label: 'Geri al',
      run: () =>
        void post('/kitchen/status', { itemIds, status: 'hazir' }).then(
          () => void refresh(),
          (e) => toast.err(errorMessage(e)),
        ),
    },
  });
  return true;
}
