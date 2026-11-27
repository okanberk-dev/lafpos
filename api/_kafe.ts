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
 * Neden yalnız imzası (Vercel'deki geçersiz değerle ya da ortak anahtarla) tutan isteğe söylenir; imzasız istek düz 401 alır.
 *
 * Dükkânın (Merkez kurulum kimliği) şubesi: kendi anahtarıyla imzalı istek dükkânın kendisi olduğunu kanıtlarsa
 * (`dukkanKanitiTutar`: kurulumun kendi anahtarıyla imzalı kanıt, Merkez kaydındaki anahtarla doğrulanır) dükkân o şubeye
 * bağlanır. Bağ api/uzaktan.ts'te `${REDIS_ONEKI}surum` hash'inin `sube:<dükkân>` alanında, süresiz.
 *
 * Anahtar değişimi (docs/07-UZAKTAN-ERISIM.md §7; 27 Kasım 2026 olayı: Vercel'deki değer kasalardan önce değişince
 * kasaların bütün istekleri reddedildi): her anahtarın isteğe bağlı önceki değeri de kabul edilir. Ortak anahtarınki
 * `ASILPOS_CLOUD_SECRET_ONCEKI` ya da eski önekli adı (shared/pos-env.ts `eskiEnvAdi`): ikisi birden tanımlıysa ikisi de
 * sayılır (ladmin'in uyarısı eski adı, eski belge yeni adı öğretiyordu; birinin yok sayılması kasaları kesiyordu). Şubeninki
 * `ASILPOS_CLOUD_SECRET_<ŞUBE>_ONCEKI`. Önce şimdiki değer denenir, karşılaştırmalar sabit zamanlı (`verifyPush`). Önceki
 * değerle tutan istek aynı kimliği alır, `onceki` işaretiyle: bulutun kasaya imzaladığı (uzaktan yönetim komutu) kasanın
 * kullandığı anahtarla imzalanır (api/_kontrol.ts). Önceki değer yetki genişletemez: kısa, şimdikiyle aynı ya da başka bir
 * anahtarın (öbür şubenin şimdiki ya da önceki, ortak anahtarın şimdiki ya da önceki değeri) aynısı olan önceki değer yok
 * sayılır; şubenin önceki değeri yalnız şubenin şimdiki anahtarı geçerliyken sayılır.
 *
 * Değişimin izlenmesi (27 Kasım 2026 incelemesi): imzası tutan kasa isteğinin 2xx yanıtı hangi değerle tuttuğunu
 * `x-laf-anahtar: simdiki|onceki` başlığıyla söyler (`anahtarBasligi`); ladmin kendi değerinin yalnız önceki değer olarak
 * kabul edildiğini görüp `_ONCEKI` silinmeden önce uyarır. `/api/health` ortak anahtarın önceki değeri tanımlı mı der
 * (`oncekiDurumu`): bütün kasalar geçtiği halde duruyorsa silinmesi hatırlatılır.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ANAHTAR_BASLIGI, ONCEKI_EKI, SUBE_ANAHTARI_RE, SUBE_BASLIGI, SUBE_ONCEKI_RE, dukkanKanitMetni, subeAnahtarAdi, subeEtiketi, subeOncekiAdi } from '../shared/baglanti.js';
import { eskiEnvAdi } from '../shared/pos-env.js';

/**
 * İmzalı isteği yapan kasa: söylediği şube (başlıksız istekte null), imzanın o şubenin kendi anahtarıyla olup olmadığı ve
 * imza önceki değerle tuttuysa `onceki` (anahtar değişimi; kasa yeni değere henüz geçmedi)
 */
export interface Kafe {
  sube: string | null;
  kendi: boolean;
  onceki?: true;
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

/** Ortamdaki şube anahtarlarının önceki değerleri: şube etiketi → değer (boşlar atılır) */
function subeOncekiDegerleri(vars: Readonly<Record<string, string | undefined>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name, value] of Object.entries(vars)) {
    const m = SUBE_ONCEKI_RE.exec(name);
    const v = (value ?? '').trim();
    if (m && v) out.set(m[1]!, v);
  }
  return out;
}

const ORTAK_ONCEKI = `ASILPOS_CLOUD_SECRET${ONCEKI_EKI}`;
/** Ortak anahtarın önceki değerinin iki adı: yeni ad ve Vercel'de bugün şimdiki değerin yanında duran eski ad */
const ORTAK_ONCEKI_ADLARI = [ORTAK_ONCEKI, eskiEnvAdi(ORTAK_ONCEKI)!] as const;
type Vars = Readonly<Record<string, string | undefined>>;
/** Ortak anahtarın önceki değerleri, denetimsiz: iki addaki dolu değerler (ad → değer; boşlar atılır) */
const ortakOncekiHamlari = (vars: Vars): [string, string][] =>
  ORTAK_ONCEKI_ADLARI.map((ad): [string, string] => [ad, (vars[ad] ?? '').trim()]).filter(([, v]) => v !== '');
const ortakOncekiHam = (vars: Vars) => new Set(ortakOncekiHamlari(vars).map(([, v]) => v));

