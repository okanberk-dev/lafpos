import { createHash, createHmac } from 'node:crypto';
import { isNetworkError, noteReachable, noteUnreachable } from './internet';

/**
 * laffogato ↔ lafmaliyet panel bağlantısının imza kuralı (laffogato `src/lib/panel/karaoke-sync-core.ts`).
 * İki proje aynı test vektörlerini sabitler; AsilPOS da `tests/signature.test.ts`'te aynılarını sabitler.
 * Kanonik metin: zaman damgası, yöntem, yol, sıralı ve kodlanmış sorgu, gövdenin SHA-256'sı. Alan adı girmez.
 */

export const TIMESTAMP_HEADER = 'x-laf-timestamp';
export const SIGNATURE_HEADER = 'x-laf-signature';
export const MIN_SECRET_LENGTH = 32;

export function canonicalQuery(params: URLSearchParams): string {
  return [...params.entries()]
    .sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

export interface SignatureInput {
  timestamp: number;
  method: string;
  url: URL;
  body: string;
}

export function canonicalString(input: SignatureInput): string {
  return [
    String(input.timestamp),
    input.method.toUpperCase(),
    input.url.pathname,
    canonicalQuery(input.url.searchParams),
    createHash('sha256').update(input.body, 'utf8').digest('hex'),
  ].join('\n');
}

export function sign(secret: string, input: SignatureInput): string {
  return createHmac('sha256', secret).update(canonicalString(input)).digest('hex');
}

export function signedHeaders(secret: string, method: string, url: URL, body: string, nowMs = Date.now()): Record<string, string> {
  const timestamp = Math.floor(nowMs / 1000);
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: `v1=${sign(secret, { timestamp, method, url, body })}`,
  };
}

/** İmzalı istek; zaman aşımı 8 sn (lafmaliyet'in site bağlantısıyla aynı). */
export async function signedFetch(
  secret: string,
  method: 'GET' | 'POST' | 'PUT',
  url: URL,
  body?: unknown,
  timeoutMs = 8000,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: unknown }> {
  if (secret.length < MIN_SECRET_LENGTH) throw new Error('İmza anahtarı tanımlı değil');
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { accept: 'application/json', ...extraHeaders, ...signedHeaders(secret, method, url, raw) };
  if (raw) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(url, { method, headers, body: raw || undefined, signal: AbortSignal.timeout(timeoutMs), redirect: 'manual' });
  } catch (e) {
    // İnternet durumu (server/lib/internet.ts): yanıt hiç gelmediyse "yok"
    if (isNetworkError(e)) noteUnreachable(e);
    throw e;
  }
  noteReachable();
  // Yönlendirme izlenmez (imza yolu kapsar, gövde yeni adrese gitmez): sunucu yanıt verdi ama adres yanlış yazılmış
  // (http, www, sonda yol). Hata yeniden denenir; adres düzeltilince geçer
  if (res.status >= 300 && res.status < 400) {
    const to = res.headers.get('location');
    let where = '';
    try {
      if (to) where = ` → ${new URL(to, url).origin}`;
    } catch {
      where = '';
    }
    throw new Error(`Adres yönlendiriyor (HTTP ${res.status}${where}): Yönetim › Bağlantı bilgileri'nde adresi yönlendirmesiz, https:// ile ve sonunda yol olmadan yazın`);
  }
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}
