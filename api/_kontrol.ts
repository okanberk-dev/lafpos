/**
 * Uzaktan yönetim (docs/UZAKTAN-YONETIM.md): LafPOS Uzaktan'ın panel uçları, kasaya giden komut kuyruğu ve panele kimin
 * gireceği. api/uzaktan.ts `kontrol/` ile başlayan istekleri buraya verir (alt çizgili dosya Vercel'de ayrı işlev olmaz);
 * kasaya teslim ve sonuç Merkez nabzında (`nabizKontrol`, api/_merkez.ts). Sözleşme shared/kontrol.ts.
 *
 * Komut: üyenin rolü (`uyeYapabilir`; patron hesabına ve rol yetkilerine yalnız sahip), kasanın son özeti (sözleşme
 * sürümü, desteklediği türler, uzaktan yönetim açık mı), `komutDogrula`, gün sonunda kasa çevrimiçi mi, kuyruk ve üye
 * başına saat sınırı. Geçen komut kasadaki adlarla özetlenir, kurulum ve üyenin rolüyle birlikte kafenin ortak
 * anahtarıyla (LAFPOS_CLOUD_SECRET) imzalanır ve kuyruğa girer: Redis'e yazabilen biri anahtarı bilmeden kasaya komut
 * sokamaz, bir şubenin komutunu başkasına taşıyamaz, rolü değiştiremez. Kasa rolü ve hedefin gerçek rolünü yeniden
 * denetler (bulutun özeti eski olabilir). Panel yalnız satırları görür; komutun verisi (şifreli PIN) ve imzası dönmez.
 *
 * Redis, kurulum kimliğiyle: `${REDIS_ONEKI}kontrol:komut:<id>` (HASH, kimlik → KomutKaydi), `…:var:<id>` (kuyrukta komut var),
 * `…:teslim:<id>` (kasaya giden son komutun anı: kasaya ulaşan komut iptal edilmez), `…:durum:<id>` (kasanın son özeti),
 * `…:ozet:<id>` (onun parmak izi), `…:gecmis:<id>` (LIST, bitmiş işlemler), `…:sayac:<id>:<saat>:<üye>`. Panel üyeleri:
 * `${REDIS_ONEKI}uye:<e-posta>` (kayıt; rol yalnız davetle gelende), `${REDIS_ONEKI}uye-davet:<e-posta>` (davet: kodun özeti, 7 gün),
 * `${REDIS_ONEKI}uyeler` (davet edilenlerin kümesi).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  anahtarImzaMetni,
  DAVET_OMRU_MS,
  DAVET_ROLLERI,
  type DavetRolu,
  type DavetYaniti,
  durumGecerli,
  durumParmakIzi,
  GECMIS_EN_COK,
  type GecmisDurumu,
  imzaMetni,
  KOMUT_ID_RE,
  KOMUT_TURLERI,
  komutDogrula,
  type KomutKaydi,
  komutOzeti,
  type KomutSonucu,
  type KomutYaniti,
  KONTROL_SURUM,
  type KontrolDurumu,
  type KontrolGecmisi,
  type KontrolPaneli,
  type KontrolPersonel,
  type KontrolRol,
  KUYRUK_EN_COK,
  type NabizKontrolYaniti,
  type OzetAdlari,
  SAAT_PAYI_MS,
  SAATLIK_EN_COK,
  ozetAdi,
  type SonucDurumu,
  type UyeRolu,
  uyeYapabilir,
  type UzaktanUye,
} from '../shared/kontrol.js';
import { ONLINE_MS } from '../shared/lisans.js';
import { ROLE_DEFAULTS, ROLES, type Role } from '../shared/permissions.js';
import { REDIS_ONEKI } from '../shared/eski-adlar.js';

type Redis = (...cmd: (string | number)[]) => Promise<unknown>;

/** Oturumdaki üye: e-posta (parolalı girişte null) ve rolü */
export interface KontrolOturumu {
  eposta: string | null;
  rol: UyeRolu;
}

export interface KontrolDeps {
  redis: Redis;
  /** Gerçek oturum (üye ya da parolalı giriş) ve rolü; yoksa null (401) */
  oturum: () => Promise<KontrolOturumu | null>;
  /** Geçerli ama gerçek olmayan oturum (parolasız görünüm): 401 yerine 403 döner, uzaktan oturum düşmez */
  gorunum?: () => Promise<boolean>;
  /** Kafe bağlanmadan önceki örnek görünüm: örnek veri, işlem yok */
  demo: boolean;
  /** Görünümün dükkânı: Merkez kurulum kimliği (Merkez'e bağlı olmayan eski kasa `default`) */
  dukkan: () => Promise<string>;
  /** Kafenin ortak anahtarı (LAFPOS_CLOUD_SECRET): komut imzası */
  secret: string;
  /** Vercel ortamındaki sahip e-postaları (LAFPOS_UYE_EPOSTA); boşsa üyelik kapalı (parolalı ya da parolasız görünüm) */
  sahipler: string[];
  /** Üye kaydı değişti ya da silindi: oturum önbelleğinden düşsün */
  uyeDegisti?: (eposta: string) => void;
  /**
   * "Gün sonu al ve güncelle": Merkez'in "Şimdi güncelle"si (api/_merkez.ts requestUpdateNow; kanalın son derlemesiyle),
   * `komut` gün sonuna bağlı. api/uzaktan.ts verir: Merkez nabız için bu dosyayı içe aktarır, burası onu aktarmaz (döngü)
   */
  guncelleIste?: (kurulum: string, now: number, komut: string) => Promise<unknown>;
  /** Bağlı gün sonu iptal edildi: o gün sonuna bağlı güncelleme isteği de geri alınır (api/_merkez.ts withdrawLinkedUpdate) */
  guncelleBirak?: (kurulum: string, komut: string) => Promise<unknown>;
  now?: () => number;
}

// ─── Sınırlar ve anahtarlar ──────────────────────────────────────────────────

