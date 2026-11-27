import { createHash, randomBytes } from 'node:crypto';
import { GUN_SONU_OMRU_MS, HIZLI_NABIZ_MS, HIZLI_SURE_MS, KOMUT_ID_RE, type NabizKontrol, type SonucDurumu } from '@shared/kontrol';
import { GECMIS_KEY, type HistoryDay } from '@shared/gecmis';
import { type LicenseRecord, type LicenseView, licenseState, normalizeBranchCode, salesAllowed } from '@shared/lisans';
import { REMOTE_SHOP } from '@shared/remote-reports';
import { db, tx } from '../db/client';
import { env } from '../env';
import { getOpenDay } from '../services/orders';
import { Effects } from '../lib/effects';
import { HttpError } from '../lib/http';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { subeEtiketi } from '@shared/baglanti';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { ESKI_VARSAYILAN_SUBE, kasaSubesi } from '../lib/sube';
import { installedVersion, readUpdateStatus, UPDATE_CHOICE_KEY, type UpdateChoiceRecord, writeUpdateRequest } from '../lib/surum';
import { underBekci } from './yedek';

/**
 * Merkez (docs/KALANLAR.md, docs/07-UZAKTAN-ERISIM.md §4 "Merkez"): kurulum ilk açılışta kimlik ve gizli anahtar
 * üretir; internete ilk çıktığında Merkez'e kendini bildirir (ilk görüşte güven, dükkânda kimse anahtar girmez), sonra
 * 5 dakikada bir imzalı nabız: sürüm, güncelleme durumu, gün açık mı. Yanıt lisans kaydı (bitiş tarihiyle), şube kodu,
 * çalıştırılacak derleme ve sahibin "Şimdi güncelle" isteği. Uzaktan'dan kasaya giden her şey bu yanıtla gelir: ayrı
 * istek ve ayrı zamanlayıcı yok (AGENTS.md kural 6'daki bütçe).
 *
 * Son yanıt saklanır: internet ya da Merkez yokken kasa son geçerli kayıtla ve kendi saatiyle çalışır. Merkez adresi
 * yoksa (ASILPOS_MERKEZ_URL ya da ASILPOS_CLOUD_URL tanımsız, ya da ASILPOS_MERKEZ_URL=0) lisans uygulanmaz ve
 * güncelleyici eskisi gibi kanalın son sürümünü izler.
 *
 * Uzaktan yönetim (docs/UZAKTAN-YONETIM.md, sync/kontrol.ts) de bu nabızla gider: istekte yönetim özetinin parmak izi
 * (gerekince özet ve sonuçlar), yanıtta komutlar. Komut uygulanınca ya da bulut özeti isteyince hemen bir nabız daha
 * (sonuç beklemesin); komut geldikten sonra 10 dakika dakikada bir nabız, sonra yine 5 dakikada bir.
 */
export const MERKEZ_BEAT_MS = 5 * 60_000;
const IDENTITY = 'merkez.kimlik';
const LAST = 'merkez.son';
/** Kasanın işlediği son "Şimdi güncelle" isteği (Merkez'in verdiği an): aynı istek iki kez işlenmez */
const HANDLED_REQUEST = 'merkez.istek';

export interface Identity {
  id: string;
  key: string;
  createdAt: number;
  registered: boolean;
  /**
   * Merkez'e bir kez kaydoldu: kayıt sonradan silinse (404) de kimlik değişmez. Uzaktan özeti, raporlar ve bulut
   * yedekleri bu kimlikle (remoteShop) yazılır; kimlik değişseydi dükkân ikiye bölünür, lisans "bekliyor"a dönerdi
   */
  everRegistered?: boolean;
}

export interface MerkezLast {
  ad: string | null;
  lisans: LicenseRecord;
  mod: 'elle' | 'otomatik';
  /** Merkez'in söylediği derleme; null: Merkez henüz göndermedi (kurulu sürüm kalır) */
  hedef: number | null;
  /** Sahibin verdiği şube kodu ("MRN"); yoksa null (eski kayıtlarda alan yok) */
  kod?: string | null;
  /** Sahibin Uzaktan'dan son "Şimdi güncelle" isteği (Merkez'deki an); yoksa null */
  guncelleIstek?: number | null;
  /** İsteğin bağlı olduğu uzaktan gün sonunun komut kimliği ("Gün sonu al ve güncelle"); Merkez'in düğmesinde null */
  guncelleKomut?: string | null;
  /** Son başarılı nabzın anı: lisans kaydının Merkez'den alındığı an */
  at: number;
}

