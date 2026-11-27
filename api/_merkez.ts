/**
 * Merkez (Uzaktan'ın `/merkez` yolu): dükkânlar, lisans ve seçerek güncelleme. api/uzaktan.ts yolu `merkez/` ile
 * başlayan istekleri buraya verir (alt çizgili dosya Vercel'de ayrı işlev olmaz).
 *
 * Kurulum kaydı: kasa ilk açılışta gizli anahtar üretir, kurulum kimliği anahtarın özetidir (`installIdFor`; kimliği
 * bilen başkası onu kendi anahtarıyla kaydedemez). İnternete ilk çıktığında `POST merkez/kayit` ile bildirir; istek
 * kafenin ortak anahtarıyla (ASILPOS_CLOUD_SECRET) ya da şubenin kendi anahtarıyla imzalıdır, dışarıdan kimse kurulum açamaz. Merkez'de "Onay bekliyor"
 * görünür. Kayıt bir kez açılır: aynı kimliğe başka anahtar yazılamaz. Sonraki istekler (`merkez/nabiz`) kurulumun
 * kendi anahtarıyla imzalıdır (server/lib/signature.ts kuralı). Kayıt IP başına saatte 10, onay bekleyen en çok 50.
 *
 * Nabzın yanıtı kasanın lisans kaydı (bitiş tarihiyle), şube kodu, çalıştıracağı derleme (hedef) ve sahibin son "Şimdi
 * güncelle" isteği (Uzaktan yönetimin "Gün sonu al ve güncelle"sinde bağlı olduğu gün sonunun kimliğiyle,
 * `guncelleKomut`): "otomatik" dükkânda hedef kanalın son derlemesi, "ben gönderince" dükkânda sahibin son gönderdiği
 * derleme (hiç gönderilmediyse kurulu olan). Panelden kasaya giden her şey bu yanıtla gider (kasa 5 dakikada bir sorar;
 * ayrı itme yok): "Şimdi güncelle" de kasaya en geç bir sonraki nabızda ulaşır.
 *
 * Redis: `${REDIS_ONEKI}merkez:kurulum:<id>` (JSON; panelin alanları: ad, lisans, mod, hedef), `${REDIS_ONEKI}merkez:durum:<id>`
 * (JSON; nabzın alanları: son görülme, sürüm, güncelleme durumu), `${REDIS_ONEKI}merkez:kurulumlar` (kimlik kümesi),
 * `${REDIS_ONEKI}merkez:bekleyen` (onay bekleyenler). Nabız ve panel ayrı anahtara yazar: biri ötekinin değişikliğini ezmez.
 * Panel uçları yalnız sahibin gerçek oturumuyla (ortamdaki üye ya da parolalı giriş); parolasız görünümde ve panele
 * davet edilen yönetici ya da izleyicide Merkez kapalıdır (403).
 *
 * Uzaktan yönetim (api/_kontrol.ts) de bu nabızla gider: kasa isteğe `kontrol` eklerse sonuçları ve özeti alınır, yanıta
 * kuyruktaki komutlar eklenir. Kuyruk işareti ve özetin parmak izi nabzın ilk MGET'inde okunur: komut yokken nabzın
 * Redis komut sayısı aynı kalır; `kontrol` göndermeyen eski kasa yanıtta yeni alan görmez.
 */
import { createHash } from 'node:crypto';
import { type LicenseRecord, licenseState, normalizeBranchCode, ONLINE_MS, UPDATE_LABELS, updateLabel } from '../shared/lisans.js';
import { fmtTime } from '../shared/time.js';
import { HISTORY_FLAG_HASH, type HistoryStore, historyFlag, historyKey, parseHistory, readHistoryStore } from '../shared/gecmis.js';
import { NABIZ_KONTROL_PAYI, nabizAnahtarlari, nabizKontrol } from './_kontrol.js';
import { REDIS_ONEKI } from '../shared/eski-adlar.js';

export interface Install {
  id: string;
  /** Kurulumun imza anahtarı (kasada üretilir); panele hiç dönmez */
  key: string;
  ad: string | null;
  createdAt: number;
  lastSeen: number | null;
  surum: string | null;
  build: number | null;
  /** `secim`: kasadaki seçim (Şimdi / Gün sonunda); null: yeni kasa, seçim yapılmadı; alan yoksa eski kasa */
  /** `kurulumUyari`: kasanın kök dosyaları ya da kısayolları güncellemeyle yenilenemedi (null/yok: sorun yok) */
  /** `sonKurulum`: kasanın son kurulum anı (ms; nabızda ISO), eski kasada yok */
  guncelleme: { durum: string; mesaj: string; yeni: { surum: string; build: number } | null; secim?: 'simdi' | 'gunsonu' | null; kurulumUyari?: string | null; sonKurulum?: number | null } | null;
  gunAcik: boolean | null;
  lisans: LicenseRecord;
  mod: 'elle' | 'otomatik';
  /** "Ben gönderince" dükkânda sahibin gönderdiği derleme */
  hedef: number | null;
  gonderildi: number | null;
  /** Sahibin verdiği şube kodu ("MRN"); eski kayıtlarda yok */
  kod?: string | null;
  /** Sahibin son "Şimdi güncelle" isteğinin anı; kasa nabzın yanıtında alır */
  guncelleIstek?: number | null;
  /**
   * İsteğin bağlı olduğu uzaktan gün sonunun komut kimliği (Uzaktan yönetim "Gün sonu al ve güncelle"); Merkez'in
   * düğmesinde null. Kasa böyle bir isteği ancak o gün sonu uygulanınca işler (server/sync/merkez.ts takeRemoteUpdate)
   */
  guncelleKomut?: string | null;
  /** Kasanın işlediğini bildirdiği son istek (nabızda `istekAlindi`) */
  istekAlindi?: number | null;
  /**
   * Kasa yalnız gönderilen derlemeyi kurar (nabızda `kesinHedef`; #83 ve sonrası). Eski kasa (alan yok) hedefi üst
   * sınır sayar: gönderilen derleme kanaldan düşünce hiç kurmaz (targetFor onu kanalın son derlemesine taşır)
   */
  kesinHedef?: boolean;
}

