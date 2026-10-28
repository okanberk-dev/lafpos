import type { PlatformCourier, PlatformId, PlatformOrderPayload } from '@shared/platforms';

/** Kasadan platforma bildirilen teslim aşamaları (POST /orders/:id/delivery) */
export type PlatformNotify = 'hazir' | 'yolda' | 'teslim';

/**
 * Gerçek platform bağlantısı: siparişi tek biçime çevirir (`PlatformOrderPayload`) ve kabul / ret / aşama çağrılarını
 * yapar. Akış, ödeme ve kilit `service.ts`'te; bağdaştırıcı yalnız platformla konuşur. Yoklama yapanlar (Trendyol Go)
 * `poll` ile yeni siparişleri ve platformun iptallerini getirir; siparişi iten platformlar (Yemeksepeti, Getir) için
 * `poll` LafPOS Uzaktan aktarıcısından çeker.
 */
export interface PollResult {
  orders: PlatformOrderPayload[];
  cancelled: string[];
  invalid?: { externalId: string; error: string }[];
  /** Yoklama başarılı ama eksik bir yol var (ör. aktarıcı düştü, siparişler yedek yoldan geldi): Yönetim'de görünür, bekleme uygulanmaz */
  warning?: string;
  /**
   * Yoklama hata vermedi (iptaller işlenir) ama yeni siparişler kasaya alınamıyor (Getir: giriş olmadı, restoran
   * kimliği bilinmiyor; kayıtlar gelen kutusunda bekliyor). Kasa ilk turda denetim kaydına uyarı, sürerse alarm yazar
   */
  blocked?: string;
  /**
   * Platformda kasanın dışında (platformun panelinden) kabul edilmiş siparişlerin kimlikleri: kasada onay bekleyen ya
   * da süresi dolmuş kayıt "platformda kabul edildi" olur (süre işlemez, Kabul yalnız adisyonu açar)
   */
  confirmed?: string[];
  /**
   * Kasada kabul edilmiş ama platformun yeniden onay beklediği siparişler (Getir: ileri tarihli sipariş etkinleşince):
   * kasa bağdaştırıcının `reconfirm`'ünü çağırır
   */
  reconfirm?: string[];
  /**
   * Kayıtlar yerelde işlendikten sonra çağrılır (siparişi iten platformlarda aktarıcının gelen kutusu burada silinir):
   * kasa düşerse kayıt silinmemiş olur, sonraki çekimde yeniden gelir ve tekilleştirilir. `keep`: gelen kutusunda
   * kalacak sipariş kimlikleri (externalId): kayda alınmayanlar (platform Kapalı'yken), kaydı düşenler, iptali o an
   * uygulanamayanlar (karar sürüyordu)
   */
  commit?: (keep: ReadonlySet<string>) => Promise<void>;
}

export interface PlatformAdapter {
  platform: PlatformId;
  label: string;
  /** Anahtarlar .env'de mi (yoksa canlı mod seçilemez) */
  configured(): boolean;
  /**
   * Platform kuryesine verilince de bildirilir ("yolda" → Getir `handover`); yoksa platform kuryesinde yalnız "hazır"
   * gider, alma ve teslimi platform kendi yazar
   */
  handover?: boolean;
  /**
   * Son başarılı yoklamadan beri yeni (onay bekleyen) siparişler ve platformun iptal ettiği paketlerin kimlikleri.
   * Çevrilemeyen paket (`invalid`) ötekileri durdurmaz: atlanır, kimliğiyle denetim kaydına düşer.
   */
  poll(sinceMs: number, now: number): Promise<PollResult>;
  /** Kabul, hazırlık süresiyle; platform reddederse fırlatır (yerelde kabul edilmez) */
  accept(order: PlatformOrderPayload, prepMinutes: number): Promise<void>;
  /**
   * Ret (kasadaki neden metniyle; bağdaştırıcı platformun koduna çevirir). `afterAccept`: kabul edilmiş sipariş kasada
   * iptal edildi; platform bunu kabul etmiyorsa bağdaştırıcı kalıcı hata (PlatformHttpError 4xx) fırlatır
   */
  reject(order: PlatformOrderPayload, reason: string, opts?: { afterAccept?: boolean }): Promise<void>;
  /**
   * Kasada kabul edilmiş siparişin platforma yeniden onayı (`PollResult.reconfirm`); platform reddederse fırlatır.
   * 'already': platform siparişi zaten onaylı buldu (onay önceden gitmişti; kasa yeniden denetim kaydı yazmaz)
   */
  reconfirm?(order: PlatformOrderPayload): Promise<void | 'already'>;
  /** Teslim aşaması; platformda karşılığı yoksa (platform kuryesi kendi yazar) false döner, istek gitmez */
  notify(order: PlatformOrderPayload, status: PlatformNotify, courier: PlatformCourier): Promise<boolean>;
}

/**
 * Platformun yanıtı ya da ağ hatası (`status` 0: bağlantı kurulamadı, yanıt gelmedi). Mesaj Türkçe ve kasada
 * gösterilir. Platformun kalıcı reddi (`permanent`: istek düzeltilmeden kabul edilmez) yeniden denenmez. `status` 425
 * "henüz erken": platform aşamalar arasında bekleme ister (Getir 1 dk); hata sayılmaz, sonraki turda sessizce sürer.
 */
export class PlatformHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
  get permanent(): boolean {
    return [400, 404, 409, 410, 422].includes(this.status);
  }
}

/**
 * fetch'in hatasını (İngilizce) kasada okunur metne çevirir: zaman aşımı "yanıt gelmedi", ağ ("fetch failed")
 * "bağlantı kurulamadı". İstek hiç çıkmadıysa (geçersiz adres ya da başlık: ayar hatası) ağ sorunu gibi gösterilmez.
 */
export function networkError(e: unknown, timeoutMs: number): PlatformHttpError {
  if (e instanceof PlatformHttpError) return e;
  const err = e instanceof Error ? e : new Error(String(e));
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return new PlatformHttpError(0, `yanıt gelmedi (${Math.round(timeoutMs / 1000)} sn)`);
  // Node fetch'i ağ hatasını hep "fetch failed" ile verir (nedeni ECONNREFUSED, ENOTFOUND…); geçersiz adres ayrı
  if (err.message === 'fetch failed') return new PlatformHttpError(0, 'bağlantı kurulamadı');
  return new PlatformHttpError(0, `istek gönderilemedi, ayarı denetleyin (${err.message})`);
}
