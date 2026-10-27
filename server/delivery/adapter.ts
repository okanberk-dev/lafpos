import type { PlatformCourier, PlatformId, PlatformOrderPayload } from '@shared/platforms';

/** Kasadan platforma bildirilen teslim aşamaları (POST /orders/:id/delivery) */
export type PlatformNotify = 'hazir' | 'yolda' | 'teslim';

/**
 * Gerçek platform bağlantısı: siparişi tek biçime çevirir (`PlatformOrderPayload`) ve kabul / ret / aşama çağrılarını
 * yapar. Akış, ödeme ve kilit `service.ts`'te; bağdaştırıcı yalnız platformla konuşur. Yoklama yapanlar (Trendyol Go)
 * `poll` ile yeni siparişleri ve platformun iptallerini getirir; siparişi iten platformlarda (Yemeksepeti) `poll` LafPOS
 * Uzaktan aktarıcısının gelen kutusundan çeker, `commit` kayıtlar kasada yazılınca gelen kutusunu temizler.
 */
export interface PollResult {
  orders: PlatformOrderPayload[];
  cancelled: string[];
  invalid?: { externalId: string; error: string }[];
  /**
   * Kayıtlar yerelde işlendikten sonra çağrılır (siparişi iten platformlarda aktarıcının gelen kutusu burada silinir):
   * kasa düşerse kayıt silinmemiş olur, sonraki çekimde yeniden gelir ve tekilleştirilir
   */
  commit?: () => Promise<void>;
}

export interface PlatformAdapter {
  platform: PlatformId;
  label: string;
  /** Anahtarlar .env'de mi (yoksa canlı mod seçilemez) */
  configured(): boolean;
  /**
   * Son başarılı yoklamadan beri yeni (onay bekleyen) siparişler ve platformun iptal ettiği paketlerin kimlikleri.
   * Çevrilemeyen paket (`invalid`) ötekileri durdurmaz: atlanır, kimliğiyle denetim kaydına düşer.
   */
  poll(sinceMs: number, now: number): Promise<PollResult>;
  /** Kabul, hazırlık süresiyle; platform reddederse fırlatır (yerelde kabul edilmez) */
  accept(order: PlatformOrderPayload, prepMinutes: number): Promise<void>;
  /** Ret (kasadaki neden metniyle; bağdaştırıcı platformun koduna çevirir) */
  reject(order: PlatformOrderPayload, reason: string): Promise<void>;
  /** Teslim aşaması; platformda karşılığı yoksa (platform kuryesi kendi yazar) false döner, istek gitmez */
  notify(order: PlatformOrderPayload, status: PlatformNotify, courier: PlatformCourier): Promise<boolean>;
}

/**
 * Platformun yanıtı ya da ağ hatası (`status` 0: bağlantı kurulamadı, yanıt gelmedi). Mesaj Türkçe ve kasada
 * gösterilir. Platformun kalıcı reddi (`permanent`: istek düzeltilmeden kabul edilmez) yeniden denenmez.
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

/** fetch'in ağ hatasını (İngilizce, "fetch failed" / zaman aşımı) kasada okunur metne çevirir */
export function networkError(e: unknown, timeoutMs: number): PlatformHttpError {
  if (e instanceof PlatformHttpError) return e;
  const aborted = e instanceof Error && (e.name === 'AbortError' || e.name === 'TimeoutError');
  return new PlatformHttpError(0, aborted ? `yanıt gelmedi (${Math.round(timeoutMs / 1000)} sn)` : 'bağlantı kurulamadı');
}
