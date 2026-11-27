import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BootstrapDTO } from '@shared/types';

/** Kurulum verisindeki demo personelin PIN'leri (server/db/seed.ts) */
export const PINS = { kasa: '1111', garson: '2222', mudur: '2468', patron: '1897' } as const;

/**
 * Süreç içi AsilPOS: geçici veritabanı, kurulum verisi, şube (varsayılan `marina`) ve demo personelin oturumları. Sunucu modülleri ortam
 * değişkenleri ayarlandıktan sonra yüklenir; vitest her test dosyasını ayrı modül alanında çalıştırdığı için
 * her dosyanın kendi veritabanı olur.
 */
export async function startApp(extraEnv: Record<string, string> = {}, opts: { branch?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'asilpos-test-'));
  Object.assign(process.env, { ASILPOS_DATA_DIR: dir, ASILPOS_NO_JOBS: '1', ...extraEnv });
  const { runMigrations } = await import('../server/db/client');
  const { seedIfEmpty } = await import('../server/db/seed');
  const { createApp } = await import('../server/app');
  runMigrations();
  seedIfEmpty();
  // Testlerin kasası Marina'nınki (şubesi belli, çok şubeli sürümden önceki gibi); `branch: null` şubesiz yeni kasayı dener
  if (opts.branch !== null) (await import('../server/lib/settings')).updateSettings({ branchId: opts.branch ?? 'marina' });
  const app = createApp();
  const tokens: Record<string, string> = {};

  async function call<T = unknown>(who: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: T }> {
    const res = await app.request(`/api${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T };
  }

  async function ok<T = unknown>(who: string, method: string, path: string, body?: unknown): Promise<T> {
    const r = await call<T>(who, method, path, body);
    if (r.status !== 200) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  }

  async function login(who: string, pin: string) {
    tokens[who] = (await ok<{ token: string }>('', 'POST', '/auth/login', { pin })).token;
  }

  for (const [who, pin] of Object.entries(PINS)) await login(who, pin);
  const boot = await ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
  /** Siteden gelen ürünün fiyatı API'den değişmez (`synced_field`); beklenen tutarları sabit tutmak isteyen test doğrudan yazar */
  async function pinPrice(name: string, price: number) {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    db.update(schema.products).set({ price }).where(eq(schema.products.name, name)).run();
  }
  return { call, ok, login, tokens, boot, pinPrice, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export type Harness = Awaited<ReturnType<typeof startApp>>;
