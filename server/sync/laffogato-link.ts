import { env } from '../env';
import { conflict } from '../lib/http';
import { getSettings } from '../lib/settings';
import { MIN_SECRET_LENGTH } from '../lib/signature';

/**
 * Site bağlantısının iki kapısı (sahibin 26 Ekim kararı: LafPOS yalnız sahip açınca devreye girer).
 * - `siteLinked`: `LAFFOGATO_URL` .env'de açıkça yazılmış. Değilse siteye hiçbir istek gitmez: menü yoklaması, görsel
 *   indirme, sipariş sürüm sinyali, Tükendi yazımı. Varsayılan adres yoktur (server/env.ts).
 * - `siteSigned`: adres ve en az 32 karakterlik `LAFFOGATO_SYNC_SECRET`; imzalı uçlar (online siparişler, Tükendi
 *   yazımı, panel menüsü) bunu ister.
 */
export const siteLinked = () => env.laffogatoUrl !== '';
export const siteSigned = () => siteLinked() && env.laffogatoPanelSecret.length >= MIN_SECRET_LENGTH;

export const SITE_NOT_LINKED = 'Site bağlantısı kurulmadı';

/** Elle tetiklenen site işlemleri ("Siteyle eşitle", "Yenile") bağlantı yokken bu mesajla 409 döner */
export function requireSiteLinked() {
  if (!siteLinked()) throw conflict(`${SITE_NOT_LINKED}: kasa bilgisayarının ayarlarında LAFFOGATO_URL yok`, 'not_configured');
}

export function requireSiteSigned() {
  requireSiteLinked();
  if (!siteSigned()) throw conflict('Site bağlantı anahtarı tanımlı değil (LAFFOGATO_SYNC_SECRET)', 'not_configured');
}

/**
 * LafPOS'un yerel, telefonla damga kartı. Varsayılan kapalı (`stampCategoryKeys: []`): tek sadakat programı
 * uygulamadaki damgadır (laffogato `src/lib/legal/content.ts` tek program tanımlar). Site bağlantısı kuruluyken hiç
 * açılmaz: damga birikmez, hediye kullanılmaz, ekranda görünmez.
 */
export const localStampsOn = () => getSettings().stampCategoryKeys.length > 0 && !siteLinked();
