/**
 * TokenX Connect (Cloud) istemcisi: Token ÖKC'lere (yazarkasa POS) REST API ile sepet gönderir.
 * Kaynak: developer.tokeninc.com › X Platform › Token X Connect (Cloud), Postman koleksiyonu "TokenX Documentation".
 *
 * Akış: client-id/secret ile erişim jetonu → (anlık mod) terminale sepet → kasiyer cihazda ödemeyi alır ve mali
 * fişi basar → sonuç webhook ile gelir; LafPOS ayrıca sepet detayını sorgulayarak da sonucu alır (kafedeki
 * sunucu internetten erişilemiyorsa webhook ulaşmaz).
 */

export interface TokenxConfig {
  authUrl: string;
  basketUrl: string;
  settingsUrl: string;
  clientId: string;
  clientSecret: string;
  terminalId: string;
  branchId: string;
  /** Bazı ortamlarda zorunlu başlık (durum kodu 0013) */
  appResource: string;
}

export interface TokenxItem {
  name: string;
  /** Birim fiyat, kuruş */
  price: number;
  sectionNo: number;
  /** KDV oranı x100 (%10 = 1000) */
  taxPercent: number;
  /** Adet x1000 */
  quantity: number;
  unit?: string;
  barcode?: string;
  pluNo?: number;
  adjust?: TokenxAdjust;
}

export interface TokenxAdjust {
  description: string;
  /** 0 indirim, 1 artırım */
  discountOrSurcharge: 0 | 1;
  /** 0 tutar, 1 yüzde */
  type: 0 | 1;
  /** Adet başına değer x100 (sepet düzeyinde yalnız bu) */
  value?: number;
  /** Kaleme toplam değer x100 */
  totalValue?: number;
}

export interface TokenxPaymentItem {
  amount: number;
  type: number;
  operatorId?: number;
  description?: string;
}

export interface TokenxBasket {
  basketID: string;
  checkNumber?: number;
  title?: string;
  filter?: string;
  note?: string;
  documentType?: number;
  createInvoice?: boolean;
  isVoid?: boolean;
  items: TokenxItem[];
  paymentItems?: TokenxPaymentItem[];
  adjust?: TokenxAdjust;
  callbackUrl?: string;
}

/** Cihazdan dönen satış sonucu (webhook `data` ya da sepet detayındaki `sale`) */
export interface TokenxSale {
  basketID: string;
  documentType?: number;
  message?: string;
  paymentCount?: number;
  paymentItems?: (TokenxPaymentItem & { status?: number; BatchNo?: number; TxnNo?: number; currencyId?: number })[];
  receiptNo?: number;
  /** 0 başarılı, -1 vazgeçildi, 99 fiş iptal */
  status: number;
  UUID?: string;
  zNo?: number;
  invoiceID?: string;
}

export interface TokenxBasketDetails {
  basketID: string;
  status?: number;
  isLocked?: boolean;
  islocked?: boolean;
  lockedBy?: string | null;
  deletedAt?: string | null;
  total?: number;
  sale?: TokenxSale | null;
}

export interface TokenxSection {
  sectionNo: number;
  name: string;
  taxPercent: number;
  status?: number;
}

/** Ödeme tipleri (Token Integration Protocol) */
export const TOKENX_PAYMENT = {
  NAKIT: 1,
  CEK: 2,
  KREDI_KARTI: 3,
  YEMEK_KARTI: 7,
  ODEMESIZ: 8,
  IKRAM: 9,
  PUAN: 11,
  EPOS: 12,
  MOBIL: 13,
  E_PARA: 14,
  ACIK_HESAP: 17,
  PARA_TRANSFERI: 18,
  HEDIYE_KARTI: 20,
} as const;