/** Güncelleme kanalının son derlemesi (surum.json'dan, kısa değişiklik notuyla) */
export interface Release {
  version: string;
  build: number;
  date: string;
  not: string | null;
}

export interface MerkezDeps {
  redis: (...cmd: (string | number)[]) => Promise<unknown>;
  /** İmzayı verilen anahtarla doğrular (api/uzaktan.ts verifyPush) */
  verify: (key: string, req: Request, url: URL, body: string) => boolean;
  /**
   * Kafenin anahtarıyla imzalı mı: ortak anahtar (ASILPOS_CLOUD_SECRET) ya da başlıktaki şubenin kendi anahtarı
   * (ASILPOS_CLOUD_SECRET_<ŞUBE>; api/_kafe.ts). Kayıt yalnız kasadan. Yanıt dönerse (şube anahtarı geçersiz, şube
   * başlığı anlaşılmadı) o yanıt aynen gider: kasa onu "bulut anahtarı tanımıyor" sanıp ortak anahtara düşmez
   */
  signedShared: (body: string) => boolean | Response;
  /** Panel için gerçek oturum var mı (üye ya da parolalı giriş) */
  admin: () => Promise<boolean>;
  /** Geçerli ama yönetici olmayan oturum (parolasız görünüm): 401 yerine 403 döner, uzaktan oturum düşmez */
  viewer?: () => Promise<boolean>;
  /** Kafe bağlanmadan önceki örnek gün: panel örnek listeyi salt okunur gösterir */
  demo: boolean;
  fetchRelease: () => Promise<Release | null>;
  now?: () => number;
  /** Patrona bildirim (api/_bildirim.ts): güncelleme sorun çıkarıp eski sürüme dönünce */
  notify?: (n: { kind: string; title: string; body: string; at: number; shop?: string | null }) => Promise<void>;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const fail = (status: number, error: string, code: string) => json({ error, code }, status);

const SET_KEY = `${REDIS_ONEKI}merkez:kurulumlar`;
const PENDING_KEY = `${REDIS_ONEKI}merkez:bekleyen`;
const installKey = (id: string) => `${REDIS_ONEKI}merkez:kurulum:${id}`;
const statusKey = (id: string) => `${REDIS_ONEKI}merkez:durum:${id}`;
/** Silinen kurulumun mezar taşı: aynı kimlik ve anahtarla yeniden kayıtta ad, kod, lisans ve kuruluş geri gelir */
const graveKey = (id: string) => `${REDIS_ONEKI}merkez:silinen:${id}`;
const GRAVE_TTL_S = 180 * 86_400;
type Grave = Pick<Install, 'ad' | 'createdAt' | 'lisans' | 'mod' | 'kod'> & { anahtarOzet: string };
export const ID_RE = /^[a-z0-9]{20,40}$/;
const MIN_KEY = 32;
/** Kayıt: IP başına saatte en çok bu kadar; onay bekleyen kurulum en çok bu kadar */
const REGISTER_PER_HOUR = 10;
const PENDING_MAX = 50;
/** Güncelleme sorunu bildirimi bir kurulumda 6 saatte en çok bir kez */
const NOTIFY_EVERY_S = 6 * 3600;
/** Panelin listesi Redis'ten bu kadar kimlikle parça parça okunur */
const LIST_CHUNK = 100;
/** Nabzın gövdesi; uzaktan yönetimin özeti ve sonuçları için pay eklenir */
const BEAT_MAX = 20_000 + NABIZ_KONTROL_PAYI;

/** Kurulum kimliği anahtarın özetidir: kimliği bilen başkası onu kendi anahtarıyla kaydedemez (server/sync/merkez.ts) */
export const installIdFor = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/**
 * Kurulumun kayıtlı imza anahtarı (kurulum yoksa ya da kayıt okunamazsa null). Dükkânın şubeye bağlanma kanıtı bununla
 * doğrulanır (api/_kafe.ts `dukkanKanitiTutar`): dükkân kimliği kurulum kimliğidir, anahtarı yalnız o kasa bilir
 */
export async function kurulumAnahtari(redis: MerkezDeps['redis'], id: string): Promise<string | null> {
  if (!ID_RE.test(id)) return null;
  try {
    const raw = (await redis('GET', installKey(id))) as string | null;
    const key = raw ? (JSON.parse(raw) as Partial<Install>).key : null;
    return typeof key === 'string' && key.length >= MIN_KEY ? key : null;
  } catch {
    return null;
  }
}

/** Nabzın yazdığı alanlar (ayrı anahtar) */
type Beat = Pick<Install, 'lastSeen' | 'surum' | 'build' | 'gunAcik' | 'guncelleme' | 'istekAlindi' | 'kesinHedef'>;

function merged(raw: string | null | undefined, beat: string | null | undefined): Install | null {
  if (!raw) return null;
  try {
    return { ...(JSON.parse(raw) as Install), ...(beat ? (JSON.parse(beat) as Partial<Beat>) : {}) };
  } catch {
    return null;
  }
}

async function readInstall(deps: Pick<MerkezDeps, 'redis'>, id: string): Promise<Install | null> {
  const [raw, beat] = ((await deps.redis('MGET', installKey(id), statusKey(id))) as (string | null)[] | null) ?? [];
  return merged(raw, beat);
}
/** Panelin yazması: kurulum kaydı (nabzın alanları ayrı anahtarda; burada kalan eski değerleri onlar ezer) */
const writeInstall = (deps: Pick<MerkezDeps, 'redis'>, i: Install) => deps.redis('SET', installKey(i.id), JSON.stringify(i));

/**
 * "Şimdi güncelle": hedef kanalın son derlemesi (okunabildiyse) ve kasaya "hemen denetle" isteği. Merkez'in düğmesi ve
 * Uzaktan yönetimin "Gün sonu al ve güncelle"si (api/uzaktan.ts üzerinden) aynı yoldan: ikincisi yalnız isteği yazıyordu,
 * Merkez satırı gönderimin adımlarını göstermiyor, kasada sürüm Merkez'den gönderilmiş sayılmayıp kasiyere soruluyor ve
 * güncelleyicinin Merkez sınırı aşılıyordu (inceleme, 23 Kas 2026). `komut`: isteğin bağlı olduğu uzaktan gün sonu (kasa
 * ancak o uygulanınca işler); Merkez'in düğmesinde null. Kurulum yoksa false. Kasa bir sonraki nabızda alır; yeni sürüm
 * gün kapalıyken kurulur, gün açıkken asla (server/sync/merkez.ts takeRemoteUpdate)
 */
export async function requestUpdateNow(redis: MerkezDeps['redis'], id: string, now: number, release: Release | null, komut: string | null = null): Promise<UpdateAsk | null> {
  const inst = await readInstall({ redis }, id);
  if (!inst) return null;
  const ask = updateAskFor(inst, release);
  if (ask !== 'istendi') return ask;
  await writeInstall({ redis }, { ...inst, guncelleIstek: now, guncelleKomut: komut, ...(release ? { hedef: release.build, gonderildi: now } : {}) });
  return 'istendi';
}

/** "Şimdi güncelle"nin sonucu: istendi ya da kasa zaten en güncel derlemede (gönderilmez) */
export type UpdateAsk = 'istendi' | 'guncel';

/**
 * Güncelleme yeniden istenir mi (sahibin isteği, 23 Kas 2026: güncel sürüm kuruluysa tekrar tekrar gönderilmesin). Kurulu
 * derleme kanalın son derlemesi ya da daha yenisiyse `guncel`: istek ve hedef yazılmaz. Kanal okunamadıysa (release
 * null) karar verilemez: istenir, kasa kendisi denetler. Bekleyen isteğin üstüne yeniden istemek serbesttir (Merkez'in
 * düğmesi gün sonuna bağlı isteği bağsız yapar; Merkez'de bekleyen satırın düğmesi zaten kapalı)
 */
export function updateAskFor(i: Pick<Install, 'build'>, release: Release | null): UpdateAsk {
  return release && i.build != null && i.build >= release.build ? 'guncel' : 'istendi';
}

/**
 * Bağlı gün sonu kasaya gitmeden iptal edildi (api/_kontrol.ts komutIptal): "hemen denetle" isteği de geri alınır. Yoksa
 * kasa isteği 30 dakika gün sonunu bekleyip "kasaya ulaşmadı" diye kapatıyor, Merkez o sürece "Güncelleme istendi"
 * gösterip "Şimdi güncelle"yi kapalı tutuyordu (inceleme, 23 Kas 2026). Yalnız istek hâlâ o gün sonuna bağlıysa: arada
 * Merkez'den verilen "Şimdi güncelle" ya da yeni bir "Gün sonu al ve güncelle" geri alınmaz. Gönderilen hedef kalır
 * (reddedilen gün sonundaki gibi: sürüm olağan yoldan gün kapanınca kurulur). Dönüş: geri alındıysa true
 */
export async function withdrawLinkedUpdate(redis: MerkezDeps['redis'], id: string, komut: string): Promise<boolean> {
  const inst = await readInstall({ redis }, id);
  if (!inst || inst.guncelleKomut !== komut) return false;
  await writeInstall({ redis }, { ...inst, guncelleIstek: null, guncelleKomut: null });
  return true;
}

/** ISO zaman → ms (anlaşılmazsa null) */
const isoMs = (v: unknown) => {
  const ms = typeof v === 'string' && v.length <= 40 ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
};
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : null);
const intOrNull = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);

