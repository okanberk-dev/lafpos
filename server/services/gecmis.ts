import { and, gte, lte } from 'drizzle-orm';
import type { HistoryDay, HistoryProducts } from '@shared/gecmis';
import { db, schema } from '../db/client';
import { trainingMode } from '../lib/settings';
import { historyStore } from '../sync/modpos';

/**
 * Kasadaki geçmiş ciro (LafPOS öncesi, ModPOS; server/sync/modpos.ts `historyStore`) bir dönemde nerede geçer. Geçmiş
 * günü yalnız LafPOS'ta gerçek iş günü olmayan, bugünden önceki tarihte geçer:
 * - o tarihte iş günü hiç yoksa geçmiş günü yazılır;
 * - varsa ve hepsi deneme günüyse (eğitimde ya da işaretten önce kapanmış: `trainingDay` true/null) ve kasa gerçek
 *   kullanımdaysa geçmiş günü o deneme günlerinin yerine geçer (`replaced`: raporlar o günlerin adisyonlarını okumaz);
 * - gerçek iş günü (`trainingDay` false) ya da açık gün varsa LafPOS'unki kalır.
 * Kurulum modunda deneme günleri kendi aralarında sayılır (patron panelinin kıyası gibi): geçmiş yalnız boş tarihe yazılır.
 * İş günü, Z zinciri ve lafmaliyet'e giden gün paketi bunu hiç okumaz.
 */
export interface HistoryIn {
  kaynak: string;
  /** Kaydın anı (değişince Uzaktan'a yeniden gider) */
  at: number;
  /** Dönemde geçen geçmiş günleri, tarih sırasıyla */
  days: HistoryDay[];
  /** Geçmiş gününün yerine geçtiği deneme iş günlerinin tarihleri */
  replaced: string[];
  /** Dönemin bugünden önceki bütün geçmiş günleri (ürün bloğunun "tam" denetimi) */
  inRange: HistoryDay[];
  urunler?: HistoryProducts;
}

export function historyFor(range: { from: string; to: string }, today: string): HistoryIn | null {
  const store = historyStore();
  if (!store) return null;
  const inRange = store.gunler.filter((d) => d.date >= range.from && d.date <= range.to && d.date < today);
  if (!inRange.length) return null;
  const rows = db
    .select({ date: schema.businessDays.date, trainingDay: schema.businessDays.trainingDay, closedAt: schema.businessDays.closedAt })
    .from(schema.businessDays)
    .where(and(gte(schema.businessDays.date, inRange[0]!.date), lte(schema.businessDays.date, inRange.at(-1)!.date)))
    .all();
  const byDate = new Map<string, typeof rows>();
  for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r]);
  const live = !trainingMode();
  const days: HistoryDay[] = [];
  const replaced: string[] = [];
  for (const d of inRange) {
    const own = byDate.get(d.date);
    if (!own) days.push(d);
    else if (live && own.every((r) => r.closedAt != null && r.trainingDay !== false)) {
      days.push(d);
      replaced.push(d.date);
    }
  }
  return { kaynak: store.kaynak, at: store.at, days, replaced, inRange, ...(store.urunler ? { urunler: store.urunler } : {}) };
}
