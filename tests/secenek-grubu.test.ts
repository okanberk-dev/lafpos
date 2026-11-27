import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, ProductDTO } from '@shared/types';
import { asksOptions, needsChoice, productGroups } from '../src/lib/boot';
import { type Harness, startApp } from './harness';

/**
 * Seçenek grupları (28 Ekim 2026): ürün ve grup bağları tek istekte ve tek işlemde (ürün çekmecesi), gruptan
 * ürünlere bağlama (Seçenekler), seçenek ek fiyatı ve bağ değişikliğinin denetim kaydı, site grubunun metni.
 */
let h: Harness;

beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

type Group = { id: string; name: string; extSource: string | null; active: boolean };
type Item = { id: string; groupId: string; name: string; price: number; active: boolean };
type Menu = { categories: { id: string; extSource: string | null }[]; products: ProductDTO[]; optionGroups: Group[]; optionItems: Item[] };
type Audit = { action: string; entity: string | null; entityId: string | null; message: string; data: Record<string, unknown> | null };

const menu = () => h.ok<Menu>('patron', 'GET', '/admin/menu');
const audits = async (action: string, entityId?: string) => (await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.action === action && (!entityId || a.entityId === entityId));
const groupsOf = async (productId: string) => (await menu()).products.find((p) => p.id === productId)!.optionGroupIds;

let seq = 0;
/** Kasaya özel yeni grup (tek seçenekli) */
async function localGroup(name = `Grup ${++seq}`, items = [{ name: 'Biri', price: 0 }]) {
  return (await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', { name, kind: 'single', items })).id;
}
async function localProduct(extra: Record<string, unknown> = {}) {
  const m = await menu();
  return h.call<{ id: string; code?: string }>('patron', 'POST', '/admin/products', { categoryId: m.categories[0]!.id, name: `Yerel ${++seq}`, price: 5000, kdvRate: 10, ...extra });
}

describe('ürün ve seçenek grupları tek istekte', () => {
  it('yeni ürün grupları ile birlikte oluşur; bağ denetim kaydına düşer', async () => {
    const a = await localGroup('Bardak boyu');
    const b = await localGroup('Kapak');
    const r = await localProduct({ groupIds: [b, a] });
    expect(r.status).toBe(200);
    expect(await groupsOf(r.json.id)).toEqual([b, a]);
    expect(await audits('menu.product', r.json.id)).toHaveLength(1);
    const [link] = await audits('menu.product_groups', r.json.id);
    expect(link?.message).toMatch(/seçenek grupları: eklenen Kapak, Bardak boyu$/);
    expect(link?.data).toEqual({ added: ['Kapak', 'Bardak boyu'], removed: [] });
  });

  it('yinelenen grup 409, olmayan grup 422; ürün hiç oluşmaz', async () => {
    const g = await localGroup();
    const before = (await menu()).products.length;
    const dup = await localProduct({ groupIds: [g, g] });
    expect([dup.status, dup.json.code]).toEqual([409, 'duplicate']);
    const missing = await localProduct({ groupIds: [g, 'YOK'] });
    expect([missing.status, missing.json.code]).toEqual([422, 'invalid_reference']);
    expect((await menu()).products.length).toBe(before);
  });

  it('düzenlemede groupIds gönderilmezse bağlar değişmez, gönderilirse aynı işlemde yazılır', async () => {
    const a = await localGroup();
    const b = await localGroup();
    const { id } = (await localProduct({ groupIds: [a] })).json;
    await h.ok('patron', 'PATCH', `/admin/products/${id}`, { shortName: 'Kısa' });
    expect(await groupsOf(id)).toEqual([a]);
    expect(await audits('menu.product_groups', id)).toHaveLength(1);

    await h.ok('patron', 'PATCH', `/admin/products/${id}`, { shortName: 'Yeni kısa', groupIds: [b] });
    const p = (await menu()).products.find((x) => x.id === id)!;
    expect([p.shortName, p.optionGroupIds]).toEqual(['Yeni kısa', [b]]);
    const entries = await audits('menu.product_groups', id);
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.data)).toContainEqual({ added: [expect.any(String)], removed: [expect.any(String)] });

    // Aynı liste yeniden gelince yazılmaz, kayıt düşmez
    await h.ok('patron', 'PATCH', `/admin/products/${id}`, { groupIds: [b] });
    expect(await audits('menu.product_groups', id)).toHaveLength(2);
  });

  it('düzenlemede geçersiz grup listesi ürün alanlarını da yazdırmaz', async () => {
    const a = await localGroup();
    const { id } = (await localProduct({ groupIds: [a], shortName: 'Eski' })).json;
    for (const [groupIds, status] of [
      [[a, a], 409],
      [['YOK'], 422],
    ] as const) {
      const r = await h.call('patron', 'PATCH', `/admin/products/${id}`, { shortName: 'Değişmemeli', groupIds });
      expect(r.status).toBe(status);
    }
    const p = (await menu()).products.find((x) => x.id === id)!;
    expect([p.shortName, p.optionGroupIds]).toEqual(['Eski', [a]]);
  });

  it('siteden gelen üründe gruplar kasa alanı gibi değişir; site alanı gelirse hiçbiri yazılmaz', async () => {
    const m = await menu();
    const site = m.products.find((p) => p.extSource && p.optionGroupIds.length > 0)!;
    const g = await localGroup();
    const r = await h.call<{ code: string }>('patron', 'PATCH', `/admin/products/${site.id}`, { price: 1, groupIds: [g] });
    expect([r.status, r.json.code]).toEqual([409, 'synced_field']);
    expect(await groupsOf(site.id)).toEqual(site.optionGroupIds);

    await h.ok('patron', 'PATCH', `/admin/products/${site.id}`, { groupIds: [...site.optionGroupIds, g] });
    expect(await groupsOf(site.id)).toEqual([...site.optionGroupIds, g]);
  });

  it('eski uç (PUT /products/:id/groups) yerinde; bağ değişikliğini denetim kaydına yazar', async () => {
    const a = await localGroup();
    const { id } = (await localProduct()).json;
    await h.ok('patron', 'PUT', `/admin/products/${id}/groups`, { groupIds: [a] });
    expect(await groupsOf(id)).toEqual([a]);
    expect(await audits('menu.product_groups', id)).toHaveLength(1);
  });
});

