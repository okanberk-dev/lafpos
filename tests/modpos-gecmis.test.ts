import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { fillHistory, type HistoryDay, type HistoryProducts, historyKey, historyProductsShown, historyReport, mergeHistory, parseHistory, readHistory, readHistoryStore, validProducts } from '@shared/gecmis';
import type { RemoteDayExtra, RemoteDayReport } from '@shared/remote-reports';
import { upstashFetch } from './fake-upstash';

/**
 * Faz 4: ModPOS geçiş günleri (Marina, 13-21 Kasım 2026) LafPOS Uzaktan raporlarında. Geçmiş gün indirimi, ödenmezi, KDV
 * kırılımını ve ModPOS Z numarasını taşır; dönemin ürün listesi (indirim öncesi) ayrı blok. Kasım raporu (13-22, 22'si
 * LafPOS'un kabul günü) sözleşmenin rakamlarını kuruşu kuruşuna verir: indirim 2.156,25, ciro dışı 2.565,00, ciro
 * 33.633,75, KDV hariç 30.576,15, fiş 161 (hesap sözleşmesi §6).
 */

/** ModPOS günleri (kuruş): tarih, ciro, kart, nakit, indirim, ödenmez, fiş, Z */
const MODPOS: [string, number, number, number, number, number, number, string][] = [
  ['2026-11-13', 39000, 19500, 19500, 0, 0, 2, 'Z-2026-002'],
  ['2026-11-14', 331100, 268725, 62375, 24900, 0, 14, 'Z-2026-003'],
  ['2026-11-15', 575300, 414650, 160650, 51700, 19000, 27, 'Z-2026-004'],
  ['2026-11-16', 267000, 214000, 53000, 0, 0, 9, 'Z-2026-005'],
  ['2026-11-17', 164125, 117125, 47000, 15375, 45500, 12, 'Z-2026-006'],
  ['2026-11-18', 241925, 181450, 60475, 31575, 40000, 16, 'Z-2026-007'],
  ['2026-11-19', 253575, 147250, 106325, 20425, 20000, 19, 'Z-2026-008'],
  ['2026-11-20', 400800, 291425, 109375, 39700, 25500, 19, 'Z-2026-009'],
  ['2026-11-21', 462050, 320300, 141750, 22950, 0, 17, 'Z-2026-010'],
];
/** Yükleme biçimi: kart ve nakit [tutar, adet]; ilk günde KDV kırılımı elle verilir, öbürlerinde %10'dan türetilir */
const UPLOAD = MODPOS.map(([date, ciro, kart, nakit, indirim, odenmez, fis, z], i) => {
  const kartAdet = Math.round((fis * kart) / ciro);
  return { date, ciro, adisyon: fis, kart: [kart, kartAdet], nakit: [nakit, fis - kartAdet], indirim, odenmez, z, ...(i === 0 ? { kdv: [[10, 39000, 35455, 3545]] } : {}) };
});
/** Dönemin ürün listesi: 31 satır, 240 adet, 29.415,00 indirim öncesi (= ciro + indirim) */
const URUNLER: HistoryProducts = {
  from: '2026-11-13',
  to: '2026-11-21',
  rows: Array.from({ length: 31 }, (_, i): [string, string, number, number] => [`ÜRÜN ${String(i + 1).padStart(2, '0')}`, i % 2 ? 'L' : 'M', i < 23 ? 8 : 7, i < 30 ? 95000 : 91500]),
};