/** Durum kodlarının Türkçe açıklaması (Geliştirici Dokümanı §13) */
const STATUS_TEXT: Record<string, string> = {
  '0001': 'Token jetonunun algoritması uyuşmuyor',
  '0002': 'Token erişim jetonunun süresi dolmuş',
  '0003': 'Token erişim jetonunun imzası geçersiz',
  '0004': 'Authorization başlığı eksik ya da hatalı',
  '0005': 'Token jetonundan bilgi okunamadı',
  '0006': 'terminal-id, branch-id ya da merchant-id başlıklarından biri gönderilmeli',
  '0007': 'terminal-id, branch-id, merchant-id başlıklarından yalnız biri gönderilmeli',
  '0011': 'Token erişimi reddetti',
  '0012': 'Token sunucusunda hata',
  '0013': 'x-application-resource başlığı gerekli (TOKENX_APP_RESOURCE)',
  '1006': 'Kayıt bulunamadı',
  '1007': 'Bu sepet kimliği daha önce kullanılmış',
  '1013': 'Sepet verisi hatalı biçimde',
  '1018': 'Sepet cihazda kilitli; önce kilidi açın',
  '1100': 'Cihazda açık bir sepet var; önce onu tamamlayın ya da silin',
  '1101': 'Bu adisyon numarasıyla açık sepet zaten var',
  '1102': 'Bu sepet zaten tamamlanmış',
  '1103': 'Ürün toplamı ile ödeme toplamı uyuşmuyor',
  '1104': 'Cihaz "Sepet ödemesini hemen al" modunda değil',
  '1105': 'Sepetin durumu bu işleme uygun değil',
  '1106': 'Bu terminal Token sisteminde bulunamadı (TOKENX_TERMINAL_ID)',
};

/** Token durum kodlarını belgedeki biçime getirir: 2 -> "0002", 1100 -> "1100" */
export function statusCode(s: unknown): string | null {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  if (Number.isFinite(n) && n > 0 && n < 100) return String(n).padStart(4, '0');
  return String(s);
}

export class TokenxError extends Error {
  constructor(
    message: string,
    public code: string | null,
    public httpStatus: number,
  ) {
    super(message);
  }
}

