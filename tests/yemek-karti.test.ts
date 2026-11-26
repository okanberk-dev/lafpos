import { describe, expect, it } from 'vitest';
import { channelOfName, pavoMealMap, pavoMediatorFor, tokenMealMap, tokenOperatorFor } from '@shared/yemek-karti';
import { pavoSale, readSale } from '../server/okc/providers/pavo';
import { kabloPlan, kabloWantedFor as kabloWanted } from '../server/okc/token-kablo-plan';

/**
 * Yemek kartının yazarkasadaki karşılığı: Token'da operatör no'su (belgeli: Edenred 1001, Multinet 1002, Setcard 1003,
 * Pluxee/Sodexo 1004, Metropol 1006), Pavo'da cihazın ödeme aracı (cihazın listesinden adıyla). Kablo takılınca
 * yapılacaklar (kabloPlan) da burada.
 */

const methods = [
  { id: 'nakit', name: 'Nakit', kind: 'nakit', channel: null, active: true },
  { id: 'pl', name: 'Pluxee', kind: 'yemek', channel: 'pluxee', active: true },
  { id: 'mu', name: 'Multinet', kind: 'yemek', channel: 'multinet', active: true },
  { id: 'ed', name: 'Edenred', kind: 'yemek', channel: 'edenred', active: true },
  { id: 'me', name: 'Metropol', kind: 'yemek', channel: 'metropol', active: false },
];

describe('Token yemek kartı operatörü', () => {
  it('kanalı bilinen kart cihazdaki uygulamasına eşlenir; cihazda uygulaması olmayan ve pasif tür eklenmez; elle eşleme korunur', () => {
    expect(tokenMealMap({}, methods, [67, 1002, 1004])).toEqual({ '1002': 'mu', '1004': 'pl' });
    // Cihaz liste vermediyse (eski yazılım) kanalı bilinen her etkin tür
    expect(tokenMealMap({}, methods, [])).toEqual({ '1001': 'ed', '1002': 'mu', '1004': 'pl' });
    // Elle: Pluxee TokenFlex'e (1005) bağlanmış; kanaldan ikinci kez eşlenmez
    expect(tokenMealMap({ '1005': 'pl' }, methods, [1002, 1004, 1005])).toEqual({ '1005': 'pl', '1002': 'mu' });
  });

  it('ödeme türünün operatörü: elle eşleme, yoksa kanalından; bilinmiyorsa yok', () => {
    expect(tokenOperatorFor('pl', 'pluxee', {})).toBe(1004);
    expect(tokenOperatorFor('pl', 'pluxee', { '1005': 'pl' })).toBe(1005);
    expect(tokenOperatorFor('x', null, {})).toBeNull();
  });
});

describe('Pavo yemek kartı ödeme aracı', () => {
  const mediators = [
    { id: 1, name: 'Nakit' },
    { id: 2, name: 'Kredi Kartı' },
    { id: 5, name: 'MULTINET' },
    { id: 6, name: 'Sodexo' },
    { id: 7, name: 'Ticket Restaurant' },
    { id: 9, name: 'Havale' },
  ];
  it('adıyla eşlenir (Sodexo → Pluxee, Ticket → Edenred); nakit ve kart hiç; tanınmayan ad eşlenmez; elle eşleme korunur', () => {
    expect(pavoMealMap({}, methods, mediators)).toEqual({ '5': 'mu', '6': 'pl', '7': 'ed' });
    expect(pavoMealMap({ '9': 'mu' }, methods, mediators)).toEqual({ '9': 'mu', '6': 'pl', '7': 'ed' });
    expect(channelOfName('Set Card')).toBe('setcard');
    expect(channelOfName('Nakit')).toBeNull();
    expect(pavoMediatorFor('mu', { '5': 'mu' })).toBe(5);
    expect(pavoMediatorFor('pl', { '5': 'mu' })).toBeNull();
  });

  it('eşlenmiş yemek kartı cihaza o araçla gider; eşlenmemiş yemek kartında ödeme bilgisi gitmez (kasiyer seçer)', () => {
    const b = { basketID: 'b', items: [{ name: 'Latte', price: 20000, sectionNo: 1, taxPercent: 1000, quantity: 1000 }] };
    expect(pavoSale({ ...b, odemeTuru: 'yemek' as const, odemeAraci: 5 }, 'LP1').PaymentInformations).toEqual([{ Mediator: 5, Amount: 200, CurrencyCode: 'TRY', ExchangeRate: 1 }]);
    expect(pavoSale({ ...b, odemeTuru: 'yemek' as const }, 'LP1')).not.toHaveProperty('PaymentInformations');
  });

  it('cihaz yanıtındaki eşlenmiş araç yemek kartı ödemesidir (no operatör olarak taşınır); eşlenmemiş araç tahminle işlenmez', () => {
    const res = { HasError: false, Data: { AddedPayments: [{ StatusId: 2, PaymentAmount: 150, PaymentTypeId: 5 }], FinancialDocuments: [{ InvoiceNo: 'B1', Type: { Name: 'Bilgi Fişi' } }] } };
    expect(readSale(res, new Set([5]))).toMatchObject({ kind: 'paid', result: { docKind: 'bilgi_fisi', payments: [{ kind: 'yemek', amount: 15000, operatorId: 5 }] } });
    expect(readSale(res, new Set())).toMatchObject({ kind: 'paid', result: { payments: [] } });
  });
});

