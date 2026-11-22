import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { desc, eq, inArray } from 'drizzle-orm';
import { effectivePermissions, type Permission } from '@shared/permissions';
import type { OrderDTO } from '@shared/types';
import { db, schema } from '../db/client';
import { env } from '../env';
import type { AuthUser } from '../lib/auth';
import { bus } from '../lib/events';
import { getSettings } from '../lib/settings';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { bootstrap } from '../services/bootstrap';
import { orderToDTO } from '../services/dto';
import { floorState, kitchenTickets, pickupBoard } from '../services/floor';
import { patronLive } from '../services/reports';
import { startReportSync } from './cloud-reports';
import { remoteShop } from './merkez';

/**
 * LafPOS Uzaktan: kafedeki sunucu canlı özetini Vercel'deki uzaktan görünüme iter (patron paneli, salon, açık
 * adisyonlar, bar). Kasa yerelde kalır; bulut salt okunur bir kopyadır. Değişiklikte en sık 15 sn'de bir, gün açıkken
 * 5 dk'da bir nabız; gövde gzip (zlib'in iş havuzunda, ana iş parçacığı beklemez), laffogato ile aynı imza kuralı.
 * Değişmeyen özet gitmez: gün kapalıyken (gece) nabız yalnız özet değiştiyse ya da son itmenin üstünden 15 dk
 * geçtiyse iter (boşta 15 dk'da bir: uzaktan sayfanın "itibarıyla" saati eskimesin, bulut kaydı düşmesin). Maliyet ve
 * kâr gitmez. Ayrıntı ve aralıkların belgesi: docs/07-UZAKTAN-ERISIM.md §4 (tests/cloud-push.test.ts ikisini tutar)
 */
export const MIN_INTERVAL_MS = 15_000;
export const HEARTBEAT_MS = 5 * 60_000;
/** Özet değişmese de bu kadarda bir itilir: uzaktan görünümdeki saat eskimesin, buluttaki kayıt (7 gün) düşmesin */
export const KEEPALIVE_MS = 15 * 60_000;
/**
 * Zamanlayıcı payı: boşta itmeler nabızla aynı anda başlar; 15. dakikadaki nabız birkaç ms erken düşse de itsin (payı
 * olmasa bir sonraki nabza, 20. dakikaya kalırdı)
 */
const KEEPALIVE_SLACK_MS = 30_000;

/** Bulutun gördüğü kişi: patron paneli, salon ve bar; maliyet yok */
const VIEWER: AuthUser = {
  id: 'uzaktan',
  name: 'Uzaktan',
  role: 'patron',
  color: '#0c0e1b',
  permissions: new Set<Permission>(['patron.panel', 'siparis.al', 'mutfak.ekran']),
  maxDiscountPct: 0,
  sessionId: 'uzaktan',
};

export const cloudEnabled = () => !!env.cloudUrl && env.cloudSecret.length >= MIN_SECRET_LENGTH;

/** Kişisel veri buluta gitmez: müşteri ve teslimat kişisinin yalnız adı; telefon, adres, cari bakiye ve limit yok */
const firstName = (s: string | null | undefined) => (s ? (s.trim().split(/\s+/)[0] ?? null) : null);

/** Uzaktan özetinde site rezervasyonu kodunun yerine geçen ad (oda kutusu "Site rezervasyonu" yazar) */
export const REMOTE_BOOKING = 'uzak';
const BOOKING_NOTE = /^site rezervasyonu krk-/i;

function remoteOrder(o: OrderDTO): OrderDTO {
  return {
    ...o,
    customer: o.customer ? ({ id: o.customer.id, name: firstName(o.customer.name) ?? '' } as OrderDTO['customer']) : null,
    deliveryName: firstName(o.deliveryName),
    deliveryPhone: null,
    deliveryAddress: null,
    extId: null,
    // Oda sayacına bağlı site rezervasyonunun kodu buluta gitmez (yalnız bağlı olduğu ve bloğun koşulu); oda satırının
    // notu ("Site rezervasyonu KRK-00042") kodsuz
    // Ödenmez yazılan kişi (personel ya da müşteri) yalnız adıyla: kimlik ve soyadı buluta gitmez
    compPerson: o.compPerson ? { ...o.compPerson, id: '', name: firstName(o.compPerson.name) ?? '' } : null,
    items: o.items.map((i) => {
      const it = i.compPerson ? { ...i, compPerson: { ...i.compPerson, id: '', name: firstName(i.compPerson.name) ?? '' } } : i;
      return it.note && BOOKING_NOTE.test(it.note) ? { ...it, note: 'Site rezervasyonu' } : it;
    }),
    room: o.room ? { ...o.room, bookingId: o.room.bookingId ? REMOTE_BOOKING : null, booking: o.room.booking ? { ...o.room.booking, id: REMOTE_BOOKING } : null } : null,
  };
}

