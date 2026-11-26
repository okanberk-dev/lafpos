import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import {
  anahtarImzaMetni,
  durumGecerli,
  durumParmakIzi,
  imzaMetni,
  KOMUT_TURLERI,
  komutDogrula,
  komutOzeti,
  type KomutTuru,
  KONTROL_SURUM,
  type KontrolDurumu,
  uyeYapabilir,
  UYE_ROLLERI,
} from '@shared/kontrol';
import { ALL_PERMISSIONS, ROLES } from '@shared/permissions';
import { KONTROL_IMZA_ONEKI } from '@shared/eski-adlar';

/**
 * Uzaktan yönetim sözleşmesi (shared/kontrol.ts): bulut, kasa ve arayüz aynı doğrulamayı, imza metnini ve parmak izini
 * kullanır. Doğrulama alanları sabit sırayla yeniden kurar (bilinmeyen alan düşer): imza iki tarafta aynı çıkar
 */
const SIFRELI = `${'Ab9+/'.repeat(68)}xy==`;
const BASKA_SIFRELI = `${'Zq0_-'.repeat(68)}kw`;

function ok(tur: unknown, veri: unknown) {
  const d = komutDogrula(tur, veri);
  if (!d.ok) throw new Error(`Beklenmeyen ret: ${d.hata}`);
  return d;
}

function hata(tur: unknown, veri: unknown): string {
  const d = komutDogrula(tur, veri);
  if (d.ok) throw new Error(`Reddedilmeliydi: ${JSON.stringify(veri)}`);
  return d.hata;
}

