import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { type ClosingPhase, closingKey, closingPhase } from '@shared/closing';
import { tl } from '@shared/money';
import { lineGross } from '@shared/order-calc';
import { fmtTime } from '@shared/time';
import { db, schema } from '../db/client';
import { env } from '../env';
import { internetState, onInternetBack } from '../lib/internet';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { cloudEnabled } from './cloud';

/**
 * Patrona telefon bildirimi (docs/07-UZAKTAN-ERISIM.md §4 "Bildirimler"): kasa önemli olayı AsilPOS Uzaktan'a imzalı
 * iter, site patronun telefonuna Web Push atar (api/_bildirim.ts). Olaylar: büyük iptal ya da ikram (eşik üstü), gün
 * sonunda kasa farkı (eşik üstü), uzun internet kesintisi (dönünce, süresiyle), Pavo gün sonu alınamadı, kapanış
 * saatine 30 dakika kala gün hâlâ açık (`closingNoticeTick`), gün sonu lafmaliyet'e gitmedi (`lafmaliyet`: gövde
 * kurulamadı ya da kalıcı ret; ayrı anahtarı yok, sync/lafmaliyet.ts). Güncelleme sorununu Merkez nabızdan kendisi görür. Ayar
 * Yönetim › Ağ ve uzaktan erişim › Telefon bildirimleri; AsilPOS Uzaktan kurulu değilse hiçbir şey gitmez. İnternet
 * yokken olay kuyrukta bekler (en çok 20, bir günden eskisi düşer) ve internet dönünce gider (kapanış bildirimi
 * kuyruğa girmez, bkz. `closingNoticeTick`). Bildirimde müşteri adı ve telefonu, maliyet yok; tutar ve personel adı var (patronun telefonu).
 */
export interface NotifySettings {
  enabled: boolean;
  /** Tek seferde iptal edilen tutar bu kadar ya da üstüyse (kuruş) */
  voidMin: number;
  /** Tek seferde ikram, ödenmez ya da zayi edilen tutar (kuruş) */
  compMin: number;
  /** Gün sonunda sayılan nakit ile beklenen arasındaki fark (kuruş, iki yönde) */
  cashDiffMin: number;
  /** İnternet en az bu kadar dakika yoksa dönünce haber verilir */
  internetMin: number;
  pavo: boolean;
  /** Kapanış saatine 30 dakika kala gün açıksa (yalnız Ayarlar'da kapanış saati girilince etkili) */
  kapanis: boolean;
}

export const NOTIFY_DEFAULTS: NotifySettings = { enabled: true, voidMin: 50_000, compMin: 50_000, cashDiffMin: 10_000, internetMin: 15, pavo: true, kapanis: true };
const SETTINGS = 'bildirim.ayar';
const QUEUE = 'bildirim.kuyruk';
const QUEUE_MAX = 20;
const QUEUE_TTL_MS = 24 * 3600_000;

export function notifySettings(): NotifySettings {
  return { ...NOTIFY_DEFAULTS, ...(getSyncState<Partial<NotifySettings>>(SETTINGS) ?? {}) };
}

export function setNotifySettings(patch: Partial<NotifySettings>) {
  setSyncState(SETTINGS, { ...notifySettings(), ...patch });
}

export interface Notice {
  /** Kuyruktaki kaydın kimliği (eski kayıtta yok: an, tür ve başlıkla eşlenir) */
  id?: string;
  kind: 'iptal' | 'ikram' | 'kasa-farki' | 'internet' | 'pavo' | 'kapanis' | 'lafmaliyet' | 'deneme';
  title: string;
  body: string;
  at: number;
}

const sameNotice = (a: Notice, b: Notice) => (a.id || b.id ? a.id === b.id : a.at === b.at && a.kind === b.kind && a.title === b.title);
const fresh = (q: Notice) => Date.now() - q.at < QUEUE_TTL_MS;

/** Bildirim gidebilir mi: Uzaktan kurulu ve ayar açık */
export const notifyReady = () => cloudEnabled() && notifySettings().enabled;

/**
 * Gönderimin sonucu: `gitti`; `dus` site bildirimi kabul etmedi (400 biçim, 413 boy: eski sitede yeni tür gibi),
 * yeniden denemek aynı yanıtı alır, kuyrukta bekletilmez ve arkadakileri tıkamaz; `bekle` ağ hatası, 401, 5xx (sonra
 * yeniden denenir)
 */
type SendResult = 'gitti' | 'dus' | 'bekle';

async function send(n: Notice): Promise<SendResult> {
  const shop = getSettings().businessName || null;
  const { id: _id, ...notice } = n;
  try {
    const res = await signedFetch(env.cloudSecret, 'POST', new URL('/api/uzaktan/bildirim', env.cloudUrl), { ...notice, shop }, 8000);
    if (res.status === 200) return 'gitti';
    if (res.status === 400 || res.status === 413) {
      console.warn(`[bildirim] site "${n.kind}" bildirimini kabul etmedi (${res.status}); düşürüldü`);
      return 'dus';
    }
    return 'bekle';
  } catch {
    return 'bekle';
  }
}

