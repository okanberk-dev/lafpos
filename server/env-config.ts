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
    /**
     * Merkez (dükkânlar, lisans, seçerek güncelleme): varsayılan LafPOS Uzaktan'ın adresi. LAFPOS_MERKEZ_URL=0 kapatır;
     * ikisi de yoksa lisans uygulanmaz ve güncelleme kanalın son sürümünü izler (server/sync/merkez.ts)
     */
    merkezUrl: vars.LAFPOS_MERKEZ_URL?.trim() === '0' ? '' : (vars.LAFPOS_MERKEZ_URL ?? vars.LAFPOS_CLOUD_URL ?? '').trim().replace(/\/+$/, ''),

    /**
     * Trendyol Go Yemek (Uber Eats Türkiye): satıcı panelinden satıcı no, API anahtarı ve gizli anahtar; yalnız kasa
     * bilgisayarının .env'inde. Üçü de yoksa canlı mod seçilemez (server/delivery/trendyol.ts)
     */
    /**
     * Yemeksepeti (Delivery Hero POS middleware): siparişler LafPOS Uzaktan aktarıcısına (Vercel) iter, kasa oradan çeker
     * (LAFPOS_CLOUD_URL ve LAFPOS_CLOUD_SECRET de gerekir); kabul, ret ve aşama kasadan middleware'e
     */
    yemeksepeti: {
      /** Delivery Hero'nun verdiği middleware adresi (ör. https://integration-middleware.stg.restaurant-partners.com) */
      mwUrl: (vars.YEMEKSEPETI_MW_URL ?? '').trim().replace(/\/+$/, ''),
      username: (vars.YEMEKSEPETI_USERNAME ?? '').trim(),
      password: (vars.YEMEKSEPETI_PASSWORD ?? '').trim(),
      /** Restoranın Delivery Hero'daki POS kimliği (remoteId); aktarıcı yalnız bunu kabul eder */
      remoteId: (vars.YEMEKSEPETI_REMOTE_ID ?? '').trim(),
    },
    /**
     * Getir Yemek (GetirFood API): Getir'in verdiği uygulama anahtarı ve restoran anahtarı; siparişler LafPOS Uzaktan
     * aktarıcısına (Vercel) iter, kasa oradan çeker (LAFPOS_CLOUD_URL ve LAFPOS_CLOUD_SECRET de gerekir), yedek olarak
     * doğrudan Getir'den okur. Getir'e verilen webhook anahtarı (GETIR_WEBHOOK_SECRET) yalnız Vercel'de durur, kasada
     * gerekmez (server/delivery/getir.ts)
     */
    getir: {
      appSecretKey: (vars.GETIR_APP_SECRET_KEY ?? '').trim(),
      restaurantSecretKey: (vars.GETIR_RESTAURANT_SECRET_KEY ?? '').trim(),
      /** Canlı https://food-external-api-gateway.getirapi.com; test ortamı https://food-external-api-gateway.development.getirapi.com */
      apiUrl: ((vars.GETIR_API_URL ?? '').trim() || 'https://food-external-api-gateway.getirapi.com').replace(/\/+$/, ''),
    },
    trendyol: {
      supplierId: (vars.TRENDYOL_SUPPLIER_ID ?? '').trim(),
      apiKey: (vars.TRENDYOL_API_KEY ?? '').trim(),
      apiSecret: (vars.TRENDYOL_API_SECRET ?? '').trim(),
      apiUrl: ((vars.TRENDYOL_API_URL ?? '').trim() || 'https://api.tgoapps.com').replace(/\/+$/, ''),
      agentName: (vars.TRENDYOL_AGENT_NAME ?? '').trim() || 'LafPOS',
      /** `x-executor-user`: işlemi yapan satıcı paneli kullanıcısının e-postası; boşsa entegratör adı */
      executorEmail: (vars.TRENDYOL_EXECUTOR_EMAIL ?? '').trim(),
    },
  };
}
