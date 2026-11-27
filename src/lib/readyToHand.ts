import { ORDER_TYPE_LABEL } from '@shared/labels';
import { callFor, callText, numaratorLabel, type ServiceMode } from '@shared/service-mode';
import type { KitchenTicket, KitchenTicketItem, OrderDTO } from '@shared/types';
import { joinMeta } from './text';

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

/**
 * Bar ekranı Geçmiş'inde teslim edilebilen kalemler: kasanın siparişinde (site ve paket platformu değil) hazır kalemler.
 * Geçmiş'te teslimi geri alınan 30 dakikadan eski sipariş Hazır sekmesine dönmez (hazır anı korunur); barista onu
 * Geçmiş'ten yeniden teslim eder (Geri al'ın yanında Teslim edildi, aynı uç)
 */
export function historyHandIds(t: Pick<KitchenTicket, 'source' | 'platform' | 'items'>): string[] {
  if (t.source !== 'pos' || t.platform) return [];
  return t.items.filter((i) => !i.voided && i.status === 'hazir').map((i) => i.id);
}

/**
 * Siparişler kartının adı (teslim bildiriminin öznesi de). Self modlarda kasanın tezgâh ve gel-al siparişi çağrı
 * numarasıyla ("No 34 · Ayşe Yılmaz"); paket platformunun gel-al'ı platformun kısa koduyla ("K9TX · Deniz Öztürk"):
 * müşteri AsilPOS numarasını bilmez, uygulamada platformun kodunu görür (çağrı ekranı gibi). `head` varsa sipariş
 * numarası ("#12") ayrıca yazılmaz.
 */
export function orderCardName(
  o: Pick<OrderDTO, 'type' | 'source' | 'no' | 'numarator' | 'platform' | 'platformCode' | 'tableName' | 'extLabel' | 'deliveryName'>,
  mode: ServiceMode,
): { name: string; head: string | null } {
  const call = o.platform ? null : callFor(o, mode);
  const head = call?.kind === 'numara' ? callText(call) : o.platform && o.type === 'gelal' ? o.platformCode : null;
  if (head) return { name: joinMeta([head, o.deliveryName]), head };
  return { name: o.tableName ?? o.extLabel ?? o.deliveryName ?? (o.numarator ? numaratorLabel(o.numarator) : ORDER_TYPE_LABEL[o.type]), head: null };
}
