import { and, asc, eq, isNotNull, isNull, lte } from 'drizzle-orm';
import { type DB, db, schema, type Tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { getSyncState, setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { siteSigned } from './laffogato-link';

/**
 * Siteye giden Satışta yazımları (`POST /api/panel/menu`). Porsiyon sayacının değiştirdiği Satışta bilgisi giden
 * kutusunda bekler (`outbox`: target 'laffogato', kind 'menu.isActive', tekil anahtar `menu:<extId>`, son istenen
 * durum): son porsiyonu satılan ürün sitede de Tükendi olur, hazırlanmadan iptal edilen kalemle porsiyonu geri dönen
 * ürün sitede yeniden satışa açılır. İnternet yokken satış durmaz, gönderilemeyen yazım kaybolmaz, artan beklemeyle
 * yeniden denenir. Ürün bu arada başka yoldan açılır ya da kapanırsa kayıt düşer. Elle "Tükendi / Satışa aç" ve
 * porsiyon doldurma beklemez, doğrudan yazar; hepsi ve menü eşitlemesi aynı kilitle sıralanır.
 */

const keyOf = (extId: string) => `menu:${extId}`;
const extIdOf = (key: string | null) => (key?.startsWith('menu:') ? key.slice(5) : null);
/** Sitenin kalıcı olarak reddettiği yazım: yeniden denenmez (`nextAttemptAt` hiç gelmez), Entegrasyon'da görünür */
const PARKED = Number.MAX_SAFE_INTEGER;

/** Masa QR kodlarının siteye gidişi: tek bekleyen kayıt, son liste geçerli */
const TABLES_KEY = 'tables';
const TABLES_KIND = 'tables.sync';
export const TABLES_PUSH_STATE = 'laffogato.tablesPush';
/** Yenilenen (emekli) masa kodları: siteye `active: false` ile gider ki eski kart sitede de kapansın */
export const RETIRED_CODES_STATE = 'laffogato.retiredTableCodes';
const RETIRED_MAX = 200;
/** Site ucu henüz yoksa (404) liste bu aralıkla yeniden denenir; kod üretimi ve "yeniden gönder" hemen dener */
const UNSUPPORTED_RETRY_MS = 6 * 3600_000;

export function retireTableCode(code: string) {
  const list = (getSyncState<string[]>(RETIRED_CODES_STATE) ?? []).filter((c) => c !== code);
  setSyncState(RETIRED_CODES_STATE, [...list, code].slice(-RETIRED_MAX));
}

export interface TablesPushState {
  lastSentAt?: number;
  lastTriedAt?: number;
  /** Site `PUT /api/panel/tables` ucunu henüz tanımıyor (404/405/501): yeniden denenmez, sonraki üretimde yine denenir */
  unsupported?: boolean;
  lastError?: string | null;
}

/**
 * QR kodlu masaların listesini siteye gönderilmek üzere giden kutusuna koyar (docs/03-ENTEGRASYON.md §2.3 "Masa QR"):
 * kod üretilince, yenilenince, masa adı ya da etkinliği değişince. Site kodu `cafe_tables`'a alır; böylece LafPOS'un
 * ürettiği QR sitede ve uygulamada masayı bulur. Bağlantı anahtarı yokken kuyruğa girmez.
 */
export function enqueueSiteTables(t: Tx | DB): boolean {
  if (!siteSigned()) return false;
  const live = t
    .select({ qrCode: schema.tables.qrCode, name: schema.tables.name, active: schema.tables.active, kind: schema.tables.kind })
    .from(schema.tables)
    .where(and(isNotNull(schema.tables.qrCode), eq(schema.tables.kind, 'masa')))
    .orderBy(asc(schema.tables.sort))
    .all()
    .map((x) => ({ code: x.qrCode!, name: x.name, active: x.active }));
  const current = new Set(live.map((x) => x.code));
  // Yenilenen kodlar pasif olarak gider: sitede eski kart da kapanır
  const retired = (getSyncState<string[]>(RETIRED_CODES_STATE) ?? []).filter((c) => !current.has(c)).map((code) => ({ code, name: 'Eski kart', active: false }));
  const tables = [...live, ...retired];
  const now = Date.now();
  t.delete(schema.outbox).where(and(eq(schema.outbox.target, 'laffogato'), eq(schema.outbox.dedupeKey, TABLES_KEY), isNull(schema.outbox.sentAt))).run();
  t.insert(schema.outbox).values({ target: 'laffogato', kind: TABLES_KIND, dedupeKey: TABLES_KEY, payload: { tables, actor: 'LafPOS' }, createdAt: now, nextAttemptAt: now }).run();
  return true;
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Siteye Satışta yazımlarını ve menü eşitlemesinin panel okumasını sıraya koyar: giden kutusu, "Tükendi / Satışa aç",
 * porsiyon doldurma ve eşitleme birbirini ezmesin (eşitleme, istek yoldayken yapılan yazımı eski görüntüyle geri almasın)
 */
export function withSiteMenuLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Porsiyon sayacının değiştirdiği Satışta bilgisini giden kutusuna koyar; çağıranın işleminde (adisyon kalemiyle tek
 * işlem). Aynı ürünün bekleyen yazımının yerini alır: siteye son durum gider.
 */
export function enqueueSiteAvailability(t: Tx | DB, p: { extSource: string | null; extId: string | null }, active: boolean): boolean {
  if (!siteSigned() || p.extSource !== 'laffogato' || !p.extId) return false;
  const key = keyOf(p.extId);
  const now = Date.now();
  t.delete(schema.outbox).where(and(eq(schema.outbox.target, 'laffogato'), eq(schema.outbox.dedupeKey, key), isNull(schema.outbox.sentAt))).run();
  t.insert(schema.outbox)
    .values({ target: 'laffogato', kind: 'menu.isActive', dedupeKey: key, payload: { id: p.extId, isActive: active, actor: 'LafPOS porsiyon' }, createdAt: now, nextAttemptAt: now })
    .run();
  return true;
}

/** Porsiyonu biten siteye bağlı ürünün Tükendi'si */
export const enqueueSiteSoldOut = (t: Tx | DB, p: { extSource: string | null; extId: string | null }) => enqueueSiteAvailability(t, p, false);

/** Ürünün Satışta bilgisi siteye doğrudan yazıldı (yönetici açtı, porsiyon dolduruldu): bekleyen yazımı düşer */
export function dropSiteSoldOut(t: Tx | DB, extId: string | null) {
  if (!extId) return;
  t.delete(schema.outbox).where(and(eq(schema.outbox.target, 'laffogato'), eq(schema.outbox.dedupeKey, keyOf(extId)), isNull(schema.outbox.sentAt))).run();
}

/**
 * Menü eşitlemesi (kilit içinde, panelin taze listesiyle): sitenin zaten istenen durumda olduğu ve sitede artık
 * olmayan kalemlerin yazımı düşer. Kalanların ürünü `held` olarak döner: site görüntüsü LafPOS'un henüz gönderemediği
 * yazımdan eskidir, eşitleme o ürünün Satışta bilgisine dokunmaz. Reddedilmiş yazım ürünü tutmaz (sitenin durumu
 * geçerli), yalnız uyarı olarak kalır.
 */
export function settleSiteWrites(t: Tx | DB, panel: Map<string, { isActive: boolean }> | null): Set<string> {
  const held = new Set<string>();
  const rows = t
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'laffogato'), isNull(schema.outbox.sentAt)))
    .all();
  for (const row of rows) {
    const extId = extIdOf(row.dedupeKey);
    if (!extId) continue;
    const want = (row.payload as { isActive?: unknown }).isActive;
    if (panel) {
      const site = panel.get(extId);
      if (!site || site.isActive === want) {
        t.delete(schema.outbox).where(eq(schema.outbox.id, row.id)).run();
        continue;
      }
    }
    if (row.nextAttemptAt !== PARKED) held.add(extId);
  }
  return held;
}

