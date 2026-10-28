import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, OptionGroupDTO, OrderDTO, Size } from '@shared/types';
import { defaultPicks, estimateUnit, menuUnit, pendingOptionsText, pendingProblem, productGroups, reconcilePicks, sendableOptions } from '../src/lib/boot';
import type { PendingLine } from '../src/lib/cart';
import { displayOrder, previewTotals } from '../src/lib/estimate';
import { type Harness, startApp } from './harness';

/**
 * Sepette görünen tutar sunucunun yazacağıyla aynı (son-pencere-1): gönderilmemiş satırın tahmini (`menuUnit`,
 * `estimateUnit`; kasanın "Öde" düğmesi, adisyon toplamı, müşteri ekranı) ve seçenek metni (`pendingOptionsText`)
 * sunucunun `resolveOptions` ve `optionsText` kuralıyla hesaplanır. Seçimi olmayan tek seçimlik grupta sunucu
 * varsayılanı (tükenmemişse) yazar ve ücretini alır: satır eklenirken tükenik olan ücretli varsayılan (Karton +₺5)
 * sonra satışa açıldıysa, ya da iki boylu ürün pencere açılmadan eklendiyse tahmin de onu sayar. Sepetin
 * gönderilemez dediği satır (`pendingProblem`) sunucunun reddettiğidir; işaretsiz her satırda tahmin = sunucu.
 */
let h: Harness;
const P = 'p-tahmin';
const G = 'g-tahmin';
const H = 'h-tahmin';
const [A, B, C, HN, HP] = ['a-tahmin', 'b-tahmin', 'c-tahmin', 'hn-tahmin', 'hp-tahmin'];

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const { db, schema } = await import('../server/db/client');
  const category = db.select().from(schema.categories).all()[0]!;
  // İki boylu deneme ürünü; G'nin türü, zorunluluğu, varsayılanı, fiyatı ve tükenenleri her turda değişir. H isteğe
  // bağlı, ücretli varsayılanlı (Hn +₺2) sabit grup: seçimsiz satırda sunucu onu da yazar
  db.insert(schema.products).values({ id: P, categoryId: category.id, name: 'Tahmin deneme', price: 10000, priceL: 12000, kdvRate: 10, sort: 999 }).run();
  db.insert(schema.optionGroups).values({ id: G, name: 'Gee', kind: 'single', required: false, maxSelect: 2, sort: 1 }).run();
  db.insert(schema.optionGroups).values({ id: H, name: 'Hach', kind: 'single', required: false, maxSelect: 1, sort: 2 }).run();
  db.insert(schema.optionItems)
    .values([
      { id: A, groupId: G, name: 'Aa', price: 0, isDefault: true, maxQty: 2, sort: 0 },
      { id: B, groupId: G, name: 'Bb', price: 0, maxQty: 2, sort: 1 },
      { id: C, groupId: G, name: 'Cc', price: 300, maxQty: 2, sort: 2 },
      { id: HN, groupId: H, name: 'Hn', price: 200, isDefault: true, sort: 0 },
      { id: HP, groupId: H, name: 'Hp', price: 0, sort: 1 },
    ])
    .run();
  db.insert(schema.productOptionGroups)
    .values([
      { productId: P, groupId: G, sort: 0 },
      { productId: P, groupId: H, sort: 1 },
    ])
    .run();
});
afterAll(() => h.cleanup());

type Kind = OptionGroupDTO['kind'];
interface Cfg {
  kind: Kind;
  required: boolean;
  defA: boolean;
  priceA: number;
  sold: [boolean, boolean, boolean];
  active: boolean;
}

async function apply(cfg: Cfg) {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  db.update(schema.optionGroups).set({ kind: cfg.kind, required: cfg.required, active: cfg.active }).where(eq(schema.optionGroups.id, G)).run();
  db.update(schema.optionItems).set({ isDefault: cfg.defA, price: cfg.priceA, soldOut: cfg.sold[0] }).where(eq(schema.optionItems.id, A)).run();
  db.update(schema.optionItems).set({ soldOut: cfg.sold[1] }).where(eq(schema.optionItems.id, B)).run();
  db.update(schema.optionItems).set({ soldOut: cfg.sold[2] }).where(eq(schema.optionItems.id, C)).run();
}

/** Sepette durabilecek satır seçimleri: boş (hızlı ekleme), tek seçim, iki seçim, sayaçta aynı seçenek iki kez */
function pickSets(kind: Kind): { itemId: string; qty?: number }[][] {
  if (kind === 'single') return [[], [{ itemId: A }], [{ itemId: B }], [{ itemId: C }]];
  if (kind === 'multi') return [[], [{ itemId: A }], [{ itemId: B }], [{ itemId: A }, { itemId: C }]];
  return [[], [{ itemId: A, qty: 1 }], [{ itemId: B, qty: 2 }], [{ itemId: A, qty: 1 }, { itemId: C, qty: 1 }], [{ itemId: A, qty: 1 }, { itemId: A, qty: 1 }]];
}

