import { CLOUD_KEY_GROUPS, cleanCloudKeys, subeEtiketi } from '@shared/baglanti';
import { tx } from '../db/client';
import { rebuildCloudAdapters } from '../delivery/registry';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { cloudKeys, saveCloudKeys, setPullState } from '../lib/platform-anahtar';
import { kasaSubesi } from '../lib/sube';
import { signedFetch } from '../lib/signature';

/**
 * Platform anahtarları buluttan (#75 İş 2): sahip Trendyol ve Yemeksepeti değerlerini bir kez Vercel'deki AsilPOS Uzaktan
 * projesine girer; kasa onları `GET /api/uzaktan/anahtarlar` ucundan (ASILPOS_CLOUD_SECRET imzası) açılışta ve 10
 * dakikada bir çeker. Uç yalnız Vercel ortamını okur, Redis'e dokunmaz (Upstash bütçesi). Değer değişince yerel kopyaya
 * yazılır, bağdaştırıcı yeniden kurulur ve denetim kaydına değersiz bir satır düşer. Çekim olmazsa (internet yok, uç
 * kapalı) kasa son değerlerle sürer. Platformun modu değişmez: açmak sahibin kararı.
 * Şubeye göre: kasa kendi şubesini (ayarlardaki branchId) imzalı sorguda gönderir; uç yalnız o şubenin
 * `<PLATFORM>_<ŞUBE>_<ALAN>` değerlerini verir (Marina kasası Tuzla'nın Trendyol anahtarını hiç almaz).
 */
export const PLATFORM_KEYS_PULL_MS = 10 * 60_000;
export const CLOUD_KEYS_PATH = '/api/uzaktan/anahtarlar';

const same = (a: Record<string, string>, b: Record<string, string>, keys: readonly string[]) => keys.every((k) => (a[k] ?? '') === (b[k] ?? ''));

/**
 * Bir çekim: kasanın şimdiki şubesi için. Yanıt o şubenin etiketiyle saklanır (şube sonradan değişirse kullanılmaz).
 * `changed`: bu şubede geçerli değeri değişen platformlar. Saklanan değerler başka şubeninse (şube kimliği değişti)
 * iki bağdaştırıcı da yeniden kurulur: eski şubenin anahtarı bağdaştırıcıda kalmaz
 */
export async function pullPlatformKeys(now = Date.now()): Promise<{ changed: string[] } | { skipped: string }> {
  if (!env.cloudUrl || env.cloudSecret.length < 32) return { skipped: 'Uzaktan tanımlı değil' };
  // Anahtarlar şubenindir: şube seçilmemiş yeni kasa sormaz (hata sayılmaz, Bağlantı bilgileri şubenin seçilmediğini söyler)
  const branchId = kasaSubesi();
  if (!branchId) return { skipped: 'Şube seçilmedi' };
  const sube = subeEtiketi(branchId);
  let res: { status: number; json: unknown };
  try {
    const url = new URL(`${env.cloudUrl}${CLOUD_KEYS_PATH}`);
    url.searchParams.set('sube', branchId);
    res = await signedFetch(env.cloudSecret, 'GET', url);
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
  // Önceki: bu şubede geçerli olan (`activeCloudKeys` kuralı); başka şubeninki ya da eski şubesiz dosya hiç geçerli değildi
  const stored = cloudKeys();
  const otherBranch = stored.sube !== sube;
  const prev = sube && !otherBranch ? stored.values : {};
  const changedGroups = CLOUD_KEY_GROUPS.filter((g) => !same(prev, next, g.keys));
  setPullState({ triedAt: now, ok: true, error: null });
  saveCloudKeys({ values: next, at: now, sube });
  if (otherBranch) rebuildCloudAdapters();
  if (!changedGroups.length) return { changed: [] };
  if (!otherBranch) rebuildCloudAdapters(changedGroups.map((g) => g.id));
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

/**
 * Şube kimliği değişince (Yönetim › Ayarlar ve yedek, yalnız patron; ladmin kurulumu şubeyi verince de): eski şubenin anahtarları hemen bırakılır
 * (bağdaştırıcılar yerel ayarlar ve yalnız yeni şube için çekilmiş değerlerle yeniden kurulur) ve yeni şubeninkiler
 * beklemeden çekilir. Uzaktan tanımlı değilse istek yok. Hata kasayı durdurmaz: çekim olmazsa 10 dakikalık çekim yeniden dener
 */
export function platformKeysBranchChanged(): Promise<void> {
  try {
    rebuildCloudAdapters();
  } catch {
    // Bağdaştırıcı kurulamasa da ayar kaydı sürer; bir sonraki başarılı çekim yeniden kurar
  }
  return pullPlatformKeys().then(
    () => undefined,
    () => undefined,
  );
}

/** Açılışta (birkaç saniye sonra) ve 10 dakikada bir; Uzaktan tanımlı değilse hiç istek yok */
export function startPlatformKeys(): ReturnType<typeof setTimeout>[] {
  // Veritabanı hazır olunca bir kez kurulur: modül yüklenirken şube ayarı henüz okunamamış olabilir (ilk kurulum)
  rebuildCloudAdapters();
  if (!env.cloudUrl || env.cloudSecret.length < 32) return [];
  const tick = () => void pullPlatformKeys().catch(() => undefined);
  return [setTimeout(tick, 5_000), setInterval(tick, PLATFORM_KEYS_PULL_MS)];
}
