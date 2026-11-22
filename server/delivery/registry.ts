import type { PlatformId } from '@shared/platforms';
import { env } from '../env';
import { configFrom } from '../env-config';
import { platformVars } from '../lib/platform-anahtar';
import type { PlatformAdapter } from './adapter';
import { getirAdapter } from './getir';
import { trendyolAdapter } from './trendyol';
import { yemeksepetiAdapter } from './yemeksepeti';

/**
 * Gerçek bağdaştırıcılar: anahtarları `.env`'den (server/env-config.ts) okur; Trendyol ve Yemeksepeti'nin anahtarları
 * buluttan da gelebilir (server/lib/platform-anahtar.ts, bulutta dolu olan ezer). Anahtarı olmayan platformun canlı
 * modu seçilemez; tarayıcı demosunda ortam boştur, hiçbiri yapılandırılmış değildir. Yemeksepeti ve Getir siparişi
 * iter: LafPOS Uzaktan aktarır, kasa oradan çeker (Getir'de yedek olarak doğrudan Getir'den de). Migros Yemek'in
 * belgesi yok (docs/PAKET-PLATFORMLARI.md).
 */
const adapters: Partial<Record<PlatformId, PlatformAdapter>> = {
  getir: getirAdapter({ ...env.getir, cloudUrl: env.cloudUrl, cloudSecret: env.cloudSecret }),
};

/**
 * Buluttan anahtarı gelen bağdaştırıcıları yeniden kurar (açılışta ve anahtar değişince). Platformun modu (Kapalı,
 * Deneme, Canlı) ayarda durur, değişmez: bağdaştırıcı yalnız yeni anahtarla kurulur
 */
export function rebuildCloudAdapters(platforms: readonly ('trendyol' | 'yemeksepeti')[] = ['trendyol', 'yemeksepeti']) {
  const c = configFrom(platformVars());
  if (platforms.includes('trendyol')) adapters.trendyol = trendyolAdapter(c.trendyol);
  if (platforms.includes('yemeksepeti')) adapters.yemeksepeti = yemeksepetiAdapter({ ...c.yemeksepeti, cloudUrl: env.cloudUrl, cloudSecret: env.cloudSecret });
}
rebuildCloudAdapters();

export function adapterFor(platform: PlatformId): PlatformAdapter | null {
  return adapters[platform] ?? null;
}

/** Testler sahte sunucuya bağlı bir bağdaştırıcı takar */
export function setAdapter(platform: PlatformId, adapter: PlatformAdapter | null) {
  if (adapter) adapters[platform] = adapter;
  else delete adapters[platform];
}