/** Kasanın özeti en çok bu kadar bayt; büyüğü saklanmaz */
export const DURUM_EN_COK = 64 * 1024;
/** Merkez nabzının gövde sınırına eklenen pay: özet ve sonuçlar */
export const NABIZ_KONTROL_PAYI = DURUM_EN_COK + 64 * 1024;
/** Bir nabızda okunan sonuç */
const SONUC_EN_COK = KUYRUK_EN_COK * 2;
/** Panel isteğinin gövdesi (şifreli PIN ~350, rol yetkileri ~700 karakter) */
const GOVDE_EN_COK = 8 * 1024;
/** Panelden davet edilen kişi (sahipler hariç) */
const UYE_EN_COK = 50;
/** Kuyruğun son payı sahibe ayrılır: yönetici kuyruğu doldurup sahibin acil işlemini (hesabı kapat) bekletemesin */
const SAHIP_PAYI = 10;
/**
 * Teslim anının payı: nabız teslim anını kuyruğu okumadan önce yazar; o arada (ya da Vercel örnekleri arasındaki saat
 * farkıyla) kuyruğa giren komut da "gitmiş" sayılır. Payın içindeki iptal 409 alır, komut bir sonraki nabızda gider
 */
const TESLIM_PAYI_MS = 2_000;

const komutKey = (id: string) => `${REDIS_ONEKI}kontrol:komut:${id}`;
const varKey = (id: string) => `${REDIS_ONEKI}kontrol:var:${id}`;
const teslimKey = (id: string) => `${REDIS_ONEKI}kontrol:teslim:${id}`;
const durumKey = (id: string) => `${REDIS_ONEKI}kontrol:durum:${id}`;
const ozetKey = (id: string) => `${REDIS_ONEKI}kontrol:ozet:${id}`;
const gecmisKey = (id: string) => `${REDIS_ONEKI}kontrol:gecmis:${id}`;
/** Saatlik sayaç üye başına: bir üye (ya da ele geçirilmiş hesabı) sınırı doldurup başkasını bekletemez */
const sayacKey = (id: string, saat: number, kim: string) => `${REDIS_ONEKI}kontrol:sayac:${id}:${saat}:${kim}`;
/**
 * Merkez kurulum kimliği ve kaydı: api/_merkez.ts ID_RE ve anahtarlarıyla aynı. O dosya nabız için bunu içe aktardığından
 * burada yeniden tanımlı (döngü olmasın); eşitliği tests/kontrol-bulut.test.ts denetler
 */
export const KURULUM_RE = /^[a-z0-9]{20,40}$/;
const merkezKeys = (id: string) => [`${REDIS_ONEKI}merkez:kurulum:${id}`, `${REDIS_ONEKI}merkez:durum:${id}`];

export const uyeKey = (eposta: string) => `${REDIS_ONEKI}uye:${eposta}`;
export const davetKey = (eposta: string) => `${REDIS_ONEKI}uye-davet:${eposta}`;
export const UYELER_KEY = `${REDIS_ONEKI}uyeler`;

// ─── Yardımcılar ─────────────────────────────────────────────────────────────

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);
const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Redis'teki JSON nesne; bozuksa ya da nesne değilse null */
function parse<T>(raw: unknown): T | null {
  if (typeof raw !== 'string') return null;
  try {
    const v = JSON.parse(raw) as unknown;
    return isRecord(v) ? (v as T) : null;
  } catch {
    return null;
  }
}

/** Ad haritası prototipsiz: `constructor` gibi bir kimlik özete işlev adı yazdırmasın */
const adHaritasi = (pairs: [string, string][]) => Object.assign(Object.create(null) as Record<string, string>, Object.fromEntries(pairs));

async function govde(req: Request): Promise<Record<string, unknown> | Response> {
  const raw = await req.text();
  if (raw.length > GOVDE_EN_COK) return fail(413, 'İstek çok büyük', 'too_large');
  try {
    const v = JSON.parse(raw) as unknown;
    if (isRecord(v)) return v;
  } catch {
    // aşağıda
  }
  return fail(400, 'İstek okunamadı', 'bad_body');
}

/** Komutun imzası: HMAC-SHA256(LAFPOS_CLOUD_SECRET, imzaMetni), base64url; kasa aynı metinden sabit zamanlı karşılaştırır */
export const komutImzasi = (secret: string, k: Pick<KomutKaydi, 'id' | 'tur' | 'veri' | 'at' | 'kim' | 'kurulum' | 'rol'>) => createHmac('sha256', secret).update(imzaMetni(k)).digest('base64url');

/** Kasanın açık anahtarı kasadan mı geldi: imzası kafenin ortak anahtarıyla ve bu kurulumla tutuyor mu (sabit zamanlı) */
export function anahtarTutar(secret: string, kurulum: string, d: Pick<KontrolDurumu, 'anahtar' | 'anahtarImza'>): boolean {
  if (!d.anahtar || typeof d.anahtarImza !== 'string') return false;
  const beklenen = Buffer.from(createHmac('sha256', secret).update(anahtarImzaMetni(kurulum, d.anahtar)).digest('base64url'));
  const gelen = Buffer.from(d.anahtarImza.replace(/=+$/, ''));
  return gelen.length === beklenen.length && timingSafeEqual(gelen, beklenen);
}

/** Panelin gördüğü satır: yalnız özet alanları (verisi ve imzası yok). `ozet`: kasanın kendi adlarıyla özeti (sonuçta) */
function satir(k: KomutKaydi, durum: GecmisDurumu = 'bekliyor', mesaj: string | null = null, bitti: number | null = null, ozet?: string): KontrolGecmisi {
  return { id: k.id, tur: k.tur, ozet: ozet || k.ozet, kim: k.kim, at: k.at, durum, mesaj, bitti };
}

const komutMu = (k: KomutKaydi | null): k is KomutKaydi =>
  !!k && typeof k.id === 'string' && typeof k.at === 'number' && typeof k.ozet === 'string' && (KOMUT_TURLERI as readonly string[]).includes(k.tur);

/** Kuyruktaki komutlar, eskiden yeniye */
async function kuyruk(redis: Redis, id: string): Promise<KomutKaydi[]> {
  const raw = await redis('HVALS', komutKey(id));
  return (Array.isArray(raw) ? raw : [])
    .map((r) => parse<KomutKaydi>(r))
    .filter(komutMu)
    .sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
}