describe('komutDogrula', () => {
  it('bilinmeyen tür ve nesne olmayan veri reddedilir', () => {
    expect(hata('personel.sil', { id: 'a' })).toBe('Bilinmeyen işlem');
    expect(hata(42, {})).toBe('Bilinmeyen işlem');
    for (const veri of [null, undefined, 'x', [1, 2], 7]) expect(hata('urun.satis', veri)).toBe('İşlemin bilgileri eksik');
  });

  it('personel.ekle: ad düzelir, renk küçülür; bilinmeyen alan düşer, alan sırası sabit', () => {
    const d = ok('personel.ekle', { fazla: 'x', pin: SIFRELI, indirim: 10, renk: '#AABBCC', rol: 'garson', ad: '  Ayşe   Yılmaz ' });
    expect(d.veri).toEqual({ ad: 'Ayşe Yılmaz', rol: 'garson', renk: '#aabbcc', indirim: 10, pin: SIFRELI });
    expect(Object.keys(d.veri)).toEqual(['ad', 'rol', 'renk', 'indirim', 'pin']);
    // Başka sırayla gelen aynı veri aynı metni verir
    const e = ok('personel.ekle', { ad: 'Ayşe Yılmaz', rol: 'garson', renk: '#aabbcc', indirim: 10, pin: SIFRELI });
    expect(JSON.stringify(e.veri)).toBe(JSON.stringify(d.veri));
    // İsteğe bağlı alanlar yoksa yazılmaz
    expect(Object.keys(ok('personel.ekle', { ad: 'Can', rol: 'kasiyer', pin: BASKA_SIFRELI }).veri)).toEqual(['ad', 'rol', 'pin']);
  });

  it('personel.ekle: bozuk alanlar ve şifrelenmemiş PIN reddedilir', () => {
    const base = { ad: 'Can', rol: 'garson', pin: SIFRELI };
    expect(hata('personel.ekle', { ...base, ad: '   ' })).toBe('Ad 1-40 karakter olmalı');
    expect(hata('personel.ekle', { ...base, ad: 'x'.repeat(41) })).toBe('Ad 1-40 karakter olmalı');
    expect(hata('personel.ekle', { ...base, rol: 'sef' })).toBe('Rol anlaşılamadı');
    expect(hata('personel.ekle', { ...base, renk: 'kırmızı' })).toBe('Renk anlaşılamadı');
    expect(hata('personel.ekle', { ...base, indirim: 101 })).toMatch(/İndirim sınırı/);
    expect(hata('personel.ekle', { ...base, indirim: 5.5 })).toMatch(/İndirim sınırı/);
    // Açık PIN (4-6 rakam) kuyruğa hiç giremez
    for (const pin of ['1234', '739153', '', 42, `${SIFRELI}!`]) expect(hata('personel.ekle', { ...base, pin })).toBe('PIN şifrelenmemiş ya da bozuk');
  });

  it('personel.duzenle: yalnız gönderilen alanlar, sabit sırayla; değişiklik yoksa ret', () => {
    const d = ok('personel.duzenle', { indirim: 20, aktif: false, rol: 'mudur', ad: ' Mehmet ', id: '01JDUSER', pin: SIFRELI });
    expect(d.veri).toEqual({ id: '01JDUSER', ad: 'Mehmet', rol: 'mudur', aktif: false, indirim: 20 });
    expect(Object.keys(d.veri)).toEqual(['id', 'ad', 'rol', 'aktif', 'indirim']);
    expect(ok('personel.duzenle', { id: 'u1', aktif: true }).veri).toEqual({ id: 'u1', aktif: true });
    expect(hata('personel.duzenle', { id: 'u1' })).toBe('Değişiklik yok');
    expect(hata('personel.duzenle', { id: 'u 1', aktif: true })).toBe('Personel anlaşılamadı');
    expect(hata('personel.duzenle', { id: 'u1', aktif: 'evet' })).toBe('Etkin bilgisi anlaşılamadı');
    expect(hata('personel.duzenle', { id: 'u1', rol: 'patronn' })).toBe('Rol anlaşılamadı');
    expect(hata('personel.duzenle', { id: 'u1', indirim: -1 })).toMatch(/İndirim sınırı/);
  });

  it('personel.pin: yalnız kimlik ve şifreli PIN', () => {
    const d = ok('personel.pin', { pin: SIFRELI, id: 'u1', ad: 'Ayşe' });
    expect(d.veri).toEqual({ id: 'u1', pin: SIFRELI });
    expect(Object.keys(d.veri)).toEqual(['id', 'pin']);
    expect(hata('personel.pin', { id: 'u1', pin: '2222' })).toBe('PIN şifrelenmemiş ya da bozuk');
    expect(hata('personel.pin', { pin: SIFRELI })).toBe('Personel anlaşılamadı');
  });

  it('rol.yetki: patron rolü değiştirilemez; yetkiler tekil ve listedeki sırayla', () => {
    expect(hata('rol.yetki', { rol: 'patron', izinler: [] })).toMatch(/Patron rolü/);
    expect(hata('rol.yetki', { rol: 'garson', izinler: ['siparis.al', 'uydurma'] })).toBe('Bilinmeyen yetki');
    expect(hata('rol.yetki', { rol: 'garson', izinler: 'siparis.al' })).toBe('Yetkiler anlaşılamadı');
    expect(hata('rol.yetki', { rol: 'garson', izinler: [...ALL_PERMISSIONS, 'siparis.al'] })).toBe('Yetkiler anlaşılamadı');
    const d = ok('rol.yetki', { izinler: ['urun.tukendi', 'siparis.al', 'urun.tukendi'], rol: 'garson' });
    expect(d.veri).toEqual({ rol: 'garson', izinler: ['siparis.al', 'urun.tukendi'] });
    expect(Object.keys(d.veri)).toEqual(['rol', 'izinler']);
    expect(ok('rol.yetki', { rol: 'kurye', izinler: [] }).veri).toEqual({ rol: 'kurye', izinler: [] });
  });

  it('urun.satis, secenek.satis ve ayar.servis', () => {
    expect(ok('urun.satis', { satista: false, id: 'p1', ad: 'Latte' }).veri).toEqual({ id: 'p1', satista: false });
    expect(Object.keys(ok('urun.satis', { satista: true, id: 'p1' }).veri)).toEqual(['id', 'satista']);
    expect(hata('urun.satis', { id: 'p/1', satista: true })).toBe('Ürün anlaşılamadı');
    expect(hata('urun.satis', { id: 'p1', satista: 'hayır' })).toBe('Satışta bilgisi anlaşılamadı');
    expect(ok('secenek.satis', { id: 'o1', satista: true }).veri).toEqual({ id: 'o1', satista: true });
    expect(hata('secenek.satis', { id: '', satista: true })).toBe('Seçenek anlaşılamadı');
    expect(ok('ayar.servis', { mod: 'self', fazla: 1 }).veri).toEqual({ mod: 'self' });
    expect(hata('ayar.servis', { mod: 'masa-servis' })).toBe('Servis modu anlaşılamadı');
  });
});

