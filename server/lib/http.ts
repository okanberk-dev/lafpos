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

type Undefault<T> = T extends z.ZodDefault<infer I extends z.ZodType> ? I : T;

/**
 * Düzenleme (PATCH) şeması: bütün alanlar isteğe bağlı ve varsayılansız. Zod 4'te `.partial()` alanın
 * `.default()`'unu yine uygular; gönderilmeyen alan varsayılanla ezilirdi (masanın adı değişince konumu ve türü,
 * rezervasyonun durumu değişince kişi sayısı ve süresi, kişinin adı değişince özel yetkileri).
 */
export function patchOf<S extends z.ZodRawShape>(schema: z.ZodObject<S>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, v] of Object.entries(schema.shape)) shape[k] = (v instanceof z.ZodDefault ? (v.unwrap() as z.ZodType) : (v as z.ZodType)).optional();
  return z.object(shape) as unknown as z.ZodObject<{ [K in keyof S]: z.ZodOptional<Extract<Undefault<S[K]>, z.ZodType>> }>;
}

/**
 * Düzenlemenin değiştirdiği alanlar: gönderilmeyen (undefined) alanlar atılır. Hiç alan kalmazsa 422; Drizzle boş
 * `set` ile "No values to set" atar ve uç 500 dönerdi (denetim, 26 Eki 2026).
 */
export function patchFields<T extends object>(patch: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  const fields = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  if (!Object.keys(fields).length) throw new HttpError(422, 'Değiştirilecek alan gönderilmedi', 'validation');
  return fields as { [K in keyof T]?: Exclude<T[K], undefined> };
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

/** Takvimde olan tarih (YYYY-AA-GG): 2026-02-30 ya da 2026-99-99 geçmez, yalnız biçim denetimi yetmiyordu */
export const isoDate = z.iso.date({ error: 'Geçerli bir tarih olmalı (YYYY-AA-GG)' });
/** Saat ve dakika (SS:DD, 00:00-23:59) */
export const clockTime = z.iso.time({ precision: -1, error: 'Geçerli bir saat olmalı (SS:DD)' });
