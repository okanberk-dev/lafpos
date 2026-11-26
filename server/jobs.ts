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
import { getSettings, getSyncState } from './lib/settings';
import { autoEodExpected, deviceEndOfDay, recoverDeviceEod, resumePolling } from './okc/service';
import { kablo } from './okc/token-kablo';
import { syncTokenKablo } from './okc/token-kablo-servis';
import { closeDay } from './services/days';
import { warmProductThumbs } from './services/media';
import { getOpenDay, isEmptyOrder } from './services/orders';
import { afterDayClosed, flushOutbox } from './sync/lafmaliyet';
import { modposTick } from './sync/modpos';
import { siteLinked } from './sync/laffogato-link';
import { onlineOrdersTick } from './sync/laffogato-orders';
import { flushSiteOutbox } from './sync/site-outbox';
import { runMenuSync } from './sync/menu-sync';
import { type PriceTiming, priceInstant } from './sync/laffogato-menu';
import { startCloudSync } from './sync/cloud';
import { startMerkez } from './sync/merkez';
import { startPlatformKeys } from './sync/platform-anahtar';
import { afterDeviceEod, closingNoticeTick, startNotices } from './sync/bildirim';
import { afterDailyBackup } from './sync/yedek';
import { startCatchUp } from './sync/catch-up';

/**
 * Menü yoklaması 15 dakikada bir (ETag). Herkese açık menü CDN'den gelir ama CDN'deki kopya eskiyince istek sitenin
 * veritabanını okur ve Neon 5 dakika boşta kalınca uyuduğu için her yoklama bir uyanmadır; 15 dk ve gece hiç
 * (docs/03-ENTEGRASYON.md §2.1). Senkron bütçesi: imzalı uçlara 5 dakikadan sık otomatik istek yok (AGENTS.md kural 6).
 */
export const MENU_SYNC_INTERVAL_MS = 15 * 60_000;
/** LafPOS'un siteye kendi Satışta yazımından sonra eşitleme gecikmesi: art arda yazımlar tek eşitlemede toplanır */
const AFTER_WRITE_SYNC_MS = 5_000;
/**
 * Sitenin menü işaretiyle tetiklenen ETag'siz eşitlemeler arası en az süre (imzalı panel okuması da yapar): art arda
 * düzenlemeler (lafmaliyet'ten 30 ürünün fiyatı) sonda tek eşitlemede toplanır. docs/03-ENTEGRASYON.md §2.1
 */
export const MARKER_SYNC_MIN_MS = 60_000;
/** LafPOS'un kendi yazımından sonraki eşitleme, bu kadar yeni bir eşitleme varsa atlanır (sinyal onu zaten izler) */
const RECENT_SYNC_MS = 20_000;
/** CDN'deki herkese açık liste bayatsa (s-maxage=60 + swr=60) bir kez ETag'siz yeniden eşitleme */
export const CDN_REFRESH_MS = 2 * 60_000;
/**
 * Şube fiyatı (laffogato #301, docs/03-ENTEGRASYON.md §2.1): sitenin söylediği bir sonraki fiyat anından bu kadar sonra
 * tek bir ETag'siz eşitleme (iki saat arasındaki küçük kayma için pay). O an gelince site hiçbir şey yazmaz, işaret oynamaz
 */
export const PRICE_SYNC_DELAY_MS = 5_000;
/**
 * Bundan uzak fiyat anı zamanlayıcıya kurulmaz (site 90 güne kadar ileri yazar; `setTimeout` 24,8 günden uzunu hemen
 * çalıştırır): gün açıkken her yoklama yeniden bakar, an yaklaşınca kurulur
 */
export const PRICE_SYNC_HORIZON_MS = 24 * 3600_000;

