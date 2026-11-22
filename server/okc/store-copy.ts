import { randomUUID } from 'node:crypto';
import { and, eq, gte, lt, or } from 'drizzle-orm';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { type DB, db, schema, type Tx, tx } from '../db/client';
import { type Actor, blindOrder, needDirect, seesStaffOf } from '../lib/auth';
import { Effects } from '../lib/effects';
import { conflict, notFound } from '../lib/http';
import { getSettings } from '../lib/settings';
import { getOpenDay, getOrderDTO, loadOrder } from '../services/orders';

/**
 * Cihaz ödemesinin işyeri nüshası (docs/04-YAZARKASA.md §4.1 "Ödeme sonrası fişler"). Nüsha tarayıcıdan, kasa
 * bilgisayarının fiş yazıcısından basılır. Eskiden yalnız canlı olay (`okc.paid`) bastırıyordu: ödeme anında kasa
 * ekranı kapalıysa, yenileniyorsa, kilitliyse ya da canlı bağlantı (SSE) kopuksa nüsha hiç basılmıyordu. Artık
 * basılmamış nüshayı sunucu bilir:
 *
 * - Sepeti nüsha basan kasa ekranı gönderdiyse fişe `bekliyor` yazılır (`sendOrderToDevice`, `storeCopy`).
 * - Cihaz ödeyince (`tamamlandi`) kasa ekranı nüshayı alır: olaydaki fiş kimliğiyle hemen; olayı kaçırdıysa açılışta
 *   ve bağlantı yeniden kurulunca bekleyenleri sorarak. Alma atomiktir: aynı nüshayı iki sekme ya da iki cihaz
 *   isterse yalnız biri alır (`basiliyor`, alanın anahtarıyla), öbürü 409 `copy_taken`.
 * - Basan ekran "basıldı" der (`basildi`, denetim kaydı `okc.store_copy`). Alınıp süresinde basıldı denmeyen nüsha
 *   (ekran basarken kapandı) yeniden verilir.
 * - Yalnız açık günün ödemeleri: gün kapandıysa bekleyen nüsha artık basılmaz. Ayar kapalıysa hiçbiri.
 */

type ReceiptRow = typeof schema.fiscalReceipts.$inferSelect;
const fr = schema.fiscalReceipts;

/** Alınıp bu sürede "basıldı" denmeyen nüsha yeniden verilir (ekran basarken kapandı ya da bağlantı koptu) */
export const STORE_COPY_LEASE_MS = 2 * 60_000;

/** Kasa ekranına verilen nüsha: ekran basar, sonra `claim` ile "basıldı" der */
export interface ClaimedStoreCopy {
  receiptId: string;
  /** Bu alışın anahtarı: "basıldı" onayı yalnız bununla kabul edilir */
  claim: string;
  order: OrderDTO;
  /**
   * Bu fişin LafPOS'a yazdığı ödemeler. Kör kasada da gider: nüsha cihazın aldığını yazar ve aynı döküm (tür, tutar)
   * `okc.paid` olayıyla zaten her ekrana gidiyor; adisyonun öteki ödemeleri `blindOrder` kuralıyla kalır
   */
  payments: { id: string; methodName: string; amount: number; tip: number; userName: string | null }[];
  device: { receiptNo: number | null; zNo: number | null; docKind: string | null; docId: string | null };
  /** Ödemenin anı: nüsha geç basılsa da ödemenin saatini yazar */
  at: number;
}

/** Verilebilir nüsha: açık günde tamamlanmış cihaz ödemesi; basılmayı bekliyor ya da alınıp süresinde basılmamış */
function claimable(now: number, dayOpenedAt: number) {
  return and(
    eq(fr.status, 'tamamlandi'),
    gte(fr.completedAt, dayOpenedAt),
    or(eq(fr.storeCopy, 'bekliyor'), and(eq(fr.storeCopy, 'basiliyor'), lt(fr.storeCopyAt, now - STORE_COPY_LEASE_MS))),
  );
}

/** Nüshaların verildiği günün açılışı; gün kapalıysa ya da "Ödeme sonrası işyeri nüshası" kapalıysa null */
function copiesSince(t: Tx | DB): number | null {
  if (!getSettings().receiptStoreCopy) return null;
  return getOpenDay(t)?.openedAt ?? null;
}

/** Basılmayı bekleyen nüshalar, ödeme sırasıyla (kasa ekranı açılınca ve canlı bağlantı yeniden kurulunca sorar) */
export function pendingStoreCopies(now = Date.now()): { id: string; orderId: string; completedAt: number | null }[] {
  const since = copiesSince(db);
  if (since == null) return [];
  return db.select({ id: fr.id, orderId: fr.orderId, completedAt: fr.completedAt }).from(fr).where(claimable(now, since)).orderBy(fr.completedAt).all();
}

/**
 * Nüshayı bu ekrana verir (atomik: koşullu tek güncelleme). Başka ekran aldıysa, basıldıysa ya da artık basılmayacaksa
 * 409 `copy_taken`; ekran o nüshayı basmaz
 */
