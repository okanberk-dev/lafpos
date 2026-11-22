/**
 * Elle Tükendi / Satışa aç'ın sonucu (`POST /api/sync/products/:id/availability`, server/sync/laffogato-orders.ts
 * `setAvailability`) ve kasiyere gösterilen kısa bildirim. Siteye bağlı üründe önce site yazılır; internet yokken
 * değişiklik kasada hemen geçerli olur, sitenin yazımı giden kutusunda bekler ve internet gelince gider. Üst çubuktaki
 * "İnternet yok · N kayıt bekliyor" rozeti (src/components/InternetBadge.tsx) bekleyen yazımı sayar.
 * docs/03-ENTEGRASYON.md §2.3 "İnternet yokken Tükendi"
 */

/**
 * Sitenin durumu: `guncellendi` site ve uygulama da güncellendi; `kuyrukta` siteye ulaşılamadı, yazım giden kutusunda;
 * `bagli_degil` LafPOS'un yerel ürünü; `baglanti_yok` site adresi yok; `anahtar_yok` site anahtarı yok (yalnız LafPOS)
 */
export type SiteWrite = 'guncellendi' | 'bagli_degil' | 'anahtar_yok' | 'baglanti_yok' | 'kuyrukta';

/**
 * Yazım neden kuyrukta: `internet` internet yok (ağ hatası, zaman aşımı ya da internetin olmadığı zaten biliniyor),
 * `site` internet var ama site geçici olarak yanıt vermedi (5xx, 429)
 */
export type SiteQueueReason = 'internet' | 'site';

export interface AvailabilityResultDTO {
  site: SiteWrite;
  /** Yalnız `kuyrukta` iken */
  neden?: SiteQueueReason;
}

/** İnternet yokken kasiyerin bildirimi (sahibin metni) */
export const QUEUED_OFFLINE_TEXT = 'İnternet yok: kasada uygulandı, site internet gelince güncellenecek';
/** İnternet var ama site geçici olarak yanıt vermedi (5xx, 429): "internet yok" demek yanlış olurdu */
export const QUEUED_SITE_DOWN_TEXT = 'Site şu an yanıt vermiyor: kasada uygulandı, site düzelince güncellenecek';

/**
 * Bildirimin tonu ve metni. Yazım kuyruğa girdiyse uyarı tonunda ("Americano tükendi. İnternet yok: kasada uygulandı,
 * site internet gelince güncellenecek"), değilse başarı. `admin`: Yönetim › Ürünler, site anahtarı ya da bağlantısı
 * yoksa bunu da söyler (kasiyerin penceresinde söylenmez)
 */
export function availabilityNotice(name: string, active: boolean, r: AvailabilityResultDTO, opts: { admin?: boolean } = {}): { tone: 'ok' | 'warn'; text: string } {
  const done = `${name} ${active ? 'satışa açıldı' : 'tükendi'}`;
  if (r.site === 'kuyrukta') return { tone: 'warn', text: `${done}. ${r.neden === 'site' ? QUEUED_SITE_DOWN_TEXT : QUEUED_OFFLINE_TEXT}` };
  if (r.site === 'guncellendi') return { tone: 'ok', text: `${done}; site ve uygulama da güncellendi` };
  if (opts.admin && r.site === 'anahtar_yok') return { tone: 'ok', text: `${done}; site anahtarı yok, yalnız LafPOS` };
  if (opts.admin && r.site === 'baglanti_yok') return { tone: 'ok', text: `${done}; site bağlantısı kurulmadı, yalnız LafPOS` };
  return { tone: 'ok', text: done };
}
