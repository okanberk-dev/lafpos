import { randomBytes } from 'node:crypto';
import { type LicenseRecord, type LicenseView, licenseState, salesAllowed } from '@shared/lisans';
import { REMOTE_SHOP } from '@shared/remote-reports';
import { db } from '../db/client';
import { env } from '../env';
import { getOpenDay } from '../services/orders';
import { HttpError } from '../lib/http';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { installedVersion, readUpdateStatus } from '../lib/surum';

/**
 * Merkez (docs/KALANLAR.md, docs/07-UZAKTAN-ERISIM.md §4 "Merkez"): kurulum ilk açılışta kimlik ve gizli anahtar
 * üretir; internete ilk çıktığında Merkez'e kendini bildirir (ilk görüşte güven, dükkânda kimse anahtar girmez), sonra
 * 5 dakikada bir imzalı nabız: sürüm, güncelleme durumu, gün açık mı. Yanıt lisans kaydı ve çalıştırılacak derleme.
 *
 * Son yanıt saklanır: internet ya da Merkez yokken kasa son geçerli kayıtla ve kendi saatiyle çalışır. Merkez adresi
 * yoksa (LAFPOS_MERKEZ_URL ya da LAFPOS_CLOUD_URL tanımsız, ya da LAFPOS_MERKEZ_URL=0) lisans uygulanmaz ve
 * güncelleyici eskisi gibi kanalın son sürümünü izler.
 */
export const MERKEZ_BEAT_MS = 5 * 60_000;
const IDENTITY = 'merkez.kimlik';
const LAST = 'merkez.son';

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
  at: number;
}

export const merkezEnabled = () => !!env.merkezUrl;

/** Kurulum kimliği: ilk okumada üretilir ve hep aynı kalır (yedekten dönüşte de; gün sonu verisiyle birlikte) */
export function identity(now = Date.now()): Identity {
  const existing = getSyncState<Identity>(IDENTITY);
  if (existing?.id && existing.key) return existing;
  const fresh: Identity = { id: randomBytes(12).toString('hex'), key: randomBytes(32).toString('base64url'), createdAt: now, registered: false };
  setSyncState(IDENTITY, fresh);
  return fresh;
}

export const merkezLast = () => getSyncState<MerkezLast>(LAST);

/**
 * Uzaktan özet ve raporların dükkân kimliği: Merkez'e bağlı kasada kurulum kimliği, değilse `default` (eski anahtarlar).
 * Kimlik değişince rapor gönderimi geçmişi baştan iter (server/sync/cloud-reports.ts)
 */
export const remoteShop = () => (merkezEnabled() ? identity().id : REMOTE_SHOP);

/** Kasanın şimdiki lisans durumu; Merkez kapalıysa null (uygulanmaz) */
export function licenseNow(now = Date.now()): LicenseView | null {
  if (!merkezEnabled()) return null;
  return licenseState(merkezLast()?.lisans, { installedAt: identity(now).createdAt, now });
}

/** Yeni satış (adisyon açma, kalem ekleme) öncesi: lisans kapalıysa durur. Tahsilat, kayıtlar ve raporlar açık */
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
    at: now,
  };
}

/** Bir nabız: gerekiyorsa önce kayıt; yanıt saklanır. Hata durumu korur (internetsiz kasa çalışır) */
export async function merkezBeat(now = Date.now()): Promise<boolean> {
  if (!merkezEnabled()) return false;
  const me = identity(now);
  const inst = installedVersion();
  try {
    if (!me.registered) {
      const res = await fetch(new URL('/api/merkez/kayit', env.merkezUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: me.id, anahtar: me.key, surum: inst.version, build: inst.build, kurulus: me.createdAt }),
        signal: AbortSignal.timeout(8000),
        redirect: 'error',
      });
      if (!res.ok) throw new Error(`Merkez kaydı alınmadı (${res.status})`);
      setSyncState(IDENTITY, { ...me, registered: true });
    }
    const upd = readUpdateStatus();
    const url = new URL('/api/merkez/nabiz', env.merkezUrl);
    const body = {
      surum: inst.version,
      build: inst.build,
      gunAcik: !!getOpenDay(db),
      guncelleme: upd ? { durum: upd.durum, mesaj: upd.mesaj, yeni: upd.yeni } : null,
    };
    const res = await signedFetch(me.key, 'POST', url, body, 8000, { 'x-laf-kurulum': me.id });
    // Kayıt Merkez'de silindiyse (Redis sıfırlandı) bir sonraki nabız yeniden kaydolur
    if (res.status === 404) setSyncState(IDENTITY, { ...me, registered: false });
    const parsed = res.status === 200 ? parseBeat(res.json, now) : null;
    if (!parsed) throw new Error(`Merkez yanıt vermedi (${res.status})`);
    setSyncState(LAST, parsed);
    lastOk = now;
    lastError = null;
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
