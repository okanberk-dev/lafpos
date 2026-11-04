import { gzipSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import type { Permission } from '@shared/permissions';
import type { OrderDTO } from '@shared/types';
import { db, schema } from '../db/client';
import { env } from '../env';
import type { AuthUser } from '../lib/auth';
import { bus } from '../lib/events';
import { MIN_SECRET_LENGTH, signedFetch } from '../lib/signature';
import { bootstrap } from '../services/bootstrap';
import { orderToDTO } from '../services/dto';
import { floorState, kitchenTickets, pickupBoard } from '../services/floor';
import { patronLive } from '../services/reports';

/**
 * LafPOS Uzaktan: kafedeki sunucu canlı özetini Vercel'deki uzaktan görünüme iter (patron paneli, salon, açık
 * adisyonlar, bar). Kasa yerelde kalır; bulut salt okunur bir kopyadır. Değişiklikte en sık 15 sn'de bir, boşta
 * 5 dk'da bir; gövde gzip, laffogato ile aynı imza kuralı. Maliyet ve kâr gitmez. Ayrıntı: docs/07-UZAKTAN-ERISIM.md
 */
const MIN_INTERVAL_MS = 15_000;
const HEARTBEAT_MS = 5 * 60_000;

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
    items: o.items.map((i) => (i.note && BOOKING_NOTE.test(i.note) ? { ...i, note: 'Site rezervasyonu' } : i)),
    room: o.room ? { ...o.room, bookingId: o.room.bookingId ? REMOTE_BOOKING : null, booking: o.room.booking ? { ...o.room.booking, id: REMOTE_BOOKING } : null } : null,
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
    patron: patronLive(false),
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

let timer: NodeJS.Timeout | null = null;
let lastPush = 0;
let pushing = false;
let state: { lastSuccessAt?: number; lastError?: string | null; lastSize?: number } = {};

export const cloudState = () => ({ configured: cloudEnabled(), url: env.cloudUrl || null, ...state });

export async function pushSnapshot(): Promise<boolean> {
  if (!cloudEnabled() || pushing) return false;
  pushing = true;
  lastPush = Date.now();
  try {
    const packed = gzipSync(JSON.stringify(buildSnapshot())).toString('base64');
    const { status } = await signedFetch(env.cloudSecret, 'POST', new URL(`${env.cloudUrl}/api/uzaktan/push`), { gz: packed }, 15_000);
    if (status !== 200) throw new Error(`HTTP ${status}`);
    state = { lastSuccessAt: Date.now(), lastError: null, lastSize: packed.length };
    return true;
  } catch (e) {
    state = { ...state, lastError: e instanceof Error ? e.message : String(e) };
    return false;
  } finally {
    pushing = false;
  }
}

/** Değişiklik olunca itme sıraya girer (en sık 15 sn'de bir) */
function schedule() {
  if (timer) return;
  const wait = Math.max(1000, MIN_INTERVAL_MS - (Date.now() - lastPush));
  timer = setTimeout(() => {
    timer = null;
    void pushSnapshot();
  }, wait);
}

export function startCloudSync(): NodeJS.Timeout[] {
  if (!cloudEnabled()) return [];
  // Personel olayları uzaktan özetini değiştirmez
  bus.on('event', (e: { topic: string }) => {
    if (e.topic !== 'users') schedule();
  });
  return [setTimeout(schedule, 5_000), setInterval(schedule, HEARTBEAT_MS)];
}
