/**
 * Kafe anahtarları (docs/07-UZAKTAN-ERISIM.md §6): kasanın imzalı isteklerini doğrulayan anahtar ve şubeye ait
 * kaynağa erişim. api/uzaktan.ts ve alt dosyaları kullanır (alt çizgili dosya Vercel'de ayrı işlev olmaz).
 *
 * Ortak anahtar `ASILPOS_CLOUD_SECRET` bütün şubelerde aynıdır. Sahip bir şubeye kendi anahtarını verebilir:
 * `ASILPOS_CLOUD_SECRET_<ŞUBE>` (ŞUBE: `subeEtiketi`, 'marina' → MARINA). O şubenin kasası istekte şubesini `x-laf-sube`
 * başlığıyla söyler ve isteği bu anahtarla imzalar; başlık imzaya girmez ama yanlış şubeyi söyleyen, o şubenin anahtarını
 * bilmeden imzayı tutturamaz. Kendi anahtarı olan şubenin kaynakları (platform anahtarları, restoranının gelen kutusu,
 * şubeye bağlanmış dükkânın özeti, raporları ve yedekleri) yalnız bu imzayla açılır: ortak anahtarı bilen başka şubenin
 * kasası onları göremez. Kendi anahtarı olmayan şube eskisi gibi ortak anahtarla çalışır; başlıksız (eski) kasa da.
 *
 * Şube anahtarı geçerli sayılmaz (o şubeye istek 503 `branch_key_invalid`): 32 karakterden kısa, ortak anahtarla ya da
 * başka bir şubeninkiyle aynı. Böyle bir yanlışlık sessizce ortak anahtara düşmez: şubenin kaynakları açılmaz, neden yanıtta.
 */
import { SUBE_ANAHTARI_RE, SUBE_BASLIGI, subeAnahtarAdi, subeEtiketi } from '../shared/baglanti.js';

/** İmzalı isteği yapan kasa: söylediği şube (başlıksız istekte null) ve imzanın o şubenin kendi anahtarıyla olup olmadığı */
export interface Kafe {
  sube: string | null;
  kendi: boolean;
}

/** İmza doğrulayıcı (api/uzaktan.ts verifyPush) */
export type Dogrula = (key: string, req: { method: string; headers: Headers }, url: URL, body: string) => boolean;

const MIN_KEY = 32;
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);

/** Ortamdaki şube anahtarları: şube etiketi → değer (boşlar atılır) */
export function subeAnahtarlari(vars: Readonly<Record<string, string | undefined>> = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(vars)) {
    const m = SUBE_ANAHTARI_RE.exec(name);
    const v = (value ?? '').trim();
    if (m && v) out.set(m[1]!, v);
  }
  return out;
}

export type AnahtarDurumu = { durum: 'yok' } | { durum: 'gecerli'; anahtar: string } | { durum: 'gecersiz'; neden: string };

/** Şubenin kendi anahtarı: yok, geçerli ya da geçersiz (nedeniyle). `ortak`: ASILPOS_CLOUD_SECRET */
export function subeAnahtariDurumu(sube: string | null, ortak: string, vars: Readonly<Record<string, string | undefined>> = process.env): AnahtarDurumu {
  if (!sube) return { durum: 'yok' };
  const hepsi = subeAnahtarlari(vars);
  const k = hepsi.get(sube);
  if (!k) return { durum: 'yok' };
  if (k.length < MIN_KEY) return { durum: 'gecersiz', neden: 'en az 32 karakter olmalı' };
  if (k === ortak) return { durum: 'gecersiz', neden: 'ortak anahtarla (ASILPOS_CLOUD_SECRET) aynı olamaz' };
  for (const [s, v] of hepsi) if (s !== sube && v === k) return { durum: 'gecersiz', neden: `${subeAnahtarAdi(s)} ile aynı olamaz` };
  return { durum: 'gecerli', anahtar: k };
}

/** Şubenin anahtarı tanımlı mı (geçerli ya da geçersiz): tanımlıysa kaynakları yalnız kendi imzasıyla açılır */
export const subeAnahtariVar = (sube: string | null, ortak: string) => subeAnahtariDurumu(sube, ortak).durum !== 'yok';