describe('imzaMetni', () => {
  it('kararlı: aynı komut her yerde aynı metin; sürüm, kurulum, kimlik, tür, an, kişi, rol ve veri içinde', () => {
    const a = ok('urun.satis', { satista: false, id: 'p1' });
    const b = ok('urun.satis', { id: 'p1', satista: false, ad: 'Latte' });
    const k = { id: 'k_abcdefghijklmnop', at: 1_795_000_000_000, kim: 'sahip@laffogato.net', kurulum: 'abcdef0123456789abcdef01', rol: 'sahip' as const };
    const m = imzaMetni({ ...k, tur: a.tur, veri: a.veri });
    expect(m).toBe(`${KONTROL_IMZA_ONEKI}:v${KONTROL_SURUM}:abcdef0123456789abcdef01:k_abcdefghijklmnop:urun.satis:1795000000000:sahip@laffogato.net:sahip:{"id":"p1","satista":false}`);
    expect(imzaMetni({ ...k, tur: b.tur, veri: b.veri })).toBe(m);
    // Herhangi bir alan değişince metin değişir: başka şubeye kopyalanan ya da rolü değiştirilen komutun imzası tutmaz
    expect(imzaMetni({ ...k, kim: 'baska@laffogato.net', tur: a.tur, veri: a.veri })).not.toBe(m);
    expect(imzaMetni({ ...k, at: k.at + 1, tur: a.tur, veri: a.veri })).not.toBe(m);
    expect(imzaMetni({ ...k, tur: a.tur, veri: { id: 'p1', satista: true } })).not.toBe(m);
    expect(imzaMetni({ ...k, kurulum: 'baskakurulum0123456789ab', tur: a.tur, veri: a.veri })).not.toBe(m);
    expect(imzaMetni({ ...k, rol: 'yonetici', tur: a.tur, veri: a.veri })).not.toBe(m);
    // Açık anahtarın imza metni kuruluma bağlı
    expect(anahtarImzaMetni('a1', 'MIIB')).not.toBe(anahtarImzaMetni('a2', 'MIIB'));
  });
});

