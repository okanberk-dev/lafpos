/**
 * Ortam değişkenlerinden okunan ayarlar. Disk ve Node modülü kullanmaz: tarayıcı demosu da aynısını okur
 * (demo/env.ts); dosya ve klasör ayarları server/env.ts'te.
 */
export function configFrom(vars: Record<string, string | undefined>) {
  return {
    isProd: vars.NODE_ENV === 'production',
    port: Number(vars.LAFPOS_PORT ?? 4000),
    host: vars.LAFPOS_HOST ?? '0.0.0.0',
    /** Oturum süresi (saat) */
    sessionHours: Number(vars.LAFPOS_SESSION_HOURS ?? 14),

    /**
     * laffogato (site + mobil uygulama API'si). Varsayılanı yok: yalnız .env'de açıkça yazılınca dolu, boşken LafPOS
     * siteye hiçbir istek atmaz (menü, görsel, online sipariş, Tükendi; sahibin 26 Ekim kararı, docs/03-ENTEGRASYON.md §2)
     */
    laffogatoUrl: (vars.LAFFOGATO_URL ?? '').trim().replace(/\/+$/, ''),
    /** Sitenin imzalı uçları: sitedeki LAFPOS_SYNC_SECRET değeri (en az 32 karakter) */
    laffogatoPanelSecret: (vars.LAFFOGATO_SYNC_SECRET ?? vars.LAFFOGATO_PANEL_SECRET ?? '').trim(),

    /** lafmaliyet (maliyet / arka ofis paneli) */
    lafmaliyetUrl: (vars.LAFMALIYET_URL ?? '').replace(/\/$/, ''),
    /** lafmaliyet'in imzalı POS uçları: paneldeki LAFPOS_SYNC_SECRET değeri */
    lafmaliyetToken: (vars.LAFMALIYET_SYNC_SECRET ?? '').trim(),

    /** LafPOS Uzaktan (Vercel): canlı özetin gittiği adres ve imza anahtarı (Vercel'deki LAFPOS_CLOUD_SECRET) */
    cloudUrl: (vars.LAFPOS_CLOUD_URL ?? '').replace(/\/$/, ''),
    cloudSecret: (vars.LAFPOS_CLOUD_SECRET ?? '').trim(),
  };
}
