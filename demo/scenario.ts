import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { DEMO_USERS } from '../server/db/seed';

type Fetch = (req: Request) => Response | Promise<Response>;
type Role = (typeof DEMO_USERS)[number]['role'];

/**
 * Demonun ilk günü: kasa gerçek uçlardan (yetki, hesap, denetim kaydı aynen) açılır. İşletme self servis: teslim
 * edilmiş satışlar raporları ve patron panelini doldurur, ödenmiş ve barda bekleyen siparişler bar ekranında ve çağrı
 * ekranında numarayla görünür, paket platformlarından biri barda biri onay bekler. Masaya servis demo şeridinden
 * açılır. Ürün sitenin menüsünde yoksa (menü değişmiş) o adım atlanır.
 */
export async function seedDemoDay(fetch: Fetch) {
  const tokens = new Map<Role, string>();

  async function call<T>(role: Role | null, method: string, path: string, body?: unknown): Promise<T> {
    const token = role ? tokens.get(role) : null;
    const res = await fetch(
      new Request(`http://demo/api${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    const data = (await res.json()) as T & { error?: string };
    if (!res.ok) throw new Error(`Demo günü kurulamadı: ${method} ${path} → ${res.status} ${data?.error ?? ''}`);
    return data;
  }

  for (const u of DEMO_USERS) {
    const { token } = await call<{ token: string }>(null, 'POST', '/auth/login', { pin: u.pin, device: 'Demo kurulumu' });
    tokens.set(u.role, token);
  }
  const boot = await call<BootstrapDTO>('kasiyer', 'GET', '/bootstrap');
  const product = (name: string) => boot.products.find((p) => p.name === name && p.active !== false);
  const method = (name: string) => boot.paymentMethods.find((m) => m.name === name);

  type Line = [name: string, qty: number, size?: 'M' | 'L'];
  const lines = (list: Line[]) =>
    list.flatMap(([name, qty, size]) => {
      const p = product(name);
      return p ? [{ productId: p.id, qty, ...(size && p.priceL ? { size } : {}) }] : [];
    });

  /** Tezgâh satışı (self servis): sipariş kasada açılır, kalemler bara gider */
  async function open(list: Line[]): Promise<OrderDTO | null> {
    const items = lines(list);
    if (!items.length) return null;
    const o = await call<OrderDTO>('kasiyer', 'POST', '/orders', { type: 'tezgah' });
    return call<OrderDTO>('kasiyer', 'POST', `/orders/${o.id}/items`, { items });
  }

  async function pay(o: OrderDTO | null, methodName: string, amount = o ? o.total - o.paid : 0) {
    const m = method(methodName);
    if (!o || !m || amount <= 0) return;
    await call('kasiyer', 'POST', `/orders/${o.id}/payments`, { methodId: m.id, amount, ...(m.kind === 'nakit' ? { given: Math.ceil(amount / 5000) * 5000 } : {}) });
  }

  async function kitchen(o: OrderDTO | null, status: 'hazirlaniyor' | 'hazir' | 'servis') {
    if (!o?.items.length) return;
    await call('mutfak', 'POST', '/kitchen/status', { itemIds: o.items.map((i) => i.id), status });
  }

  await call('kasiyer', 'POST', '/cash/day/open', { openingCash: 150000 });

  // Self servis (işletmenin modu): sipariş ve ödeme kasada, numara çağrılınca tezgâhtan alınır. Masa yok
  // Teslim edilmiş satışlar: raporlar, gün özeti ve patron paneli
  const sold: [Line[], string][] = [
    [[['Latte', 2, 'M'], ['San Sebastian', 1]], 'Nakit'],
    [[['Americano', 2, 'L'], ['Türk Kahvesi', 1]], 'Kredi kartı'],
    [[['Flat White', 1, 'M'], ['Karabuğday Simit', 1]], 'Pluxee'],
    [[['Cappuccino', 2, 'M'], ['Rosbeef Sandviç', 1], ['Su', 2]], 'Kredi kartı'],
    [[['Buzlu Caffè Latte', 1, 'L']], 'Nakit'],
    [[['Matcha Latte', 2, 'M'], ['Çilek Magnolia', 1]], 'Multinet'],
  ];
  for (const [list, methodName] of sold) {
    const o = await open(list);
    await kitchen(o, 'servis');
    await pay(o, methodName);
  }

  // Ödenmiş, barda bekleyen siparişler: çağrı ekranında hazırlanıyor ve hazır numaralar
  const waiting: [Line[], 'hazirlaniyor' | 'hazir' | null][] = [
    [[['Latte', 1, 'L'], ['Türk Kahvesi', 2]], 'hazirlaniyor'],
    [[['Mocha', 2, 'M'], ['Chai Latte', 1, 'M']], 'hazir'],
    [[['Limonlu Soğuk Çay', 2], ['Mango', 1]], null],
  ];
  for (const [list, status] of waiting) {
    const o = await open(list);
    if (status) await kitchen(o, status);
    await pay(o, 'Kredi kartı');
  }

  await call('kasiyer', 'POST', '/cash/movements', { kind: 'harcama', amount: 18000, description: 'Süt ve buz' });

  // Paket platformları deneme modunda: bir Trendyol Go siparişi barda, bir Yemeksepeti siparişi onay bekliyor (şerit)
  for (const platform of ['yemeksepeti', 'getir', 'trendyol']) await call('patron', 'PUT', `/platforms/${platform}`, { mode: 'deneme' });
  const trendyol = await call<{ id: string }>('kasiyer', 'POST', '/platforms/trendyol/test-order', { courier: 'platform' });
  await call('kasiyer', 'POST', `/platforms/orders/${trendyol.id}/accept`, { prepMinutes: 20 });
  await call('kasiyer', 'POST', '/platforms/yemeksepeti/test-order', { courier: 'platform' });

  // Kurulumun oturumları kapanır: demoyu açan kişi kendi rolüyle girer
  for (const role of tokens.keys()) await call(role, 'POST', '/auth/logout');
}