const GECMIS_DURUMLARI: readonly string[] = ['bekliyor', 'uygulandi', 'reddedildi', 'iptal'];
function gecmisOku(raw: unknown): KontrolGecmisi[] {
  return (Array.isArray(raw) ? raw : [])
    .map((r) => parse<KontrolGecmisi>(r))
    .filter((g): g is KontrolGecmisi => !!g && typeof g.id === 'string' && typeof g.ozet === 'string' && GECMIS_DURUMLARI.includes(g.durum));
}

async function gecmiseYaz(redis: Redis, id: string, satirlar: KontrolGecmisi[]) {
  // LPUSH sondakini başa koyar: işlenme sırasıyla verilen satırlar yeniden eskiye durur
  await redis('LPUSH', gecmisKey(id), ...satirlar.map((s) => JSON.stringify(s)));
  await redis('LTRIM', gecmisKey(id), 0, GECMIS_EN_COK - 1);
}

/**
 * Kuyruk boş görüldü: işaret ve teslim anı silinir, sonra kuyruk yeniden sayılır. Arada komut girdiyse (komutEkle önce
 * HSET, sonra işaret yazar) işaret geri konur: silme ile yeni komutun işareti yarışıp komut işaretsiz kalmaz
 */
async function isaretTemizle(redis: Redis, id: string) {
  await redis('DEL', varKey(id), teslimKey(id));
  if (Number(await redis('HLEN', komutKey(id))) > 0) await redis('SET', varKey(id), '1');
}

/** Yalnız sözleşmenin alanları saklanır (kasa fazladan bir şey gönderse de panele gitmez) */
function alanlar<T>(o: Record<string, unknown>, keys: readonly (keyof T & string)[]): T {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out as T;
}
function durumTemiz(d: KontrolDurumu): KontrolDurumu {
  return {
    ...alanlar<KontrolDurumu>(d as unknown as Record<string, unknown>, ['v', 'at', 'acik', 'turler', 'anahtar', 'anahtarImza', 'servisModu']),
    personel: (d.personel as unknown[]).filter(isRecord).map((p) => alanlar<KontrolPersonel>(p, ['id', 'ad', 'rol', 'renk', 'aktif', 'indirim', 'sonGiris'])),
    roller: (d.roller as unknown[]).filter(isRecord).map((r) => alanlar<KontrolRol>(r, ['rol', 'izinler', 'ozel', 'kisi'])),
  };
}

// ─── Panel üyeleri: e-posta, rol ve davet ───────────────────────────────────

/** Üye kaydı (api/uzaktan.ts): parolanın özeti (scrypt), açılış anı; rol yalnız panelden davet edilende */
export interface UyeKaydi {
  h: string;
  at: number;
  rol?: DavetRolu;
}
/** Panelden verilen davet: kodun kendisi değil özeti; kim: davet eden (e-posta ya da `parola`) */
export interface DavetKaydi {
  kod: string;
  rol: DavetRolu;
  at: number;
  kim: string;
}

export const EPOSTA_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export const normalizeEposta = (v: unknown) => String(v ?? '').trim().toLowerCase();
export const davetRolu = (v: unknown): DavetRolu | null => (typeof v === 'string' && (DAVET_ROLLERI as readonly string[]).includes(v) ? (v as DavetRolu) : null);

/** Davet kodu büyük-küçük harf, boşluk ve tireye bakmadan karşılaştırılır (telefonda elle yazılır) */
export const normalizeDavet = (v: unknown) => String(v ?? '').toUpperCase().replace(/[\s-]+/g, '');
/** Redis'te davet kodunun özeti durur (sha256, onaltılık) */
export const davetOzeti = (kod: unknown) => createHash('sha256').update(normalizeDavet(kod)).digest('hex');

/** Redis'teki davet (JSON) geçerli mi: biçimi doğru ve süresi dolmamış (Redis'in süresine ek olarak); değilse null */
export function davetGecerli(raw: unknown, now: number): DavetKaydi | null {
  const d = typeof raw === 'string' ? parse<Record<string, unknown>>(raw) : isRecord(raw) ? raw : null;
  if (!d || !davetRolu(d.rol) || typeof d.kod !== 'string' || !/^[0-9a-f]{64}$/.test(d.kod) || num(d.at) == null) return null;
  return (d.at as number) + DAVET_OMRU_MS > now ? (d as unknown as DavetKaydi) : null;
}

/** Karışmayan harf ve rakamlar (0/O, 1/I/L yok): telefonda okunup elle yazılır */
const KOD_HARFLERI = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
/** 12 karakterlik kişisel davet kodu (~59 bit), `XXXX-XXXX-XXXX` */
export function davetKoduUret(): string {
  const out: string[] = [];
  while (out.length < 12) {
    for (const b of randomBytes(16)) {
      // Eşit dağılım: 31'in katını aşan baytlar atılır
      if (b < 248 && out.length < 12) out.push(KOD_HARFLERI[b % 31]!);
    }
  }
  return `${out.slice(0, 4).join('')}-${out.slice(4, 8).join('')}-${out.slice(8).join('')}`;
}

