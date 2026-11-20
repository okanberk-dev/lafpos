import { randomUUID } from 'node:crypto';
import { and, desc, eq, gt, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { allocate, tl } from '@shared/money';
import type { OrderTotals } from '@shared/order-calc';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { type Actor, type AuthUser, need, needDirect, seesCashNumbers, toAuthUser } from '../lib/auth';
import { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { getSettings, getSyncState, setSyncState, trainingMode } from '../lib/settings';
import { orderItems, orderPayments } from '../services/dto';
import { addExternalPayments, assertNoActiveRoom, fiscalHeldQty, freeQty, getOpenDay, loadOrder, mergeSelection, refundExternalPayments, splitActive } from '../services/orders';
import { basketByRate, buildBasket, clampPayments, type MethodKind } from './basket';
import { type FiscalProvider, type FiscalResult, providerFor } from './providers';
import type { PendingReceipt } from './providers/types';
import { busyMessage, eodSummary, eodTimeMs, type EodReading, pairPavo, pavo, type PavoEodSummary, pavoProvider, pavoTiming, readEod, usePavoStore } from './providers/pavo';
import { fromTokenxSale, tokenx, tokenxProvider, webhookUrl } from './providers/tokenx';
import { describe as describePavo, PavoError } from './pavo';
import { type TokenxBasket, TokenxError, type TokenxSale } from './tokenx';

/**
 * Yazarkasa POS (ÖKC) bağlantısı. Sağlayıcılar `providers/` altında (Token, eğitim cihazı...); burası markadan
 * bağımsız: adisyon sepet olarak cihaza gider, ödeme ve belge cihazda olur, sonuç (`FiscalResult`) adisyonun
 * ödemesi olarak işlenir. Bekleyen sepet, kilit, zorla iptal ve geç gelen sonuç kuralları her marka için aynıdır.
 */

type ReceiptRow = typeof schema.fiscalReceipts.$inferSelect;
const PENDING = ['gonderildi', 'kilitli'] as const;

export { tokenx, webhookUrl };

usePavoStore({
  getSequence: () => getSyncState<number>('pavo.sequence') ?? 0,
  setSequence: (n) => setSyncState('pavo.sequence', n),
  getCert: () => getSyncState<string>('pavo.cert'),
  setCert: (fp) => setSyncState('pavo.cert', fp),
});

/**
 * Yazarkasa durumu. Pavo'nun son banka gün sonu (`pavo.eod`) tutarları yalnız kasa rakamlarını görene (kör kasa:
 * `kasa.rakam` ya da `rapor.gor`); kullanıcısız çağrıda (sistem sağlığı) tutar gitmez
 */
export function okcStatus(user?: AuthUser) {
  const s = getSettings();
  const p = providerFor(s.okcProvider);
  const eod = getSyncState<PavoEodRecord>(EOD_LAST);
  return {
    provider: s.okcProvider,
    mode: s.okcMode,
    sectionMap: s.okcSectionMap,
    operatorMethods: s.okcOperatorMethods,
    pavoAutoEod: s.okcPavoAutoEod,
    active: p ? { label: p.label, configured: p.configured(), capabilities: p.capabilities } : null,
    tokenx: tokenxProvider.status() as { configured: boolean; terminalId: string | null; branchId: string | null; webhookUrl: string | null; webhookSecret: boolean },
    pavo: { ...pavoProvider.status(), eod: eod ? eodFor(user ?? null, eod) : null },
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
    /**
     * Cihaz fişinin LafPOS'ta oluşturduğu ödemeler: istemci "tutar olarak alınmış ödeme" kuralını (`okc_partial`:
     * tamamlanmış fişlerin ödemeleri cihazdan sayılır) sunucuyla birebir uygular
     */
    paymentIds: r.paymentIds,
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
  // Cihazda fişi kesilmiş ama LafPOS'a tam işlenmemiş kalemler yeniden gitmez (ikinci fişe girerdi); adisyonun
  // fişe girmemiş kalemleri kalem seçilerek gidebilir (inceleme, 27 Eki 2026)
  const held = fiscalHeldQty(db, orderId);
  if (held.size) {
    const current = orderItems(db, orderId).filter((i) => !i.voided && !i.complimentary);
    const blocked = selection?.length
      ? mergeSelection(selection).some((sel) => {
          const it = current.find((i) => i.id === sel.itemId);
          return !!it && held.has(it.id) && sel.qty > freeQty(it, held);
        })
      : current.some((i) => held.has(i.id) && i.qty - i.paidQty > 0);
    if (blocked) {
      throw conflict(
        selection?.length
          ? "Seçilen kalem cihazda kesilmiş ama LafPOS'a tam işlenmemiş bir fişte; yeniden gönderilmez. Kalanı kasadan alın ya da fişi cihazdan iptal edin"
          : 'Bu adisyonun cihazda kesilmiş ama LafPOS\'a tam işlenmemiş fişi var; o fişin kalemleri yeniden gönderilmez. Kalanı kasadan alın, diğer kalemleri "Kalem seç" ile gönderin ya da fişi cihazdan iptal edin',
        'okc_unresolved',
      );
    }
  }
  // Hesap kişilere bölünmüşken kalem seçerek göndermek payları düşürmez (masa eksik öder): paylar Paylaş'tan
  const paidNow = orderPayments(db, orderId).reduce((a, p) => a + (p.refundedAt ? 0 : p.amount), 0);
  if (selection?.length && splitActive(db, order, order.total - paidNow)) {
    throw conflict('Hesap kişilere bölünmüş: payları "Paylaş"tan alın ya da paylaşımı kaldırın', 'split_active');
  }
  // Cihazdan gelen ödemeler fişleriyle bilinir (bölünmüş ödemenin ikincisi ya da servis fişi kalem taşımaz)
  const deviceIds = new Set(completedReceipts(orderId).flatMap((r) => r.paymentIds));
  const amountPayments = orderPayments(db, orderId).filter((p) => !p.refundedAt && !p.items?.length && !deviceIds.has(p.id));
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
      payments: orderPayments(db, orderId),
      remainingDue: order.total - order.paid,
      prior: selection?.length || !order.totals ? undefined : priorOf(orderId, items, order.totals),
      // Pavo kısım no değil KDV grubu (KDV10, KDV20) alır: grup orandan çıkar, eşleme gerekmez
      sectionMap: s.okcProvider === 'pavo' ? new Proxy({}, { get: () => 1 }) : s.okcSectionMap,
      sizeLabels: s.sizeLabels,
      callbackUrl: s.okcProvider === 'tokenx' ? (webhookUrl() ?? undefined) : undefined,
    });
    // Cihazın kabul etmeyeceği sepet (Pavo'da %0 KDV'li kalem gibi) kayıt yazılmadan reddedilir
    provider.validate?.(built.basket);
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

  let unknown: string | null = null;
  if (provider.capabilities.transport === 'push') {
    try {
      await provider.send({ id: basketId, status: 'gonderildi', mode: s.okcMode, basket: built.basket, amount: built.amount });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Yanıt gelmediyse (zaman aşımı, bağlantı koptu) sepet cihaza ulaşmış olabilir: bekleyen kalır, adisyon kilitli
      // kalır ve durumu sorgulanır. Kesin retse sepet cihazda yoktur. Her iki durumda da yalnız hâlâ bekleyen sepet
      // güncellenir: sonuç (webhook) istek sürerken geldiyse işlenmiş sepet ezilmez (inceleme, 27 Eki 2026)
      const uncertain = (e as { uncertain?: unknown } | null)?.uncertain === true;
      const stillPending = and(eq(schema.fiscalReceipts.id, basketId), inArray(schema.fiscalReceipts.status, [...PENDING]));
      const changed = db
        .update(schema.fiscalReceipts)
        .set(uncertain ? { error: `Gönderimin yanıtı alınamadı: ${message}`, updatedAt: Date.now() } : { status: 'hata', error: message, updatedAt: Date.now() })
        .where(stillPending)
        .run().changes;
      if (changed) {
        recordError(message);
        if (!uncertain) {
          publish(orderId, 'okc.error', message, actor.user.id);
          throw new HttpError(502, `Yazarkasaya gönderilemedi: ${message}`, e instanceof TokenxError ? `tokenx_${e.code ?? 'hata'}` : e instanceof PavoError ? 'pavo_send' : 'okc_send');
        }
        unknown = message;
      }
    }
  }
  if (provider.poll) ensurePolling();
  const fx = new Effects();
  fx.audit(db, {
    userId: actor.user.id,
    action: 'okc.send',
    orderId,
    amount: built.amount,
    message: `#${order.no} adisyon yazarkasaya gönderildi (${tl(built.amount)}, ${s.okcProvider === 'simulator' ? 'simülatör' : `${provider.label}, ${s.okcMode === 'anlik' ? 'kasada ödeme' : 'masada ödeme'}`})${unknown ? `; cihazdan yanıt alınamadı (${unknown})` : ''}`,
  });
  fx.flush();
  if (unknown) {
    publish(orderId, 'okc.error', 'Yazarkasadan yanıt alınamadı; sepetin durumu sorgulanıyor', actor.user.id);
    throw new HttpError(
      502,
      `Yazarkasadan yanıt alınamadı; sepet cihaza ulaşmış olabilir. Durumu sorgulanıyor: cihazda ödendiyse adisyon kendiliğinden kapanır, cihazda yoksa sepeti iptal edin (${unknown})`,
      'okc_unknown',
    );
  }
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
  const r = loadReceipt(receiptId);
  // Cihazda fişi kesilmiş (eksik ödenmiş ya da LafPOS'a işlenememiş) sepet silinmiş sayılmaz: fiş iptali ödemesini
  // geri alamaz, kalemleri ikinci fişe girerdi (inceleme, 27 Eki 2026). Yetkili onayı istenmeden reddedilir
  if (hasDocument(r)) throw unresolvedReceipt();
  if (!PENDING.includes(r.status as (typeof PENDING)[number]) && r.status !== 'hata') throw conflict('Bu sepet artık iptal edilemez');
  const approverId = force ? need(actor, 'odeme.iade', 'Cihaza ulaşılamadan sepeti iptal saymak yetkili onayı gerektirir') : null;
  let unreachable: string | null = null;
  const provider = providerFor(r.provider);
  if (r.provider !== 'simulator' && r.status !== 'hata') {
    try {
      if (!provider) throw new Error(`${r.provider} bağlantısı bu sürümde yok`);
      await provider.cancel(pendingOf(r));
    } catch (e) {
      // Pavo'da gün sonu sürüyor: cihaz meşgul ama ulaşılabilir, sepet "ulaşılamadı" diye iptal sayılmaz
      if (e instanceof PavoError && e.code === 'EOD_BUSY') throw conflict(e.message, 'okc_busy');
      // Sepet bu arada ödendiyse ya da cihazda yoksa sonucu işlemek için durumu sorgula
      await refreshReceipt(r.id).catch(() => undefined);
      const message = e instanceof Error ? e.message : String(e);
      const now = loadReceipt(r.id);
      settledMeanwhile(now);
      if (!PENDING.includes(now.status as (typeof PENDING)[number])) return receiptDTO(now);
      if (!force) throw new HttpError(502, `Cihazdaki sepet silinemedi: ${message}`, 'okc_delete');
      unreachable = message;
    }
  }
  // Yalnız hâlâ bekleyen ya da gönderilemeyen (sonucu olmayan hata) sepet silinmiş sayılır: silme sürerken gelen
  // "ödendi" ezilmez, belgesi kesilmiş hata sepeti hiç silinmez
  const fx = new Effects();
  const changed = tx((t) => {
    const n = t
      .update(schema.fiscalReceipts)
      .set({ status: 'silindi', error: unreachable ? `Cihaza ulaşılamadı, LafPOS'ta iptal sayıldı: ${unreachable}` : null, updatedAt: Date.now() })
      .where(
        and(
          eq(schema.fiscalReceipts.id, r.id),
          or(
            inArray(schema.fiscalReceipts.status, [...PENDING]),
            and(eq(schema.fiscalReceipts.status, 'hata'), sql`coalesce(json_extract(${schema.fiscalReceipts.result}, '$.status'), '') <> 'paid'`),
          ),
        ),
      )
      .run().changes;
    if (!n) return 0;
    const order = loadOrder(t, r.orderId);
    fx.audit(
      t,
      unreachable
        ? {
            userId: actor.user.id,
            approverId,
            action: 'okc.force_cancel',
            severity: 'alarm',
            orderId: r.orderId,
            amount: r.amount,
            message: `#${order.no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihaza ulaşılamadan LafPOS'ta iptal sayıldı. Cihazda ödeme alındıysa mali fişi cihazdan iptal edin`,
          }
        : { userId: actor.user.id, action: 'okc.delete', orderId: r.orderId, amount: r.amount, message: `#${order.no} adisyonun yazarkasa sepeti (${tl(r.amount)}) LafPOS'tan iptal edildi` },
    );
    return n;
  });
  if (!changed) {
    const now = loadReceipt(r.id);
    settledMeanwhile(now);
    return receiptDTO(now);
  }
  fx.flush();
  publish(r.orderId, 'okc.cancelled', unreachable ? "Cihaza ulaşılamadı; sepet LafPOS'ta iptal sayıldı" : 'Cihaz sepeti iptal edildi', actor.user.id);
  return receiptDTO(loadReceipt(r.id));
}

function completedReceipts(orderId: string): ReceiptRow[] {
  return db
    .select()
    .from(schema.fiscalReceipts)
    .where(and(eq(schema.fiscalReceipts.orderId, orderId), eq(schema.fiscalReceipts.status, 'tamamlandi')))
    .all();
}

/**
 * Adisyonun ödenmiş kısmının KDV oranına göre brütü ve cihaza giden servis: cihaz fişleri gönderilen sepetten
 * (fişin iade edilmemiş ödemesi kadar), LafPOS'ta kalem seçerek alınan ödemeler kalemlerin bugünkü payıyla
 * oranlara bölünür. Bütün adisyon sepeti bunu LafPOS'un KDV dökümüne tamamlar (inceleme, 27 Eki 2026).
 */
function priorOf(orderId: string, items: { id: string; qty: number; kdvRate: number }[], totals: OrderTotals): { byRate: Record<string, number>; service: number } {
  const live = orderPayments(db, orderId).filter((p) => !p.refundedAt);
  const byRate: Record<string, number> = {};
  let service = 0;
  const add = (amount: number, weights: Record<string, number>) => {
    const keys = Object.keys(weights);
    allocate(amount, keys.map((k) => weights[k])).forEach((v, i) => (byRate[keys[i]] = (byRate[keys[i]] ?? 0) + v));
  };
  const deviceIds = new Set<string>();
  for (const r of completedReceipts(orderId)) {
    for (const id of r.paymentIds) deviceIds.add(id);
    const paid = live.filter((p) => r.paymentIds.includes(p.id)).reduce((a, p) => a + p.amount, 0);
    if (paid <= 0) continue;
    // Fişin ödemesinin bir kısmı LafPOS'ta iade edildiyse kalan ödeme fişin oranlarına bölünür
    const sent = basketByRate(r.basket as TokenxBasket);
    add(paid, sent.byRate);
    service += paid === r.amount ? sent.service : allocate(paid, [sent.service, r.amount - sent.service])[0];
  }
  for (const p of live) {
    if (deviceIds.has(p.id) || !p.items?.length) continue;
    const weights: Record<string, number> = {};
    for (const sel of p.items) {
      const it = items.find((i) => i.id === sel.itemId);
      if (!it || it.qty <= 0) continue;
      weights[String(it.kdvRate)] = (weights[String(it.kdvRate)] ?? 0) + ((totals.lineNet[it.id] ?? 0) * sel.qty) / it.qty;
    }
    if (Object.keys(weights).length) add(p.amount, weights);
  }
  return { byRate, service };
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

  const stored = r.result as Partial<FiscalResult> | null;
  if (result.status === 'paid') {
    // Aynı "ödendi" ikinci kez: işlenmiş (ya da işlenip hataya düşmüş) sonuç tekrarlanmaz. Fişi iptal edilmiş
    // sepete gelen "ödendi" de eski sonucun tekrarıdır (bir sepet bir kez ödenir)
    if (r.status === 'tamamlandi' || hasDocument(r) || r.status === 'fis_iptal') return;
    if (r.status === 'iptal' || r.status === 'silindi') {
      // Bu sepet için geç gelen "ödendi" zaten bildirildi
      if (stored?.status === 'paid') return;
      // İptal sayılan sepete geç gelen "ödendi": adisyon kendiliğinden yeniden kapanmaz, yönetici bakar. Sonuç (Z ve
      // fiş no) sepette saklanır: tekrarı yeni alarm vermez, sonradan gelen fiş iptali belgenin kesildiğini bilir
      tx((t) => {
        t.update(schema.fiscalReceipts).set({ result, zNo: result.zNo, receiptNo: result.receiptNo, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
        fx.audit(t, {
          userId: by?.userId ?? null,
          action: 'okc.late_paid',
          severity: 'alarm',
          orderId: r.orderId,
          amount: r.amount,
          message: `Yazarkasada iptal sayılan sepet için "ödendi" bildirimi geldi (${tl(r.amount)}${doc ? `, ${doc}` : ''}, ${source}); cihazdaki fişi kontrol edin`,
        });
      });
      fx.flush();
      return;
    }
    const sender = r.sentBy ? db.select().from(schema.users).where(eq(schema.users.id, r.sentBy)).get() : null;
    const userId = sender?.id ?? 'sistem';
    const payments = clampPayments(result.payments, r.amount)
      .map((p) => ({ methodId: methodFor(p.kind, p.operatorId), amount: p.amount, note: `Yazarkasa${doc ? ` ${doc}` : ''}` }))
      .filter((p): p is { methodId: string; amount: number; note: string } => !!p.methodId);
    const gap = r.amount - payments.reduce((a, p) => a + p.amount, 0);
    if (gap > 0) {
      applyUnderpaid(r, result, payments, gap, userId, source, doc);
      return;
    }
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
    if (r.status === 'fis_iptal') return;
    // Belge kesilmişti: tamamlanan, cihazda kapanıp LafPOS'a tam işlenemeyen (hata) ya da iptal sayıldıktan sonra
    // "ödendi" bildirimi gelen sepet. LafPOS'a işlenmiş ödemesi olan sepet her durumda belgelidir: fiş iptali o
    // ödemeleri geri alır (eski kayıtta belgeli hata sepeti "silindi" olmuş olabilir; inceleme, 27 Eki 2026)
    const documented = r.status === 'tamamlandi' || hasDocument(r) || r.paymentIds.length > 0 || stored?.status === 'paid';
    const pending = PENDING.includes(r.status as (typeof PENDING)[number]) || (r.status === 'hata' && !stored);
    // Fiş kesilmemiş, zaten kapanmış sepete aynı iptal ikinci kez geldi: işlem ve kayıt tekrarlanmaz
    if (!documented && !pending && stored?.status === 'voided') return;
    const closedDay = documented ? closedDayOf(r) : null;
    if (closedDay) {
      // Kapanmış günün Z'si değişmez: ödeme o günden geri alınmaz, adisyon o günde açılmaz. İade bugünün işidir,
      // yönetici alarmı görür ve parayı geri verdiyse bugünün kasasından çıkış olarak işler (inceleme, 27 Eki 2026)
      tx((t) => {
        t.update(schema.fiscalReceipts)
          .set({ status: 'fis_iptal', result, error: `Fiş ${closedDay.date} gününe ait; gün kapandığı için ödeme LafPOS'ta geri alınmadı`, updatedAt: now })
          .where(eq(schema.fiscalReceipts.id, r.id))
          .run();
        const order = loadOrder(t, closedDay.orderId);
        fx.audit(t, {
          userId: by?.userId ?? null,
          approverId: by?.approverId ?? null,
          action: 'okc.void_closed_day',
          severity: 'alarm',
          orderId: order.id,
          amount: r.amount,
          message: `#${order.no} adisyonun ${closedDay.date} tarihli yazarkasa fişi (${tl(r.amount)}) cihazda iptal edildi; gün kapandığı için ödeme LafPOS'ta geri alınmadı. Müşteriye iade yapıldıysa bugünün kasasından çıkış olarak işleyin`,
        });
      });
    } else if (documented) {
      tx((t) => {
        const out = refundExternalPayments(t, by?.userId ?? null, fx, r.paymentIds, 'Yazarkasada fiş iptal edildi');
        t.update(schema.fiscalReceipts).set({ status: 'fis_iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
        const target = out.orders[0]?.order ?? loadOrder(t, r.orderId);
        const reopened = out.orders.some((o) => o.reopened);
        fx.audit(t, {
          userId: by?.userId ?? null,
          approverId: by?.approverId ?? null,
          action: 'okc.void',
          severity: 'alarm',
          orderId: target.id,
          amount: r.amount,
          message: out.refunded
            ? `#${target.no} adisyonun yazarkasa fişi iptal edildi; ${tl(out.refunded)} ödeme geri alındı${reopened ? ' ve adisyon yeniden açıldı' : ''}`
            : r.paymentIds.length
              ? `#${target.no} adisyonun yazarkasa fişi (${tl(r.amount)}) iptal edildi; ödemesi LafPOS'ta zaten iptal edilmişti, adisyon değişmedi`
              : `#${target.no} adisyonun yazarkasa fişi (${tl(r.amount)}) iptal edildi; LafPOS'a işlenmiş ödemesi yoktu, adisyon değişmedi`,
        });
      });
    } else if (pending) {
      // Belge kesilmemiş, bekleyen (ya da gönderilemeyen) sepet için iptal: sepet kapanır, ödeme yok
      tx((t) => {
        t.update(schema.fiscalReceipts).set({ status: 'iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
        fx.audit(t, {
          userId: by?.userId ?? null,
          approverId: by?.approverId ?? null,
          action: 'okc.cancelled',
          orderId: r.orderId,
          amount: r.amount,
          message: `#${loadOrder(t, r.orderId).no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihazda iptal edildi; fiş kesilmemişti (${source})`,
        });
      });
    } else {
      // LafPOS'ta silinen ya da cihazda vazgeçilen sepete fiş iptali geldi: durum değişmez (LafPOS'un iptali kalır).
      // "Ödendi" bildirimi hiç ulaşmadıysa cihazda fiş kesilip iptal edilmiş olabilir; bir kez not düşülür, sonuç
      // saklanır ki tekrarı yeni kayıt yazmasın
      tx((t) => {
        t.update(schema.fiscalReceipts).set({ result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
        fx.audit(t, {
          userId: by?.userId ?? null,
          approverId: by?.approverId ?? null,
          action: 'okc.void',
          severity: 'uyari',
          orderId: r.orderId,
          amount: r.amount,
          message: `#${loadOrder(t, r.orderId).no} adisyonun ${r.status === 'silindi' ? "LafPOS'ta iptal sayılan" : 'cihazda vazgeçilen'} yazarkasa sepeti (${tl(r.amount)}) için fiş iptali bildirimi geldi; LafPOS'a işlenmiş ödemesi yok, adisyon değişmedi (${source})`,
        });
      });
    }
    fx.emit({ topic: 'okc', kind: 'okc.void', orderId: r.orderId, message: 'Yazarkasada fiş iptal edildi' });
    fx.flush();
    return;
  }

  // Cihazda vazgeçildi: yalnız bekleyen sepet kapanır (işlenmiş ya da iptal sayılmış sepet değişmez)
  if (!PENDING.includes(r.status as (typeof PENDING)[number])) return;
  tx((t) => {
    t.update(schema.fiscalReceipts).set({ status: 'iptal', result, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    fx.audit(t, {
      userId: by?.userId ?? null,
      action: 'okc.cancelled',
      orderId: r.orderId,
      amount: r.amount,
      message: `#${loadOrder(t, r.orderId).no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihazda ödenmeden kapatıldı (${source})`,
    });
  });
  fx.emit({ topic: 'okc', kind: 'okc.cancelled', orderId: r.orderId, message: 'Cihazda ödemeden vazgeçildi' });
  fx.emit({ topic: 'orders', kind: 'okc.cancelled', orderId: r.orderId });
  fx.flush();
}

/** Cihazda belge kesildi ama LafPOS'a tam işlenemedi (hata durumunda, sonuç saklı) */
function hasDocument(r: ReceiptRow): boolean {
  return r.status === 'hata' && (r.result as Partial<FiscalResult> | null)?.status === 'paid';
}

function unresolvedReceipt(meanwhile = false) {
  return conflict(
    `${meanwhile ? 'Sepet bu arada cihazda fişe dönüştü' : 'Bu sepetin fişi cihazda kesildi'} ama LafPOS'a tam işlenmedi; sepet silinemez. Kalanı kasadan alın ya da fişi cihazdan iptal edin`,
    'okc_unresolved',
  );
}

/** Sepet iptali sürerken sonuç geldiyse (ödendi ya da belgeli hata) iptal başarılı sayılmaz */
function settledMeanwhile(now: ReceiptRow) {
  if (now.status === 'tamamlandi') throw conflict('Sepet bu arada cihazda ödendi; adisyona işlendi', 'okc_paid');
  if (hasDocument(now)) throw unresolvedReceipt(true);
}

/**
 * Cihaz belgeyi sepet tutarıyla kesti ama ödemelerin bir kısmının LafPOS'ta karşılığı yok (ikram, ödemesiz ya da
 * eşlenmemiş tür). Alınan ödemeler tutar olarak işlenir (kasa sayımı doğru kalsın, fiş iptali onları geri alsın);
 * kalemler ödenmiş sayılmaz, sepet hataya düşer ve yöneticiye alarm gider. Bu adisyon kalan çözülene kadar cihaza
 * yeniden gönderilmez: aynı kalemler ikinci fişe girerdi (inceleme, 27 Eki 2026).
 */
function applyUnderpaid(
  r: ReceiptRow,
  result: FiscalResult,
  payments: { methodId: string; amount: number; note: string }[],
  gap: number,
  userId: string,
  source: ResultSource,
  doc: string,
) {
  const now = Date.now();
  const fx = new Effects();
  try {
    tx((t) => {
      const out = payments.length ? addExternalPayments(t, userId, fx, r.orderId, { payments, items: [] }) : { order: loadOrder(t, r.orderId), paymentIds: [] as string[] };
      t.update(schema.fiscalReceipts)
        .set({
          status: 'hata',
          zNo: result.zNo,
          receiptNo: result.receiptNo,
          result,
          paymentIds: out.paymentIds,
          completedAt: now,
          updatedAt: now,
          error: `Cihazda ${tl(gap)} ödemesiz kapandı (ikram, ödemesiz ya da eşlenmemiş tür); kalemler ödenmiş sayılmadı`,
        })
        .where(eq(schema.fiscalReceipts.id, r.id))
        .run();
      fx.audit(t, {
        userId,
        action: 'okc.underpaid',
        severity: 'alarm',
        orderId: r.orderId,
        amount: gap,
        message: `#${out.order.no} adisyon yazarkasada ${tl(r.amount)} fişle kapandı${doc ? ` (${doc})` : ''} ama ${tl(gap)} için LafPOS'ta karşılığı olan ödeme yok (ikram, ödemesiz ya da eşlenmemiş tür; ${source}). Kalanı kasadan alın ya da fişi cihazdan iptal edin`,
      });
    });
    fx.emit({ topic: 'okc', kind: 'okc.error', orderId: r.orderId, message: `Yazarkasada ${tl(gap)} ödemesiz kapandı; adisyonu kontrol edin` });
    fx.flush();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    db.update(schema.fiscalReceipts).set({ status: 'hata', result, error: `Ödeme alındı ama LafPOS'a işlenemedi: ${message}`, updatedAt: now }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    const fx2 = new Effects();
    fx2.audit(db, { action: 'okc.apply_failed', severity: 'alarm', orderId: r.orderId, amount: r.amount, message: `Yazarkasada ${tl(r.amount)} fiş kesildi ama LafPOS'a işlenemedi: ${message}` });
    fx2.emit({ topic: 'okc', kind: 'okc.error', orderId: r.orderId, message });
    fx2.flush();
  }
}

/** Fişin (iade edilmemiş) ödemelerinden biri açık gün dışındaysa o günün tarihi ve ödemenin adisyonu */
function closedDayOf(r: ReceiptRow): { date: string; orderId: string } | null {
  if (!r.paymentIds.length) return null;
  const day = getOpenDay(db);
  const live = db
    .select({ dayId: schema.payments.dayId, orderId: schema.payments.orderId, refundedAt: schema.payments.refundedAt })
    .from(schema.payments)
    .where(inArray(schema.payments.id, r.paymentIds))
    .all()
    .filter((p) => !p.refundedAt);
  const old = live.find((p) => p.dayId !== day?.id);
  if (!old) return null;
  const date = db.select({ date: schema.businessDays.date }).from(schema.businessDays).where(eq(schema.businessDays.id, old.dayId)).get()?.date ?? '?';
  return { date, orderId: old.orderId ?? r.orderId };
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
  const out = await provider.poll(pendingOf(r)).catch(deviceError);
  const stillPending = and(eq(schema.fiscalReceipts.id, r.id), inArray(schema.fiscalReceipts.status, [...PENDING]));
  if (out.kind === 'result') applyResult(r.id, out.result, 'sorgu');
  else if (out.kind === 'deleted' || out.kind === 'missing') {
    // Silindi: sepet cihazdan kaldırıldı. Yok: yanıtı alınamayan gönderim cihaza hiç ulaşmamış; adisyonun kilidi açılır
    const deleted = out.kind === 'deleted';
    const fx = new Effects();
    const changed = tx((t) => {
      const n = t
        .update(schema.fiscalReceipts)
        .set(deleted ? { status: 'silindi', updatedAt: Date.now() } : { status: 'hata', error: `Sepet cihaza ulaşmadı${r.error ? ` (${r.error})` : ''}`, updatedAt: Date.now() })
        .where(stillPending)
        .run().changes;
      if (n) {
        const no = loadOrder(t, r.orderId).no;
        fx.audit(t, {
          action: deleted ? 'okc.cancelled' : 'okc.not_delivered',
          severity: deleted ? 'info' : 'uyari',
          orderId: r.orderId,
          amount: r.amount,
          message: deleted ? `#${no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihazdan silindi (sorgu)` : `#${no} adisyonun yazarkasa sepeti (${tl(r.amount)}) cihaza ulaşmadı; adisyon kasadan alınabilir`,
        });
      }
      return n;
    });
    fx.flush();
    if (changed) publish(r.orderId, deleted ? 'okc.cancelled' : 'okc.error', deleted ? 'Sepet cihazdan silindi' : 'Sepet cihaza ulaşmadı; hesabı yeniden gönderin ya da kasadan alın');
  } else if (out.locked !== (r.status === 'kilitli')) setLock(r.id, out.locked, out.lockedBy);
  return receiptDTO(loadReceipt(r.id));
}

/** Durumu sorgulanabilen sağlayıcılar (sorgu döngüsü yalnız bunların sepetlerine bakar) */
const POLLED = ['tokenx', 'pavo'] as const;

// ─── Sorgulama döngüsü ──────────────────────────────────────────────────────

let pollTimer: NodeJS.Timeout | null = null;
let polling = false;

/** 8 saatten eski bekleyen sepet kendiliğinden sorgulanmaz (elle yenilenir); yalnız onlar kaldıysa döngü durur */
const POLL_MAX_AGE_MS = 8 * 3600_000;

/** Kendiliğinden sorgulanan sepetler: sorgulanabilir sağlayıcı, bekliyor, 8 saatten yeni */
const polledNow = () =>
  and(inArray(schema.fiscalReceipts.provider, [...POLLED]), inArray(schema.fiscalReceipts.status, [...PENDING]), gt(schema.fiscalReceipts.createdAt, Date.now() - POLL_MAX_AGE_MS));

/** Bekleyen (sorgulanabilir) sepet varken 2,5 sn'de bir (liste modunda 10 sn) durum sorar; kalmayınca durur. */
export function ensurePolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      const pending = db.select().from(schema.fiscalReceipts).where(polledNow()).all();
      if (!pending.length) {
        clearInterval(pollTimer!);
        pollTimer = null;
        return;
      }
      const now = Date.now();
      for (const r of pending) {
        const age = now - r.createdAt;
        if (r.mode === 'liste' && (now - r.updatedAt < 10_000 || age < 5_000)) continue;
        await refreshReceipt(r.id).catch((e) => recordError(e instanceof Error ? e.message : String(e)));
      }
    } finally {
      polling = false;
    }
  }, 2500);
}

/**
 * Sunucu açılışında: önceki süreçten kalan sorgulanabilir bekleyen sepet varsa sorgu döngüsü yeniden başlar
 * (webhook yokken sonuç yalnız sorguyla gelir; yoksa adisyon kilitli kalırdı, inceleme 27 Eki 2026)
 */
export function resumePolling() {
  const pending = db.select({ id: schema.fiscalReceipts.id }).from(schema.fiscalReceipts).where(polledNow()).get();
  if (pending) ensurePolling();
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
    if (!getOpenDay(db) || closedDayOf(r)) throw conflict('Kapanmış bir güne ait fiş iptal edilemez', 'day_closed');
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
  return provider.test().catch(deviceError);
}

/** Pavo eşleştirmesi: cihazda onay ekranı açılır, kasiyer onaylayınca LafPOS cihaza satış gönderebilir */
export async function pairDevice(actor: Actor) {
  if (getSettings().okcProvider !== 'pavo') throw conflict('Eşleştirme yalnız Pavo bağlantısında', 'okc_no_pair');
  if (!pavoProvider.configured()) throw conflict(pavoProvider.notConfigured, 'okc_not_configured');
  const out = await pairPavo().catch(deviceError);
  const fx = new Effects();
  fx.audit(db, { userId: actor.user.id, action: 'okc.pair', message: `Pavo cihazı eşleştirildi (${pavoProvider.terminalId()})` });
  fx.flush();
  return out;
}

// ─── Pavo banka gün sonu ────────────────────────────────────────────────────

/**
 * Cihaz gün sonunun saklanan sonucu (`sync_state` `pavo.eod.<gün>` ve `pavo.eod.last`). Yalnız özet: kart no, işlem
 * dökümü, slip ve işyeri bilgisi saklanmaz. `ok` alındı · `failed` cihaz alamadı (yeniden denenebilir) · `unknown`
 * yanıt alınamadı, alınmış olabilir (önce doğrulanır; kendiliğinden yeniden denenmez) · `skipped` denenmedi.
 */
export interface PavoEodRecord extends PavoEodSummary {
  at: number;
  /** Denemenin bağlı olduğu LafPOS günü (kapanan gün ya da elle denemede açık gün) */
  dayId: string | null;
  trigger: 'otomatik' | 'elle';
  status: 'ok' | 'failed' | 'unknown' | 'skipped';
  errorCode: string | null;
  message: string | null;
  /** LafPOS'ta kapanan günün kart toplamı (bahşiş dahil, kuruş); gün açıkken null */
  dayCardKurus: number | null;
  /** Denemeden önce bilinen son gün sonunun batch no'su: yanıtı alınamayan deneme bununla doğrulanır */
  prevBatchNo: string | null;
  /** Belirsiz ya da alınamayan deneme cihazdan doğrulandıysa o an */
  verifiedAt?: number | null;
}

const EOD_LAST = 'pavo.eod.last';
/** Son başarılı gün sonunun batch no'su (doğrulamanın kıyası) */
const EOD_BATCH = 'pavo.eod.batch';

/** Blind kasa: kasa rakamlarını görmeyene tutarlar gitmez (sayılar ve durum gider) */
function eodFor(user: AuthUser | null, rec: PavoEodRecord) {
  if (user && seesCashNumbers(user)) return { ...rec, amountsHidden: false };
  return { ...rec, grandTotalKurus: null, dayCardKurus: null, acquirers: rec.acquirers.map((a) => ({ ...a, totalKurus: null })), amountsHidden: true };
}
function eodSummaryFor(user: AuthUser | null, s: PavoEodSummary | null) {
  if (!s || (user && seesCashNumbers(user))) return s;
  return { ...s, grandTotalKurus: null, acquirers: s.acquirers.map((a) => ({ ...a, totalKurus: null })) };
}

/** Kapanmış günün kart toplamı (Z'nin kart alanı ve kartla alınan bahşiş: bankaya giden tutar); gün açıksa null */
function dayCardKurus(dayId: string | null): number | null {
  if (!dayId) return null;
  const day = db.select({ closedAt: schema.businessDays.closedAt, summary: schema.businessDays.summary }).from(schema.businessDays).where(eq(schema.businessDays.id, dayId)).get();
  if (!day?.closedAt || !day.summary) return null;
  const s = day.summary;
  return (s.byZField?.card ?? 0) + s.payments.filter((p) => p.zField === 'card').reduce((a, p) => a + (p.tips ?? 0), 0);
}

/** Cihaz gün sonu neden denenmez; null: denenebilir. `auto`: gün kapanınca (ayara bağlı) */
function eodBlocker(auto: boolean): { message: string; code: string } | null {
  const s = getSettings();
  if (s.okcProvider !== 'pavo') return { message: 'Cihazda gün sonu yalnız Pavo bağlantısında', code: 'okc_no_eod' };
  if (!pavoProvider.configured()) return { message: pavoProvider.notConfigured, code: 'okc_not_configured' };
  if (trainingMode(s)) return { message: 'Kurulum (eğitim) modunda cihazda banka gün sonu alınmaz', code: 'okc_training' };
  if (auto && !s.okcPavoAutoEod) return { message: 'Gün kapanınca cihazda gün sonu alma kapalı (Yönetim › Yazarkasa POS)', code: 'okc_eod_off' };
  if ((getSyncState<number>('pavo.sequence') ?? 0) <= 0) return { message: 'Cihaz eşleştirilmemiş; Yönetim › Yazarkasa POS › Eşleştir', code: 'okc_not_paired' };
  const busy = busyMessage(pavo()!, 'gün sonu alınmadı');
  if (busy) return { message: busy, code: 'okc_busy' };
  return null;
}

/**
 * Sonucu saklar, denetim kaydına yazar ve yayar (tek işlem). Atlanan deneme doğrulama bekleyen (belirsiz) sonucu ve
 * aynı günün denenmiş sonucunu ezmez. `verified`: sonuç cihazdan doğrulandı; `note` denetim mesajını verir
 */
function saveEod(rec: PavoEodRecord, actorId: string | null, verified = false, note?: { severity: 'info' | 'uyari' | 'alarm'; message: string }) {
  const skipped = rec.status === 'skipped';
  const keepLast = skipped && getSyncState<PavoEodRecord>(EOD_LAST)?.status === 'unknown';
  const dayKey = rec.dayId ? `pavo.eod.${rec.dayId}` : null;
  const dayPrev = dayKey ? getSyncState<PavoEodRecord>(dayKey) : null;
  const keepDay = skipped && !!dayPrev && dayPrev.status !== 'skipped';
  const where = [rec.batchNo ? `batch ${rec.batchNo}` : '', rec.deviceDateTime ?? ''].filter(Boolean).join(', ');
  const diff = rec.status === 'ok' && rec.grandTotalKurus != null && rec.dayCardKurus != null ? rec.grandTotalKurus - rec.dayCardKurus : 0;
  const banks = rec.acquirers.map((a) => `${a.name}${a.totalKurus != null ? ` ${tl(a.totalKurus)}` : ''}`).join(', ');
  const audit = note
    ? note
    : rec.status === 'ok'
      ? {
          severity: (diff ? 'uyari' : 'info') as 'uyari' | 'info',
          message: `Pavo cihazında banka gün sonu ${verified ? 'doğrulandı' : 'alındı'}${where ? ` (${where})` : ''}${rec.grandTotalKurus != null ? `: ${tl(rec.grandTotalKurus)}` : ''}${banks ? ` · ${banks}` : ''}${
            diff
              ? `. Cihazın kart toplamı LafPOS gün sonundaki kart toplamından (${tl(rec.dayCardKurus!)}) ${tl(Math.abs(diff))} ${diff > 0 ? 'fazla' : 'eksik'}: cihazda LafPOS dışı ya da başka güne ait kart işlemi, başka cihazda alınan kart ödemesi olabilir`
              : ''
          }`,
        }
      : rec.status === 'failed'
        ? { severity: 'alarm' as const, message: `Pavo cihazında banka gün sonu alınamadı: ${rec.message}. Yönetim › Yazarkasa POS'tan yeniden deneyin ya da cihazın menüsünden alın` }
        : rec.status === 'unknown'
          ? {
              severity: 'alarm' as const,
              message: `Pavo cihazında banka gün sonunun sonucu alınamadı (${rec.message}); gün sonu cihazda alınmış olabilir. Yeniden denemeden önce Yönetim › Yazarkasa POS › Doğrula`,
            }
          : { severity: 'info' as const, message: `Pavo cihazında banka gün sonu alınmadı: ${rec.message}` };
  const fx = new Effects();
  tx((t) => {
    if (!keepLast) setSyncState(EOD_LAST, rec);
    if (dayKey && !keepDay) setSyncState(dayKey, rec);
    if (rec.status === 'ok' && rec.batchNo) setSyncState(EOD_BATCH, rec.batchNo);
    fx.audit(t, {
      userId: actorId,
      action: 'okc.eod',
      severity: audit.severity,
      amount: rec.status === 'ok' ? rec.grandTotalKurus : null,
      message: audit.message,
      data: { status: rec.status, trigger: rec.trigger, batchNo: rec.batchNo, errorCode: rec.errorCode, verified },
    });
  });
  fx.emit({ topic: 'okc', kind: 'okc.eod', message: rec.status === 'ok' ? 'Cihazda gün sonu alındı' : (rec.message ?? undefined) });
  fx.flush();
}

/**
 * Pavo cihazında banka gün sonu (kart işlemlerinin batch'i kapanır). LafPOS gün sonundan sonra çağrılır, onu
 * beklemez: çağıran sonucu beklemeden bırakır (`void ... .catch`), cihaz yanıt vermese de gün kapalı kalır.
 * Denenmeyen durumlar (bilgi eksik, kurulum modu, cihaz meşgul, eşleştirme yok, otomatik kapalı) bilgi kaydıyla
 * atlanır; Pavo seçili değilse hiçbir şey yazılmaz. Yanıtı alınamayan deneme `unknown` kalır, kendiliğinden yeniden
 * denenmez (ikinci gün sonu boş batch açardı; doğrulama `verifyDeviceEod`).
 */
export async function deviceEndOfDay(dayId: string | null, actorId: string | null, opts: { manual?: boolean; print?: boolean } = {}): Promise<PavoEodRecord | null> {
  if (getSettings().okcProvider !== 'pavo') return null;
  const base: PavoEodRecord = {
    at: Date.now(),
    dayId,
    trigger: opts.manual ? 'elle' : 'otomatik',
    status: 'skipped',
    batchNo: null,
    deviceDateTime: null,
    grandTotalKurus: null,
    acquirers: [],
    errorCode: null,
    message: null,
    dayCardKurus: null,
    prevBatchNo: getSyncState<string>(EOD_BATCH),
  };
  const blocked = eodBlocker(!opts.manual);
  if (blocked) {
    const rec = { ...base, errorCode: blocked.code, message: blocked.message };
    saveEod(rec, actorId);
    return rec;
  }
  let reading: EodReading;
  try {
    reading = readEod(await pavo()!.performEod({ print: opts.print, timeoutMs: pavoTiming.eodMs }));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // Bağlantı hiç kurulamadıysa gün sonu gitmedi; yanıt gelmediyse (ya da beklenmeyen hata) gitmiş olabilir
    reading = e instanceof PavoError && !e.uncertain ? { kind: 'failed', code: e.code, message } : { kind: 'unknown', code: e instanceof PavoError ? e.code : null, message };
  }
  const rec: PavoEodRecord =
    reading.kind === 'ok'
      ? { ...base, ...(reading.summary ?? {}), status: 'ok', message: reading.message, dayCardKurus: dayCardKurus(dayId) }
      : { ...base, status: reading.kind, errorCode: reading.code, message: reading.message };
  if (rec.status !== 'ok') recordError(`Cihaz gün sonu: ${rec.message}`);
  saveEod(rec, actorId);
  return rec;
}

/**
 * Elle gün sonunun günü. Son kapanan günün denemesi alınamadı, belirsiz kaldı (doğrulandıktan sonra) ya da atlandıysa
 * bu onun yenisidir: o güne yazılır (ertesi sabah gün açılmış olsa da). Değilse açık gün, yoksa son kapanan gün
 */
function eodDayId(): string | null {
  const lastClosed =
    db
      .select({ id: schema.businessDays.id })
      .from(schema.businessDays)
      .where(isNotNull(schema.businessDays.closedAt))
      .orderBy(desc(schema.businessDays.closedAt))
      .limit(1)
      .get()?.id ?? null;
  const last = getSyncState<PavoEodRecord>(EOD_LAST);
  if (lastClosed && last && last.status !== 'ok' && last.dayId === lastClosed) return lastClosed;
  return getOpenDay(db)?.id ?? lastClosed;
}

/**
 * Yönetim › Yazarkasa POS › Cihazda gün sonu al (elle ya da başarısız denemenin yenisi). Ayar kapalı olsa da çalışır.
 * Önceki deneme belirsizse önce doğrulanmalı: belirsiz sonucun üstüne ikinci gün sonu boş batch açar.
 */
export async function runDeviceEod(actor: Actor, opts: { print?: boolean; force?: boolean } = {}) {
  const blocked = eodBlocker(false);
  if (blocked) throw conflict(blocked.message, blocked.code);
  const last = getSyncState<PavoEodRecord>(EOD_LAST);
  if (last?.status === 'unknown' && !opts.force) {
    throw conflict('Önceki gün sonunun sonucu belirsiz; önce "Doğrula" ile cihazdan kontrol edin', 'okc_eod_unknown');
  }
  const rec = (await deviceEndOfDay(eodDayId(), actor.user.id, { manual: true, print: opts.print }))!;
  if (rec.status === 'skipped') throw conflict(rec.message ?? 'Gün sonu alınmadı', rec.errorCode ?? 'okc_busy');
  if (rec.status === 'failed') throw new HttpError(502, `Cihazda gün sonu alınamadı: ${rec.message}`, 'pavo_eod');
  if (rec.status === 'unknown') throw new HttpError(502, `Cihazdan yanıt alınamadı; gün sonu alınmış olabilir. "Doğrula" ile kontrol edin (${rec.message})`, 'pavo_eod_unknown');
  return eodFor(actor.user, rec);
}

/** Cihazdaki gün sonu denemeden sonra mı: batch no büyük, ya da önceki batch bilinmiyorsa cihaz saati denemeden sonra */
function eodAfter(device: PavoEodSummary, rec: PavoEodRecord): boolean {
  const a = Number(device.batchNo);
  const b = Number(rec.prevBatchNo);
  if (rec.prevBatchNo && Number.isFinite(a) && Number.isFinite(b)) return a > b;
  const at = eodTimeMs(device.deviceDateTime);
  // Cihaz saati dakika hassasiyetinde ve kasa bilgisayarından en çok 5 dk sapabilir (Pavo'nun toleransı)
  return at != null && at >= rec.at - 6 * 60_000;
}

/**
 * Doğrula: cihazın son gün sonu (`/PrintEODCopy`, slip basılmaz) sorulur. Son deneme alınamadı, belirsiz ya da
 * atlandıysa ve cihazdaki gün sonu ondan sonraysa (cihazın menüsünden alınmış ya da yanıtı kaybolmuş) sonuç
 * "alındı" olur, tutarlar cihazınkiyle yazılır.
 */
export async function verifyDeviceEod(actor: Actor) {
  const s = getSettings();
  if (s.okcProvider !== 'pavo') throw conflict('Cihazda gün sonu yalnız Pavo bağlantısında', 'okc_no_eod');
  if (!pavoProvider.configured()) throw conflict(pavoProvider.notConfigured, 'okc_not_configured');
  if ((getSyncState<number>('pavo.sequence') ?? 0) <= 0) throw conflict('Cihaz eşleştirilmemiş; Yönetim › Yazarkasa POS › Eşleştir', 'okc_not_paired');
  const c = pavo()!;
  const busy = busyMessage(c, 'bitince doğrulayın');
  if (busy) throw conflict(busy, 'okc_busy');
  const res = await c.eodCopy(undefined, pavoTiming.eodCopyMs).catch(deviceError);
  const last = getSyncState<PavoEodRecord>(EOD_LAST);
  const user = actor.user;
  if (res.HasError) {
    // 5075: cihazda kayıtlı gün sonu yok. Belirsiz deneme de alınmamış demektir: yeniden denenebilir
    if (String(res.ErrorCode ?? '') === '5075') {
      if (last?.status === 'unknown') {
        const rec: PavoEodRecord = { ...last, status: 'failed', message: 'Doğrulandı: cihazda kayıtlı gün sonu yok', verifiedAt: Date.now() };
        saveEod(rec, user.id, true, {
          severity: 'uyari',
          message: "Pavo cihazında belirsiz kalan banka gün sonu doğrulandı: alınmamış (cihazda kayıtlı gün sonu yok). Yönetim › Yazarkasa POS'tan yeniden deneyin",
        });
        return { changed: true, record: eodFor(user, rec), device: null, message: 'Gün sonu alınmamış (cihazda kayıtlı gün sonu yok); yeniden deneyin' };
      }
      return { changed: false, record: last ? eodFor(user, last) : null, device: null, message: 'Cihazda kayıtlı gün sonu yok' };
    }
    throw new HttpError(502, `Cihaz son gün sonunu vermedi: ${describePavo(res)}`, 'pavo_device');
  }
  const device = eodSummary((res.Data as { eodData?: unknown } | null | undefined)?.eodData);
  if (!device?.batchNo) throw new HttpError(502, 'Cihaz son gün sonunun özetini vermedi', 'pavo_device');
  const seen = `batch ${device.batchNo}${device.deviceDateTime ? `, ${device.deviceDateTime}` : ''}`;
  if (last && last.status !== 'ok' && eodAfter(device, last)) {
    const rec: PavoEodRecord = { ...last, ...device, status: 'ok', errorCode: null, message: 'Gün sonu cihazda alınmış (doğrulandı)', dayCardKurus: dayCardKurus(last.dayId), verifiedAt: Date.now() };
    saveEod(rec, user.id, true);
    return { changed: true, record: eodFor(user, rec), device: eodSummaryFor(user, device), message: `Gün sonu cihazda alınmış (${seen})` };
  }
  if (last?.status === 'unknown') {
    // Belirsizlik çözüldü: cihazda bu denemeden sonra gün sonu yok, deneme alınamadı sayılır (yeniden denenebilir)
    const rec: PavoEodRecord = { ...last, status: 'failed', message: `Doğrulandı: cihazda bu denemeden sonra gün sonu yok (son: ${seen})`, verifiedAt: Date.now() };
    saveEod(rec, user.id, true, {
      severity: 'uyari',
      message: `Pavo cihazında belirsiz kalan banka gün sonu doğrulandı: alınmamış (cihazdaki son gün sonu ${seen}). Yönetim › Yazarkasa POS'tan yeniden deneyin`,
    });
    return { changed: true, record: eodFor(user, rec), device: eodSummaryFor(user, device), message: `Gün sonu alınmamış (cihazdaki son gün sonu ${seen}); yeniden deneyin` };
  }
  const message =
    last && last.status !== 'ok'
      ? `Cihazdaki son gün sonu (${seen}) bu denemeden önce; gün sonu alınmamış`
      : last?.batchNo === device.batchNo
        ? `Cihazdaki son gün sonu LafPOS'takiyle aynı (${seen})`
        : `Cihazdaki son gün sonu: ${seen}`;
  return { changed: false, record: last ? eodFor(user, last) : null, device: eodSummaryFor(user, device), message };
}

/** Cihazın hatası arayüze okunur mesajla döner (beklenmeyen 500 değil) */
function deviceError(e: unknown): never {
  if (e instanceof PavoError) throw new HttpError(502, e.message, e.code === 'CERT_CHANGED' ? 'pavo_cert' : 'pavo_device');
  throw e;
}

export function receiptActor(userId: string): Actor | null {
  const u = db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  return u ? { user: toAuthUser(u), approver: null } : null;
}

export { env as okcEnv };
