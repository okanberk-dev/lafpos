import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, OptionGroupDTO, OptionItemDTO, OrderDTO } from '@shared/types';
import { asksOptions, defaultPicks, missingChoice, needsChoice, productGroups } from '../src/lib/boot';
import { type Harness, startApp } from './harness';

/**
 * Varyant (boy) eklerken seçenek (kullanıcı, 27 Ekim 2026: "varyant ekleme de seçenekli olsun"): iki boylu üründe
 * zorunlu seçim varsa (Türk kahvesinde şeker) boy düğmesi pencereyi açar, zorunlu grupta önseçim yok; Yönetim ›
 * Ayarlar › Seçenekleri sor "Seçenekli her üründe" ise seçeneği olan her iki boylu ürün pencereyle eklenir.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const withAsk = (boot: BootstrapDTO, askOptions: 'zorunlu' | 'hep'): BootstrapDTO => ({ ...boot, settings: { ...boot.settings, askOptions } });
const group = (over: Partial<OptionGroupDTO> & Pick<OptionGroupDTO, 'kind'>): OptionGroupDTO => ({
  id: over.id ?? `g-${over.kind}`,
  name: over.name ?? 'Grup',
  required: false,
  maxSelect: 1,
  extKey: null,
  // Yalnız kuralın baktığı alanlar (sonradan eklenen seçenek alanları bu testi ilgilendirmez)
  items: [
    { id: `${over.id ?? over.kind}-a`, name: 'A', code: null, price: 0, isDefault: false, maxQty: 3, allergens: [], soldOut: false },
    { id: `${over.id ?? over.kind}-b`, name: 'B', code: null, price: 0, isDefault: true, maxQty: 3, allergens: [], soldOut: false },
  ] as OptionItemDTO[],
  ...over,
});

describe('seçenek sorma: saf kurallar (kurulum menüsüyle)', () => {
  it('Türk kahvesinin şekeri zorunlu seçim; Latte ve seçeneksiz ürün değil', () => {
    expect(needsChoice(h.boot, product('Türk Kahvesi'))).toBe(true);
    expect(needsChoice(h.boot, product('Latte'))).toBe(false);
    const plain = h.boot.products.find((p) => p.priceL != null && p.optionGroupIds.length === 0);
    if (plain) expect(needsChoice(h.boot, plain)).toBe(false);
  });

  it('varsayılan ayar "zorunlu": Türk kahvesi pencereyle, Latte boy düğmesiyle hemen eklenir', () => {
    expect(h.boot.settings.askOptions).toBe('zorunlu');
    expect(asksOptions(h.boot, product('Türk Kahvesi'))).toBe(true);
    expect(asksOptions(h.boot, product('Latte'))).toBe(false);
  });

  it('"hep": seçeneği olan her ürün pencereyle; seçeneği olmayan yine hemen eklenir', () => {
    const boot = withAsk(h.boot, 'hep');
    expect(asksOptions(boot, product('Latte'))).toBe(true);
    expect(asksOptions(boot, product('Türk Kahvesi'))).toBe(true);
    const plain = h.boot.products.find((p) => p.optionGroupIds.length === 0)!;
    expect(asksOptions(boot, plain)).toBe(false);
  });

  it('eski sunucu ya da tanınmayan değer "zorunlu" sayılır', () => {
    const { askOptions: _, ...rest } = h.boot.settings;
    const old = { ...h.boot, settings: rest } as unknown as BootstrapDTO;
    expect(asksOptions(old, product('Latte'))).toBe(false);
    expect(asksOptions(old, product('Türk Kahvesi'))).toBe(true);
    expect(asksOptions(withAsk(h.boot, 'garip' as 'hep'), product('Latte'))).toBe(false);
  });

  it('pencere: şekerde önseçim yok, bardakta varsayılan seçili; şeker seçilene kadar eksik', () => {
    const groups = productGroups(h.boot, product('Türk Kahvesi'));
    const sugar = groups.find((g) => g.name === 'Şeker')!;
    const cup = groups.find((g) => g.name === 'Bardak')!;
    expect(sugar.required).toBe(true);
    const picks = defaultPicks(groups);
    expect(sugar.items.some((i) => picks[i.id])).toBe(false);
    expect(picks[cup.items.find((i) => i.isDefault)!.id]).toBe(1);
    expect(missingChoice(groups, picks)?.name).toBe('Şeker');
    const sade = sugar.items.find((i) => i.name === 'Sade')!;
    expect(missingChoice(groups, { ...picks, [sade.id]: 1 })).toBeUndefined();
  });

  it('Latte: isteğe bağlı gruplarda varsayılan önseçim sürer, eksik seçim yok', () => {
    const groups = productGroups(h.boot, product('Latte'));
    const picks = defaultPicks(groups);
    const milk = groups.find((g) => g.extKey === 'milk')!;
    expect(milk.required).toBe(false);
    expect(picks[milk.items.find((i) => i.isDefault)!.id]).toBe(1);
    expect(missingChoice(groups, picks)).toBeUndefined();
  });

  it('zorunlu çok seçimli grup da seçim ister; sayaçlı ve boş grup istemez', () => {
    const multi = group({ id: 'm', kind: 'multi', required: true });
    const counter = group({ id: 'c', kind: 'counter', required: true });
    const empty = group({ id: 'e', kind: 'single', required: true, items: [] });
    const single = group({ id: 's', kind: 'single', required: true });
    expect(defaultPicks([multi, counter, empty, single])).toEqual({});
    expect(missingChoice([counter, empty], {})).toBeUndefined();
    expect(missingChoice([counter, multi], {})?.id).toBe('m');
    expect(missingChoice([multi], { 'm-a': 1 })).toBeUndefined();
    expect(missingChoice([single], { 's-b': 0 })?.id).toBe('s');
    // İsteğe bağlı tek seçimlikte varsayılan gelir
    expect(defaultPicks([group({ id: 'o', kind: 'single' })])).toEqual({ 'o-b': 1 });
  });
});

describe('Seçenekleri sor ayarı (sunucu)', () => {
  it('açılış verisinde herkese gider; yalnız ayar yetkisi olan değiştirir', async () => {
    expect((await h.ok<BootstrapDTO>('garson', 'GET', '/bootstrap')).settings.askOptions).toBe('zorunlu');
    for (const who of ['kasa', 'garson']) {
      const r = await h.call(who, 'PUT', '/admin/settings', { askOptions: 'hep' });
      expect(r.status, who).toBe(403);
    }
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.askOptions).toBe('zorunlu');
  });

  it('tanınmayan değer reddedilir', async () => {
    const r = await h.call('patron', 'PUT', '/admin/settings', { askOptions: 'bazen' });
    expect(r.status).toBe(422);
    expect(JSON.stringify(r.json)).toMatch(/askOptions/);
  });

  it('kaydedilir, denetim kaydına düşer; başka ayar kaydı onu varsayılana çekmez (patchOf)', async () => {
    const saved = await h.ok<{ askOptions: string }>('patron', 'PUT', '/admin/settings', { askOptions: 'hep' });
    expect(saved.askOptions).toBe('hep');
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.askOptions).toBe('hep');
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.find((a) => a.action === 'settings.update')?.message).toMatch(/Seçenekleri sor/);
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 9 });
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).settings.askOptions).toBe('hep');
    await h.ok('patron', 'PUT', '/admin/settings', { askOptions: 'zorunlu' });
  });

  it('pencereden seçilen şeker bara gider, büyük boy fiyatıyla; seçeneksiz eski istemciye varsayılan sürer', async () => {
    const tk = product('Türk Kahvesi');
    const sade = productGroups(h.boot, tk)
      .find((g) => g.name === 'Şeker')!
      .items.find((i) => i.name === 'Sade')!;
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const after = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, {
      items: [
        { productId: tk.id, size: 'L', qty: 1, options: [{ itemId: sade.id }] },
        { productId: tk.id, size: 'M', qty: 1, options: [] },
      ],
    });
    const [large, medium] = after.items;
    expect(large.size).toBe('L');
    expect(large.optionsText).toBe('Sade');
    expect(large.unitPrice).toBe(tk.priceL);
    expect(medium.optionsText).toBe('Orta');
  });
});