/** LafPOS'un 22.11 kabul günü (tests/fixtures/kabul-gunu-2026-11-22.json'un Uzaktan özeti) */
const LAFPOS_22: RemoteDayReport = {
  v: 1,
  date: '2026-11-22',
  at: Date.parse('2026-11-23T01:10:00+03:00'),
  n: 1,
  closed: true,
  z: [1],
  s: { list: 744000, gross: 637500, comp: 106500, disc: 9000, svc: 0, rev: 628500, odenmez: 93500, zayi: 0, voided: 239500, receipts: 26, items: 58, tips: 0, guests: 0, tableSales: 0, paidClosed: 628500, paidOpen: 0, onlineOrders: 0, onlineAmount: 0 },
  pay: [
    ['Kredi kartı', 'card', 503000, 20],
    ['Nakit', 'cash', 125500, 6],
  ],
  types: [['tezgah', 26, 628500]],
  kdv: [[10, 628500, 571364, 57136]],
  closes: [[600, 628500, 26]],
  prod: [['latte|M', 'LATTE', 'M', 'Kahve', 6, 57000, 0, 0]],
  hours: [[10, 628500, 26]],
  clock: [[15, 628500]],
  staff: [],
};
const row = (id: string, value: number) => ({ id, at: Date.parse('2026-11-22T14:00:00+03:00'), orderId: id, orderNo: 1, place: 'Tezgah', name: 'LATTE', size: 'M', qty: 1, value, reason: null, compKind: null, person: null, by: 'Kasa', approvedBy: null, afterSend: false, afterBill: false });
const EXTRA_22: RemoteDayExtra = {
  prep: { done: [], hand: [] },
  checks: [],
  lists: { iptal: [], ikram: [row('i1', 13000)], indirim: [row('d1', 5250), row('d2', 3750)], happy: [] },
  odenmez: [],
  refunds: [],
  plat: { rows: [], pending: 0 },
};

const days = () => parseHistory(UPLOAD) as HistoryDay[];

