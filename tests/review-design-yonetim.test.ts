import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Harness, startApp } from './harness';

/**
 * Tasarım geçişinin incelemesi (4 Kas 2026): Yönetim › Ayarlar, Ürünler, Müşteri ekranı, Site ve lafmaliyet, Genel bakış
 * ve kenar çubuğu. Sunucunun kuralı süreç içi uygulamayla, ekranın kuralı kaynaktan denetlenir.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

const kitchen = async () => {
  const s = await h.ok<{ kitchenWarnMinutes: number; kitchenAlarmMinutes: number }>('patron', 'GET', '/admin/settings');
  return [s.kitchenWarnMinutes, s.kitchenAlarmMinutes];
};
const settingsAudits = async () => (await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=1000')).filter((a) => a.action === 'settings.update').length;

describe('bar fişi uyarısı ve alarmı', () => {
  it('alarm uyarıdan kısa ya da eşitse 422 (bar ekranı amberi hiç göstermezdi); hiçbir ayar yazılmaz', async () => {
    expect(await kitchen()).toEqual([7, 12]);
    const audits = await settingsAudits();
    for (const body of [
      { kitchenWarnMinutes: 15 },
      { kitchenWarnMinutes: 12 },
      { kitchenAlarmMinutes: 7 },
      { kitchenAlarmMinutes: 5 },
      { kitchenWarnMinutes: 20, kitchenAlarmMinutes: 20 },
      { kitchenWarnMinutes: 15, kitchenAlarmMinutes: 10, receiptFooter: 'Teşekkürler' },
    ]) {
      const r = await h.call<{ code?: string; error?: string }>('patron', 'PUT', '/admin/settings', body);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe('kitchen_alarm');
      expect(r.json.error).toBe('Bar fişi alarmı uyarıdan uzun olmalı');
    }
    expect(await kitchen()).toEqual([7, 12]);
    expect((await h.ok<{ receiptFooter: string }>('patron', 'GET', '/admin/settings')).receiptFooter).not.toBe('Teşekkürler');
    expect(await settingsAudits()).toBe(audits);
  });

  it('geçerli çift ikisi birlikte ya da biri tek başına değişir (öteki kayıtlı değeriyle denetlenir)', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 15, kitchenAlarmMinutes: 20 });
    expect(await kitchen()).toEqual([15, 20]);
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 19 });
    expect(await kitchen()).toEqual([19, 20]);
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 7, kitchenAlarmMinutes: 12 });
    expect(await kitchen()).toEqual([7, 12]);
  });

  it('kayıtlı eski geçersiz çift başka ayarın kaydını (bütün form dahil) engellemez; çifte dokunan kayıt düzeltir', async () => {
    const { updateSettings } = await import('../server/lib/settings');
    updateSettings({ kitchenWarnMinutes: 12, kitchenAlarmMinutes: 12 });
    const all = await h.ok<Record<string, unknown>>('patron', 'GET', '/admin/settings');
    const { menuAutoSync: _a, onlineOrdersSync: _b, serviceMode: _c, ...form } = all;
    expect((await h.call('patron', 'PUT', '/admin/settings', { ...form, receiptFooter: 'Afiyet olsun' })).status).toBe(200);
    expect(await kitchen()).toEqual([12, 12]);
    expect((await h.call('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 13 })).status).toBe(422);
    await h.ok('patron', 'PUT', '/admin/settings', { kitchenWarnMinutes: 7 });
    expect(await kitchen()).toEqual([7, 12]);
  });
});

describe('yönetim ekranlarının kuralları (kaynak)', () => {
  const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');

  it('Ayarlar: alarmın hatası alandayken Kaydet göndermez ("kaydedildi" ile hata yan yana kalmaz)', () => {
    const page = src('pages/admin/SettingsAdmin.tsx');
    expect(page).toMatch(/const kitchenError = s\.kitchenAlarmMinutes <= s\.kitchenWarnMinutes \? 'Alarm süresi uyarıdan uzun olmalı' : null;/);
    expect(page).toMatch(/<Field label="Bar fişi alarmı \(dk\)" hint="[^"]*" error=\{kitchenError\}>/);
    const save = page.slice(page.indexOf('const save = async'), page.indexOf('const backupNow'));
    const guard = save.search(/if \(kitchenError\) \{\s*toast\.err\('Bar fişi alarmı uyarıdan uzun olmalı'\);\s*return;\s*\}/);
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(save.indexOf("put<Settings>('/admin/settings'"));
  });

  it('Site ve lafmaliyet: "Online siparişleri çek" kapalıyken kart siparişin düştüğünü söylemez, son çekim onay almaz', () => {
    const page = src('pages/admin/IntegrationAdmin.tsx');
    expect(page).toMatch(/const pulling = s\.online\.configured && s\.online\.enabled;/);
    expect(page).toMatch(/s\.online\.enabled\s*\? 'Anahtar tanımlı, siparişler imzalı bağlantıyla çekilir'\s*: 'Online sipariş çekimi kapalı: uygulama ve web siparişleri kasaya düşmez'/);
    // 20 sn / 5 dk satırı yalnız çekim açıkken
    expect(page).toMatch(/\{s\.online\.enabled && \(\s*<Status ok=\{s\.online\.versionSignal && !!orders\?\.lastSuccessAt\}/);
    expect(page).toMatch(/<Status ok=\{pulling && !!orders\?\.lastSuccessAt\} idle=\{!pulling \|\| !orders\?\.lastSuccessAt\} error=\{!!orders\?\.lastError\}>/);
    // Genel bakış: kapalı çekim yeşil değil
    expect(src('pages/admin/OverviewAdmin.tsx')).toMatch(/tone: !s\.online\.configured \|\| !s\.online\.enabled \? 'neutral'/);
  });

  it('Ürünler: kaynak seçimi gizliyken (telefon) seçili kaynak listeyi süzmez', () => {
    const page = src('pages/admin/MenuAdmin.tsx');
    // Seçim kutusu sm (40rem) altında gizli; süzgeç aynı eşikte
    expect(page).toMatch(/<label className="hidden min-w-0 sm:block sm:w-44">\s*<span className="sr-only">Kaynak<\/span>/);
    expect(page).toMatch(/const sourceShown = useMediaQuery\('\(min-width: 40rem\)'\);/);
    expect(page).toMatch(/const src: Source = bySource && sourceShown \? source : '';/);
  });

  it('Müşteri ekranı: önizleme sayfada da formdan önce (görsel sıra ile odak sırası aynı), genişte açık yerleşimle sağda', () => {
    const page = src('pages/admin/DisplayAdmin.tsx');
    expect(page).not.toMatch(/order-first|order-last/);
    expect(page.indexOf('<Card title="Önizleme"')).toBeLessThan(page.indexOf('<Card title="Görünüm"'));
    expect(page).toMatch(/<div className="min-w-0 xl:sticky xl:top-4 xl:col-start-2 xl:row-start-1 xl:self-start">\s*<Card title="Önizleme"/);
    expect(page).toMatch(/<div className="min-w-0 space-y-4 xl:col-start-1 xl:row-start-1">\s*<Card title="Görünüm"/);
  });

  it('kenar çubuğu: sayaç ne saydığını söyler ("bekleyen" değil: tükenen ürün, sorun)', () => {
    const shell = src('components/admin/AdminShell.tsx');
    expect(shell).not.toMatch(/\bbekleyen`/);
    expect(shell).toMatch(/menu: \(n\) => `\$\{n\} ürün tükendi`/);
    expect(shell).toMatch(/entegrasyon: \(n\) => `\$\{n\} sorun`/);
    // Sahnenin numaralı menüsü (17 Kas 2026): rakam gözle okunur (ipucu ne saydığını söyler), ne saydığı adın parçası
    // olarak ekran okuyucuya ("Ürünler 3" değil "Ürünler, 3 ürün tükendi")
    expect(shell).toMatch(/return count \? \{ count, text: countText\(key, count\) \} : null;/);
    expect(shell).toMatch(/\{c && <span className="sr-only">, \{c\.text\}<\/span>\}/);
    expect(shell).toMatch(/<span aria-hidden="true" title=\{c\.text\} className="n">/);
  });
});