export class TokenxClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private cfg: TokenxConfig) {}

  static configFromEnv(env: Record<string, string | undefined>): TokenxConfig | null {
    const cfg: TokenxConfig = {
      authUrl: (env.TOKENX_AUTH_URL ?? '').replace(/\/+$/, ''),
      basketUrl: (env.TOKENX_BASKET_URL ?? '').replace(/\/+$/, ''),
      settingsUrl: (env.TOKENX_SETTINGS_URL ?? env.TOKENX_BASKET_URL ?? '').replace(/\/+$/, ''),
      clientId: env.TOKENX_CLIENT_ID ?? '',
      clientSecret: env.TOKENX_CLIENT_SECRET ?? '',
      terminalId: env.TOKENX_TERMINAL_ID ?? '',
      branchId: env.TOKENX_BRANCH_ID ?? '',
      appResource: env.TOKENX_APP_RESOURCE ?? '',
    };
    if (!cfg.authUrl || !cfg.basketUrl || !cfg.clientId || !cfg.clientSecret) return null;
    return cfg;
  }

  get terminalId() {
    return this.cfg.terminalId;
  }

  get branchId() {
    return this.cfg.branchId;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const basic = Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64');
    const res = await fetch(`${this.cfg.authUrl}/v1/auth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => null)) as { status?: number; description?: string; result?: { accessToken?: string; expiresIn?: number } } | null;
    const value = json?.result?.accessToken;
    if (!res.ok || !value) {
      throw new TokenxError(`Token kimlik doğrulaması başarısız: ${json?.description ?? `HTTP ${res.status}`}`, String(json?.status ?? ''), res.status);
    }
    this.token = { value, expiresAt: Date.now() + (json?.result?.expiresIn ?? 900) * 1000 };
    return value;
  }

  private async call<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    opts: { body?: unknown; terminal?: boolean; branch?: boolean; retryAuth?: boolean } = {},
  ): Promise<T> {
    const token = await this.accessToken();
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.terminal) headers['terminal-id'] = this.cfg.terminalId;
    if (opts.branch) headers['branch-id'] = this.cfg.branchId;
    if (this.cfg.appResource) headers['x-application-resource'] = this.cfg.appResource;
    const res = await fetch(url, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as { status?: number | string; description?: string; result?: T } | null;
    const code = statusCode(json?.status);
    if ((res.status === 401 || code === '0002') && opts.retryAuth !== false) {
      this.token = null;
      return this.call<T>(method, url, { ...opts, retryAuth: false });
    }
    const ok = res.ok && (json?.status === 0 || json?.status === 201 || json?.status === '0');
    if (!ok) {
      const known = code ? STATUS_TEXT[code] : undefined;
      throw new TokenxError(known ?? json?.description ?? `Token isteği başarısız (HTTP ${res.status})`, code, res.status);
    }
    return json?.result as T;
  }

  getFiscalSections() {
    return this.call<{ sections: TokenxSection[]; terminal?: string }>('GET', `${this.cfg.basketUrl}/v1/fiscal-parameters`, { terminal: true });
  }

  getTerminals() {
    return this.call<{ id: string; branchId: string; mode: 0 | 1 }[]>('GET', `${this.cfg.basketUrl}/v1/terminal`, { branch: !!this.cfg.branchId, terminal: !this.cfg.branchId });
  }

  getTerminal() {
    return this.call<{ terminalId: string; branchId: string; merchantId: string }>('GET', `${this.cfg.basketUrl}/v1/terminal/${encodeURIComponent(this.cfg.terminalId)}`, { terminal: true });
  }

  /** "Sepet ödemesini hemen al" (kasada ödeme) modundaki terminale */
  sendInstantBasket(basket: TokenxBasket) {
    return this.call<unknown>('POST', `${this.cfg.basketUrl}/v1/instant-basket`, { body: basket, terminal: true });
  }

  /** "Birden fazla sepeti listele" (masada ödeme): şubedeki bütün terminallere ya da tek terminale */
  sendListBasket(basket: TokenxBasket) {
    return this.call<unknown>('POST', `${this.cfg.basketUrl}/v1/basket`, { body: basket, branch: !!this.cfg.branchId, terminal: !this.cfg.branchId });
  }

  updateBasket(basket: TokenxBasket) {
    const { basketID, ...rest } = basket;
    return this.call<unknown>('PUT', `${this.cfg.basketUrl}/v1/basket/${encodeURIComponent(basketID)}`, { body: rest, branch: !!this.cfg.branchId, terminal: !this.cfg.branchId });
  }

  getBasket(basketId: string) {
    return this.call<TokenxBasketDetails>('GET', `${this.cfg.basketUrl}/v1/basket/${encodeURIComponent(basketId)}`);
  }

  deleteBasket(basketId: string) {
    return this.call<unknown>('DELETE', `${this.cfg.basketUrl}/v1/basket/${encodeURIComponent(basketId)}`);
  }

  unlockBasket(basketId: string) {
    return this.call<unknown>('POST', `${this.cfg.basketUrl}/v1/basket/unlock`, { body: { basketID: basketId }, branch: !!this.cfg.branchId, terminal: !this.cfg.branchId });
  }

  getOpenBaskets() {
    return this.call<{ basketID: string; checkNumber: number; total: number; isLocked: boolean; title?: string }[]>('GET', `${this.cfg.basketUrl}/v1/basket/open-basket`, { terminal: true });
  }

  /** Webhook adresini Token'a kaydeder (entegratör başına tek adres; sepet başına callbackUrl da gönderilebilir) */
  setClientSettings(callbackUrl: string, callbackAuthHeader?: string) {
    return this.call<unknown>('POST', `${this.cfg.settingsUrl}/v1/client-settings`, { body: { callbackUrl, ...(callbackAuthHeader ? { callbackAuthHeader } : {}) } });
  }
}
