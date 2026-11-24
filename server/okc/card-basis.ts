import { and, eq, gt, isNotNull, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { deviceReceipts } from '../services/days';
import type { PavoEodBatch, PavoEodRecord } from './service';

/**
 * Pavo banka gün sonunun LafPOS tarafı: günün başarılı gün sonları ve LafPOS'un kıyas tutarı. Cihaz koduna (okc/service.ts)
 * ve lafmaliyet gövdesine (sync/lafmaliyet.ts `bankPos.batches`, `bankPos.dayCard`) ortak; service.ts gövde kuyruğunu
 * çağırdığı için gövde bu kuralları buradan okur (döngüsel içe aktarma olmasın)
 */

/** Kaydın gününde alınmış başarılı gün sonları: öncekiler ve kaydın kendisi (alındıysa) */
export function batchesOf(rec: PavoEodRecord | null | undefined): PavoEodBatch[] {
  if (!rec) return [];
  const list = [...(rec.earlier ?? [])];
  if (rec.status === 'ok' && !list.some((b) => b.batchNo && b.batchNo === rec.batchNo)) {
    // Eski kayıtta `dayClosed` yok: kapalı sayılır (otomatik deneme ikinci kez gönderilmez)
    list.push({ batchNo: rec.batchNo, deviceDateTime: rec.deviceDateTime, grandTotalKurus: rec.grandTotalKurus, at: rec.at, trigger: rec.trigger, dayClosed: rec.dayClosed ?? true });
  }
  return list;
}

/**
 * LafPOS'un kıyas tutarı (`PavoEodRecord.dayCardKurus`). Günün ilk gün sonu: kapanmış günün kart toplamı (Z'nin kart
 * alanı ve kartla alınan bahşiş: bankaya giden tutar). Aynı günün sonraki gün sonu (gün yeniden açılıp kapandı ya da
 * gün içinde elle alındı): önceki gün sonundan sonra alınan, iade edilmemiş kart ödemeleri; günün bütün kartıyla
 * kıyaslamak her seferinde yanlış "eksik" uyarısı verirdi. İkisine de kartla açık hesap tahsilatı eklenir. Gün açıksa null.
 * Bankanın batch'inde olmayan kart satışı ikisinden de düşer (bahşişiyle, aynı çekimdir): mali fişi yazarkasada
 * kesilmeyen ödeme (yazarkasadan geçmeyen: başka POS'tan ya da "Başka yoldan aldım"; 22.11'de ₺870 "eksik" görünüyordu)
 * ve gün kapandıktan sonra cihazda fişi iptal edilen ödeme (`fis_iptal`: LafPOS'ta ödeme canlı kalır, Z'nin kartında durur)
 */
export function cardBasis(dayId: string | null, earlier: PavoEodBatch[]): { dayCardKurus: number | null; dayCardSinceBatch: string | null } {
  const none = { dayCardKurus: null, dayCardSinceBatch: null };
  if (!dayId) return none;
  const day = db.select({ closedAt: schema.businessDays.closedAt, summary: schema.businessDays.summary }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (!day?.closedAt || !day.summary) return none;
  const prev = earlier.at(-1);
  const p = schema.payments;
  // Kartla açık hesap tahsilatı (siparişsiz ödeme) Z'nin kart alanında yok ama bankaya gider: kıyasa girer
  const collections = (since: number | null) =>
    db
      .select({ amount: p.amount })
      .from(p)
      .where(and(eq(p.dayId, dayId), isNull(p.refundedAt), isNull(p.orderId), eq(p.zField, 'card'), since == null ? undefined : gt(p.createdAt, since)))
      .all()
      .reduce((a, r) => a + r.amount, 0);
  const receipts = deviceReceipts(db, [dayId]);
  const viaDevice = new Set(receipts.flatMap((r) => r.paymentIds));
  const voidedOnDevice = new Set(receipts.filter((r) => r.status === 'fis_iptal').flatMap((r) => r.paymentIds));
  const inBatch = (id: string) => viaDevice.has(id) && !voidedOnDevice.has(id);
  const sales = (since: number | null) =>
    db
      .select({ id: p.id, amount: p.amount, tip: p.tip })
      .from(p)
      .where(and(eq(p.dayId, dayId), isNull(p.refundedAt), isNotNull(p.orderId), eq(p.zField, 'card'), since == null ? undefined : gt(p.createdAt, since)))
      .all();
  if (!prev) {
    const s = day.summary;
    const offBatch = sales(null)
      .filter((r) => !inBatch(r.id))
      .reduce((a, r) => a + r.amount + r.tip, 0);
    return {
      dayCardKurus: (s.byZField?.card ?? 0) + s.payments.filter((x) => x.zField === 'card').reduce((a, x) => a + (x.tips ?? 0), 0) + collections(null) - offBatch,
      dayCardSinceBatch: null,
    };
  }
  const rows = sales(prev.at).filter((r) => inBatch(r.id));
  return { dayCardKurus: rows.reduce((a, r) => a + r.amount + r.tip, 0) + collections(prev.at), dayCardSinceBatch: prev.batchNo };
}