/** Merkez açık: adres ve kafenin ortak anahtarı (kayıt onunla imzalı; anahtarsız kasada lisans uygulanmaz) */
export const merkezEnabled = () => !!env.merkezUrl && env.cloudSecret.length >= MIN_SECRET_LENGTH;

/**
 * Merkez kapalıyken (ASILPOS_MERKEZ_URL=0) AsilPOS Uzaktan özeti, raporları ve bulut yedeklerini bütün kasaların ortak
 * `default` dükkânına yazar (`remoteShop`). Tek kasada sorun yok; birden çok şubenin kasası varken şubeler birbirinin
 * raporunu ve yedeğini ezer. İlk kasa Marina'nınki: şubesi başka olan kasa ikinci şubedir, Merkez kapalıysa uyarı
 * (Yönetim › Bağlantı bilgileri). Uzaktan kurulu değilse buluta bir şey gitmez, uyarı yok
 */
export function merkezKapaliUyarisi(): string | null {
  if (merkezEnabled() || !env.cloudUrl || env.cloudSecret.length < MIN_SECRET_LENGTH) return null;
  const sube = kasaSubesi();
  if (!sube || sube === ESKI_VARSAYILAN_SUBE) return null;
  return 'Merkez kapalı (ASILPOS_MERKEZ_URL=0): AsilPOS Uzaktan bu kasanın özetini, raporlarını ve bulut yedeklerini bütün kasaların ortak "default" dükkânına yazar. Birden çok şubenin kasası varken şubeler birbirinin raporunu ve yedeğini ezer; ayarlar dosyasından ASILPOS_MERKEZ_URL=0 satırını kaldırın';
}

/** Kurulum kimliği anahtarın özetidir (api/_merkez.ts installIdFor ile aynı): kimliği bilen başkası onu kaydedemez */
export const installIdFor = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/**
 * Kurulum kimliği: ilk okumada üretilir ve hep aynı kalır (yedekten dönüşte de; gün sonu verisiyle birlikte). Hiç
 * kaydolmamış eski (rastgele) kimlik anahtardan türeyen kimliğe geçer; bir kez kaydolmuş eski kimlik, kaydı Merkez'de
 * silinse de kalır (Merkez mezar taşıyla aynı kimliği yeniden kaydeder)
 */
export function identity(now = Date.now()): Identity {
  const existing = getSyncState<Identity>(IDENTITY);
  if (existing?.id && existing.key) {
    if (existing.registered || existing.everRegistered || existing.id === installIdFor(existing.key)) return existing;
    const migrated = { ...existing, id: installIdFor(existing.key) };
    setSyncState(IDENTITY, migrated);
    return migrated;
  }
  const key = randomBytes(32).toString('base64url');
  const fresh: Identity = { id: installIdFor(key), key, createdAt: now, registered: false };
  setSyncState(IDENTITY, fresh);
  return fresh;
}

export const merkezLast = () => getSyncState<MerkezLast>(LAST);

/**
 * Uzaktan özet ve raporların dükkân kimliği: Merkez'e bağlı kasada kurulum kimliği, değilse `default` (eski anahtarlar).
 * Kimlik değişince rapor gönderimi geçmişi baştan iter (server/sync/cloud-reports.ts)
 */
export const remoteShop = () => (merkezEnabled() ? identity().id : REMOTE_SHOP);

/**
 * Kasanın şimdiki lisans durumu; Merkez kapalıysa null (uygulanmaz). Son başarılı nabzın anı onay anıdır: kasa Merkez'e
 * 15 dakikadır ulaşamıyorsa süresi dolmuş lisans yalnız uyarı olur, satış kapanmaz (shared/lisans.ts, çevrimdışı kural)
 */
export function licenseNow(now = Date.now()): LicenseView | null {
  if (!merkezEnabled()) return null;
  const last = merkezLast();
  return licenseState(last?.lisans, { installedAt: identity(now).createdAt, now, confirmedAt: last?.at ?? null });
}

