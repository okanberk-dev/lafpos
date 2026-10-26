import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { tl } from '@shared/money';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { type Actor, need, needDirect, toAuthUser } from '../lib/auth';
import { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { orderItems, orderPayments } from '../services/dto';
import { addExternalPayments, assertNoActiveRoom, getOpenDay, loadOrder, mergeSelection, refundExternalPayments, splitActive } from '../services/orders';
import { buildBasket, clampPayments, type MethodKind } from './basket';
import { type FiscalProvider, type FiscalResult, providerFor } from './providers';
import type { PendingReceipt } from './providers/types';
import { fromTokenxSale, tokenx, tokenxProvider, webhookUrl } from './providers/tokenx';
import { TokenxError, type TokenxSale } from './tokenx';

/**
 * Yazarkasa POS (ÖKC) bağlantısı. Sağlayıcılar `providers/` altında (Token, eğitim cihazı...); burası markadan
 * bağımsız: adisyon sepet olarak cihaza gider, ödeme ve belge cihazda olur, sonuç (`FiscalResult`) adisyonun
 * ödemesi olarak işlenir. Bekleyen sepet, kilit, zorla iptal ve geç gelen sonuç kuralları her marka için aynıdır.
 */

type ReceiptRow = typeof schema.fiscalReceipts.$inferSelect;
const PENDING = ['gonderildi', 'kilitli'] as const;

export { tokenx, webhookUrl };

export function okcStatus() {
  const s = getSettings();
  const p = providerFor(s.okcProvider);
  return {
    provider: s.okcProvider,
    mode: s.okcMode,
    sectionMap: s.okcSectionMap,
    operatorMethods: s.okcOperatorMethods,
    active: p ? { label: p.label, configured: p.configured(), capabilities: p.capabilities } : null,
    tokenx: tokenxProvider.status() as { configured: boolean; terminalId: string | null; branchId: string | null; webhookUrl: string | null; webhookSecret: boolean },
    lastError: getSyncState<{ message: string; at: number }>('okc.lastError'),
  };
}

export function receiptDTO(r: ReceiptRow) {
  return {
    id: r.id,
    orderId: r.orderId,
    provider: r.provider,
    mode: r.mode,
    status: r.status,
    amount: r.amount,
    items: r.items,
    zNo: r.zNo,
    receiptNo: r.receiptNo,
    /** Kesilen belge (ortak sonuçtan): tür ve e-belge no; eski kayıtlarda yok */
    docKind: (r.result as Partial<FiscalResult> | null)?.docKind ?? null,
    docId: (r.result as Partial<FiscalResult> | null)?.docId ?? null,
    error: r.error,
    lockedBy: r.lockedBy,
    createdAt: r.createdAt,
    completedAt: r.completedAt,
    basket: r.basket,
  };
}
export type ReceiptDTO = ReturnType<typeof receiptDTO>;

function pendingOf(r: ReceiptRow): PendingReceipt {
  return { id: r.id, status: r.status, mode: r.mode, basket: r.basket as PendingReceipt['basket'], amount: r.amount };
}

function loadReceipt(id: string): ReceiptRow {
  const r = db.select().from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.id, id)).get();
  if (!r) throw notFound('Cihaz sepeti');
  return r;
}

function recordError(message: string) {
  setSyncState('okc.lastError', { message, at: Date.now() });
}

function publish(orderId: string, kind: string, message?: string, byUserId?: string) {
  const fx = new Effects();
  fx.emit({ topic: 'okc', kind, orderId, message, byUserId });
  fx.emit({ topic: 'orders', kind, orderId, byUserId });
  fx.flush();
}

