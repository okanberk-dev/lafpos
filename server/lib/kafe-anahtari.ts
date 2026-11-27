import { createHash } from 'node:crypto';
import { SUBE_BASLIGI, subeAnahtarAdi, subeEtiketi } from '@shared/baglanti';
import { env } from '../env';
import { getSettings, getSyncState, setSyncState } from './settings';
import { MIN_SECRET_LENGTH, signedFetch } from './signature';

/**
 * Şube anahtarı (docs/07-UZAKTAN-ERISIM.md §6). AsilPOS Uzaktan'ın kafe anahtarı (`ASILPOS_CLOUD_SECRET`) bütün
 * şubelerde ortaktır; sahip bir şubeye kendi anahtarını verebilir: Vercel'de `ASILPOS_CLOUD_SECRET_<ŞUBE>`, kasada
 * Yönetim › Bağlantı bilgileri › AsilPOS Uzaktan › Şube anahtarı (`ASILPOS_CLOUD_SUBE_SECRET`). Şube anahtarı olan
 * kasa Uzaktan'a giden her isteği onunla imzalar ve şubesini `x-laf-sube` başlığıyla söyler; bulut o şubenin
 * platform anahtarlarını, restoranının gelen kutusunu ve dükkânını (özet, rapor, yedek) yalnız bu imzayla açar.
 *
 * Geçiş sırası: önce bütün kasalar bu sürüme, sonra kasaya şube anahtarı, en son Vercel (docs/07-UZAKTAN-ERISIM.md §6).
 * Bulut şube anahtarını henüz tanımıyorsa (Vercel'e girilmedi) imza 401 alır, kasa aynı isteği ortak anahtarla yineler
 * ve 10 dakika ortak anahtarla sürer; sonra şube anahtarını yeniden dener. Uzaktan yönetim (komut ve açık anahtar
 * imzası) bu denemeye katılmaz: bulut şube anahtarını kabul edene dek ortak anahtarla sürer (`kontrolAnahtari`), yoksa
 * deneme anlarında bulutla kasa ayrı anahtar kullanırdı. Şube anahtarı boşsa her şey eskisi gibi ortak anahtarla gider.
 * Ortak anahtar ladmin'in dağıttığı satırdır; şube anahtarı ayrı satırda durur, dağıtım ona dokunmaz.
 */

/** Bulut şube anahtarını reddedince ortak anahtarla geçen süre */
export const GERI_DONUS_MS = 10 * 60_000;

interface Gecmis {
  /** Bulutun şube anahtarını son reddettiği an ve o anahtar (değişince ret unutulur) */
  red: { at: number; key: string } | null;
}
let gecmis: Gecmis = { red: null };

/**
 * Bulutun son kabul ettiği şube anahtarının izi (değerin özeti, anahtarın kendisi değil): kabulde yazılır, retle silinir.
 * Kasa yeniden başlayınca da kalır: uzaktan yönetim her açılışta ortak anahtara dönüp bulutla ayrışmaz
 */
const ONAY = 'uzaktan.subeAnahtariOnay';
const izOf = (key: string) => createHash('sha256').update(`asilpos-sube-anahtari:${key}`).digest('hex').slice(0, 32);
let onay: string | null | undefined;
const onayOku = () => (onay === undefined ? (onay = getSyncState<string>(ONAY) || null) : onay);
function onayYaz(v: string | null) {
  if (onayOku() === v) return;
  onay = v;
  // Kayıt boş olamaz (sync_state.value NOT NULL): "kabul yok" boş metin
  setSyncState(ONAY, v ?? '');
}

/** Testler için: geçmişi ve kabul izini siler */
export function kafeAnahtariSifirla() {
  gecmis = { red: null };
  onay = undefined;
  onayYaz(null);
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
 * İsteklerin deneyeceği kafe anahtarı (`kafeFetch`): şube anahtarı (bulut son 10 dakikada onu reddetmediyse) ve şubesi,
 * değilse ortak anahtar (`sube` null)
 */
export function kafeAnahtari(now = Date.now()): { key: string; sube: string | null } {
  const s = subeAnahtari();
  const red = gecmis.red;
  if (s && !(red && red.key === s.key && now - red.at < GERI_DONUS_MS)) return s;
  return { key: env.cloudSecret, sube: null };
}

/**
 * Uzaktan yönetimin anahtarı (server/sync/kontrol.ts: komut imzası, açık anahtar imzası ve özetteki `sube`): şube
 * anahtarı yalnız bulut onu kabul ettiyse (son sonuç kabul), değilse ortak anahtar. 10 dakikalık yeniden deneme yalnız
 * `kafeFetch`'te: bulut şube anahtarını tanımıyorken kasa deneme anında ona dönseydi özet şubeyi söyler, bulut ise komutu
 * ortak anahtarla imzalar, kasa reddederdi
 */
export function kontrolAnahtari(): { key: string; sube: string | null } {
  const s = subeAnahtari();
  if (s && onayOku() === izOf(s.key)) return s;
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
      if (res.status < 400) onayYaz(izOf(k.key));
      return res;
    }
    gecmis.red = { at: Date.now(), key: k.key };
    onayYaz(null);
    console.warn(`[uzaktan] şube anahtarı reddedildi (Vercel'de ${subeAnahtarAdi(k.sube)} yok ya da farklı); ${GERI_DONUS_MS / 60_000} dakika ortak anahtarla`);
  }
  return signedFetch(ortak, method, url, body, timeoutMs, extraHeaders);
}

/**
 * Yönetim › Bağlantı bilgileri'nde şube anahtarının durumu: `yok` (boş), `subesiz` (kasanın şubesi belli değil),
 * `kisa`, `ortakla-ayni`, `kullaniliyor` (bulutun son yanıtı kabul), `bulutta-yok` (son yanıt ret; ortak anahtar
 * kullanılıyor) ya da `denenmedi` (henüz istek gitmedi). `ad`: Vercel'deki adı (değer değil)
 */
export function subeAnahtariGorunumu(): { durum: 'yok' | 'subesiz' | 'kisa' | 'ortakla-ayni' | 'bulutta-yok' | 'kullaniliyor' | 'denenmedi'; ad: string | null } {
  const key = env.cloudSubeSecret;
  const sube = subeEtiketi(getSettings().branchId);
  const ad = sube ? subeAnahtarAdi(sube) : null;
  if (!key) return { durum: 'yok', ad };
  if (!sube) return { durum: 'subesiz', ad };
  if (key.length < MIN_SECRET_LENGTH) return { durum: 'kisa', ad };
  if (key === env.cloudSecret) return { durum: 'ortakla-ayni', ad };
  if (onayOku() === izOf(key)) return { durum: 'kullaniliyor', ad };
  if (gecmis.red?.key === key) return { durum: 'bulutta-yok', ad };
  return { durum: 'denenmedi', ad };
}
