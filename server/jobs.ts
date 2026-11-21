import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import type { LiveEvent } from '@shared/events';
import { businessDate, istanbulParts } from '@shared/time';
import { db, schema, sqlite, tx } from './db/client';
import { liveTick, POLL_INTERVAL_MS, reconcileNotifications } from './delivery/live';
import { expirePlatformOrders } from './delivery/service';
import { env } from './env';
import { Effects } from './lib/effects';
import { bus } from './lib/events';
import { getSettings } from './lib/settings';
import { deviceEndOfDay, recoverDeviceEod, resumePolling } from './okc/service';
import { closeDay } from './services/days';
import { warmProductThumbs } from './services/media';
import { getOpenDay, isEmptyOrder } from './services/orders';
import { afterDayClosed, flushOutbox } from './sync/lafmaliyet';
import { siteLinked } from './sync/laffogato-link';
import { onlineOrdersTick } from './sync/laffogato-orders';
import { flushSiteOutbox } from './sync/site-outbox';
import { runMenuSync } from './sync/menu-sync';
import { startCloudSync } from './sync/cloud';
import { startCatchUp } from './sync/catch-up';

/**
 * Menü yoklaması 15 dakikada bir (ETag). Herkese açık menü CDN'den gelir ama CDN'deki kopya eskiyince istek sitenin
 * veritabanını okur ve Neon 5 dakika boşta kalınca uyuduğu için her yoklama bir uyanmadır; 15 dk ve gece hiç
 * (docs/03-ENTEGRASYON.md §2.1). Senkron bütçesi: imzalı uçlara 5 dakikadan sık otomatik istek yok (AGENTS.md kural 6).
 */
export const MENU_SYNC_INTERVAL_MS = 15 * 60_000;
/** LafPOS'un siteye kendi Satışta yazımından sonra eşitleme gecikmesi: art arda yazımlar tek eşitlemede toplanır */
const AFTER_WRITE_SYNC_MS = 5_000;

const timers: NodeJS.Timeout[] = [];
let soonTimer: NodeJS.Timeout | null = null;
let soonForce = false;

/**
 * Otomatik menü eşitlemesi. Site bağlantısı yoksa (LAFFOGATO_URL) siteye hiçbir istek gitmez: ne menü ne görsel.
 * Açık iş günü yokken (gece) atlanır, gün açılınca bir kez çeker. `anyTime`: LafPOS'un siteye kendi Tükendi / Satışa
 * aç yazımından hemen sonra; site o an zaten uyanık, gece de çalışır.
 */
