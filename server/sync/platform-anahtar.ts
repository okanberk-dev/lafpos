import { CLOUD_KEY_GROUPS, cleanCloudKeys } from '@shared/baglanti';
import { tx } from '../db/client';
import { rebuildCloudAdapters } from '../delivery/registry';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { cloudKeys, saveCloudKeys, setPullState } from '../lib/platform-anahtar';
import { signedFetch } from '../lib/signature';

/**
 * Platform anahtarları buluttan (#75 İş 2): sahip Trendyol ve Yemeksepeti değerlerini bir kez Vercel'deki LafPOS Uzaktan
 * projesine girer; kasa onları `GET /api/uzaktan/anahtarlar` ucundan (LAFPOS_CLOUD_SECRET imzası) açılışta ve 10
 * dakikada bir çeker. Uç yalnız Vercel ortamını okur, Redis'e dokunmaz (Upstash bütçesi). Değer değişince yerel kopyaya
 * yazılır, bağdaştırıcı yeniden kurulur ve denetim kaydına değersiz bir satır düşer. Çekim olmazsa (internet yok, uç
 * kapalı) kasa son değerlerle sürer. Platformun modu değişmez: açmak sahibin kararı.
 */
export const PLATFORM_KEYS_PULL_MS = 10 * 60_000;
export const CLOUD_KEYS_PATH = '/api/uzaktan/anahtarlar';

const same = (a: Record<string, string>, b: Record<string, string>, keys: readonly string[]) => keys.every((k) => (a[k] ?? '') === (b[k] ?? ''));

export async function pullPlatformKeys(now = Date.now()): Promise<{ changed: string[] } | { skipped: string }> {
  if (!env.cloudUrl || env.cloudSecret.length < 32) return { skipped: 'Uzaktan tanımlı değil' };
  let res: { status: number; json: unknown };
  try {
    res = await signedFetch(env.cloudSecret, 'GET', new URL(`${env.cloudUrl}${CLOUD_KEYS_PATH}`));
  } catch {
    // Hata nesnesi günlüğe yazılmaz: adres ya da yanıt parçası taşıyabilir
    setPullState({ triedAt: now, ok: false, error: 'Uzaktan’a ulaşılamadı' });
    return { skipped: 'ulaşılamadı' };
  }
  const body = res.json as { anahtarlar?: unknown } | null;
  if (res.status !== 200 || !body || typeof body.anahtarlar !== 'object') {
    setPullState({ triedAt: now, ok: false, error: res.status === 401 ? 'İmza geçersiz' : `Uzaktan yanıtı ${res.status}` });
    return { skipped: `durum ${res.status}` };
  }
  const next = cleanCloudKeys(body.anahtarlar);
  const prev = cloudKeys().values;
  const changedGroups = CLOUD_KEY_GROUPS.filter((g) => !same(prev, next, g.keys));
  setPullState({ triedAt: now, ok: true, error: null });
  saveCloudKeys({ values: next, at: now });
  if (!changedGroups.length) return { changed: [] };
  rebuildCloudAdapters(changedGroups.map((g) => g.id));
  const fx = new Effects();
  tx((t) => {
    for (const g of changedGroups) {
      const keys = g.keys.filter((k) => (prev[k] ?? '') !== (next[k] ?? ''));
      fx.audit(t, { action: 'ayar.platform-anahtar', entity: 'platform', entityId: g.id, message: `${g.label} anahtarları buluttan güncellendi`, data: { keys } });
    }
  });
  fx.emit({ topic: 'settings', kind: 'ayar.platform-anahtar', message: 'Platform anahtarları buluttan güncellendi' });
  fx.flush();
  return { changed: changedGroups.map((g) => g.id) };
}

/** Açılışta (birkaç saniye sonra) ve 10 dakikada bir; Uzaktan tanımlı değilse hiç istek yok */
export function startPlatformKeys(): ReturnType<typeof setTimeout>[] {
  if (!env.cloudUrl || env.cloudSecret.length < 32) return [];
  const tick = () => void pullPlatformKeys().catch(() => undefined);
  return [setTimeout(tick, 5_000), setInterval(tick, PLATFORM_KEYS_PULL_MS)];
}
