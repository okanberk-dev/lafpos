import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { maskOdenmezPeople, odenmezByPerson, odenmezSuggestion, phoneTail } from '@shared/comp';
import type { BootstrapDTO, OdenmezPersonDTO, OrderDTO, ZSummary } from '@shared/types';
import { displayOrder } from '../src/lib/estimate';
import { type Harness, PINS, startApp } from './harness';

/**
 * Ödenmez kayıtlı bir kişiye bağlı (4 Kasım 2026): adisyonun tamamı ya da tek kalem ödenmez kapatılırken kişi
 * (personel ya da kayıtlı müşteri) zorunlu; ikram ve zayide kişi reddedilir. Kişinin var ve etkin olduğu doğrulanır,
 * türü, kimliği ve adının anlık kopyası siparişe ve kaleme yazılır; denetim iletisi kişiyi adlandırır, geri alma kişiyi
 * temizler. Raporlar kişi kişi (iptal ve indirim listesi, kişi bazında özet, personel raporu, CSV, Z). Kişi bilgisi
 * lafmaliyet'e, siteye ve müşteri ekranına gitmez; personel adına yazılan ödenmez personel tutarıdır (maliyet yetkisi).
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

type Audit = { action: string; message: string; orderId: string | null; entityId: string | null; data: Record<string, unknown> | null };
const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const user = (name: string) => h.boot.users.find((u) => u.name === name)!;
const staff = (name: string) => ({ kind: 'user' as const, id: user(name).id });
async function newOrder(items: { name: string; qty?: number }[]) {
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1 })) });
}
async function audits() {
  return h.ok<Audit[]>('patron', 'GET', '/admin/audit?severity=tum&limit=300');
}
const today = async () => (await h.ok<{ day: { id: string; date: string } }>('patron', 'GET', '/cash/day')).day;

let customerId = '';
let ayseOrder: OrderDTO;

describe('ortak kurallar', () => {
  it('neden önerisi: personelde "Personel yemeği", patronda "Patron hesabı", müşteride yok', () => {
    expect(odenmezSuggestion('user', 'garson')).toBe('Personel yemeği');
    expect(odenmezSuggestion('user', 'mudur')).toBe('Personel yemeği');
    expect(odenmezSuggestion('user', 'patron')).toBe('Patron hesabı');
    expect(odenmezSuggestion('customer', null)).toBeNull();
  });

  it('telefonun son dört hanesi; kişi bazında toplam ve gizleme', () => {
    expect(phoneTail('0530 000 11 22')).toBe('1122');
    expect(phoneTail('123')).toBeNull();
    expect(phoneTail(null)).toBeNull();
    const items = [
      { qty: 2, unitPrice: 1000, compPersonKind: 'user' as const, compPersonId: 'u1', compPersonName: 'Garson' },
      { qty: 1, unitPrice: 500, compPersonKind: 'user' as const, compPersonId: 'u2', compPersonName: 'Müdür' },
      { qty: 1, unitPrice: 3000, compPersonKind: 'customer' as const, compPersonId: 'c1', compPersonName: 'Ayşe' },
      { qty: 1, unitPrice: 700, compPersonKind: null, compPersonId: null, compPersonName: null },
    ];
    const all = odenmezByPerson(items);
    expect(all.map((r) => [r.name, r.qty, r.amount])).toEqual([
      ['Ayşe', 1, 3000],
      ['Garson', 2, 2000],
      ['Kişi seçilmemiş', 1, 700],
      ['Müdür', 1, 500],
    ]);
    // Yalnız kendi personel satırını gören: öteki personel tek "Personel" satırında
    const masked = odenmezByPerson(items, (id) => id === 'u1');
    expect(masked.map((r) => [r.name, r.id, r.amount])).toEqual([
      ['Ayşe', 'c1', 3000],
      ['Garson', 'u1', 2000],
      ['Kişi seçilmemiş', null, 700],
      ['Personel', null, 500],
    ]);
    const z: OdenmezPersonDTO[] = all;
    expect(maskOdenmezPeople(z, () => false).map((r) => [r.name, r.amount])).toEqual([
      ['Ayşe', 3000],
      ['Personel', 2500],
      ['Kişi seçilmemiş', 700],
    ]);
  });
});

describe('adisyonun tamamı ödenmez', () => {
  it('kişisiz ödenmez, ikram ve zayide kişi reddedilir; kişi var ve etkin olmalı', async () => {
    const o = await newOrder([{ name: 'Latte' }]);
    const none = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği' });
    expect([none.status, none.json.code]).toEqual([400, 'person_required']);
    for (const kind of ['ikram', 'zayi'] as const) {
      const r = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind, reason: 'Deneme', person: staff('Garson') });
      expect([r.status, r.json.code]).toEqual([400, 'person_not_allowed']);
    }
    const ghost = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: { kind: 'user', id: 'yok' } });
    expect(ghost.status).toBe(404);
    const noCustomer = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Deneme', person: { kind: 'customer', id: 'yok' } });
    expect(noCustomer.status).toBe(404);
    // Kapalı hesap: etkin değil
    const bar = user('Bar ekranı');
    await h.ok('patron', 'PATCH', `/admin/users/${bar.id}`, { active: false });
    const inactive = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: staff('Bar ekranı') });
    expect([inactive.status, inactive.json.code]).toEqual([409, 'person_inactive']);
    await h.ok('patron', 'PATCH', `/admin/users/${bar.id}`, { active: true });
    // Hiçbir şey yazılmadı
    expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).status).toBe('acik');
  });

  it('personele yazılır: adisyon ve kalemlerde tür, kimlik, ad; denetim kişiyi adlandırır', async () => {
    const o = await newOrder([{ name: 'Latte', qty: 2 }, { name: 'Türk Kahvesi' }]);
    const closed = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Personel yemeği', person: staff('Garson'), approverPin: PINS.mudur });
    const garson = { kind: 'user', id: user('Garson').id, name: 'Garson' };
    // Kasiyer maliyet yetkisi görmez: kapanmış adisyonda başkasının personel ödenmezi adsız
    expect(closed.compPerson).toEqual({ kind: 'user', id: '', name: 'Personel' });
    const full = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(full.status).toBe('kapali');
    expect(full.compPerson).toEqual(garson);
    expect(full.items.every((i) => i.compKind === 'odenmez' && i.compReason === 'Personel yemeği')).toBe(true);
    expect(full.items.every((i) => JSON.stringify(i.compPerson) === JSON.stringify(garson))).toBe(true);
    // Garson kendi adına yazılanı görür
    expect((await h.ok<OrderDTO>('garson', 'GET', `/orders/${o.id}`)).compPerson).toEqual(garson);
    const a = (await audits()).find((x) => x.action === 'order.odenmez' && x.orderId === o.id)!;
    expect(a.message).toMatch(/ödenmez kapattı: Garson adına \(personel\)/);
    expect(a.data).toMatchObject({ kind: 'odenmez', person: { kind: 'user', id: user('Garson').id, name: 'Garson' } });
  });
});

describe('tek kalem ödenmez', () => {
  it('müşteriye yazılır; ad o anın kopyası (müşterinin adı sonradan değişse de kalır); geri alma temizler', async () => {
    const c = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Ayşe Yılmaz', phone: '0530 000 11 22' });
    customerId = c.id;
    let o = await newOrder([{ name: 'Latte', qty: 3 }]);
    const item = o.items[0];
    const r = await h.call<{ code: string }>('mudur', 'POST', `/orders/${o.id}/items/${item.id}/comp`, { qty: 1, kind: 'odenmez', reason: 'Müşteri şikâyeti' });
    expect([r.status, r.json.code]).toEqual([400, 'person_required']);
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${item.id}/comp`, { qty: 1, kind: 'odenmez', reason: 'Müşteri şikâyeti', person: { kind: 'customer', id: c.id } });
    const comped = o.items.find((i) => i.complimentary)!;
    expect(comped).toMatchObject({ qty: 1, compKind: 'odenmez', compPerson: { kind: 'customer', id: c.id, name: 'Ayşe Yılmaz' } });
    // Kalemin kalanı ödenmez değil, kişisi yok; adisyonun kişisi yalnız tamamı kapanınca
    expect(o.items.find((i) => !i.complimentary)!.compPerson).toBeNull();
    expect(o.compPerson).toBeNull();
    const a = (await audits()).find((x) => x.action === 'item.odenmez' && x.orderId === o.id)!;
    expect(a.message).toMatch(/1× Latte ödenmez yazdı: Ayşe Yılmaz adına \(müşteri\)/);

    await h.ok('patron', 'PATCH', `/customers/${c.id}`, { name: 'Ayşe Kaya' });
    expect((await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`)).items.find((i) => i.complimentary)!.compPerson?.name).toBe('Ayşe Yılmaz');

    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${comped.id}/comp`, { undo: true, reason: '' });
    expect(o.items.every((i) => !i.complimentary && i.compPerson === null)).toBe(true);
    const undo = (await audits()).find((x) => x.action === 'item.uncomp' && x.orderId === o.id)!;
    expect(undo.message).toMatch(/ödenmez kaydını geri aldı \(Ayşe Yılmaz adına \(müşteri\)\)/);
    // Denetim kaydı etiketi türden: "Ödenmezi geri alma" (AuditAdmin UNCOMP_LABEL)
    expect((undo as unknown as { data: { kind: string } }).data.kind).toBe('odenmez');

    // Yeniden yazılır ve ödenir: kapanmış adisyon raporlara girer
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${o.items[0].id}/comp`, { qty: 1, kind: 'odenmez', reason: 'Müşteri şikâyeti', person: { kind: 'customer', id: c.id } });
    const nakit = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: nakit.id, amount: o.total - o.paid });
    ayseOrder = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(ayseOrder.status).toBe('kapali');
  });

  it('tamamı ödenmez kapanan adisyonda kalem geri alınınca adisyonun kişisi de silinir (ödenmez kalem kalmadıysa)', async () => {
    const o = await newOrder([{ name: 'Americano' }]);
    await h.ok('mudur', 'POST', `/orders/${o.id}/comp`, { kind: 'odenmez', reason: 'Patron hesabı', person: staff('Patron') });
    await h.ok('mudur', 'POST', `/orders/${o.id}/reopen`, { reason: 'Yanlış kapandı', approverPin: PINS.mudur });
    const reopened = await h.ok<OrderDTO>('mudur', 'GET', `/orders/${o.id}`);
    expect(reopened.compPerson?.name).toBe('Patron');
    const after = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${reopened.items[0].id}/comp`, { undo: true, reason: '' });
    expect(after.compPerson).toBeNull();
    await h.ok('mudur', 'POST', `/orders/${o.id}/cancel`, { reason: 'Deneme', approverPin: PINS.mudur });
  });
});

describe('raporlar kişi kişi', () => {
  it('ikram listesinde ödenmez satırı kişiyi taşır; kişi bazında özet (kişi, adet, tutar)', async () => {
    const { date } = await today();
    const list = await h.ok<{ rows: { compKind: string | null; person: { kind: string; name: string } | null; qty: number; value: number }[]; odenmezPeople: OdenmezPersonDTO[] }>(
      'patron',
      'GET',
      `/reports/items?kind=ikram&from=${date}&to=${date}`,
    );
    const odenmez = list.rows.filter((r) => r.compKind === 'odenmez');
    expect(odenmez.every((r) => r.person)).toBe(true);
    expect(odenmez.some((r) => r.person?.name === 'Garson' && r.person.kind === 'user')).toBe(true);
    // Müşterinin adı yazıldığı anın kopyası: yeniden yazılan ödenmez yeni adı (Ayşe Kaya) taşır
    expect(odenmez.some((r) => r.person?.name === 'Ayşe Kaya' && r.person.kind === 'customer')).toBe(true);
    const byName = Object.fromEntries(list.odenmezPeople.map((p) => [p.name, p]));
    expect(byName.Garson).toMatchObject({ kind: 'user', id: user('Garson').id, qty: 3 });
    expect(byName['Ayşe Kaya']).toMatchObject({ kind: 'customer', id: customerId, qty: 1 });
    // Özet listedeki ödenmez satırlarıyla aynı toplam
    expect(list.odenmezPeople.reduce((a, p) => a + p.amount, 0)).toBe(odenmez.reduce((a, r) => a + r.value, 0));
  });

  it('maliyet yetkisi olmayan rapor görene personel adı gitmez ("Personel"), müşteri adı gider', async () => {
    const { updateSettings } = await import('../server/lib/settings');
    const { ROLE_DEFAULTS } = await import('@shared/permissions');
    updateSettings({ rolePermissions: { kasiyer: [...ROLE_DEFAULTS.kasiyer, 'rapor.gor', 'kasa.rakam'] } });
    await h.login('kasa', PINS.kasa);
    const { date, id } = await today();
    const list = await h.ok<{ rows: { compKind: string | null; person: { name: string } | null }[]; odenmezPeople: OdenmezPersonDTO[] }>('kasa', 'GET', `/reports/items?kind=ikram&from=${date}&to=${date}`);
    const names = list.rows.filter((r) => r.compKind === 'odenmez').map((r) => r.person?.name);
    expect(names).not.toContain('Garson');
    expect(names).toContain('Personel');
    expect(names).toContain('Ayşe Kaya');
    expect(list.odenmezPeople.map((p) => p.name)).toEqual(expect.arrayContaining(['Personel', 'Ayşe Kaya']));
    expect(list.odenmezPeople.some((p) => p.name === 'Garson')).toBe(false);
    const csv = await h.call<string>('kasa', 'GET', `/reports/export.csv?type=ikram&from=${date}&to=${date}`);
    expect(csv.json).not.toContain('Garson (personel)');
    // Ara rapor (X) da aynı: personel satırları tek "Personel"
    const x = await h.ok<{ summary: ZSummary | null }>('kasa', 'GET', '/cash/day');
    expect(x.summary?.odenmezPeople?.some((p) => p.name === 'Garson')).toBe(false);
    expect(x.summary?.odenmezPeople?.some((p) => p.name === 'Personel')).toBe(true);
    updateSettings({ rolePermissions: {} });
    await h.login('kasa', PINS.kasa);
    expect(id).toBeTruthy();
  });

  it('personel raporu çalışanın adına yazılan ödenmezi gösterir; CSV\'de Kişi sütunu', async () => {
    const { date } = await today();
    const rep = await h.ok<{ staff: { name: string; odenmez: number; odenmezValue: number }[] }>('patron', 'GET', `/reports/staff?from=${date}&to=${date}`);
    const g = rep.staff.find((r) => r.name === 'Garson')!;
    expect(g.odenmez).toBe(3);
    expect(g.odenmezValue).toBeGreaterThan(0);
    const csv = await h.call<string>('patron', 'GET', `/reports/export.csv?type=ikram&from=${date}&to=${date}`);
    expect(csv.json.split('\n')[0]).toMatch(/Tür;Kişi;Neden/);
    expect(csv.json).toContain('Garson (personel)');
    expect(csv.json).toContain('Ayşe Kaya (müşteri)');
  });

  it('Z ödenmez dökümü kişiyle', async () => {
    const x = await h.ok<{ summary: ZSummary }>('patron', 'GET', '/cash/day');
    const people = x.summary.odenmezPeople ?? [];
    expect(people.find((p) => p.name === 'Garson')).toMatchObject({ kind: 'user', qty: 3 });
    expect(people.find((p) => p.name === 'Ayşe Kaya')).toMatchObject({ kind: 'customer', qty: 1 });
    expect(people.reduce((a, p) => a + p.amount, 0)).toBe(x.summary.odenmez);
    // Z ekranı dökümü gösterir
    const view = readFileSync(new URL('../src/pages/cash/ZView.tsx', import.meta.url), 'utf8');
    expect(view).toMatch(/summary\.odenmezPeople/);
  });
});

describe('kişi bilgisi dışarı gitmez', () => {
  it('lafmaliyet gün paketi kişiyi taşımaz', async () => {
    const { id } = await today();
    const { buildDayPayload } = await import('../server/sync/lafmaliyet');
    const payload = JSON.stringify(buildDayPayload(id));
    expect(payload).toContain('Ödenmez: Personel yemeği');
    expect(payload).not.toContain('Ayşe');
    expect(payload).not.toContain('Garson');
    expect(payload).not.toContain(customerId);
  });

  it('müşteri ekranına giden satırlar kişiyi taşımaz', async () => {
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    const state = displayOrder(boot, ayseOrder, [], 'Tezgâh');
    expect(JSON.stringify(state)).not.toContain('Ayşe');
  });

  it('LafPOS Uzaktan özetinde yalnız ilk ad, kimlik yok', async () => {
    const o = await newOrder([{ name: 'Latte', qty: 2 }]);
    await h.ok('mudur', 'POST', `/orders/${o.id}/items/${o.items[0].id}/comp`, { qty: 1, kind: 'odenmez', reason: 'Müşteri şikâyeti', person: { kind: 'customer', id: customerId } });
    const { buildSnapshot } = await import('../server/sync/cloud');
    const snap = JSON.stringify(buildSnapshot());
    // Ne açık adisyondaki kişi ne de patron uyarısındaki denetim iletisi soyadı taşır
    expect(snap).not.toContain('Yılmaz');
    expect(snap).not.toContain('Kaya');
    expect(snap).toContain('Ayşe adına');
    expect(snap).not.toContain(customerId);
  });
});

describe('denetim kaydında ciro dışı etiketleri', () => {
  it("sunucunun yazdığı her ciro dışı kodunun adı var; geri alma kaydın türünden (ikram, ödenmez, zayi)", () => {
    const audit = readFileSync(new URL('../src/pages/admin/AuditAdmin.tsx', import.meta.url), 'utf8');
    const orders = readFileSync(new URL('../server/services/orders.ts', import.meta.url), 'utf8');
    // Kod üçlü ifadeyle kurulur ("grep action: '" bulmaz): kalem ve adisyon için her tür
    expect(orders).toContain("action: kind === 'zayi' ? 'item.zayi' : kind === 'odenmez' ? 'item.odenmez' : 'item.comp',");
    expect(orders).toContain("action: input.kind === 'ikram' ? 'order.comp' : `order.${input.kind}`,");
    for (const code of ['item.comp', 'item.odenmez', 'item.zayi', 'item.uncomp', 'order.comp', 'order.odenmez', 'order.zayi']) expect(audit, code).toContain(`'${code}': '`);
    expect(audit).toContain("const UNCOMP_LABEL: Record<string, string> = { ikram: 'İkramı geri alma', odenmez: 'Ödenmezi geri alma', zayi: 'Zayiyi geri alma' };");
  });
});