/** Fişin başlığındaki şube: Merkez'deki dükkân adı ve şube kodu; Merkez kapalıysa ya da ikisi de yoksa null */
export function merkezBranch(): { name: string | null; code: string | null } | null {
  if (!merkezEnabled()) return null;
  const last = merkezLast();
  const name = last?.ad ?? null;
  const code = last?.kod ?? null;
  return name || code ? { name, code } : null;
}

/**
 * Yeni satış (adisyon açma, kalem ekleme) öncesi: lisans kapalıysa durur. Tahsilat, kayıtlar ve raporlar açık; kasa
 * Merkez'e ulaşamıyorsa hiç durmaz (licenseNow)
 */
export function assertCanSell(now = Date.now()) {
  const lic = licenseNow(now);
  if (lic && !salesAllowed(lic)) throw new HttpError(403, `${lic.message}. Lisans için işletme sahibiyle görüşün`, 'license_blocked');
}

/** Güncelleyicinin sorusu (yalnız bu bilgisayardan): Merkez açık mı ve hangi derleme çalıştırılacak */
export function merkezTarget(): { enabled: boolean; hedef: number | null } {
  if (!merkezEnabled()) return { enabled: false, hedef: null };
  return { enabled: true, hedef: merkezLast()?.hedef ?? null };
}

let lastError: string | null = null;
let lastOk: number | null = null;
export const merkezSyncState = () => ({ enabled: merkezEnabled(), lastOk, lastError, id: merkezEnabled() ? identity().id : null });

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object';

/** Nabzın yanıtı → saklanan kayıt (beklenmeyen alan düşer; lisans okunamazsa eski kayıt kalır) */
/** Merkez'den gelen geçmiş ciro (AsilPOS öncesi günler): kasa kendi patron panelinin kıyaslarına katar (reports.ts) */
export function takeHistory(json: unknown) {
  if (!isRecord(json) || !('gecmis' in json)) return;
  const g = json.gecmis;
  // Silindi: boş kayıt (anı 0; Merkez'de kayıt yokken yeniden gönderilmez)
  if (g === null) {
    setSyncState(GECMIS_KEY, { at: 0, gunler: [] });
    return;
  }
  if (!isRecord(g) || !Number.isInteger(g.at) || !Array.isArray(g.gunler)) return;
  const ok = (d: unknown): d is HistoryDay =>
    isRecord(d) && typeof d.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && Number.isInteger(d.ciro) && Number.isInteger(d.adisyon) && Array.isArray(d.closes) && Array.isArray(d.pay);
  const gunler = g.gunler.filter(ok).slice(0, 800);
  // Kaynağın adı ("ModPOS"): kasanın Raporlar'ı günleri onunla etiketler; eski Merkez göndermez
  const kaynak = typeof g.kaynak === 'string' && g.kaynak.trim() ? g.kaynak.trim().slice(0, 40) : null;
  setSyncState(GECMIS_KEY, { at: g.at as number, gunler, ...(kaynak ? { kaynak } : {}) });
}

/**
 * Nabızda söylenen geçmiş ciro anı: elimizdeki kayıt kaynağın adını taşımıyorsa (bu sürümden önce alınmış) -1 söylenir.
 * -1 hiçbir kaydın anına ve "kayıt yok"un 0'ına eşit değildir: Merkez kaydı bir kez adıyla yeniden gönderir, kayıt
 * Merkez'de silinmişse silindi (null) der. 0 söylense silinmiş kaydın adsız kopyası kasada kalırdı
 */
const HISTORY_AT_UNNAMED = -1;
export function historyAtForBeat(): number {
  const g = getSyncState<{ at?: number; kaynak?: string; gunler?: unknown[] }>(GECMIS_KEY);
  return g?.gunler?.length && !g.kaynak ? HISTORY_AT_UNNAMED : (g?.at ?? 0);
}