/** Adisyonu (ya da seçilen kalemleri) cihaza gönderir. */
export async function sendOrderToDevice(actor: Actor, orderId: string, selection: { itemId: string; qty: number }[] | null): Promise<ReceiptDTO> {
  needDirect(actor, 'odeme.al');
  const s = getSettings();
  if (s.okcProvider === 'kapali') throw conflict('Yazarkasa POS bağlantısı kapalı (Yönetim › Yazarkasa POS)', 'okc_off');
  const provider: FiscalProvider | null = providerFor(s.okcProvider);
  if (!provider) throw conflict('Bu yazarkasa sağlayıcısı bu sürümde yok (Yönetim › Yazarkasa POS)', 'okc_off');
  if (!provider.configured()) throw conflict(provider.notConfigured, 'okc_not_configured');
  if (s.okcMode === 'liste' ? !provider.capabilities.list : !provider.capabilities.instant) {
    throw conflict(`${provider.label} ${s.okcMode === 'liste' ? 'masada ödeme' : 'kasada ödeme'} modunu desteklemiyor (Yönetim › Yazarkasa POS)`, 'okc_mode');
  }

  const order = loadOrder(db, orderId);
  if (order.status !== 'acik') throw conflict('Adisyon kapalı');
  if (order.extPaid) throw conflict('Bu sipariş sitede ödendi');
  // Oda sayacı çalışırken hesap kapanmaz: cihazda ödenen adisyona sonradan oda ücreti yazılırdı
  assertNoActiveRoom(db, orderId);
  if (!getOpenDay(db)) throw new HttpError(409, 'Gün açılmamış', 'day_closed');
  const pending = db
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, orderId), inArray(schema.fiscalReceipts.status, [...PENDING])))
    .get();
  if (pending) throw conflict('Bu adisyonun cihazda bekleyen sepeti var; önce onu tamamlayın ya da iptal edin', 'okc_pending');
  // Hesap kişilere bölünmüşken kalem seçerek göndermek payları düşürmez (masa eksik öder): paylar Paylaş'tan
  const paidNow = orderPayments(db, orderId).reduce((a, p) => a + (p.refundedAt ? 0 : p.amount), 0);
  if (selection?.length && splitActive(db, order, order.total - paidNow)) {
    throw conflict('Hesap kişilere bölünmüş: payları "Paylaş"tan alın ya da paylaşımı kaldırın', 'split_active');
  }
  const amountPayments = orderPayments(db, orderId).filter((p) => !p.refundedAt && !p.items?.length);
  if (amountPayments.length && !selection?.length) {
    throw conflict('Adisyonda tutar olarak alınmış ödeme var. Kalanı LafPOS\'ta alın ya da "Kalem seç" ile cihaza gönderin', 'okc_partial');
  }

  const items = orderItems(db, orderId);
  const table = order.tableId ? db.select().from(schema.tables).where(eq(schema.tables.id, order.tableId)).get() : null;
  const section = table ? db.select().from(schema.sections).where(eq(schema.sections.id, table.sectionId)).get() : null;
  const basketId = randomUUID();
  let built;
  try {
    built = buildBasket({
      basketId,
      orderNo: order.no,
      title: table?.name ?? (order.type === 'tezgah' ? `Tezgâh ${order.no}` : order.deliveryName ? `${order.deliveryName}` : `Adisyon ${order.no}`),
      filter: section?.name ?? (order.type === 'tezgah' ? 'Tezgâh' : order.type === 'paket' ? 'Paket' : 'Gel-al'),
      note: `LafPOS #${order.no}`,
      items,
      totals: order.totals ?? { lineNet: {} },
      selection: selection?.length ? mergeSelection(selection) : null,
      remainingDue: order.total - order.paid,
      sectionMap: s.okcSectionMap,
      sizeLabels: s.sizeLabels,
      callbackUrl: s.okcProvider === 'tokenx' ? (webhookUrl() ?? undefined) : undefined,
    });
  } catch (e) {
    throw bad(e instanceof Error ? e.message : String(e), 'okc_basket');
  }
  const remaining = order.total - order.paid;
  if (built.amount > remaining) throw conflict(`Sepet tutarı (${tl(built.amount)}) kalan tutarı (${tl(remaining)}) aşıyor`, 'okc_amount');

  const now = Date.now();
  db.insert(schema.fiscalReceipts)
    .values({
      id: basketId,
      orderId,
      provider: s.okcProvider,
      mode: s.okcMode,
      terminalId: provider.terminalId(),
      status: 'gonderildi',
      amount: built.amount,
      items: built.lines,
      basket: built.basket,
      sentBy: actor.user.id,
      createdAt: now,
      updatedAt: now,
    })
    .run();

  if (provider.capabilities.transport === 'push') {
    try {
      await provider.send({ id: basketId, status: 'gonderildi', mode: s.okcMode, basket: built.basket, amount: built.amount });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.update(schema.fiscalReceipts).set({ status: 'hata', error: message, updatedAt: Date.now() }).where(eq(schema.fiscalReceipts.id, basketId)).run();
      recordError(message);
      publish(orderId, 'okc.error', message, actor.user.id);
      throw new HttpError(502, `Yazarkasaya gönderilemedi: ${message}`, e instanceof TokenxError ? `tokenx_${e.code ?? 'hata'}` : 'okc_send');
    }
  }
  if (provider.poll) ensurePolling();
  const fx = new Effects();
  fx.audit(db, {
    userId: actor.user.id,
    action: 'okc.send',
    orderId,
    amount: built.amount,
    message: `#${order.no} adisyon yazarkasaya gönderildi (${tl(built.amount)}, ${s.okcProvider === 'simulator' ? 'simülatör' : `${provider.label}, ${s.okcMode === 'anlik' ? 'kasada ödeme' : 'masada ödeme'}`})`,
  });
  fx.flush();
  publish(orderId, 'okc.sent', undefined, actor.user.id);
  return receiptDTO(loadReceipt(basketId));
}

