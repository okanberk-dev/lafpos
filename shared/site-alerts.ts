/**
 * Diğer sistemlerden gelen uyarılar: online sipariş (uygulama, web, masa QR) ve karaoke rezervasyonu. Sunucu
 * (`server/sync/laffogato-orders.ts`, `server/sync/laffogato-karaoke.ts`) ve istemci (`src/lib/siteAlerts.ts`) aynı
 * kuralları okur. docs/03-ENTEGRASYON.md §2.5 "Sesli uyarılar"
 */

/** Yeni online sipariş bu süreden eskiyse (ödeme anından) artık çalmaz */
export const ONLINE_ALERT_MAX_AGE_MS = 4 * 3600_000;

/** Yeni aşamasında bekleyen online sipariş (bar henüz başlamadı) */
export interface OnlineAlertDTO {
  orderId: string;
  /** Sitenin sipariş numarası */
  no: number;
  /** "Masa 4", "Gel-al", "Kurye" */
  label: string;
  /** Masa siparişi: zil daha yüksek çalar (sitenin `RING_LEVEL_TABLE`) */
  table: boolean;
  tableId: string | null;
  /** Ödeme anı (ms) */
  openedAt: number;
}

/** `GET /api/sync/alerts`: cihazın çalacağı uyarılar. Site bağlantısı yoksa `configured: false`, liste boş */
export interface SiteAlertsDTO {
  configured: boolean;
  online: OnlineAlertDTO[];
}

/** Karaoke satırının uyarı metni: "Karaoke 20:00 · 2 sa · 4 kişi" (ad ve not yok) */
export function karaokeAlertText(b: { startHour: number; hours: number; guests: number }): string {
  return `Karaoke ${String(b.startHour).padStart(2, '0')}:00 · ${b.hours} sa${b.guests > 0 ? ` · ${b.guests} kişi` : ''}`;
}