const timers: NodeJS.Timeout[] = [];
/** Bekleyen tek menü eşitlemesi: yeni istek en erken olanla birleşir (zorunluluk ve gece izni toplanır) */
let pendingSync: { at: number; force: boolean; anyTime: boolean; timer: NodeJS.Timeout } | null = null;
let lastSyncAt = 0;
/** Son zorunlu (ETag'siz) zamanlanmış eşitleme: işaret ve fiyat anı eşitlemeleri arası en az `MARKER_SYNC_MIN_MS` */
let lastMarkerSyncAt = 0;
/** Gece (açık gün yokken) menü işareti değişti: gün açılınca bir kez ETag'siz eşitlenir */
let menuDirty = false;
/** CDN bayatlığı için yeniden eşitleme bir kez kuruldu: yine bayatsa 15 dakikalık yoklama bekler (döngü yok) */
let cdnRetried = false;
/**
 * Bu süreçte ETag'siz bir eşitleme yapıldı. Menü işareti ve fiyat anı bellekte ya da son okumada: kasa kapalıyken
 * (gece, güncelleme) yazılan şube fiyatını herkese açık menü göstermez (304, Tuzla'nın listesi değişmez), işaretin ilk
 * okuması da onu taban alır. Süreç başına bir kez (ilk yoklama ya da gün açılışı) ETag'siz: bir imzalı okuma
 */
let processSynced = false;

/** Testler için: zamanlayıcının menü belleğini sıfırlar */
export function resetMenuScheduler() {
  if (pendingSync) clearTimeout(pendingSync.timer);
  pendingSync = null;
  lastSyncAt = 0;
  lastMarkerSyncAt = 0;
  menuDirty = false;
  cdnRetried = false;
  processSynced = false;
}

/** Testler için: bekleyen eşitleme (an ve ETag'siz mi) */
export const pendingMenuSync = () => (pendingSync ? { at: pendingSync.at, force: pendingSync.force } : null);
export const menuSyncDirty = () => menuDirty;

function scheduleMenuSync(at: number, force: boolean, anyTime: boolean) {
  if (pendingSync) {
    if (pendingSync.at <= at) {
      pendingSync.force ||= force;
      pendingSync.anyTime ||= anyTime;
      return;
    }
    clearTimeout(pendingSync.timer);
    force ||= pendingSync.force;
    anyTime ||= pendingSync.anyTime;
  }
  const timer = setTimeout(() => void runScheduledSync(), Math.max(0, at - Date.now()));
  pendingSync = { at, force, anyTime, timer };
}

/** Bekleyen eşitlemeyi çalıştırır (zamanlayıcı ya da test) */
export async function runScheduledSync() {
  const job = pendingSync;
  if (!job) return;
  clearTimeout(job.timer);
  pendingSync = null;
  const now = Date.now();
  // Gün bu arada kapandı: işaret eşitlemesi gün açılışına kalır
  if (!job.anyTime && !getOpenDay(db)) {
    if (job.force) menuDirty = true;
    return;
  }
  lastSyncAt = now;
  if (job.force) lastMarkerSyncAt = now;
  await menuTick({ anyTime: job.anyTime, force: job.force });
}

/**
 * Otomatik menü eşitlemesi. Site bağlantısı yoksa (LAFFOGATO_URL) siteye hiçbir istek gitmez: ne menü ne görsel.
 * Açık iş günü yokken (gece) atlanır, gün açılınca bir kez çeker. `anyTime`: LafPOS'un siteye kendi Tükendi / Satışa
 * aç yazımından hemen sonra; site o an zaten uyanık, gece de çalışır.
 */
