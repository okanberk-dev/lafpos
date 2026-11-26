import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { KURULUM_KLASORU } from '@shared/eski-adlar';

/**
 * Windows kurulumunun ayar kuralları (scripts/kasa/windows/kurulum/ayarlar.mjs): bekçinin sunucuya verdiği bellek
 * sınırı ve .env.example'dan üretilen ayarlar.env.ornek. Uzun dönem raporu (400 gün, iki dönem birden) 512 MB'a
 * sığmıyordu; varsayılan bilgisayarın belleğinin dörtte biri, 1024-4096 MB
 */
type Ayarlar = {
  HEAP_MIN_MB: number;
  HEAP_MAX_MB: number;
  heapLimitMb: (setting: unknown, totalBytes: number) => number;
  validHeapSetting: (setting: unknown) => boolean;
  envSample: (example: string) => string;
};
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
// Değişken adresle: tip denetimi .mjs'i aramaz, türü yukarıda
const load = () => import(/* @vite-ignore */ new URL('scripts/kasa/windows/kurulum/ayarlar.mjs', root).href) as Promise<Ayarlar>;
const GB = 2 ** 30;

describe('bekçinin bellek sınırı', () => {
  it('ayarsız: bilgisayarın belleğinin dörtte biri, en az 1024, en çok 4096 MB', async () => {
    const { heapLimitMb } = await load();
    expect(heapLimitMb(undefined, 2 * GB)).toBe(1024);
    expect(heapLimitMb(undefined, 4 * GB)).toBe(1024);
    expect(heapLimitMb(undefined, 8 * GB)).toBe(2048);
    expect(heapLimitMb(undefined, 12 * GB)).toBe(3072);
    expect(heapLimitMb(undefined, 16 * GB)).toBe(4096);
    expect(heapLimitMb(undefined, 64 * GB)).toBe(4096);
    // Eski 512 MB'lık varsayılan geri gelmez
    expect(heapLimitMb('', 1 * GB)).toBeGreaterThanOrEqual(1024);
  });

  it('ASILPOS_MAX_HEAP_MB 256-4096 arası tam sayıysa o; değilse yok sayılır', async () => {
    const { heapLimitMb, validHeapSetting, HEAP_MIN_MB, HEAP_MAX_MB } = await load();
    expect([HEAP_MIN_MB, HEAP_MAX_MB]).toEqual([256, 4096]);
    expect(heapLimitMb('768', 8 * GB)).toBe(768);
    expect(heapLimitMb(' 256 ', 8 * GB)).toBe(256);
    expect(heapLimitMb('4096', 2 * GB)).toBe(4096);
    for (const bad of ['', '   ', '255', '4097', '1024.5', 'abc', '0', '-512', undefined, null]) {
      expect(validHeapSetting(bad)).toBe(false);
      expect(heapLimitMb(bad, 8 * GB)).toBe(2048);
    }
  });

  it('bekçi kuralı ayarlar.mjs\'ten alır; derleme onu pakete koyar', () => {
    const bekci = read('scripts/kasa/windows/kurulum/bekci.mjs');
    expect(bekci).toContain("from './ayarlar.mjs'");
    expect(bekci).toMatch(/heapLimitMb\(env\.ASILPOS_MAX_HEAP_MB, totalmem\(\)\)/);
    expect(bekci).not.toMatch(/\b512\b/);
    const derle = read('scripts/kasa/windows/kurulum/derle.mjs');
    expect(read('scripts/kasa/windows/kurulum/paket.mjs')).toMatch(/KASA_SCRIPTS = \['bekci\.mjs', 'ayarlar\.mjs', 'guncelle\.mjs', 'arsiv\.mjs', 'geri-yukle\.mjs', 'kurulum-yenile\.mjs'\]/);
    // Paketin denemesi ayarsız varsayılanı ve ayar dosyasından gelen sınırı günlükte arar
    expect(derle).toContain('ASILPOS_MAX_HEAP_MB=768');
  });
});

describe('ayarlar.env.ornek', () => {
  it('bellek ayarı yorumlu ve açıklamalı; sunucu adresi ve veri yolu satırları yok', async () => {
    const { envSample } = await load();
    const sample = envSample(read('.env.example'));
    const lines = sample.split('\n');
    expect(lines[0]).toMatch(/Windows kurulumu/);
    expect(sample).not.toMatch(/^#?\s*ASILPOS_(PORT|HOST|DATA_DIR)=/m);
    // Yorumlu: ilk kurulumda sınır bilgisayarın belleğinden gelir
    const at = lines.indexOf('# ASILPOS_MAX_HEAP_MB=2048');
    expect(at).toBeGreaterThan(0);
    expect(sample).not.toMatch(/^ASILPOS_MAX_HEAP_MB=/m);
    // Hemen üstünde açıklaması: aralık, varsayılan, ne zaman artırılır
    const note = lines.slice(at - 3, at).join(' ');
    expect(note).toContain('256-4096');
    expect(note).toContain('dörtte biri');
    expect(note).toContain('1024');
    expect(note).toContain('heap out of memory');
    // Sunucu satırlarının ardında, site ayarlarından önce
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.includes('ASILPOS_SECRET=')));
    expect(at).toBeLessThan(lines.findIndex((l) => l.includes('LAFFOGATO_URL=')));
    expect(sample).toContain(`C:\\ProgramData\\${KURULUM_KLASORU}\\secret.key`);
  });

  it('.env.example ASILPOS_SECRET satırını yitirirse derleme durur', async () => {
    const { envSample } = await load();
    expect(() => envSample('# başlık\nASILPOS_PORT=4000\n')).toThrow(/ASILPOS_SECRET/);
  });
});
