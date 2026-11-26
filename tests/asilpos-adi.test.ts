import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as eskiAdlar from '@shared/eski-adlar';
import { BELGE_ALINTILARI, ESKI_AD_METINLERI, ESKI_AD_NOTU, ESKI_URUN_ADI, KURULUM_KLASORU } from '@shared/eski-adlar';

/**
 * Ad değişikliği (26 Kasım 2026, ürün AsilPOS oldu). Eski ad yalnız izinli yerlerde geçer:
 * - shared/eski-adlar.ts (TypeScript dosyaları değeri yalnız oradan alır),
 * - telin altın dosyaları, ladmin ile bayt bayt aynı hesap sözleşmesi ve gönderilmiş göçler (dosyanın tamamı),
 * - TypeScript dışındaki dosyalarda `ESKI_AD_METINLERI` (kurulu kasanın klasörleri, kanal, imzalar...), betikte satır
 *   sonundaki `eski-ad` notuyla işaretli küçük kopya, belgede `BELGE_ALINTILARI` (tırnaktaki tel değeri, eski PR'lar).
 * Ayrıca eski adların değerleri ve altın dosyalar sabittir: değişirse kurulu kasa, eski sürüme dönüş ya da ladmin bozulur.
 */

const ESKI_AD = new RegExp(['laf', 'pos'].join(''), 'i');
const root = new URL('../', import.meta.url);
const dosyalar = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);

/** Tamamı eski adla kalabilen dosyalar */
const TAM_DOSYA = new Set([
  'shared/eski-adlar.ts',
  'tests/fixtures/kabul-gunu-2026-11-22.json',
  'tests/fixtures/lafmaliyet-gun.golden.json',
  'tests/fixtures/lafmaliyet-gun-personel.golden.json',
  'docs/hesap-sozlesmesi.md',
]);
const tamDosya = (f: string) => TAM_DOSYA.has(f) || f.startsWith('drizzle/');
/** Adı eski adla kalan dosyalar: macOS kısayolu (kurulu launchd ajanında mutlak yol), eski kısayolların yönlendiricisi */
const ESKI_ADLI_YOLLAR = new Set([`scripts/kasa/mac/${ESKI_URUN_ADI}-Kasa.command`, `scripts/kasa/windows/${ESKI_URUN_ADI}-Kasa.bat`]);
const IKILI = /\.(ico|png|jpe?g|gif|webp|woff2?|ttf|otf|zip|db|pdf|mp3|wav)$/i;
const TS = /\.(ts|tsx|mts|cts)$/;
const BETIK = /\.(mjs|cjs|js|ps1|nsi|sh|bat|cmd|command|ya?ml)$/;
const BELGE = /\.(md|txt)$/;
const NOT = new RegExp(`(?:#|//|;)\\s*${ESKI_AD_NOTU}\\b`);

const cikar = (satir: string, metinler: readonly string[]) => [...metinler].sort((a, b) => b.length - a.length).reduce((s, m) => s.split(m).join(''), satir);