/**
 * Ödenmez denetim iletisi müşteriyi tam adıyla anar ("Ayşe Yılmaz adına"): patron uyarıları buluta giderken müşteri
 * yalnız adıyla kalır (kişisel veri). Ad, denetim kaydının kendi kişi verisinden (`data.person`): kalem sonradan geri
 * alınsa ya da müşterinin adı değişse de iletideki ad bulunur
 */
function scrubCustomerNames<T extends { id: number; message: string }>(alerts: T[]): T[] {
  const ids = alerts.map((a) => a.id);
  if (!ids.length) return alerts;
  const people = new Map<number, string>();
  for (const r of db.select({ id: schema.auditLog.id, data: schema.auditLog.data }).from(schema.auditLog).where(inArray(schema.auditLog.id, ids)).all()) {
    const person = (r.data as { person?: { kind?: string; name?: string } } | null)?.person;
    if (person?.kind === 'customer' && person.name) people.set(r.id, person.name);
  }
  return alerts.map((a) => {
    const name = people.get(a.id);
    return name && a.message.includes(name) ? { ...a, message: a.message.split(name).join(firstName(name) ?? '') } : a;
  });
}

/**
 * Uzaktaki görünüm patronundur: kasa rakamları (kasa farkı, yazarkasadan geçmeyen) yalnız patron rolü `kasa.rakam`
 * taşıyorsa buluta gider (kör kasa kuralı; patron rolü kilitli, bugün hep taşır)
 */
export const patronSeesCash = () => effectivePermissions('patron', null, getSettings().rolePermissions).has('kasa.rakam');

/**
 * Son gün sonunun kartı (uzaktan patron paneli, gün kapalıyken): Z, ciro, adisyon, ödemeler, yazarkasadan geçmeyen ve
 * kasa farkı. Kasa rakamları (beklenen, sayılan, fark, yazarkasadan geçmeyen) yalnız `patronSeesCash`; eski Z'de
 * yazarkasadan geçmeyen yok (kart satırı yazmaz). Maliyet ve kâr yok
 */
export function lastCloseCard() {
  const day = db.select().from(schema.businessDays).orderBy(desc(schema.businessDays.closedAt)).all().find((d) => d.closedAt && d.summary);
  if (!day?.closedAt || !day.summary) return null;
  const s = day.summary;
  const numbers = patronSeesCash();
  return {
    date: day.date,
    zNo: day.zNo,
    closedAt: day.closedAt,
    netSales: s.netSales,
    receipts: s.receipts,
    payments: s.payments.map((p) => ({ name: p.name, amount: p.amount, count: p.count })),
    ...(numbers && s.offDevice ? { offDevice: s.offDevice } : {}),
    cash: numbers ? { expected: s.expectedCash, counted: s.countedCash, diff: s.cashDiff } : null,
  };
}

export function buildSnapshot(now = Date.now()) {
  const open = db.select().from(schema.orders).where(eq(schema.orders.status, 'acik')).all();
  // Etiketlerdeki tam ad (Gel-al · Ayşe Yılmaz) yalnız ada iner
  const shorten = (label: string) => open.reduce((l, o) => (o.deliveryName && l.includes(o.deliveryName) ? l.replace(o.deliveryName, firstName(o.deliveryName) ?? '') : l), label);
  const floor = floorState(db);
  return {
    v: 1,
    at: now,
    bootstrap: bootstrap(db, VIEWER),
    patron: (() => {
      const live = patronLive(false, patronSeesCash());
      return { ...live, alerts: scrubCustomerNames(live.alerts), lastClose: lastCloseCard() };
    })(),
    floor: {
      ...floor,
      others: floor.others.map((x) => ({ ...x, label: shorten(x.label) })),
      reservations: floor.reservations.map((r) => ({ ...r, name: firstName(r.name) ?? '' })),
      // Sitenin karaoke rezervasyonundan buluta yalnız saat, kişi, ödeme durumu: ad, not ve kapıda sorulan kod
      // (KRK-…) gitmez; sitenin kişisel veri metni rezervasyonu yalnız kafedeki makineye açar (§2.4)
      siteKaraoke: floor.siteKaraoke?.map((b, i) => ({ ...b, id: `site-${i + 1}`, firstName: '', note: '' })),
    },
    kitchen: kitchenTickets(db).map((k) => ({ ...k, label: shorten(k.label) })),
    board: pickupBoard(db, now),
    orders: Object.fromEntries(open.map((o) => [o.id, remoteOrder(orderToDTO(db, o))])),
  };
}

type Snapshot = ReturnType<typeof buildSnapshot>;