async function send(lines: { productId: string; size: Size; qty: number; options: { itemId: string; qty?: number }[] }[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  const res = await h.call<OrderDTO & { code?: string; error?: string }>('kasa', 'POST', `/orders/${o.id}/items`, { items: lines });
  return { order: o, res };
}

describe('sepet tahmini sunucunun yazacağıyla aynı', () => {
  it('her grup türünde, zorunlulukta, varsayılanda ve tükenmede: işaretsiz satırın tutarı ve metni sunucununki', async () => {
    const cfgs: Cfg[] = [];
    for (const kind of ['single', 'multi', 'counter'] as Kind[])
      for (const required of [false, true])
        for (const defA of [true, false])
          for (const priceA of [0, 500])
            for (let s = 0; s < 8; s++)
              for (const active of [true, false]) {
                if (!active && (s > 1 || priceA)) continue;
                cfgs.push({ kind, required, defA, priceA, sold: [!!(s & 1), !!(s & 2), !!(s & 4)], active });
              }
    const mismatches: string[] = [];
    let checked = 0;
    for (const cfg of cfgs) {
      await apply(cfg);
      const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
      const p = boot.products.find((x) => x.id === P)!;
      const tag = `${cfg.kind}${cfg.required ? ' zorunlu' : ''} varsayılan=${cfg.defA ? 'Aa' : '-'} Aa=${cfg.priceA} tükenen=${cfg.sold.map(Number).join('')}${cfg.active ? '' : ' kapalı'}`;
      for (const [n, own] of pickSets(cfg.kind).entries()) {
        // H seçimsiz (hızlı ekleme: sunucu Hn'yi yazar) ya da pencereden Hp seçili; iki boy sırayla
        const options = n % 2 ? [...own, { itemId: HP }] : own;
        const size: Size = n % 2 ? 'L' : 'M';
        const problem = pendingProblem(boot, p, options);
        const { res } = await send([{ productId: P, size, qty: 1, options: sendableOptions(boot, P, options) }]);
        const at = `${tag} ${size} ${JSON.stringify(options.map((o) => `${o.itemId.split('-')[0]}${o.qty ?? ''}`))}`;
        if ((problem === null) !== (res.status === 200)) mismatches.push(`${at}: sepet ${problem ?? 'sorunsuz'}, sunucu ${res.status} ${res.json.error ?? ''}`);
        if (problem !== null || res.status !== 200) continue;
        checked++;
        const item = res.json.items[0]!;
        const shown = { unit: menuUnit(boot, p, size, options), estimate: estimateUnit(boot, p, size, options), text: pendingOptionsText(boot, p, options) };
        const server = { unit: item.unitPrice, estimate: item.unitPrice, text: item.optionsText };
        if (JSON.stringify(shown) !== JSON.stringify(server)) mismatches.push(`${at}: sepet ${JSON.stringify(shown)}, sunucu ${JSON.stringify(server)}`);
      }
    }
    expect(mismatches).toEqual([]);
    // Kapsam: tek seçimlik grupta seçimsiz satırın ücretli varsayılanı dahil yüzlerce satır sunucuyla karşılaştırıldı
    expect(checked).toBeGreaterThan(300);
  }, 600_000);

  it('Karton +₺5 pencerede tükenikti, satır sepetteyken satışa açıldı: sepet ₺85 ve "Karton", sunucu da', async () => {
    let boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const cup = () => boot.products.find((x) => x.name === 'Yenilebilir bardak')!;
    expect(cup().price).toBe(8000);
    const { id: gid } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', {
      name: 'Kap',
      kind: 'single',
      required: false,
      maxSelect: 1,
      sort: 50,
      active: true,
      items: [
        { name: 'Fincan', price: 0, isDefault: false },
        { name: 'Karton', price: 500, isDefault: true },
      ],
      productIds: [cup().id],
    });
    boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const karton = boot.optionGroups.find((g) => g.id === gid)!.items.find((i) => i.name === 'Karton')!;
    await h.ok('kasa', 'POST', `/option-items/${karton.id}/sold-out`, { soldOut: true });
    try {
      // Pencere: tükenen Karton önseçilmez, Ekle açık ("Karton tükendi" notu); satır grubu boş eklenir, ₺80
      boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
      const groups = productGroups(boot, cup());
      expect(groups.map((g) => g.id)).toEqual([gid]);
      expect(reconcilePicks(groups, defaultPicks(groups))).toEqual({});
      expect(estimateUnit(boot, cup(), 'TEK', [])).toBe(8000);
      // Başka kasa Karton'u satışa açar; satır hâlâ sepette: sunucu Karton'u yazacak, sepet de ₺85 gösterir
      await h.ok('kasa', 'POST', `/option-items/${karton.id}/sold-out`, { soldOut: false });
      boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
      const p = cup();
      const pending: PendingLine[] = [{ key: 'k1', productId: p.id, size: 'TEK', qty: 2, options: [], note: '' }];
      expect(pendingProblem(boot, p, [])).toBeNull();
      expect(estimateUnit(boot, p, 'TEK', [])).toBe(8500);
      expect(pendingOptionsText(boot, p, [])).toBe('Karton');
      const { order, res } = await send(pending.map((l) => ({ productId: l.productId, size: l.size, qty: l.qty, options: sendableOptions(boot, l.productId, l.options) })));
      expect(res.status).toBe(200);
      expect(res.json.items[0]).toMatchObject({ unitPrice: 8500, optionsText: 'Karton' });
      // "Öde · ₺X", adisyon toplamı ve müşteri ekranı aynı tahminden
      expect(previewTotals(boot, order, pending)!.total).toBe(res.json.total);
      expect(displayOrder(boot, order, pending, 'Tezgâh')!.lines).toEqual([{ name: p.name, size: null, qty: 2, options: 'Karton', total: 17000 }]);
    } finally {
      await h.ok('patron', 'PUT', `/admin/option-groups/${gid}/products`, { productIds: [] });
    }
  });
});