async function uyeListesi(deps: KontrolDeps, now: number): Promise<UzaktanUye[]> {
  const sahipler = deps.sahipler;
  const kume = await deps.redis('SMEMBERS', UYELER_KEY);
  const davetliler = (Array.isArray(kume) ? kume : []).filter((e): e is string => typeof e === 'string' && EPOSTA_RE.test(e) && !sahipler.includes(e)).sort();
  const keys = [...sahipler.map(uyeKey), ...davetliler.flatMap((e) => [uyeKey(e), davetKey(e)])];
  const raws = keys.length ? (((await deps.redis('MGET', ...keys)) as unknown[] | null) ?? []) : [];
  const out: UzaktanUye[] = sahipler.map((eposta, i) => {
    const k = parse<UyeKaydi>(raws[i]);
    return { eposta, rol: 'sahip', durum: k ? 'aktif' : 'davet', sabit: true, at: num(k?.at), davetBitis: null };
  });
  const bayat: string[] = [];
  davetliler.forEach((eposta, j) => {
    const k = parse<UyeKaydi>(raws[sahipler.length + j * 2]);
    const d = davetGecerli(raws[sahipler.length + j * 2 + 1], now);
    const kayitRolu = davetRolu(k?.rol);
    if (k && kayitRolu) out.push({ eposta, rol: kayitRolu, durum: 'aktif', sabit: false, at: num(k.at), davetBitis: null });
    else if (d) out.push({ eposta, rol: d.rol, durum: 'davet', sabit: false, at: d.at, davetBitis: d.at + DAVET_OMRU_MS });
    else bayat.push(eposta);
  });
  // Süresi dolmuş davet ya da elle silinmiş kayıt kümeden de düşer
  if (bayat.length) await deps.redis('SREM', UYELER_KEY, ...bayat);
  return out;
}

/** Üye uçlarının ortak girdisi: e-posta biçimi ve ortamdaki sahip (panelden değiştirilmez) */
function uyeEpostasi(body: Record<string, unknown>, deps: KontrolDeps): string | Response {
  const eposta = normalizeEposta(body.eposta);
  if (!EPOSTA_RE.test(eposta) || eposta.length > 254) return fail(400, 'E-posta anlaşılamadı', 'bad_body');
  if (deps.sahipler.includes(eposta)) return fail(409, 'Bu e-posta Vercel’de sahip olarak tanımlı; panelden değiştirilmez ve kaldırılmaz', 'owner_fixed');
  return eposta;
}

async function uyeIslemi(yol: string, req: Request, deps: KontrolDeps, ben: KontrolOturumu, now: number): Promise<Response> {
  const body = await govde(req);
  if (body instanceof Response) return body;
  const eposta = uyeEpostasi(body, deps);
  if (eposta instanceof Response) return eposta;

  if (yol === 'uye-sil') {
    // Kayıt silinir: oturum en geç önbellek süresinde (bir dakika) düşer; yeniden davette parolasını baştan belirler
    await deps.redis('DEL', uyeKey(eposta), davetKey(eposta));
    await deps.redis('SREM', UYELER_KEY, eposta);
    deps.uyeDegisti?.(eposta);
    return json({ ok: true });
  }

  const rol = davetRolu(body.rol);
  if (!rol) return fail(400, 'Rol anlaşılamadı', 'bad_body');
  // Davet yalnız üyelik açıkken: üye girişi ortamdaki sahip e-postasıyla açılır
  if (yol === 'uye' && !deps.sahipler.length) return fail(409, 'Panele kişi eklemek için önce Vercel’de sahip e-postasını (LAFPOS_UYE_EPOSTA) tanımlayın', 'member_mode_off');
  const [rawUye, rawDavet] = ((await deps.redis('MGET', uyeKey(eposta), davetKey(eposta))) as unknown[] | null) ?? [];
  const kayit = parse<UyeKaydi>(rawUye);
  const davet = davetGecerli(rawDavet, now);

  if (yol === 'uye-rol') {
    if (kayit && davetRolu(kayit.rol)) {
      // Rol kayıttan okunur: oturum düşmez, yeni rol en geç bir dakikada geçer (XX: bu arada kaldırıldıysa yeniden açılmaz)
      if (kayit.rol !== rol) await deps.redis('SET', uyeKey(eposta), JSON.stringify({ ...kayit, rol }), 'XX');
      deps.uyeDegisti?.(eposta);
      return json({ ok: true });
    }
    if (davet) {
      // Davetin süresi uzamaz: kalan süreyle yeniden yazılır
      await deps.redis('SET', davetKey(eposta), JSON.stringify({ ...davet, rol }), 'EX', Math.max(1, Math.ceil((davet.at + DAVET_OMRU_MS - now) / 1000)), 'XX');
      return json({ ok: true });
    }
    return fail(404, 'Bu e-posta panelde yok', 'not_found');
  }

  if (kayit && davetRolu(kayit.rol)) return fail(409, 'Bu e-posta zaten panelde; rolünü değiştirebilir ya da kaldırabilirsiniz', 'member_exists');
  if (!davet && Number(await deps.redis('SCARD', UYELER_KEY)) >= UYE_EN_COK) return fail(409, `Panele en çok ${UYE_EN_COK} kişi eklenebilir; önce kullanılmayanları kaldırın`, 'too_many');
  // Rolsüz eski kayıt (ortamdan çıkarılmış sahip): davetle gelen kişi parolasını kodla yeniden belirler
  if (kayit) await deps.redis('DEL', uyeKey(eposta));
  const kod = davetKoduUret();
  const yeni: DavetKaydi = { kod: davetOzeti(kod), rol, at: now, kim: ben.eposta ?? 'parola' };
  // Yeniden davet eskisinin yerine geçer: önceki kod geçersiz olur
  await deps.redis('SET', davetKey(eposta), JSON.stringify(yeni), 'EX', Math.ceil(DAVET_OMRU_MS / 1000));
  await deps.redis('SADD', UYELER_KEY, eposta);
  deps.uyeDegisti?.(eposta);
  return json({ ok: true, kod, bitis: now + DAVET_OMRU_MS } satisfies DavetYaniti);
}

// ─── Komutlar ────────────────────────────────────────────────────────────────