describe('geçmiş ciro: ModPOS gününün yeni alanları', () => {
  it('indirim, ciro dışı, KDV kırılımı ve Z numarası saklanır; sıfırlar ve verilmeyen KDV saklanmaz', () => {
    const d = days();
    expect(typeof d).not.toBe('string');
    expect(d[0]).toMatchObject({ date: '2026-11-13', z: 'Z-2026-002', kdv: [[10, 39000, 35455, 3545]] });
    // Sıfır indirim ve ödenmez saklanmaz (eski günlerin biçimi değişmez)
    expect(d[0]).not.toHaveProperty('indirim');
    expect(d[0]).not.toHaveProperty('odenmez');
    expect(d[2]).toMatchObject({ indirim: 51700, odenmez: 19000, z: 'Z-2026-004' });
    expect(d[2]).not.toHaveProperty('kdv');
  });

  it('gün raporu: brüt = ciro + indirim, ciro dışı = ödenmez, liste = brüt + ciro dışı, KDV %10 ayrıştırılır, kaynak ve Z', () => {
    const r = historyReport(days()[2]!, 'ModPOS');
    expect(r.s).toMatchObject({ rev: 575300, disc: 51700, comp: 19000, odenmez: 19000, gross: 627000, list: 646000, receipts: 27, paidClosed: 575300 });
    expect(r.kdv).toEqual([[10, 575300, 523000, 52300]]);
    expect(r).toMatchObject({ kaynak: 'ModPOS', zText: 'Z-2026-004', z: [] });
    // Eski kayıt (yeni alanlar yok): indirim ve ciro dışı sıfır, KDV yine %10; Z yazılmaz
    const old = historyReport({ date: '2026-11-01', ciro: 11000, adisyon: 1, closes: [], pay: [] });
    expect(old.s).toMatchObject({ rev: 11000, disc: 0, comp: 0, list: 11000 });
    expect(old.kdv).toEqual([[10, 11000, 10000, 1000]]);
    expect(old).not.toHaveProperty('zText');
  });

  it('yarım veri saklanmaz: KDV satırları ciroyu, matrah + KDV dahil tutarı tutmalı; tutarlar tam sayı; Z kısa metin', () => {
    const base = { date: '2026-11-13', ciro: 39000, adisyon: 2 };
    expect(parseHistory([{ ...base, kdv: [[10, 30000, 27273, 2727]] }])).toMatch(/KDV dahil tutarların toplamı/);
    expect(parseHistory([{ ...base, kdv: [[10, 39000, 35455, 3000]] }])).toMatch(/matrah ve KDV toplamı/);
    expect(parseHistory([{ ...base, kdv: [[10, 39000]] }])).toMatch(/\[oran, KDV dahil, matrah, KDV\]/);
    expect(parseHistory([{ ...base, kdv: [[150, 39000, 39000, 0]] }])).toMatch(/oran 0-100/);
    expect(parseHistory([{ ...base, indirim: -1 }])).toMatch(/indirim/);
    expect(parseHistory([{ ...base, odenmez: 1.5 }])).toMatch(/ödenmez/);
    expect(parseHistory([{ ...base, z: 'x'.repeat(41) }])).toMatch(/Z numarası/);
    // Boş Z yazılmaz
    expect((parseHistory([{ ...base, z: '' }]) as HistoryDay[])[0]!.z).toBeUndefined();
  });

  it('dönemin ürün listesi: biçimi denetlenir; rapor bloğu yalnız dönemin hepsini kapsayan aralıkta tam gösterir', () => {
    expect(validProducts(URUNLER)).toEqual(URUNLER);
    expect(validProducts({ ...URUNLER, from: '2026-11-22' })).toBeNull();
    expect(validProducts({ ...URUNLER, rows: [['LATTE', 'M', -1, 100]] })).toBeNull();
    expect(validProducts(null)).toBeNull();
    expect(historyProductsShown(URUNLER, { from: '2026-11-01', to: '2026-11-30' })).toBe('tam');
    expect(historyProductsShown(URUNLER, { from: '2026-11-16', to: '2026-11-22' })).toBe('kismi');
    expect(historyProductsShown(URUNLER, { from: '2026-11-22', to: '2026-11-22' })).toBeNull();
    // Bloğun bir günü raporda LafPOS günüyle değiştiyse (geçmişten gelmedi) blok gösterilmez: o günü iki kez sayardı
    const used = days().filter((d) => d.date !== '2026-11-15').map((d) => ({ date: d.date, kaynak: 'ModPOS' }));
    expect(historyProductsShown(URUNLER, { from: '2026-11-13', to: '2026-11-22' }, days(), used)).toBe('kismi');
  });

  it('saklanan kayıt: kaynak ve ürün listesi okunur; günler eskisi gibi; bozuk ürün bloğu kaydı düşürmez', () => {
    const raw = JSON.stringify({ v: 1, kaynak: 'ModPOS', at: 5, gunler: days(), urunler: URUNLER });
    expect(readHistory(raw)).toEqual(days());
    expect(readHistoryStore(raw)).toEqual({ v: 1, kaynak: 'ModPOS', at: 5, gunler: days(), urunler: URUNLER });
    // Kaynağı yazılmamış eski kayıt: genel ad
    expect(readHistoryStore(JSON.stringify({ v: 1, at: 1, gunler: days() }))!.kaynak).toBe('Önceki kasa programı');
    expect(readHistoryStore(JSON.stringify({ v: 1, kaynak: 'ModPOS', at: 1, gunler: days(), urunler: { from: 'x' } }))).toEqual({ v: 1, kaynak: 'ModPOS', at: 1, gunler: days() });
  });

  it('kasanın iki kaydı birleşir: aynı tarihte lafmaliyet (ladmin) günü elle yükleneni geçer, ürün bloğu ladmin\'inki', () => {
    const manual = { kaynak: 'Önceki kasa programı', at: 3, gunler: days().map((d) => ({ date: d.date, ciro: d.ciro, adisyon: d.adisyon, closes: [], pay: [] })) };
    const ladmin = { kaynak: 'ModPOS', at: 9, gunler: days().slice(4), urunler: URUNLER };
    const m = mergeHistory(manual, ladmin)!;
    expect(m.gunler).toHaveLength(9);
    expect(m.gunler[0]).toEqual(manual.gunler[0]);
    expect(m.gunler[4]).toEqual(days()[4]);
    expect(m).toMatchObject({ kaynak: 'ModPOS', at: 9, urunler: URUNLER });
    expect(mergeHistory(manual, null)).toMatchObject({ kaynak: 'Önceki kasa programı', at: 3 });
    expect(mergeHistory(null, { kaynak: 'ModPOS', at: 1, gunler: [] })).toBeNull();
  });
});