export async function menuTick(opts: { anyTime?: boolean; force?: boolean } = {}) {
  if (!siteLinked() || !getSettings().menuAutoSync) return;
  if (!opts.anyTime && !getOpenDay(db)) return;
  // Şubenin fiyat anı son imzalı okumadan sonra geçti (gece, zamanlayıcı kaçtı ya da o eşitleme başaramadı): ETag'siz,
  // yoksa herkese açık menü 304 döner ve imzalı okuma yapılmazdı. En sık yoklama aralığında (15 dk), bütçe içinde
  // Süreç yeni başladı: kapalıyken yazılan şube fiyatı için bir kez ETag'siz (`processSynced`)
  const force = opts.force || !processSynced || priceInstant(menuState(), Date.now()).due;
  try {
    // force: ETag'e bakılmaz (CDN'deki liste henüz eskiyse 304 dönerdi); fiyat ve Satışta imzalı panelden tazedir
    const r = await runMenuSync({ apply: true, force });
    if (force) processSynced = true;
    if (r.status === 'uygulandi') console.log(`[senkron] site menüsü uygulandı: ${r.preview?.changes.length ?? 0} değişiklik`);
    // CDN'deki liste bayat (sitede yeniden açılan ürün listede yok): bir kez, CDN yenilenince ETag'siz
    if (r.cdnStale && !cdnRetried) {
      cdnRetried = true;
      scheduleMenuSync(Date.now() + CDN_REFRESH_MS, true, false);
    } else if (r.status === 'uygulandi' && !r.cdnStale) cdnRetried = false;
  } catch (e) {
    console.warn('[senkron] site menüsü alınamadı:', e instanceof Error ? e.message : e);
  }
  schedulePriceSync();
  // Yeni ya da değişen ürün görsellerinin küçük kopyası (kart için); eksik yoksa istek gitmez
  const fetched = await warmProductThumbs().catch(() => 0);
  if (fetched) console.log(`[görsel] ${fetched} ürün görseli indirildi`);
}

const menuState = () => getSyncState<PriceTiming>('laffogato.menu');

/**
 * Şubenin bir sonraki fiyat anına tek bir ETag'siz eşitleme (gün açıkken; an + `PRICE_SYNC_DELAY_MS`). Her eşitlemeden
 * sonra yeniden bakılır: o anın eşitlemesi yeni anı (ya da hiçbirini) okur, aynı an ikinci kez kurulmaz. Bekleyen daha
 * erken bir eşitleme varsa ona katılmaz (onu ETag'siz yapmaz); o eşitlemeden sonra kurulur. Gün kapalıyken kurulmaz:
 * an geçtiyse gün açılınca `menuTick` ETag'siz eşitler; kurulan eşitleme günün kapanmasına denk gelirse açılışa kalır.
 * Site alanı göndermiyorsa (şube fiyatı öncesi) hiçbir şey kurulmaz. AGENTS.md kural 6: fiyat anı başına en çok bir
 * imzalı okuma, zorunlu eşitlemeler arası en az 60 sn (`MARKER_SYNC_MIN_MS`; yakın anlar tek okumada toplanır)
 */
export function schedulePriceSync(now = Date.now()) {
  if (!siteLinked() || !getSettings().menuAutoSync || !getOpenDay(db)) return;
  const { at } = priceInstant(menuState(), now);
  if (at === null || at - now > PRICE_SYNC_HORIZON_MS) return;
  // Zorunlu eşitlemeler arası en az 60 sn (işaret eşitlemesiyle aynı taban): yakın fiyat anları tek okumada toplanır
  const when = Math.max(at + PRICE_SYNC_DELAY_MS, lastMarkerSyncAt + MARKER_SYNC_MIN_MS);
  if (pendingSync && pendingSync.at <= when) return;
  scheduleMenuSync(when, true, false);
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
  if (!existsSync(file)) {
    try {
      await backupNow();
    } catch (e) {
      console.warn('[yedek] alınamadı:', e instanceof Error ? e.message : e);
    }
    dailyMaintenance(day);
  }
  // Günün yedeği şifrelenip buluta (Uzaktan kuruluysa; gidemezse yarım saatte bir yeniden)
  if (existsSync(file)) afterDailyBackup(file, day);
}

let lastAutoWarn = 0;

/**
 * Otomatik gün sonu: ayarlanan saatte açık POS adisyonu yoksa günü sayımsız kapatır (föy sonra girilir). `now`
 * testler için (zamanlayıcı şimdiki anla çağırır)
 */
