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
  /**
   * Uyarı penceresinin ölçüsü (ms): ödeme anı; planlı siparişte (`scheduledFor`) en erken planlı saatten 30 dakika önce.
   * Geceden ödenmiş sabah siparişi o ana dek çalmaz, saati gelince çalar; saatinden önce denen "Gördüm" onu susturmaz
   * (src/lib/siteAlerts.ts `onlineAckKeys`). Eski sunucu göndermez: `openedAt` geçerli
   */
  dueAt?: number;
  /** Planlı saat (ISO; sitenin `scheduledFor`), planlı değilse null. Eski sunucu göndermez */
  scheduledFor?: string | null;
}

/**
 * Masadan çağrı (uygulamada "Garson çağır", su, peçete; laffogato `src/lib/admin/table-calls-core.ts`). Sitenin sipariş
 * listesindeki `calls` alanından gelir (yeni istek yok); yanıtlanmazsa sitede 15 dakika açık kalır. Misafirin adı yok:
 * yalnız masa ve sebep. docs/03-ENTEGRASYON.md §2.3 "Masa çağrıları"
 */
export interface TableCallDTO {
  /** Sitenin çağrı kimliği (`tcl-…`) */
  id: string;
  /** Masanın adı: eşlenen yerel masa ("S4"), eşlenmezse sitenin etiketi ("Masa 4") */
  label: string;
  /** `waiter` · `water` · `napkin`; site yeni bir sebep eklerse metni "Çağırıyor" */
  reason: string;
  /** Eşlenen yerel masa (QR kodu, sonra etiket; siparişlerin kuralı) */
  tableId: string | null;
  /** Çağrının açıldığı an (ms, sitenin saati) */
  createdAt: number;
}

/** Yanıtlanmayan çağrı sitede bu kadar açık kalır (laffogato `TABLE_CALL_OPEN_MS`); sonra ekranlardan düşer */
export const TABLE_CALL_OPEN_MS = 15 * 60_000;

const TABLE_CALL_REASON_TEXT: Record<string, string> = { waiter: 'Garson çağırıyor', water: 'Su istiyor', napkin: 'Peçete istiyor' };

/** Sebebin personel metni (sitenin `TABLE_CALL_REASON_LABELS`): "Su istiyor" */
export const tableCallReasonText = (reason: string) => TABLE_CALL_REASON_TEXT[reason] ?? 'Çağırıyor';

/** Çağrının uyarı metni: "Masa 4 · Su istiyor" (ad yok) */
export const tableCallText = (c: Pick<TableCallDTO, 'label' | 'reason'>) => `${c.label} · ${tableCallReasonText(c.reason)}`;

/** `GET /api/sync/alerts`: cihazın çalacağı uyarılar. Site bağlantısı yoksa `configured: false`, listeler boş */
export interface SiteAlertsDTO {
  configured: boolean;
  online: OnlineAlertDTO[];
  /** Açık masa çağrıları, en eskisi önce. Eski sunucu göndermez */
  calls?: TableCallDTO[];
}

/** Karaoke satırının uyarı metni: "Karaoke 20:00 · 2 sa · 4 kişi" (ad ve not yok) */
export function karaokeAlertText(b: { startHour: number; hours: number; guests: number }): string {
  return `Karaoke ${String(b.startHour).padStart(2, '0')}:00 · ${b.hours} sa${b.guests > 0 ? ` · ${b.guests} kişi` : ''}`;
}
