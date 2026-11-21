/** Sunucu API istemcisi. Oturum jetonu `Authorization` başlığında gider. */

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code: string | null,
    public data: Record<string, unknown>,
  ) {
    super(message);
  }
}

// Tarayıcı demosu (/demo) aynı alan adında Uzaktan'la ya da kasayla yan yana açılır: oturumları birbirini ezmesin
const TOKEN_KEY = import.meta.env.MODE === 'demo' ? 'lafpos.demo.token' : 'lafpos.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* özel pencere: oturum yalnız bellekte kalır */
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** Oturumun kapandığı API dışından anlaşıldı (canlı akış 401 aldı): giriş ekranına dönülür */
export function sessionEnded() {
  onUnauthorized?.();
}

/** Uzaktan görünümün seçili dükkânı (src/lib/remote.ts): her isteğe `x-laf-dukkan` olarak gider; kasada yok */
let shopHeader: string | null = null;
export function setShopHeader(id: string | null) {
  shopHeader = id;
}

export async function api<T>(method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (shopHeader) headers['x-laf-dukkan'] = shopHeader;
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'Sunucuya ulaşılamadı. Kafe ağı bağlantısını kontrol edin', 'network', {});
  }
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const d = (data ?? {}) as Record<string, unknown>;
    if (res.status === 401 && path !== '/auth/login') onUnauthorized?.();
    throw new ApiError(res.status, (d.error as string) || statusMessage(res.status), (d.code as string) ?? null, d);
  }
  return data as T;
}

/** Sunucu metin göndermediyse kodun anlamı ve ne yapılacağı (kullanıcıya "Hata (500)" yazılmaz) */
export function statusMessage(status: number): string {
  if (status === 401) return 'Oturum kapandı. Yeniden giriş yapın';
  if (status === 403) return 'Bu işlem için yetkiniz yok';
  if (status === 404) return 'Kayıt bulunamadı; ekranı yenileyin';
  if (status === 409) return 'Kayıt başka bir ekranda değişti; ekranı yenileyip yeniden deneyin';
  if (status === 429) return 'Çok sık denendi. Biraz bekleyip yeniden deneyin';
  if (status >= 500) return "Kasa sunucusunda bir sorun oldu. Biraz sonra yeniden deneyin; sürerse LafPOS'u yeniden başlatın";
  return `İşlem tamamlanamadı (hata ${status}). Yeniden deneyin`;
}

export const get = <T>(path: string) => api<T>('GET', path);
export const post = <T>(path: string, body?: unknown) => api<T>('POST', path, body ?? {});
export const patch = <T>(path: string, body?: unknown) => api<T>('PATCH', path, body ?? {});
export const put = <T>(path: string, body?: unknown) => api<T>('PUT', path, body ?? {});
export const del = <T>(path: string) => api<T>('DELETE', path);

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return 'Beklenmeyen bir sorun oldu. Yeniden deneyin';
}