/**
 * Kasanın çalıştıracağı derleme: otomatikte kanalın sonu, elle gönderilende sahibin gönderdiği (yoksa null: kurulu
 * kalır). Eski kasa (`kesinHedef` yok) hedefi üst sınır sayar; gönderilen derleme kanaldan düşerse (gönderdikten sonra
 * main'e giren PR) hiç kurmaz ve panel de "gönderildi" görürdü. Ona, kurulu derlemeden yeni bir gönderim varken
 * kanalın son derlemesi söylenir: geçişte gönderilen güncelleme kaybolmaz
 */
export function targetFor(i: Pick<Install, 'mod' | 'hedef' | 'build' | 'kesinHedef'>, release: Release | null): number | null {
  if (i.mod === 'otomatik') return release?.build ?? i.hedef;
  if (!i.kesinHedef && release && i.hedef != null && i.build != null && i.hedef > i.build && release.build > i.hedef) return release.build;
  return i.hedef;
}

/** Panelin gördüğü satır: anahtar yok; lisans ve güncelleme durumu sade adıyla */
/**
 * Panelin durum etiketi (sahibin dört durumu: güncel, bekliyor, gün sonunda kurulacak, hata). Bekleyen sürümde kasadaki
 * seçim ayırır: seçim yoksa kasada soruluyor; eski kasa (`secim` alanı yok) eski etiketle
 */