export function parseBeat(json: unknown, now: number): MerkezLast | null {
  if (!isRecord(json) || json.ok !== true || !isRecord(json.lisans)) return null;
  const l = json.lisans;
  if (l.durum !== 'bekliyor' && l.durum !== 'aktif' && l.durum !== 'pasif') return null;
  const lisans: LicenseRecord = { durum: l.durum };
  if (typeof l.bitis === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(l.bitis)) lisans.bitis = l.bitis;
  if (Number.isFinite(l.pasifAt)) lisans.pasifAt = l.pasifAt as number;
  return {
    ad: typeof json.ad === 'string' ? json.ad.slice(0, 60) : null,
    lisans,
    mod: json.mod === 'otomatik' ? 'otomatik' : 'elle',
    hedef: Number.isInteger(json.hedef) && (json.hedef as number) > 0 ? (json.hedef as number) : null,
    kod: normalizeBranchCode(json.kod) ?? null,
    guncelleIstek: Number.isInteger(json.guncelleIstek) && (json.guncelleIstek as number) > 0 ? (json.guncelleIstek as number) : null,
    guncelleKomut: typeof json.guncelleKomut === 'string' && KOMUT_ID_RE.test(json.guncelleKomut) ? json.guncelleKomut : null,
    at: now,
  };
}

/**
 * Bekleyen yeni sürüm için geçerli seçim. Kasada yapılan seçim (Şimdi / Gün sonunda) önce gelir. Seçim yoksa ve sürümü
 * sahip Merkez'den gönderdiyse (Merkez'in hedefi bu derleme ya da daha yenisi: "Güncelleme gönder", "Şimdi güncelle",
 * otomatik mod) kasiyere sorulmaz: gün sonunda kurulur (gün zaten kapalıysa güncelleyici hemen kurar, guncelle.mjs
 * installDecision). Kasadaki "Şimdi güncelle" (gün açıkken hemen kur, `simdi: true`) değişmez. Seçim yoksa null (kasada
 * sorulur: Merkez kapalı ya da sürüm Merkez'den gönderilmedi)
 */
export function effectiveUpdateChoice(yeni: { build: number } | null | undefined): { secim: UpdateChoiceRecord['secim']; kaynak: 'kasa' | 'merkez' } | null {
  if (!yeni) return null;
  const choice = getSyncState<UpdateChoiceRecord>(UPDATE_CHOICE_KEY);
  if (choice?.build === yeni.build) return { secim: choice.secim, kaynak: 'kasa' };
  const hedef = merkezEnabled() ? (merkezLast()?.hedef ?? null) : null;
  if (hedef != null && yeni.build <= hedef) return { secim: 'gunsonu', kaynak: 'merkez' };
  return null;
}

/**
 * Sahibin Uzaktan › Merkez'den "Şimdi güncelle" isteği (nabzın yanıtında `guncelleIstek`): kasadaki "Şimdi güncelle"
 * düğmesinin yazdığı isteğin aynısını yazar (guncelleme/istek.json; bekçi alır, güncelleyici hemen denetler ve
 * indirir). Uzaktan istek hiçbir zaman gün açıkken kurdurmaz (`simdi: false`): yeni sürüm gün kapalıysa hemen, açıksa
 * gün sonundan sonra kurulur (guncelle.mjs installDecision). Her istek bir kez işlenir ve denetim kaydına yazılır;
 * Windows güncelleyicisi olmayan kurulumda istek yazılmaz, kayıt bunu söyler. Dönüş: işlendiyse true.
 *
 * `gunSonu`: isteğin bağlı olduğu uzaktan gün sonu ve kasadaki sonucu ("Gün sonu al ve güncelle"; sync/kontrol.ts
 * komutDurumu). Güncelleme ancak o gün sonu uygulandıysa istenir; gün sonu henüz gelmediyse `GUN_SONU_OMRU_MS` boyunca
 * beklenir. Reddedildiyse (açık adisyon, eski istek) ya da o sürede gelmediyse istek güncelleme başlatmadan kapanır ve
 * kayda düşer: reddedilen gün sonunun güncellemesi istenmiş kalmıyordu (inceleme, 23 Kas 2026). Merkez'in gönderdiği
 * hedef geçerli kalır: sürüm olağan denetimle gün kapanınca kurulur. Kasaya gitmeden iptal edilen gün sonunun isteğini
 * bulut geri alır (api/_merkez.ts withdrawLinkedUpdate); kasa gün sonunu hiç görmediyse nedenini bilemez, kayıt "kasada
 * uygulanmadı (iptal edildi ya da kasaya ulaşmadı)" der
 */
