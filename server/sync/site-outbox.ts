import { and, asc, eq, isNull, lte } from 'drizzle-orm';
import { type DB, db, schema, type Tx } from '../db/client';
import { env } from '../env';
import { Effects } from '../lib/effects';
import { setSyncState } from '../lib/settings';
import { signedFetch } from '../lib/signature';
import { siteSigned } from './laffogato-link';

/**
 * Siteye giden Satışta yazımları (`POST /api/panel/menu`). Porsiyonu biten siteye bağlı ürünün Tükendi'si giden
 * kutusunda bekler (`outbox`: target 'laffogato', kind 'menu.isActive', tekil anahtar `menu:<extId>`): internet
 * yokken satış durmaz, gönderilemeyen yazım kaybolmaz, artan beklemeyle yeniden denenir. Ürün bu arada yeniden
 * açılırsa kayıt düşer. Elle "Tükendi / Satışa aç" beklemez, doğrudan yazar; hepsi aynı kilitle sıralanır.
 */

const keyOf = (extId: string) => `menu:${extId}`;

let chain: Promise<unknown> = Promise.resolve();

/** Siteye Satışta yazımlarını sıraya koyar: giden kutusu, "Tükendi / Satışa aç" ve porsiyon doldurma birbirini ezmesin */
export function withSiteMenuLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** Porsiyonu biten siteye bağlı ürünün Tükendi'sini giden kutusuna koyar; çağıranın işleminde (adisyon kalemiyle tek işlem) */
export function enqueueSiteSoldOut(t: Tx | DB, p: { extSource: string | null; extId: string | null }): boolean {
  if (!siteSigned() || p.extSource !== 'laffogato' || !p.extId) return false;
  const key = keyOf(p.extId);
  const now = Date.now();
  t.delete(schema.outbox).where(and(eq(schema.outbox.dedupeKey, key), isNull(schema.outbox.sentAt))).run();
  t.insert(schema.outbox)
    .values({ target: 'laffogato', kind: 'menu.isActive', dedupeKey: key, payload: { id: p.extId, isActive: false, actor: 'LafPOS porsiyon' }, createdAt: now, nextAttemptAt: now })
    .run();
  return true;
}

/** Ürün yeniden açılınca bekleyen Tükendi yazımı düşer (gönderilmemiş ya da sitenin reddettiği) */
export function dropSiteSoldOut(t: Tx | DB, extId: string | null) {
  if (!extId) return;
  t.delete(schema.outbox).where(and(eq(schema.outbox.target, 'laffogato'), eq(schema.outbox.dedupeKey, keyOf(extId)), isNull(schema.outbox.sentAt))).run();
}

/** Site bunları düzeltilmeden kabul etmez: tekrar denenmez, Yönetim › Entegrasyon'da hata olarak görünür */
const PERMANENT = new Set([400, 403, 404, 409, 413, 422]);

/** Bekleyen Tükendi yazımlarını gönderir (dakikada bir ve porsiyon biter bitmez) */
export function flushSiteOutbox(): Promise<{ sent: number; failed: number }> {
  if (!siteSigned()) return Promise.resolve({ sent: 0, failed: 0 });
  return withSiteMenuLock(sendDue).catch((e) => {
    console.warn('[site] Tükendi bildirimleri gönderilemedi:', e instanceof Error ? e.message : e);
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
    const payload = row.payload as { id: string; isActive: boolean; actor: string };
    // Bu arada yeniden açılan (porsiyon doldu, yönetici açtı) ürün sitede kapatılmaz
    const p = db.select({ active: schema.products.active }).from(schema.products).where(and(eq(schema.products.extSource, 'laffogato'), eq(schema.products.extId, payload.id))).get();
    if (!p || p.active) {
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
      if (PERMANENT.has(status)) {
        db.update(schema.outbox)
          .set({ attempts: row.attempts + 1, lastError: `Site Tükendi bilgisini reddetti (HTTP ${status})`, nextAttemptAt: Date.now() + 365 * 86400_000 })
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
        .set({ attempts, lastError: `Site Tükendi bilgisini alamadı: ${e instanceof Error ? e.message : String(e)}`, nextAttemptAt: Date.now() + wait })
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

/** Yönetim › Entegrasyon ve Genel bakış: siteye bildirilemeyen Tükendi yazımları */
export function siteOutboxStatus() {
  const rows = db
    .select({ lastError: schema.outbox.lastError })
    .from(schema.outbox)
    .where(and(eq(schema.outbox.target, 'laffogato'), isNull(schema.outbox.sentAt)))
    .all();
  return { pending: rows.length, lastError: rows.find((r) => r.lastError)?.lastError ?? null };
}