/** Site bunları düzeltilmeden kabul etmez: tekrar denenmez, Yönetim › Entegrasyon'da hata olarak görünür */
const PERMANENT = new Set([400, 403, 409, 413, 422]);

/** Bekleyen Satışta yazımlarını gönderir (dakikada bir ve porsiyon değişir değişmez) */
export function flushSiteOutbox(): Promise<{ sent: number; failed: number }> {
  if (!siteSigned()) return Promise.resolve({ sent: 0, failed: 0 });
  return withSiteMenuLock(sendDue).catch((e) => {
    console.warn('[site] Satışta bildirimleri gönderilemedi:', e instanceof Error ? e.message : e);
    return { sent: 0, failed: 0 };
  });
}

async function sendDue(): Promise<{ sent: number; failed: number }> {
  let sent = 0;
  let failed = 0;
  const due = db
    .select()
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'laffogato'), isNull(schema.outbox.sentAt), lte(schema.outbox.nextAttemptAt, Date.now())))
    .orderBy(asc(schema.outbox.id))
    .limit(20)
    .all();
  for (const row of due) {
    if (row.kind === TABLES_KIND) {
      const r = await sendTables(row);
      if (r === 'sent') sent++;
      else if (r === 'failed') failed++;
      continue;
    }
    const payload = row.payload as { id: string; isActive: boolean; actor: string };
    // Ürün bu arada başka yoldan açıldı ya da kapandı (porsiyon doldu, yönetici açtı, site kapattı): yazım eskidi
    const p = db.select({ active: schema.products.active }).from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, payload.id))).get();
    if (!p || p.active !== payload.isActive) {
      db.delete(schema.outbox).where(eq(schema.outbox.id, row.id)).run();
      continue;
    }
    try {
      const { status } = await signedFetch(env.laffogatoPanelSecret, 'POST', new URL(`${env.laffogatoUrl}/api/panel/menu`), payload);
      if (status === 200) {
        db.update(schema.outbox).set({ sentAt: Date.now(), lastError: null, attempts: row.attempts + 1 }).where(eq(schema.outbox.id, row.id)).run();
        sent++;
        continue;
      }
      // Kalem sitede yok (silinmiş): sitede açılacak ya da kapatılacak bir şey yok, yazım tamamdır
      if (status === 404) {
        db.delete(schema.outbox).where(eq(schema.outbox.id, row.id)).run();
        continue;
      }
      if (PERMANENT.has(status)) {
        db.update(schema.outbox)
          .set({ attempts: row.attempts + 1, lastError: `Site Satışta bilgisini reddetti (HTTP ${status})`, nextAttemptAt: PARKED })
          .where(eq(schema.outbox.id, row.id))
          .run();
        failed++;
        continue;
      }
      throw new Error(`HTTP ${status}`);
    } catch (e) {
      const attempts = row.attempts + 1;
      const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8));
      db.update(schema.outbox)
        .set({ attempts, lastError: `Site Satışta bilgisini alamadı: ${e instanceof Error ? e.message : String(e)}`, nextAttemptAt: Date.now() + wait })
        .where(eq(schema.outbox.id, row.id))
        .run();
      failed++;
    }
  }
  if (sent || failed) setSyncState('laffogato.menuPush', { lastRunAt: Date.now(), sent, failed });
  if (sent) {
    const fx = new Effects();
    fx.emit({ topic: 'sync', kind: 'site.menu.written' });
    fx.flush();
  }
  return { sent, failed };
}

