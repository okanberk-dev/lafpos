import { type LiveEvent, SITE_EVENT } from '@shared/events';
import type { Permission } from '@shared/permissions';
import { ONLINE_ALERT_MAX_AGE_MS, type OnlineAlertDTO, type SiteAlertsDTO } from '@shared/site-alerts';

/**
 * Diğer sistemlerden gelen uyarıların kuralları (DOM'a dokunmaz; çizim ve ses src/components/SiteInbox.tsx'te,
 * testler doğrudan çağırır). docs/03-ENTEGRASYON.md §2.5 "Sesli uyarılar"
 *
 * - Yeni online sipariş (uygulama, web, masa QR): sitenin panelindeki zil gibi 3 saniyede bir çalar; bu cihazda
 *   "Gördüm" denince (24 saat hatırlanır), sipariş açılınca, aşaması değişince (bar "Hazırlanıyor", sitede ya da
 *   köşkte değişti), siteden kalkınca ya da ödemesinden 4 saat geçince susar. Masa siparişi daha yüksek.
 * - Siteden kalkan sipariş: tek sakin nota ve bildirim.
 * - Sitedeki karaoke: yeni rezervasyon bir kez zil, iptal inen ses, saati değişen tek nota; üçü de bildirimle.
 */

// ─── Cihaz tercihleri (saklama src/lib/alertPrefs.ts) ─────────────────────

export interface AlertPrefs {
  /** Bütün uyarı sesleri (kapalıyken şerit ve bildirim yine görünür) */
  sound: boolean;
  /** 0..1 */
  volume: number;
  /** Online sipariş (uygulama, web, masa QR): yeni gelince zil, siteden kalkınca sakin ses */
  online: boolean;
  /** Sitedeki karaoke rezervasyonu: yeni, iptal, saati değişen */
  karaoke: boolean;
}

export const ALERT_PREFS_DEFAULT: AlertPrefs = { sound: true, volume: 0.8, online: true, karaoke: true };

/** Ses düzeyinin üç adımı (Araçlar'daki seçim); varsayılan Orta */
export const VOLUME_STEPS = [
  { value: 'kisik', label: 'Kısık', volume: 0.35 },
  { value: 'orta', label: 'Orta', volume: 0.8 },
  { value: 'yuksek', label: 'Yüksek', volume: 1 },
] as const;
export type VolumeStep = (typeof VOLUME_STEPS)[number]['value'];

/** Kayıtlı düzeye en yakın adım */
export function volumeStep(volume: number): VolumeStep {
  let best: (typeof VOLUME_STEPS)[number] = VOLUME_STEPS[1];
  for (const s of VOLUME_STEPS) if (Math.abs(s.volume - volume) < Math.abs(best.volume - volume)) best = s;
  return best.value;
}

const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

/** Saklanan metni okur; bozuk ya da eksik alan varsayılanına döner */
export function parseAlertPrefs(raw: string | null): AlertPrefs {
  if (!raw) return ALERT_PREFS_DEFAULT;
  let v: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return ALERT_PREFS_DEFAULT;
    v = parsed as Record<string, unknown>;
  } catch {
    return ALERT_PREFS_DEFAULT;
  }
  const volume = typeof v.volume === 'number' && Number.isFinite(v.volume) ? Math.min(1, Math.max(0, v.volume)) : ALERT_PREFS_DEFAULT.volume;
  return {
    sound: bool(v.sound, ALERT_PREFS_DEFAULT.sound),
    volume,
    online: bool(v.online, ALERT_PREFS_DEFAULT.online),
    karaoke: bool(v.karaoke, ALERT_PREFS_DEFAULT.karaoke),
  };
}

// ─── Online sipariş zili ────────────────────────────────────────────────────

/** Sitenin zil döngüsü (`RING_CYCLE_MS`) */
export const RING_CYCLE_MS = 3000;
/** Masa siparişi tam düzeyde, diğerleri biraz kısık (sitenin `RING_LEVEL_TABLE` / `RING_LEVEL_OTHER`) */
export const RING_LEVEL_TABLE = 1;
export const RING_LEVEL_OTHER = 0.8;
/** Bu cihazdaki "Gördüm" bu kadar hatırlanır */
export const ACK_KEEP_MS = 24 * 3600_000;
export const ACKS_KEY = 'lafpos.pref.siteAlerts.acks';

/** Kim neyi duyar: online siparişi siparişi alan ya da bar; karaokeyi siparişi alan ya da rezervasyoncu */
export interface AlertPerms {
  online: boolean;
  karaoke: boolean;
}

export function alertPerms(can: (p: Permission) => boolean): AlertPerms {
  return { online: can('siparis.al') || can('mutfak.ekran'), karaoke: can('siparis.al') || can('rezervasyon.yonet') };
}

/** Bu cihazın "Gördüm"leri: sipariş → an (ms) */
export type Acks = Record<string, number>;

