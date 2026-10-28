import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PlatformOrderPayload } from '@shared/platforms';
import type { BootstrapDTO, OptionGroupDTO, OrderDTO } from '@shared/types';
import { defaultPicks, editingPicks, knownPicks, missingChoice, pendingProblem, pickHint, pickNote, pickSingle, reconcilePicks, soldOutDefault } from '../src/lib/boot';
import { type FakeSite, startFakeSite } from './fake-site';
import { type Harness, startApp } from './harness';

/**
 * Seçenek tükendi (p-6, yulaf sütü bitti): kasada Tükenen ürünler › Seçenekler işaretler (ürünün Tükendi yetkisi,
 * denetim kaydı, `menu` olayı). Kasa satışı açıkça seçilen tükenen seçeneği ve zorunlu grubun tükenen varsayılanını
 * 409 `option_sold_out` ile reddeder; isteğe bağlı grubun tükenen varsayılanı (Normal süt) satışı durdurmaz, o grup
 * için seçenek yazılmaz. Siteden gelen ödenmiş sipariş ve paket platformu siparişi reddedilmez. Menü senkronu ve
 * yönetimdeki grup düzenlemesi işarete dokunmaz.
 */
const SECRET = 'q'.repeat(48);
let h: Harness;
let site: FakeSite;

