import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { businessDate, istanbulParts } from '@shared/time';
import { db, schema, sqlite, tx } from './db/client';
import { env } from './env';
import { Effects } from './lib/effects';
import { bus } from './lib/events';
import { getSettings } from './lib/settings';
import { closeDay } from './services/days';
import { warmProductThumbs } from './services/media';
import { getOpenDay } from './services/orders';
import { enqueueDay, flushOutbox } from './sync/lafmaliyet';
import { onlineOrdersTick, pushSoldOut } from './sync/laffogato-orders';
import { runMenuSync } from './sync/menu-sync';
import { startCloudSync } from './sync/cloud';

/** Senkron bütçesi: laffogato'nun veritabanına giden otomatik istekler 5 dakikadan sık değil (senkron.md). */
export const SYNC_INTERVAL_MS = 5 * 60_000;

const timers: NodeJS.Timeout[] = [];

async function menuTick() {
  if (!getSettings().menuAutoSync) return;
  try {
    const r = await runMenuSync({ apply: true });
    if (r.status === 'uygulandi') console.log(`[senkron] site menüsü uygulandı: ${r.preview?.changes.length ?? 0} değişiklik`);
  } catch (e) {
    console.warn('[senkron] site menüsü alınamadı:', e instanceof Error ? e.message : e);
  }
  // Yeni ya da değişen ürün görsellerinin küçük kopyası (kart için); eksik yoksa istek gitmez
  const fetched = await warmProductThumbs().catch(() => 0);
  if (fetched) console.log(`[görsel] ${fetched} ürün görseli indirildi`);
}

/** Günlük SQLite yedeği: data/backups/lafpos-YYYY-MM-DD.db, son N gün tutulur. */
export async function backupNow(): Promise<string> {
  const dir = resolve(env.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const file = resolve(dir, `lafpos-${businessDate(Date.now())}.db`);
  await sqlite.backup(file);
  const keep = getSettings().backupKeep;
  const files = readdirSync(dir).filter((f) => /^lafpos-\d{4}-\d{2}-\d{2}\.db$/.test(f)).sort();
  for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(resolve(dir, f));
  return file;
}

async function backupTick() {
  const file = resolve(env.dataDir, 'backups', `lafpos-${businessDate(Date.now())}.db`);
  if (existsSync(file)) return;
  try {
    await backupNow();
  } catch (e) {
    console.warn('[yedek] alınamadı:', e instanceof Error ? e.message : e);
  }
}

let lastAutoWarn = 0;

/** Otomatik gün sonu: ayarlanan saatte açık POS adisyonu yoksa günü sayımsız kapatır (föy sonra girilir). */
function autoDayEndTick() {
  const s = getSettings();
  if (!s.autoDayEnd) return;
  const p = istanbulParts(Date.now());
  if (p.hour !== s.autoDayEndHour || p.minute > 15) return;
  const day = getOpenDay(db);
  // Yeni açılmış (ya da gün sonundan sonra yeniden açılmış) gün hemen kapatılmaz
  if (!day || Date.now() - Math.max(day.openedAt, day.reopenedAt ?? 0) < 3 * 3600_000) return;
  const open = db.select({ id: schema.orders.id }).from(schema.orders).where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos'))).all();
  const fx = new Effects();
  if (open.length) {
    if (Date.now() - lastAutoWarn > 30 * 60_000) {
      lastAutoWarn = Date.now();
      fx.audit(db, { action: 'day.auto_skip', severity: 'uyari', message: `Otomatik gün sonu alınamadı: ${open.length} açık adisyon var` });
      fx.flush();
    }
    return;
  }
  const closed = tx((t) => closeDay(t, null, fx, { countedCash: null, note: 'Otomatik gün sonu' }));
  fx.flush();
  if (enqueueDay(closed.id)) void flushOutbox();
}

export function startJobs() {
  if (process.env.LAFPOS_NO_JOBS === '1') return;
  timers.push(setTimeout(menuTick, 8_000));
  timers.push(setInterval(menuTick, SYNC_INTERVAL_MS));
  // Online siparişler: 20 sn'de bir sürüm sinyali (site veritabanına dokunmaz); sinyal yoksa en sık 5 dk'da bir çekme
  timers.push(setTimeout(onlineOrdersTick, 12_000));
  timers.push(setInterval(onlineOrdersTick, 20_000));
  timers.push(setInterval(() => void flushOutbox(), 60_000));
  timers.push(setInterval(autoDayEndTick, 60_000));
  timers.push(setTimeout(backupTick, 30_000));
  // LafPOS Uzaktan (Vercel): tanımlıysa canlı özet
  timers.push(...startCloudSync());
  // WAL'deki işlemler beş dakikada bir ana dosyaya yazılır: lafpos.db'yi kopyalayan son satışları da alır
  timers.push(
    setInterval(() => {
      try {
        sqlite.pragma('wal_checkpoint(PASSIVE)');
      } catch {
        /* veritabanı meşgulse bir sonraki turda */
      }
    }, 5 * 60_000),
  );
  timers.push(setInterval(backupTick, 60 * 60_000));
  // Porsiyonu biten ürün sitede de tükensin
  bus.on('event', (e) => {
    if (e.topic === 'sync' && e.kind === 'availability.push' && e.message) void pushSoldOut([e.message]);
  });
}

export function stopJobs() {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
}