/** Ortak anahtarın geçerli önceki değerleri ve adları (`ortakOncekiler`, `oncekiDurumu`) */
function ortakOncekiKayitlari(ortak: string, vars: Vars): [string, string][] {
  const subeler = new Set([...subeAnahtarlari(vars).values(), ...subeOncekiDegerleri(vars).values()]);
  return ortakOncekiHamlari(vars).filter(([, v]) => v.length >= MIN_KEY && v !== ortak && !subeler.has(v));
}

/**
 * Ortak anahtarın önceki değerleri (`ASILPOS_CLOUD_SECRET_ONCEKI` ve eski önekli adı; ikisi de
 * tanımlıysa ikisi de, aynıysa bir kez): anahtar değişiminde kasalar yeni değere gece geçene dek bulut bunları da kabul
 * eder. Kısa, şimdikiyle aynı ya da bir şube anahtarıyla (şimdiki ya da önceki) aynı olan değer sayılmaz: o şubenin
 * anahtarıyla imzalı istek başlıksız gelip ortak anahtar sayılmasın
 */
export function ortakOncekiler(ortak: string, vars: Vars = process.env): string[] {
  return [...new Set(ortakOncekiKayitlari(ortak, vars).map(([, v]) => v))];
}

/**
 * Herkese açık sağlık yanıtının anahtar değişimi alanları (`/api/health`): ortak anahtarın geçerli bir önceki değeri
 * tanımlı mı (`onceki`) ve hangi adlarla (`oncekiAdlari`; değer değil). ladmin bütün kasalar yeni değeri uyguladığı halde
 * `onceki` duruyorsa silinmesini hatırlatır: unutulan `_ONCEKI` eski anahtarı süresiz geçerli tutar. Uzaktan kurulmamışsa
 * (şimdiki anahtar yok) önceki de sayılmaz
 */
export function oncekiDurumu(ortak: string, vars: Vars = process.env): { onceki: boolean; oncekiAdlari: string[] } {
  if (ortak.length < MIN_KEY) return { onceki: false, oncekiAdlari: [] };
  const adlar = ortakOncekiKayitlari(ortak, vars).map(([ad]) => ad);
  return { onceki: adlar.length > 0, oncekiAdlari: adlar };
}

/**
 * Şube anahtarının önceki değeri (`ASILPOS_CLOUD_SECRET_<ŞUBE>_ONCEKI`): yalnız şubenin şimdiki anahtarı geçerliyken.
 * Kısa, şimdikiyle aynı, ortak anahtarın şimdiki ya da önceki değeriyle ya da başka şubenin şimdiki ya da önceki
 * anahtarıyla aynıysa null: ortak anahtarı bilen (bütün kasalar) ya da başka şube bu şubeyi açamasın
 */
export function subeOncekiAnahtari(sube: string | null, ortak: string, vars: Vars = process.env): string | null {
  if (!sube) return null;
  const d = subeAnahtariDurumu(sube, ortak, vars);
  if (d.durum !== 'gecerli') return null;
  const v = (vars[subeOncekiAdi(sube)] ?? '').trim();
  if (v.length < MIN_KEY || v === d.anahtar || v === ortak || ortakOncekiHam(vars).has(v)) return null;
  for (const [s, k] of subeAnahtarlari(vars)) if (s !== sube && k === v) return null;
  for (const [s, k] of subeOncekiDegerleri(vars)) if (s !== sube && k === v) return null;
  return v;
}

/**
 * Kafe anahtarlarının ortamdaki bütün değerleri, denetimsiz: ortak ve şube anahtarlarının şimdiki ve önceki (`_ONCEKI`)
 * değerleri. Üçüncü tarafa verilen anahtar (Getir) bunlardan biri olamaz: önceki değer de değişim süresince kasa imzası
 * sayılır
 */