describe('gruptan ürünlere bağlama', () => {
  it('eklenen ürünün öteki grupları yerinde kalır, grup sona eklenir; çıkarılanın bağı kalkar', async () => {
    const first = await localGroup();
    const g = await localGroup('Ekstra peynir');
    const p1 = (await localProduct({ groupIds: [first] })).json.id;
    const p2 = (await localProduct()).json.id;
    const p3 = (await localProduct({ groupIds: [g] })).json.id;

    const { bus } = await import('../server/lib/events');
    const seen: { topic: string; kind: string }[] = [];
    const listen = (e: { topic: string; kind: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('patron', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p1, p2] });
    bus.off('event', listen);
    expect(seen).toContainEqual(expect.objectContaining({ topic: 'menu', kind: 'group.products' }));

    expect(await groupsOf(p1)).toEqual([first, g]);
    expect(await groupsOf(p2)).toEqual([g]);
    expect(await groupsOf(p3)).toEqual([]);
    const [entry] = await audits('menu.product_groups', g);
    expect(entry?.entity).toBe('option_group');
    expect(entry?.message).toMatch(/Ekstra peynir grubunun ürünleri: eklenen Yerel \d+, Yerel \d+; çıkarılan Yerel \d+$/);

    // Aynı liste yeniden gelince kayıt düşmez
    await h.ok('patron', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p2, p1] });
    expect(await audits('menu.product_groups', g)).toHaveLength(1);
  });

  it('olmayan grup 404, olmayan ürün 422, yinelenen ürün 409; yetkisiz 403', async () => {
    const g = await localGroup();
    const p = (await localProduct()).json.id;
    const cases: [string, string, string, unknown, number][] = [
      ['patron', 'PUT', '/admin/option-groups/YOK/products', { productIds: [p] }, 404],
      ['patron', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p, 'YOK'] }, 422],
      ['patron', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p, p] }, 409],
      ['kasa', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p] }, 403],
      ['garson', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p] }, 403],
      ['kasa', 'POST', '/admin/products', { categoryId: 'x', name: 'X', price: 1, kdvRate: 10, groupIds: [g] }, 403],
      ['kasa', 'PATCH', `/admin/products/${p}`, { groupIds: [g] }, 403],
      ['kasa', 'POST', '/admin/option-groups', { name: 'X', kind: 'single', items: [] }, 403],
    ];
    for (const [who, m, path, body, status] of cases) {
      const r = await h.call(who, m, path, body);
      expect(r.status, `${who} ${m} ${path}`).toBe(status);
    }
    expect(await groupsOf(p)).toEqual([]);
    // Müdür menü yetkisiyle bağlar
    await h.ok('mudur', 'PUT', `/admin/option-groups/${g}/products`, { productIds: [p] });
    expect(await groupsOf(p)).toEqual([g]);
  });

  it('düzenleyici grubu, seçeneklerini ve ürünlerini tek istekte yazar', async () => {
    const p1 = (await localProduct()).json.id;
    const p2 = (await localProduct()).json.id;
    const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', { name: 'Sos', kind: 'single', items: [{ name: 'Acı', price: 1000 }], productIds: [p1] });
    expect(await groupsOf(p1)).toEqual([id]);

    const m = await menu();
    const item = m.optionItems.find((i) => i.groupId === id)!;
    await h.ok('patron', 'PUT', `/admin/option-groups/${id}`, { name: 'Sos', kind: 'single', items: [{ id: item.id, name: 'Acı', price: 1000 }], productIds: [p2] });
    expect([await groupsOf(p1), await groupsOf(p2)]).toEqual([[], [id]]);

    // Olmayan ürün gelirse grup da değişmez
    const r = await h.call('patron', 'PUT', `/admin/option-groups/${id}`, { name: 'Başka ad', kind: 'single', items: [{ id: item.id, name: 'Acı', price: 1000 }], productIds: ['YOK'] });
    expect(r.status).toBe(422);
    expect((await menu()).optionGroups.find((g) => g.id === id)!.name).toBe('Sos');
  });

  it('kapalı grup kasada sorulmaz, ürün bağları durur', async () => {
    const p = (await localProduct()).json.id;
    const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', { name: 'Kapanacak', kind: 'single', items: [{ name: 'Biri' }], productIds: [p] });
    const item = (await menu()).optionItems.find((i) => i.groupId === id)!;
    await h.ok('patron', 'PUT', `/admin/option-groups/${id}`, { name: 'Kapanacak', kind: 'single', active: false, items: [{ id: item.id, name: 'Biri' }] });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.optionGroups.some((g) => g.id === id)).toBe(false);
    expect((await menu()).optionGroups.find((g) => g.id === id)!.active).toBe(false);
    expect(await groupsOf(p)).toEqual([id]);
    // Kasa ekranı da açık gruplardan karar verir: tek grubu kapalı tek boylu ürün hızlı eklenir (boş pencere açılmaz),
    // kartında seçenek simgesi çıkmaz. Kart, pencere ve sorma kuralı aynı kaynağa (productGroups) bakar
    const product = boot.products.find((x) => x.id === p)!;
    expect(product.optionGroupIds).toEqual([id]);
    expect([productGroups(boot, product), asksOptions(boot, product), needsChoice(boot, product)]).toEqual([[], false, false]);
    const tile = readFileSync(new URL('../src/pages/order/ProductPanel.tsx', import.meta.url), 'utf8');
    expect(tile).toContain('const hasOptions = productGroups(boot, p).length > 0;');
    expect(tile).not.toMatch(/optionGroupIds\.length/);
  });

  it('bir ürüne en çok 12 grup bağlanır, gruptan bağlarken de', async () => {
    const ids = [];
    for (let i = 0; i < 12; i++) ids.push(await localGroup());
    const p = (await localProduct({ groupIds: ids })).json.id;
    const extra = await localGroup('On üçüncü');
    const r = await h.call<{ code: string }>('patron', 'PUT', `/admin/option-groups/${extra}/products`, { productIds: [p] });
    expect([r.status, r.json.code]).toEqual([409, 'too_many_groups']);
    expect(await groupsOf(p)).toEqual(ids);
  });
});

