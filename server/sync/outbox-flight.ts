import { and, eq, isNull } from 'drizzle-orm';
import { type DB, schema, type Tx } from '../db/client';

/**
 * Giden kutusunda o an gönderilmekte olan kayıtlar (istek yolda, yanıt bekleniyor; lafmaliyet'te en çok 15 sn). Aynı
 * günün yenisi kuyruğa girerken ya da gün yeniden açılırken bekleyen kayıt silinir, yoldaki silinmez: yanıtı 200 ise
 * gönderilmiş sayılır (karşı taraf aldı), değilse gönderen onu atar (yenisi ya da açık gün varken). Silinen kaydın 200'ü
 * kaybolursa sonraki gövde aynı sırayla (`revision`) ve aynı düzeltmeyle yeniden giderdi (inceleme, 23 Kasım 2026)
 */
const flying = new Set<number>();

export function takeOff(id: number) {
  flying.add(id);
}

export function land(id: number) {
  flying.delete(id);
}

export const inFlight = (id: number) => flying.has(id);

/** Anahtarın bekleyen (gönderilmemiş) kayıtlarını siler; yoldakini bırakır */
export function dropPending(t: Tx | DB, target: 'lafmaliyet' | 'laffogato', key: string) {
  const rows = t
    .select({ id: schema.outbox.id })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, target), eq(schema.outbox.dedupeKey, key), isNull(schema.outbox.sentAt)))
    .all();
  for (const r of rows) if (!flying.has(r.id)) t.delete(schema.outbox).where(eq(schema.outbox.id, r.id)).run();
}