/**
 * Masa listesini siteye yazar (`PUT /api/panel/tables`). Site ucu henüz tanımıyorsa (404, 405, 501) kayıt kalır, durum
 * "site henüz almıyor" olur ve 6 saatte bir yeniden denenir (kod üretimi ve Entegrasyon'daki "yeniden gönder" hemen
 * dener). Kalıcı ret park edilir.
 */
async function sendTables(row: typeof schema.outbox.$inferSelect): Promise<'sent' | 'failed' | 'skipped'> {
  const now = Date.now();
  const state = (): TablesPushState => (getSyncState<TablesPushState>(TABLES_PUSH_STATE) ?? {});
  try {
    const { status } = await signedFetch(env.laffogatoPanelSecret, 'PUT', new URL(`${env.laffogatoUrl}/api/panel/tables`), row.payload);
    if (status === 200) {
      db.update(schema.outbox).set({ sentAt: now, lastError: null, attempts: row.attempts + 1 }).where(eq(schema.outbox.id, row.id)).run();
      setSyncState(TABLES_PUSH_STATE, { ...state(), lastSentAt: now, lastTriedAt: now, unsupported: false, lastError: null });
      return 'sent';
    }
    if (status === 404 || status === 405 || status === 501) {
      // Site ucu henüz yok: kayıt düşmez, 6 saatte bir yeniden denenir (kod üretimi ve "yeniden gönder" hemen dener)
      db.update(schema.outbox).set({ attempts: row.attempts + 1, lastError: null, nextAttemptAt: now + UNSUPPORTED_RETRY_MS }).where(eq(schema.outbox.id, row.id)).run();
      setSyncState(TABLES_PUSH_STATE, { ...state(), lastTriedAt: now, unsupported: true, lastError: null });
      return 'skipped';
    }
    if (PERMANENT.has(status)) {
      const lastError = `Site masa kodlarını reddetti (HTTP ${status})`;
      db.update(schema.outbox).set({ attempts: row.attempts + 1, lastError, nextAttemptAt: PARKED }).where(eq(schema.outbox.id, row.id)).run();
      setSyncState(TABLES_PUSH_STATE, { ...state(), lastTriedAt: now, unsupported: false, lastError });
      return 'failed';
    }
    throw new Error(`HTTP ${status}`);
  } catch (e) {
    const attempts = row.attempts + 1;
    const wait = Math.min(6 * 3600_000, 60_000 * 2 ** Math.min(attempts, 8));
    const lastError = `Site masa kodlarını alamadı: ${e instanceof Error ? e.message : String(e)}`;
    db.update(schema.outbox).set({ attempts, lastError, nextAttemptAt: now + wait }).where(eq(schema.outbox.id, row.id)).run();
    setSyncState(TABLES_PUSH_STATE, { ...state(), lastTriedAt: now, lastError });
    return 'failed';
  }
}

