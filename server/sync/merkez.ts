import { createHash, randomBytes } from 'node:crypto';
import { type LicenseRecord, type LicenseView, licenseState, normalizeBranchCode, salesAllowed } from '@shared/lisans';
import { REMOTE_SHOP } from '@shared/remote-reports';
import { db, tx } from '../db/client';
import { env } from '../env';
import { getOpenDay } from '../services/orders';
import { Effects } from '../lib/effects';
import { HttpError } from '../lib/http';
import { getSyncState, setSyncState } from '../lib/settings';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { installedVersion, readUpdateStatus, writeUpdateRequest } from '../lib/surum';
import { underBekci } from './yedek';

/**
 * Merkez (docs/KALANLAR.md, docs/07-UZAKTAN-ERISIM.md §4 "Merkez"): kurulum ilk açılışta kimlik ve gizli anahtar
 * üretir; internete ilk çıktığında Merkez'e kendini bildirir (ilk görüşte güven, dükkânda kimse anahtar girmez), sonra
 * 5 dakikada bir imzalı nabız: sürüm, güncelleme durumu, gün açık mı. Yanıt lisans kaydı (bitiş tarihiyle), şube kodu,
 * çalıştırılacak derleme ve sahibin "Şimdi güncelle" isteği. Uzaktan'dan kasaya giden her şey bu yanıtla gelir: ayrı
 * istek ve ayrı zamanlayıcı yok (AGENTS.md kural 6'daki bütçe).
 *
 * Son yanıt saklanır: internet ya da Merkez yokken kasa son geçerli kayıtla ve kendi saatiyle çalışır. Merkez adresi
 * yoksa (LAFPOS_MERKEZ_URL ya da LAFPOS_CLOUD_URL tanımsız, ya da LAFPOS_MERKEZ_URL=0) lisans uygulanmaz ve
 * güncelleyici eskisi gibi kanalın son sürümünü izler.
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
  /** Son başarılı nabzın anı: lisans kaydının Merkez'den alındığı an */
  at: number;
}

/** Merkez açık: adres ve kafenin ortak anahtarı (kayıt onunla imzalı; anahtarsız kasada lisans uygulanmaz) */
export const merkezEnabled = () => !!env.merkezUrl && env.cloudSecret.length >= MIN_SECRET_LENGTH;

/** Kurulum kimliği anahtarın özetidir (api/_merkez.ts installIdFor ile aynı): kimliği bilen başkası onu kaydedemez */
export const installIdFor = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 24);

/**
 * Kurulum kimliği: ilk okumada üretilir ve hep aynı kalır (yedekten dönüşte de; gün sonu verisiyle birlikte). Henüz
 * kaydolmamış eski (rastgele) kimlik anahtardan türeyen kimliğe geçer; kayıtlı eski kimlik kaldıkça kullanılır
 */
export function identity(now = Date.now()): Identity {
  const existing = getSyncState<Identity>(IDENTITY);
  if (existing?.id && existing.key) {
    if (existing.registered || existing.id === installIdFor(existing.key)) return existing;
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
    at: now,
  };
}

/**
 * Sahibin Uzaktan › Merkez'den "Şimdi güncelle" isteği (nabzın yanıtında `guncelleIstek`): kasadaki "Şimdi güncelle"
 * düğmesinin yazdığı isteğin aynısını yazar (guncelleme/istek.json; bekçi alır, güncelleyici hemen denetler ve
 * indirir). Uzaktan istek hiçbir zaman gün açıkken kurdurmaz (`simdi: false`): yeni sürüm gün kapalıysa hemen, açıksa
 * gün sonundan sonra kurulur (guncelle.mjs installDecision). Her istek bir kez işlenir ve denetim kaydına yazılır;
 * Windows güncelleyicisi olmayan kurulumda istek yazılmaz, kayıt bunu söyler. Dönüş: işlendiyse true
 */
