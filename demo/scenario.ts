import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { DEMO_USERS } from '../server/db/seed';

type Fetch = (req: Request) => Response | Promise<Response>;
type Role = (typeof DEMO_USERS)[number]['role'];

/**
 * Demonun ilk günü: kasa gerçek uçlardan (yetki, hesap, denetim kaydı aynen) açılır. Bir kısmı ödenmiş adisyonlar
 * raporları ve patron panelini doldurur; açık masalar, mutfaktaki kalemler ve çalışan karaoke sayacı kasa ekranını
 * canlı gösterir. Ürün sitenin menüsünde yoksa (menü değişmiş) o adım atlanır.
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
  const table = (name: string) => boot.tables.find((t) => t.name === name);

  type Line = [name: string, qty: number, size?: 'M' | 'L'];
  const lines = (list: Line[]) =>
    list.flatMap(([name, qty, size]) => {
      const p = product(name);
      return p ? [{ productId: p.id, qty, ...(size && p.priceL ? { size } : {}) }] : [];
    });

  async function open(role: Role, tableName: string | null, guests: number, list: Line[]): Promise<OrderDTO | null> {
    const t = tableName ? table(tableName) : null;
    if (tableName && !t) return null;
    const items = lines(list);
    if (!items.length) return null;
    const o = await call<OrderDTO>(role, 'POST', '/orders', t ? { type: 'masa', tableId: t.id, guests } : { type: 'tezgah' });
    return call<OrderDTO>(role, 'POST', `/orders/${o.id}/items`, { items });
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

  // Kapanmış satışlar: raporlar, gün özeti ve patron paneli
  const sold: [string | null, number, Line[], string][] = [
    [null, 1, [['Latte', 2, 'M'], ['San Sebastian', 1]], 'Nakit'],
    ['S2', 2, [['Americano', 2, 'L'], ['Türk Kahvesi', 1]], 'Kredi kartı'],
    [null, 1, [['Flat White', 1, 'M'], ['Karabuğday Simit', 1]], 'Pluxee'],
    ['B2', 3, [['Cappuccino', 2, 'M'], ['Rosbeef Sandviç', 1], ['Su', 2]], 'Kredi kartı'],
    [null, 1, [['Buzlu Caffè Latte', 1, 'L']], 'Nakit'],
    ['B5', 2, [['Matcha Latte', 2, 'M'], ['Çilek Magnolia', 1]], 'Multinet'],
  ];
  for (const [tableName, guests, list, methodName] of sold) {
    const o = await open(tableName ? 'garson' : 'kasiyer', tableName, guests, list);
    await kitchen(o, 'servis');
    await pay(o, methodName);
  }

  // Açık masalar: mutfakta bekleyen, hazır ve servis edilmiş kalemler; bir masa kısmen ödenmiş
  const s1 = await open('garson', 'S1', 2, [['Latte', 1, 'L'], ['Türk Kahvesi', 2]]);
  await kitchen(s1, 'hazirlaniyor');
  const s4 = await open('garson', 'S4', 4, [['Mocha', 2, 'M'], ['Chai Latte', 1, 'M'], ['L\'Af Kahve', 2]]);
  await kitchen(s4, 'hazir');
  await open('garson', 'B1', 3, [['Limonlu Soğuk Çay', 2], ['Mango', 1], ['Çay', 3]]);
  const b3 = await open('garson', 'B3', 4, [['Espresso', 2], ['Donostia (L\'Af Özel)', 2], ['Su', 2]]);
  await kitchen(b3, 'servis');
  await pay(b3, 'Kredi kartı', b3 ? Math.round((b3.total - b3.paid) / 2) : 0);
  const u2 = await open('garson', 'Ü2', 2, [['Frappe', 2]]);
  await kitchen(u2, 'servis');

  const room = table('Karaoke odası');
  if (room) {
    const o = await call<OrderDTO>('kasiyer', 'POST', '/orders', { type: 'masa', tableId: room.id, guests: 6 });
    await call('kasiyer', 'POST', `/orders/${o.id}/room/start`, {});
    await call('kasiyer', 'POST', `/orders/${o.id}/items`, { items: lines([['Soda', 3], ['Cool Lime', 3]]) });
  }

  await call('kasiyer', 'POST', '/cash/movements', { kind: 'harcama', amount: 18000, description: 'Süt ve buz' });

  // Kurulumun oturumları kapanır: demoyu açan kişi kendi rolüyle girer
  for (const role of tokens.keys()) await call(role, 'POST', '/auth/logout');
}