export function takeRemoteUpdate(istek: number | null | undefined, now = Date.now(), gunSonu: { komut: string; durum: SonucDurumu | null } | null = null): boolean {
  if (!istek || getSyncState<number>(HANDLED_REQUEST) === istek) return false;
  const kalmadi = !!gunSonu && gunSonu.durum !== 'uygulandi';
  if (kalmadi && gunSonu.durum == null && now - istek < GUN_SONU_OMRU_MS) return false;
  const can = !kalmadi && underBekci();
  const fx = new Effects();
  tx((t) => {
    setSyncState(HANDLED_REQUEST, istek);
    fx.audit(t, {
      action: 'guncelleme',
      entity: 'merkez',
      message: kalmadi
        ? `Merkez'den (AsilPOS Uzaktan) gün sonuyla birlikte istenen güncelleme başlatılmadı: uzaktan gün sonu ${gunSonu.durum ? 'reddedildi' : 'kasada uygulanmadı (iptal edildi ya da kasaya ulaşmadı)'}`
        : can
          ? "Merkez'den (AsilPOS Uzaktan) güncelleme istendi: yeni sürüm denetleniyor, gün kapalıyken kurulur"
          : "Merkez'den (AsilPOS Uzaktan) güncelleme istendi; bu kurulumda otomatik güncelleyici yok, sunucu elle güncellenir",
      data: { kaynak: 'merkez', istek, ...(gunSonu ? { komut: gunSonu.komut, gunSonu: gunSonu.durum } : {}) },
    });
  });
  if (can) writeUpdateRequest({ at: now, by: 'merkez', simdi: false });
  if (can) fx.emit({ topic: 'settings', kind: 'guncelleme', message: 'Güncelleme denetleniyor' });
  fx.flush();
  return true;
}

// ─── Uzaktan yönetim nabzı ───────────────────────────────────────────────────

type KontrolModulu = typeof import('./kontrol');

/** Bulut son yanıtta özeti istedi: sonraki nabız özeti gönderir (nabız gitmezse istek kalır) */
let durumIstendi = false;
/** Son nabzın anı ve hızlı nabzın bitişi (komut gelince 10 dakika dakikada bir) */
let sonNabiz = 0;
let hizliBitis = 0;
let nabizSuruyor = false;

/**
 * Nabza eklenecek yönetim kısmı. Modül yalnız Merkez açıkken tembel yüklenir (tarayıcı demosunda RSA yok, Merkez de
 * hiç açılmaz). Özet hazırlanamazsa nabız kontrolsüz gider: lisans ve güncelleme beklemez
 */
async function kontrolNabzi(now: number): Promise<{ k: KontrolModulu; giden: NabizKontrol } | null> {
  try {
    const k = await import('./kontrol');
    return { k, giden: k.nabizKontrol(durumIstendi, now) };
  } catch (e) {
    console.warn('[merkez] uzaktan yönetim özeti hazırlanamadı:', e instanceof Error ? e.message : String(e));
    return null;
  }
}

/**
 * Nabız gitti: iletilen özet ve sonuçlar işaretlenir, yanıttaki komutlar uygulanır (eski bulutta `kontrol` yok, bir şey
 * olmaz). Dönüş: hemen bir nabız daha gerekiyor mu (yeni sonuç ya da bulut özeti istedi)
 */
async function kontrolSonrasi(kontrol: { k: KontrolModulu; giden: NabizKontrol } | null, json: unknown, now: number): Promise<boolean> {
  if (!kontrol) return false;
  try {
    kontrol.k.nabizIletildi(kontrol.giden);
    const r = await kontrol.k.kontrolYaniti(isRecord(json) ? json.kontrol : undefined, now);
    durumIstendi = r.durumIste;
    if (r.komut > 0) hizliBitis = now + HIZLI_SURE_MS;
    return r.sonuc > 0 || r.durumIste;
  } catch {
    // Ayrıntı günlüğe yazılmaz: komutlar şifreli PIN taşır
    console.error('[merkez] uzaktan yönetim yanıtı işlenemedi');
    return false;
  }
}

/**
 * Şimdiki nabız aralığı: komut geldikten sonra HIZLI_SURE_MS boyunca dakikada bir, sonra 5 dakikada bir. Saat geri
 * alındıysa (hızlı sürenin bitişi HIZLI_SURE_MS'ten uzakta) hızlı nabız sürmez
 */