describe('Vercel: api/ işlevi Node ESM olarak yüklenir', () => {
  /**
   * Vercel api/ dosyalarını dosya dosya ESM'e derler, import yollarını değiştirmez ("type": "module"): uzantısız göreli
   * yol orada çözülmez (ERR_MODULE_NOT_FOUND) ve bütün /api/* uçları 500 döner. vitest, tsx ve Vite `.js`'i `.ts`'e
   * çözdüğü için öteki testler bunu görmez. Burada api/uzaktan.ts'in eriştiği her dosya aynı biçimde derlenir (yollar
   * olduğu gibi) ve ayrı bir Node süreci yükler
   */
  it('api/uzaktan.ts ve içe aktardığı her göreli dosya uzantılı yolla yüklenir', () => {
    const root = resolve(__dirname, '..');
    // Çıplak paketler (web-push, @vercel/blob) reponun node_modules'ünden çözülsün diye derleme onun altında
    const out = join(root, 'node_modules', '.cache', `api-esm-${process.pid}-${Math.random().toString(36).slice(2)}`);
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, 'package.json'), JSON.stringify({ type: 'module' }));
    const uzantisiz: string[] = [];
    const seen = new Set<string>();
    const queue = [join(root, 'api', 'uzaktan.ts')];
    try {
      while (queue.length) {
        const file = queue.shift()!;
        if (seen.has(file)) continue;
        seen.add(file);
        const src = readFileSync(file, 'utf8');
        const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: file }).outputText;
        const dest = join(out, relative(root, file)).replace(/\.ts$/, '.js');
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, js);
        // Derlenmiş çıktıdaki çalışma anı içe aktarımları (yalnız tür olanlar silinmiştir)
        for (const [, spec] of js.matchAll(/(?:^|\n)\s*(?:import|export)\b[^'"]*?from\s*['"]([^'"]+)['"]/g)) {
          if (!spec!.startsWith('.')) continue;
          if (!spec!.endsWith('.js')) uzantisiz.push(`${relative(root, file)} → ${spec}`);
          const target = resolve(dirname(file), spec!.replace(/\.js$/, '') + '.ts');
          if (existsSync(target)) queue.push(target);
        }
      }
      expect(uzantisiz).toEqual([]);
      const url = pathToFileURL(join(out, 'api', 'uzaktan.js')).href;
      const res = execFileSync(process.execPath, ['--input-type=module', '-e', `const m = await import(${JSON.stringify(url)}); console.log(typeof m.GET, typeof m.POST);`], { cwd: out, encoding: 'utf8', timeout: 30_000 });
      expect(res.trim()).toBe('function function');
      // Sözleşme dosyası da yüklenen dosyalar arasında (api/_kontrol.ts üzerinden)
      expect([...seen].map((f) => relative(root, f))).toContain(join('shared', 'kontrol.ts'));
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);
});

function ornekDurum(): KontrolDurumu {
  return {
    v: KONTROL_SURUM,
    at: 1_795_000_000_000,
    acik: true,
    turler: [...KOMUT_TURLERI],
    anahtar: 'MIIBIjANBgkqh',
    personel: [
      { id: 'u1', ad: 'Patron', rol: 'patron', renk: '#1e4031', aktif: true, indirim: 100, sonGiris: 1_795_000_000_000 },
      { id: 'u2', ad: 'Garson', rol: 'garson', renk: '#3f6b8a', aktif: true, indirim: 10, sonGiris: null },
    ],
    roller: ROLES.map((rol) => ({ rol, izinler: rol === 'patron' ? [...ALL_PERMISSIONS] : ['siparis.al'], ozel: false, kisi: rol === 'patron' || rol === 'garson' ? 1 : 0 })),
    servisModu: 'masa',
  };
}

/** Aynı nesne, anahtarlar ters sırayla (iç içe de) */
function tersSira<T>(v: T): T {
  if (Array.isArray(v)) return v.map(tersSira) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, tersSira(x)])) as T;
  return v;
}

describe('durumParmakIzi', () => {
  it('`at` hariç; alan sırasından bağımsız; içerik değişince değişir', () => {
    const d = ornekDurum();
    const iz = durumParmakIzi(d);
    expect(iz).toMatch(/^[0-9a-f]{14}$/);
    expect(durumParmakIzi({ ...d, at: d.at + 60_000 })).toBe(iz);
    expect(JSON.stringify(tersSira(d))).not.toBe(JSON.stringify(d));
    expect(durumParmakIzi(tersSira(d))).toBe(iz);
    expect(durumParmakIzi({ ...d, acik: false })).not.toBe(iz);
    expect(durumParmakIzi({ ...d, servisModu: 'self' })).not.toBe(iz);
    expect(durumParmakIzi({ ...d, personel: [{ ...d.personel[0]!, aktif: false }, d.personel[1]!] })).not.toBe(iz);
  });

  it('durumGecerli: eksik ya da bozuk özet geçmez', () => {
    expect(durumGecerli(ornekDurum())).toBe(true);
    expect(durumGecerli(null)).toBe(false);
    expect(durumGecerli({ ...ornekDurum(), v: 0 })).toBe(false);
    const { anahtar: _a, ...eksik } = ornekDurum();
    expect(durumGecerli(eksik)).toBe(false);
  });
});

