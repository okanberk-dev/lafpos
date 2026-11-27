import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ACILIS_KASA, BANKA_KIYAS_BASLIGI, ESKI_DEPO_ONEKI, ESKI_ENV_ONEKI, ESKI_URUN_ADI, TEL_KAYNAK } from '@shared/eski-adlar';
import { envDegeri, eskiEnvAdi, posEnv, posEnvAdi, posEnvDolu, yazilacakEnvAdi, yeniAdlarla, yeniEnvAdi } from '@shared/pos-env';
import { type Harness, startApp } from './harness';

/**
 * Ad değişikliğinde kurulu kasanın çalışmaya devam etmesi (plan A2): ortam değişkenleri iki adla okunur, ayarlar
 * dosyasına dosyada yeni ad yoksa eski adla yazılır, ladmin'in eski adlı anahtarları ve devir kaynağı kabul edilir, bekçi sunucuya
 * iki adı da verir, güncelleyici eski ayarı okur, tarayıcı deposu yeni öneke kopyalanır, kısayollar yenisine taşınır.
 */

const E = (ad: string) => `${ESKI_ENV_ONEKI}${ad}`;
const root = new URL('../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
const load = (f: string) => import(/* @vite-ignore */ new URL(`scripts/kasa/windows/kurulum/${f}`, root).href);

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

describe('ortam değişkeni: önce ASILPOS_*, yoksa eski ad', () => {
  it('posEnv ve yardımcıları', () => {
    expect(posEnv({ [E('PORT')]: '5000' }, 'PORT')).toBe('5000');
    expect(posEnv({ ASILPOS_PORT: '6000', [E('PORT')]: '5000' }, 'PORT')).toBe('6000');
    expect(posEnv({}, 'PORT')).toBeUndefined();
    // Boş yeni ad: posEnv boşu verir (?? kuralı), posEnvDolu eskisine düşer (anahtarlar)
    expect(posEnv({ ASILPOS_SECRET: '', [E('SECRET')]: 'eski' }, 'SECRET')).toBe('');
    expect(posEnvDolu({ ASILPOS_SECRET: '', [E('SECRET')]: 'eski' }, 'SECRET')).toBe('eski');
    expect(eskiEnvAdi('ASILPOS_CLOUD_URL')).toBe(E('CLOUD_URL'));
    expect(eskiEnvAdi('LAFFOGATO_URL')).toBeNull();
    expect(yeniEnvAdi(E('CLOUD_URL'))).toBe('ASILPOS_CLOUD_URL');
    expect(yeniEnvAdi('LAFMALIYET_URL')).toBe('LAFMALIYET_URL');
    expect(envDegeri({ [E('CLOUD_URL')]: 'https://a' }, 'ASILPOS_CLOUD_URL')).toBe('https://a');
    expect(envDegeri({ LAFFOGATO_URL: 'https://s' }, 'LAFFOGATO_URL')).toBe('https://s');
    expect(posEnvAdi({ [E('CLOUD_SECRET')]: 'x' }, 'CLOUD_SECRET')).toBe(E('CLOUD_SECRET'));
    expect(posEnvAdi({}, 'CLOUD_SECRET')).toBe('ASILPOS_CLOUD_SECRET');
    expect(yazilacakEnvAdi(new Set([E('CLOUD_URL')]), 'ASILPOS_CLOUD_URL')).toBe(E('CLOUD_URL'));
    expect(yazilacakEnvAdi(new Set([E('CLOUD_URL'), 'ASILPOS_CLOUD_URL']), 'ASILPOS_CLOUD_URL')).toBe('ASILPOS_CLOUD_URL');
    expect(yazilacakEnvAdi(new Set(['ASILPOS_CLOUD_URL']), 'ASILPOS_CLOUD_URL')).toBe('ASILPOS_CLOUD_URL');
    expect(yazilacakEnvAdi(new Set(), 'ASILPOS_CLOUD_URL')).toBe(E('CLOUD_URL'));
    expect(yazilacakEnvAdi(new Set(), 'LAFMALIYET_URL')).toBe('LAFMALIYET_URL');
    expect(yeniAdlarla({ [E('CLOUD_URL')]: 'eski', LAFMALIYET_URL: 'm' })).toEqual({ ASILPOS_CLOUD_URL: 'eski', LAFMALIYET_URL: 'm' });
    expect(yeniAdlarla({ [E('CLOUD_URL')]: 'eski', ASILPOS_CLOUD_URL: 'yeni' })).toEqual({ ASILPOS_CLOUD_URL: 'yeni' });
  });

  it('sunucu ayarları kurulu kasanın eski adlı ayarlar.env satırlarını okur; yeni ad geçer', async () => {
    const { configFrom } = await import('../server/env-config');
    const eski = configFrom({ [E('PORT')]: '4100', [E('HOST')]: '127.0.0.1', [E('SESSION_HOURS')]: '9', [E('CLOUD_URL')]: 'https://u.example/', [E('CLOUD_SECRET')]: ' s ', [E('MERKEZ_URL')]: '0' });
    expect(eski).toMatchObject({ port: 4100, host: '127.0.0.1', sessionHours: 9, cloudUrl: 'https://u.example', cloudSecret: 's', merkezUrl: '' });
    expect(configFrom({ [E('CLOUD_URL')]: 'https://u.example' }).merkezUrl).toBe('https://u.example');
    expect(configFrom({ ASILPOS_PORT: '4200', [E('PORT')]: '4100' }).port).toBe(4200);
  });
});

describe('ayarlar dosyası: eski ad yazılır, dosyada duran yeni ad korunur', () => {
  it('yalnız eski ad duruyorsa o satır değişir; ikisi de varsa ikisi; yalnız yeni ad varsa o; hiçbiri yoksa eski ad (eski sürüme dönüş); kaldırmada ikisi kalkar', async () => {
    const { applyEnvEdits, readEnvText } = await import('../server/lib/ayar-dosyasi');
    const eskiDosya = `﻿# ayarlar\r\n${E('CLOUD_URL')}=https://eski.example\r\n${E('CLOUD_SECRET')}=${'o'.repeat(40)}\r\n`;
    const a = applyEnvEdits(eskiDosya, { ASILPOS_CLOUD_SECRET: 'n'.repeat(40) });
    expect(a).toBe(`﻿# ayarlar\r\n${E('CLOUD_URL')}=https://eski.example\r\n${E('CLOUD_SECRET')}=${'n'.repeat(40)}\r\n`);
    const ikisi = applyEnvEdits(`ASILPOS_CLOUD_SECRET=a\n${E('CLOUD_SECRET')}=a\n`, { ASILPOS_CLOUD_SECRET: 'b' });
    expect(readEnvText(ikisi)).toEqual({ ASILPOS_CLOUD_SECRET: 'b', [E('CLOUD_SECRET')]: 'b' });
    // Dosyada hiç yok (kafenin eski dosyasında yalnız yorumlu satır, yeni kurulumda da): eski adla, eski sunucu da okur
    const bos = applyEnvEdits('# bos\n', { ASILPOS_CLOUD_URL: 'https://y.example' });
    expect(readEnvText(bos)).toEqual({ [E('CLOUD_URL')]: 'https://y.example' });
    expect(applyEnvEdits('ASILPOS_CLOUD_URL=x\n', { ASILPOS_CLOUD_URL: 'https://y.example' })).toBe('ASILPOS_CLOUD_URL=https://y.example\n');
    // Eski ve yeni örnek dosyanın yorumlu satırının altına
    expect(applyEnvEdits(`# Uzaktan\n# ${E('CLOUD_URL')}=\n# son\n`, { ASILPOS_CLOUD_URL: 'https://y.example' })).toBe(`# Uzaktan\n# ${E('CLOUD_URL')}=\n${E('CLOUD_URL')}=https://y.example\n# son\n`);
    expect(applyEnvEdits(`# Uzaktan\n# ASILPOS_CLOUD_URL=\n# son\n`, { ASILPOS_CLOUD_URL: 'https://y.example' })).toBe(`# Uzaktan\n# ASILPOS_CLOUD_URL=\n${E('CLOUD_URL')}=https://y.example\n# son\n`);
    expect(readEnvText(applyEnvEdits(`${E('CLOUD_URL')}=x\nASILPOS_CLOUD_URL=y\nA=1\n`, { ASILPOS_CLOUD_URL: null }))).toEqual({ A: '1' });
  });

  it('yapıştırılan eski adlı satırlar yeni adla okunur', async () => {
    const { parseEnvLines } = await import('../shared/baglanti');
    const r = parseEnvLines(`${E('CLOUD_URL')}=https://u.example\n${E('CLOUD_SECRET')}=${'c'.repeat(40)}\n`);
    expect(r).toEqual({ values: { ASILPOS_CLOUD_URL: 'https://u.example', ASILPOS_CLOUD_SECRET: 'c'.repeat(40) }, unknown: [], later: [] });
  });

  it("ladmin'in anahtar dağıtımı eski adlı anahtarlarla gelir; kasadaki eski adlı değerle karşılaştırılır", async () => {
    const { dagitimFarki } = await import('../server/sync/baglanti-dagitim');
    const json = { ok: true, surum: '0123', baglanti: { [E('CLOUD_URL')]: 'https://u.example', [E('CLOUD_SECRET')]: 'n'.repeat(40) } };
    const current = { [E('CLOUD_URL')]: 'https://u.example/', [E('CLOUD_SECRET')]: 'o'.repeat(40) };
    expect(dagitimFarki(json, current)).toEqual({ surum: '0123', edits: { ASILPOS_CLOUD_SECRET: 'n'.repeat(40) } });
    expect(dagitimFarki(json, { ...current, [E('CLOUD_SECRET')]: 'n'.repeat(40) })!.edits).toEqual({});
    // Kasada Uzaktan yoksa (iki adla da) açılmaz
    expect(dagitimFarki(json, {})!.edits).toEqual({});
  });
});

describe('tel: devrin kaynağı iki adla', () => {
  it("yeni panelin 'asilpos' kaynağı kabul edilir, kasada eski değerle tutulur", async () => {
    const { readDayAnswer } = await import('../server/sync/lafmaliyet');
    const yeni = readDayAnswer({ ok: true, date: '2026-11-26', nextOpening: { amount: 12.5, source: 'asilpos' } }, '2026-11-26');
    expect(yeni.nextOpening).toEqual({ amount: 12.5, source: TEL_KAYNAK });
    const eski = readDayAnswer({ ok: true, date: '2026-11-26', nextOpening: { amount: 12.5, source: TEL_KAYNAK } }, '2026-11-26');
    expect(eski.nextOpening).toEqual({ amount: 12.5, source: TEL_KAYNAK });
    expect(ACILIS_KASA).toBe(TEL_KAYNAK);
  });
});

describe('güncelleyici (guncelle.mjs)', () => {
  it('eski adlı ayarı okur (kapalı güncelleme kapalı kalır, kanal adresi); yükün iki adı da kabul edilir', async () => {
    const { updateMode, channelUrls, parseManifest, staleDownloads, appZipName } = await load('guncelle.mjs');
    expect(updateMode({ [E('GUNCELLEME')]: 'kapali' })).toBe('kapali');
    expect(updateMode({ ASILPOS_GUNCELLEME: 'otomatik', [E('GUNCELLEME')]: 'kapali' })).toBe('otomatik');
    expect(channelUrls({ [E('GUNCELLEME_KANAL')]: 'http://127.0.0.1:9/guncelleme/surum.json' })).toEqual(['http://127.0.0.1:9/guncelleme/surum.json']);
    const sha = 'a'.repeat(64);
    const m = (file: string) => ({ v: 1, build: 1_795_100_000, version: '0.3.0', app: { file, sha256: sha, size: 1 }, node: { version: '24.22.3', abi: '137', sha256: sha }, sqlite: { version: '12.11.1', sha256: sha } });
    expect(parseManifest(m(appZipName(1_795_100_000)), 'https://k.example/guncelleme/surum.json').app.file).toBe(appZipName(1_795_100_000));
    expect(parseManifest(m('asilpos-app-1795100000.zip'), 'https://k.example/guncelleme/surum.json').app.file).toBe('asilpos-app-1795100000.zip');
    expect(() => parseManifest(m('baska-1795100000.zip'), 'https://k.example/guncelleme/surum.json')).toThrow();
    expect(staleDownloads([appZipName(1), 'asilpos-app-2.zip', appZipName(3)], 3)).toEqual([appZipName(1), 'asilpos-app-2.zip']);
  });

  it('deneme bekçisine iki adla bayrak verir (eski güncelleyici eski adla verir, yeni bekçi ikisini okur)', () => {
    const g = read('scripts/kasa/windows/kurulum/guncelle.mjs');
    expect(g).toContain(`ASILPOS_BEKCI_STDIN: '1', ASILPOS_GUNCELLEME_DENEME: '1', ${E('BEKCI_STDIN')}: '1', ${E('GUNCELLEME_DENEME')}: '1'`);
    const b = read('scripts/kasa/windows/kurulum/bekci.mjs');
    expect(b).toContain("posEnv(process.env, 'BEKCI_STDIN') === '1'");
    expect(b).toContain("posEnv(process.env, 'GUNCELLEME_DENEME') === '1'");
  });
});

describe('bekçi sunucuya iki adı da verir', () => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('eski adlı ayarlar.env satırı ve bekçinin kendi değişkenleri iki adla', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'asilpos-bekci-'));
    dirs.push(dir);
    const app = join(dir, 'app');
    const home = join(dir, 'veri');
    mkdirSync(join(app, 'server'), { recursive: true });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(app, 'package.json'), JSON.stringify({ build: 1_795_100_000 }));
    for (const f of ['bekci.mjs', 'ayarlar.mjs', 'guncelle.mjs', 'arsiv.mjs', 'geri-yukle.mjs', 'kurulum-yenile.mjs']) copyFileSync(new URL(`scripts/kasa/windows/kurulum/${f}`, root), join(app, f));
    writeFileSync(join(home, 'ayarlar.env'), `${E('SESSION_HOURS')}=13\r\nASILPOS_PUBLIC_URL=https://p.example\r\n`);
    const ad = (k: string) => [`ASILPOS_${k}`, E(k)];
    const keys = [...ad('SESSION_HOURS'), ...ad('PUBLIC_URL'), ...ad('DATA_DIR'), ...ad('STDIN_CONTROL'), ...ad('AYAR_DOSYASI')];
    writeFileSync(
      join(app, 'server', 'index.mjs'),
      `console.log('ortam ' + JSON.stringify(Object.fromEntries(${JSON.stringify(keys)}.map((k) => [k, process.env[k] ?? null]))));\nconsole.log('AsilPOS sunucusu hazır');\nfor (const e of ['data', 'end']) process.stdin.on(e, () => process.exit(0));\n`,
    );
    const env: NodeJS.ProcessEnv = { ...process.env, ASILPOS_HOME: home, ASILPOS_PAKET_DENEME: '1' };
    for (const k of Object.keys(env)) if (k.startsWith('ASILPOS_') && k !== 'ASILPOS_HOME' && k !== 'ASILPOS_PAKET_DENEME') delete env[k];
    for (const k of Object.keys(env)) if (k.startsWith(ESKI_ENV_ONEKI)) delete env[k];
    const child = spawn(process.execPath, [join(app, 'bekci.mjs')], { env, stdio: 'ignore' });
    const logFile = join(home, 'logs', 'sunucu.log');
    const log = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : '');
    try {
      for (let i = 0; !log().includes('AsilPOS sunucusu hazır'); i++) {
        if (i > 200 || child.exitCode != null) throw new Error(`bekçi sunucuyu açmadı:\n${log()}`);
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      if (child.exitCode == null && child.signalCode == null) {
        const exited = once(child, 'exit');
        child.kill();
        await exited;
      }
    }
    const line = log()
      .split('\n')
      .find((l) => l.includes('ortam {'))!;
    const seen = JSON.parse(line.slice(line.indexOf('{'))) as Record<string, string | null>;
    expect(seen).toMatchObject({
      ASILPOS_SESSION_HOURS: '13',
      [E('SESSION_HOURS')]: '13',
      ASILPOS_PUBLIC_URL: 'https://p.example',
      [E('PUBLIC_URL')]: 'https://p.example',
      ASILPOS_DATA_DIR: home,
      [E('DATA_DIR')]: home,
      ASILPOS_STDIN_CONTROL: '1',
      [E('STDIN_CONTROL')]: '1',
      ASILPOS_AYAR_DOSYASI: join(home, 'ayarlar.env'),
      [E('AYAR_DOSYASI')]: join(home, 'ayarlar.env'),
    });
  });
});

