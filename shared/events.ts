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
  | 'okc';

/**
 * Diğer sistemlerden (laffogato sitesi ve lafmobil uygulaması; aynı siparişleri köşkün paneli ladmin de görür) gelen
 * ve cihazlarda sesli uyarı çalan olaylar (docs/03-ENTEGRASYON.md §2.5 "Sesli uyarılar"; istemci
 * `src/lib/siteAlerts.ts`, `src/components/SiteInbox.tsx`). Hepsi var olan çekimlerden doğar (sipariş listesi, karaoke
 * listesi): yeni istek açmaz. Metinde ad, not, telefon yok; yalnız masa, sipariş no, saat, süre, kişi sayısı.
 *
 * - `orders` › `online.new`: yeni online sipariş, `message` "Online sipariş: Masa 4 · Ayşe" (bar için ayrıca
 *   `kitchen` › `ticket.new`, `message: 'online'`). `online.updated`: aşaması ya da masası sitede değişti.
 *   `online.stage`: LafPOS aşamayı siteye yazdı. `online.done`: siteden kalktı, `message` "Online sipariş #N siteden
 *   kalktı".
 * - `reservations` › `site.karaoke.new`, `site.karaoke.cancelled`, `site.karaoke.moved`: bugünün site karaoke
 *   listesinde yeni, iptal edilen, saati değişen ya da günden kalkan rezervasyon, `message` "Karaoke 20:00 · 2 sa ·
 *   4 kişi". Listenin değiştiğini söyleyen `site.karaoke` de yayılır (ekranlar yenilenir).
 */
export const SITE_EVENT = {
  onlineNew: 'online.new',
  onlineUpdated: 'online.updated',
  onlineStage: 'online.stage',
  onlineDone: 'online.done',
  karaokeNew: 'site.karaoke.new',
  karaokeCancelled: 'site.karaoke.cancelled',
  karaokeMoved: 'site.karaoke.moved',
} as const;

export type SiteEventKind = (typeof SITE_EVENT)[keyof typeof SITE_EVENT];

export interface LiveEvent {
  seq: number;
  at: number;
  topic: LiveTopic;
  /** Kısa açıklama: "order.sent", "payment.added" …; diğer sistemlerden gelenler `SITE_EVENT` */
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