describe('uyeYapabilir', () => {
  const herTur = KOMUT_TURLERI as readonly KomutTuru[];
  it('sahip her şeyi, izleyici hiçbir şeyi yapar', () => {
    for (const tur of herTur) {
      expect(uyeYapabilir('sahip', tur, ['patron'])).toBe(true);
      expect(uyeYapabilir('izleyici', tur)).toBe(false);
      expect(uyeYapabilir('izleyici', tur, ['garson'])).toBe(false);
    }
  });

  it('yönetici: patron hesabına ve rol yetkilerine dokunamaz; gerisi serbest', () => {
    const tablo: [KomutTuru, ('patron' | 'garson' | 'mudur' | undefined)[], boolean][] = [
      ['rol.yetki', [], false],
      ['personel.ekle', ['garson'], true],
      ['personel.ekle', ['patron'], false],
      ['personel.duzenle', ['garson'], true],
      ['personel.duzenle', ['garson', 'patron'], false],
      ['personel.duzenle', ['patron', 'mudur'], false],
      ['personel.pin', ['mudur'], true],
      ['personel.pin', ['patron'], false],
      ['urun.satis', [], true],
      ['secenek.satis', [], true],
      ['ayar.servis', [], true],
    ];
    for (const [tur, hedef, beklenen] of tablo) expect(uyeYapabilir('yonetici', tur, hedef), `${tur} ${hedef.join(',')}`).toBe(beklenen);
    expect(UYE_ROLLERI).toEqual(['sahip', 'yonetici', 'izleyici']);
  });
});

describe('komutOzeti', () => {
  it('okunur kısa metin; şifreli PIN ve başka gizli değer içermez', () => {
    const adlar = { personel: { u1: 'Ayşe' }, urun: { p1: 'Latte' }, secenek: { o1: 'Yulaf sütü' } };
    const ozetler = [
      komutOzeti('personel.ekle', ok('personel.ekle', { ad: 'Can', rol: 'garson', pin: SIFRELI }).veri as never, adlar),
      komutOzeti('personel.pin', ok('personel.pin', { id: 'u1', pin: BASKA_SIFRELI }).veri as never, adlar),
      komutOzeti('personel.duzenle', ok('personel.duzenle', { id: 'u1', aktif: false, indirim: 15 }).veri as never, adlar),
      komutOzeti('rol.yetki', ok('rol.yetki', { rol: 'garson', izinler: ['siparis.al'] }).veri as never, adlar),
      komutOzeti('urun.satis', ok('urun.satis', { id: 'p1', satista: false }).veri as never, adlar),
      komutOzeti('secenek.satis', ok('secenek.satis', { id: 'o1', satista: true }).veri as never, adlar),
      komutOzeti('ayar.servis', ok('ayar.servis', { mod: 'self' }).veri as never, adlar),
    ];
    expect(ozetler).toEqual([
      'Personel ekle: Can (Garson)',
      'PIN değiştir: Ayşe',
      'Personel düzenle: Ayşe (hesabı kapat, indirim sınırı %15)',
      'Rol yetkileri: Garson (1 yetki)',
      'Tükendi: Latte',
      'Satışa aç: Yulaf sütü',
      expect.stringMatching(/^Servis modu: /),
    ]);
    for (const o of ozetler) {
      expect(o).not.toContain(SIFRELI.slice(0, 24));
      expect(o).not.toContain(BASKA_SIFRELI.slice(0, 24));
      expect(o).not.toMatch(/\d{4,}/);
    }
    // Adı bilinmeyen kimlik yerine genel ad (kimlik metne girmez)
    expect(komutOzeti('personel.pin', { id: 'u9', pin: SIFRELI })).toBe('PIN değiştir: bilinmeyen personel');
  });
});