/**
 * Cihazdaki sepeti siler (ödeme alınmadıysa). `force`: internet ya da Token kesintisinde silme isteği gitmiyorsa
 * sepet yetkili onayıyla LafPOS'ta iptal sayılır; yoksa adisyon ödenemez, iptal edilemez, gün kapanmaz (inceleme,
 * 26 Eki 2026). Cihazda yine de ödeme alınırsa geç gelen sonuç `okc.late_paid` alarmı verir.
 */
export async function cancelDeviceBasket(actor: Actor, receiptId: string, force = false): Promise<ReceiptDTO> {
  needDirect(actor, 'odeme.al');
  const approverId = force ? need(actor, 'odeme.iade', 'Cihaza ulaşılamadan sepeti iptal saymak yetkili onayı gerektirir') : null;
  const r = loadReceipt(receiptId);
  if (!PENDING.includes(r.status as (typeof PENDING)[number]) && r.status !== 'hata') throw conflict('Bu sepet artık iptal edilemez');
  let unreachable: string | null = null;
  const provider = providerFor(r.provider);
  if (r.provider !== 'simulator' && r.status !== 'hata') {
    try {
      if (!provider) throw new Error(`${r.provider} bağlantısı bu sürümde yok`);
      await provider.cancel(pendingOf(r));
    } catch (e) {
      // Sepet bu arada ödendiyse sonucu işlemek için durumu sorgula
      await refreshReceipt(r.id).catch(() => undefined);
      const message = e instanceof Error ? e.message : String(e);
      if (!force) throw new HttpError(502, `Cihazdaki sepet silinemedi: ${message}`, 'okc_delete');
      const now = loadReceipt(r.id);
      if (now.status === 'tamamlandi') throw conflict('Sepet bu arada cihazda ödendi; adisyona işlendi', 'okc_paid');
      unreachable = message;
    }
  }
  db.update(schema.fiscalReceipts)
    .set({ status: 'silindi', error: unreachable ? `Cihaza ulaşılamadı, LafPOS'ta iptal sayıldı: ${unreachable}` : null, updatedAt: Date.now() })
    .where(eq(schema.fiscalReceipts.id, r.id))
    .run();
  if (unreachable) {
    const order = loadOrder(db, r.orderId);
    const fx = new Effects();
    fx.audit(db, {
      userId: actor.user.id,
      approverId,
      action: 'okc.force_cancel',
      severity: 'alarm',
      orderId: r.orderId,
      amount: r.amount,
      message: `#${order.no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihaza ulaşılamadan LafPOS'ta iptal sayıldı. Cihazda ödeme alındıysa mali fişi cihazdan iptal edin`,
    });
    fx.flush();
  }
  publish(r.orderId, 'okc.cancelled', unreachable ? "Cihaza ulaşılamadı; sepet LafPOS'ta iptal sayıldı" : 'Cihaz sepeti iptal edildi', actor.user.id);
  return receiptDTO(loadReceipt(r.id));
}

