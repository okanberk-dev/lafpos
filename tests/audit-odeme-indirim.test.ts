import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { amountForItems, itemPayLines } from '@shared/order-calc';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Denetim bulguları (26 Eki 2026): ödeme, indirim, iptal onayı, bahşiş, kalem bazlı ödeme ve girdi doğrulama.
 * Her bulgu bir testle; test düzeltmeden önce kırılır, sonra geçer.
 */
let h: Harness;
const MUDUR = PINS.mudur;
let tableNo = 0;

beforeAll(async () => {
  h = await startApp();
  await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true }); // bahşiş testleri: ayar açık kurulum ve eski veri
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  // Türk Kahvesi sitenin kalemi (130 TL); beklenen tutarlar 140 TL'ye göre yazıldı, site fiyatı değişse de bozulmasın
  await h.pinPrice('Türk Kahvesi', 14000);
});
afterAll(() => h.cleanup());

type Line = { name: string; qty?: number; size?: 'M' | 'L' };
type Audit = { action: string; severity: string; amount: number | null; orderId: string | null; message: string; approverName: string | null; data: Record<string, unknown> | null };

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const lines = (items: Line[]) => items.map((i) => ({ productId: product(i.name).id, qty: i.qty ?? 1, ...(i.size ? { size: i.size } : {}) }));
const getOrder = (id: string) => h.ok<OrderDTO>('patron', 'GET', `/orders/${id}`);
const audits = async (orderId: string, action: string) => (await h.ok<Audit[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.orderId === orderId && a.action === action);

/** Boş bir masada adisyon açıp kalemleri ekler */
async function tableOrder(who: string, items: Line[]) {
  const table = h.boot.tables.filter((t) => t.kind !== 'oda')[tableNo++]!;
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'masa', tableId: table.id });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: lines(items) });
}

async function counterOrder(who: string, items: Line[], extra: Record<string, unknown> = {}) {
  const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'tezgah', ...extra });
  return h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: lines(items) });
}

