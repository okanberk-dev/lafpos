import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/** Kasa bilgisayarı başlatıcıları (docs/05-KASA-BILGISAYARI.md): kiosk, sessiz yazdırma, ayrı profil, otomatik başlatma */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('kasa bilgisayarı', () => {
  const launchers = { windows: read('scripts/kasa/windows/LafPOS-Kasa.bat'), mac: read('scripts/kasa/mac/LafPOS-Kasa.command') };

  for (const [os, text] of Object.entries(launchers)) {
    it(`${os}: Chrome kiosk, sessiz fiş yazdırma, uygulama penceresi, ayrı profil`, () => {
      for (const flag of ['--kiosk', '--kiosk-printing', '--app=', '--user-data-dir=', '--disable-pinch', '--overscroll-history-navigation=0', '--autoplay-policy=no-user-gesture-required']) {
        expect(text, flag).toContain(flag);
      }
      // Sunucu hazır olmadan Chrome açılırsa "bağlanılamadı" görünür: önce sağlık ucu beklenir
      expect(text).toContain('api/health');
    });
  }

  it('Windows betikleri CRLF (cmd ve PowerShell)', () => {
    expect(read('scripts/kasa/windows/LafPOS-Kasa.bat')).toMatch(/\r\n/);
    expect(read('scripts/kasa/windows/kur.ps1')).toMatch(/\r\n/);
    expect(read('.gitattributes')).toMatch(/\*\.bat text eol=crlf/);
  });

  it('kurulum: sunucu ve kasa ekranı oturum açılınca başlar, kaldırma da var', () => {
    const ps = read('scripts/kasa/windows/kur.ps1');
    expect(ps).toMatch(/Register-ScheduledTask[\s\S]*-AtLogOn|New-ScheduledTaskTrigger -AtLogOn/);
    expect(ps).toContain('npm start');
    expect(ps).toContain('LafPOS Kasa.lnk');
    expect(ps).toContain('-Kaldir');
    const sh = read('scripts/kasa/mac/kur.sh');
    expect(sh).toContain('<key>KeepAlive</key><true/>');
    expect(sh).toContain('--kaldir');
    expect(statSync(join(root, 'scripts/kasa/mac/LafPOS-Kasa.command')).mode & 0o111).toBeGreaterThan(0);
  });

  it('ekran kararmasın ayarı varsayılan açık ve belgelenmiş', () => {
    expect(read('server/lib/settings.ts')).toMatch(/keepAwake: true/);
    expect(read('docs/05-KASA-BILGISAYARI.md')).toMatch(/Wake Lock/);
  });
});