function methodFor(kind: MethodKind, operatorId: number | null): string | null {
  const methods = db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.active, true)).all();
  if (kind === 'yemek' && operatorId != null) {
    const mapped = getSettings().okcOperatorMethods[String(operatorId)];
    if (mapped && methods.some((m) => m.id === mapped)) return mapped;
  }
  const byKind = methods.filter((m) => m.kind === kind).sort((a, b) => a.sort - b.sort)[0];
  if (byKind) return byKind.id;
  return methods.find((m) => m.kind === 'diger' || m.zField === 'other')?.id ?? null;
}

type ResultSource = 'webhook' | 'sorgu' | 'simulator' | 'cihaz';
const DOC_LABEL: Record<string, string> = { okc_fis: 'fiş', bilgi_fisi: 'bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

/** Token sonucunu işler (webhook, sorgu, eğitim cihazı); ortak sonuca çevirip `applyResult`'a verir */
export function applySale(receiptId: string, sale: TokenxSale, source: ResultSource, by?: { userId: string; approverId: string | null }) {
  const r = db.select().from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.id, receiptId)).get();
  if (!r) return;
  applyResult(receiptId, fromTokenxSale(sale, r.amount), source, by);
}

/**
 * Cihaz sonucunu işler (her sağlayıcı). Aynı sonuç birden çok kez gelebilir; işlem tekrarlanmaz.
 * paid = ödendi ve belge kesildi, cancelled = cihazda vazgeçildi, voided = belge cihazda iptal edildi.
 */