describe('eski ad (ad değişikliği: ürün AsilPOS)', () => {
  it('eski ad yalnız izinli yerlerde: eski adlar modülü, sabit dosyalar, betikteki işaretli kopya ve belgedeki alıntı', () => {
    const ihlal: string[] = [];
    for (const f of dosyalar) {
      if (ESKI_AD.test(f) && !ESKI_ADLI_YOLLAR.has(f)) ihlal.push(`${f}: dosya adı`);
      if (tamDosya(f) || IKILI.test(f)) continue;
      let metin: string;
      try {
        metin = readFileSync(new URL(f, root), 'utf8');
      } catch {
        continue;
      }
      if (!ESKI_AD.test(metin)) continue;
      metin.split('\n').forEach((satir, i) => {
        if (!ESKI_AD.test(satir)) return;
        if (TS.test(f)) return ihlal.push(`${f}:${i + 1}: TypeScript eski adı shared/eski-adlar.ts'ten almalı`);
        let kalan = cikar(satir, ESKI_AD_METINLERI);
        if (BELGE.test(f)) kalan = cikar(kalan, BELGE_ALINTILARI);
        if (!ESKI_AD.test(kalan)) return;
        if (BETIK.test(f) && NOT.test(satir)) return;
        ihlal.push(`${f}:${i + 1}: ${satir.trim().slice(0, 140)}`);
      });
    }
    expect(ihlal).toEqual([]);
  });

  it('eski adların değerleri değişmez (kurulu kasa, tel, Pavo, Upstash ve imzalar bunlara bağlı)', () => {
    const degerler = Object.fromEntries(
      Object.entries(eskiAdlar)
        .filter(([, v]) => typeof v === 'string')
        .sort(([a], [b]) => (a < b ? -1 : 1)),
    );
    // Yeni bir eski ad eklenince bu özet bilerek güncellenir; var olan bir değer değişmemeli
    expect(createHash('sha256').update(JSON.stringify(degerler)).digest('hex')).toBe('0c9b3ed3755c275ef0c022f8f5455bf57dd575e86fa79ff26b68bb46e9c69bea');
  });

  it('tel altın dosyaları ladmin ile bayt bayt aynı kalır', () => {
    const ozet = (f: string) => createHash('sha256').update(readFileSync(new URL(f, root))).digest('hex');
    expect(ozet('tests/fixtures/kabul-gunu-2026-11-22.json')).toBe('5fb55e0cc9997c7b84c7ca08b87cad72f4cf47288f5521f6991298a1c08b245c');
    expect(ozet('tests/fixtures/lafmaliyet-gun.golden.json')).toBe('46adb00d0fc3de3be88df7b7cd9a16e8a641b6c5f2c81ec61681230728f0e5d4');
    expect(ozet('tests/fixtures/lafmaliyet-gun-personel.golden.json')).toBe('ea4f82573cb699120dff3bd0c282682ba89091e484e58d0736c7cab293c9b782');
  });

  it('TypeScript içe aktaramayan betiklerin kopyaları eski adlar modülüyle aynı', async () => {
    const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href);
    const { MENU, IF_PRESENT_ROOT_FILES } = await load('kurulum-yenile.mjs');
    expect(MENU).toEqual({ yeni: 'AsilPOS', eski: ESKI_URUN_ADI });
    expect(IF_PRESENT_ROOT_FILES).toEqual([`${KURULUM_KLASORU}-Kaldir.ps1`]);
    const { OLD_WEB_INSTALLER_NAME, WEB_INSTALLER_URL } = await load('web-kurucu.mjs');
    expect(OLD_WEB_INSTALLER_NAME).toBe(eskiAdlar.ESKI_WEB_KURUCU);
    expect(WEB_INSTALLER_URL.startsWith(`https://${eskiAdlar.ALAN_ADI}/guncelleme/`)).toBe(true);
    const { MANIFEST_URLS, appZipName } = await load('guncelle.mjs');
    expect(MANIFEST_URLS).toEqual([`https://${eskiAdlar.ALAN_ADI}/guncelleme/surum.json`, `https://${eskiAdlar.VERCEL_ALANI}/guncelleme/surum.json`]);
    expect(appZipName(1)).toBe(`${eskiAdlar.UYGULAMA_ZIP_ONEKI}1.zip`);
    // Bekçi içe aktarılamaz (açılınca çalışır): kopyası metinden
    const bekci = readFileSync(new URL('scripts/kasa/windows/kurulum/bekci.mjs', root), 'utf8');
    expect(bekci).toContain(`const ESKI = { klasor: '${KURULUM_KLASORU}', envOneki: '${eskiAdlar.ESKI_ENV_ONEKI}' };`);
    const nsi = readFileSync(new URL('scripts/kasa/windows/kurulum/asilpos.nsi', root), 'utf8');
    expect(nsi).toContain(`!define TASK "${eskiAdlar.SUNUCU_GOREVI}"`);
    expect(nsi).toContain(`InstallDir "$PROGRAMFILES64\\${KURULUM_KLASORU}"`);
    expect(nsi).toContain(`StrCpy $DATA "$APPDATA\\${KURULUM_KLASORU}"`);
    expect(nsi).toContain(`Uninstall\\${KURULUM_KLASORU}"`);
    for (const f of ['web-kurucu.ps1', 'web-kaldir.ps1', 'yonet.ps1']) {
      const ps = readFileSync(new URL(`scripts/kasa/windows/kurulum/${f}`, root), 'utf8');
      expect(ps, f).toContain(`Join-Path $env:ProgramData '${KURULUM_KLASORU}'`);
    }
  });
});
