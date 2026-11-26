import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Şube kurulumu: ladmin'in şubeye özel kurucusu veri klasörüne tek kullanımlık kodu yazar; sunucu kodu ladmin'e verip
 * şubesini ve bağlantılarını alır (server/sync/kurulum-kodu.ts). ladmin sahte fetch'le.
 */

const KOD = 'Abc123_-'.repeat(4);
let h: Harness;
let dir: string;
let envFile: string;

const answer = {
  ok: true,
  sube: { id: 'kadikoy', ad: 'Kadıköy' },
  baglanti: {
    LAFMALIYET_URL: 'https://ladmin.laffogato.net',
    LAFMALIYET_SYNC_SECRET: 's'.repeat(40),
    LAFPOS_CLOUD_URL: 'https://lafpos.laffogato.net',
    LAFPOS_CLOUD_SECRET: 'c'.repeat(40),
    // Kısa anahtar yazılmaz; listede olmayan anahtar hiç yazılmaz
    LAFFOGATO_SYNC_SECRET: 'kisa',
    TOKENX_CLIENT_SECRET: 'x'.repeat(40),
  },
};

beforeAll(async () => {
  h = await startApp();
  dir = mkdtempSync(join(tmpdir(), 'lafpos-kurulum-'));
  envFile = join(dir, 'ayarlar.env');
  writeFileSync(envFile, '# ayarlar\nLAFFOGATO_URL=\n');
  process.env.LAFPOS_AYAR_DOSYASI = envFile;
});
afterAll(() => {
  delete process.env.LAFPOS_AYAR_DOSYASI;
  h.cleanup();
});

const writeCode = (adres = 'https://ladmin.laffogato.net', kod = KOD) => writeFileSync(join(dir, 'kurulum-kodu.json'), `﻿${JSON.stringify({ adres, kod })}`);
const fakeFetch = (status: number, json: unknown, seen?: { url: string; body: unknown }[]) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    seen?.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

describe('kurulum kodu dosyası ve ladmin yanıtı', () => {
  it('yalnız https (yerelde http), geçerli kod; yol düşer', async () => {
    const { readKodFile } = await import('../server/sync/kurulum-kodu');
    expect(readKodFile(JSON.stringify({ adres: 'https://ladmin.laffogato.net/panel', kod: KOD }))).toEqual({ adres: 'https://ladmin.laffogato.net', kod: KOD });
    expect(readKodFile(JSON.stringify({ adres: 'http://ladmin.laffogato.net', kod: KOD }))).toBeNull();
    expect(readKodFile(JSON.stringify({ adres: 'http://localhost:3000', kod: KOD }))).toEqual({ adres: 'http://localhost:3000', kod: KOD });
    expect(readKodFile(JSON.stringify({ adres: 'https://ladmin.laffogato.net', kod: 'kisa' }))).toBeNull();
    expect(readKodFile('{bozuk')).toBeNull();
  });

  it('yanıttan yalnız bilinen ve geçerli bağlantılar alınır; şube kimliği biçime uymalı', async () => {
    const { readRedeemAnswer } = await import('../server/sync/kurulum-kodu');
    const r = readRedeemAnswer(answer)!;
    expect(r.sube).toEqual({ id: 'kadikoy', ad: 'Kadıköy' });
    expect(Object.keys(r.edits).sort()).toEqual(['LAFMALIYET_SYNC_SECRET', 'LAFMALIYET_URL', 'LAFPOS_CLOUD_SECRET', 'LAFPOS_CLOUD_URL']);
    expect(readRedeemAnswer({ ...answer, sube: { id: 'Kadıköy', ad: 'x' } })).toBeNull();
    expect(readRedeemAnswer({ ok: false })).toBeNull();
  });
});

describe('kodun ladmin’e verilmesi', () => {
  it('internet yoksa kod durur, neden yazılır; sonra yeniden denenir', async () => {
    const { redeemInstallCode } = await import('../server/sync/kurulum-kodu');
    writeCode();
    const out = await redeemInstallCode({ dataDir: dir, fetchImpl: (async () => Promise.reject(new Error('ağ yok'))) as typeof fetch });
    expect(out).toMatchObject({ ok: false, hata: expect.stringContaining('ulaşılamadı') });
    expect(out!.kalici).toBeUndefined();
    expect(existsSync(join(dir, 'kurulum-kodu.json'))).toBe(true);
  });

  it('kod verilince şube kimliği ve bağlantılar yazılır, kod bir daha kullanılmaz, denetime düşer', async () => {
    const { redeemInstallCode, kurulumDurumu } = await import('../server/sync/kurulum-kodu');
    const seen: { url: string; body: unknown }[] = [];
    const out = await redeemInstallCode({ dataDir: dir, fetchImpl: fakeFetch(200, answer, seen) });
    expect(seen[0]).toMatchObject({ url: 'https://ladmin.laffogato.net/api/lafpos/kurulum', body: { kod: KOD } });
    expect(out).toMatchObject({ ok: true, sube: { id: 'kadikoy', ad: 'Kadıköy' }, hata: null });
    expect(kurulumDurumu()).toMatchObject({ ok: true });
    const { getSettings } = await import('../server/lib/settings');
    expect(getSettings().branchId).toBe('kadikoy');
    const text = readFileSync(envFile, 'utf8');
    expect(text).toContain(`LAFMALIYET_SYNC_SECRET=${'s'.repeat(40)}`);
    expect(text).toContain('LAFPOS_CLOUD_URL=https://lafpos.laffogato.net');
    expect(text).not.toContain('TOKENX_CLIENT_SECRET');
    expect(text).toContain('# ayarlar');
    expect(existsSync(join(dir, 'kurulum-kodu.json'))).toBe(false);
    expect(existsSync(join(dir, 'kurulum-kodu.json.kullanildi'))).toBe(true);
    const { db, schema } = await import('../server/db/client');
    const rows = db.select().from(schema.auditLog).all();
    expect(rows.some((r) => r.action === 'settings.branchId' && r.message.includes('Kadıköy'))).toBe(true);
    // Dosya yokken bir şey yapılmaz
    expect(await redeemInstallCode({ dataDir: dir, fetchImpl: fakeFetch(500, {}) })).toBeNull();
  });

  it('kullanılmış ya da süresi dolmuş kod kalıcı hatadır: dosya kalkar, yeniden denenmez', async () => {
    const { redeemInstallCode } = await import('../server/sync/kurulum-kodu');
    writeCode();
    const out = await redeemInstallCode({ dataDir: dir, fetchImpl: fakeFetch(410, { error: 'Bu kurulum bağlantısı kullanılmış' }) });
    expect(out).toMatchObject({ ok: false, kalici: true, hata: expect.stringContaining('kullanılmış') });
    expect(existsSync(join(dir, 'kurulum-kodu.json'))).toBe(false);
  });

  it('şube kimliği kilitliyse (lafmaliyet gün kabul etti) ve farklıysa değişmez, alarm', async () => {
    const { redeemInstallCode } = await import('../server/sync/kurulum-kodu');
    const { getSettings, setSyncState } = await import('../server/lib/settings');
    setSyncState('lafmaliyet.push', { lastSuccessAt: Date.now() });
    writeCode();
    const out = await redeemInstallCode({ dataDir: dir, fetchImpl: fakeFetch(200, { ...answer, sube: { id: 'moda', ad: 'Moda' } }) });
    expect(out).toMatchObject({ ok: false, kilitli: true });
    expect(getSettings().branchId).toBe('kadikoy');
  });
});