export function applyResult(receiptId: string, result: FiscalResult, source: ResultSource, by?: { userId: string; approverId: string | null }) {
  const r = db.select().from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.id, receiptId)).get();
  if (!r) return;
  const now = Date.now();
  const fx = new Effects();
  const doc = [result.zNo != null ? `Z${result.zNo}` : '', result.receiptNo != null ? `${DOC_LABEL[result.docKind ?? 'okc_fis']} ${result.receiptNo}` : '', result.docId ? `${DOC_LABEL[result.docKind ?? 'e_arsiv']} ${result.docId}` : '']
    .filter(Boolean)
    .join(' ');

  if (result.status === 'paid') {
    if (r.status === 'tamamlandi') return;
    if (r.status === 'iptal' || r.status === 'fis_iptal' || r.status === 'silindi') {
      // İptal sayılan sepete geç ya da yeniden gelen "ödendi": adisyon kendiliğinden yeniden kapanmaz, yönetici bakar
      fx.audit(db, {
        userId: by?.userId ?? null,
        action: 'okc.late_paid',
        severity: 'alarm',
        orderId: r.orderId,
        amount: r.amount,
        message: `Yazarkasada iptal sayılan sepet için "ödendi" bildirimi geldi (${tl(r.amount)}, ${source}); cihazdaki fişi kontrol edin`,
      });
      fx.flush();
      return;
    }
    const sender = r.sentBy ? db.select().from(schema.users).where(eq(schema.users.id, r.sentBy)).get() : null;
    const userId = sender?.id ?? 'sistem';
    const payments = clampPayments(result.payments, r.amount)
      .map((p) => ({ methodId: methodFor(p.kind, p.operatorId), amount: p.amount, note: `Yazarkasa${doc ? ` ${doc}` : ''}` }))
      .filter((p): p is { methodId: string; amount: number; note: string } => !!p.methodId);
    try {
      const res = tx((t) => {
        const out = addExternalPayments(t, userId, fx, r.orderId, { payments, items: r.items });
        t.update(schema.fiscalReceipts)
          .set({ status: 'tamamlandi', zNo: result.zNo, receiptNo: result.receiptNo, result, paymentIds: out.paymentIds, completedAt: now, updatedAt: now, error: null })
          .where(eq(schema.fiscalReceipts.id, r.id))
          .run();
        fx.audit(t, {
          userId,
          action: 'okc.paid',
          orderId: r.orderId,
          amount: r.amount,
          message: `#${out.order.no} yazarkasada ödendi: ${tl(r.amount)}${doc ? `, ${doc}` : ''} (${source})`,
        });
        return out;
      });
      fx.emit({ topic: 'okc', kind: 'okc.paid', orderId: r.orderId, message: res.closed ? 'Yazarkasada ödendi, adisyon kapandı' : 'Yazarkasada ödendi' });
      fx.flush();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      db.update(schema.fiscalReceipts).set({ status: 'hata', result, error: `Ödeme alındı ama LafPOS'a işlenemedi: ${message}`, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
      const fx2 = new Effects();
      fx2.audit(db, { action: 'okc.apply_failed', severity: 'alarm', orderId: r.orderId, amount: r.amount, message: `Yazarkasada ${tl(r.amount)} ödendi ama LafPOS'a işlenemedi: ${message}` });
      fx2.emit({ topic: 'okc', kind: 'okc.error', orderId: r.orderId, message });
      fx2.flush();
    }
    return;
  }

  if (result.status === 'voided') {
    if (r.status === 'tamamlandi' && r.paymentIds.length) {
      tx((t) => {
        refundExternalPayments(t, by?.userId ?? null, fx, r.orderId, r.paymentIds, 'Yazarkasada fiş iptal edildi');
        t.update(schema.fiscalReceipts).set({ status: 'fis_iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
        fx.audit(t, {
          userId: by?.userId ?? null,
          approverId: by?.approverId ?? null,
          action: 'okc.void',
          severity: 'alarm',
          orderId: r.orderId,
          amount: r.amount,
          message: `Yazarkasada mali fiş iptal edildi; ${tl(r.amount)} ödeme geri alındı ve adisyon yeniden açıldı`,
        });
      });
    } else {
      db.update(schema.fiscalReceipts).set({ status: 'iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    }
    fx.emit({ topic: 'okc', kind: 'okc.void', orderId: r.orderId, message: 'Yazarkasada fiş iptal edildi' });
    fx.flush();
    return;
  }

  // Cihazda vazgeçildi
  if (r.status === 'tamamlandi') return;
  db.update(schema.fiscalReceipts).set({ status: 'iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
  fx.emit({ topic: 'okc', kind: 'okc.cancelled', orderId: r.orderId, message: 'Cihazda ödemeden vazgeçildi' });
  fx.emit({ topic: 'orders', kind: 'okc.cancelled', orderId: r.orderId });
  fx.flush();
}

export function setLock(receiptId: string, locked: boolean, by?: string | null) {
  const r = db.select().from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.id, receiptId)).get();
  if (!r || !PENDING.includes(r.status as (typeof PENDING)[number])) return;
  db.update(schema.fiscalReceipts)
    .set({ status: locked ? 'kilitli' : 'gonderildi', lockedBy: locked ? (by ?? null) : null, updatedAt: Date.now() })
    .where(eq(schema.fiscalReceipts.id, receiptId))
    .run();
  publish(r.orderId, locked ? 'okc.locked' : 'okc.unlocked', locked ? 'Sepet cihazda açıldı' : undefined);
}

/** Sepetin durumunu sağlayıcıdan sorgular (webhook ulaşmadığında). */
export async function refreshReceipt(receiptId: string) {
  const r = loadReceipt(receiptId);
  const provider = providerFor(r.provider);
  if (!provider?.poll || !provider.configured() || !PENDING.includes(r.status as (typeof PENDING)[number])) return receiptDTO(r);
  const out = await provider.poll(pendingOf(r));
  if (out.kind === 'result') applyResult(r.id, out.result, 'sorgu');
  else if (out.kind === 'deleted') {
    db.update(schema.fiscalReceipts).set({ status: 'silindi', updatedAt: Date.now() }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    publish(r.orderId, 'okc.cancelled', 'Sepet cihazdan silindi');
  } else if (out.locked !== (r.status === 'kilitli')) setLock(r.id, out.locked, out.lockedBy);
  return receiptDTO(loadReceipt(r.id));
}

/** Durumu sorgulanabilen sağlayıcılar (sorgu döngüsü yalnız bunların sepetlerine bakar) */
const POLLED = ['tokenx'] as const;

// ─── Sorgulama döngüsü ──────────────────────────────────────────────────────

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

/** Bekleyen (sorgulanabilir) sepet varken 2,5 sn'de bir (liste modunda 10 sn) durum sorar; kalmayınca durur. */
export function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const pending = db
        .select()
        .from(schema.fiscalReceipts)
        .where(and(inArray(schema.fiscalReceipts.provider, [...POLLED]), inArray(schema.fiscalReceipts.status, [...PENDING])))
        .all();
      if (!pending.length) {
        clearInterval(pollTimer!);
        pollTimer = null;
        return;
      }
      const now = Date.now();
      for (const r of pending) {
        const age = now - r.createdAt;
        if (age > 8 * 3600_000) continue; // 8 saatten eski sepet sorgulanmaz; elle yenilenir
        if (r.mode === 'liste' && (now - r.updatedAt < 10_000 || age < 5_000)) continue;
        await refreshReceipt(r.id).catch((e) => recordError(e instanceof Error ? e.message : String(e)));
      }
    } finally {
      polling = false;
    }
  }, 2500);
}

export function receiptsForOrder(orderId: string): ReceiptDTO[] {
  return db.select().from(schema.fiscalReceipts).where(eq(schema.fiscalReceipts.orderId, orderId)).orderBy(desc(schema.fiscalReceipts.createdAt)).all().map(receiptDTO);
}

// ─── Webhook ────────────────────────────────────────────────────────────────

export function handleTokenxWebhook(authHeader: string | undefined, payload: unknown): { ok: boolean } {
  const secret = process.env.TOKENX_WEBHOOK_SECRET ?? '';
  if (secret.length < 16) throw new HttpError(503, 'Webhook kapalı', 'not_configured');
  if ((authHeader ?? '').trim() !== `Bearer ${secret}`) throw new HttpError(401, 'Yetkisiz', 'unauthorized');
  const p = payload as { operation?: string; data?: { basketID?: string; lockedBy?: string } & Partial<TokenxSale> };
  const basketId = p?.data?.basketID;
  if (!basketId) return { ok: true };
  if (p.operation === 'BASKET_COMPLETED' && typeof p.data?.status === 'number') applySale(basketId, p.data as TokenxSale, 'webhook');
  else if (p.operation === 'BASKET_LOCKED') setLock(basketId, true, p.data?.lockedBy ?? null);
  else if (p.operation === 'BASKET_UNLOCKED') setLock(basketId, false);
  return { ok: true };
}

// ─── Simülatör (eğitim cihazı) ──────────────────────────────────────────────

export function simulatorBaskets() {
  return db
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.provider, 'simulator'), inArray(schema.fiscalReceipts.status, [...PENDING])))
    .orderBy(desc(schema.fiscalReceipts.createdAt))
    .all()
    .map(receiptDTO);
}