export function autoDayEndTick(now = Date.now()) {
  const s = getSettings();
  if (!s.autoDayEnd) return;
  const p = istanbulParts(now);
  // Saat yarımlı olabilir (22.5 = 22:30): o dakikadan sonraki 15 dakikada
  const hour = Math.floor(s.autoDayEndHour);
  const minute = Math.round((s.autoDayEndHour - hour) * 60);
  if (p.hour !== hour || p.minute < minute || p.minute > minute + 15) return;
  const day = getOpenDay(db);
  // Yeni açılmış (ya da gün sonundan sonra yeniden açılmış) gün hemen kapatılmaz
  if (!day || now - Math.max(day.openedAt, day.reopenedAt ?? 0) < 3 * 3600_000) return;
  // Boş adisyonlar (satış sonrası açılan yeni tezgâh gibi) engel değil: gün sonu onları kapatır
  const open = db
    .select({ id: schema.orders.id })
    .from(schema.orders)
    .where(and(eq(schema.orders.dayId, day.id), eq(schema.orders.status, 'acik'), eq(schema.orders.source, 'pos')))
    .all()
    .filter((o) => !isEmptyOrder(db, o.id));
  const fx = new Effects();
  if (open.length) {
    if (now - lastAutoWarn > 30 * 60_000) {
      lastAutoWarn = now;
      fx.audit(db, { action: 'day.auto_skip', severity: 'uyari', message: `Otomatik gün sonu alınamadı: ${open.length} açık adisyon var` });
      fx.flush();
    }
    return;
  }
  const closed = tx((t) => closeDay(t, null, fx, { countedCash: null, note: 'Otomatik gün sonu' }));
  fx.flush();
  // Atmaz (gövde kurulamazsa denetim kaydı ve patrona bildirim): Pavo'nun gün sonu aşağıda her durumda başlar
  afterDayClosed(closed.id, { eodExpected: autoEodExpected(closed.id) });
  // Pavo: cihazda banka gün sonu; beklenmez, cihaz yanıt vermese de gün kapalı kalır (docs/04-YAZARKASA.md §8.5).
  // Alınamaz ya da belirsiz kalırsa kasadan alınan gün sonundaki gibi patronun telefonuna (routes/cash.ts); otomatik
  // gün sonunda bildirim hiç gitmiyordu (inceleme, 23 Kas 2026)
  void deviceEndOfDay(closed.id, null)
    .then(afterDeviceEod)
    .catch((e) => console.warn('[pavo] gün sonu', e instanceof Error ? e.message : e));
}

/** LafPOS'un siteye Satışta yazımından birkaç saniye sonra bir menü eşitlemesi (site o an uyanık; gece de) */
export function menuSyncSoon(delayMs = AFTER_WRITE_SYNC_MS, opts: { force?: boolean } = {}) {
  scheduleMenuSync(Date.now() + delayMs, !!opts.force, true);
}

/**
 * LafPOS siteye Satışta yazdı: 5 sn sonra bir eşitleme. Bekleyen bir eşitleme varsa ya da son 20 sn'de eşitlendiyse
 * atlanır (işaret eşitlemesi onu kapsar)
 */
export function onSiteMenuWritten(now = Date.now()) {
  if (pendingSync || now - lastSyncAt < RECENT_SYNC_MS) return;
  menuSyncSoon();
}

/**
 * Sitenin menü işareti değişti (fiyat ya da Satışta sitede veya lafmaliyet panelinde): gün açıkken 1 sn sonra ETag'siz,
 * işaret eşitlemeleri arası en az 60 sn (art arda değişiklik sonda tek eşitleme). Gece eşitleme yok: gün açılınca bir kez
 * (`menuDirty`). Site her yayında (deploy) işaretleri yeniler; bu da gece istek doğurmaz.
 */
export function onSiteMenuChanged(now = Date.now()) {
  if (!getOpenDay(db)) {
    menuDirty = true;
    return;
  }
  scheduleMenuSync(Math.max(now + 1_000, lastMarkerSyncAt + MARKER_SYNC_MIN_MS), true, false);
}