beforeAll(async () => {
  site = await startFakeSite(SECRET);
  h = await startApp({ LAFFOGATO_URL: site.url, LAFFOGATO_SYNC_SECRET: SECRET });
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(async () => {
  h.cleanup();
  await site.close();
});

const boot = () => h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
const product = (b: BootstrapDTO, name: string) => b.products.find((p) => p.name === name)!;
/** Ürünün adı verilen gruptaki seçeneği (iki "Şeker" grubu var: kasanınki zorunlu tek seçim, sitenin sayaçlı) */
function option(b: BootstrapDTO, productName: string, groupName: string, itemName: string) {
  const p = product(b, productName);
  const g = b.optionGroups.find((x) => x.name === groupName && p.optionGroupIds.includes(x.id))!;
  return { group: g, item: g.items.find((i) => i.name === itemName)! };
}
const mark = (who: string, itemId: string, soldOut: boolean) => h.call<{ changed?: boolean; code?: string }>(who, 'POST', `/option-items/${itemId}/sold-out`, { soldOut });
async function sell(items: { productId: string; size?: 'M' | 'L' | 'TEK'; qty: number; options?: { itemId: string; qty?: number }[] }[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return { order: o, res: await h.call<OrderDTO & { code?: string; error?: string }>('kasa', 'POST', `/orders/${o.id}/items`, { items }) };
}
async function auditRows() {
  return h.ok<{ action: string; entityId: string | null; message: string; data: { soldOut?: boolean } | null }[]>('patron', 'GET', '/admin/audit?limit=100');
}

describe('kasada seçenek tükendi', () => {
  it('kasiyer işaretler: bootstrap\'ta görünür, denetim kaydı ve menü olayı; aynı istek ikinci kez yazmaz', async () => {
    const { bus } = await import('../server/lib/events');
    const { item: oat } = option(await boot(), 'Latte', 'Süt', 'Yulaf');
    expect(oat.soldOut).toBe(false);
    const events: { topic: string; kind: string }[] = [];
    const listen = (e: { topic: string; kind: string }) => events.push(e);
    bus.on('event', listen);
    try {
      const r = await mark('kasa', oat.id, true);
      expect(r.status).toBe(200);
      expect(r.json.changed).toBe(true);
    } finally {
      bus.off('event', listen);
    }
    expect(events).toContainEqual(expect.objectContaining({ topic: 'menu', kind: 'option.sold_out' }));
    expect(option(await boot(), 'Latte', 'Süt', 'Yulaf').item.soldOut).toBe(true);
    const rows = (await auditRows()).filter((a) => a.action === 'menu.option_sold_out' && a.entityId === oat.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].message).toBe('Kasa: Yulaf (Süt) tükendi');
    expect(rows[0].data).toEqual({ soldOut: true });

    expect((await mark('kasa', oat.id, true)).json.changed).toBe(false);
    expect((await auditRows()).filter((a) => a.action === 'menu.option_sold_out' && a.entityId === oat.id)).toHaveLength(1);
  });

  it('yetki: Tükendi yetkisi olmayan (garson) 403; olmayan seçenek 404', async () => {
    const { item: almond } = option(await boot(), 'Latte', 'Süt', 'Badem');
    const r = await mark('garson', almond.id, true);
    expect(r.status).toBe(403);
    expect(option(await boot(), 'Latte', 'Süt', 'Badem').item.soldOut).toBe(false);
    expect((await mark('kasa', 'yok', true)).status).toBe(404);
  });

  it('kasa satışı tükenen seçeneği 409 option_sold_out ile reddeder, adisyona bir şey yazılmaz', async () => {
    const b = await boot();
    const latte = product(b, 'Latte');
    const { item: oat } = option(b, 'Latte', 'Süt', 'Yulaf');
    const { order, res } = await sell([{ productId: latte.id, size: 'M', qty: 1, options: [{ itemId: oat.id }] }]);
    expect(res.status).toBe(409);
    expect(res.json.code).toBe('option_sold_out');
    expect(res.json.error).toBe('Yulaf tükendi');
    expect((await h.ok<OrderDTO>('kasa', 'GET', `/orders/${order.id}`)).items).toHaveLength(0);
  });

  it('isteğe bağlı grubun varsayılanı tükendiyse satış durmaz, o grup için seçenek yazılmaz (Normal süt bitti: su, latte)', async () => {
    // Site Süt grubunu sudan çaya bütün içeceklere bağlar: Normal bitti diye su satılamaz olmasın, yerine başka süt
    // yazılmasın (lafmaliyet'e yanlış ALTERNATIF SÜT satırı, fazladan ek fiyat)
    const b = await boot();
    const [water, latte] = [product(b, 'Su'), product(b, 'Latte')];
    const { group: milk, item: normal } = option(b, 'Latte', 'Süt', 'Normal');
    const { item: lactoseFree } = option(b, 'Latte', 'Süt', 'Laktozsuz');
    const { item: oat } = option(b, 'Latte', 'Süt', 'Yulaf');
    expect([milk.required, water.optionGroupIds.includes(milk.id)]).toEqual([false, true]);
    // Yulaf ilk testten beri tükendi; sonda o hâline döner (aşağıdaki müdür testi açar)
    const oatWas = oat.soldOut;
    await mark('kasa', normal.id, true);
    await mark('kasa', oat.id, true);
    try {
      const plain = await sell([
        { productId: water.id, qty: 1 },
        { productId: latte.id, size: 'M', qty: 1 },
      ]);
      expect(plain.res.status).toBe(200);
      const items = plain.res.json.items;
      expect(items.map((i) => i.options.filter((o) => o.groupId === milk.id))).toEqual([[], []]);
      // Tutar menü fiyatı: yerine ücretli süt (Yulaf +25 TL) yazılmadı
      expect(items.map((i) => i.unitPrice)).toEqual([water.price, latte.price]);

      // Açıkça seçilen tükenen seçenek her grupta reddedilir
      const picked = await sell([{ productId: latte.id, size: 'M', qty: 1, options: [{ itemId: oat.id }] }]);
      expect(picked.res.status).toBe(409);
      expect(picked.res.json).toMatchObject({ code: 'option_sold_out', error: 'Yulaf tükendi' });
      const chosen = await sell([{ productId: latte.id, size: 'M', qty: 1, options: [{ itemId: lactoseFree.id }] }]);
      expect(chosen.res.status).toBe(200);
      expect(chosen.res.json.items[0].options.map((o) => o.name)).toContain('Laktozsuz');

      // lafmaliyet gün yükünde su ve latte, ALTERNATIF SÜT yok
      const cash = b.paymentMethods.find((m) => m.name === 'Nakit')!;
      const paid = await h.ok<{ closed: boolean }>('kasa', 'POST', `/orders/${plain.order.id}/payments`, { methodId: cash.id, amount: plain.res.json.total });
      expect(paid.closed).toBe(true);
      const { salesLines } = await import('../server/sync/lafmaliyet');
      const names = salesLines([plain.order.dayId]).map((l) => l.posName);
      expect(names).toEqual(expect.arrayContaining(['SU', 'LATTE MEDIUM']));
      expect(names).not.toContain('ALTERNATIF SÜT');
    } finally {
      await mark('kasa', normal.id, false);
      await mark('kasa', oat.id, oatWas);
    }
    // Açılınca seçeneksiz satış yine varsayılanı yazar
    const again = await sell([{ productId: latte.id, size: 'M', qty: 1 }]);
    expect(again.res.status).toBe(200);
    expect(again.res.json.items[0].options.filter((o) => o.groupId === milk.id).map((o) => o.name)).toEqual(['Normal']);
  });

  it('zorunlu tek seçimlik grup: varsayılan tükendi ve boş gönderildi 409 (değişmedi); seçilince satılır', async () => {
    const b = await boot();
    const coffee = product(b, 'Türk Kahvesi');
    const { group, item: medium } = option(b, 'Türk Kahvesi', 'Şeker', 'Orta');
    expect([group.required, group.kind, medium.isDefault]).toEqual([true, 'single', true]);
    const { item: plain } = option(b, 'Türk Kahvesi', 'Şeker', 'Sade');
    await mark('kasa', medium.id, true);
    try {
      const empty = await sell([{ productId: coffee.id, qty: 1 }]);
      expect(empty.res.status).toBe(409);
      expect(empty.res.json).toMatchObject({ code: 'option_sold_out', error: 'Orta tükendi; Şeker seçin' });
      expect((await sell([{ productId: coffee.id, qty: 1, options: [{ itemId: plain.id }] }])).res.status).toBe(200);
    } finally {
      await mark('kasa', medium.id, false);
    }
  });

  it('sayaçlı grup: tükenen seçenek adetle seçilirse 409, sıfır adet satışı durdurmaz', async () => {
    const b = await boot();
    const latte = product(b, 'Latte');
    const { item: shot } = option(b, 'Latte', 'Ekstra shot', 'Ekstra shot');
    await mark('kasa', shot.id, true);
    try {
      const one = await sell([{ productId: latte.id, size: 'M', qty: 1, options: [{ itemId: shot.id, qty: 1 }] }]);
      expect(one.res.status).toBe(409);
      expect(one.res.json.code).toBe('option_sold_out');
      expect((await sell([{ productId: latte.id, size: 'M', qty: 1, options: [{ itemId: shot.id, qty: 0 }] }])).res.status).toBe(200);
    } finally {
      await mark('kasa', shot.id, false);
    }
  });

  it('menü yetkisi olan (müdür) da açar; açılış da denetim kaydına düşer', async () => {
    const { item: oat } = option(await boot(), 'Latte', 'Süt', 'Yulaf');
    expect((await mark('mudur', oat.id, false)).json.changed).toBe(true);
    const rows = (await auditRows()).filter((a) => a.action === 'menu.option_sold_out' && a.entityId === oat.id);
    expect(rows[0]).toMatchObject({ message: 'Müdür: Yulaf (Süt) satışa açıldı', data: { soldOut: false } });
    expect(option(await boot(), 'Latte', 'Süt', 'Yulaf').item.soldOut).toBe(false);
  });
});

describe('kasa dışından gelen sipariş reddedilmez, işaret korunur', () => {
  it('siteden gelen ödenmiş sipariş (Yulaf) tükenen seçenekle de alınır', async () => {
    const { item: oat } = option(await boot(), 'Latte', 'Süt', 'Yulaf');
    await mark('kasa', oat.id, true);
    try {
      await h.ok('kasa', 'POST', '/sync/online/refresh');
      const { db, schema } = await import('../server/db/client');
      const { eq } = await import('drizzle-orm');
      const lines = db.select({ optionsText: schema.orderItems.optionsText }).from(schema.orderItems).innerJoin(schema.orders, eq(schema.orders.id, schema.orderItems.orderId)).where(eq(schema.orders.source, 'laffogato')).all();
      expect(lines.map((l) => l.optionsText)).toContain('Yulaf');
    } finally {
      await mark('kasa', oat.id, false);
    }
  });

  it('paket platformu siparişi, varsayılanı tükenen üründe de kabul edilir', async () => {
    const b = await boot();
    const { item: normal } = option(b, 'Latte', 'Süt', 'Normal');
    await h.ok('patron', 'PUT', '/platforms/yemeksepeti', { mode: 'deneme' });
    const lines = [{ externalId: 'ys-latte', name: 'Latte', qty: 1, unitPrice: 19000, modifiers: ['Yulaf sütü'], note: null }];
    const payload: PlatformOrderPayload = {
      platform: 'yemeksepeti',
      simulated: true,
      externalId: `ys-${Math.random()}`,
      code: 'S0LD',
      placedAt: Date.now(),
      scheduledFor: null,
      courier: 'platform',
      platformCollects: true,
      paymentLabel: 'Online kart',
      customer: { name: 'Ayşe K.', phone: null, address: null },
      note: null,
      lines,
      subtotal: 19000,
      restaurantDiscount: 0,
      platformDiscount: 0,
      customerTotal: 19000,
    };
    await mark('kasa', normal.id, true);
    try {
      const { tx } = await import('../server/db/client');
      const { Effects } = await import('../server/lib/effects');
      const service = await import('../server/delivery/service');
      const fx = new Effects();
      const { row } = tx((t) => service.ingestPlatformOrder(t, fx, payload, Date.now()));
      fx.flush();
      const { orderId } = await h.ok<{ orderId: string }>('kasa', 'POST', `/platforms/orders/${row.id}/accept`, {});
      const o = await h.ok<OrderDTO>('kasa', 'GET', `/orders/${orderId}`);
      expect(o.items).toHaveLength(1);
      expect(o.items[0]).toMatchObject({ name: 'Latte', unitPrice: 19000, note: 'Yulaf sütü' });
    } finally {
      await mark('kasa', normal.id, false);
    }
  });

  it('menü senkronu ve yönetimdeki grup düzenlemesi Tükendi işaretine dokunmaz', async () => {
    const b = await boot();
    const { item: oat } = option(b, 'Latte', 'Süt', 'Yulaf');
    const { group: cups, item: glass } = option(b, 'Latte', 'Bardak', 'Cam bardak');
    await mark('kasa', oat.id, true);
    await mark('kasa', glass.id, true);
    try {
      // Site senkronu her turda seçenekleri yeniden yazar (ad, fiyat, sıra, active)
      expect((await h.ok<{ status: string }>('mudur', 'POST', '/sync/menu/apply')).status).toBe('uygulandi');
      // Kasaya özel grup yönetimde düzenlenir (ad, fiyat, varsayılan)
      await h.ok('mudur', 'PUT', `/admin/option-groups/${cups.id}`, {
        name: cups.name,
        kind: cups.kind,
        required: cups.required,
        maxSelect: cups.maxSelect,
        items: cups.items.map((i) => ({ id: i.id, name: i.name, price: i.price, isDefault: i.isDefault, maxQty: i.maxQty })),
      });
      const after = await boot();
      expect(option(after, 'Latte', 'Süt', 'Yulaf').item.soldOut).toBe(true);
      expect(option(after, 'Latte', 'Bardak', 'Cam bardak').item.soldOut).toBe(true);
    } finally {
      await mark('kasa', oat.id, false);
      await mark('kasa', glass.id, false);
    }
  });
});

describe('seçenek penceresi: seçiliyken tükenen seçenek (saf kurallar)', () => {
  const item = (id: string, name: string, over: Partial<OptionGroupDTO['items'][number]> = {}) => ({ id, name, code: null, price: 0, isDefault: false, maxQty: 1, allergens: [], soldOut: false, ...over });
  const milk: OptionGroupDTO = {
    id: 'g-sut',
    name: 'Süt',
    kind: 'single',
    required: false,
    maxSelect: 1,
    extKey: 'milk',
    items: [item('normal', 'Normal', { isDefault: true }), item('oat', 'Yulaf', { price: 1500, soldOut: true }), item('lf', 'Laktozsuz', { price: 1000 })],
  };

  it('sepetteki "Latte (Yulaf)" düzenlenirken tükenen Yulaf seçili kalır: uyarı var (Güncelle kapalı), sunucu normal süt yazmaz', () => {
    const picks = editingPicks([{ itemId: 'oat' }, { itemId: 'shot', qty: 2 }]);
    expect(picks).toEqual({ oat: 1, shot: 2 });
    expect(pickHint(milk, picks)).toBe('Yulaf tükendi, başka birini seçin');
  });

  it('seçili tükenen çipe dokunmak onu bırakır (grup varsayılanına döner); başka süt seçmek yerine geçer, öteki gruplar kalır', () => {
    const picks = { oat: 1, shot: 2 };
    expect(pickSingle(milk, picks, 'oat')).toEqual({ shot: 2, normal: 1 });
    expect(pickSingle(milk, picks, 'lf')).toEqual({ shot: 2, lf: 1 });
    expect(pickHint(milk, pickSingle(milk, picks, 'oat'))).toBeNull();
    // Satıştaki seçenek radyo düğmesi gibi: zaten seçiliyse seçili kalır
    expect(pickSingle(milk, { lf: 1 }, 'lf')).toEqual({ lf: 1 });
  });

  it('zorunlu grupta tükenen seçim bırakılınca grup seçim bekler; varsayılanı da tükendiyse önseçim gelmez', () => {
    const sugar: OptionGroupDTO = { ...milk, id: 'g-seker', name: 'Şeker', required: true, extKey: null, items: [item('sade', 'Sade'), item('orta', 'Orta', { soldOut: true })] };
    expect(pickHint(sugar, { orta: 1 })).toBe('Orta tükendi, başka birini seçin');
    expect(pickSingle(sugar, { orta: 1 }, 'orta')).toEqual({});
    expect(missingChoice([sugar], {})?.name).toBe('Şeker');
    // Zorunlu grubun tükenen varsayılanı Ekle'yi kapatır
    const sugarSoldDefault: OptionGroupDTO = { ...sugar, items: [item('sade', 'Sade'), item('orta', 'Orta', { isDefault: true, soldOut: true })] };
    expect(pickHint(sugarSoldDefault, {})).toBe('Orta tükendi, başka birini seçin');
    expect(pickNote(sugarSoldDefault, {})).toBeNull();
  });

  it('isteğe bağlı grubun tükenen varsayılanı: önseçim yok, yalnız bilgi notu, Ekle açık (sunucu seçenek yazmaz)', () => {
    const soldDefault: OptionGroupDTO = { ...milk, items: milk.items.map((i) => ({ ...i, soldOut: i.id !== 'lf' })) };
    expect(defaultPicks([soldDefault])).toEqual({});
    expect(pickSingle(soldDefault, { oat: 1 }, 'oat')).toEqual({});
    expect(pickHint(soldDefault, {})).toBeNull();
    expect(pickNote(soldDefault, {})).toBe('Normal tükendi');
    expect(missingChoice([soldDefault], {})).toBeUndefined();
    // Başka süt seçilince not kalkar
    expect(pickNote(soldDefault, { lf: 1 })).toBeNull();
  });

  it('çok seçimli grupta tükenen seçim "kaldırın" der', () => {
    const syrup: OptionGroupDTO = { ...milk, kind: 'multi', maxSelect: 2, items: [item('vanilya', 'Vanilya', { soldOut: true }), item('karamel', 'Karamel')] };
    expect(pickHint(syrup, { vanilya: 1, karamel: 1 })).toBe('Vanilya tükendi, kaldırın');
    expect(pickHint(syrup, { karamel: 1 })).toBeNull();
  });

  // Hızlı ekleme ve sepet: kurallar sunucunun resolveOptions'ıyla aynı
  const sugar: OptionGroupDTO = { ...milk, id: 'g-seker', name: 'Şeker', required: true, extKey: 'sugar', items: [item('sade', 'Sade'), item('orta', 'Orta', { isDefault: true })] };
  const bootOf = (groups: OptionGroupDTO[]) => ({ optionGroups: groups }) as unknown as BootstrapDTO;
  const prod = (groupIds: string[]) => ({ id: 'p', optionGroupIds: groupIds }) as unknown as BootstrapDTO['products'][number];

  it('hızlı ekleme pencereyi yalnız zorunlu grubun varsayılanı tükendiyse açar (Normal süt bitti, su hemen eklenir)', () => {
    const milkSold = { ...milk, items: milk.items.map((i) => (i.id === 'normal' ? { ...i, soldOut: true } : i)) };
    expect(soldOutDefault(bootOf([milkSold]), prod([milkSold.id]))).toBe(false);
    const sugarSold = { ...sugar, items: sugar.items.map((i) => (i.id === 'orta' ? { ...i, soldOut: true } : i)) };
    expect(soldOutDefault(bootOf([milkSold, sugarSold]), prod([milkSold.id, sugarSold.id]))).toBe(true);
  });

  it('sepette gönderilemeyecek satırın nedeni: tükenen seçim, zorunlu grubun tükenen varsayılanı, kapanan grubun seçimi', () => {
    const milkNormalSold = { ...milk, items: milk.items.map((i) => (i.id === 'normal' ? { ...i, soldOut: true } : i)) };
    const sugarSold = { ...sugar, items: sugar.items.map((i) => (i.id === 'orta' ? { ...i, soldOut: true } : i)) };
    const boot = bootOf([milkNormalSold, sugarSold]);
    const p = prod([milk.id, sugar.id]);
    // Açıkça seçilen tükenen seçenek (her grupta)
    expect(pendingProblem(boot, p, [{ itemId: 'oat' }, { itemId: 'sade' }])).toBe('Yulaf tükendi');
    // Zorunlu grupta seçim yok, varsayılan tükendi
    expect(pendingProblem(boot, p, [])).toBe('Orta tükendi, şeker seçin');
    // İsteğe bağlı grubun tükenen varsayılanı satırı durdurmaz
    expect(pendingProblem(boot, p, [{ itemId: 'sade' }])).toBeNull();
    // Zorunlu grubun varsayılanı yoksa seçim ister (sunucu 400 option_required)
    expect(pendingProblem(bootOf([{ ...sugar, items: [item('sade', 'Sade')] }]), prod([sugar.id]), [])).toBe('Şeker seçin');
    // Grubu kapanan seçenek (açılış verisinde yok): sunucu 400 option_invalid
    expect(pendingProblem(bootOf([milk]), prod([milk.id]), [{ itemId: 'karton' }])).toBe('Seçeneği kalktı, düzenleyin');
    expect(pendingProblem(bootOf([milk]), prod([milk.id]), [{ itemId: 'lf' }])).toBeNull();
  });

  it('pencere açıkken grup kapanır ya da açılır: kapanan grubun seçimi atılır, yeni grubun varsayılanı gelir, tükenen seçim kalır', () => {
    const cup: OptionGroupDTO = { ...milk, id: 'g-bardak', name: 'Bardak', extKey: null, items: [item('karton', 'Karton', { isDefault: true, price: 500 }), item('cam', 'Cam')] };
    // Açılışta Süt ve Bardak; Yulaf seçiliyken tükendi
    const picks = { oat: 1, karton: 1 };
    // Bardak kapandı: kartonu atılır, tükenen Yulaf açılış verisinde durduğu için kalır
    const closed = reconcilePicks([milk], picks, new Set([milk.id, cup.id]));
    expect(closed).toEqual({ oat: 1 });
    // Bardak yeniden açıldı: ücretli varsayılanı seçili gelir (ekranda görünmeden fiyata girmesin)
    expect(reconcilePicks([milk, cup], closed, new Set([milk.id]))).toEqual({ oat: 1, karton: 1 });
    // Gruplar aynıysa seçim aynı nesne (gereksiz çizim yok); kasiyerin bıraktığı varsayılan geri gelmez
    const same = { lf: 1 };
    expect(reconcilePicks([milk, cup], same, new Set([milk.id, cup.id]))).toBe(same);
    // Düzenlenen satırda grubu kapanan seçenek düşer
    expect(knownPicks([milk], editingPicks([{ itemId: 'lf' }, { itemId: 'karton' }]))).toEqual({ lf: 1 });
  });
});