/** Yönetim › Entegrasyon: masa kodlarının siteye gidişi (anahtar yokken boş) */
export function siteTablesPushStatus(): TablesPushState | null {
  return siteSigned() ? (getSyncState<TablesPushState>(TABLES_PUSH_STATE) ?? {}) : null;
}

/**
 * Yönetim › Entegrasyon ve Genel bakış: siteye bildirilemeyen Satışta yazımları. `pending` yeniden denenir,
 * `rejected` site kalıcı olarak reddetti (yeniden denenmez). Bağlantı anahtarı yokken gönderim de yoktur: sayılmaz.
 * Masa listesi (`tables.sync`) burada sayılmaz; onun durumu `siteTablesPushStatus`.
 */
export function siteOutboxStatus(): { pending: number; rejected: number; lastError: string | null } {
  if (!siteSigned()) return { pending: 0, rejected: 0, lastError: null };
  const rows = db
    .select({ lastError: schema.outbox.lastError, nextAttemptAt: schema.outbox.nextAttemptAt })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'laffogato'), isNull(schema.outbox.sentAt), eq(schema.outbox.kind, 'menu.isActive')))
    .all();
  const rejected = rows.filter((r) => r.nextAttemptAt === PARKED).length;
  return { pending: rows.length - rejected, rejected, lastError: rows.find((r) => r.lastError)?.lastError ?? null };
}
