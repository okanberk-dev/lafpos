import type { PlatformId } from './platforms';

/** Sunucudan cihazlara yayılan canlı olaylar. `topic`, istemcide hangi sorguların yenileneceğini belirler. */
export type LiveTopic =
  | 'orders'
  | 'tables'
  | 'kitchen'
  | 'menu'
  | 'cash'
  | 'settings'
  | 'sync'
  | 'delivery'
  | 'reservations'
  | 'stock'
  | 'customers'
  | 'users'
  | 'alerts'
  | 'okc'
  /** Mesai: giriş-çıkış ve yöneticinin düzeltmeleri (time.in, time.out, time.edit, time.delete) */
  | 'time';

export interface LiveEvent {
  seq: number;
  at: number;
  topic: LiveTopic;
  /** Kısa açıklama: "order.sent", "payment.added" … */
  kind: string;
  orderId?: string;
  tableId?: string;
  /** Mutfak/bar fişi gibi bildirim gerektiren olaylarda istasyon */
  stationId?: string;
  /** Patron paneline düşen uyarı metni */
  message?: string;
  /** Olayı yapan kullanıcı (kendi ekranında bildirim çalmasın diye) */
  byUserId?: string;
  /** Bildirimin hedefi: "hazır" uyarısı siparişi alan kişinin ekranında çalar */
  forUserId?: string;
  /** "Hazır" uyarısı paket platformu siparişinde: paket siparişlerini yöneten her cihazda çalar (`readyAlertFor`) */
  platform?: PlatformId;
}

/**
 * "Hazır" uyarısı bu kişinin cihazında çalar mı. Siparişi alan kişi (garson, kasiyer) görür. Paket platformu
 * siparişinin "alanı" kabul edendir: otomatik kabulde ayarda seçilen kişi kafede olmayabilir, uyarı yalnız ona giderse
 * kasada kimse görmez. Bu yüzden platform siparişinde paket yetkili (`paket.yonet`: şeritteki siparişleri yöneten)
 * her cihaz da görür; bir olay bir cihazda bir kez değerlendirildiği için çift uyarı olmaz. "Hazır"a basan kendi
 * ekranında uyarı görmez.
 */
export function readyAlertFor(e: Pick<LiveEvent, 'kind' | 'forUserId' | 'byUserId' | 'message' | 'platform'>, me: { id: string; permissions: readonly string[] }): boolean {
  if (e.kind !== 'items.ready' || !e.message || e.byUserId === me.id) return false;
  if (e.forUserId === me.id) return true;
  return !!e.platform && me.permissions.includes('paket.yonet');
}