describe('seçenek ek fiyatı denetim kaydında', () => {
  it('fiyat değişince eski → yeni yazılır; yalnız ad değişince kayıt düşmez', async () => {
    const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', {
      name: 'Şurup (kasa)',
      kind: 'single',
      items: [
        { name: 'Yok', price: 0, isDefault: true },
        { name: 'Bal', price: 1500 },
      ],
    });
    const [created] = await audits('menu.option_price', id);
    expect(created?.message).toMatch(/"Şurup \(kasa\)" seçenek grubunu ekledi: eklenen Yok, Bal \+₺15,00$/);

    const items = (await menu()).optionItems.filter((i) => i.groupId === id);
    const [yok, bal] = [items.find((i) => i.name === 'Yok')!, items.find((i) => i.name === 'Bal')!];
    const put = (list: unknown[]) => h.ok('patron', 'PUT', `/admin/option-groups/${id}`, { name: 'Şurup (kasa)', kind: 'single', items: list });

    // Yalnız ad: kayıt yok
    await put([
      { id: yok.id, name: 'Şurupsuz', price: 0, isDefault: true },
      { id: bal.id, name: 'Çam balı', price: 1500 },
    ]);
    expect(await audits('menu.option_price', id)).toHaveLength(1);

    // Fiyat değişti, biri kaldırıldı, biri eklendi
    await put([
      { id: bal.id, name: 'Çam balı', price: 2000 },
      { name: 'Akçaağaç', price: 2500 },
    ]);
    const entries = await audits('menu.option_price', id);
    expect(entries).toHaveLength(2);
    const changed = entries.find((e) => e.message.includes('değiştirdi'))!;
    expect(changed.message).toMatch(/Şurup \(kasa\) seçeneklerini değiştirdi: Çam balı ₺15,00 → ₺20,00; eklenen Akçaağaç \+₺25,00; kaldırılan Şurupsuz$/);
    expect(changed.data).toMatchObject({
      changes: [{ id: bal.id, name: 'Çam balı', from: 1500, to: 2000 }],
      added: [expect.objectContaining({ name: 'Akçaağaç', price: 2500 })],
      removed: [{ id: yok.id, name: 'Şurupsuz', price: 0 }],
    });
  });

  it('varsayılan ücretli seçeneğe geçince (ya da ondan çıkınca) kayıt düşer; ücretsizden ücretsize geçişte düşmez', async () => {
    // Seçeneksiz kasa satışına sunucu tek seçimlik grubun varsayılanını yazar: Cam → Karton satışın tutarını değiştirir
    const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', {
      name: 'Bardak (kasa)',
      kind: 'single',
      items: [
        { name: 'Cam', price: 0, isDefault: true },
        { name: 'Kağıt', price: 0 },
        { name: 'Karton', price: 500 },
      ],
    });
    expect(await audits('menu.option_price', id)).toHaveLength(1);
    const items = (await menu()).optionItems.filter((i) => i.groupId === id);
    const [cam, kagit, karton] = ['Cam', 'Kağıt', 'Karton'].map((n) => items.find((i) => i.name === n)!);
    const put = (def: string) =>
      h.ok('patron', 'PUT', `/admin/option-groups/${id}`, {
        name: 'Bardak (kasa)',
        kind: 'single',
        items: [cam, kagit, karton].map((i) => ({ id: i.id, name: i.name, price: i.price, isDefault: i.id === def })),
      });
    const changed = async () => (await audits('menu.option_price', id)).filter((e) => e.message.includes('değiştirdi'));

    // Ücretsizden ücretsize (Cam → Kağıt): tutar değişmez, kayıt yok
    await put(kagit.id);
    expect(await changed()).toHaveLength(0);

    // Ücretsizden ücretliye (Kağıt → Karton)
    await put(karton.id);
    let entries = await changed();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toMatch(/Bardak \(kasa\) seçeneklerini değiştirdi: varsayılan Kağıt → Karton \+₺5,00$/);
    expect(entries[0]!.data).toEqual({ changes: [], added: [], removed: [], defaultChange: { from: { name: 'Kağıt', price: 0 }, to: { name: 'Karton', price: 500 } } });

    // Ücretliden ücretsize (Karton → Cam) de tutarı değiştirir
    await put(cam.id);
    entries = await changed();
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => /varsayılan Karton \+₺5,00 → Cam$/.test(e.message))).toBe(true);

    // Seçeneksiz kasa satışına yazılan varsayılan: Karton'a alınca tutar +5 TL (kaydın konusu)
    await put(karton.id);
    expect(await changed()).toHaveLength(3);
    const p = (await localProduct({ groupIds: [id] })).json.id;
    await h.call('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const order = await h.ok<{ id: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const r = await h.ok<{ items: { productId: string; options: { name: string; price: number }[] }[] }>('kasa', 'POST', `/orders/${order.id}/items`, { items: [{ productId: p, qty: 1 }] });
    const line = r.items.find((i) => i.productId === p)!;
    expect(line.options.map((o) => [o.name, o.price])).toEqual([['Karton', 500]]);
  });

  it('ücretli varsayılanlı grubu kapatmak ya da açmak kayıt yazar (seçeneksiz satışın tutarı değişir); ücretsiz varsayılanlıda yazmaz', async () => {
    // Kapalı grup kasada yoktur, varsayılanı yazılmaz: Karton +5 TL'lik grubu kapatmak seçeneksiz satışı 5 TL ucuzlatır
    const group = async (name: string, items: { name: string; price: number; isDefault?: boolean }[]) => {
      const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/option-groups', { name, kind: 'single', items });
      const rows = (await menu()).optionItems.filter((i) => i.groupId === id);
      const put = (active: boolean) =>
        h.ok('patron', 'PUT', `/admin/option-groups/${id}`, { name, kind: 'single', active, items: rows.map((r) => ({ id: r.id, name: r.name, price: r.price, isDefault: !!items.find((i) => i.name === r.name)?.isDefault })) });
      const changed = async () => (await audits('menu.option_price', id)).filter((e) => e.message.includes('değiştirdi'));
      return { id, put, changed };
    };

    const paid = await group('Kapak (kasa)', [
      { name: 'Karton', price: 500, isDefault: true },
      { name: 'Cam', price: 0 },
    ]);
    await paid.put(false);
    let entries = await paid.changed();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toMatch(/Kapak \(kasa\) seçeneklerini değiştirdi: grup kapatıldı; varsayılan Karton \+₺5,00 → yok$/);
    expect(entries[0]!.data).toEqual({ changes: [], added: [], removed: [], defaultChange: { from: { name: 'Karton', price: 500 }, to: null }, groupActive: false });
    // Kapalıyken yeniden kaydetmek tutarı değiştirmez
    await paid.put(false);
    expect(await paid.changed()).toHaveLength(1);
    await paid.put(true);
    entries = await paid.changed();
    expect(entries).toHaveLength(2);
    const opened = entries.find((e) => e.message.includes('grup açıldı'))!;
    expect(opened.message).toMatch(/Kapak \(kasa\) seçeneklerini değiştirdi: grup açıldı; varsayılan yok → Karton \+₺5,00$/);
    expect(opened.data).toMatchObject({ defaultChange: { from: null, to: { name: 'Karton', price: 500 } }, groupActive: true });

    // Ücretsiz varsayılanlı grup: açıp kapatmak seçeneksiz satışın tutarını değiştirmez, kayıt yok
    const free = await group('Pipet (kasa)', [
      { name: 'Yok', price: 0, isDefault: true },
      { name: 'Kağıt pipet', price: 200 },
    ]);
    await free.put(false);
    await free.put(true);
    expect(await free.changed()).toHaveLength(0);
  });

  it('site grubu AsilPOS’ta düzenlenmez; mesaj nereden değiştiğini söyler, ürünlere bağlanabilir', async () => {
    const m = await menu();
    const site = m.optionGroups.find((g) => g.extSource)!;
    const r = await h.call<{ error?: string; message?: string; code: string }>('patron', 'PUT', `/admin/option-groups/${site.id}`, { name: 'X', kind: 'single', items: [] });
    expect([r.status, r.json.code]).toEqual([409, 'site_group']);
    expect(JSON.stringify(r.json)).toMatch(/sitenin sabit listesinden gelir, site koduyla değişir; kasaya özel seçenek için yerel grup ekleyin/);
    const p = (await localProduct()).json.id;
    await h.ok('patron', 'PUT', `/admin/option-groups/${site.id}/products`, { productIds: [...m.products.filter((x) => x.optionGroupIds.includes(site.id)).map((x) => x.id), p] });
    expect(await groupsOf(p)).toEqual([site.id]);
  });
});
