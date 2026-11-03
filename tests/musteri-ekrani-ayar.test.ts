import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encode } from 'uqr';
import type { DisplayConfigDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Müşteri ekranının özelleştirmesi (Yönetim › Müşteri ekranı): ayar sunucuda, ekran oturumsuz okur; yalnız ayar yetkisi
 * yazar, metin ve adres sınırlı, değişiklik denetim kaydına düşer.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const full = (over: Partial<DisplayConfigDTO> = {}) => ({
  theme: 'yesil',
  welcomeTitle: 'Hoş geldiniz',
  welcomeSubtitle: 'Drink it. Eat the cup.',
  thanksTitle: 'Afiyet olsun',
  messages: ['Happy hour 15:00-17:00', 'Uygulamada her 6 kahveye 1 hediye'],
  qrUrl: 'https://laffogato.net/uygulama',
  qrLabel: 'Uygulamayı indirin',
  showClock: false,
  showOptions: true,
  ...over,
});

describe('müşteri ekranı ayarı', () => {
  it('ekran oturumsuz okur: varsayılan gece teması, sitenin sloganı, işletme adı', async () => {
    const c = await h.ok<DisplayConfigDTO>('', 'GET', '/public/display-config');
    expect(c.theme).toBe('gece');
    expect(c.welcomeTitle).toBe('Hoş geldiniz');
    expect(c.welcomeSubtitle).toBe('Drink it. Eat the cup.');
    expect(c.messages).toEqual([]);
    expect(c.qrUrl).toBe('');
    expect(c.businessName).toBe("L'Affogato");
  });

  it('patron değiştirir, ekran yeni görünümü okur; bootstrap ayarlarında da gelir', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { customerDisplay: full() });
    const c = await h.ok<DisplayConfigDTO>('', 'GET', '/public/display-config');
    expect(c.theme).toBe('yesil');
    expect(c.messages).toHaveLength(2);
    expect(c.qrUrl).toBe('https://laffogato.net/uygulama');
    expect(c.showClock).toBe(false);
    const boot = await h.ok<{ settings: { customerDisplay: DisplayConfigDTO } }>('kasa', 'GET', '/bootstrap');
    expect(boot.settings.customerDisplay.thanksTitle).toBe('Afiyet olsun');
    const audit = await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=20');
    expect(audit.some((a) => a.action === 'settings.update' && a.message.includes('customerDisplay'))).toBe(true);
  });

  it('yalnız ayar yetkisi yazar (kasiyer ve garson yazamaz)', async () => {
    expect((await h.call('kasa', 'PUT', '/admin/settings', { customerDisplay: full({ theme: 'porselen' }) })).status).toBe(403);
    expect((await h.call('garson', 'PUT', '/admin/settings', { customerDisplay: full({ theme: 'porselen' }) })).status).toBe(403);
    expect((await h.ok<DisplayConfigDTO>('', 'GET', '/public/display-config')).theme).toBe('yesil');
  });

  it('tema, metin uzunluğu, duyuru sayısı ve adres denetlenir', async () => {
    const bad = async (over: Record<string, unknown>) => (await h.call('patron', 'PUT', '/admin/settings', { customerDisplay: { ...full(), ...over } })).status;
    expect(await bad({ theme: 'mor' })).toBe(422);
    expect(await bad({ welcomeTitle: 'x'.repeat(61) })).toBe(422);
    expect(await bad({ messages: Array.from({ length: 7 }, (_, i) => `Duyuru ${i}`) })).toBe(422);
    expect(await bad({ messages: [''] })).toBe(422);
    expect(await bad({ qrUrl: 'javascript:alert(1)' })).toBe(422);
    expect(await bad({ qrUrl: 'laffogato.net' })).toBe(422);
    // Boş adres karekodu kaldırır
    await h.ok('patron', 'PUT', '/admin/settings', { customerDisplay: full({ qrUrl: '' }) });
    expect((await h.ok<DisplayConfigDTO>('', 'GET', '/public/display-config')).qrUrl).toBe('');
  });
});

// İnceleme bulguları: Ayarlar'ın kaydı müşteri ekranını geri alıyordu, uzun karekod adresi sayfayı düşürüyordu
describe('müşteri ekranı ayarının ekranları', () => {
  const src = (path: string) => readFileSync(join(__dirname, '..', path), 'utf8');

  it("Yönetim › Ayarlar'ın kaydı açılıştaki müşteri ekranı kopyasını geri yazmaz", () => {
    const settings = src('src/pages/admin/SettingsAdmin.tsx');
    expect(settings).toMatch(/k !== 'customerDisplay'/);
    expect(settings).toMatch(/comparable = \(x: Settings\) => JSON\.stringify\(\{ \.\.\.x, serviceMode: null, customerDisplay: null \}\)/);
  });

  it('karekod adresi alanı sunucunun sınırında (300); sığmayan içerik çizimi düşürmez', () => {
    expect(src('server/routes/admin.ts')).toMatch(/qrUrl: z\.union\(\[z\.literal\(''\), z\.string\(\)\.trim\(\)\.max\(300\)/);
    expect(src('src/pages/admin/DisplayAdmin.tsx')).toMatch(/value=\{draft\.qrUrl\}[^>]*maxLength=\{300\}/);
    // uqr bu boyu karekoda sığdıramaz: QrCode bunu yakalar
    expect(() => encode(`https://laffogato.net/${'x'.repeat(2400)}`, { ecc: 'M', border: 2 })).toThrow();
    expect(src('src/components/QrCode.tsx')).toMatch(/try \{\s*qr = encode\(value/);
  });

  it("'Ekranı aç' ve kurulum adresi demonun önekini korur (appUrl)", () => {
    const page = src('src/pages/admin/DisplayAdmin.tsx');
    expect(page).toContain("const screenUrl = appUrl('/musteri-ekrani?ekran=kasa');");
    expect(page).not.toMatch(/href="\/musteri-ekrani/);
  });
});