describe('indirim', () => {
  it('auth-53: indirim sınırı toplam etkiye uygulanır; %10 sınırlı kişi kalem ve adisyon indirimini üst üste koyup %19 yapamaz', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'İndirimci', role: 'kasiyer', permGrant: ['siparis.indirim'], maxDiscountPct: 10, pin: '4242' });
    await h.login('ind', '4242');

    // Tek indirimde sınır zaten vardı: %19 onay ister
    let o = await counterOrder('ind', [{ name: 'Türk Kahvesi' }]);
    expect((await h.call<{ code: string }>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 19, reason: 'Personel' })).json.code).toBe('approval_required');

    // Kaleme %10 kendi sınırında; üstüne adisyona %10 toplamda %19 eder: yetkili onayı ister
    o = await h.ok<OrderDTO>('ind', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    const stacked = await h.call<{ code: string }>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    expect(stacked.status).toBe(403);
    expect(stacked.json.code).toBe('approval_required');
    expect((await getOrder(o.id)).totals.orderDiscount).toBe(0);
    // Müdür onaylar; denetim kaydı adisyondaki toplam oranı yazar
    o = await h.ok<OrderDTO>('ind', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Personel', approverPin: MUDUR });
    expect(o.total).toBe(11340);
    const [rec] = await audits(o.id, 'order.discount');
    expect(rec).toMatchObject({ approverName: 'Müdür' });
    expect(rec!.message).toContain('toplam %19');

    // Ters sıra da aynı: önce adisyona %10, sonra kaleme %10
    let p = await counterOrder('ind', [{ name: 'Türk Kahvesi' }]);
    p = await h.ok<OrderDTO>('ind', 'POST', `/orders/${p.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    const lineOnTop = await h.call<{ code: string }>('ind', 'POST', `/orders/${p.id}/items/${p.items[0]!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    expect(lineOnTop.status).toBe(403);
    expect(lineOnTop.json.code).toBe('approval_required');

    // Sınırın içinde kalan birleşim onaysız geçer: kaleme %5, adisyona %4 (toplam %8,8)
    let q = await counterOrder('ind', [{ name: 'Türk Kahvesi' }]);
    q = await h.ok<OrderDTO>('ind', 'POST', `/orders/${q.id}/items/${q.items[0]!.id}/discount`, { type: 'percent', value: 5, reason: 'Personel' });
    q = await h.ok<OrderDTO>('ind', 'POST', `/orders/${q.id}/discount`, { type: 'percent', value: 4, reason: 'Personel' });
    expect(q.totals.lineDiscounts + q.totals.orderDiscount).toBe(700 + 532);
  });

  it('money-12: indirimli adisyona başka adisyon birleşir ya da kalem taşınırsa indirim büyür; yetkili onayı ister ve denetime yazılır', async () => {
    // Hedef: 1 kahve, müdür onaylı %50; kaynak: 10 kahvelik başka masa
    let target = await tableOrder('garson', [{ name: 'Türk Kahvesi' }]);
    target = await h.ok<OrderDTO>('garson', 'POST', `/orders/${target.id}/discount`, { type: 'percent', value: 50, reason: 'Personel', approverPin: MUDUR });
    const source = await tableOrder('garson', [{ name: 'Türk Kahvesi', qty: 10 }]);
    expect([target.total, source.total]).toEqual([7000, 140000]);

    // Garsonun indirim yetkisi yok: birleştirme indirimi 10 kahveye yayacağı için onay ister, hiçbir şey değişmez
    const denied = await h.call<{ code: string; permission: string }>('garson', 'POST', `/orders/${target.id}/merge`, { sourceOrderId: source.id });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'approval_required', permission: 'siparis.indirim' });
    expect((await getOrder(source.id)).status).toBe('acik');
    expect((await getOrder(target.id)).total).toBe(7000);

    // Müdür PIN'iyle birleşir; büyüyen indirim (70.000 kuruş) onaylayanla denetime yazılır
    const merged = await h.ok<OrderDTO>('garson', 'POST', `/orders/${target.id}/merge`, { sourceOrderId: source.id, approverPin: MUDUR });
    expect(merged.total).toBe(77000);
    const grown = (await audits(target.id, 'order.discount')).find((a) => a.amount === 70000);
    expect(grown).toMatchObject({ approverName: 'Müdür', severity: 'uyari' });

    // Kalem taşıma: indirimli adisyona 6 kahve taşımak da onay ister
    const other = await tableOrder('garson', [{ name: 'Türk Kahvesi', qty: 6 }]);
    const body = { items: [{ itemId: other.items[0]!.id, qty: 6 }], targetOrderId: target.id };
    const moveDenied = await h.call<{ code: string }>('garson', 'POST', `/orders/${other.id}/transfer`, body);
    expect(moveDenied.status).toBe(403);
    expect(moveDenied.json.code).toBe('approval_required');
    expect((await getOrder(other.id)).total).toBe(84000);
    const moved = await h.ok<{ source: OrderDTO; target: OrderDTO }>('garson', 'POST', `/orders/${other.id}/transfer`, { ...body, approverPin: MUDUR });
    expect(moved.target.total).toBe(77000 + 42000);
    expect((await audits(target.id, 'order.discount')).some((a) => a.amount === 42000)).toBe(true);

    // İndirimsiz adisyonlar arasında birleştirme ve taşıma eskisi gibi onaysız
    const a = await tableOrder('garson', [{ name: 'Türk Kahvesi' }]);
    const b = await tableOrder('garson', [{ name: 'Türk Kahvesi', qty: 2 }]);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${a.id}/merge`, { sourceOrderId: b.id })).total).toBe(42000);
    const c = await tableOrder('garson', [{ name: 'Türk Kahvesi', qty: 2 }]);
    const split = await h.ok<{ target: OrderDTO }>('garson', 'POST', `/orders/${c.id}/transfer`, { items: [{ itemId: c.items[0]!.id, qty: 1 }] });
    expect(split.target.total).toBe(14000);

    // Aynı oranlı iki indirimli masa birleşince yüzdenin yuvarlaması (1 kuruş) onay istetmez
    const discounted = async (o: OrderDTO) => {
      await h.ok('garson', 'POST', `/orders/${o.id}/items/${o.items[0]!.id}/discount`, { type: 'amount', value: 6, reason: 'Yuvarlama', approverPin: MUDUR });
      return h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 10, reason: 'Öğrenci', approverPin: MUDUR });
    };
    const d = await discounted(await tableOrder('garson', [{ name: 'Türk Kahvesi' }]));
    const e = await discounted(await tableOrder('garson', [{ name: 'Türk Kahvesi' }]));
    expect(d.totals.orderDiscount + e.totals.orderDiscount).toBe(2798);
    expect((await h.ok<OrderDTO>('garson', 'POST', `/orders/${d.id}/merge`, { sourceOrderId: e.id })).totals.orderDiscount).toBe(2799);
  });

  it('auth-53 (gözden geçirme): indirimden sonra dolgu kalem iptal, ikram ya da taşımayla çıkarılınca etkin indirim sınırı aşamaz', async () => {
    // %10 sınırlı kasiyer: 1 gerçek + 9 dolgu latte (19.500 kuruş), indirim sınırın içinde verilir
    await h.ok('patron', 'POST', '/admin/users', { name: 'Sınırlı', role: 'kasiyer', permGrant: ['siparis.indirim'], maxDiscountPct: 10, pin: '5151' });
    await h.login('sinirli', '5151');
    const pct = (o: OrderDTO) => Math.round(((o.totals.lineDiscounts + o.totals.orderDiscount) * 10000) / o.totals.gross) / 100;
    const padded = (who = 'sinirli') => counterOrder(who, [{ name: 'Latte', size: 'M' }, { name: 'Latte', size: 'M', qty: 9 }]);
    const unchanged = async (id: string, total: number) => {
      const now = await getOrder(id);
      expect(now.items.filter((i) => !i.voided && !i.complimentary)).toHaveLength(2);
      expect(now.total).toBe(total);
    };

    // Tutar indirimi %10 (19.500); 9 latte "yanlış giriş" diye iptal edilince 1 latte bedava kapanırdı
    let o = await padded();
    const pad = o.items[1]!;
    o = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 19500, reason: 'Personel' });
    expect(pct(o)).toBe(10);
    const voidPath = `/orders/${o.id}/items/${pad.id}/void`;
    const denied = await h.call<{ code: string; permission: string }>('sinirli', 'POST', voidPath, { reason: 'Yanlış giriş' });
    expect(denied.status).toBe(403);
    expect(denied.json).toMatchObject({ code: 'approval_required', permission: 'siparis.indirim' });
    await unchanged(o.id, 175500);
    expect((await h.call<{ code: string }>('sinirli', 'POST', `/orders/${o.id}/close`)).json.code).toBe('due');
    // Müdür onaylarsa iptal olur; büyüyen indirim (17.550 kuruş, %100) onaylayanla denetime yazılır
    o = await h.ok<OrderDTO>('sinirli', 'POST', voidPath, { reason: 'Yanlış giriş', approverPin: MUDUR });
    expect(o.total).toBe(0);
    const grown = (await audits(o.id, 'order.discount')).find((a) => a.amount === 17550);
    expect(grown).toMatchObject({ approverName: 'Müdür', severity: 'uyari' });
    expect(grown!.message).toContain('%100');

    // Yüzde yığma: kaleme %10 + adisyona %9 (toplam %9,91); dolgu iptal edilince gerçek kalemde %18,1 olurdu
    let p = await padded();
    p = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${p.id}/items/${p.items[0]!.id}/discount`, { type: 'percent', value: 10, reason: 'Personel' });
    p = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${p.id}/discount`, { type: 'percent', value: 9, reason: 'Personel' });
    expect(pct(p)).toBe(9.91);
    const stacked = await h.call<{ code: string }>('sinirli', 'POST', `/orders/${p.id}/items/${p.items[1]!.id}/void`, { reason: 'Yanlış giriş' });
    expect(stacked.status).toBe(403);
    expect(stacked.json.code).toBe('approval_required');
    await unchanged(p.id, p.total);

    // Dolguyu ikram etmek ya da başka adisyona taşımak da aynı: onay ister, hiçbir şey değişmez
    let q = await padded();
    q = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${q.id}/discount`, { type: 'amount', value: 19500, reason: 'Personel' });
    const comp = await h.call<{ code: string; permission: string }>('sinirli', 'POST', `/orders/${q.id}/items/${q.items[1]!.id}/comp`, { reason: 'Misafir' });
    expect(comp.status).toBe(403);
    expect(comp.json).toMatchObject({ code: 'approval_required', permission: 'siparis.indirim' });
    const move = await h.call<{ code: string }>('sinirli', 'POST', `/orders/${q.id}/transfer`, { items: [{ itemId: q.items[1]!.id, qty: 9 }] });
    expect(move.status).toBe(403);
    expect(move.json.code).toBe('approval_required');
    await unchanged(q.id, 175500);

    // Sınırın içinde kalan büyüme onaysız geçer ama denetime yazılır: %5 tutar indirimi, 1 latte iptal → %5,56
    let r = await padded();
    r = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${r.id}/discount`, { type: 'amount', value: 9750, reason: 'Personel' });
    r = await h.ok<OrderDTO>('sinirli', 'POST', `/orders/${r.id}/items/${r.items[1]!.id}/void`, { qty: 1, reason: 'Yanlış giriş' });
    expect(pct(r)).toBe(5.56);
    expect((await audits(r.id, 'order.discount')).find((a) => a.amount === 975)).toMatchObject({ approverName: null, severity: 'info' });

    // Yüzde adisyon indirimi küçülmede oranını korur: indirim yetkisi olmayan kasiyer dolguyu onaysız iptal eder
    let s = await padded('kasa');
    s = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${s.id}/discount`, { type: 'percent', value: 10, reason: 'Öğrenci', approverPin: MUDUR });
    s = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${s.id}/items/${s.items[1]!.id}/void`, { reason: 'Yanlış giriş' });
    expect([s.total, pct(s)]).toEqual([17550, 10]);
    expect(await audits(s.id, 'order.discount')).toHaveLength(1);
  });
});

describe('iptal onayı', () => {
  it('state-05, auth-55: bar hazırlamaya başladığı kalemi garson "yeni"ye geri alıp onaysız iptal edemez', async () => {
    const o = await tableOrder('garson', [{ name: 'Latte', size: 'M' }]);
    const item = o.items[0]!;
    const voidPath = `/orders/${o.id}/items/${item.id}/void`;
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [item.id], status: 'hazirlaniyor' });
    expect((await h.call<{ code: string }>('garson', 'POST', voidPath, { reason: 'Vazgeçti' })).json.code).toBe('approval_required');

    // Başlamış kalem bekleyene ("yeni") çevrilemez: başlama zamanı silinip iptal "yanlış giriş" sayılırdı
    for (const who of ['garson', 'bar']) {
      expect((await h.call(who, 'POST', '/kitchen/status', { itemIds: [item.id], status: 'yeni' })).status, who).toBe(422);
    }
    expect((await getOrder(o.id)).items[0]).toMatchObject({ status: 'hazirlaniyor' });
    expect((await h.call<{ code: string }>('garson', 'POST', voidPath, { reason: 'Vazgeçti' })).json.code).toBe('approval_required');
    expect((await h.call<{ code: string }>('garson', 'POST', `/orders/${o.id}/cancel`, { reason: 'Vazgeçti' })).json.code).toBe('approval_required');

    // Bardaki "Geri al" (hazır → hazırlanıyor) başlama zamanını korur: onaylı iptal hazırlandıktan sonra sayılır, uyarı yazar
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [item.id], status: 'hazir' });
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: [item.id], status: 'hazirlaniyor' });
    expect((await h.call<{ code: string }>('garson', 'POST', voidPath, { reason: 'Vazgeçti' })).json.code).toBe('approval_required');
    const voided = await h.ok<OrderDTO>('garson', 'POST', voidPath, { reason: 'Vazgeçti', approverPin: MUDUR });
    expect(voided.items.find((i) => i.id === item.id)).toMatchObject({ voided: true, voidAfterSend: true });
    expect((await audits(o.id, 'item.void'))[0]).toMatchObject({ severity: 'uyari', approverName: 'Müdür', data: { afterSend: true, fresh: false } });
  });
});

type PayResult = { order: OrderDTO; closed: boolean; change: number; amount: number; share: { no: number; of: number } | null };

describe('bahşiş', () => {
  it('money-16, reports-36: açık hesap ödemesine bahşiş yazılmaz; raporda alınmamış bahşiş görünmez', async () => {
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Ahmet Bey' });
    const o = await counterOrder('kasa', [{ name: 'Türk Kahvesi' }], { customerId: cust.id });
    const cari = h.boot.paymentMethods.find((m) => m.kind === 'cari')!;
    const tipped = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cari.id, amount: o.total, tip: 2000, customerId: cust.id });
    expect(tipped.status).toBe(400);
    expect(tipped.json.code).toBe('tip_on_account');
    expect((await getOrder(o.id)).payments).toHaveLength(0);
    const tipsBefore = (await h.ok<{ summary: { tips: number } }>('patron', 'GET', '/cash/day')).summary.tips;

    // Bahşişsiz açık hesap eskisi gibi; müşterinin borcu tutar kadar, raporda bahşiş artmaz
    expect((await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cari.id, amount: o.total, customerId: cust.id })).closed).toBe(true);
    expect((await getOrder(o.id)).customer).toMatchObject({ balance: o.total });
    expect((await h.ok<{ summary: { tips: number } }>('patron', 'GET', '/cash/day')).summary.tips).toBe(tipsBefore);

    // Kart ödemesinde bahşiş eskisi gibi alınır
    const p = await counterOrder('kasa', [{ name: 'Türk Kahvesi' }]);
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: method('Kredi kartı').id, amount: p.total, tip: 2000 });
    expect((await h.ok<{ summary: { tips: number } }>('patron', 'GET', '/cash/day')).summary.tips).toBe(tipsBefore + 2000);
  });
});

describe('ödeme', () => {
  it('state-07: yanıtı kaybolup yeniden gönderilen ödeme isteği iki kez yazılmaz; ilk sonuç döner', async () => {
    // Tutar: iki kahvelik masanın yarısı nakit; aynı istek ikinci kez gelir
    const o = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 2 }]);
    const half = { methodId: method('Nakit').id, amount: 14000, given: 20000, requestId: 'odeme-istegi-0001' };
    expect(await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, half)).toMatchObject({ closed: false, amount: 14000, change: 6000 });
    expect(await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, half)).toMatchObject({ closed: false, amount: 14000, change: 6000 });
    let after = await getOrder(o.id);
    expect(after).toMatchObject({ status: 'acik', paid: 14000 });
    expect(after.payments).toHaveLength(1);

    // Kalem: iki adetlik satırın biri iki kez gönderilir; ikinci adet ödenmiş sayılmaz
    const p = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 2 }]);
    const one = { methodId: method('Kredi kartı').id, amount: 14000, items: [{ itemId: p.items[0]!.id, qty: 1 }], requestId: 'odeme-istegi-0002' };
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, one);
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, one);
    after = await getOrder(p.id);
    expect(after.payments).toHaveLength(1);
    expect(after.items[0]).toMatchObject({ paidQty: 1 });
    expect(after.status).toBe('acik');

    // Yeni istek kalan yarıyı alıp adisyonu kapatır; kapandıktan sonra gelen tekrarı "kapalı" hatası değil ilk sonuçtur
    const rest = { methodId: method('Nakit').id, amount: 14000, requestId: 'odeme-istegi-0003' };
    expect((await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, rest)).closed).toBe(true);
    expect(await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, rest)).toMatchObject({ closed: true, amount: 14000 });
    expect((await getOrder(o.id)).payments).toHaveLength(2);

    // İstek kimliği olmayan eski istemci eskisi gibi çalışır; kimlik biçimi denetlenir
    expect((await h.call('kasa', 'POST', `/orders/${p.id}/payments`, { ...one, requestId: 'kısa' })).status).toBe(422);
    const { requestId: _, ...legacy } = one;
    expect((await h.ok<PayResult>('kasa', 'POST', `/orders/${p.id}/payments`, legacy)).closed).toBe(true);
  });

  it('money-14: kalem bazlı ödemede ekrandaki tutar sunucununkiyle tutmazsa ödeme yazılmaz; kart terminaline girilen tutar kayıtla ayrışmaz', async () => {
    let o = await counterOrder('kasa', [{ name: 'Türk Kahvesi', qty: 2 }]);
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 50, reason: 'Personel', approverPin: MUDUR });
    const item = o.items[0]!;
    // Kasiyerin ekranında bir kahve 70 ₺ (indirimli) ve terminale bu girildi; bu sırada başka cihazda indirim kalkar
    expect(o.totals.lineNet[item.id]).toBe(14000);
    await h.ok('mudur', 'POST', `/orders/${o.id}/discount`, { type: 'percent', value: 0, remove: true });
    const stale = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, amount: 7000, items: [{ itemId: item.id, qty: 1 }] });
    expect(stale.status).toBe(409);
    expect(stale.json.code).toBe('items_changed');
    const after = await getOrder(o.id);
    expect(after.payments).toHaveLength(0);
    expect(after.items[0]).toMatchObject({ paidQty: 0 });

    // Yenilenen ekranın tutarıyla alınır
    const paid = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Kredi kartı').id, amount: 14000, items: [{ itemId: item.id, qty: 1 }] });
    expect(paid).toMatchObject({ amount: 14000, closed: false });
  });

  it('input-68: ikram ya da iptal kalemi kalem bazlı ödemede ödenmiş işaretlenmez; ikramı geri alınan kalem kalemle ödenir', async () => {
    let o = await counterOrder('kasa', [{ name: 'Türk Kahvesi' }, { name: 'Latte', size: 'M' }, { name: 'Türk Kahvesi' }, { name: 'Türk Kahvesi' }]);
    const [comped, latte, voided] = o.items;
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${comped!.id}/comp`, { reason: 'Müdür ikramı' });
    o = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${voided!.id}/void`, { reason: 'Yanlış giriş' });
    const latteNet = o.totals.lineNet[latte!.id]!;
    const card = method('Kredi kartı').id;

    // İkram kalemi ücretli kalemle birlikte seçilir: ücretsiz kalem ödenmiş işaretlenmez, ödeme yazılmaz
    for (const free of [comped!, voided!]) {
      const r = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount: latteNet, items: [{ itemId: free.id, qty: 1 }, { itemId: latte!.id, qty: 1 }] });
      expect(r.status).toBe(409);
      expect(r.json.code).toBe('item_free');
    }
    let after = await getOrder(o.id);
    expect(after.payments).toHaveLength(0);
    expect(after.items.every((i) => i.paidQty === 0)).toBe(true);

    // Latte'yi öder, kahvenin ikramı geri alınır: kahve borçludur ve kalemle ödenir
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount: latteNet, items: [{ itemId: latte!.id, qty: 1 }] });
    after = await h.ok<OrderDTO>('mudur', 'POST', `/orders/${o.id}/items/${comped!.id}/comp`, { undo: true, reason: '' });
    expect(after.total - after.paid).toBe(28000);
    expect(after.items.find((i) => i.id === comped!.id)).toMatchObject({ complimentary: false, paidQty: 0 });
    const paid = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount: 14000, items: [{ itemId: comped!.id, qty: 1 }] });
    expect(paid.order.items.find((i) => i.id === comped!.id)).toMatchObject({ paidQty: 1 });
  });

  it('money-17: önceki adet ödemesi iptal edilip adet yeniden ödenince kuruş kalmaz; bütün kalemler ödenince adisyon kapanır', async () => {
    // 3 kahvelik satır 1 kuruş indirimle 41999 (adet payları 14000, 14000, 13999), tek kahvelik satır 14000
    let o = await tableOrder('garson', [{ name: 'Türk Kahvesi', qty: 3 }]);
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/items`, { items: lines([{ name: 'Türk Kahvesi' }]) });
    o = await h.ok<OrderDTO>('garson', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 1, reason: 'Yuvarlama', approverPin: MUDUR });
    const [a, b] = o.items;
    expect([o.total, o.totals.lineNet[a!.id], o.totals.lineNet[b!.id]]).toEqual([55999, 41999, 14000]);
    const card = method('Kredi kartı').id;
    // Ödeme ekranının hesabı (PaymentModal): sunucu aynı tutarı bekler
    const pay = async (itemId: string, qty: number) => {
      const amount = amountForItems(o.totals, itemPayLines(o.items, o.payments), [{ lineId: itemId, qty }]);
      const r = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount, items: [{ itemId, qty }] });
      o = r.order;
      return r;
    };

    const p1 = await pay(a!.id, 1);
    const p2 = await pay(a!.id, 2);
    expect([p1.amount, p2.amount]).toEqual([14000, 27999]);
    // Ödeme satır tutarını taşır
    expect(o.payments.map((p) => p.items)).toEqual([[{ itemId: a!.id, qty: 1, amount: 14000 }], [{ itemId: a!.id, qty: 2, amount: 27999 }]]);

    // İlk (büyük paylı) ödeme iptal edilir, adet yeniden ödenir: satırın kalanı 14000, 13999 değil
    const first = o.payments.find((p) => p.amount === 14000)!;
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/payments/${first.id}/refund`, { reason: 'Yanlış kart', approverPin: MUDUR });
    expect((await pay(a!.id, 1)).amount).toBe(14000);
    const last = await pay(b!.id, 1);
    expect(last.closed).toBe(true);
    expect(last.order.total - last.order.paid).toBe(0);
  });

  it('money-17: ödenen tutarı bilinmeyen satırda (yazarkasa ya da eski ödeme) adet payları eskisi gibi sırayla sayılır', () => {
    const totals = { lineNet: { a: 41999 } };
    const item = { id: 'a', qty: 3, paidQty: 2 };
    // Tutarlı ödemeler: kalan, net pay eksi ödenen
    expect(amountForItems(totals, itemPayLines([item], [{ items: [{ itemId: 'a', qty: 2, amount: 27999 }] }]), [{ lineId: 'a', qty: 1 }])).toBe(14000);
    // Tutarı yazılmamış ödeme (yazarkasa) ya da adedi tutmayan kayıt: sıradaki pay
    expect(itemPayLines([item], [{ items: [{ itemId: 'a', qty: 2 }] }])[0]!.paidAmount).toBeNull();
    expect(itemPayLines([item], [{ items: [{ itemId: 'a', qty: 1, amount: 14000 }] }])[0]!.paidAmount).toBeNull();
    expect(amountForItems(totals, itemPayLines([item], [{ items: [{ itemId: 'a', qty: 2 }] }]), [{ lineId: 'a', qty: 1 }])).toBe(13999);
    // İptal edilen ödeme sayılmaz
    expect(itemPayLines([{ ...item, paidQty: 1 }], [{ items: [{ itemId: 'a', qty: 1, amount: 14000 }], refundedAt: 1 }, { items: [{ itemId: 'a', qty: 1, amount: 13999 }] }])[0]!.paidAmount).toBe(13999);
  });

  it('state-07 (gözden geçirme): aynı deneme kimliğiyle başka pay ya da tutar gelirse ilk ödeme dönmez; 409 ile ekran yenilenir', async () => {
    const card = method('Kredi kartı').id;
    // Paylaş: pay 1'in yanıtı kayboldu, ekran pay 2'yi gösterir; eski istemci pay 2'yi aynı kimlikle gönderir
    let o = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 3 }]);
    o = await h.ok<OrderDTO>('kasa', 'PUT', `/orders/${o.id}/split`, { people: 3 });
    const requestId = 'paylas-deneme-0001';
    const first = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount: o.split!.shares[0], share: true, shareNo: 1, requestId });
    expect(first.share).toEqual({ no: 1, of: 3 });
    o = await getOrder(o.id);
    const share2 = { methodId: card, amount: o.split!.shares[0], share: true, shareNo: 2 };
    const second = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, { ...share2, requestId });
    expect(second.status).toBe(409);
    expect(second.json.code).toBe('request_reused');
    expect((await getOrder(o.id)).payments).toHaveLength(1);
    // Yenilenen ekranın yeni denemesi pay 2'yi yazar; ilk istek aynen yeniden gelirse eskisi gibi ilk sonuç döner
    expect((await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { ...share2, requestId: 'paylas-deneme-0002' })).share).toEqual({ no: 2, of: 3 });
    const replay = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount: first.amount, share: true, shareNo: 1, requestId });
    expect(replay.share).toEqual({ no: 1, of: 3 });
    expect((await getOrder(o.id)).payments).toHaveLength(2);

    // Kalem: 2 kahvelik satır 1 kuruş indirimle (adet payları 14000 / 13999); ikinci adet aynı seçim ve kimlikle gelir
    let p = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 2 }]);
    p = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${p.id}/items/${p.items[0]!.id}/discount`, { type: 'amount', value: 1, reason: 'Yuvarlama', approverPin: MUDUR });
    const line = p.items[0]!.id;
    await h.ok('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: card, amount: 14000, items: [{ itemId: line, qty: 1 }], requestId: 'kalem-deneme-0001' });
    const unit2 = await h.call<{ code: string }>('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: card, amount: 13999, items: [{ itemId: line, qty: 1 }], requestId: 'kalem-deneme-0001' });
    expect(unit2.status).toBe(409);
    expect(unit2.json.code).toBe('request_reused');
    const after = await getOrder(p.id);
    expect([after.payments.length, after.items[0]!.paidQty, after.total - after.paid]).toEqual([1, 1, 13999]);
    // Başka ödeme türü ya da bahşiş de başka istektir
    for (const changed of [{ methodId: method('Nakit').id }, { tip: 500 }]) {
      const r = await h.call<{ code: string }>('kasa', 'POST', `/orders/${p.id}/payments`, { methodId: card, amount: 14000, items: [{ itemId: line, qty: 1 }], requestId: 'kalem-deneme-0001', ...changed });
      expect(r.json.code).toBe('request_reused');
    }
  });

  it('state-07 (gözden geçirme): iptal edilen ödemenin deneme kimliği yeniden gelirse iptal edilen ödeme başarı diye dönmez', async () => {
    const o = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 2 }]);
    const body = { methodId: method('Kredi kartı').id, amount: 14000, requestId: 'tutar-deneme-0001' };
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, body);
    // Yanıt kayboldu, kart aslında reddedilmişti: ödeme iptal edilir, müşteri başka kartla aynı tutarı öder
    const pay = (await getOrder(o.id)).payments[0]!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments/${pay.id}/refund`, { reason: 'Kart reddedildi', approverPin: MUDUR });
    const again = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/payments`, body);
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('request_refunded');
    expect((await getOrder(o.id)).paid).toBe(0);
    // Yeni deneme kimliğiyle alınır
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { ...body, requestId: 'tutar-deneme-0002' });
    const after = await getOrder(o.id);
    expect([after.paid, after.payments.filter((x) => !x.refundedAt).length]).toEqual([14000, 1]);
  });

  it('state-07 (gözden geçirme): yanıtı kaybolan açık hesap tahsilatı yeniden gelince iki kez yazılmaz; bakiyeden fazlası tahsil edilmez', async () => {
    const cust = await h.ok<{ id: string }>('kasa', 'POST', '/customers', { name: 'Veresiye Bey' });
    const o = await counterOrder('kasa', [{ name: 'Türk Kahvesi' }], { customerId: cust.id });
    const cari = h.boot.paymentMethods.find((m) => m.kind === 'cari')!;
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cari.id, amount: o.total, customerId: cust.id });
    const expectedCash = async () => (await h.ok<{ summary: { expectedCash: number } }>('patron', 'GET', '/cash/day')).summary.expectedCash;
    const detail = () => h.ok<{ customer: { balance: number }; ledger: { kind: string; amount: number }[] }>('kasa', 'GET', `/customers/${cust.id}`);
    const before = await expectedCash();

    // Aynı tahsilat isteği iki kez: bir kez yazılır, ikinci istek ilk sonucu alır
    const body = { customerId: cust.id, methodId: method('Nakit').id, amount: 10000, requestId: 'tahsilat-istegi-0001' };
    expect((await h.call('kasa', 'POST', '/cash/collect', body)).status).toBe(200);
    expect((await h.call('kasa', 'POST', '/cash/collect', body)).status).toBe(200);
    let c = await detail();
    expect(c.customer.balance).toBe(4000);
    expect(c.ledger.filter((l) => l.kind === 'tahsilat').map((l) => l.amount)).toEqual([-10000]);
    expect(await expectedCash()).toBe(before + 10000);

    // Aynı kimlik başka tutarla gelirse eski sonuç dönmez
    const reused = await h.call<{ code: string }>('kasa', 'POST', '/cash/collect', { ...body, amount: 4000 });
    expect(reused.status).toBe(409);
    expect(reused.json.code).toBe('request_reused');

    // Bakiyeden fazlası tahsil edilmez: kimliksiz (eski istemci) tekrar da borç kapanınca durur
    const legacy = { customerId: cust.id, methodId: method('Nakit').id, amount: 4000 };
    expect((await h.call('kasa', 'POST', '/cash/collect', legacy)).status).toBe(200);
    const twice = await h.call<{ code: string }>('kasa', 'POST', '/cash/collect', legacy);
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe('over_balance');
    c = await detail();
    expect(c.customer.balance).toBe(0);
    expect(c.ledger.filter((l) => l.kind === 'tahsilat')).toHaveLength(2);
    expect(await expectedCash()).toBe(before + 14000);
  });

  it('money-17 (gözden geçirme): yazarkasaya kalem seçerek giden sepet de satırın kalanını alır; iptal edilen adet ödemesinden sonra kuruş kalmaz', async () => {
    await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator' });
    try {
      let o = await tableOrder('kasa', [{ name: 'Türk Kahvesi', qty: 3 }]);
      o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: lines([{ name: 'Türk Kahvesi' }]) });
      o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/discount`, { type: 'amount', value: 1, reason: 'Yuvarlama', approverPin: MUDUR });
      const [a, b] = o.items;
      expect([o.total, o.totals.lineNet[a!.id], o.totals.lineNet[b!.id]]).toEqual([55999, 41999, 14000]);
      const card = method('Kredi kartı').id;
      const pay = async (itemId: string, qty: number) => {
        const amount = amountForItems(o.totals, itemPayLines(o.items, o.payments), [{ lineId: itemId, qty }]);
        const r = await h.ok<PayResult>('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: card, amount, items: [{ itemId, qty }] });
        o = r.order;
        return r.amount;
      };
      expect([await pay(a!.id, 1), await pay(a!.id, 2)]).toEqual([14000, 27999]);
      const first = o.payments.find((p) => p.amount === 14000)!;
      o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/payments/${first.id}/refund`, { reason: 'Yanlış kart', approverPin: MUDUR });

      // Ödeme ekranı bu adet için 14000 der; cihaz sepeti de aynı tutarı ister (13999 değil)
      const lafpos = amountForItems(o.totals, itemPayLines(o.items, o.payments), [{ lineId: a!.id, qty: 1 }]);
      const sent = await h.ok<{ receipt: { id: string; amount: number; items: { itemId: string; qty: number; amount?: number }[] } }>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: [{ itemId: a!.id, qty: 1 }] });
      expect([lafpos, sent.receipt.amount]).toEqual([14000, 14000]);
      expect(sent.receipt.items).toEqual([{ itemId: a!.id, qty: 1, amount: 14000 }]);
      await h.ok('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: 3, amount: sent.receipt.amount }] });
      o = await getOrder(o.id);
      // Cihaz ödemesi de satır tutarını taşır: sonraki kalem ödemesi satırın kalanını bilir
      expect(o.payments.find((p) => p.note?.startsWith('Yazarkasa'))!.items).toEqual([{ itemId: a!.id, qty: 1, amount: 14000 }]);
      expect(await pay(b!.id, 1)).toBe(14000);
      o = await getOrder(o.id);
      expect([o.status, o.total - o.paid]).toEqual(['kapali', 0]);
    } finally {
      await h.ok('patron', 'PUT', '/okc/settings', { provider: 'kapali' });
    }
  });
});