describe('tarayıcı deposu: eski önekli anahtarlar yeni öneke kopyalanır', () => {
  class Depo implements Storage {
    private m = new Map<string, string>();
    get length() {
      return this.m.size;
    }
    key(i: number) {
      return [...this.m.keys()][i] ?? null;
    }
    getItem(k: string) {
      return this.m.get(k) ?? null;
    }
    setItem(k: string, v: string) {
      this.m.set(k, v);
    }
    removeItem(k: string) {
      this.m.delete(k);
    }
    clear() {
      this.m.clear();
    }
  }

  it('yeni anahtar yoksa kopyalanır, varsa dokunulmaz; eski anahtarlar silinmez; depo yoksa sessiz geçer', async () => {
    const { eskiDepoyuTasi, DEPO_ONEKI, TASINDI_ISARETI } = await import('../src/lib/eski-depo');
    expect(DEPO_ONEKI).toBe('asilpos.');
    const yerel = new Depo();
    const oturum = new Depo();
    yerel.setItem(`${ESKI_DEPO_ONEKI}token`, 't');
    yerel.setItem(`${ESKI_DEPO_ONEKI}cart`, '{"eski":1}');
    yerel.setItem('asilpos.cart', '{"yeni":1}');
    yerel.setItem('laf:baska', 'x');
    oturum.setItem(`${ESKI_DEPO_ONEKI}counterDraft`, 'taslak');
    expect(eskiDepoyuTasi([yerel, oturum, undefined])).toBe(2);
    expect(yerel.getItem('asilpos.token')).toBe('t');
    expect(yerel.getItem('asilpos.cart')).toBe('{"yeni":1}');
    expect(yerel.getItem(`${ESKI_DEPO_ONEKI}token`)).toBe('t');
    expect(yerel.getItem('asilpos.baska')).toBeNull();
    expect(oturum.getItem('asilpos.counterDraft')).toBe('taslak');
    expect(yerel.getItem(TASINDI_ISARETI)).toBe('1');
    expect(oturum.getItem(TASINDI_ISARETI)).toBe('1');
    expect(eskiDepoyuTasi([yerel, oturum])).toBe(0);
    const bozuk = { getItem: () => null, get length(): number { throw new Error('kapalı'); } } as unknown as Storage;
    expect(eskiDepoyuTasi([bozuk])).toBe(0);
  });

  it('taşıma her depoda bir kez: uygulamanın sildiği anahtar (çıkış, gösterilen güncelleme işareti) eski kopyadan geri gelmez', async () => {
    const { eskiDepoyuTasi } = await import('../src/lib/eski-depo');
    const yerel = new Depo();
    const oturum = new Depo();
    yerel.setItem(`${ESKI_DEPO_ONEKI}token`, 't');
    // Eski sürüm yenilemeden hemen önce "güncellendi" işaretini koyar
    oturum.setItem(`${ESKI_DEPO_ONEKI}guncellendi`, '1');
    expect(eskiDepoyuTasi([yerel, oturum])).toBe(2);
    // Yeni sürüm bildirimi gösterip işareti siler; kullanıcı çıkış yapar
    oturum.removeItem('asilpos.guncellendi');
    yerel.removeItem('asilpos.token');
    // Sonraki açılışlar
    expect(eskiDepoyuTasi([yerel, oturum])).toBe(0);
    expect(eskiDepoyuTasi([yerel, oturum])).toBe(0);
    expect(oturum.getItem('asilpos.guncellendi')).toBeNull();
    expect(yerel.getItem('asilpos.token')).toBeNull();
    // Eskiler yerinde (eski sürüme dönüş)
    expect(yerel.getItem(`${ESKI_DEPO_ONEKI}token`)).toBe('t');
    // Depo yazılamıyorsa işaret de konmaz: sonraki açılış yeniden dener
    const dolu = new Depo();
    dolu.setItem(`${ESKI_DEPO_ONEKI}cart`, 'x');
    const setItem = dolu.setItem.bind(dolu);
    dolu.setItem = () => {
      throw new Error('dolu');
    };
    expect(eskiDepoyuTasi([dolu])).toBe(0);
    dolu.setItem = setItem;
    expect(eskiDepoyuTasi([dolu])).toBe(1);
    // Uygulamanın ilk içe aktarımı (depoyu okuyan modüllerden önce)
    expect(read('src/main.tsx').split('\n').find((l) => l.startsWith('import '))).toBe("import './lib/eski-depo';");
  });
});