async function komutEkle(req: Request, deps: KontrolDeps, ben: KontrolOturumu, now: number): Promise<Response> {
  if (ben.rol === 'izleyici') return fail(403, 'Yalnız görme yetkiniz var; değişiklik yapamazsınız', 'remote_readonly');
  const body = await govde(req);
  if (body instanceof Response) return body;
  const tur = typeof body.tur === 'string' && (KOMUT_TURLERI as readonly string[]).includes(body.tur) ? (body.tur as KomutKaydi['tur']) : null;
  if (!tur) return fail(400, 'Bilinmeyen işlem', 'bad_body');
  const id = await deps.dukkan();
  if (!KURULUM_RE.test(id)) return fail(409, 'Kasa Merkez’e bağlı değil', 'not_connected');

  // Kasanın son özeti: sürüm, desteklediği türler ve uzaktan yönetim açık mı
  const durum = parse<unknown>(await deps.redis('GET', durumKey(id)));
  if (durumGecerli(durum) && durum.v > KONTROL_SURUM) return fail(409, 'LafPOS Uzaktan bu kasa sürümünü henüz tanımıyor; site güncellenince yeniden deneyin', 'bulut_eski');
  if (!durumGecerli(durum) || !durum.turler.includes(tur)) return fail(409, 'Kasa güncel değil: önce Merkez’den güncelleme gönderin', 'kasa_eski');
  if (!durum.acik) return fail(409, 'Kasada uzaktan yönetim kapalı (kasada Yönetim › Ağ ve uzaktan erişim)', 'kontrol_kapali');

  const d = komutDogrula(tur, body.veri);
  if (!d.ok) return fail(400, d.hata, 'bad_body');
  const veri = d.veri as { id?: string; rol?: Role };

  // Rol kapısı: düzenleme ve PIN'de hedefin kasadaki rolü, eklemede ve rol değişiminde yeni rol
  const kisi = new Map((durum.personel as unknown[]).filter(isRecord).map((p): [string, KontrolPersonel] => [String(p.id), p as unknown as KontrolPersonel]));
  const hedef = d.tur === 'personel.duzenle' || d.tur === 'personel.pin' ? kisi.get(veri.id ?? '') : undefined;
  if ((d.tur === 'personel.duzenle' || d.tur === 'personel.pin') && !hedef && ben.rol !== 'sahip') {
    return fail(409, 'Bu personel kasanın son özetinde yok; özet güncellenince yeniden deneyin', 'unknown_target');
  }
  const hedefRoller = d.tur === 'personel.ekle' ? [veri.rol] : d.tur.startsWith('personel.') ? [hedef?.rol, veri.rol] : [];
  if (!uyeYapabilir(ben.rol, d.tur, hedefRoller)) {
    return fail(403, d.tur === 'rol.yetki' ? 'Rol yetkilerini yalnız sahip değiştirebilir' : d.tur === 'gun.sonu' ? 'Gün sonunu uzaktan yalnız sahip alır' : 'Patron hesabına yalnız sahip dokunabilir', 'not_allowed');
  }
  // Gün sonu yalnız kasa bağlıyken (son nabız Merkez'in "çevrimiçi" süresinde): çevrimdışı kasanın kuyruğunda bekleyen
  // istek saatler sonra o arada açılan günü kapatırdı. Kasa da eski ya da günü değişmiş isteği reddeder (inceleme, 23 Kas
  // 2026)
  if (d.tur === 'gun.sonu') {
    const [rawKurulum, rawNabiz] = ((await deps.redis('MGET', ...merkezKeys(id))) as unknown[] | null) ?? [];
    const son = kasaBilgisi(rawKurulum, rawNabiz)?.sonGorulme ?? null;
    if (son == null || now - son > ONLINE_MS) return fail(409, 'Kasa şu an çevrimdışı: gün sonu yalnız kasa bağlıyken uzaktan alınır. Kasa yeniden bağlanınca deneyin', 'kasa_cevrimdisi');
  }

  // Kuyruğun son payı sahibin: yönetici kuyruğu doldurup sahibin acil işlemini bekletemez
  const kuyrukSiniri = ben.rol === 'sahip' ? KUYRUK_EN_COK : KUYRUK_EN_COK - SAHIP_PAYI;
  if (Number(await deps.redis('HLEN', komutKey(id))) >= kuyrukSiniri) return fail(429, 'Kasaya giden kuyrukta çok işlem bekliyor; kasa bağlanınca yeniden deneyin', 'queue_full');
  const kim = ben.eposta ?? 'parola';
  const saat = Math.floor(now / 3600_000);
  const sayac = Number(await deps.redis('INCR', sayacKey(id, saat, kim)));
  if (sayac === 1) await deps.redis('EXPIRE', sayacKey(id, saat, kim), 7200);
  if (sayac > SAATLIK_EN_COK) return fail(429, 'Bu saat içinde çok işlem gönderildi; biraz sonra yeniden deneyin', 'rate_limited');

  // Özet kasadaki adlarla; ürün ya da seçeneğin adı istekten (yalnız bekleyen satırın metni için: doğrulanmaz, kasa
  // sonuçla kendi adını gönderir ve geçmişe o yazılır)
  const adlar: OzetAdlari = { personel: adHaritasi([...kisi].map(([pid, p]): [string, string] => [pid, String(p.ad)])) };
  const ad = typeof body.ad === 'string' ? ozetAdi(body.ad) : '';
  if (ad && veri.id && (d.tur === 'urun.satis' || d.tur === 'urun.gorunum' || d.tur === 'urun.gorsel' || d.tur === 'secenek.satis')) adlar[d.tur === 'secenek.satis' ? 'secenek' : 'urun'] = adHaritasi([[veri.id, ad]]);
  const temel = { id: `k_${randomBytes(18).toString('base64url')}`, tur: d.tur, veri: d.veri, at: now, kim, kurulum: id, rol: ben.rol };
  const kayit: KomutKaydi = { ...temel, ozet: komutOzeti(d.tur, d.veri, adlar), imza: komutImzasi(deps.secret, temel) };
  await deps.redis('HSET', komutKey(id), kayit.id, JSON.stringify(kayit));
  await deps.redis('SET', varKey(id), '1');
  // "Gün sonu al ve güncelle": Merkez'in "Şimdi güncelle"siyle aynı yol (hedef, gönderim anı ve istek), bu gün sonuna
  // bağlı: kasa güncellemeyi ancak gün sonu uygulanınca ister, reddedilen gün sonunun güncellemesi kurulmaya kalkmaz
  if (d.tur === 'gun.sonu' && body.guncelle === true) await deps.guncelleIste?.(id, now, kayit.id);
  return json({ ok: true, komut: satir(kayit) } satisfies KomutYaniti);
}