/** Son tamamlanan eğitim fişleri (fiş iptali denemek için) */
export function simulatorRecent() {
  return db
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.provider, 'simulator'), inArray(schema.fiscalReceipts.status, ['tamamlandi', 'fis_iptal', 'iptal'])))
    .orderBy(desc(schema.fiscalReceipts.updatedAt))
    .limit(10)
    .all()
    .map(receiptDTO);
}

export function simulatorComplete(actor: Actor, receiptId: string, payments: { type: number; amount: number; operatorId?: number }[]) {
  needDirect(actor, 'odeme.al');
  const r = loadReceipt(receiptId);
  if (r.provider !== 'simulator') throw bad('Bu sepet simülatöre ait değil');
  if (!PENDING.includes(r.status as (typeof PENDING)[number])) throw conflict('Sepet artık beklemiyor');
  const total = payments.reduce((a, p) => a + p.amount, 0);
  if (total !== r.amount) throw bad(`Ödemelerin toplamı (${tl(total)}) sepet tutarına (${tl(r.amount)}) eşit olmalı`, 'okc_amount');
  const day = getOpenDay(db);
  const counter = (getSyncState<number>('okc.sim.receiptNo') ?? 0) + 1;
  setSyncState('okc.sim.receiptNo', counter);
  applySale(r.id, { basketID: r.id, status: 0, zNo: day?.zNo ?? 0, receiptNo: counter, message: 'OK', paymentCount: payments.length, paymentItems: payments, UUID: randomUUID() }, 'simulator');
  return receiptDTO(loadReceipt(r.id));
}

