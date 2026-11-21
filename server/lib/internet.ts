/**
 * İnternet var mı: kasa yerel sunucudur, satış internetsiz sürer; bu yalnız dışarıya giden işlerin (lafmaliyet gün sonu,
 * site giden kutusu, Uzaktan özeti, online sipariş çekimi) durumunu tutar. Yeni istek atmaz: imzalı her isteğin sonucu
 * yazılır (server/lib/signature.ts). Yanıt gelen istek (hata kodu da olsa) "var", ağ hatası (adres çözülemedi,
 * bağlantı kurulamadı, zaman aşımı) "yok" demektir. "Yok"tan "var"a dönünce dinleyiciler bir kez çağrılır
 * (server/sync/catch-up.ts bekleyenleri hemen gönderir).
 */
export type InternetState = 'bilinmiyor' | 'var' | 'yok';

let state: InternetState = 'bilinmiyor';
let since = 0;
let lastOkAt: number | null = null;
let lastFailAt: number | null = null;
let lastError: string | null = null;
const listeners = new Set<() => void>();

const NETWORK_CODES = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENETUNREACH',
  'EHOSTUNREACH',
  'ENETDOWN',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'UND_ERR_HEADERS_TIMEOUT',
]);

/** Hata bir ağ hatası mı (yanıt hiç gelmedi): fetch'in "fetch failed"ı ve nedeni, zaman aşımı */
export function isNetworkError(e: unknown): boolean {
  if (!(e instanceof Error)) return false;
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string' && NETWORK_CODES.has(code)) return true;
  const cause = (e as { cause?: unknown }).cause;
  if (cause && cause !== e && isNetworkError(cause)) return true;
  return e instanceof TypeError && /fetch failed|network/i.test(e.message);
}

/** Dışarıdan yanıt geldi */
export function noteReachable(now = Date.now()) {
  const back = state === 'yok';
  lastOkAt = now;
  lastError = null;
  if (state !== 'var') {
    state = 'var';
    since = now;
  }
  if (back) for (const fn of listeners) fn();
}

/** Ağ hatası: dışarıya ulaşılamadı */
export function noteUnreachable(e: unknown, now = Date.now()) {
  lastFailAt = now;
  lastError = e instanceof Error ? ((e.cause as Error | undefined)?.message ?? e.message) : String(e);
  if (state !== 'yok') {
    state = 'yok';
    since = now;
  }
}

/** İnternet dönünce çağrılacak iş (kaldırmak için dönen fonksiyon) */
export function onInternetBack(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export const internetState = () => ({ state, since: since || null, lastOkAt, lastFailAt, lastError });

/** Testler için */
export function resetInternet() {
  state = 'bilinmiyor';
  since = 0;
  lastOkAt = null;
  lastFailAt = null;
  lastError = null;
}