export function updateStatusLabel(g: NonNullable<Install['guncelleme']>): string {
  if (g.durum === 'guncel') return 'Güncel';
  if (g.durum === 'bekliyor' && g.secim !== undefined) return g.secim === 'gunsonu' ? 'Gün sonunda kurulacak' : g.secim === 'simdi' ? 'Şimdi kuruluyor' : 'Kasada seçim bekliyor';
  return updateLabel(g.durum);
}

/**
 * Merkez'den gönderilen güncellemenin yolculuğu (dükkân satırı): "Gönderildi 22:20" → "Kasa aldı · gün sonunda
 * kurulacak" → "Kuruluyor" → "Kuruldu 22:41 · sürüm 0.3.1" ya da "Kurulamadı: <mesaj>". "Kuruldu" yalnız kasanın
 * çalışan derlemesi (yeniden açılan sunucunun nabızda bildirdiği `build`) gönderilen derlemeye vardığında. Gönderim
 * yoksa null. Eski kasa (seçim alanı yok) da aynı adımları görür; yalnız "kasa aldı"nın ardı eski etiketle
 */
export function deliveryStatus(i: Pick<Install, 'hedef' | 'gonderildi' | 'build' | 'surum' | 'guncelleme'>): { etiket: string; ton: 'info' | 'success' | 'warning' } | null {
  if (i.hedef == null || i.gonderildi == null) return null;
  const g = i.guncelleme;
  if (i.build != null && i.build >= i.hedef) {
    const at = g?.sonKurulum && g.sonKurulum >= i.gonderildi ? ` ${fmtTime(g.sonKurulum)}` : '';
    return { etiket: `Kuruldu${at}${i.surum ? ` · sürüm ${i.surum}` : ''}`, ton: 'success' };
  }
  if (g && (g.durum === 'hata' || g.durum === 'geri-dondu')) return { etiket: `Kurulamadı: ${g.mesaj || updateLabel(g.durum)}`.slice(0, 160), ton: 'warning' };
  if (g?.durum === 'kuruluyor') return { etiket: 'Kuruluyor', ton: 'info' };
  if (g?.yeni && g.yeni.build <= i.hedef && g.yeni.build > (i.build ?? 0)) {
    if (g.durum === 'indiriliyor') return { etiket: 'Kasa aldı · indiriliyor', ton: 'info' };
    if (g.secim === 'simdi') return { etiket: 'Kasa aldı · şimdi kurulacak', ton: 'info' };
    if (g.secim === 'gunsonu') return { etiket: 'Kasa aldı · gün sonunda kurulacak', ton: 'info' };
    return { etiket: `Kasa aldı · ${updateStatusLabel(g).toLocaleLowerCase('tr-TR')}`, ton: 'info' };
  }
  return { etiket: `Gönderildi ${fmtTime(i.gonderildi)}`, ton: 'info' };
}

export function installView(i: Install, release: Release | null, now: number) {
  // Kasanın son görülmesi onay anıdır: çevrimdışı kasada satış kapanmaz, panel de bunu gösterir (shared/lisans.ts)
  const lic = licenseState(i.lisans, { installedAt: i.createdAt, now, confirmedAt: i.lastSeen });
  const behind = release != null && i.build != null && i.build < release.build;
  return {
    id: i.id,
    ad: i.ad,
    surum: i.surum,
    build: i.build,
    createdAt: i.createdAt,
    lastSeen: i.lastSeen,
    online: i.lastSeen != null && now - i.lastSeen < ONLINE_MS,
    gunAcik: i.gunAcik,
    guncelleme: i.guncelleme ? { durum: String(i.guncelleme.durum), mesaj: String(i.guncelleme.mesaj ?? ''), yeni: i.guncelleme.yeni ?? null, secim: i.guncelleme.secim ?? null, etiket: updateStatusLabel(i.guncelleme), kurulumUyari: i.guncelleme.kurulumUyari ?? null } : null,
    /** Merkez'den gönderilen güncellemenin adımı (deliveryStatus); gönderim yoksa null */
    gonderim: deliveryStatus(i),
    lisans: { ...i.lisans, ...lic },
    mod: i.mod,
    hedef: i.hedef,
    gonderildi: i.gonderildi,
    kod: i.kod ?? null,
    guncelleIstek: i.guncelleIstek ?? null,
    /** "Şimdi güncelle" istendi, kasa henüz almadı */
    istekBekliyor: !!i.guncelleIstek && i.istekAlindi !== i.guncelleIstek,
    /**
     * Kanalda daha yeni derleme var ve kasanın çalıştıracağı derleme o değil: hiç gönderilmedi ya da gönderilen derleme
     * kanaldan düştü (kasa yalnız gönderileni kurar; kanal ilerlediyse yeniden gönderilmeli)
     */
    bekleyen: behind && targetFor(i, release) !== release!.build,
  };
}