async function komutIptal(req: Request, deps: KontrolDeps, ben: KontrolOturumu, now: number): Promise<Response> {
  if (ben.rol === 'izleyici') return fail(403, 'Yalnız görme yetkiniz var; değişiklik yapamazsınız', 'remote_readonly');
  const body = await govde(req);
  if (body instanceof Response) return body;
  const komutId = typeof body.id === 'string' ? body.id : '';
  if (!KOMUT_ID_RE.test(komutId)) return fail(400, 'İşlem anlaşılamadı', 'bad_body');
  const id = await deps.dukkan();
  if (!KURULUM_RE.test(id)) return fail(409, 'Kasa Merkez’e bağlı değil', 'not_connected');
  const yok = () => fail(404, 'Bu işlem artık kuyrukta değil; kasa uygulamış ya da iptal edilmiş olabilir', 'not_found');
  const kayit = parse<KomutKaydi>(await deps.redis('HGET', komutKey(id), komutId));
  if (!komutMu(kayit)) return yok();
  if (ben.rol !== 'sahip' && kayit.kim !== ben.eposta) return fail(403, 'Başkasının gönderdiği işlemi yalnız sahip iptal edebilir', 'not_allowed');
  // Kasaya gitmiş komut iptal edilmez: kasa uygular ve sonucu bildirir (panel "iptal" deyip kasa uygulamış olmasın)
  const gitti = async () => {
    const teslim = Number(await deps.redis('GET', teslimKey(id)));
    return teslim > 0 && kayit.at <= teslim;
  };
  const gonderildi = () => fail(409, 'Bu işlem kasaya gönderildi; artık iptal edilemez, sonucu birazdan görünür', 'delivered');
  if (await gitti()) return gonderildi();
  if (Number(await deps.redis('HDEL', komutKey(id), komutId)) < 1) return yok();
  // Nabız teslim anını kuyruğu okumadan önce yazar: silmeden sonra yeniden bakılır. Arada nabız komutu okuduysa kasaya
  // gitmiştir; kayıt geri konur (sonucu geçmişe yazılsın), iptal edilmez
  if (await gitti()) {
    await deps.redis('HSET', komutKey(id), kayit.id, JSON.stringify(kayit));
    await deps.redis('SET', varKey(id), '1');
    return gonderildi();
  }
  const row = satir(kayit, 'iptal', ben.eposta ? `İptal eden: ${ben.eposta}` : 'Sahip iptal etti', now);
  await gecmiseYaz(deps.redis, id, [row]);
  // "Gün sonu al ve güncelle"de güncelleme isteği bu gün sonuna bağlı: gün sonu gitmeyince istek de geri alınır. Yoksa
  // Merkez 30 dakika "Güncelleme istendi" deyip "Şimdi güncelle"yi kapalı tutuyor, kasa da kayda "kasaya ulaşmadı"
  // yazıyordu (inceleme, 23 Kas 2026)
  if (kayit.tur === 'gun.sonu') await deps.guncelleBirak?.(id, kayit.id);
  if (Number(await deps.redis('HLEN', komutKey(id))) === 0) await isaretTemizle(deps.redis, id);
  return json({ ok: true, komut: row } satisfies KomutYaniti);
}

/** Merkez'in bildiği kasa (kurulum kaydı ve nabzı): son görülme ve sürüm; Merkez'de yoksa null */
function kasaBilgisi(rawKurulum: unknown, rawNabiz: unknown): KontrolPaneli['kasa'] {
  const kurulum = parse<Record<string, unknown>>(rawKurulum);
  if (!kurulum) return null;
  const v = { ...kurulum, ...(parse<Record<string, unknown>>(rawNabiz) ?? {}) };
  return {
    sonGorulme: num(v.lastSeen),
    surum: typeof v.surum === 'string' ? v.surum : null,
    build: Number.isInteger(v.build) ? (v.build as number) : null,
    gunAcik: typeof v.gunAcik === 'boolean' ? v.gunAcik : null,
  };
}

/**
 * Panele giden özet: açık anahtar yalnız kasanın imzası (anahtarImza) tutarsa verilir, yoksa boş (arayüz PIN işlemlerini
 * kapatır, kasa bir sonraki özetinde imzalı anahtarı yeniden gönderir). İmzanın kendisi panele gitmez
 */
function panelDurumu(raw: unknown, secret: string, kurulum: string): KontrolDurumu | null {
  const d = parse<unknown>(raw);
  if (!durumGecerli(d)) return null;
  const { anahtarImza: _imza, ...rest } = d;
  return { ...rest, anahtar: anahtarTutar(secret, kurulum, d) ? d.anahtar : '' };
}

async function panelVerisi(deps: KontrolDeps, ben: KontrolOturumu): Promise<KontrolPaneli> {
  const id = await deps.dukkan();
  if (!KURULUM_RE.test(id)) return { ben, durum: null, bekleyen: [], gecmis: [], kasa: null };
  // Özet, kuyruk işareti ve Merkez'in kaydı tek MGET'te; kuyruk yalnız işaret varsa okunur (işaret kuyrukla birlikte
  // tutulur: isaretTemizle)
  const [rawDurum, rawVar, rawKurulum, rawNabiz] = ((await deps.redis('MGET', durumKey(id), varKey(id), ...merkezKeys(id))) as unknown[] | null) ?? [];
  const gecmis = gecmisOku(await deps.redis('LRANGE', gecmisKey(id), 0, GECMIS_EN_COK - 1));
  const bekleyen = rawVar != null ? (await kuyruk(deps.redis, id)).map((k) => satir(k)) : [];
  return { ben, durum: panelDurumu(rawDurum, deps.secret, id), bekleyen, gecmis, kasa: kasaBilgisi(rawKurulum, rawNabiz) };
}

// ─── Uçlar ───────────────────────────────────────────────────────────────────

const GET_UCLARI = ['durum', 'uyeler'];
const POST_UCLARI = ['komut', 'iptal', 'uye', 'uye-rol', 'uye-sil'];

