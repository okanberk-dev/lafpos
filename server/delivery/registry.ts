import type { PlatformId } from '@shared/platforms';
import { env } from '../env';
import type { PlatformAdapter } from './adapter';
import { getirAdapter } from './getir';
import { trendyolAdapter } from './trendyol';
import { yemeksepetiAdapter } from './yemeksepeti';

/**
 * Gerçek bağdaştırıcılar: anahtarları `.env`'den (server/env-config.ts) okur. Anahtarı olmayan platformun canlı
 * modu seçilemez; tarayıcı demosunda ortam boştur, hiçbiri yapılandırılmış değildir. Yemeksepeti ve Getir siparişi
 * iter: LafPOS Uzaktan aktarır, kasa oradan çeker (Getir'de yedek olarak doğrudan Getir'den de). Migros Yemek'in
 * belgesi yok (docs/PAKET-PLATFORMLARI.md).
 */
const adapters: Partial<Record<PlatformId, PlatformAdapter>> = {
  trendyol: trendyolAdapter(env.trendyol),
  yemeksepeti: yemeksepetiAdapter({ ...env.yemeksepeti, cloudUrl: env.cloudUrl, cloudSecret: env.cloudSecret }),
  getir: getirAdapter({ ...env.getir, cloudUrl: env.cloudUrl, cloudSecret: env.cloudSecret }),
};

export function adapterFor(platform: PlatformId): PlatformAdapter | null {
  return adapters[platform] ?? null;
}

/** Testler sahte sunucuya bağlı bir bağdaştırıcı takar */
export function setAdapter(platform: PlatformId, adapter: PlatformAdapter | null) {
  if (adapter) adapters[platform] = adapter;
  else delete adapters[platform];
}
