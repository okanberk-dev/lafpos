import { and, eq } from 'drizzle-orm';
import { PLATFORM_LABEL, type PlatformCourier, type PlatformId, type PlatformOrderPayload } from '@shared/platforms';
import { type DB, schema, type Tx } from '../db/client';
import { getSettings } from '../lib/settings';

/**
 * Deneme modu (simülatör): platformdan gelmiş gibi sipariş üretir. Kalemler kasanın satıştaki ürünlerinden, fiyatlar
 * kasanın fiyatı; kurye, ödeme şekli, kampanya ve kısa kod platformun gerçek siparişlerine benzer
 * (calisma/arastirma/paket-platformlari). Gerçek bağlantı gelince yalnız bu dosyanın yerine bağdaştırıcı geçer.
 */
const NAMES = ['Ayşe K.', 'Mehmet Y.', 'Zeynep A.', 'Can D.', 'Elif S.', 'Burak T.', 'Deniz Ö.', 'Selin B.'];
const STREETS = ['İstasyon Mh. Gül Sk. No 4', 'Postane Mh. Tuzla Cd. No 18', 'Aydınlı Mh. Lale Sk. No 9', 'Şifa Mh. Sahil Yolu No 27'];
const CHARS = 'ABCDEFGHJKLMNPRSTUVYZ23456789';

type Rand = () => number;

function pick<T>(list: readonly T[], r: Rand): T {
  return list[Math.floor(r() * list.length) % list.length];
}

/** Platformun kısa kod biçimi: Yemeksepeti harf-rakam, Getir 4 rakam, Trendyol Go 3 (Uber geçişinde 5), Migros 6 */
function codeFor(platform: PlatformId, r: Rand): string {
  const digits = (n: number) => Array.from({ length: n }, () => Math.floor(r() * 10)).join('');
  if (platform === 'yemeksepeti') return Array.from({ length: 4 }, () => pick([...CHARS], r)).join('');
  if (platform === 'getir') return digits(4);
  if (platform === 'trendyol') return digits(3);
  return digits(6);
}

export function sampleOrder(t: Tx | DB, platform: PlatformId, now = Date.now(), r: Rand = Math.random, opts: { courier?: PlatformCourier } = {}): PlatformOrderPayload {
  const products = t
    .select()
    .from(schema.products)
    .where(and(eq(schema.products.active, true), eq(schema.products.hidden, false), eq(schema.products.isService, false)))
    .all()
    .filter((p) => p.price > 0);
  if (!products.length) throw new Error('Satışta ürün yok');
  const sizeL = getSettings().sizeLabels.L;
  const count = 1 + Math.floor(r() * 3);
  const lines: PlatformOrderPayload['lines'] = [];
  for (let i = 0; i < count; i++) {
    const p = pick(products, r);
    const large = p.priceL != null && r() < 0.4;
    const qty = r() < 0.75 ? 1 : 2;
    lines.push({ externalId: `${platform}-${p.id}`, name: p.name, qty, unitPrice: large ? p.priceL! : p.price, modifiers: large ? [sizeL] : [], note: r() < 0.15 ? 'Buzsuz olsun' : null });
  }
  const subtotal = lines.reduce((a, l) => a + l.unitPrice * l.qty, 0);
  const courier: PlatformCourier = opts.courier ?? (r() < 0.6 ? 'platform' : r() < 0.6 ? 'restoran' : 'gelal');
  const online = courier === 'gelal' || r() < 0.65;
  const kapida = online ? null : pick(['nakit', 'kart', 'Multinet', 'Pluxee'], r);
  const restaurantDiscount = r() < 0.2 ? Math.round(subtotal * 0.1) : 0;
  const platformDiscount = r() < 0.2 ? Math.min(1500, subtotal - restaurantDiscount) : 0;
  return {
    platform,
    simulated: true,
    externalId: `${platform}-${now}-${Math.floor(r() * 1e6)}`,
    code: codeFor(platform, r),
    placedAt: now,
    scheduledFor: null,
    courier,
    // Platform kuryesi kapıda ödemeyi de platform adına alır; kendi kuryemiz kapıda alırsa tahsilat kasada
    platformCollects: online || courier === 'platform',
    paymentLabel: online ? 'Online kart' : `Kapıda ${kapida}`,
    customer: {
      name: pick(NAMES, r),
      phone: courier === 'restoran' ? `0 5${Math.floor(r() * 10)}* *** ** ${String(Math.floor(r() * 100)).padStart(2, '0')}` : null,
      address: courier === 'restoran' ? `${pick(STREETS, r)}, Tuzla` : null,
    },
    note: r() < 0.25 ? 'Zile basmayın, arayın' : null,
    lines,
    subtotal,
    restaurantDiscount,
    platformDiscount,
    customerTotal: subtotal - restaurantDiscount - platformDiscount,
  };
}

export const SIMULATOR_NOTE = (platform: PlatformId) =>
  `${PLATFORM_LABEL[platform]} deneme modunda: siparişler simülatörden gelir, platforma bir şey gönderilmez`;