export async function kontrol(req: Request, _url: URL, path: string, deps: KontrolDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();
  const yol = path.replace(/^kontrol\//, '');
  const get = req.method === 'GET' && GET_UCLARI.includes(yol);
  const post = req.method === 'POST' && POST_UCLARI.includes(yol);
  if (!get && !post) return fail(404, 'Uzaktan yönetimde böyle bir uç yok', 'not_found');

  // Kafe bağlanmadan: örnek gün ve örnek üyeler, işlem yok
  if (deps.demo) {
    if (post) return fail(403, 'Örnek görünümde değişiklik yapılmaz', 'remote_readonly');
    return json(yol === 'durum' ? demoPanel(now) : { uyeler: demoUyeler(now) });
  }
  if (!(deps.secret.length >= 32)) return fail(503, 'LafPOS Uzaktan kurulmamış (LAFPOS_CLOUD_SECRET)', 'not_configured');
  const ben = await deps.oturum();
  if (!ben) {
    if (await deps.gorunum?.()) return fail(403, 'Uzaktan yönetim için üye girişi gerekir', 'remote_admin');
    return fail(401, 'Oturum kapalı. Yeniden girin', 'unauthorized');
  }

  if (yol === 'durum') return json(await panelVerisi(deps, ben));
  if (yol === 'komut') return komutEkle(req, deps, ben, now);
  if (yol === 'iptal') return komutIptal(req, deps, ben, now);
  // Panele kimin gireceğini yalnız sahip belirler
  if (ben.rol !== 'sahip') return fail(403, 'Panel erişimini yalnız sahip yönetir', 'not_allowed');
  if (yol === 'uyeler') return json({ uyeler: await uyeListesi(deps, now) });
  return uyeIslemi(yol, req, deps, ben, now);
}

// ─── Merkez nabzı: kasaya teslim ve sonuç ────────────────────────────────────

/** Merkez nabzının tek MGET'ine eklenen anahtarlar: kuyruk işareti, özetin parmak izi, son teslim */
export const nabizAnahtarlari = (id: string) => [varKey(id), ozetKey(id), teslimKey(id)];

function sonuclariOku(v: unknown, now: number): KomutSonucu[] {
  if (!Array.isArray(v)) return [];
  const seen = new Set<string>();
  const out: KomutSonucu[] = [];
  for (const s of v.slice(0, SONUC_EN_COK)) {
    if (!isRecord(s) || typeof s.id !== 'string' || !KOMUT_ID_RE.test(s.id) || seen.has(s.id)) continue;
    const durum: SonucDurumu | null = s.durum === 'uygulandi' ? 'uygulandi' : s.durum === 'reddedildi' ? 'reddedildi' : null;
    if (!durum) continue;
    seen.add(s.id);
    // Kasanın saati: makul değilse bulutun saati
    const at = Number.isInteger(s.at) && (s.at as number) > 0 && (s.at as number) <= now + SAAT_PAYI_MS ? (s.at as number) : now;
    // Kasanın kendi adlarıyla özeti (yeni kasa): tek satır, kısa
    const ozet = typeof s.ozet === 'string' ? s.ozet.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 200) : '';
    out.push({ id: s.id, durum, mesaj: typeof s.mesaj === 'string' ? s.mesaj.trim().slice(0, 300) : '', at, ...(ozet ? { ozet } : {}) });
  }
  return out;
}

/**
 * Nabızdaki `kontrol` (kasa → bulut; yoksa null, yanıtta alan olmaz): sonuçlar geçmişe geçer ve komut kuyruktan silinir
 * (bilinmeyen kimlik yok sayılır), kasanın özeti değiştiyse saklanır (parmak izini bulut kendisi hesaplar), yanıt kasanın
 * uygulayacağı komutları ve özet isteğini taşır. `onceden`: nabzın MGET'inde okunan `nabizAnahtarlari` değerleri
 * (ek okuma yok); kuyruk yalnız işaret varsa okunur, yazım yalnız değişince
 */
export async function nabizKontrol(redis: Redis, id: string, istek: unknown, onceden: unknown[], now: number): Promise<NabizKontrolYaniti | null> {
  if (!isRecord(istek)) return null;
  const [rawVar, rawOzet, rawTeslim] = onceden;
  let ozet = typeof rawOzet === 'string' ? rawOzet : null;
  let kuyrukVar = rawVar != null;

  const sonuclar = sonuclariOku(istek.sonuclar, now);
  if (sonuclar.length) {
    const raws = await redis('HMGET', komutKey(id), ...sonuclar.map((s) => s.id));
    const satirlar: KontrolGecmisi[] = [];
    sonuclar.forEach((s, i) => {
      const k = parse<KomutKaydi>(Array.isArray(raws) ? raws[i] : null);
      if (komutMu(k) && k.id === s.id) satirlar.push(satir(k, s.durum, s.mesaj || null, s.at, s.ozet));
    });
    if (satirlar.length) {
      await gecmiseYaz(redis, id, satirlar);
      await redis('HDEL', komutKey(id), ...satirlar.map((r) => r.id));
      kuyrukVar = true;
    }
  }

  const d = istek.durum;
  if (d !== undefined && durumGecerli(d) && Buffer.byteLength(JSON.stringify(d)) <= DURUM_EN_COK) {
    const iz = durumParmakIzi(d);
    if (iz !== ozet) {
      await redis('SET', durumKey(id), JSON.stringify(durumTemiz(d)));
      await redis('SET', ozetKey(id), iz);
      ozet = iz;
    }
  }

  let komutlar: KomutKaydi[] = [];
  if (kuyrukVar) {
    // Teslim anı kuyruk okunmadan ÖNCE yazılır: iptal ile nabız yarışırsa iptal ya komutu nabızdan önce siler ya da
    // silmeden sonra teslimi görüp komutu geri koyar (komutIptal). Okunan komutlar bu andan eski ya da payın içinde
    const teslim = Math.max(now, Date.now()) + TESLIM_PAYI_MS;
    if (!(Number(rawTeslim) >= teslim)) await redis('SET', teslimKey(id), String(teslim));
    komutlar = (await kuyruk(redis, id)).slice(0, KUYRUK_EN_COK);
    if (!komutlar.length) await isaretTemizle(redis, id);
    else {
      // Saat farkıyla teslim anından yeni görünen komut: teslim onun anına ilerler
      const son = Math.max(...komutlar.map((k) => k.at));
      if (son > teslim) await redis('SET', teslimKey(id), String(son));
    }
  }
  return { durumIste: !ozet || ozet !== istek.ozet, komutlar };
}

