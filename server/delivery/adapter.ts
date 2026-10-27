import type { PlatformCourier, PlatformId, PlatformOrderPayload } from '@shared/platforms';

/** Kasadan platforma bildirilen teslim aşamaları (POST /orders/:id/delivery) */
export type PlatformNotify = 'hazir' | 'yolda' | 'teslim';

/**
 * Gerçek platform bağlantısı: siparişi tek biçime çevirir (`PlatformOrderPayload`) ve kabul / ret / aşama çağrılarını
 * yapar. Akış, ödeme ve kilit `service.ts`'te; bağdaştırıcı yalnız platformla konuşur. Yoklama yapanlar (Trendyol Go)
 * `poll` ile yeni siparişleri ve platformun iptallerini getirir; siparişi iten platformlar (Yemeksepeti, Getir) için
 * `poll` LafPOS Uzaktan aktarıcısından çeker (sonraki iş).
 */
export interface PlatformAdapter {
  platform: PlatformId;
  label: string;
  /** Anahtarlar .env'de mi (yoksa canlı mod seçilemez) */
  configured(): boolean;
  /** Son başarılı yoklamadan beri yeni (onay bekleyen) siparişler ve platformun iptal ettiği paketlerin kimlikleri */
  poll(sinceMs: number, now: number): Promise<{ orders: PlatformOrderPayload[]; cancelled: string[] }>;
  /** Kabul, hazırlık süresiyle; platform reddederse fırlatır (yerelde kabul edilmez) */
  accept(order: PlatformOrderPayload, prepMinutes: number): Promise<void>;
  /** Ret (kasadaki neden metniyle; bağdaştırıcı platformun koduna çevirir) */
  reject(order: PlatformOrderPayload, reason: string): Promise<void>;
  /** Teslim aşaması; platformda karşılığı yoksa (platform kuryesi kendi yazar) false döner, istek gitmez */
  notify(order: PlatformOrderPayload, status: PlatformNotify, courier: PlatformCourier): Promise<boolean>;
}
