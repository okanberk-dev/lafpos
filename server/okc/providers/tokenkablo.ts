import { kablo, KabloError, notConnectedMessage } from '../token-kablo';
import { fromTokenxSale } from './tokenx';
import type { FiscalProvider, PollOutcome } from './types';

/**
 * Token ÖKC'ler (Beko 300TR, X30TR) kasa bilgisayarına kabloyla: TokenX Connect Wire / Integration Hub. Bulut, hesap
 * ve internet gerekmez; sepet ve sonuç biçimi bulutla aynıdır (Token Integration Protocol). Yalnız kasada ödeme: cihaz
 * açık hesap listesi tutmaz. Ayrıntı: docs/04-YAZARKASA.md §9.
 */
export const tokenKabloProvider: FiscalProvider = {
  id: 'tokenkablo',
  label: 'Token (Beko) · kablolu',
  capabilities: { transport: 'push', instant: true, list: false, splitPayment: true, cancel: false, poll: true, docKinds: ['okc_fis', 'bilgi_fisi', 'e_arsiv'] },
  configured: () => kablo.connected,
  get notConfigured() {
    return notConnectedMessage(kablo.state);
  },
  terminalId: () => kablo.state.fiscalId,
  status() {
    const s = kablo.state;
    // Windows dışında (geliştirme, demo) köprü hiç açılmaz: kart nedenini söyler, kurulum düğmesi kapalı
    if (!kablo.supported) return { phase: 'desteklenmiyor', message: 'Kablolu Token yalnız Windows kasa bilgisayarında çalışır', fiscalId: null, model: null, sections: [], paymentApps: [], connectedAt: null };
    return { phase: s.phase, message: s.message, fiscalId: s.fiscalId, model: s.model, sections: s.sections, paymentApps: s.paymentApps, connectedAt: s.connectedAt };
  },
  async send(r) {
    await kablo.sendBasket(r.basket);
  },
  /**
   * Kablolu protokolde sepet cihazdan silinmez: satış cihazın ekranındaysa kasiyer cihazda vazgeçer (sonuç "vazgeçildi"
   * olarak gelir). Cihaz bağlı değilse sepet yalnız yetkili onayıyla AsilPOS'ta iptal sayılır
   */
  async cancel() {
    if (!kablo.connected) throw new KabloError(notConnectedMessage(kablo.state));
    throw new KabloError('Satış cihazın ekranında: cihazda iptal tuşuyla vazgeçin, adisyon kendiliğinden açılır');
  },
  async poll(r): Promise<PollOutcome> {
    const sale = kablo.sales.get(r.id);
    if (sale) return { kind: 'result', result: fromTokenxSale(sale, r.amount) };
    return { kind: 'pending', locked: false, lockedBy: null };
  },
  async test() {
    const s = kablo.state;
    const { autoSectionMap } = await import('../basket');
    return {
      connected: kablo.connected,
      phase: s.phase,
      message: s.message,
      fiscalId: s.fiscalId,
      model: s.model,
      sections: s.sections,
      suggestedSectionMap: autoSectionMap(s.sections),
      paymentApps: s.paymentApps,
    };
  },
};