describe('Uzaktan Kasım raporu (13-22 Kasım): ModPOS günleri + LafPOS kabul günü', () => {
  it('Ciro dökümü sözleşmenin rakamlarını verir (sumSummary)', async () => {
    const { sumSummary } = await import('../api/uzaktan');
    const dates = Array.from({ length: 10 }, (_, i) => `2026-11-${String(13 + i).padStart(2, '0')}`);
    const reps = fillHistory(dates, [LAFPOS_22], days(), '2026-11-23', (d) => historyReport(d, 'ModPOS')).sort((a, b) => (a.date < b.date ? -1 : 1));
    const s = sumSummary({ from: '2026-11-13', to: '2026-11-22' }, reps, [], Date.parse('2026-11-23T12:00:00+03:00'), '2026-11-23');
    expect(s.waterfall).toEqual({ list: 3835500, complimentary: 256500, discounts: 215625, service: 0, revenue: 3363375, kdv: 305760, netExKdv: 3057615 });
    expect(s.receipts).toBe(161);
    expect(s.payments.map((p) => [p.name, p.amount])).toEqual([
      ['Kredi kartı', 2477425],
      ['Nakit', 885950],
    ]);
    expect(s.kdv).toEqual([{ rate: 10, gross: 3363375, base: 3057615, kdv: 305760 }]);
    expect(s.byDay).toHaveLength(10);
    expect(s.byDay[0]).toMatchObject({ date: '2026-11-13', netSales: 39000, kaynak: 'ModPOS', zText: 'Z-2026-002' });
    expect(s.byDay[9]).toMatchObject({ date: '2026-11-22', netSales: 628500 });
    expect(s.byDay[9]).not.toHaveProperty('kaynak');
    expect(s.history).toEqual({ kaynak: 'ModPOS', days: 9, from: '2026-11-13', to: '2026-11-21' });
  });
});

