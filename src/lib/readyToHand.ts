import type { KitchenTicketItem, OrderDTO } from '@shared/types';

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

/**
 * Kasanın gel-al siparişi bara giden kalem taşıyorsa aşaması bardan izlenir (sunucu `pickupFromBar`): Siparişler'de
 * elle aşama düğmesi (Hazır, Yola çıktı, Teslim edildi) yok, sunucu da reddeder (409 `stage_from_bar`); teslim
 * `readyToHand`'in Teslim edildi'siyle. Bara kalem gitmeyen gel-al'da elle aşama sürer
 */
export function stageFromBar(o: OrderDTO): boolean {
  if (o.source !== 'pos' || o.platform || o.type !== 'gelal' || o.status === 'iptal') return false;
  return o.items.some((i) => !i.voided && !!i.stationId);
}

/**
 * Bar ekranı Geçmiş'inin Geri al'ı bir adım geri: teslim edilmiş kalemler "Hazır"a (teslimin geri alınışı: hazır anı
 * korunur, hazır uyarısı yinelenmez, sipariş kuyruğa ve çağrı ekranında "Hazırlanıyor"a dönmez); teslim edilmiş kalem
 * yoksa hazır kalemler "Hazırlanıyor"a. Sunucu da teslim edilmiş kalemi "Hazırlanıyor"a götürmez (`setItemsStatus`)
 */
export function undoStep(items: Pick<KitchenTicketItem, 'id' | 'status' | 'voided'>[]): { ids: string[]; status: 'hazir' | 'hazirlaniyor' } | null {
  const live = items.filter((i) => !i.voided);
  const served = live.filter((i) => i.status === 'servis').map((i) => i.id);
  if (served.length) return { ids: served, status: 'hazir' };
  const ready = live.filter((i) => i.status === 'hazir').map((i) => i.id);
  return ready.length ? { ids: ready, status: 'hazirlaniyor' } : null;
}