/**
 * Özetin içeriğinin özeti: üç zaman damgası (özetin anı, açılış verisinin ve panelin saati) her seferinde değişir,
 * içerik saymaz. Aynıysa uzaktan görünüm zaten günceldir
 */
export function snapshotHash(snap: Snapshot): string {
  const content = { ...snap, at: 0, bootstrap: { ...snap.bootstrap, serverTime: 0 }, patron: { ...snap.patron, now: 0 } };
  return createHash('sha256').update(JSON.stringify(content)).digest('hex');
}

/** gzip zlib'in iş havuzunda: özet büyüse de kasanın istekleri sıkıştırmayı beklemez */
const gzipAsync = (text: string) => new Promise<Buffer>((ok, fail) => gzip(text, (err, out) => (err ? fail(err) : ok(out))));

let timer: NodeJS.Timeout | null = null;
let lastPush = 0;
let pushing = false;
/** Sıradaki itme beş dakikalık nabızdan mı (bir olayla aynı sıraya girdiyse de nabız sayılır) */
let heartbeatQueued = false;
/** Buluta son giden özetin içerik özeti */
let lastHash: string | null = null;
/** Son başarılı itmenin başladığı an: nabızla aynı ritimde ölçülür (bitiş anı ağın süresi kadar kayardı) */
let lastSentAt = 0;
let state: { lastSuccessAt?: number; lastError?: string | null; lastSize?: number } = {};

export const cloudState = () => ({ configured: cloudEnabled(), url: env.cloudUrl || null, ...state });

/** Test için: son gidenin özeti ve durum sıfırlanır */
export function resetCloudSync() {
  if (timer) clearTimeout(timer);
  timer = null;
  lastPush = 0;
  pushing = false;
  heartbeatQueued = false;
  lastHash = null;
  lastSentAt = 0;
  state = {};
}

/** `off`: uzaktan erişim tanımlı değil; `busy`: önceki itme sürüyor (değişikliği sonraki itme ya da nabız taşır) */
export type PushResult = 'sent' | 'unchanged' | 'failed' | 'off' | 'busy';

/**
 * Özeti iter. Değişmediyse istek gitmez; gün açıkken nabız (`heartbeat`) yine iter: uzaktan panelin saati ve
 * adisyon süreleri tazelensin. Gün kapalıyken nabız yalnız değişiklikte ya da son itmenin üstünden 15 dk geçtiyse
 * (boşta 15 dk'da bir)
 */
export async function pushSnapshot(opts: { heartbeat?: boolean } = {}): Promise<PushResult> {
  if (!cloudEnabled()) return 'off';
  if (pushing) return 'busy';
  pushing = true;
  const startedAt = Date.now();
  lastPush = startedAt;
  try {
    const snap = buildSnapshot();
    const hash = snapshotHash(snap);
    const keepAlive = startedAt - lastSentAt >= KEEPALIVE_MS - KEEPALIVE_SLACK_MS;
    if (hash === lastHash && !keepAlive && !(opts.heartbeat && snap.patron.dayOpen)) return 'unchanged';
    const packed = (await gzipAsync(JSON.stringify(snap))).toString('base64');
    const { status } = await signedFetch(env.cloudSecret, 'POST', new URL(`${env.cloudUrl}/api/uzaktan/push`), { gz: packed }, 15_000, { 'x-laf-dukkan': remoteShop() });
    if (status !== 200) throw new Error(`HTTP ${status}`);
    lastHash = hash;
    lastSentAt = startedAt;
    state = { lastSuccessAt: Date.now(), lastError: null, lastSize: packed.length };
    return 'sent';
  } catch (e) {
    state = { ...state, lastError: e instanceof Error ? e.message : String(e) };
    return 'failed';
  } finally {
    pushing = false;
  }
}

/** Değişiklik olunca itme sıraya girer (en sık 15 sn'de bir); `heartbeat`: beş dakikalık nabız */
function schedule(heartbeat = false) {
  if (heartbeat) heartbeatQueued = true;
  if (timer) return;
  const wait = Math.max(1000, MIN_INTERVAL_MS - (Date.now() - lastPush));
  timer = setTimeout(() => {
    timer = null;
    const beat = heartbeatQueued;
    heartbeatQueued = false;
    void pushSnapshot({ heartbeat: beat });
  }, wait);
}

export function startCloudSync(): NodeJS.Timeout[] {
  if (!cloudEnabled()) return [];
  // Personel olayları uzaktan özetini değiştirmez
  bus.on('event', (e: { topic: string }) => {
    if (e.topic !== 'users') schedule();
  });
  // Günlük rapor özetleri (server/sync/cloud-reports.ts): kendi ritmiyle
  return [setTimeout(() => schedule(), 5_000), setInterval(() => schedule(true), HEARTBEAT_MS), ...startReportSync()];
}