export const nabizAraligi = (now = Date.now()) => (now < hizliBitis && hizliBitis - now <= HIZLI_SURE_MS ? HIZLI_NABIZ_MS : MERKEZ_BEAT_MS);

/** Tik zamanlayıcının gecikmesine pay: dakikalık tik 5 dakikalık nabzı bir sonraki tike kaçırmasın */
const TIK_PAYI_MS = 5_000;

/**
 * Dakikalık tik (startMerkez): son nabızdan beri aralık dolduysa ve önceki nabız bitmişse bir nabız. Dönüş: nabız atıldı
 * ve başarılı oldu mu. Kasanın saati geri alındıysa (son nabız ileride görünür) nabzın zamanı gelmiş sayılır: yoksa
 * saat son nabzı yeniden geçene dek (yanlış BIOS saatinde aylarca) hiç nabız atılmazdı
 */
export async function merkezTick(now = Date.now()): Promise<boolean> {
  const gecen = now - sonNabiz;
  if (nabizSuruyor || (gecen >= 0 && gecen < nabizAraligi(now) - TIK_PAYI_MS)) return false;
  nabizSuruyor = true;
  try {
    return await merkezBeat(now);
  } finally {
    nabizSuruyor = false;
  }
}

/**
 * Kayıtta şube: ladmin'den kurulan kasa (server/sync/kurulum-kodu.ts) dükkânın adını ve şube kodunu söyler; Merkez yeni
 * kaydı bu adla açar (sahip yine onaylar). Kurulumdan gelmeyen kasada alan yok
 */
function kayitSube(): { sube?: { ad: string; kod: string | null } } {
  // kurulum-kodu.ts'in kaydı (döngüsel içe aktarma olmasın diye anahtardan okunur)
  const ad = getSyncState<{ sube?: { ad?: string } | null }>('kurulum.sube')?.sube?.ad ?? null;
  if (!ad) return {};
  const kod = subeEtiketi(getSettings().branchId)?.slice(0, 12) ?? null;
  return { sube: { ad, kod } };
}

/**
 * Bir nabız: gerekiyorsa önce kayıt; yanıt saklanır. Hata durumu korur (internetsiz kasa çalışır). `ek`: uzaktan
 * yönetimin hemen attığı ek nabız; zincir en çok bir ek nabızdır
 */