export function kafeAnahtarDegerleri(vars: Readonly<Record<string, string | undefined>> = process.env): Set<string> {
  const ortak = (vars.ASILPOS_CLOUD_SECRET ?? '').trim() || (vars[eskiEnvAdi('ASILPOS_CLOUD_SECRET')!] ?? '').trim();
  const out = new Set([ortak, ...ortakOncekiHam(vars), ...subeAnahtarlari(vars).values(), ...subeOncekiDegerleri(vars).values()]);
  out.delete('');
  return out;
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
 * `kafeAnahtari`'nın önceki değerleri (anahtar değişimi): şubenin kendi geçerli anahtarı varsa onun önceki değeri, yoksa
 * ortak anahtarınkiler (iki adla); tanımlı ya da geçerli değilse boş
 */
export function kafeOncekiAnahtarlari(sube: string | null | undefined, ortak: string): string[] {
  const s = typeof sube === 'string' ? subeEtiketi(sube) : null;
  if (subeAnahtariDurumu(s, ortak).durum !== 'gecerli') return ortakOncekiler(ortak);
  const v = subeOncekiAnahtari(s, ortak);
  return v ? [v] : [];
}

/** Bu istekte imzayı tutan değer (`kafeKimligi` yazar, `anahtarBasligi` okur): istek nesnesi başına, bellekte */
const eslesen = new WeakMap<object, 'simdiki' | 'onceki'>();

/**
 * Yanıta `x-laf-anahtar` başlığı (shared/baglanti.ts `ANAHTAR_BASLIGI`): istekte kasa imzası tuttuysa ve yanıt 2xx ise
 * hangi değerle tuttuğu (`simdiki` ya da `onceki`). Başka yanıta dokunmaz. Sır taşımaz: imzayı tutturan zaten anahtarı
 * bilir. api/uzaktan.ts her yanıtta çağırır
 */
export function anahtarBasligi(req: object, res: Response): Response {
  const e = eslesen.get(req);
  if (!e || res.status < 200 || res.status >= 300) return res;
  const headers = new Headers(res.headers);
  headers.set(ANAHTAR_BASLIGI, e);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Kasanın imzalı isteği: `x-laf-sube` başlığı varsa o şubenin kendi anahtarıyla (tanımlıysa; değilse ortak anahtarla),
 * başlık yoksa ortak anahtarla doğrulanır. Tutarsa kasanın kimliği, tutmazsa 401 `bad_signature` (kasa şube anahtarıyla
 * imzaladıysa ortak anahtarla yineler: server/lib/kafe-anahtari.ts), başlık anlaşılmazsa 400 yanıtı döner. Şubenin
 * anahtarı geçersizse 503 yalnız imzası Vercel'deki (geçersiz) değerle ya da ortak anahtarla tutan isteğe: anahtarı
 * olmayan biri başlıkla hangi şubenin anahtarının bozuk olduğunu, neden bozuk olduğunu öğrenemez (düz 401 alır).
 * Her anahtarın önceki değeri de (`ortakOncekiler`, `subeOncekiAnahtari`) tutar: kimlik aynı, `onceki` işaretli. Tutan
 * değer istek için not edilir (`anahtarBasligi`)
 */
export function kafeKimligi(req: { method: string; headers: Headers }, url: URL, body: string, ortak: string, dogrula: Dogrula): Kafe | Response {
  const tutar = (key: string | null) => !!key && key.length >= MIN_KEY && dogrula(key, req, url, body);
  const red = () => fail(401, 'İmza geçersiz', 'bad_signature');
  // Önce şimdiki değer, tutmazsa önceki değerler (anahtar değişimi: kasa yeni değere gün kapanınca geçer)
  const kimlik = (sube: string | null, kendi: boolean, simdiki: string, oncekiler: () => string[]): Kafe | Response => {
    if (tutar(simdiki)) {
      eslesen.set(req, 'simdiki');
      return { sube, kendi };
    }
    if (oncekiler().some(tutar)) {
      eslesen.set(req, 'onceki');
      return { sube, kendi, onceki: true };
    }
    return red();
  };
  const ortakOnceki = () => ortakOncekiler(ortak);
  const baslik = req.headers.get(SUBE_BASLIGI);
  if (baslik == null) return kimlik(null, false, ortak, ortakOnceki);
  const sube = subeEtiketi(baslik);
  if (!sube) return fail(400, 'Şube başlığı anlaşılamadı', 'bad_branch');
  const d = subeAnahtariDurumu(sube, ortak);
  if (d.durum === 'gecersiz') {
    const ham = subeAnahtarlari().get(sube) ?? '';
    const imzali = (ham && dogrula(ham, req, url, body)) || tutar(ortak) || ortakOnceki().some(tutar);
    return imzali ? fail(503, `Şube anahtarı geçersiz (${subeAnahtarAdi(sube)} ${d.neden})`, 'branch_key_invalid') : red();
  }
  if (d.durum === 'gecerli') {
    return kimlik(sube, true, d.anahtar, () => {
      const v = subeOncekiAnahtari(sube, ortak);
      return v ? [v] : [];
    });
  }
  return kimlik(sube, false, ortak, ortakOnceki);
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
 * Dükkânın şubeye bağlanma kanıtı tutuyor mu (shared/baglanti.ts `DUKKAN_KANIT_BASLIGI`): HMAC-SHA256(kurulumun Merkez'de
 * kayıtlı anahtarı, `dukkanKanitMetni(dükkân, şube)`), base64url, sabit zamanlı karşılaştırma. Yalnız şube anahtarıyla
 * imzalı istekte okunur: kanıt "bu dükkân bu şubenin" der, istek imzası "ben bu şubeyim" der. İkisi birlikte yalnız o
 * dükkânın kasasında olur; dükkân kimliğini (görünümden) öğrenen başka şubenin kasası onu kendine bağlayamaz
 */
export function dukkanKanitiTutar(kurulumAnahtari: string, dukkan: string, sube: string, kanit: string | null): boolean {
  if (!kanit || kurulumAnahtari.length < MIN_KEY) return false;
  const beklenen = Buffer.from(createHmac('sha256', kurulumAnahtari).update(dukkanKanitMetni(dukkan, sube)).digest('base64url'));
  const gelen = Buffer.from(kanit.trim().replace(/=+$/, ''));
  return gelen.length === beklenen.length && timingSafeEqual(gelen, beklenen);
}