describe('Token kablolu: kablo takılınca', () => {
  const device = {
    sections: [
      { sectionNo: 1, name: 'GIDA', taxPercent: 1000 },
      { sectionNo: 2, name: 'ICECEK', taxPercent: 2000 },
      { sectionNo: 4, name: 'SU', taxPercent: 100 },
    ],
    paymentApps: [1002],
  };
  const s = { okcProvider: 'kapali' as const, okcTokenKabloOto: true, okcSectionMap: { '1': 3, '10': 1, '20': 2 }, okcOperatorMethods: {} };

  it('kapalıyken geçer; cihazda olmayan kısım cihazdakiyle değişir, tutan kısım kalır; yemek kartı eşlenir', () => {
    expect(kabloPlan(s, device, methods, true)).toEqual({ provider: 'tokenkablo', sectionMap: { '1': 4, '10': 1, '20': 2 }, operatorMethods: { '1002': 'mu' }, held: null });
  });

  it('eğitim cihazında gün açıkken geçmez; gün kapalıyken geçer; patronun “Kurulumu yap”ı her durumda geçirir', () => {
    expect(kabloPlan({ ...s, okcProvider: 'simulator' }, device, methods, true)).toMatchObject({ provider: null, held: expect.stringContaining('Eğitim günü açık') });
    expect(kabloPlan({ ...s, okcProvider: 'simulator' }, device, methods, false).provider).toBe('tokenkablo');
    expect(kabloPlan({ ...s, okcProvider: 'pavo' }, device, methods, false)).toMatchObject({ provider: null, sectionMap: null, held: expect.stringContaining('Pavo') });
    expect(kabloPlan({ ...s, okcProvider: 'pavo' }, device, methods, false, true).provider).toBe('tokenkablo');
    expect(kabloPlan({ ...s, okcTokenKabloOto: false }, device, methods, false)).toMatchObject({ provider: null, held: expect.stringContaining('kapalı') });
  });

  it('zaten Token kabloluysa ve ayarlar uygunsa değişiklik yok', () => {
    expect(kabloPlan({ ...s, okcProvider: 'tokenkablo', okcSectionMap: { '1': 4, '10': 1, '20': 2 }, okcOperatorMethods: { '1002': 'mu' } }, device, methods, true)).toEqual({ provider: null, sectionMap: null, operatorMethods: null, held: null });
  });

  it('köprü yalnız Windows kasada ve Token kablolu seçiliyken ya da kendiliğinden geçiş açıkken (kapalı, eğitim cihazı) çalışır', () => {
    expect(kabloWanted(s, true)).toBe(true);
    expect(kabloWanted(s, false)).toBe(false);
    expect(kabloWanted({ ...s, okcProvider: 'pavo' }, true)).toBe(false);
    expect(kabloWanted({ ...s, okcProvider: 'tokenkablo', okcTokenKabloOto: false }, true)).toBe(true);
    expect(kabloWanted({ ...s, okcTokenKabloOto: false }, true)).toBe(false);
  });
});