export function claimStoreCopy(actor: Actor, receiptId: string, now = Date.now()): ClaimedStoreCopy {
  needDirect(actor, 'odeme.al');
  const claim = randomUUID();
  const fx = new Effects();
  const row = tx((t) => {
    const before = t.select().from(fr).where(eq(fr.id, receiptId)).get();
    if (!before) throw notFound('Cihaz sepeti');
    const since = copiesSince(t);
    if (since == null) return null;
    const taken = t
      .update(fr)
      .set({ storeCopy: 'basiliyor', storeCopyClaim: claim, storeCopyAt: now })
      .where(and(eq(fr.id, receiptId), claimable(now, since)))
      .run().changes;
    if (!taken) return null;
    if (before.storeCopy === 'basiliyor') {
      // Önceki ekran aldı ama basıldı demedi (basarken kapandı ya da onayı ulaşmadı): iki kez basılmış olabilir
      fx.audit(t, {
        userId: actor.user.id,
        action: 'okc.store_copy',
        orderId: before.orderId,
        entity: 'fiscal_receipt',
        entityId: before.id,
        amount: before.amount,
        message: `#${loadOrder(t, before.orderId).no} adisyonun işyeri nüshası yeniden basılıyor: önceki ekran ${STORE_COPY_LEASE_MS / 60_000} dk içinde basıldığını bildirmedi, iki kez basılmış olabilir`,
      });
    }
    return before;
  });
  if (!row) throw conflict('Bu işyeri nüshası başka bir ekranda basıldı ya da artık basılmıyor', 'copy_taken');
  fx.emit({ topic: 'okc', kind: 'okc.store_copy' });
  fx.flush();
  return printable(actor, row, claim);
}

/**
 * Nüsha basıldı. Yalnız alan ekranın anahtarıyla; yanıtı kaybolan onayın tekrarı kaydı tekrarlamaz. Anahtar tutmuyorsa
 * (süresi geçti, nüsha başka ekrana verildi) 409 `copy_taken`
 */
export function storeCopyPrinted(actor: Actor, receiptId: string, claim: string, now = Date.now()): { ok: true } {
  needDirect(actor, 'odeme.al');
  const fx = new Effects();
  const outcome = tx((t) => {
    const r = t.select().from(fr).where(eq(fr.id, receiptId)).get();
    if (!r) throw notFound('Cihaz sepeti');
    if (r.storeCopyClaim !== claim) return 'gone' as const;
    if (r.storeCopy === 'basildi') return 'again' as const;
    if (r.storeCopy !== 'basiliyor') return 'gone' as const;
    t.update(fr)
      .set({ storeCopy: 'basildi', storeCopyAt: now })
      .where(and(eq(fr.id, receiptId), eq(fr.storeCopy, 'basiliyor'), eq(fr.storeCopyClaim, claim)))
      .run();
    const late = r.completedAt != null ? Math.floor((now - r.completedAt) / 60_000) : 0;
    fx.audit(t, {
      userId: actor.user.id,
      action: 'okc.store_copy',
      orderId: r.orderId,
      entity: 'fiscal_receipt',
      entityId: r.id,
      amount: r.amount,
      message: `#${loadOrder(t, r.orderId).no} adisyonun işyeri nüshası ${late >= 1 ? `ödemeden ${late} dk sonra ` : ''}basıldı (yazarkasa ödemesi ${tl(r.amount)})`,
    });
    return 'ok' as const;
  });
  if (outcome === 'gone') throw conflict('Bu işyeri nüshası başka bir ekrana verildi', 'copy_taken');
  if (outcome === 'ok') {
    fx.emit({ topic: 'okc', kind: 'okc.store_copy' });
    fx.flush();
  }
  return { ok: true };
}

/** Nüshanın çıktısı için: adisyon (kişiye göre süzülmüş), bu fişin ödemeleri, cihazın fiş ve Z no'su, ödeme anı */
function printable(actor: Actor, r: ReceiptRow, claim: string): ClaimedStoreCopy {
  const full = getOrderDTO(db, r.orderId);
  // Ödemeyi alan kişi: kapanmış adisyonda yalnız kendi adisyonunu ya da personel tutarlarını görene (blindOrder gibi)
  const staff = full.status === 'acik' || seesStaffOf(actor.user, full.waiterId);
  const result = r.result as { docKind?: string | null; docId?: string | null } | null;
  return {
    receiptId: r.id,
    claim,
    order: blindOrder(actor.user, full),
    payments: full.payments
      .filter((p) => r.paymentIds.includes(p.id))
      .map((p) => ({ id: p.id, methodName: p.methodName, amount: p.amount, tip: p.tip, userName: staff ? p.userName : null })),
    device: { receiptNo: r.receiptNo, zNo: r.zNo, docKind: result?.docKind ?? null, docId: result?.docId ?? null },
    at: r.completedAt ?? Date.now(),
  };
}