export async function menuTick(opts: { anyTime?: boolean; force?: boolean } = {}) {
  if (!siteLinked() || !getSettings().menuAutoSync) return;
  if (!opts.anyTime && !getOpenDay(db)) return;
  try {
    // force: ETag'e bakılmaz (CDN'deki liste henüz eskiyse 304 dönerdi); fiyat ve Satışta imzalı panelden tazedir
    const r = await runMenuSync({ apply: true, force: opts.force });
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

/**
 * Adlı tek seferlik yedek (denemeyi bitirmeden önce: `lafpos-deneme-oncesi-<an>.db`). Günlük yedeklerin döngüsüne
 * girmez, silinmez. Dosya yazılamazsa hata fırlatır: çağıran silme işine geçmez
 */
export async function backupNamed(label: string): Promise<string> {
  const dir = resolve(env.dataDir, 'backups');
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const file = resolve(dir, `lafpos-${label}-${stamp}.db`);
  await sqlite.backup(file);
  return file;
}

/** Günlük bakımın en son yapıldığı iş günü (yedekten sonra, günde bir) */
let maintainedOn: string | null = null;

/**
 * Günlük veritabanı bakımı: WAL ana dosyaya yazılıp -wal sıfırlanır (TRUNCATE; beş dakikalık PASSIVE denetim noktası
 * dosyayı küçültmez) ve SQLite sorgu istatistiklerini tazeler (`optimize`, yalnız gerekeni)
 */
function dailyMaintenance(day: string) {
  if (maintainedOn === day) return;
  maintainedOn = day;
  try {
    sqlite.pragma('wal_checkpoint(TRUNCATE)');
    sqlite.pragma('optimize');
  } catch (e) {
    console.warn('[bakım] veritabanı bakımı yapılamadı:', e instanceof Error ? e.message : e);
  }
}

async function backupTick() {
  const day = businessDate(Date.now());
  const file = resolve(env.dataDir, 'backups', `lafpos-${day}.db`);
  if (existsSync(file)) return;
  try {
    await backupNow();
  } catch (e) {
    console.warn('[yedek] alınamadı:', e instanceof Error ? e.message : e);
  }
  dailyMaintenance(day);
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
  // Boş adisyonlar (satış sonrası açılan yeni tezgâh gibi) engel değil: gün sonu onları kapatır
  const open = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos')))
    .all()
    .filter((o) => !isEmptyOrder(db, o.id));
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
  afterDayClosed(closed.id);
  // Pavo: cihazda banka gün sonu; beklenmez, cihaz yanıt vermese de gün kapalı kalır (docs/04-YAZARKASA.md §8.5)
  void deviceEndOfDay(closed.id, null).catch((e) => console.warn('[pavo] gün sonu', e instanceof Error ? e.message : e));
}

/** LafPOS'un siteye Satışta yazımından birkaç saniye sonra bir menü eşitlemesi */
export function menuSyncSoon(delayMs = AFTER_WRITE_SYNC_MS, opts: { force?: boolean } = {}) {
  if (opts.force) soonForce = true;
  if (soonTimer) return;
  soonTimer = setTimeout(() => {
    soonTimer = null;
    const force = soonForce;
    soonForce = false;
    void menuTick({ anyTime: true, force });
  }, delayMs);
}

/** Paket platformları: kabul süresi geçen bekleyen sipariş platformda iptal olmuştur */
function platformTick() {
  try {
    const fx = new Effects();
    tx((t) => expirePlatformOrders(t, fx));
    fx.flush();
  } catch (e) {
    console.error('[platform] süre denetimi', e);
  }
}

export function startJobs() {
  if (process.env.LAFPOS_NO_JOBS === '1') return;
  timers.push(setTimeout(() => void menuTick(), 8_000));
  timers.push(setInterval(() => void menuTick(), MENU_SYNC_INTERVAL_MS));
  // Online siparişler: 20 sn'de bir sürüm sinyali (site veritabanına dokunmaz); sinyal yoksa en sık 5 dk'da bir çekme
  timers.push(setTimeout(onlineOrdersTick, 12_000));
  timers.push(setInterval(onlineOrdersTick, 20_000));
  timers.push(setInterval(() => void flushOutbox(), 60_000));
  // Siteye bildirilemeyen Satışta yazımları (porsiyon sayacı): dakikada bir, bekleme süresi dolanlar
  timers.push(setInterval(() => void flushSiteOutbox(), 60_000));
  timers.push(setInterval(autoDayEndTick, 60_000));
  timers.push(setInterval(platformTick, 30_000));
  // Canlı platform bağlantısı: yoklama (Trendyol Go) ve bekleyen aşama bildirimleri; anahtar yokken hiç istek yok
  timers.push(setTimeout(() => void liveTick(), 15_000));
  timers.push(setInterval(() => void liveTick(), POLL_INTERVAL_MS));
  timers.push(setTimeout(backupTick, 30_000));
  // Yeniden başlatmadan önce yazarkasaya gönderilmiş, sonucu beklenen sepetler sorgulanmaya devam eder
  resumePolling();
  // Pavo gün sonu sürerken süreç kapandıysa sonuç belirsizdir: alarm, yeniden denemeden önce doğrulama
  try {
    recoverDeviceEod();
  } catch (e) {
    console.error('[pavo] gün sonu kaydı', e);
  }
  // LafPOS Uzaktan (Vercel): tanımlıysa canlı özet
  timers.push(...startCloudSync());
  // İnternet dönüşü: bekleyenler beklemeden bir kez gider; internet yokken dakikada bir TCP denemesi (HTTP yok)
  timers.push(...startCatchUp());
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
  bus.on('event', onJobEvent);
}

/**
 * Zamanlayıcının olay dinleyicisi (testler de bunu bağlar). Porsiyon sayacıyla değişen Satışta bilgisi siteye de
 * gider: biten ürün tükenir, hazırlanmadan iptal edilen kalemle porsiyonu geri dönen ürün yeniden satışa açılır.
 * Adisyon işlemi yazımı giden kutusuna koydu (server/sync/site-outbox.ts); burada hemen gönderilir.
 */
export function onJobEvent(e: LiveEvent) {
  if (e.topic === 'sync' && e.kind === 'availability.push') void flushSiteOutbox();
  // LafPOS siteye Satışta yazdı: site o an uyanık, menü de eşitlenir (sonraki yoklama 15 dk sonra)
  if (e.topic === 'sync' && e.kind === 'site.menu.written') menuSyncSoon();
  // Sitenin menü işareti değişti (fiyat ya da Satışta sitede veya lafmaliyet panelinde değişti): hemen, ETag'siz
  if (e.topic === 'sync' && e.kind === 'site.menu.changed') menuSyncSoon(1_000, { force: true });
  // Gün açıldı: gece atlanan menü yoklaması bir kez
  if (e.topic === 'cash' && (e.kind === 'day.opened' || e.kind === 'day.reopened')) void menuTick();
  // Paket siparişinin aşaması değişti: canlı platforma hemen yazılır (gidemezse 20 sn'lik turda yeniden)
  if (e.topic === 'delivery' && e.kind === 'delivery.status' && process.env.LAFPOS_NO_JOBS !== '1') void reconcileNotifications().catch(() => undefined);
}

export function stopJobs() {
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  bus.off('event', onJobEvent);
  if (soonTimer) clearTimeout(soonTimer);
  soonTimer = null;
}