describe("kâğıt: ladmin'in fotoğraftan okuduğu metin", () => {
  it('banka gün sonu kâğıdının kıyas başlığı eski adla (eski panelin kodla okuyucusu banka satırlarını onda bitirir)', () => {
    // lafmaliyet src/lib/photo-read/pavo-ocr.ts: katlanmış satır (büyük harf, Türkçe harfsiz, ayraçlar boşluk)
    const katla = (s: string) =>
      s
        .toLocaleUpperCase('tr')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    expect(katla(BANKA_KIYAS_BASLIGI)).toBe(`PAVO ${ESKI_URUN_ADI.toUpperCase()} KARSILASTIRMA`);
    expect(read('src/lib/print.tsx')).toContain('<div className="rc-caption">{BANKA_KIYAS_BASLIGI}</div>');
  });
});

describe('Windows kısayolları ve kaldırma: eski adlar', () => {
  it('kısayol yenileyici koşulda eski adı da tanır, yenisini yazınca eskisini siler, eski menü klasörünü taşır', async () => {
    const ps = read('scripts/kasa/windows/kurulum/kisayollar.ps1');
    expect(ps).toContain("[string]$EskiMenu = '', [string]$YeniMenu = ''");
    expect(ps).toContain('foreach ($ad in @($k.kosul))');
    expect(ps).toContain('foreach ($ad in @($k.eski))');
    expect(ps).toContain('$f.Name.Replace($EskiMenu, $YeniMenu)');
    expect(ps.indexOf('$s.Save()')).toBeLessThan(ps.indexOf('foreach ($ad in @($k.eski))'));
    const { shortcutArgs, MENU } = await import(/* @vite-ignore */ new URL('../scripts/kasa/windows/kurulum/kurulum-yenile.mjs', import.meta.url).href);
    const args: string[] = shortcutArgs({ appDir: 'a', installDir: 'k', listFile: 'l' });
    expect(args.slice(args.indexOf('-EskiMenu'), args.indexOf('-EskiMenu') + 4)).toEqual(['-EskiMenu', MENU.eski, '-YeniMenu', MENU.yeni]);
  });

  it('kasa bekçisi eski adlı kasa ve bekçi kısayolunu da sayar; adres eski değişkenden de', () => {
    const ps = read('scripts/kasa/windows/kurulum/kasa-yazici.ps1');
    expect(ps).toContain(`$EskiAd = '${ESKI_URUN_ADI}'`);
    expect(ps).toContain("foreach ($ad in @('AsilPOS Kasa.lnk', ($EskiAd + ' Kasa.lnk')))");
    expect(ps).toContain('foreach ($ad in @($BekciKisayolu, $EskiBekciKisayolu))');
    expect(ps).toContain(`else { $env:${E('URL')} }`);
    const bat = read('scripts/kasa/windows/AsilPOS-Kasa.bat');
    expect(bat).toContain(`if "%ASILPOS_URL%"=="" set "ASILPOS_URL=%${E('URL')}%"`);
    // Eski kısayolların çağırdığı dosya yenisine yönlendirir
    expect(read(`scripts/kasa/windows/${ESKI_URUN_ADI}-Kasa.bat`)).toContain('"%~dp0AsilPOS-Kasa.bat" %*');
  });

  it('kurulum ve kaldırma iki adın kısayollarını da siler; kök dosyaların eski adlıları da kalkar', () => {
    const nsi = read('scripts/kasa/windows/kurulum/asilpos.nsi');
    expect(nsi.match(/!insertmacro EskiKisayollariSil/g)).toHaveLength(2);
    expect(nsi).toContain(`RMDir /r "$SMPROGRAMS\\${ESKI_URUN_ADI}"`);
    expect(nsi).toContain(`Delete "$INSTDIR\\${ESKI_URUN_ADI}-Kasa.bat"`);
    const kaldir = read('scripts/kasa/windows/kurulum/web-kaldir.ps1');
    expect(kaldir).toContain(`$eskiAd = '${ESKI_URUN_ADI}'`);
    expect(kaldir).toContain(`'${ESKI_URUN_ADI}-Kasa.bat'`);
    const kur = read('scripts/kasa/windows/kurulum/web-kurucu.ps1');
    expect(kur).toContain("Sil (Join-Path ([Environment]::GetFolderPath('CommonPrograms')) $EskiAd)");
  });
});