/**
 * Şubenin komut ve açık anahtar imzası için anahtarı (uzaktan yönetim, api/_kontrol.ts): kendi geçerli anahtarı, yoksa
 * ortak anahtar
 */
export function kafeAnahtari(sube: string | null | undefined, ortak: string): string {
  const d = subeAnahtariDurumu(typeof sube === 'string' ? subeEtiketi(sube) : null, ortak);
  return d.durum === 'gecerli' ? d.anahtar : ortak;
}

/**
 * Kasanın imzalı isteği: `x-laf-sube` başlığı varsa o şubenin kendi anahtarıyla (tanımlıysa; değilse ortak anahtarla),
 * başlık yoksa ortak anahtarla doğrulanır. Tutarsa kasanın kimliği, tutmazsa 401 `bad_signature` (kasa şube anahtarıyla
 * imzaladıysa ortak anahtarla yineler: server/lib/kafe-anahtari.ts), başlık anlaşılmazsa 400, şubenin anahtarı geçersizse
 * 503 yanıtı döner
 */
export function kafeKimligi(req: { method: string; headers: Headers }, url: URL, body: string, ortak: string, dogrula: Dogrula): Kafe | Response {
  const baslik = req.headers.get(SUBE_BASLIGI);
  if (baslik == null) return ortak.length >= MIN_KEY && dogrula(ortak, req, url, body) ? { sube: null, kendi: false } : fail(401, 'İmza geçersiz', 'bad_signature');
  const sube = subeEtiketi(baslik);
  if (!sube) return fail(400, 'Şube başlığı anlaşılamadı', 'bad_branch');
  const d = subeAnahtariDurumu(sube, ortak);
  if (d.durum === 'gecersiz') return fail(503, `Şube anahtarı geçersiz (${subeAnahtarAdi(sube)} ${d.neden})`, 'branch_key_invalid');
  const key = d.durum === 'gecerli' ? d.anahtar : ortak;
  if (key.length < MIN_KEY || !dogrula(key, req, url, body)) return fail(401, 'İmza geçersiz', 'bad_signature');
  return { sube, kendi: d.durum === 'gecerli' };
}

/**
 * Şubeye ait kaynağa erişim (`hedef`: kaynağın şubesi; null: şubesiz, herkese açık kaynak): hedefin kendi anahtarı varsa
 * yalnız o anahtarla imzalı istek; yoksa ortak anahtarla imzalı her istek, ama başka şubenin kendi anahtarıyla gelen
 * istek değil (şube anahtarı yalnız kendi şubesini açar). Erişim varsa null, yoksa 403 yanıtı
 */
export function subeErisimi(kafe: Kafe, hedef: string | null, ortak: string): Response | null {
  if (!hedef) return null;
  if (subeAnahtariVar(hedef, ortak)) {
    if (kafe.kendi && kafe.sube === hedef) return null;
    return fail(403, `Bu şubenin kendi anahtarı var (Vercel'de ${subeAnahtarAdi(hedef)}): kasada Yönetim › Bağlantı bilgileri › AsilPOS Uzaktan › Şube anahtarı aynı olmalı`, 'branch_key_required');
  }
  if (kafe.kendi && kafe.sube !== hedef) return fail(403, 'Şube anahtarı yalnız kendi şubesinin kaynaklarını açar', 'other_branch');
  return null;
}

/**
 * Dükkânın (Merkez kurulum kimliği) bağlı olduğu şube: kendi anahtarıyla imzalı ilk yazımda bağlanır (özet itmesinde
 * sürüm kaydına, rapor itmesinde rapor kaydına `s`). Bağlı dükkânın yeni bağı: yazanın şubesi (kendi anahtarıyla)
 * yoksa eski bağ
 */
export const yeniBag = (kafe: Kafe, eski: string | null | undefined): string | undefined => (kafe.kendi && kafe.sube ? kafe.sube : (eski ?? undefined));
