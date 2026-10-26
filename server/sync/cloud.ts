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

function remoteOrder(o: OrderDTO): OrderDTO {
  return {
    ...o,
    customer: o.customer ? ({ id: o.customer.id, name: firstName(o.customer.name) ?? '' } as OrderDTO['customer']) : null,
    deliveryName: firstName(o.deliveryName),
    deliveryPhone: null,
    deliveryAddress: null,
    extId: null,
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
  bus.on('event', (e: { topic: string }) => {
    if (e.topic !== 'users') schedule();
  });
  return [setTimeout(schedule, 5_000), setInterval(schedule, HEARTBEAT_MS)];
}