/** Kafe bağlanmadan önce panelin örnek satırları (gerçek kurulum değil, salt okunur) */
function demoInstalls(release: Release | null, now: number) {
  const base: Install = {
    id: 'ornekkurulum00000000001',
    key: '',
    ad: 'Örnek dükkân',
    createdAt: now - 20 * 86_400_000,
    lastSeen: now - 60_000,
    surum: release?.version ?? '0.2.0',
    build: release?.build ?? null,
    guncelleme: { durum: 'guncel', mesaj: 'Güncel', yeni: null },
    gunAcik: true,
    lisans: { durum: 'aktif', bitis: null },
    mod: 'elle',
    hedef: release?.build ?? null,
    gonderildi: null,
  };
  return [installView(base, release, now)];
}

/** Panel kapısı: yönetici oturumu yoksa yanıt. Geçerli ama yetkisiz oturum (parolasız görünüm) 403 alır, 401 değil */
async function gate(deps: MerkezDeps): Promise<Response | null> {
  if (await deps.admin()) return null;
  // Geçerli oturum ama sahip değil: panele eklenen yönetici ya da izleyici, parolasız görünüm
  if (await deps.viewer?.()) return fail(403, 'Merkez’i yalnız panelin sahibi açar (sahibin üye girişi)', 'remote_admin');
  return fail(401, 'Merkez için üye girişi gerekir', 'unauthorized');
}

