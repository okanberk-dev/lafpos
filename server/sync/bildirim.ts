import { eq } from 'drizzle-orm';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { db, schema } from '../db/client';
import { env } from '../env';
import { onInternetBack } from '../lib/internet';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { cloudEnabled } from './cloud';

/**
 * Patrona telefon bildirimi (docs/07-UZAKTAN-ERISIM.md §4 "Bildirimler"): kasa önemli olayı LafPOS Uzaktan'a imzalı
 * iter, site patronun telefonuna Web Push atar (api/_bildirim.ts). Olaylar: büyük iptal ya da ikram (eşik üstü), gün
 * sonunda kasa farkı (eşik üstü), uzun internet kesintisi (dönünce, süresiyle), Pavo gün sonu alınamadı. Güncelleme
 * sorununu Merkez nabızdan kendisi görür. Ayar Yönetim › Ağ ve uzaktan erişim › Telefon bildirimleri; LafPOS Uzaktan
 * kurulu değilse hiçbir şey gitmez. İnternet yokken olay kuyrukta bekler (en çok 20, bir günden eskisi düşer) ve
 * internet dönünce gider. Bildirimde müşteri adı ve telefonu, maliyet yok; tutar ve personel adı var (patronun telefonu).
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
}

export const NOTIFY_DEFAULTS: NotifySettings = { enabled: true, voidMin: 50_000, compMin: 50_000, cashDiffMin: 10_000, internetMin: 15, pavo: true };
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
  kind: 'iptal' | 'ikram' | 'kasa-farki' | 'internet' | 'pavo' | 'deneme';
  title: string;
  body: string;
  at: number;
}

/** Bildirim gidebilir mi: Uzaktan kurulu ve ayar açık */
export const notifyReady = () => cloudEnabled() && notifySettings().enabled;

async function send(n: Notice): Promise<boolean> {
  const shop = getSettings().businessName || null;
  try {
    const res = await signedFetch(env.cloudSecret, 'POST', new URL('/api/uzaktan/bildirim', env.cloudUrl), { ...n, shop }, 8000);
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Olayı gönderir; gidemezse kuyruğa alır. Kasa işlemini hiç bekletmez (çağıran beklemez) */
export async function notify(n: Omit<Notice, 'at'> & { at?: number }): Promise<void> {
  if (!notifyReady()) return;
  const notice: Notice = { ...n, at: n.at ?? Date.now() };
  if (await send(notice)) return;
  const queue = (getSyncState<Notice[]>(QUEUE) ?? []).filter((q) => Date.now() - q.at < QUEUE_TTL_MS);
  setSyncState(QUEUE, [...queue, notice].slice(-QUEUE_MAX));
}

/** Kuyruktakileri sırayla gönderir (internet dönünce); gidemeyen kalır */
export async function flushNotices(): Promise<number> {
  const queue = (getSyncState<Notice[]>(QUEUE) ?? []).filter((q) => Date.now() - q.at < QUEUE_TTL_MS);
  if (!queue.length || !notifyReady()) return 0;
  let sent = 0;
  for (const n of queue) {
    if (!(await send(n))) break;
    sent++;
  }
  setSyncState(QUEUE, queue.slice(sent));
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
  const value = items.filter((i) => (kind === 'iptal' ? i.voided : i.complimentary && !i.voided)).reduce((a, i) => a + i.qty * i.unitPrice, 0);
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

/** İnternet döndü: kesinti eşikten uzunsa süresiyle, sonra kuyruktakiler */
export function startNotices(): () => void {
  return onInternetBack((downSince) => {
    const minutes = Math.round((Date.now() - downSince) / 60_000);
    void (async () => {
      await flushNotices();
      if (downSince > 0 && minutes >= notifySettings().internetMin) {
        await notify({ kind: 'internet', title: `İnternet ${minutes} dakika yoktu`, body: `${fmtTime(downSince)} ile ${fmtTime(Date.now())} arası; satış sürdü, bekleyenler gönderiliyor` });
      }
    })();
  });
}