/** Gün açıldı: gece atlanan yoklama bir kez; gece menü işareti değiştiyse ETag'siz */
export function onMenuDayOpened() {
  const force = menuDirty;
  menuDirty = false;
  return menuTick({ force });
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
  // ModPOS dönemi lafmaliyet'ten: iş günü başına bir kez (05:00'ten ya da açılıştan sonraki ilk tur); bağlantı yoksa istek yok
  timers.push(setTimeout(() => void modposTick(), 25_000));
  timers.push(setInterval(() => void modposTick(), 60_000));
  // Siteye bildirilemeyen Satışta yazımları (porsiyon sayacı): dakikada bir, bekleme süresi dolanlar
  timers.push(setInterval(() => void flushSiteOutbox(), 60_000));
  // Zamanlayıcıda yakalanmayan hata süreci düşürür (kasa kapanır): kapanış hatası günlüğe, sonraki tur yine dener
  timers.push(
    setInterval(() => {
      try {
        autoDayEndTick();
      } catch (e) {
        console.error('[gün sonu] otomatik gün sonu', e);
      }
    }, 60_000),
  );
  timers.push(setInterval(platformTick, 30_000));
  // Canlı platform bağlantısı: yoklama (Trendyol Go) ve bekleyen aşama bildirimleri; anahtar yokken hiç istek yok
  timers.push(setTimeout(() => void liveTick(), 15_000));
  timers.push(setInterval(() => void liveTick(), POLL_INTERVAL_MS));
  timers.push(setTimeout(backupTick, 30_000));
  // Yeniden başlatmadan önce yazarkasaya gönderilmiş, sonucu beklenen sepetler sorgulanmaya devam eder
  resumePolling();
  // Token kablolu (Windows kasa): köprü açılır, kablo takılınca cihaz kendiliğinden tanınır
  try {
    syncTokenKablo();
  } catch (e) {
    console.error('[token-kablo] başlatılamadı', e);
  }
  // Pavo gün sonu sürerken süreç kapandıysa sonuç belirsizdir: alarm, yeniden denemeden önce doğrulama
  try {
    recoverDeviceEod();
  } catch (e) {
    console.error('[pavo] gün sonu kaydı', e);
  }
  // LafPOS Uzaktan (Vercel): tanımlıysa canlı özet
  timers.push(...startCloudSync());
  timers.push(...startMerkez());
  // Platform anahtarları buluttan: açılışta ve 10 dakikada bir (Uzaktan'ın Vercel ortamı, Redis'e dokunmaz)
  timers.push(...startPlatformKeys());
  // İnternet dönünce bekleyen bildirimler ve uzun kesinti haberi
  startNotices();
  // Kapanış saatine 30 dakika kala gün açıksa patronun telefonuna (Ayarlar'da kapanış saati ve Uzaktan yoksa istek yok)
  timers.push(setInterval(() => void closingNoticeTick().catch((e) => console.error('[bildirim] kapanış', e)), 60_000));
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
  if (e.topic === 'sync' && e.kind === 'site.menu.written') onSiteMenuWritten();
  // Sitenin menü işareti değişti (fiyat ya da Satışta sitede veya lafmaliyet panelinde değişti): gün açıkken ETag'siz,
  // en sık 60 sn'de bir; gece gün açılışına kalır
  if (e.topic === 'sync' && e.kind === 'site.menu.changed') onSiteMenuChanged();
  // Menü eşitlendi (elle "Siteyle eşitle" de): şubenin bir sonraki fiyat anına eşitleme kurulur
  if (e.topic === 'sync' && e.kind === 'menu.synced') schedulePriceSync();
  // Gün açıldı: gece atlanan menü yoklaması bir kez
  if (e.topic === 'cash' && (e.kind === 'day.opened' || e.kind === 'day.reopened')) void onMenuDayOpened();
  // Paket siparişinin aşaması değişti: canlı platforma hemen yazılır (gidemezse 20 sn'lik turda yeniden)
  if (e.topic === 'delivery' && e.kind === 'delivery.status' && process.env.LAFPOS_NO_JOBS !== '1') void reconcileNotifications().catch(() => undefined);
}

export function stopJobs() {
  kablo.stop();
  for (const t of timers) clearTimeout(t);
  timers.length = 0;
  bus.off('event', onJobEvent);
  resetMenuScheduler();
}