/** Olayı gönderir; gidemezse kuyruğa alır. Kasa işlemini hiç bekletmez (çağıran beklemez) */
export async function notify(n: Omit<Notice, 'at'> & { at?: number }): Promise<void> {
  if (!notifyReady()) return;
  const notice: Notice = { ...n, id: randomUUID(), at: n.at ?? Date.now() };
  if ((await send(notice)) !== 'bekle') return;
  const queue = (getSyncState<Notice[]>(QUEUE) ?? []).filter(fresh);
  setSyncState(QUEUE, [...queue, notice].slice(-QUEUE_MAX));
}

let flushing: Promise<number> | null = null;
let flushAgain = false;

/**
 * Kuyruktakileri sırayla gönderir (internet dönünce); gidemeyen kalır. Tek seferde bir boşaltma (internet gidip
 * gelince ikinci çağrı süreni bekler, sonra bir tur daha): aynı bildirim iki kez gitmez. Kuyruk her gönderimden sonra
 * yeniden okunur ve yalnız giden silinir: boşaltma sürerken kuyruğa giren yeni bildirim kaybolmaz
 */
export function flushNotices(): Promise<number> {
  if (flushing) {
    flushAgain = true;
    return flushing;
  }
  flushing = (async () => {
    let total = 0;
    try {
      do {
        flushAgain = false;
        total += await flushOnce();
      } while (flushAgain);
    } finally {
      flushing = null;
    }
    return total;
  })();
  return flushing;
}

async function flushOnce(): Promise<number> {
  const queue = (getSyncState<Notice[]>(QUEUE) ?? []).filter(fresh);
  if (!queue.length || !notifyReady()) return 0;
  let sent = 0;
  for (const n of queue) {
    const result = await send(n);
    if (result === 'bekle') break;
    if (result === 'gitti') sent++;
    setSyncState(QUEUE, (getSyncState<Notice[]>(QUEUE) ?? []).filter((q) => fresh(q) && !sameNotice(q, n)));
  }
  return sent;
}

export const pendingNotices = () => (getSyncState<Notice[]>(QUEUE) ?? []).length;

// ─── Olaylar ────────────────────────────────────────────────────────────────

const userName = (id: string | null | undefined) => (id ? (db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, id)).get()?.name ?? null) : null);

/**
 * İptal ya da ikram sonrası: kalemin (ya da adisyonun) bu işlemle ciro dışına çıkan tutarı eşiği geçtiyse. `before`
 * işlemden önceki iptal/ikram edilmiş tutar: yalnız bu işlemin payı sayılır
 */
export function afterLoss(kind: 'iptal' | 'ikram', orderId: string, before: number, byUserId: string | null) {
  if (!notifyReady()) return;
  const s = notifySettings();
  const after = lossOf(kind, orderId);
  const amount = after.value - before;
  if (amount < (kind === 'iptal' ? s.voidMin : s.compMin) || amount <= 0) return;
  const who = userName(byUserId);
  void notify({
    kind,
    title: kind === 'iptal' ? `Büyük iptal: ${tl(amount)}` : `Büyük ikram: ${tl(amount)}`,
    body: `Adisyon ${after.no}${after.place ? ` · ${after.place}` : ''}${who ? ` · ${who}` : ''}`,
  });
}

/** Adisyonun iptal (ya da ikram, ödenmez, zayi) edilmiş toplam tutarı */
export function lossOf(kind: 'iptal' | 'ikram', orderId: string): { value: number; no: number; place: string | null } {
  const o = db.select().from(schema.orders).where(eq(schema.orders.id, orderId)).get();
  if (!o) return { value: 0, no: 0, place: null };
  const items = db.select().from(schema.orderItems).where(eq(schema.orderItems.orderId, orderId)).all();
  // Denetim kaydının tutarıyla aynı kural (lineGross): bildirim ve kayıt aynı rakamı söyler
  const value = items.filter((i) => (kind === 'iptal' ? i.voided : i.complimentary && !i.voided)).reduce((a, i) => a + lineGross(i), 0);
  const place = o.tableId ? (db.select({ name: schema.tables.name }).from(schema.tables).where(eq(schema.tables.id, o.tableId)).get()?.name ?? null) : null;
  return { value, no: o.no, place };
}

/** Gün sonunda kasa farkı eşiği geçtiyse */
export function afterDayClose(summary: { countedCash: number | null; cashDiff: number | null; expectedCash: number } | null | undefined, zNo: number | null) {
  if (!notifyReady() || !summary || summary.cashDiff == null) return;
  if (Math.abs(summary.cashDiff) < notifySettings().cashDiffMin) return;
  void notify({
    kind: 'kasa-farki',
    title: `Kasa ${summary.cashDiff < 0 ? 'eksik' : 'fazla'}: ${tl(Math.abs(summary.cashDiff))}`,
    body: `Gün sonu${zNo ? ` (Z ${zNo})` : ''}: beklenen ${tl(summary.expectedCash)}, sayılan ${tl(summary.countedCash ?? 0)}`,
  });
}

