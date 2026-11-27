import { env } from '../env';
import { conflict } from '../lib/http';
import { getSettings } from '../lib/settings';
import { MIN_SECRET_LENGTH } from '../lib/signature';

/**
 * Site bağlantısının iki kapısı (sahibin 26 Ekim kararı: AsilPOS yalnız sahip açınca devreye girer).
 * - `siteLinked`: `LAFFOGATO_URL` .env'de açıkça yazılmış. Değilse siteye hiçbir istek gitmez: menü yoklaması, görsel
 *   indirme, sipariş sürüm sinyali, Tükendi yazımı. Varsayılan adres yoktur (server/env.ts).
 * - `siteSigned`: adres ve en az 32 karakterlik `LAFFOGATO_SYNC_SECRET`; imzalı uçlar (online siparişler, Tükendi
 *   yazımı, panel menüsü) bunu ister.
 */
export const siteLinked = () => env.laffogatoUrl !== '';
export const siteSigned = () => siteLinked() && env.laffogatoPanelSecret.length >= MIN_SECRET_LENGTH;

export const SITE_NOT_LINKED = 'Site bağlantısı kurulmadı';

/**
 * İmzalı isteklerin şubesi: bu kasanın şubesi (Yönetim › Ayarlar ve yedek › Şube kimliği, varsayılan `marina`). Site şubelidir
 * (laffogato #279): GET'te `?branch=`, POST / PUT gövdesinde `branch`; sipariş, çağrı, Satışta ve masa kodları o
 * şubenindir. docs/03-ENTEGRASYON.md §2.3 "Şube"
 */
export const siteBranch = () => getSettings().branchId;

/**
 * Yanıtın `branch` alanı bu kasanın şubesi değilse onu döner (liste okunmaz). Alanı göndermeyen eski site ya da
 * okunamayan değer null: bugünkü davranış
 */
export function wrongSiteBranch(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null;
  return raw === siteBranch() ? null : raw.slice(0, 24);
}

/**
 * İmzalı listelerin (`GET /api/panel/orders`, `GET /api/panel/menu`) AsilPOS'un okuduğu biçim sürümü (laffogato
 * `PANEL_ORDERS_VERSION`, `PANEL_MENU_VERSION`). Alanı hiç göndermeyen eski site tanınır; başka her değer (2, "1",
 * null) AsilPOS'un bilmediği biçimdir, liste okunmaz. docs/03-ENTEGRASYON.md §2.3
 */
export const SITE_LIST_VERSION = 1;

/** Gövdenin sürümü tanınmıyorsa onu, tanınıyorsa (ya da alan yoksa) null döner */
export function unknownSiteListVersion(body: { version?: unknown }): string | null {
  if (body.version === undefined || body.version === SITE_LIST_VERSION) return null;
  // Sayı olduğu gibi, gerisi JSON'uyla: metin "1" ile sayı 1 hata mesajında ayırt edilsin
  return (typeof body.version === 'number' ? String(body.version) : (JSON.stringify(body.version) ?? String(body.version))).slice(0, 40);
}

/** Elle tetiklenen site işlemleri ("Siteyle eşitle", "Yenile") bağlantı yokken bu mesajla 409 döner */
export function requireSiteLinked() {
  if (!siteLinked()) throw conflict(`${SITE_NOT_LINKED}: kasa bilgisayarının ayarlarında LAFFOGATO_URL yok`, 'not_configured');
}

export function requireSiteSigned() {
  requireSiteLinked();
  if (!siteSigned()) throw conflict('Site bağlantı anahtarı tanımlı değil (LAFFOGATO_SYNC_SECRET)', 'not_configured');
}

/**
 * AsilPOS'un yerel, telefonla damga kartı. Varsayılan kapalı (`stampCategoryKeys: []`): tek sadakat programı
 * uygulamadaki damgadır (laffogato `src/lib/legal/content.ts` tek program tanımlar). Site bağlantısı kuruluyken hiç
 * açılmaz: damga birikmez, hediye kullanılmaz, ekranda görünmez.
 */
export const localStampsOn = () => getSettings().stampCategoryKeys.length > 0 && !siteLinked();
