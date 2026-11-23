import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO } from '@shared/types';
import { asksOptions } from '../src/lib/boot';
import { type Harness, startApp } from './harness';

/**
 * Seçenek profili (4 Kasım 2026, operatör: "bazı ürünlere varyant vs. eklemeye gerek olmuyor"): sitenin seçenek
 * grupları (süt, kavrum, şurup, ekstra shot, şeker) yalnız anlamlı olduğu ürünlere bağlanır (server/sync/option-profile.ts).
 * Su, Soda, Çay, frozen ve soğuk çay hiçbir şey sormaz; matcha ve sıcak çikolata kavrum ve shot sormaz. Var olan
 * kurulumda düzeltme bir kez ve yalnız yöneticinin değiştirmediği ürünlerde. Kartta yalnız isteğe bağlı seçeneği olan
 * ürün (tek boylu da) tek dokunuşla eklenir; zorunlu seçim (Türk kahvesinde şeker) pencereyi açar.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const SITE = ['milk', 'roast', 'syrup', 'extraShot', 'sugar'];

async function groupsOf(name: string, boot?: BootstrapDTO) {
  const b = boot ?? (await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap'));
  const p = b.products.find((x) => x.name === name)!;
  return p.optionGroupIds.map((id) => {
    const g = b.optionGroups.find((x) => x.id === id)!;
    return g.extKey && SITE.includes(g.extKey) ? g.extKey : `yerel:${g.name}`;
  });
}

describe('kurulumdaki bağlar', () => {
  it('hiçbir şey sorulmayanlar: su, soda, limonata, çay, frozen, soğuk çay, matcha affogato', async () => {
    for (const name of ['Su', 'Soda', "L'Af Limon", 'Cool Lime', 'Çay', 'Çilek', 'Limonlu Soğuk Çay', 'Matcha Affogato']) {
      expect(await groupsOf(name), name).toEqual([]);
    }
  });

  it('anlamlı olanlar bağlı: sütlü kahve hepsi, espresso süt ve şurupsuz, matcha ve sıcak çikolata kahvesiz, smoothie yalnız süt', async () => {
    expect(await groupsOf('Latte')).toEqual(expect.arrayContaining(SITE));
    expect((await groupsOf('Espresso')).filter((g) => SITE.includes(g))).toEqual(['roast', 'extraShot', 'sugar']);
    expect(await groupsOf('Matcha Latte')).toEqual(['milk', 'syrup', 'sugar']);
    expect(await groupsOf('Sıcak Çikolata')).toEqual(['milk', 'syrup', 'sugar']);
    expect(await groupsOf('Salep')).toEqual(['milk']);
    expect(await groupsOf('Yaban Mersini')).toEqual(['milk']);
    expect(await groupsOf('Frappe')).toEqual(['milk', 'syrup', 'extraShot']);
    expect(await groupsOf('Chai Latte')).toEqual(['milk', 'syrup', 'extraShot', 'sugar']);
    // Türk kahvesi: site gruplarından hiçbiri; kasanın kendi zorunlu şekeri ve bardağı
    expect((await groupsOf('Türk Kahvesi')).every((g) => g.startsWith('yerel:'))).toBe(true);
    expect(await groupsOf('Türk Kahvesi')).toContain('yerel:Şeker');
  });
});

describe('var olan kurulumun bir kerelik düzeltmesi', () => {
  it('yöneticinin değiştirmediği ürünlerden profilde olmayan bağ kalkar; değiştirilene dokunulmaz; bir kez çalışır', async () => {
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const { upgradeOptionProfiles, resetOptionProfileUpgrade } = await import('../server/sync/option-profile');
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const site = new Map(boot.optionGroups.filter((g) => g.extKey && SITE.includes(g.extKey)).map((g) => [g.extKey!, g.id]));
    const product = (name: string) => boot.products.find((p) => p.name === name)!;
    const link = (name: string, keys: string[]) => {
      for (const k of keys) db.insert(schema.productOptionGroups).values({ productId: product(name).id, groupId: site.get(k)!, sort: SITE.indexOf(k) }).onConflictDoNothing().run();
    };
    // Eski kurulum: site her ürüne beş grubu bağlamıştı; Türk kahvesinde kurulum site şekerini kendi şekeriyle değiştirmişti
    link('Su', SITE);
    link('Çay', SITE);
    link('Türk Kahvesi', ['milk', 'roast', 'syrup', 'extraShot']);
    // Yönetici Soda'ya bilerek yalnız şurup bağlamış: dokunulmaz
    link('Soda', ['syrup']);
    resetOptionProfileUpgrade();
    expect(upgradeOptionProfiles()).toBe(3);
    expect(await groupsOf('Su')).toEqual([]);
    expect(await groupsOf('Çay')).toEqual([]);
    expect((await groupsOf('Türk Kahvesi')).every((g) => g.startsWith('yerel:'))).toBe(true);
    expect(await groupsOf('Soda')).toEqual(['syrup']);
    // Latte zaten profilde: değişmez
    expect(await groupsOf('Latte')).toEqual(expect.arrayContaining(SITE));
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?severity=tum&limit=50');
    expect(audit.find((a) => a.action === 'menu.product_groups' && a.message.startsWith('Seçenek profili'))?.message).toMatch(/3 üründen anlamsız seçenek bağları kalktı \(/);
    // İkinci açılışta bir şey yapmaz
    link('Su', SITE);
    expect(upgradeOptionProfiles()).toBe(0);
    expect(await groupsOf('Su')).toEqual(SITE);
    db.delete(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, product('Su').id))).run();
    db.delete(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, product('Soda').id))).run();
  });
});

describe('kartta tek dokunuş', () => {
  it('yalnız isteğe bağlı seçeneği olan tek boylu ürün sormaz ("Zorunlu seçim varsa"); "Seçenekli her üründe" sorar', async () => {
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const matcha = boot.products.find((p) => p.name === 'Matcha Latte')!;
    const turkish = boot.products.find((p) => p.name === 'Türk Kahvesi')!;
    expect(matcha.priceL).toBeNull();
    expect(asksOptions(boot, matcha)).toBe(false);
    expect(asksOptions(boot, turkish)).toBe(true);
    expect(asksOptions({ ...boot, settings: { ...boot.settings, askOptions: 'hep' } }, matcha)).toBe(true);
    // Kart ve en çok satanlar şeridinin ortak kuralı (tests/en-cok-satanlar.test.ts)
    const tile = readFileSync(new URL('../src/pages/order/productTap.ts', import.meta.url), 'utf8');
    expect(tile).toContain('ask: asksOptions(boot, p) || (!twoSizes && p.price <= 0)');
    expect(tile).toContain("size: twoSizes ? 'M' : 'TEK'");
  });
});
