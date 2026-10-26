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
  | 'alerts';

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
}
