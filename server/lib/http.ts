import type { Context } from 'hono';
import { z } from 'zod';

/** İstemciye Türkçe mesajla dönen iş kuralı hatası. */
export class HttpError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 423 | 429 | 500 | 502 | 503,
    message: string,
    public code?: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const bad = (msg: string, code?: string) => new HttpError(400, msg, code);
export const notFound = (what = 'Kayıt') => new HttpError(404, `${what} bulunamadı`, 'not_found');
export const conflict = (msg: string, code?: string) => new HttpError(409, msg, code);

/** Gövdeyi zod şemasıyla doğrular; hata mesajını Türkçe ve alan adlı döndürür. */
export async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    raw = {};
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const field = first?.path.join('.') || 'gövde';
    throw new HttpError(422, `Geçersiz alan: ${field} (${first?.message ?? 'hatalı değer'})`, 'validation');
  }
  return parsed.data;
}

export function query<T extends z.ZodType>(c: Context, schema: T): z.infer<T> {
  const parsed = schema.safeParse(c.req.query());
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new HttpError(422, `Geçersiz parametre: ${first?.path.join('.')}`, 'validation');
  }
  return parsed.data;
}

/** Kuruş alanları için ortak şema: negatif olmayan tam sayı */
export const kurus = z.number().int().min(0).max(1_000_000_000);