/** Saklanan metni okur; 24 saatten eski ve bozuk kayıt düşer */
export function parseAcks(raw: string | null, now: number): Acks {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const out: Acks = {};
    for (const [id, at] of Object.entries(v as Record<string, unknown>)) {
      if (typeof at === 'number' && Number.isFinite(at) && now - at < ACK_KEEP_MS && at <= now + ACK_KEEP_MS) out[id] = at;
    }
    return out;
  } catch {
    return {};
  }
}

/** "Gördüm" ekler, eskileri atar */
export function addAcks(acks: Acks, ids: readonly string[], now: number): Acks {
  const out: Acks = {};
  for (const [id, at] of Object.entries(acks)) if (now - at < ACK_KEEP_MS) out[id] = at;
  for (const id of ids) out[id] = now;
  return out;
}

/**
 * Çalan online siparişler, en eskisi önce: yetki ve tercih açık, bu cihazda "Gördüm" denmemiş, ekranda açık değil
 * (`openOrderId`), ödemesinden 4 saat geçmemiş. Sunucu yalnız açık ve "yeni" aşamadakini gönderir.
 */
export function pendingOnline(data: Pick<SiteAlertsDTO, 'online'> | undefined, acks: Acks, prefs: Pick<AlertPrefs, 'online'>, perms: Pick<AlertPerms, 'online'>, now: number, openOrderId?: string | null): OnlineAlertDTO[] {
  if (!data || !perms.online || !prefs.online) return [];
  return data.online
    .filter((o) => !acks[o.orderId] && o.orderId !== openOrderId && now - o.openedAt < ONLINE_ALERT_MAX_AGE_MS)
    .sort((a, b) => a.openedAt - b.openedAt || (a.orderId < b.orderId ? -1 : 1));
}

/** Zilin düzeyi: cihazın ses düzeyi, bekleyenlerden biri masa siparişiyse tam, değilse biraz kısık */
export function ringLevel(pending: readonly Pick<OnlineAlertDTO, 'table'>[], volume: number): number {
  return Math.min(1, Math.max(0, volume)) * (pending.some((o) => o.table) ? RING_LEVEL_TABLE : RING_LEVEL_OTHER);
}

/** Bir canlı olayın cihazdaki karşılığı */
export interface AlertCue {
  /** Uyarı listesi yeniden okunsun */
  refetch?: boolean;
  /** Bu siparişin zili bu cihazda sussun (aşaması değişti) */
  ack?: string;
  /** Tek seferlik ses (yeni online siparişin zili döngüdedir, burada değil) */
  sound?: 'ring' | 'iptal' | 'tek';
  toast?: { tone: 'info' | 'warn'; text: string };
}

/**
 * Olay → ses, bildirim, liste yenilemesi. Yetkisi ya da tercihi kapalı uyarı ses ve bildirim vermez; ses kapalıysa
 * (`prefs.sound`) bildirim yine çıkar. İlgisiz olay null.
 */
export function siteEventCue(e: Pick<LiveEvent, 'topic' | 'kind' | 'message' | 'orderId'>, prefs: AlertPrefs, perms: AlertPerms): AlertCue | null {
  const sound = (s: NonNullable<AlertCue['sound']>) => (prefs.sound ? { sound: s } : {});
  if (e.topic === 'orders') {
    if (!perms.online) return null;
    const on = prefs.online;
    switch (e.kind) {
      case SITE_EVENT.onlineNew:
        return { refetch: true, ...(on && e.message ? { toast: { tone: 'info', text: e.message } } : {}) };
      case SITE_EVENT.onlineUpdated:
        return { refetch: true, ...(e.orderId ? { ack: e.orderId } : {}) };
      case SITE_EVENT.onlineStage:
        return { refetch: true };
      case SITE_EVENT.onlineDone:
        return { refetch: true, ...(on && e.message ? { ...sound('tek'), toast: { tone: 'info', text: e.message } } : {}) };
      default:
        return null;
    }
  }
  if (e.topic === 'reservations' && perms.karaoke && prefs.karaoke && e.message) {
    if (e.kind === SITE_EVENT.karaokeNew) return { ...sound('ring'), toast: { tone: 'info', text: `Yeni rezervasyon · ${e.message}` } };
    if (e.kind === SITE_EVENT.karaokeCancelled) return { ...sound('iptal'), toast: { tone: 'warn', text: `Rezervasyon iptal · ${e.message}` } };
    if (e.kind === SITE_EVENT.karaokeMoved) return { ...sound('tek'), toast: { tone: 'info', text: `Rezervasyon değişti · ${e.message}` } };
  }
  return null;
}

/** Şeridin başlığı: "Yeni online sipariş" / "3 yeni online sipariş" */
export const pendingTitle = (n: number) => (n === 1 ? 'Yeni online sipariş' : `${n} yeni online sipariş`);

// ─── Bar ekranıyla çift ses olmasın ─────────────────────────────────────────

let onlineRinger = false;

/** Kabuğun uyarısı online siparişte zil çalıyor mu (SiteInbox takılı, ses ve online uyarı açık) */
export function setOnlineRinger(active: boolean) {
  onlineRinger = active;
}

/** Bar ekranı online fişte kendi sesini çalmasın: kabuğun zili zaten çalıyor */
export function onlineRingActive(): boolean {
  return onlineRinger;
}
