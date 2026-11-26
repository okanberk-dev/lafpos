import { salePayments } from '../basket';
import { TOKENX_PAYMENT, TokenxClient, TokenxError, type TokenxSale } from '../tokenx';
import type { FiscalProvider, FiscalResult, PollOutcome } from './types';
import { posEnv } from '@shared/pos-env';

/**
 * Token ÖKC'ler (Beko 300TR, X30TR; 400TR e-belge) TokenX Connect Cloud ile. Sepet Token'ın sunucusuna gider,
 * cihaz ödemeyi alıp fişi keser; sonuç webhook ile ya da sepet sorgulanarak gelir.
 */

let client: TokenxClient | null | undefined;
export function tokenx(): TokenxClient | null {
  if (client === undefined) {
    const cfg = TokenxClient.configFromEnv(process.env);
    client = cfg ? new TokenxClient(cfg) : null;
  }
  return client;
}

export function webhookUrl(): string | null {
  const base = (posEnv(process.env, 'PUBLIC_URL') ?? '').replace(/\/+$/, '');
  return base ? `${base}/api/public/okc/tokenx/webhook` : null;
}

/** Token sonucunu ortak sonuca çevirir: 0 ödendi, 99 fiş iptal, -1 ve diğerleri vazgeçildi */
export function fromTokenxSale(sale: TokenxSale, basketAmount: number): FiscalResult {
  const status = sale.status === 0 ? 'paid' : sale.status === 99 ? 'voided' : 'cancelled';
  const meal = (sale.paymentItems ?? []).some((p) => p.type === TOKENX_PAYMENT.YEMEK_KARTI);
  return {
    status,
    // Token belge türünü sonuçta açıkça vermiyor: e-belge kimliği geldiyse e-Arşiv/e-Fatura, yemek kartında bilgi fişi
    docKind: status !== 'paid' ? null : sale.invoiceID ? null : meal ? 'bilgi_fisi' : 'okc_fis',
    zNo: sale.zNo ?? null,
    receiptNo: sale.receiptNo ?? null,
    docId: sale.invoiceID ?? null,
    payments: status === 'paid' ? salePayments(sale, basketAmount).map(({ kind, amount, operatorId, description }) => ({ kind, amount, operatorId, description })) : [],
    raw: sale,
  };
}

export const tokenxProvider: FiscalProvider = {
  id: 'tokenx',
  label: 'Token (Beko) · TokenX Connect',
  capabilities: { transport: 'push', instant: true, list: true, splitPayment: true, cancel: true, poll: true, docKinds: ['okc_fis', 'bilgi_fisi', 'e_arsiv'] },
  configured: () => !!tokenx(),
  notConfigured: 'TokenX bilgileri eksik; Yönetim › Bağlantı bilgileri › Token yazarkasa (TOKENX_AUTH_URL, TOKENX_BASKET_URL, TOKENX_CLIENT_ID, TOKENX_CLIENT_SECRET, TOKENX_TERMINAL_ID)',
  terminalId: () => tokenx()?.terminalId || null,
  status() {
    const c = tokenx();
    return {
      configured: !!c,
      terminalId: c?.terminalId || null,
      branchId: c?.branchId || null,
      webhookUrl: webhookUrl(),
      webhookSecret: (process.env.TOKENX_WEBHOOK_SECRET ?? '').length >= 16,
    };
  },
  async send(r) {
    const c = tokenx()!;
    if (r.mode === 'anlik') await c.sendInstantBasket(r.basket);
    else await c.sendListBasket(r.basket);
  },
  async cancel(r) {
    const c = tokenx();
    if (!c) throw new Error('TokenX bağlantısı yok');
    if (r.status === 'kilitli') await c.unlockBasket(r.id);
    await c.deleteBasket(r.id);
  },
  async poll(r): Promise<PollOutcome> {
    const c = tokenx();
    if (!c) return { kind: 'pending', locked: r.status === 'kilitli', lockedBy: null };
    const d = await c.getBasket(r.id).catch((e: unknown) => {
      // 1006: Token bu sepeti hiç görmedi (yanıtı alınamayan gönderim ulaşmamış)
      if (e instanceof TokenxError && e.code === '1006') return 'missing' as const;
      throw e;
    });
    if (d === 'missing') return { kind: 'missing' };
    if (d?.sale) return { kind: 'result', result: fromTokenxSale(d.sale, r.amount) };
    if (d?.deletedAt) return { kind: 'deleted' };
    return { kind: 'pending', locked: !!(d?.isLocked ?? d?.islocked), lockedBy: d?.lockedBy ?? null };
  },
  async test() {
    const c = tokenx();
    if (!c) throw new Error(tokenxProvider.notConfigured);
    const [terminal, fiscal] = await Promise.all([c.getTerminal().catch((e: Error) => ({ error: e.message })), c.getFiscalSections()]);
    const terminals = await c.getTerminals().catch(() => null);
    const { autoSectionMap } = await import('../basket');
    return { terminal, sections: fiscal.sections, suggestedSectionMap: autoSectionMap(fiscal.sections), terminals };
  },
};