// ─── Örnek görünüm (kafe bağlanmadan) ────────────────────────────────────────

/** Örnek kasanın açık anahtarı: gerçek bir RSA-2048 SPKI (özel anahtarı atıldı; örnekte PIN zaten gönderilmez) */
const DEMO_ANAHTAR =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEArLXw3k819cYdnz4YpZf2ld6drTg35RD4EwDT1Z/YYFdRcSKYOGy2zzTeaOGgcEyM+L2qhSm/hplPOGNWF6kFf1lvo1u1lXyO1lN5778r914oJRc5LYVR7Gga3RdVtFfTYoOFOOJUFFVYaxZ0wZ+AkDt7jYG1xjPcUHuXS4kkAaWHz+NxDuUxk8O3f48Hny7nKE1XqqX7zg+zqCub9Ea60+PKA7rsCWfyd7/66BIwxWZoCTjuQf0eaqfeJw4Vrvqj7TGR8SzthKXpE8rbdrBgBIysYBT/uYM832XbBIca+RU8Z8vqR2z5ygROuVXHHQEg9bPbIpZTtti/W0oHZu0SZQIDAQAB';
const DEMO_SAHIP = 'sahip@ornek.example';
const DEMO_MUDUR = 'mudur@ornek.example';

function demoPanel(now: number): KontrolPaneli {
  const dk = 60_000;
  const personel: KontrolPersonel[] = [
    { id: 'ornek-patron', ad: 'Elif Yılmaz', rol: 'patron', renk: '#1f3d2b', aktif: true, indirim: 100, sonGiris: now - 20 * 60 * dk },
    { id: 'ornek-mudur', ad: 'Burak Demir', rol: 'mudur', renk: '#2f6b4f', aktif: true, indirim: 30, sonGiris: now - 4 * 60 * dk },
    { id: 'ornek-kasa-1', ad: 'Zeynep Aksoy', rol: 'kasiyer', renk: '#c2703d', aktif: true, indirim: 10, sonGiris: now - 35 * dk },
    { id: 'ornek-kasa-2', ad: 'Can Öztürk', rol: 'kasiyer', renk: '#3d6fc2', aktif: true, indirim: 10, sonGiris: now - 95 * dk },
    { id: 'ornek-garson', ad: 'Ayşe Şahin', rol: 'garson', renk: '#8a4fb3', aktif: true, indirim: 0, sonGiris: now - 12 * dk },
  ];
  const roller: KontrolRol[] = ROLES.map((rol) => ({ rol, izinler: [...ROLE_DEFAULTS[rol]], ozel: false, kisi: personel.filter((p) => p.aktif && p.rol === rol).length }));
  const adlar: OzetAdlari = { personel: Object.fromEntries(personel.map((p) => [p.id, p.ad])), urun: { 'ornek-limonata': 'Ev yapımı limonata' } };
  const row = (id: string, tur: KontrolGecmisi['tur'], ozet: string, kim: string, at: number, durum: GecmisDurumu, mesaj: string | null, bitti: number | null): KontrolGecmisi => ({
    id: `k_ornek${id.padStart(15, '0')}`,
    tur,
    ozet,
    kim,
    at,
    durum,
    mesaj,
    bitti,
  });
  return {
    ben: { eposta: DEMO_SAHIP, rol: 'sahip' },
    durum: {
      v: KONTROL_SURUM,
      at: now - 3 * dk,
      acik: true,
      turler: [...KOMUT_TURLERI],
      anahtar: DEMO_ANAHTAR,
      personel,
      roller,
      servisModu: 'masa',
    },
    bekleyen: [row('5', 'urun.satis', komutOzeti('urun.satis', { id: 'ornek-limonata', satista: false }, adlar), DEMO_MUDUR, now - 2 * dk, 'bekliyor', null, null)],
    gecmis: [
      row('4', 'personel.pin', komutOzeti('personel.pin', { id: 'ornek-kasa-1', pin: '' }, adlar), DEMO_SAHIP, now - 50 * dk, 'uygulandi', null, now - 47 * dk),
      row('3', 'personel.duzenle', komutOzeti('personel.duzenle', { id: 'ornek-kasa-2', indirim: 15 }, adlar), DEMO_MUDUR, now - 3 * 60 * dk, 'uygulandi', null, now - 178 * dk),
      row('2', 'personel.ekle', komutOzeti('personel.ekle', { ad: 'Deniz Kara', rol: 'garson', pin: '' }, adlar), DEMO_MUDUR, now - 26 * 60 * dk, 'reddedildi', 'Bu PIN başka bir personelde kayıtlı; başka bir PIN seçin', now - 26 * 60 * dk + 4 * dk),
      row('1', 'ayar.servis', komutOzeti('ayar.servis', { mod: 'masa' }, adlar), DEMO_SAHIP, now - 3 * 1440 * dk, 'uygulandi', null, now - 3 * 1440 * dk + 5 * dk),
    ],
    kasa: { sonGorulme: now - 2 * dk, surum: '0.3.0', build: null, gunAcik: true },
    demo: true,
  };
}

function demoUyeler(now: number): UzaktanUye[] {
  const gun = 86_400_000;
  return [
    { eposta: DEMO_SAHIP, rol: 'sahip', durum: 'aktif', sabit: true, at: now - 40 * gun, davetBitis: null },
    { eposta: DEMO_MUDUR, rol: 'yonetici', durum: 'aktif', sabit: false, at: now - 12 * gun, davetBitis: null },
    { eposta: 'muhasebe@ornek.example', rol: 'izleyici', durum: 'davet', sabit: false, at: now - 2 * gun, davetBitis: now - 2 * gun + DAVET_OMRU_MS },
  ];
}