export async function merkezBeat(now = Date.now(), ek = false): Promise<boolean> {
  if (!merkezEnabled()) return false;
  sonNabiz = now;
  const me = identity(now);
  const inst = installedVersion();
  let again = false;
  try {
    if (!me.registered) {
      // Kayıt kafenin ortak anahtarıyla imzalı (dışarıdan kimse kurulum açamaz); kurulumun kendi anahtarı içinde
      const res = await signedFetch(env.cloudSecret, 'POST', new URL('/api/merkez/kayit', env.merkezUrl), { id: me.id, anahtar: me.key, surum: inst.version, build: inst.build, kurulus: me.createdAt, ...kayitSube() }, 8000);
      if (res.status === 409) {
        // Kimlik başkasınca alınmış (eski rastgele kimlik): yeni anahtar ve ondan türeyen kimlik; sonraki nabız kaydolur
        const key = randomBytes(32).toString('base64url');
        setSyncState(IDENTITY, { ...me, id: installIdFor(key), key, registered: false });
        throw new Error('Kimlik başkasınca alınmıştı; yeni kimlik üretildi');
      }
      if (res.status === 400 && isRecord(res.json) && res.json.code === 'bad_id' && me.id !== installIdFor(me.key)) {
        // Eski kimliğin Merkez'deki izi de yok (Redis kaybı): anahtardan türeyen kimlikle kaydolunur
        setSyncState(IDENTITY, { ...me, id: installIdFor(me.key), registered: false });
        throw new Error('Eski kimlik Merkez’de bulunamadı; anahtardan türeyen kimlikle kaydolunacak');
      }
      if (res.status !== 200) throw new Error(`Merkez kaydı alınmadı (${res.status})`);
      setSyncState(IDENTITY, { ...me, registered: true, everRegistered: true });
    }
    const upd = readUpdateStatus();
    const url = new URL('/api/merkez/nabiz', env.merkezUrl);
    const kontrol = await kontrolNabzi(now);
    const body = {
      surum: inst.version,
      build: inst.build,
      gunAcik: !!getOpenDay(db),
      // `secim`: kasada bekleyen sürüm için yapılan seçim (Şimdi / Gün sonunda); yoksa null (panel "seçim bekliyor" der)
      // `kurulumUyari`: kök dosyalar ya da kısayollar güncellemeyle yenilenemedi (panelde "Kurulumu yenileyin"). Merkez'den
      // gönderilen sürümde seçim kendiliğinden "gün sonunda" (effectiveUpdateChoice). `sonKurulum`: son kurulumun anı (panel
      // "Kuruldu 22:41"); çalışan derleme `build` (sunucunun kendi paketinden, yeniden açıldıktan sonra doğrulanmış)
      guncelleme: upd
        ? { durum: upd.durum, mesaj: upd.mesaj, yeni: upd.yeni, secim: effectiveUpdateChoice(upd.yeni)?.secim ?? null, kurulumUyari: upd.kurulumUyari, sonKurulum: upd.sonKurulum }
        : null,
      // Panel "Kasa aldı" desin: işlenen son "Şimdi güncelle" isteği
      istekAlindi: getSyncState<number>(HANDLED_REQUEST),
      // Güncelleyici yalnız gönderilen derlemeyi kurar (guncelle.mjs merkezCap): Merkez hedefi kanalın sonuna taşımasın
      kesinHedef: true,
      // Elimizdeki geçmiş cironun anı (Merkez yalnız değiştiyse gönderir; shared/gecmis.ts)
      gecmisAt: historyAtForBeat(),
      // Uzaktan yönetim: özetin parmak izi, gerekince özet ve sonuçlar (eski bulut alanı görmez)
      ...(kontrol ? { kontrol: kontrol.giden } : {}),
    };
    const res = await signedFetch(me.key, 'POST', url, body, 8000, { 'x-laf-kurulum': me.id });
    // Kayıt Merkez'de silindiyse (Redis sıfırlandı) bir sonraki nabız yeniden kaydolur
    if (res.status === 404) setSyncState(IDENTITY, { ...me, registered: false, everRegistered: me.registered || !!me.everRegistered });
    const parsed = res.status === 200 ? parseBeat(res.json, now) : null;
    if (!parsed) throw new Error(`Merkez yanıt vermedi (${res.status})`);
    const prev = merkezLast();
    setSyncState(LAST, parsed);
    lastOk = now;
    lastError = null;
    // Dükkân adı ya da şube kodu değişti: ekranlar bootstrap'ı yeniden okusun (fiş başlığı)
    if ((prev?.ad ?? null) !== parsed.ad || (prev?.kod ?? null) !== parsed.kod) new Effects().emit({ topic: 'settings', kind: 'merkez', message: 'Şube bilgisi değişti' }).flush();
    takeHistory(res.json);
    // Önce uzaktan yönetimin komutları, sonra güncelleme isteği: "Gün sonu al ve güncelle"de istek aynı yanıttaki gün
    // sonunun sonucuna bağlı (gün sonu reddedilirse güncelleme istenmez)
    again = await kontrolSonrasi(kontrol, res.json, now);
    const bagli = parsed.guncelleKomut ? { komut: parsed.guncelleKomut, durum: kontrol?.k.komutDurumu(parsed.guncelleKomut) ?? null } : null;
    takeRemoteUpdate(parsed.guncelleIstek, now, bagli);
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
  // Sonuçlar ve istenen özet bir sonraki nabzı beklemesin: hemen bir nabız daha (ek nabız yeni zincir başlatmaz)
  if (again && !ek) await merkezBeat(now, true);
  return true;
}

/**
 * Dakikalık tik: nabız 5 dakikada bir, komut geldikten sonra 10 dakika dakikada bir (`nabizAraligi`). İlk nabız
 * açılıştan 10 saniye sonra
 */
export function startMerkez(): NodeJS.Timeout[] {
  if (!merkezEnabled()) return [];
  identity();
  return [setTimeout(() => void merkezTick(), 10_000), setInterval(() => void merkezTick(), HIZLI_NABIZ_MS)];
}
