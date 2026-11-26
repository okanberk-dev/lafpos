import { and, eq } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import { getSyncState, setSyncState } from '../lib/settings';

/**
 * Seçenek profili: sitenin seçenek gruplarından (süt, kavrum, şurup, ekstra shot, şeker) hangisinin hangi ürüne
 * anlamlı olduğu. Site bu grupları seçenek alan her kategoriye sunar (mobil v1 sözleşmesi, `NON_CUSTOMIZABLE` dışı); kasada
 * her ürüne hepsini bağlamak Su ve Soda'ya süt, Çay'a kavrum, frozen'a ekstra shot sordururdu ve tek boylu seçenekli ürün
 * her dokunuşta pencere açardı. Kural (docs/02-PLAN.md "Seçenek profili"): yalnız hazırlığı değiştiren ve gerçekten
 * istenen seçenek bağlanır; hiçbir şey sorulmayan ürün tek dokunuşla eklenir.
 *
 * Profil yalnız AsilPOS'un bağlarını belirler (sitenin menüsüne ve mobil uygulamasına dokunmaz). Site ürünü ilk kez
 * gelirken uygulanır; var olan kurulumda bir kez, yalnız yöneticinin hiç değiştirmediği (sitenin beş grubu birden bağlı)
 * ürünlere (`upgradeOptionProfiles`). Yönetici sonra Yönetim › Ürünler'den ürün başına grup ekler ya da çıkarır.
 */

/** Sitenin seçenek gruplarının anahtarları (`upsertOptionGroups` sırasıyla) */
export const SITE_GROUP_KEYS = ['milk', 'roast', 'syrup', 'extraShot', 'sugar'] as const;
export type SiteGroupKey = (typeof SITE_GROUP_KEYS)[number];

const ALL: readonly SiteGroupKey[] = SITE_GROUP_KEYS;
const MILKY: readonly SiteGroupKey[] = ['milk', 'syrup', 'sugar'];

/** Kategori varsayılanı: sitenin kategori anahtarıyla. Listede olmayan kategori (yeni) bütün grupları alır */
const BY_CATEGORY: Record<string, readonly SiteGroupKey[]> = {
  // Matcha'da kahve yok: kavrum ve ekstra shot anlamsız
  matcha: MILKY,
  espresso: ALL,
  'ice-coffee': ALL,
  // Limonata, soda, su: hazırlığı değişmez
  cold: [],
  // Sıcak çikolata, salep, chai: kahve yok
  hot: MILKY,
  frappe: ['milk', 'syrup', 'extraShot'],
  // Meyveli sütlü: yalnız süt
  smoothie: ['milk'],
  // Meyveli buzlu: süt de yok
  frozen: [],
  'ice-tea': [],
  dessert: [],
  snack: [],
  extras: [],
};

/** Ürün istisnaları: sitenin ürün kimliğiyle (`mnu-…`, sitenin sabit kimlikleri) */
const BY_ITEM: Record<string, readonly SiteGroupKey[]> = {
  // Matcha Affogato: dondurmanın üstüne matcha; süt sorulmaz
  'mnu-0003': [],
  // L'Affogato: dondurmanın üstüne espresso; kavrum ve shot
  'mnu-0004': ['roast', 'extraShot'],
  // Espresso: süt ve şurup yok; şeker isteyen olur
  'mnu-0005': ['roast', 'extraShot', 'sugar'],
  // Türk kahvesi: kasanın kendi zorunlu şeker grubu (seed); site gruplarından hiçbiri
  'mnu-0019': [],
  // Filtre kahve: demlenmiş, kavrum ve shot yok
  'mnu-0020': MILKY,
  // Buzlu Chai ve Chai Latte: kahve yok ama "dirty chai" için shot
  'mnu-0021': ['milk', 'syrup', 'extraShot', 'sugar'],
  'mnu-0037': ['milk', 'syrup', 'extraShot', 'sugar'],
  // Cold brew: soğuk demleme; kavrum ve shot yok
  'mnu-0030': MILKY,
  // Salep: süt seçilebilir, başka bir şey değil
  'mnu-0041': ['milk'],
  // Çay: hiçbir şey sorulmaz
  'mnu-0042': [],
};

/** Ürünün bağlanacak site grupları (sıra `SITE_GROUP_KEYS` sırası) */
export function siteGroupsFor(categoryKey: string, itemId: string): SiteGroupKey[] {
  const keys = BY_ITEM[itemId] ?? BY_CATEGORY[categoryKey] ?? ALL;
  return SITE_GROUP_KEYS.filter((k) => keys.includes(k));
}

const UPGRADE_KEY = 'secenek-profili';

/**
 * Var olan kurulumda bir kez: yöneticinin hiç değiştirmediği site ürünlerinden (sitenin beş grubu birden bağlı; Türk
 * kahvesinde kurulumun kendi şeker grubu yüzünden dördü) profilde olmayan site gruplarının bağı kalkar. Yalnız bağ
 * kaldırılır, eklenmez; yöneticinin elle değiştirdiği ürün olduğu gibi kalır. Denetime tek bilgi kaydı düşer. Döndürür:
 * değişen ürün sayısı.
 */
export function upgradeOptionProfiles(): number {
  if (getSyncState<boolean>(UPGRADE_KEY)) return 0;
  const changed: string[] = [];
  tx((t) => {
    const keyOf = new Map(
      t
        .select({ id: schema.optionGroups.id, key: schema.optionGroups.extKey })
        .from(schema.optionGroups)
        .where(eq(schema.optionGroups.extSource, 'laffogato'))
        .all()
        .filter((g): g is { id: string; key: SiteGroupKey } => (SITE_GROUP_KEYS as readonly string[]).includes(g.key ?? ''))
        .map((g) => [g.id, g.key]),
    );
    const categories = new Map(t.select({ id: schema.categories.id, key: schema.categories.extKey }).from(schema.categories).all().map((c) => [c.id, c.key ?? '']));
    for (const p of t.select().from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all()) {
      const links = t.select().from(schema.productOptionGroups).where(eq(schema.productOptionGroups.productId, p.id)).all().filter((l) => keyOf.has(l.groupId));
      const keys = new Set(links.map((l) => keyOf.get(l.groupId)!));
      const all = SITE_GROUP_KEYS.every((k) => keys.has(k));
      const seededTurkish = p.extId === 'mnu-0019' && keys.size === SITE_GROUP_KEYS.length - 1 && !keys.has('sugar');
      if (!all && !seededTurkish) continue;
      const wanted = new Set(siteGroupsFor(categories.get(p.categoryId) ?? '', p.extId ?? ''));
      const drop = links.filter((l) => !wanted.has(keyOf.get(l.groupId)!));
      for (const l of drop) t.delete(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, p.id), eq(schema.productOptionGroups.groupId, l.groupId))).run();
      if (drop.length) changed.push(p.name);
    }
    if (changed.length) {
      t.insert(schema.auditLog)
        .values({
          at: Date.now(),
          action: 'menu.product_groups',
          severity: 'info',
          message: `Seçenek profili: ${changed.length} üründen anlamsız seçenek bağları kalktı (${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ` ve ${changed.length - 8} ürün daha` : ''})`,
          data: { products: changed },
        })
        .run();
    }
    setSyncState(UPGRADE_KEY, true);
  });
  return changed.length;
}

/** Testler için: yükseltme yeniden denensin */
export function resetOptionProfileUpgrade() {
  db.delete(schema.syncState).where(eq(schema.syncState.key, UPGRADE_KEY)).run();
}
