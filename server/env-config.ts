import { posEnv } from '@shared/pos-env';

/**
 * Ortam değişkenlerinden okunan ayarlar. Kasanın kendi değişkenleri `ASILPOS_*`; kurulu kasadaki eski adlar da okunur
 * (shared/pos-env.ts). Disk ve Node modülü kullanmaz: tarayıcı demosu da aynısını okur
 * (demo/env.ts); dosya ve klasör ayarları server/env.ts'te.
 */
export function configFrom(vars: Record<string, string | undefined>) {
  return {
    isProd: vars.NODE_ENV === 'production',
    port: Number(posEnv(vars, 'PORT') ?? 4000),
    host: posEnv(vars, 'HOST') ?? '0.0.0.0',
    /** Oturum süresi (saat) */
    sessionHours: Number(posEnv(vars, 'SESSION_HOURS') ?? 14),

    /**
     * laffogato (site + mobil uygulama API'si). Varsayılanı yok: yalnız .env'de açıkça yazılınca dolu, boşken AsilPOS
     * siteye hiçbir istek atmaz (menü, görsel, online sipariş, Tükendi; sahibin 26 Ekim kararı, docs/03-ENTEGRASYON.md §2)
     */
    laffogatoUrl: (vars.LAFFOGATO_URL ?? '').trim().replace(/\/+$/, ''),
    /** Sitenin imzalı uçları: sitedeki imza anahtarının (shared/eski-adlar.ts `SITE_ANAHTAR_ENV`) değeri (en az 32 karakter) */
    laffogatoPanelSecret: (vars.LAFFOGATO_SYNC_SECRET ?? vars.LAFFOGATO_PANEL_SECRET ?? '').trim(),

    /** lafmaliyet (maliyet / arka ofis paneli) */
    lafmaliyetUrl: (vars.LAFMALIYET_URL ?? '').trim().replace(/\/+$/, ''),
    /** lafmaliyet'in imzalı POS uçları: paneldeki ASILPOS_SYNC_SECRET (eski adıyla da) değeri */
    lafmaliyetToken: (vars.LAFMALIYET_SYNC_SECRET ?? '').trim(),

    /** AsilPOS Uzaktan (Vercel): canlı özetin gittiği adres ve imza anahtarı (Vercel'deki ASILPOS_CLOUD_SECRET) */
    cloudUrl: (posEnv(vars, 'CLOUD_URL') ?? '').replace(/\/$/, ''),
    cloudSecret: (posEnv(vars, 'CLOUD_SECRET') ?? '').trim(),
    /**
     * Şubenin kendi Uzaktan anahtarı (isteğe bağlı; Vercel'deki ASILPOS_CLOUD_SECRET_<ŞUBE>). Tanımlıysa Uzaktan'a giden
     * istekler bununla imzalanır, ortak anahtar yalnız bulut onu henüz tanımıyorsa kullanılır (server/lib/kafe-anahtari.ts)
     */
    cloudSubeSecret: (posEnv(vars, 'CLOUD_SUBE_SECRET') ?? '').trim(),
    /**
     * Ortak ve şube anahtarının bir önceki değeri: ayarlar dosyasındaki değer değişince sunucu eskisini
     * `ASILPOS_CLOUD_SECRET_ONCEKI` / `ASILPOS_CLOUD_SUBE_SECRET_ONCEKI` satırına yazar (server/lib/ayar-dosyasi.ts). Yalnız
     * değişimden önce alınmış bulut yedeklerini açmak için (server/lib/kafe-anahtari.ts `yedekCozmeAnahtarlari`); hiçbir
     * istek bununla imzalanmaz
     */
    cloudSecretOnceki: (posEnv(vars, 'CLOUD_SECRET_ONCEKI') ?? '').trim(),
    cloudSubeSecretOnceki: (posEnv(vars, 'CLOUD_SUBE_SECRET_ONCEKI') ?? '').trim(),
    /**
     * Merkez (dükkânlar, lisans, seçerek güncelleme): varsayılan AsilPOS Uzaktan'ın adresi. ASILPOS_MERKEZ_URL=0 kapatır;
     * ikisi de yoksa lisans uygulanmaz ve güncelleme kanalın son sürümünü izler (server/sync/merkez.ts)
     */
    merkezUrl: posEnv(vars, 'MERKEZ_URL')?.trim() === '0' ? '' : (posEnv(vars, 'MERKEZ_URL') ?? posEnv(vars, 'CLOUD_URL') ?? '').trim().replace(/\/+$/, ''),

    /**
     * Yemeksepeti (Delivery Hero POS middleware): siparişler AsilPOS Uzaktan aktarıcısına (Vercel) iter, kasa oradan çeker
     * (ASILPOS_CLOUD_URL ve ASILPOS_CLOUD_SECRET de gerekir); kabul, ret ve aşama kasadan middleware'e
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
     * Getir Yemek (GetirFood API): Getir'in verdiği uygulama anahtarı ve restoran anahtarı; siparişler AsilPOS Uzaktan
     * aktarıcısına (Vercel) iter, kasa oradan çeker (ASILPOS_CLOUD_URL ve ASILPOS_CLOUD_SECRET de gerekir), yedek olarak
     * doğrudan Getir'den okur. Getir'e verilen webhook anahtarı (GETIR_WEBHOOK_SECRET) yalnız Vercel'de durur, kasada
     * gerekmez (server/delivery/getir.ts)
     */
    getir: {
      appSecretKey: (vars.GETIR_APP_SECRET_KEY ?? '').trim(),
      restaurantSecretKey: (vars.GETIR_RESTAURANT_SECRET_KEY ?? '').trim(),
      /** Canlı https://food-external-api-gateway.getirapi.com; test ortamı https://food-external-api-gateway.development.getirapi.com */
      apiUrl: ((vars.GETIR_API_URL ?? '').trim() || 'https://food-external-api-gateway.getirapi.com').replace(/\/+$/, ''),
    },
    /**
     * Trendyol Go Yemek (Uber Eats Türkiye): satıcı panelinden satıcı no, API anahtarı ve gizli anahtar; yalnız kasa
     * bilgisayarının .env'inde. Üçü de yoksa canlı mod seçilemez (server/delivery/trendyol.ts)
     */
    trendyol: {
      supplierId: (vars.TRENDYOL_SUPPLIER_ID ?? '').trim(),
      apiKey: (vars.TRENDYOL_API_KEY ?? '').trim(),
      apiSecret: (vars.TRENDYOL_API_SECRET ?? '').trim(),
      /** Canlı https://api.tgoapis.com; test ortamı https://stageapi.tgoapis.com (IP izni ister) */
      apiUrl: ((vars.TRENDYOL_API_URL ?? '').trim() || 'https://api.tgoapis.com').replace(/\/+$/, ''),
      /** Yazılım bizim: User-Agent "<satıcı no> - SelfIntegration", x-agentname SelfIntegration */
      agentName: (vars.TRENDYOL_AGENT_NAME ?? '').trim() || 'SelfIntegration',
      /** x-executor-user: işlemi yapanın e-postası (satıcı panelindeki kullanıcı) */
      executorEmail: (vars.TRENDYOL_EXECUTOR_EMAIL ?? '').trim(),
    },
  };
}