export function simulatorCancel(actor: Actor, receiptId: string, voidReceipt = false) {
  needDirect(actor, 'odeme.al');
  const r = loadReceipt(receiptId);
  if (r.provider !== 'simulator') throw bad('Bu sepet simülatöre ait değil');
  let approverId: string | null = null;
  if (voidReceipt) {
    // Fiş iptali ödeme iptalidir: LafPOS'taki ödeme iptaliyle aynı yetki ve aynı gün kuralı
    approverId = need(actor, 'odeme.iade', 'Fiş iptali yetkili onayı gerektirir');
    const day = getOpenDay(db);
    const paidDays = r.paymentIds.length ? db.select({ dayId: schema.payments.dayId }).from(schema.payments).where(inArray(schema.payments.id, r.paymentIds)).all() : [];
    if (!day || paidDays.some((p) => p.dayId !== day.id)) throw conflict('Kapanmış bir güne ait fiş iptal edilemez', 'day_closed');
  }
  applySale(r.id, { basketID: r.id, status: voidReceipt ? 99 : -1, message: 'CANCELLED' }, 'simulator', { userId: actor.user.id, approverId });
  return receiptDTO(loadReceipt(r.id));
}

export function simulatorLock(actor: Actor, receiptId: string, locked: boolean) {
  needDirect(actor, 'odeme.al');
  setLock(receiptId, locked, locked ? 'SIMULATOR' : null);
}

/** Seçili cihaz bağlantısını dener (Token'da terminal, kısımlar ve önerilen KDV → kısım eşlemesi) */
export async function testProvider() {
  const provider = providerFor(getSettings().okcProvider);
  if (!provider?.test) throw conflict('Bu sağlayıcı için bağlantı denemesi yok', 'okc_no_test');
  if (!provider.configured()) throw conflict(provider.notConfigured, 'okc_not_configured');
  return provider.test();
}

export function receiptActor(userId: string): Actor | null {
  const u = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return u ? { user: toAuthUser(u), approver: null } : null;
}

export { env as okcEnv };
