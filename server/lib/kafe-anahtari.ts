import { SUBE_BASLIGI, subeAnahtarAdi, subeEtiketi } from '@shared/baglanti';
import { env } from '../env';
import { getSettings } from './settings';
import { MIN_SECRET_LENGTH, signedFetch } from './signature';

/**
 * Şube anahtarı (docs/07-UZAKTAN-ERISIM.md §6). AsilPOS Uzaktan'ın kafe anahtarı (`ASILPOS_CLOUD_SECRET`) bütün
 * şubelerde ortaktır; sahip bir şubeye kendi anahtarını verebilir: Vercel'de `ASILPOS_CLOUD_SECRET_<ŞUBE>`, kasada
 * Yönetim › Bağlantı bilgileri › AsilPOS Uzaktan › Şube anahtarı (`ASILPOS_CLOUD_SUBE_SECRET`). Şube anahtarı olan
 * kasa Uzaktan'a giden her isteği onunla imzalar ve şubesini `x-laf-sube` başlığıyla söyler; bulut o şubenin
 * platform anahtarlarını, restoranının gelen kutusunu ve dükkânını (özet, rapor, yedek) yalnız bu imzayla açar.
 *
 * Geçiş sırası önemsiz: bulut şube anahtarını henüz tanımıyorsa (Vercel'e girilmedi) imza 401 alır, kasa aynı isteği
 * ortak anahtarla yineler ve 10 dakika ortak anahtarla sürer; sonra şube anahtarını yeniden dener. Şube anahtarı boşsa
 * her şey eskisi gibi ortak anahtarla gider. Ortak anahtar ladmin'in dağıttığı satırdır; şube anahtarı ayrı satırda
 * durur, dağıtım ona dokunmaz.
 */

/** Bulut şube anahtarını reddedince ortak anahtarla geçen süre */
export const GERI_DONUS_MS = 10 * 60_000;

interface Gecmis {
  /** Bulutun şube anahtarını son reddettiği an ve o anahtar (değişince ret unutulur) */
  red: { at: number; key: string } | null;
  /** Şube anahtarıyla imzalı isteğin son kabul edildiği an */
  kabul: number | null;
}
let gecmis: Gecmis = { red: null, kabul: null };

/** Testler için: geçmişi siler */
export function kafeAnahtariSifirla() {
  gecmis = { red: null, kabul: null };
}

/**
 * Kasanın şube anahtarı kullanılabilir mi: tanımlı, en az 32 karakter, ortak anahtardan farklı ve kasanın şubesi belli
 * (Vercel adındaki ŞUBE). Değilse null; neden `subeAnahtariGorunumu`'nde
 */
export function subeAnahtari(): { key: string; sube: string } | null {
  const key = env.cloudSubeSecret;
  const sube = subeEtiketi(getSettings().branchId);
  if (key.length < MIN_SECRET_LENGTH || key === env.cloudSecret || !sube) return null;
  return { key, sube };
}

/**
 * Şu an geçerli kafe anahtarı: şube anahtarı (bulut son 10 dakikada onu reddetmediyse) ve şubesi, değilse ortak anahtar
 * (`sube` null). Uzaktan yönetimin komut imzası ve açık anahtar imzası da bununla (server/sync/kontrol.ts)
 */
export function kafeAnahtari(now = Date.now()): { key: string; sube: string | null } {
  const s = subeAnahtari();
  const red = gecmis.red;
  if (s && !(red && red.key === s.key && now - red.at < GERI_DONUS_MS)) return s;
  return { key: env.cloudSecret, sube: null };
}

/** Bulut yedeğini şifreleyen anahtar: şube anahtarı varsa o (başka şubenin kasası çözemez), yoksa ortak anahtar */
export const yedekAnahtari = () => subeAnahtari()?.key ?? env.cloudSecret;
/** Yedeği çözmeyi denenecek anahtarlar: önce şube anahtarı, sonra ortak (şube anahtarından önce alınmış yedekler) */
export const yedekCozmeAnahtarlari = () => [...new Set([subeAnahtari()?.key, env.cloudSecret].filter((k): k is string => !!k && k.length >= MIN_SECRET_LENGTH))];

const imzaReddi = (status: number, json: unknown) => status === 401 && !!json && typeof json === 'object' && (json as { code?: unknown }).code === 'bad_signature';

/**
 * AsilPOS Uzaktan'a imzalı istek (`signedFetch` ile aynı imza): şube anahtarı geçerliyse onunla ve şube başlığıyla; bulut
 * imzayı reddederse (401 `bad_signature`: Vercel'de bu şubenin anahtarı yok ya da farklı) aynı istek ortak anahtarla ve
 * başlıksız yinelenir. `ortak`: ortak anahtar (paket aktarıcılarında yapılandırmadan, öbür yerlerde ayarlardan)
 */
export async function kafeFetch(
  ortak: string,
  method: 'GET' | 'POST' | 'PUT',
  url: URL,
  body?: unknown,
  timeoutMs?: number,
  extraHeaders: Record<string, string> = {},
): ReturnType<typeof signedFetch> {
  const k = kafeAnahtari();
  if (k.sube) {
    const res = await signedFetch(k.key, method, url, body, timeoutMs, { ...extraHeaders, [SUBE_BASLIGI]: k.sube });
    if (!imzaReddi(res.status, res.json)) {
      if (res.status < 400) gecmis.kabul = Date.now();
      return res;
    }
    gecmis.red = { at: Date.now(), key: k.key };
    console.warn(`[uzaktan] şube anahtarı reddedildi (Vercel'de ${subeAnahtarAdi(k.sube)} yok ya da farklı); ${GERI_DONUS_MS / 60_000} dakika ortak anahtarla`);
  }
  return signedFetch(ortak, method, url, body, timeoutMs, extraHeaders);
}

/**
 * Yönetim › Bağlantı bilgileri'nde şube anahtarının durumu: `yok` (boş), `subesiz` (kasanın şubesi belli değil),
 * `kisa`, `ortakla-ayni`, `bulutta-yok` (bulut son 10 dakikada reddetti; ortak anahtar kullanılıyor), `kullaniliyor`
 * (bulut kabul etti) ya da `denenmedi` (henüz istek gitmedi). `ad`: Vercel'deki adı (değer değil)
 */
export function subeAnahtariGorunumu(now = Date.now()): { durum: 'yok' | 'subesiz' | 'kisa' | 'ortakla-ayni' | 'bulutta-yok' | 'kullaniliyor' | 'denenmedi'; ad: string | null } {
  const key = env.cloudSubeSecret;
  const sube = subeEtiketi(getSettings().branchId);
  const ad = sube ? subeAnahtarAdi(sube) : null;
  if (!key) return { durum: 'yok', ad };
  if (!sube) return { durum: 'subesiz', ad };
  if (key.length < MIN_SECRET_LENGTH) return { durum: 'kisa', ad };
  if (key === env.cloudSecret) return { durum: 'ortakla-ayni', ad };
  const red = gecmis.red;
  if (red && red.key === key && now - red.at < GERI_DONUS_MS) return { durum: 'bulutta-yok', ad };
  return { durum: gecmis.kabul != null ? 'kullaniliyor' : 'denenmedi', ad };
}
