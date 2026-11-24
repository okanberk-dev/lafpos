import { and, desc, eq, isNotNull, isNull } from 'drizzle-orm';
import { type DB, schema, type Tx } from '../db/client';
import { getSyncState } from '../lib/settings';

/**
 * Kasa zinciri (docs/03-ENTEGRASYON.md §4.6): gün açılırken beklenen nakit önceki gerçek günün devridir. LafPOS'ta gün
 * sonundan sonra teslim yok (teslim gün içinde yazılır, beklenenden düşer): yerel devir günün sayımıdır. lafmaliyet'in
 * değeri (`nextOpening`: kasa raporu varsa sayılan − teslim, yoksa LafPOS'un sayımı) panelde düzeltilen raporu da görür;
 * varsa o geçer. Ağ işi yoktur: lafmaliyet'in değeri gün sonu yanıtından (gönderim kaydı) ve tembel devir okumasından
 * (sync/lafmaliyet.ts `devirIfStale`, sync_state `lafmaliyet.devir`) okunur.
 */

type DayRow = typeof schema.businessDays.$inferSelect;

/** En az bu kadar farkta (kuruş) açılışın nedeni zorunlu: lafmaliyet'in kasa raporu toleransı (1 TL) */
export const OPENING_REASON_MIN = 100;

/** lafmaliyet'in devri (kuruş): gün sonu yanıtında ve `GET /api/panel/pos/devir`'de aynı nesne */
export interface NextOpening {
  amount: number;
  source: 'kasa_raporu' | 'lafpos';
}

/** Tembel devir okumasının durumu (sync_state `lafmaliyet.devir`) */
export interface DevirState {
  /** Sorulan iş günü */
  date: string;
  /** Son deneme (5 dakika bütçesi buna bakar) */
  attemptAt: number;
  /** Son başarılı okuma; yoksa null */
  okAt: number | null;
  /** Son başarılı okumanın değeri (null: lafmaliyet'te gün sayılmadı) */
  nextOpening?: NextOpening | null;
  lastError?: string | null;
}

export interface OpeningExpectation {
  /** Beklenen açılış nakdi (kuruş) */
  amount: number;
  /** `lafmaliyet`: panelin devri; `lafpos`: kasanın kendi sayımı */
  source: 'lafmaliyet' | 'lafpos';
  /** lafmaliyet'in kaynağı (yalnız `source: 'lafmaliyet'`) */
  ladminSource?: NextOpening['source'];
  /** Devrin geldiği gün */
  fromDate: string;
  fromZNo: number;
  fromDayId: string;
}

/**
 * Devrin günü: en son kapanan gün (Z sırasıyla), yalnız gerçek günse (kurulum modu dışında kapandı). Son kapanan gün
 * eğitim günüyse devir yok: aradaki deneme satışları çekmeceyi değiştirdi
 */
export function lastClosedRealDay(t: Tx | DB): DayRow | null {
  const last = t.select().from(schema.businessDays).where(isNotNull(schema.businessDays.closedAt)).orderBy(desc(schema.businessDays.zNo), desc(schema.businessDays.closedAt)).get();
  return last && last.trainingDay === false ? last : null;
}

/** Günün lafmaliyet'e gitmeyi bekleyen kaydı var mı (yeniden sayım ya da yeniden kapanış henüz gitmedi) */
export function dayPushPending(t: Tx | DB, date: string): boolean {
  return !!t
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.dedupeKey, `gun:${date}`), isNull(schema.outbox.sentAt)))
    .get();
}

/** TL'den kuruşa (lafmaliyet iki ondalıklı TL gönderir) */
export const kurusOf = (tl: number) => Math.round(tl * 100);

/**
 * lafmaliyet'in bu güne söylediği en yeni devir: günün kendi 200 almış gönderim kaydının yanıtı (en yenisi) ile tembel
 * okumanın değerinden hangisi daha yeniyse. `undefined`: lafmaliyet bu gün için bir şey söylemedi (eski panel, hiç
 * gönderilmedi); `null`: gün lafmaliyet'te sayılmamış
 */
function ladminNextOpening(t: Tx | DB, date: string): { value: NextOpening | null; at: number } | undefined {
  const sent = t
    .select({ response: schema.outbox.response, sentAt: schema.outbox.sentAt })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'lafmaliyet'), eq(schema.outbox.dedupeKey, `gun:${date}`), isNotNull(schema.outbox.sentAt)))
    .orderBy(desc(schema.outbox.sentAt), desc(schema.outbox.id))
    .get();
  const answer = sent?.response as { at?: number; nextOpening?: { amount: number; source: NextOpening['source'] } | null } | null | undefined;
  const fromAnswer = answer && 'nextOpening' in answer && answer.nextOpening !== undefined
    ? { value: answer.nextOpening ? { amount: kurusOf(answer.nextOpening.amount), source: answer.nextOpening.source } : null, at: answer.at ?? sent?.sentAt ?? 0 }
    : undefined;
  const devir = getSyncState<DevirState>('lafmaliyet.devir');
  const fromDevir = devir && devir.date === date && devir.okAt != null && devir.nextOpening !== undefined ? { value: devir.nextOpening ?? null, at: devir.okAt } : undefined;
  if (fromAnswer && fromDevir) return fromDevir.at > fromAnswer.at ? fromDevir : fromAnswer;
  return fromAnswer ?? fromDevir;
}

/**
 * Açılacak günün beklenen açılış nakdi; bilinmiyorsa null (gerçek gün yok, son gün eğitim günü, sayılmamış ve
 * lafmaliyet bir şey söylemedi). Günün gönderilmemiş kaydı varsa (yeniden sayım yolda) lafmaliyet eski günü biliyordur:
 * yerel sayım geçer
 */
export function expectedOpening(t: Tx | DB): OpeningExpectation | null {
  const day = lastClosedRealDay(t);
  if (!day) return null;
  const from = { fromDate: day.date, fromZNo: day.zNo, fromDayId: day.id };
  const ladmin = dayPushPending(t, day.date) ? undefined : ladminNextOpening(t, day.date);
  if (ladmin?.value) return { amount: ladmin.value.amount, source: 'lafmaliyet', ladminSource: ladmin.value.source, ...from };
  if (day.countedCash != null) return { amount: day.countedCash, source: 'lafpos', ...from };
  return null;
}