describe('girdi doğrulama', () => {
  it('input-73: adetli seçenekte aynı seçim tekrarlanınca seçenek sınırı aşılmaz', async () => {
    const shot = h.boot.optionGroups.find((g) => g.extKey === 'extraShot')!.items[0]!;
    expect(shot.maxQty).toBe(1);
    const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const latte = { productId: product('Latte').id, size: 'M', qty: 1 };
    for (const options of [Array.from({ length: 20 }, () => ({ itemId: shot.id, qty: 1 })), [{ itemId: shot.id }, { itemId: shot.id }]]) {
      const r = await h.call<{ code: string }>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ ...latte, options }] });
      expect(r.status).toBe(400);
      expect(r.json.code).toBe('option_invalid');
    }
    expect((await getOrder(o.id)).items).toHaveLength(0);
    // Tek shot eskisi gibi; seçenek fişte bir kez yazılır
    const one = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ ...latte, options: [{ itemId: shot.id, qty: 1 }] }] });
    expect(one.items[0]!.unitPrice).toBe(product('Latte').price + shot.price);
    expect(one.items[0]!.options.filter((x) => x.itemId === shot.id)).toEqual([expect.objectContaining({ qty: 1 })]);
  });

  it('input-70: olmayan ya da yinelenen kimlik 500 değil 404/422/409 döner', async () => {
    const menu = await h.ok<{ categories: { id: string }[]; optionGroups: { id: string }[] }>('patron', 'GET', '/admin/menu');
    const local = await h.ok<{ id: string }>('patron', 'POST', '/admin/products', { categoryId: menu.categories[0]!.id, name: 'Yerel', price: 1000, kdvRate: 10 });
    const res = await h.ok<{ id: string }>('mudur', 'POST', '/reservations', { date: '2026-10-27', time: '19:00', name: 'X' });
    const g = menu.optionGroups[0]!.id;
    const cases: [string, string, string, unknown, number][] = [
      ['garson', 'POST', '/orders', { type: 'tezgah', customerId: 'YOK' }, 404],
      ['kasa', 'POST', '/orders', { type: 'gelal', customerId: 'YOK' }, 404],
      ['mudur', 'POST', '/customers/YOK/addresses', { address: 'Bağdat cd. 1' }, 422],
      ['garson', 'POST', '/reservations', { date: '2026-10-27', time: '19:00', name: 'X', tableId: 'YOK' }, 422],
      ['garson', 'PATCH', `/reservations/${res.id}`, { tableId: 'YOK' }, 422],
      ['patron', 'POST', '/admin/tables', { sectionId: 'YOK', name: 'T' }, 422],
      ['patron', 'POST', '/admin/categories', { name: 'C', stationId: 'YOK' }, 422],
      ['patron', 'POST', '/admin/products', { categoryId: menu.categories[0]!.id, name: 'X', price: 1, kdvRate: 10, stationId: 'YOK' }, 422],
      ['patron', 'PATCH', `/admin/products/${local.id}`, { categoryId: 'YOK' }, 422],
      ['patron', 'PATCH', `/admin/products/${local.id}`, { stationId: 'YOK' }, 422],
      ['patron', 'PUT', '/admin/products/YOK/groups', { groupIds: [g] }, 422],
      ['patron', 'PUT', `/admin/products/${local.id}/groups`, { groupIds: [g, g] }, 409],
    ];
    for (const [who, m, path, body, status] of cases) {
      const r = await h.call<{ code: string }>(who, m, path, body);
      expect(r.status, `${m} ${path}`).toBe(status);
    }
  });
});