export async function merkez(req: Request, url: URL, path: string, deps: MerkezDeps): Promise<Response> {
  const now = (deps.now ?? Date.now)();

  // ─── Kasa: kayıt (kafenin ortak anahtarıyla imzalı; kurulumun kendi anahtarı burada bildirilir) ───
  if (path === 'merkez/kayit' && req.method === 'POST') {
    const raw = await req.text();
    if (raw.length > 4000) return fail(413, 'Kayıt çok büyük', 'too_large');
    const imza = deps.signedShared(raw);
    if (imza instanceof Response) return imza;
    if (!imza) return fail(401, 'İmza geçersiz', 'bad_signature');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(400, 'Kayıt okunamadı', 'bad_body');
    }
    const id = String(body.id ?? '');
    const key = String(body.anahtar ?? '');
    if (!ID_RE.test(id) || key.length < MIN_KEY || key.length > 200) return fail(400, 'Kurulum kimliği ya da anahtarı anlaşılamadı', 'bad_body');
    const ip = (req.headers.get('x-forwarded-for') ?? 'yok').split(',')[0]!.trim().slice(0, 64);
    const ipKey = `${REDIS_ONEKI}merkez:kayit:ip:${ip}`;
    const tries = Number(await deps.redis('INCR', ipKey));
    if (tries === 1) await deps.redis('EXPIRE', ipKey, 3600);
    if (tries > REGISTER_PER_HOUR) return fail(429, 'Çok fazla kayıt denemesi; bir saat sonra yeniden deneyin', 'rate_limited');
    // Aynı kasa yeniden bildiriyorsa (yanıtı almadan internet kesildi) sorun yok; başka anahtar kabul edilmez
    const existing = await readInstall(deps, id);
    if (existing) return existing.key === key ? json({ ok: true, yeni: false }) : fail(409, 'Bu kurulum kimliği başka bir anahtarla kayıtlı', 'install_exists');
    // Silinen kurulum aynı anahtarla dönüyor: eski (rastgele) kimliği de kabul edilir, ad, kod ve lisans geri gelir
    let grave: Grave | null = null;
    try {
      const raw = (await deps.redis('GET', graveKey(id))) as string | null;
      grave = raw ? (JSON.parse(raw) as Grave) : null;
    } catch {
      grave = null;
    }
    if (grave && grave.anahtarOzet !== installIdFor(key)) grave = null;
    // Yeni kurulumun kimliği anahtarının özeti olmalı (eski kurulumlar kayıtlı kaldıkça yukarıdan, silindiyse mezar taşıyla geçer)
    if (!grave && id !== installIdFor(key)) return fail(400, 'Kurulum kimliği anahtarla uyuşmuyor', 'bad_id');
    if (!grave && Number(await deps.redis('SCARD', PENDING_KEY)) >= PENDING_MAX) return fail(429, 'Onay bekleyen kurulum çok; önce Merkez’de bekleyenleri onaylayın ya da silin', 'too_many_pending');
    const fresh: Install = {
      id,
      key,
      ad: null,
      createdAt: now,
      lastSeen: now,
      surum: text(body.surum, 40),
      build: intOrNull(body.build),
      guncelleme: null,
      gunAcik: null,
      lisans: { durum: 'bekliyor' },
      mod: 'elle',
      hedef: null,
      gonderildi: null,
    };
    // Kasa kendi kuruluş anını söyler (internete geç çıkan kurulumun deneme süresi kuruluştan sayılır); gelecekte olamaz
    const installedAt = intOrNull(body.kurulus);
    if (installedAt && installedAt <= now) fresh.createdAt = installedAt;
    // ladmin'den kurulan kasa şubesinin adını ve kodunu söyler (server/sync/kurulum-kodu.ts): dükkân bu adla açılır,
    // sahip yine onaylar. Geçersiz kod düşer (ad kalır)
    const sube = body.sube && typeof body.sube === 'object' ? (body.sube as Record<string, unknown>) : null;
    if (sube) {
      fresh.ad = text(sube.ad, 60) || null;
      const kod = normalizeBranchCode(sube.kod);
      if (kod) fresh.kod = kod;
    }
    if (grave) Object.assign(fresh, { ad: grave.ad, createdAt: grave.createdAt, lisans: grave.lisans, mod: grave.mod, kod: grave.kod ?? null });
    if ((await deps.redis('SET', installKey(id), JSON.stringify(fresh), 'NX')) === 'OK') {
      await deps.redis('SADD', SET_KEY, id);
      if (fresh.lisans.durum === 'bekliyor') await deps.redis('SADD', PENDING_KEY, id);
      if (grave) await deps.redis('DEL', graveKey(id));
      return json({ ok: true, yeni: true });
    }
    const raced = await readInstall(deps, id);
    if (raced && raced.key === key) return json({ ok: true, yeni: false });
    return fail(409, 'Bu kurulum kimliği başka bir anahtarla kayıtlı', 'install_exists');
  }

  // ─── Kasa: imzalı nabız ───
  if (path === 'merkez/nabiz' && req.method === 'POST') {
    const id = req.headers.get('x-laf-kurulum') ?? '';
    if (!ID_RE.test(id)) return fail(400, 'Kurulum kimliği yok', 'bad_body');
    const raw = await req.text();
    if (raw.length > BEAT_MAX) return fail(413, 'Nabız çok büyük', 'too_large');
    // Kurulum, nabız kaydı ve uzaktan yönetimin işaretleri (kuyruk, özet, teslim) tek okumada
    // Geçmiş ciro (shared/gecmis.ts) de aynı okumada: kasa kendi patron panelinde AsilPOS öncesi günleri görsün
    const [rawInst, rawBeat, rawGecmis, ...kontrolOnce] = ((await deps.redis('MGET', installKey(id), statusKey(id), historyKey(id), ...nabizAnahtarlari(id))) as (string | null)[] | null) ?? [];
    const inst = merged(rawInst, rawBeat);
    if (!inst) return fail(404, 'Kurulum kayıtlı değil', 'not_registered');
    if (!deps.verify(inst.key, req, url, raw)) return fail(401, 'İmza geçersiz', 'bad_signature');
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return fail(400, 'Nabız okunamadı', 'bad_body');
    }
    const g = body.guncelleme as Record<string, unknown> | null | undefined;
    const yeni = g?.yeni as { surum?: unknown; build?: unknown } | null | undefined;
    // Bilinen durumlar saklanır (panel adıyla gösterir); başka metin "bilinmiyor" olur
    const durum = g && typeof g.durum === 'string' && Object.hasOwn(UPDATE_LABELS, g.durum) ? g.durum : 'bilinmiyor';
    const beat: Beat = {
      lastSeen: now,
      surum: text(body.surum, 40) ?? inst.surum,
      build: intOrNull(body.build) ?? inst.build,
      gunAcik: typeof body.gunAcik === 'boolean' ? body.gunAcik : inst.gunAcik,
      istekAlindi: intOrNull(body.istekAlindi) ?? inst.istekAlindi ?? null,
      kesinHedef: body.kesinHedef === true,
      guncelleme:
        g && typeof g === 'object'
          ? { durum, mesaj: text(g.mesaj, 300) ?? '', yeni: yeni && typeof yeni.surum === 'string' && intOrNull(yeni.build) ? { surum: yeni.surum.slice(0, 40), build: yeni.build as number } : null, ...('secim' in g ? { secim: g.secim === 'simdi' || g.secim === 'gunsonu' ? (g.secim as 'simdi' | 'gunsonu') : null } : {}), kurulumUyari: text(g.kurulumUyari, 300) || null, sonKurulum: isoMs(g.sonKurulum) }
          : inst.guncelleme,
    };
    // Nabız yalnız kendi alanlarını yazar (tek komut): panelin aynı anda verdiği lisans ya da hedef ezilmez
    await deps.redis('SET', statusKey(id), JSON.stringify(beat));
    // Uzaktan yönetim yalnız `kontrol` gönderen kasada. Bir aksaklık lisans nabzını düşürmez: alan yanıtta olmaz, kasa
    // bildirmediği sonuçları saklar ve sonraki nabızda yeniden gönderir
    const kontrol = await nabizKontrol(deps.redis, id, body.kontrol, kontrolOnce, now).catch(() => null);
    // Yanıt panelin son yazdığı kayıttan (kanal okunurken değişmiş olabilir)
    const release = await deps.fetchRelease();
    const fresh = await readInstall(deps, id);
    const next: Install = { ...(fresh ?? inst), ...beat };
    // Güncelleme sorun çıkardı (eski sürüme dönüldü): onaylı dükkânda patrona haber. Metin sabit (kasanın yazdığı
    // ileti yalnız panelde görünür), dükkânın adı sahibin verdiği; aynı kurulum 6 saatte en çok bir kez
    const failedNow = durum === 'geri-dondu' || durum === 'hata';
    if (failedNow && inst.guncelleme?.durum !== durum && next.lisans.durum === 'aktif' && deps.notify) {
      if ((await deps.redis('SET', `${REDIS_ONEKI}merkez:bildirim:${id}`, '1', 'NX', 'EX', NOTIFY_EVERY_S)) === 'OK') {
        const body = durum === 'geri-dondu' ? 'Yeni sürüm kurulamadı; eski sürüm çalışıyor' : 'Güncelleme sorun çıkardı; ayrıntı Merkez’de';
        await deps.notify({ kind: 'guncelleme', title: 'Güncelleme sorunu', body, at: now, shop: next.ad }).catch(() => undefined);
      }
    }
    // Geçmiş ciro yalnız kasadakinden farklıysa gider (kasa elindekinin anını `gecmisAt` ile söyler); kayıt silindiyse null.
    // Kaynağın adı da gider (kasanın Raporlar'ı günleri "ModPOS" diye etiketler)
    const gecmisStore = readHistoryStore(rawGecmis);
    const gecmisAt = gecmisStore ? gecmisStore.at : null;
    // Kasanın -1'i: elindeki kopya kaynağın adını taşımıyor (eski sürüm); kayıt varsa yeniden, yoksa silindi diye gider
    const kasaGecmisAt = Number.isInteger(body.gecmisAt) ? (body.gecmisAt as number) : null;
    const gecmis = (gecmisAt ?? 0) !== (kasaGecmisAt ?? 0) && 'gecmisAt' in body ? { gecmis: gecmisStore ? { at: gecmisAt, kaynak: gecmisStore.kaynak, gunler: gecmisStore.gunler } : null } : {};
    // `guncelleKomut`: isteğin bağlı olduğu uzaktan gün sonu (eski kasa alanı görmez, isteği hemen işler)
    return json({ ok: true, ad: next.ad, kod: next.kod ?? null, lisans: next.lisans, mod: next.mod, hedef: targetFor(next, release), guncelleIstek: next.guncelleIstek ?? null, guncelleKomut: next.guncelleKomut ?? null, at: now, ...gecmis, ...(kontrol ? { kontrol } : {}) });
  }

  // ─── Panel ───
  if (path === 'merkez/kurulumlar' && req.method === 'GET') {
    const release = await deps.fetchRelease();
    if (deps.demo) return json({ kurulumlar: demoInstalls(release, now), enYeni: release, demo: true });
    const denied = await gate(deps);
    if (denied) return denied;
    const ids = ((await deps.redis('SMEMBERS', SET_KEY)) as string[] | null) ?? [];
    const rows: Install[] = [];
    for (let i = 0; i < ids.length; i += LIST_CHUNK) {
      const part = ids.slice(i, i + LIST_CHUNK);
      const raws = ((await deps.redis('MGET', ...part.flatMap((id) => [installKey(id), statusKey(id)]))) as (string | null)[] | null) ?? [];
      part.forEach((_, j) => {
        const row = merged(raws[j * 2], raws[j * 2 + 1]);
        if (row) rows.push(row);
      });
    }
    rows.sort((a, b) => (a.ad ?? '￿').localeCompare(b.ad ?? '￿', 'tr') || a.createdAt - b.createdAt);
    return json({ kurulumlar: rows.map((i) => installView(i, release, now)), enYeni: release });
  }

  if (req.method === 'POST' && (path === 'merkez/kurulum' || path === 'merkez/gonder' || path === 'merkez/simdi-guncelle' || path === 'merkez/sil' || path === 'merkez/gecmis')) {
    if (deps.demo) return fail(403, 'Örnek görünümde değişiklik yapılmaz', 'remote_readonly');
    const denied = await gate(deps);
    if (denied) return denied;
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;

    // Kaydı sil: bilinmeyen ya da artık kullanılmayan kurulum. Lisansı aktif kurulum silinmez (önce pasife alınır).
    // Mezar taşı kalır: kasa hâlâ çalışıyorsa sonraki nabızda aynı kimlikle, adı, kodu ve lisansıyla yeniden kaydolur
    if (path === 'merkez/sil') {
      const id = String(body.id ?? '');
      if (!ID_RE.test(id)) return fail(400, 'Kurulum kimliği anlaşılamadı', 'bad_body');
      const inst = await readInstall(deps, id);
      if (inst?.lisans.durum === 'aktif') return fail(400, 'Lisansı aktif kurulum silinmez; önce pasife alın', 'license_active');
      if (inst?.key) {
        const grave: Grave = { ad: inst.ad, createdAt: inst.createdAt, lisans: inst.lisans, mod: inst.mod, kod: inst.kod ?? null, anahtarOzet: installIdFor(inst.key) };
        await deps.redis('SET', graveKey(id), JSON.stringify(grave), 'EX', GRAVE_TTL_S);
      }
      await deps.redis('DEL', installKey(id), statusKey(id));
      await deps.redis('SREM', SET_KEY, id);
      await deps.redis('SREM', PENDING_KEY, id);
      return json({ ok: true });
    }

    // Geçmiş ciro (shared/gecmis.ts): dükkânın AsilPOS'tan önceki kasa programında kalan günleri. Bulutta ayrı anahtarda
    // durur, kasaya gitmez; boş liste kaydı siler. Uzaktan'ın kıyasları ve raporları o günleri de görür
    if (path === 'merkez/gecmis') {
      const id = String(body.id ?? '');
      if (!ID_RE.test(id) || !(await readInstall(deps, id))) return fail(404, 'Kurulum bulunamadı', 'not_found');
      const days = parseHistory(body.gunler);
      if (typeof days === 'string') return fail(400, days, 'bad_body');
      if (!days.length) {
        await deps.redis('DEL', historyKey(id));
        await deps.redis('HDEL', HISTORY_FLAG_HASH, historyFlag(id));
        return json({ ok: true, gun: 0, ciro: 0 });
      }
      const store: HistoryStore = { v: 1, kaynak: text(body.kaynak, 40) || 'Önceki kasa programı', at: Date.now(), gunler: days };
      await deps.redis('SET', historyKey(id), JSON.stringify(store));
      await deps.redis('HSET', HISTORY_FLAG_HASH, historyFlag(id), String(store.at));
      return json({ ok: true, gun: days.length, ciro: days.reduce((a, d) => a + d.ciro, 0), ilk: days[0]!.date, son: days[days.length - 1]!.date });
    }

    if (path === 'merkez/kurulum') {
      const id = String(body.id ?? '');
      const inst = ID_RE.test(id) ? await readInstall(deps, id) : null;
      if (!inst) return fail(404, 'Kurulum bulunamadı', 'not_found');
      const next: Install = { ...inst };
      if ('ad' in body) next.ad = text(body.ad, 60) || null;
      if ('kod' in body) {
        const kod = normalizeBranchCode(body.kod);
        if (kod === undefined) return fail(400, 'Şube kodu yalnız harf, rakam ve tire olabilir; en çok 12 karakter', 'bad_body');
        next.kod = kod;
      }
      if (body.mod === 'elle' || body.mod === 'otomatik') next.mod = body.mod;
      if (body.lisans === 'aktif') {
        const bitis = body.bitis == null || body.bitis === '' ? null : String(body.bitis);
        if (bitis != null && !/^\d{4}-\d{2}-\d{2}$/.test(bitis)) return fail(400, 'Bitiş tarihi anlaşılamadı', 'bad_body');
        next.lisans = { durum: 'aktif', bitis };
      } else if (body.lisans === 'pasif') {
        // Zaten pasifse uyarı süresi baştan başlamaz
        next.lisans = { durum: 'pasif', pasifAt: inst.lisans.durum === 'pasif' ? (inst.lisans.pasifAt ?? now) : now };
      } else if (body.lisans === 'bekliyor') {
        next.lisans = { durum: 'bekliyor' };
      }
      await writeInstall(deps, next);
      // Sahip karar verdi: onay bekleyenler sınırından düşer
      if (next.lisans.durum !== 'bekliyor') await deps.redis('SREM', PENDING_KEY, id);
      return json({ ok: true, kurulum: installView(next, await deps.fetchRelease(), now) });
    }

    const ids = Array.isArray(body.ids) ? body.ids.filter((x): x is string => typeof x === 'string' && ID_RE.test(x)).slice(0, 200) : [];
    if (!ids.length) return fail(400, 'Dükkân seçin', 'bad_body');
    const release = await deps.fetchRelease();

    // Şimdi güncelle (requestUpdateNow): hedef kanalın son derlemesi ve kasaya "hemen denetle" isteği
    if (path === 'merkez/simdi-guncelle') {
      let asked = 0;
      let current = 0;
      for (const id of ids) {
        const r = await requestUpdateNow(deps.redis, id, now, release);
        if (r === 'istendi') asked++;
        else if (r === 'guncel') current++;
      }
      return json({ ok: true, istenen: asked, guncel: current, build: release?.build ?? null, surum: release?.version ?? null });
    }

    // Güncelleme gönder: seçilen dükkânların hedefi kanalın son derlemesi
    if (!release) return fail(503, 'Güncelleme kanalı okunamadı; biraz sonra yeniden deneyin', 'no_release');
    let sent = 0;
    let current = 0;
    for (const id of ids) {
      const inst = await readInstall(deps, id);
      if (!inst) continue;
      // En güncel derleme kuruluysa yeniden gönderilmez ("Gönderildi" adımı açılmaz)
      if (updateAskFor(inst, release) === 'guncel') {
        current++;
        continue;
      }
      await writeInstall(deps, { ...inst, hedef: release.build, gonderildi: now });
      sent++;
    }
    return json({ ok: true, gonderilen: sent, guncel: current, build: release.build, surum: release.version });
  }

  return fail(404, "Merkez'de böyle bir uç yok", 'not_found');
}