describe('Uzaktan Raporlar uçları (Redis\'te geçmiş ciro)', () => {
  const SHOP = 'b'.repeat(24);
  const CLOUD = 'https://lafpos.vercel.app';
  const PASSWORD = 'modpos-parola-123';
  const store = new Map<string, string>();
  const KEYS = ['LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_PAROLA', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA'];
  const before: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const k of KEYS) before[k] = process.env[k];
    delete process.env.LAFPOS_UYE_EPOSTA;
    Object.assign(process.env, { LAFPOS_CLOUD_SECRET: 'g'.repeat(40), LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
    const redis = upstashFetch(store);
    vi.stubGlobal('fetch', async (_i: string, init?: RequestInit) => redis(init));
    // Kasanın bugünü 23.11 (gün açık); 22.11 LafPOS'un, 13-21 ModPOS'un (sahibin Merkez'den yüklediği kayıt)
    store.set('lafpos:surum', JSON.stringify({ [SHOP]: JSON.stringify({ at: Date.parse('2026-11-23T12:00:00+03:00'), o: true, d: '2026-11-23' }), [`gecmis:${SHOP}`]: '5' }));
    store.set(`lafpos:rapor:${SHOP}:son`, JSON.stringify({ today: '2026-11-23', at: Date.parse('2026-11-23T12:00:00+03:00') }));
    store.set(`lafpos:rapor:${SHOP}:gun:2026-11-22`, JSON.stringify(LAFPOS_22));
    store.set(`lafpos:rapor:${SHOP}:ek:2026-11-22`, JSON.stringify(EXTRA_22));
    store.set(historyKey(SHOP), JSON.stringify({ v: 1, kaynak: 'ModPOS', at: 5, gunler: days(), urunler: URUNLER }));
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
  });

  async function view(path: string) {
    const { GET, POST } = await import('../api/uzaktan');
    const { token } = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '3.3.3.3' } }))).json()) as { token: string };
    const [p, q = ''] = path.split('?');
    const res = await GET(new Request(`${CLOUD}/api/uzaktan?yol=${p}${q ? `&${q}` : ''}`, { headers: { authorization: `Bearer ${token}`, 'x-laf-dukkan': SHOP } }));
    expect(res.status).toBe(200);
    return (await res.json()) as any;
  }

  it('Ciro (13-22 Kasım): ModPOS günleri adıyla, Z numarasıyla; satılan ürün ModPOS listesini de sayar', async () => {
    const s = await view('reports/summary?from=2026-11-13&to=2026-11-22');
    expect(s.waterfall).toMatchObject({ discounts: 215625, complimentary: 256500, revenue: 3363375, kdv: 305760, netExKdv: 3057615 });
    expect(s.receipts).toBe(161);
    expect(s.byDay.filter((d: { kaynak?: string }) => d.kaynak === 'ModPOS').map((d: { zText: string }) => d.zText)).toEqual(MODPOS.map((m) => m[7]));
    expect(s.itemsSold).toBe(58 + 240);
    expect(s.history).toEqual({ kaynak: 'ModPOS', days: 9, from: '2026-11-13', to: '2026-11-21' });
  });

  it('Geçen hafta (16-22 Kasım): ModPOS günleri de görünür; ürün listesi dönemi tam kapsamadığından yalnız not', async () => {
    const s = await view('reports/summary?from=2026-11-16&to=2026-11-22');
    expect(s.byDay.map((d: { date: string }) => d.date)).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22']);
    expect(s.netSales).toBe(267000 + 164125 + 241925 + 253575 + 400800 + 462050 + 628500);
    expect(s.waterfall.discounts).toBe(15375 + 31575 + 20425 + 39700 + 22950 + 9000);
    expect(s.itemsSold).toBe(58);
    const p = await view('reports/products?from=2026-11-16&to=2026-11-22');
    expect(p.history).toEqual({ kaynak: 'ModPOS', from: '2026-11-13', to: '2026-11-21', covered: false });
  });

  it('Saatlik: kapanış dakikası olmayan ModPOS günü saatlere girmez, gün sayısını ve haftanın ortalamasını da bölmez (kasadaki gibi)', async () => {
    const h = await view('reports/hourly?from=2026-11-13&to=2026-11-22');
    expect(h.total).toBe(628500);
    expect(h.days).toBe(1);
    expect(h.week.reduce((a: number, w: { days: number }) => a + w.days, 0)).toBe(1);
    // 22 Kasım'ın haftanın günü satırı yalnız onun saatini taşır (15 Kasım'ın ModPOS günü ortalamayı yarıya indirmez)
    expect(h.week.find((w: { days: number }) => w.days === 1).hours[15]).toBe(628500);
  });

  it('Ürünler: ModPOS listesi kendi bloğunda (indirim öncesi), LafPOS ürün cirosuna karışmaz', async () => {
    const p = await view('reports/products?from=2026-11-13&to=2026-11-22');
    expect(p.total).toBe(57000);
    expect(p.products).toHaveLength(1);
    expect(p.history).toMatchObject({ kaynak: 'ModPOS', from: '2026-11-13', to: '2026-11-21', covered: true, qty: 240, amount: 2941500 });
    expect(p.history.rows).toHaveLength(31);
    expect(p.history.rows[0]).toEqual({ name: 'ÜRÜN 01', size: 'M', qty: 8, amount: 95000 });
  });

  it('kasanın ittiği ModPOS günü saklanır (kaynak, Z); kaynağı bozuk gün saklanmaz', async () => {
    const { POST } = await import('../api/uzaktan');
    const { signedHeaders } = await import('../server/lib/signature');
    const { gzipSync } = await import('node:zlib');
    const shop = 'c'.repeat(24);
    const good = { ...historyReport(days()[0]!, 'ModPOS'), at: 10 };
    const bad = { ...historyReport(days()[1]!, 'ModPOS'), at: 10, kaynak: 5 };
    // Dönem ürün listesi: biçimi ve gün sayısı denetlenir; bozuk blok taşıyan gün saklanmaz
    const withBlock = { ...historyReport(days()[2]!, 'ModPOS'), at: 10, urunler: { ...URUNLER, n: 9 } };
    const badBlock = { ...historyReport(days()[3]!, 'ModPOS'), at: 10, urunler: { ...URUNLER, n: 0 } };
    const body = JSON.stringify({ gz: gzipSync(JSON.stringify({ v: 1, shop, today: '2026-11-23', at: 10, days: [good, bad, withBlock, badBlock] })).toString('base64') });
    const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/rapor`, { method: 'POST', body, headers: signedHeaders('g'.repeat(40), 'POST', new URL(`${CLOUD}/api/uzaktan/rapor`), body) }));
    expect(await res.json()).toMatchObject({ ok: true, stored: 2 });
    expect(JSON.parse(store.get(`lafpos:rapor:${shop}:gun:2026-11-13`)!)).toMatchObject({ kaynak: 'ModPOS', zText: 'Z-2026-002', s: { rev: 39000 } });
    expect(store.has(`lafpos:rapor:${shop}:gun:2026-11-14`)).toBe(false);
    expect(JSON.parse(store.get(`lafpos:rapor:${shop}:gun:2026-11-15`)!).urunler).toMatchObject({ from: '2026-11-13', to: '2026-11-21', n: 9 });
    expect(store.has(`lafpos:rapor:${shop}:gun:2026-11-16`)).toBe(false);
  });

  it('ek sekmeler: İndirim ve ikram listesi ModPOS günlerinin toplamını, öbür listeler ve Adisyonlar ModPOS notunu taşır', async () => {
    const d = await view('reports/items?kind=indirim&from=2026-11-13&to=2026-11-22');
    expect(d.total).toBe(9000);
    expect(d.history).toEqual({ kaynak: 'ModPOS', days: 9, amount: 206625 });
    const k = await view('reports/items?kind=ikram&from=2026-11-13&to=2026-11-22');
    expect(k.total).toBe(13000);
    expect(k.history).toEqual({ kaynak: 'ModPOS', days: 9, amount: 150000 });
    // İptal ve happy hour: ModPOS'tan kalem kaydı gelmez, tutar yok; liste yalnız LafPOS günlerinin
    const v = await view('reports/items?kind=iptal&from=2026-11-13&to=2026-11-22');
    expect(v.history).toEqual({ kaynak: 'ModPOS', days: 9 });
    expect((await view('reports/items?kind=happy&from=2026-11-13&to=2026-11-22')).history).toEqual({ kaynak: 'ModPOS', days: 9 });
    // Adisyonlar: ModPOS günlerinin fişi listede yok, sayısı notta (Ciro'nun 161 fişiyle çelişmesin)
    const c = await view('reports/checks?from=2026-11-13&to=2026-11-22');
    expect(c.history).toEqual({ kaynak: 'ModPOS', days: 9, receipts: 135 });
    // Dönemde ModPOS günü yoksa not yok
    expect(await view('reports/items?kind=iptal&from=2026-11-22&to=2026-11-22')).not.toHaveProperty('history');
    expect(await view('reports/checks?from=2026-11-22&to=2026-11-22')).not.toHaveProperty('history');
  });

  it('Paket platformları: platformun payı LafPOS günlerinin cirosundan (ModPOS günlerinin platform kaydı yok; kasadaki gibi)', async () => {
    const p = await view('reports/platforms?from=2026-11-13&to=2026-11-22');
    expect(p.netSales).toBe(628500);
  });
});