/** Pavo gün sonu alınamadı ya da sonucu belirsiz */
export function afterDeviceEod(rec: { status: string; message?: string | null } | null | undefined) {
  if (!notifyReady() || !notifySettings().pavo || !rec || (rec.status !== 'failed' && rec.status !== 'unknown')) return;
  void notify({
    kind: 'pavo',
    title: rec.status === 'failed' ? 'Pavo gün sonu alınamadı' : 'Pavo gün sonu belirsiz',
    body: `${rec.message ?? 'Cihaz yanıt vermedi'}. Yönetim › Yazarkasa POS'tan yeniden deneyin`,
  });
}

// ─── Kapanış saati ──────────────────────────────────────────────────────────

const CLOSING_STATE = 'bildirim.kapanis';
/** Gidemeyen kapanış bildirimi en sık bu arayla yeniden denenir (site yanıt vermiyorsa dakikada bir istek gitmesin) */
const CLOSING_RETRY_MS = 5 * 60_000;
let closingBusy = false;
let closingRetryAt = 0;

/** Kapanış bildiriminin metni (kasadaki kartla aynı dil; dükkânın adını başlığa site ekler) */
export function closingNoticeText(phase: NonNullable<ClosingPhase>, closingTime: string, zNo: number): { title: string; body: string } {
  return phase.kind === 'yaklasiyor'
    ? { title: `Kapanışa ${phase.minutesLeft} dk kaldı`, body: `Kapanış ${closingTime} · gün sonu henüz alınmadı (Z ${zNo})` }
    : { title: 'Kapanış saati geçti', body: `Kapanış ${closingTime} · gün hâlâ açık (Z ${zNo})` };
}

/**
 * Kapanış saati hatırlatması patronun telefonuna (dakikada bir; server/jobs.ts). Kural kasadaki kartla aynı
 * (shared/closing.ts): kapanışa 30 dakika kala gün açıksa, yeniden açılan gün 30 dakika sonra. Hatırlatma kimliği
 * başına bir kez (`closingKey`): gün başına bir kez, yeniden açılan günde (ya da kapanış saati değişince) bir kez daha.
 * Ayarlar'da kapanış saati yoksa, bildirim ya da bu tür kapalıysa, Uzaktan kurulu değilse hiçbir şey gitmez.
 *
 * Kuyruğa girmez, metni gittiği an yazılır: internet yokken ya da site yanıt vermezken sonraki turda (en sık 5
 * dakikada bir) o anki durumla yeniden denenir. Böylece bayat bildirim gitmez: internet kapanıştan sonra dönerse
 * "Kapanışa 30 dk kaldı" değil "Kapanış saati geçti" gider, gün o arada kapandıysa hiçbir şey. Gönderildi mi
 */
export async function closingNoticeTick(now = Date.now()): Promise<boolean> {
  if (closingBusy || now < closingRetryAt || !notifyReady() || !notifySettings().kapanis) return false;
  const closingTime = getSettings().closingTime;
  if (!closingTime) return false;
  const day = getOpenDay(db);
  const phase = day ? closingPhase(day, closingTime, now) : null;
  if (!day || !phase) return false;
  const key = closingKey(day, phase.closeAt);
  if (getSyncState<string>(CLOSING_STATE) === key || internetState().state === 'yok') return false;
  closingBusy = true;
  try {
    const result = await send({ id: randomUUID(), kind: 'kapanis', ...closingNoticeText(phase, closingTime, day.zNo), at: now });
    if (result === 'bekle') {
      closingRetryAt = now + CLOSING_RETRY_MS;
      return false;
    }
    closingRetryAt = 0;
    setSyncState(CLOSING_STATE, key);
    return result === 'gitti';
  } finally {
    closingBusy = false;
  }
}

/** İnternet döndü: kesinti eşikten uzunsa süresiyle, sonra kuyruktakiler */
export function startNotices(): () => void {
  return onInternetBack((downSince) => {
    const minutes = Math.round((Date.now() - downSince) / 60_000);
    // Gidemeyen kapanış bildirimi 5 dakikayı beklemez: sonraki dakika turunda o anki durumla gider
    closingRetryAt = 0;
    void (async () => {
      await flushNotices();
      if (downSince > 0 && minutes >= notifySettings().internetMin) {
        await notify({ kind: 'internet', title: `İnternet ${minutes} dakika yoktu`, body: `${fmtTime(downSince)} ile ${fmtTime(Date.now())} arası; satış sürdü, bekleyenler gönderiliyor` });
      }
    })();
  });
}