export function takeRemoteUpdate(istek: number | null | undefined, now = Date.now()): boolean {
  if (!istek || getSyncState<number>(HANDLED_REQUEST) === istek) return false;
  const can = underBekci();
  const fx = new Effects();
  tx((t) => {
    setSyncState(HANDLED_REQUEST, istek);
    fx.audit(t, {
      action: 'guncelleme',
      entity: 'merkez',
      message: can
        ? "Merkez'den (LafPOS Uzaktan) güncelleme istendi: yeni sürüm denetleniyor, gün kapalıyken kurulur"
        : "Merkez'den (LafPOS Uzaktan) güncelleme istendi; bu kurulumda otomatik güncelleyici yok, sunucu elle güncellenir",
      data: { kaynak: 'merkez', istek },
    });
  });
  if (can) writeUpdateRequest({ at: now, by: 'merkez', simdi: false });
  if (can) fx.emit({ topic: 'settings', kind: 'guncelleme', message: 'Güncelleme denetleniyor' });
  fx.flush();
  return true;
}

/** Bir nabız: gerekiyorsa önce kayıt; yanıt saklanır. Hata durumu korur (internetsiz kasa çalışır) */
export async function merkezBeat(now = Date.now()): Promise<boolean> {
  if (!merkezEnabled()) return false;
  const me = identity(now);
  const inst = installedVersion();
  try {
    if (!me.registered) {
      // Kayıt kafenin ortak anahtarıyla imzalı (dışarıdan kimse kurulum açamaz); kurulumun kendi anahtarı içinde
      const res = await signedFetch(env.cloudSecret, 'POST', new URL('/api/merkez/kayit', env.merkezUrl), { id: me.id, anahtar: me.key, surum: inst.version, build: inst.build, kurulus: me.createdAt }, 8000);
      if (res.status === 409) {
        // Kimlik başkasınca alınmış (eski rastgele kimlik): yeni anahtar ve ondan türeyen kimlik; sonraki nabız kaydolur
        const key = randomBytes(32).toString('base64url');
        setSyncState(IDENTITY, { ...me, id: installIdFor(key), key, registered: false });
        throw new Error('Kimlik başkasınca alınmıştı; yeni kimlik üretildi');
      }
      if (res.status !== 200) throw new Error(`Merkez kaydı alınmadı (${res.status})`);
      setSyncState(IDENTITY, { ...me, registered: true });
    }
    const upd = readUpdateStatus();
    const url = new URL('/api/merkez/nabiz', env.merkezUrl);
    const body = {
      surum: inst.version,
      build: inst.build,
      gunAcik: !!getOpenDay(db),
      guncelleme: upd ? { durum: upd.durum, mesaj: upd.mesaj, yeni: upd.yeni } : null,
      // Panel "Kasa aldı" desin: işlenen son "Şimdi güncelle" isteği
      istekAlindi: getSyncState<number>(HANDLED_REQUEST),
    };
    const res = await signedFetch(me.key, 'POST', url, body, 8000, { 'x-laf-kurulum': me.id });
    // Kayıt Merkez'de silindiyse (Redis sıfırlandı) bir sonraki nabız yeniden kaydolur
    if (res.status === 404) setSyncState(IDENTITY, { ...me, registered: false });
    const parsed = res.status === 200 ? parseBeat(res.json, now) : null;
    if (!parsed) throw new Error(`Merkez yanıt vermedi (${res.status})`);
    const prev = merkezLast();
    setSyncState(LAST, parsed);
    lastOk = now;
    lastError = null;
    // Dükkân adı ya da şube kodu değişti: ekranlar bootstrap'ı yeniden okusun (fiş başlığı)
    if ((prev?.ad ?? null) !== parsed.ad || (prev?.kod ?? null) !== parsed.kod) new Effects().emit({ topic: 'settings', kind: 'merkez', message: 'Şube bilgisi değişti' }).flush();
    takeRemoteUpdate(parsed.guncelleIstek, now);
    return true;
  } catch (e) {
    lastError = e instanceof Error ? e.message : String(e);
    return false;
  }
}

export function startMerkez(): NodeJS.Timeout[] {
  if (!merkezEnabled()) return [];
  identity();
  return [setTimeout(() => void merkezBeat(), 10_000), setInterval(() => void merkezBeat(), MERKEZ_BEAT_MS)];
}
