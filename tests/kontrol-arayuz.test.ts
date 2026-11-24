import { webcrypto } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GUN_SONU_OMRU_MS,
  KOMUT_TURLERI,
  komutDogrula,
  komutOzeti,
  KONTROL_SURUM,
  type KomutTuru,
  type KomutVerileri,
  type KontrolDurumu,
  type KontrolGecmisi,
  type KontrolPaneli,
  UYE_ROLLERI,
  type UyeRolu,
  uyeYapabilir,
} from '../shared/kontrol';
import { ROLES } from '../shared/permissions';
import type { BootstrapDTO } from '../shared/types';
import { KONTROL_HIZLI_MS, KONTROL_YAVAS_MS, komutGonder, kontrolYoklamaMs, pinSifrele, SIFRELEME_YOK } from '../src/lib/kontrol';
import {
  adHatasi,
  bekleyenHaritasi,
  genelNeden,
  gorulmeMetni,
  gunSonuNedeni,
  hedefBulucu,
  iptalNedeni,
  islemNedeni,
  kasaCevrimici,
  kimEtiketi,
  ozetAdi,
  pinGirdisi,
  pinHatasi,
  satisGorunumu,
  secenekGruplari,
  secenekOzetAdi,
  sekmeler,
  sekmeSec,
  siraMetni,
  sonGirisMetni,
  urunSatirlari,
  uygulananHaritasi,
} from '../src/pages/kontrol/yardimci';

/** Uzaktan yönetim ekranı (src/pages/kontrol, src/lib/kontrol.ts): saf yardımcılar, PIN şifrelemesi ve bağlantılar */
const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const DURUM: KontrolDurumu = {
  v: KONTROL_SURUM,
  at: 1_000,
  acik: true,
  turler: [...KOMUT_TURLERI],
  anahtar: 'MIIBIjANBgkq',
  personel: [
    { id: 'u1', ad: 'Ayşe', rol: 'garson', renk: '#3f6b8a', aktif: true, indirim: 10, sonGiris: null },
    { id: 'u2', ad: 'Ali', rol: 'kasiyer', renk: '#5e8f45', aktif: true, indirim: 15, sonGiris: 5_000 },
    { id: 'u3', ad: 'Ali Rıza', rol: 'patron', renk: '#1e4031', aktif: true, indirim: 100, sonGiris: 9_000 },
  ],
  roller: [],
  servisModu: 'masa',
};
const panel = (rol: UyeRolu, over: Partial<KontrolPaneli> = {}): Pick<KontrolPaneli, 'ben' | 'durum' | 'demo'> => ({ ben: { eposta: 'uye@ornek.test', rol }, durum: DURUM, demo: false, ...over });

/** Buluttaki özet (shared/kontrol.ts komutOzeti): ürün ve seçenekte istekteki ad, personelde kasanın bildirdiği ad */
const ADLAR = { personel: { u1: 'Ayşe', u2: 'Ali', u3: 'Ali Rıza' }, urun: { p1: 'Latte', p2: 'Mocha' }, secenek: { o1: secenekOzetAdi('Yulaf sütü', 'Süt') } };
let seq = 0;
function islem<T extends KomutTuru>(tur: T, veri: KomutVerileri[T], over: Partial<KontrolGecmisi> = {}): KontrolGecmisi {
  seq += 1;
  return { id: `k_${String(seq).padStart(16, '0')}`, tur, ozet: komutOzeti(tur, veri, ADLAR), kim: 'uye@ornek.test', at: seq, durum: 'bekliyor', mesaj: null, bitti: null, ...over };
}
const bul = hedefBulucu({
  personel: DURUM.personel.map((k) => ({ id: k.id, ad: k.ad })),
  urun: [
    { id: 'p1', ad: 'Latte' },
    { id: 'p2', ad: 'Mocha' },
  ],
  secenek: [{ id: 'o1', ad: secenekOzetAdi('Yulaf sütü', 'Süt') }],
});

describe('sekmeler', () => {
  it('Erişim (panele kim girer) yalnız sahipte; bilinmeyen sekme Ekip', () => {
    expect(sekmeler('sahip')).toEqual(['ekip', 'roller', 'menu', 'kasa', 'erisim', 'gecmis']);
    for (const rol of ['yonetici', 'izleyici', undefined] as const) expect(sekmeler(rol)).not.toContain('erisim');
    expect(sekmeSec('erisim', 'sahip')).toBe('erisim');
    expect(sekmeSec('erisim', 'yonetici')).toBe('ekip');
    expect(sekmeSec('gecmis', 'izleyici')).toBe('gecmis');
    expect(sekmeSec(null, 'sahip')).toBe('ekip');
    expect(sekmeSec('<script>', 'sahip')).toBe('ekip');
  });
});

describe('PIN ve ad denetimi', () => {
  it('PIN 4-6 rakam, tekrarıyla aynı', () => {
    expect(pinHatasi('', '').pin).toMatch(/gerekli/);
    expect(pinHatasi('123', '123').pin).toMatch(/4–6 rakam/);
    expect(pinHatasi('1234567', '1234567').pin).toMatch(/4–6 rakam/);
    expect(pinHatasi('12a4', '12a4').pin).toMatch(/4–6 rakam/);
    expect(pinHatasi('4829', '').tekrar).toMatch(/bir kez daha/);
    expect(pinHatasi('4829', '4828').tekrar).toBe('İki PIN aynı değil');
    expect(pinHatasi('4829', '4829')).toEqual({ pin: null, tekrar: null });
    expect(pinHatasi('482915', '482915')).toEqual({ pin: null, tekrar: null });
  });
  it('alan yalnız rakam alır, en çok 6', () => {
    expect(pinGirdisi('12 3a4-5678')).toBe('123456');
    expect(pinGirdisi('٣')).toBe('');
  });
  it('ad 1-40 karakter, boşluklar teke iner (kasanın kuralı)', () => {
    expect(adHatasi('   ')).toBe('Ad gerekli');
    expect(adHatasi('a'.repeat(41))).toMatch(/40/);
    expect(adHatasi(`  Ayşe   ${'b'.repeat(30)}  `)).toBeNull();
  });
});

describe('rol kapısı (düğme kapanır, nedeni yazılır)', () => {
  it('örnek görünüm, yalnız görür, kasa güncel değil, kapalı ve yeni sürüm bütün işlemleri kapatır', () => {
    expect(genelNeden(panel('sahip'))).toBeNull();
    expect(islemNedeni(panel('sahip', { demo: true }), 'urun.satis')).toMatch(/^Örnek görünüm/);
    expect(islemNedeni(panel('izleyici'), 'urun.satis')).toBe('Yalnız görme yetkiniz var');
    expect(islemNedeni(panel('sahip', { durum: null }), 'urun.satis')).toBe('Kasa güncel değil');
    // Bozuk ya da eski özetle komut gönderilmez (durumGecerli)
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, anahtar: undefined } as unknown as KontrolDurumu }), 'urun.satis')).toBe('Kasa güncel değil');
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, acik: false } }), 'urun.satis')).toBe('Kasada uzaktan yönetim kapalı');
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, v: KONTROL_SURUM + 1 } }), 'urun.satis')).toMatch(/yenileyin/);
  });
  it('kasa hiç bağlanmadıysa "güncel değil" denmez; güncelleme önerisi yalnız sahibe Merkez’le', () => {
    expect(genelNeden({ ...panel('sahip', { durum: null }), kasa: null })).toBe('Kasa henüz bağlanmadı');
    expect(genelNeden({ ...panel('sahip', { durum: null }), kasa: { sonGorulme: 1, surum: '0.3.0', build: null, gunAcik: true } })).toBe('Kasa güncel değil');
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, turler: ['urun.satis'] } }), 'ayar.servis')).toMatch(/Merkez/);
    expect(islemNedeni(panel('yonetici', { durum: { ...DURUM, turler: ['urun.satis'] } }), 'ayar.servis')).toMatch(/panelin sahibine/);
  });
  it('kasanın bilmediği işlem ve PIN anahtarı yoksa PIN işlemleri kapalı', () => {
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, turler: ['urun.satis'] } }), 'ayar.servis')).toMatch(/Merkez/);
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, anahtar: '' } }), 'personel.pin')).toMatch(/PIN anahtarı/);
    expect(islemNedeni(panel('sahip', { durum: { ...DURUM, anahtar: '' } }), 'personel.duzenle', ['garson'])).toBeNull();
  });
  it('yönetici patron hesabına ve rol yetkilerine dokunamaz; sahip her şeyi yapar', () => {
    expect(islemNedeni(panel('yonetici'), 'rol.yetki')).toBe('Rol yetkilerini yalnız sahip değiştirir');
    expect(islemNedeni(panel('yonetici'), 'personel.duzenle', ['patron'])).toBe('Patron hesabına yalnız sahip dokunur');
    expect(islemNedeni(panel('yonetici'), 'personel.pin', ['patron'])).toBe('Patron hesabına yalnız sahip dokunur');
    expect(islemNedeni(panel('yonetici'), 'personel.duzenle', ['garson', 'patron'])).toBe('Patron hesabına yalnız sahip dokunur');
    expect(islemNedeni(panel('yonetici'), 'personel.duzenle', ['garson', 'kasiyer'])).toBeNull();
    expect(islemNedeni(panel('yonetici'), 'secenek.satis')).toBeNull();
    expect(islemNedeni(panel('sahip'), 'rol.yetki')).toBeNull();
    expect(islemNedeni(panel('sahip'), 'personel.pin', ['patron'])).toBeNull();
    // Gün sonu: bulut ve kasanın nedeniyle aynı ("patron hesabı" değil)
    expect(islemNedeni(panel('yonetici'), 'gun.sonu')).toBe('Gün sonunu uzaktan yalnız sahip alır');
    expect(islemNedeni(panel('sahip'), 'gun.sonu')).toBeNull();
  });
  it('gün sonu yalnız kasa bağlıyken ve sırada gün sonu yokken; işlemin nedeni önce gelir', () => {
    const now = 10 * 86_400_000;
    const kasa = (sonGorulme: number | null) => ({ sonGorulme, surum: '1.0.0', build: null, gunAcik: true });
    const sahip = { ...panel('sahip'), kasa: kasa(now - 2 * 60_000), bekleyen: [] };
    expect(gunSonuNedeni(sahip, now)).toBeNull();
    expect(gunSonuNedeni({ ...sahip, kasa: kasa(now - 11 * 60_000) }, now)).toBe('Kasa çevrimdışı: gün sonu yalnız kasa bağlıyken uzaktan alınır');
    expect(gunSonuNedeni({ ...sahip, kasa: kasa(null) }, now)).toMatch(/^Kasa çevrimdışı/);
    expect(gunSonuNedeni({ ...sahip, bekleyen: [islem('gun.sonu', { not: '' })] }, now)).toMatch(/^Gün sonu isteği sırada/);
    // Başka bekleyen işlem gün sonunu kapatmaz
    expect(gunSonuNedeni({ ...sahip, bekleyen: [islem('ayar.servis', { mod: 'self' })] }, now)).toBeNull();
    expect(gunSonuNedeni({ ...sahip, ...panel('yonetici') }, now)).toBe('Gün sonunu uzaktan yalnız sahip alır');
    expect(gunSonuNedeni({ ...sahip, demo: true }, now)).toMatch(/^Örnek görünüm/);
  });
  it('sıraya alındı duyurusu: kasa çevrimdışıyken gün sonunun süresi 30 dakika, öteki işlemlerin 24 saat', () => {
    expect(siraMetni('gun.sonu', true)).toEqual({ ton: 'ok', metin: 'Sıraya alındı; kasa en geç 5 dakikada uygular' });
    expect(siraMetni('gun.sonu', false)).toEqual({ ton: 'warn', metin: `Sıraya alındı. Kasa şu an çevrimdışı: gün sonu ancak kasa ${GUN_SONU_OMRU_MS / 60_000} dakika içinde bağlanırsa alınır` });
    expect(siraMetni('gun.sonu', false).metin).toContain('30 dakika');
    expect(siraMetni('ayar.servis', false)).toEqual({ ton: 'warn', metin: 'Sıraya alındı. Kasa şu an çevrimdışı: açılınca uygulanır (24 saat içinde)' });
  });
  it('arayüz bulutun kuralından gevşek değil: açık düğme her zaman uyeYapabilir', () => {
    for (const rol of UYE_ROLLERI)
      for (const tur of KOMUT_TURLERI)
        for (const hedef of [undefined, ...ROLES]) {
          if (islemNedeni(panel(rol), tur, [hedef]) === null) expect(uyeYapabilir(rol, tur, [hedef]), `${rol} ${tur} ${hedef}`).toBe(true);
        }
  });
  it('iptal kasanın durumundan bağımsız; örnek görünüm ve yalnız görür iptal edemez, başkasınınkini yalnız sahip', () => {
    expect(iptalNedeni({ ben: { eposta: null, rol: 'sahip' }, demo: false })).toBeNull();
    expect(iptalNedeni({ ben: { eposta: 'a@b.co', rol: 'yonetici' } })).toBeNull();
    expect(iptalNedeni({ ben: { eposta: 'a@b.co', rol: 'izleyici' } })).toBeTruthy();
    expect(iptalNedeni({ ben: { eposta: null, rol: 'sahip' }, demo: true })).toBeTruthy();
    expect(iptalNedeni({ ben: { eposta: 'a@b.co', rol: 'yonetici' } }, { kim: 'a@b.co' })).toBeNull();
    expect(iptalNedeni({ ben: { eposta: 'a@b.co', rol: 'yonetici' } }, { kim: 'sahip@b.co' })).toMatch(/yalnız sahip/);
    expect(iptalNedeni({ ben: { eposta: 'a@b.co', rol: 'yonetici' } }, { kim: 'parola' })).toMatch(/yalnız sahip/);
    expect(iptalNedeni({ ben: { eposta: null, rol: 'sahip' } }, { kim: 'a@b.co' })).toBeNull();
  });
});

describe('bekleyen işlemin satırı (özetten)', () => {
  it('her tür kendi satırına bağlanır', () => {
    expect(bul(islem('urun.satis', { id: 'p1', satista: false }))).toEqual([{ anahtar: 'urun:p1', satista: false }]);
    expect(bul(islem('urun.satis', { id: 'p2', satista: true }))).toEqual([{ anahtar: 'urun:p2', satista: true }]);
    expect(bul(islem('secenek.satis', { id: 'o1', satista: false }))).toEqual([{ anahtar: 'secenek:o1', satista: false }]);
    expect(bul(islem('personel.pin', { id: 'u1', pin: 'x' }))).toEqual([{ anahtar: 'personel:u1' }]);
    expect(bul(islem('personel.duzenle', { id: 'u2', rol: 'garson', aktif: false }))).toEqual([{ anahtar: 'personel:u2' }]);
    expect(bul(islem('personel.duzenle', { id: 'u3', ad: 'Ali R.' }))).toEqual([{ anahtar: 'personel:u3' }]);
    expect(bul(islem('rol.yetki', { rol: 'kasiyer', izinler: ['siparis.al'] }))).toEqual([{ anahtar: 'rol:kasiyer' }]);
    expect(bul(islem('ayar.servis', { mod: 'self' }))).toEqual([{ anahtar: 'servis', mod: 'self' }]);
    // Yeni personel henüz satır değil (Ekip'te bekleyen ekleme olarak listelenir)
    expect(bul(islem('personel.ekle', { ad: 'Can', rol: 'garson', pin: 'x' }))).toEqual([]);
  });
  it('uzun ürün adı bulutun kısalttığı adla eşleşir (boşluklar teke, en çok 60 karakter)', () => {
    const uzun = `Ev   yapımı ${'çok '.repeat(20)}limonata`;
    const bul2 = hedefBulucu({ personel: [], urun: [{ id: 'p9', ad: uzun }], secenek: [] });
    const bulutAdi = uzun.trim().replace(/\s+/g, ' ').slice(0, 60);
    expect(ozetAdi(uzun)).toBe(bulutAdi);
    expect(bul2({ tur: 'urun.satis', ozet: komutOzeti('urun.satis', { id: 'p9', satista: false }, { urun: { p9: bulutAdi } }) })).toEqual([{ anahtar: 'urun:p9', satista: false }]);
  });
  it('bilinmeyen ad ve başka bir özet eşleşmez', () => {
    expect(bul({ tur: 'urun.satis', ozet: 'Tükendi: Filtre kahve' })).toEqual([]);
    expect(bul({ tur: 'urun.satis', ozet: komutOzeti('secenek.satis', { id: 'o1', satista: false }, ADLAR) })).toEqual([]);
    expect(bul({ tur: 'personel.pin', ozet: 'PIN değiştir: Veli' })).toEqual([]);
  });
  it('kuyruk sırasıyla: aynı satırın son isteği geçerli', () => {
    const h = bekleyenHaritasi([islem('urun.satis', { id: 'p1', satista: true }, { at: 50 }), islem('urun.satis', { id: 'p1', satista: false }, { at: 10 })], bul);
    expect(h.get('urun:p1')?.map((x) => x.hedef.satista)).toEqual([false, true]);
    expect(satisGorunumu('urun:p1', false, h, new Map())).toEqual({ satista: true, bekliyor: true });
  });
  it('kasada uygulanıp menü özetine yansımamış işlem görünür; yeni özet gelince düşer, reddedilen sayılmaz', () => {
    const gecmis = [
      islem('urun.satis', { id: 'p2', satista: false }, { durum: 'uygulandi', bitti: 200 }),
      islem('urun.satis', { id: 'p1', satista: false }, { durum: 'reddedildi', mesaj: 'Ürün bulunamadı', bitti: 210 }),
      islem('secenek.satis', { id: 'o1', satista: false }, { durum: 'uygulandi', bitti: 90 }),
    ];
    const once = uygulananHaritasi(gecmis, 100, bul);
    expect(satisGorunumu('urun:p2', true, new Map(), once)).toEqual({ satista: false, bekliyor: false });
    expect(satisGorunumu('urun:p1', true, new Map(), once)).toEqual({ satista: true, bekliyor: false });
    expect(satisGorunumu('secenek:o1', true, new Map(), once)).toEqual({ satista: true, bekliyor: false });
    expect(satisGorunumu('urun:p2', true, new Map(), uygulananHaritasi(gecmis, 300, bul))).toEqual({ satista: true, bekliyor: false });
  });
});

describe('menü satırları ve kişiler', () => {
  const boot = {
    categories: [
      { id: 'c2', name: 'Tatlılar', sort: 2 },
      { id: 'c1', name: 'Kahveler', sort: 1 },
    ],
    products: [
      { id: 'p3', categoryId: 'c2', name: 'Tiramisu', shortName: null, sort: 1, active: true, soldOutBy: null, hidden: false, isService: false, optionGroupIds: [] },
      { id: 'p1', categoryId: 'c1', name: 'Latte', shortName: 'Latte', sort: 2, active: false, soldOutBy: 'site', hidden: false, isService: false, optionGroupIds: ['g1'] },
      { id: 'p2', categoryId: 'c1', name: 'Americano', shortName: null, sort: 1, active: true, soldOutBy: null, hidden: false, isService: false, optionGroupIds: [] },
      { id: 'p4', categoryId: 'c1', name: 'Gizli', shortName: null, sort: 0, active: true, soldOutBy: null, hidden: true, isService: false, optionGroupIds: ['g2'] },
      { id: 'p5', categoryId: 'c1', name: 'Servis', shortName: null, sort: 0, active: true, soldOutBy: null, hidden: false, isService: true, optionGroupIds: [] },
    ],
    optionGroups: [
      {
        id: 'g1',
        name: 'Süt',
        items: [
          { id: 'o1', name: 'Yulaf sütü', code: null, soldOut: true },
          { id: 'o0', name: 'Hiçbiri', code: 'none', soldOut: false },
        ],
      },
      { id: 'g2', name: 'Yalnız gizli üründe', items: [{ id: 'o9', name: 'X', code: null, soldOut: false }] },
    ],
  } as unknown as BootstrapDTO;
  it('gizli ve hizmet kalemi yok; kategori ve ürün sırasıyla; sitenin kapattığı ayrı', () => {
    expect(urunSatirlari(boot).map((u) => u.id)).toEqual(['p2', 'p1', 'p3']);
    expect(urunSatirlari(boot).find((u) => u.id === 'p1')).toMatchObject({ satista: false, site: true, kategori: 'Kahveler' });
  });
  it('seçenekler satılan ürüne bağlı gruplarda; "hiçbiri" listelenmez; özetteki ad grubun adıyla', () => {
    const g = secenekGruplari(boot);
    expect(g.map((x) => x.id)).toEqual(['g1']);
    expect(g[0].secenekler).toEqual([{ id: 'o1', ad: 'Yulaf sütü', ozetAdi: 'Yulaf sütü (Süt)', satista: false }]);
    expect(g[0].kullanan).toEqual(['Latte']);
  });
  it('kim, son görülme ve çevrimiçi', () => {
    expect(kimEtiketi('parola', null)).toBe('Siz');
    expect(kimEtiketi('parola', 'uye@ornek.test')).toBe('Parolalı giriş');
    expect(kimEtiketi('Uye@Ornek.test', 'uye@ornek.test')).toBe('Siz');
    expect(kimEtiketi('INFO@ornek.test', 'info@ornek.test')).toBe('Siz');
    expect(kimEtiketi('baska@ornek.test', 'uye@ornek.test')).toBe('baska@ornek.test');
    const now = 10 * 86_400_000;
    expect(gorulmeMetni(null, now)).toBe('hiç bağlanmadı');
    expect(gorulmeMetni(now - 20_000, now)).toBe('az önce');
    expect(gorulmeMetni(now - 12 * 60_000, now)).toBe('12 dk önce');
    expect(gorulmeMetni(now - 3 * 3600_000, now)).toBe('3 sa önce');
    expect(gorulmeMetni(now - 3 * 86_400_000, now)).toMatch(/\d{2}\.\d{2}\.\d{4}/);
    expect(kasaCevrimici(now - 6 * 60_000, now)).toBe(true);
    expect(kasaCevrimici(now - 11 * 60_000, now)).toBe(false);
    expect(kasaCevrimici(null, now)).toBe(false);
    // Son giriş saat başına yuvarlı gelir: dakika gösterilmez
    expect(sonGirisMetni(null, now)).toBe('Hiç girmedi');
    expect(sonGirisMetni(now - 46 * 60_000, now)).toBe('Son giriş son bir saat içinde');
    expect(sonGirisMetni(now - 3 * 3600_000 - 10 * 60_000, now)).toBe('Son giriş yaklaşık 3 sa önce');
    expect(sonGirisMetni(now - 3 * 86_400_000, now)).toMatch(/^Son giriş \d{2}\.\d{2}\.\d{4}.* sularında$/);
  });
});

describe('yoklama', () => {
  it('bekleyen varken ve kasa çevrimiçiyken 15 sn; yokken ya da kasa kapalıyken 60 sn (Redis bütçesi)', () => {
    const now = 10 * 86_400_000;
    const kasa = (sonGorulme: number | null) => ({ sonGorulme, surum: '1.0.0', build: null, gunAcik: true });
    const bekleyen = [islem('ayar.servis', { mod: 'masa' })];
    expect(kontrolYoklamaMs({ bekleyen, kasa: kasa(now - 2 * 60_000) }, now)).toBe(KONTROL_HIZLI_MS);
    expect(kontrolYoklamaMs({ bekleyen, kasa: kasa(now - 6 * 3_600_000) }, now)).toBe(KONTROL_YAVAS_MS);
    expect(kontrolYoklamaMs({ bekleyen, kasa: null }, now)).toBe(KONTROL_YAVAS_MS);
    expect(kontrolYoklamaMs({ bekleyen: [], kasa: kasa(now) }, now)).toBe(KONTROL_YAVAS_MS);
    expect(kontrolYoklamaMs(undefined)).toBe(KONTROL_YAVAS_MS);
    expect([KONTROL_HIZLI_MS, KONTROL_YAVAS_MS]).toEqual([15_000, 60_000]);
  });
});

describe('PIN şifrelemesi (Web Crypto, RSA-OAEP SHA-256)', () => {
  const subtle = webcrypto.subtle;
  afterEach(() => vi.unstubAllGlobals());
  async function anahtarlar() {
    const kp = await webcrypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
    const spki = Buffer.from(await webcrypto.subtle.exportKey('spki', kp.publicKey)).toString('base64');
    return { spki, ozel: kp.privateKey };
  }
  it('kasanın açık anahtarıyla şifrelenir, yalnız özel anahtar çözer; sözleşmenin biçimine uyar', async () => {
    const { spki, ozel } = await anahtarlar();
    const sifreli = await pinSifrele('482915', spki, subtle);
    expect(sifreli).not.toContain('482915');
    expect(sifreli).toHaveLength(344);
    expect(komutDogrula('personel.pin', { id: 'u1', pin: sifreli }).ok).toBe(true);
    const acik = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, ozel, Buffer.from(sifreli, 'base64'));
    expect(new TextDecoder().decode(acik)).toBe('482915');
    // OAEP rastgele: aynı PIN her seferinde başka metin
    expect(await pinSifrele('482915', spki, subtle)).not.toBe(sifreli);
    // base64url ve dolgusuz anahtar da okunur
    const url = spki.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const ikinci = await pinSifrele('4829', url, subtle);
    expect(new TextDecoder().decode(await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, ozel, Buffer.from(ikinci, 'base64')))).toBe('4829');
  });
  it('Web Crypto yoksa ya da anahtar bozuksa açıklayıcı ileti; ileti PIN içermez', async () => {
    await expect(pinSifrele('482915', 'MIIB', null)).rejects.toThrow(SIFRELEME_YOK);
    const e = await pinSifrele('482915', 'bozuk-anahtar', subtle).catch((x: Error) => x);
    expect(e).toBeInstanceOf(Error);
    expect((e as Error).message).toMatch(/anahtarı okunamadı/);
    expect((e as Error).message).not.toContain('482915');
  });
  it('açık PIN gönderilemez: komut istek gitmeden reddedilir', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(komutGonder({ tur: 'personel.pin', veri: { id: 'u1', pin: '4829' } })).rejects.toThrow(/şifrelenmemiş/);
    await expect(komutGonder({ tur: 'personel.ekle', veri: { ad: 'Can', rol: 'garson', pin: '482915' } })).rejects.toThrow(/şifrelenmemiş/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('komut gönderimi', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('"Gün sonu al ve güncelle" güncelleme isteğini de taşır (düşüyordu); başka işlemde gitmez', async () => {
    const giden: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        giden.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ ok: true, komut: islem('gun.sonu', { not: '' }) }), { status: 200 });
      }),
    );
    await komutGonder({ tur: 'gun.sonu', veri: { not: '' }, guncelle: true });
    await komutGonder({ tur: 'gun.sonu', veri: { not: '' } });
    await komutGonder({ tur: 'ayar.servis', veri: { mod: 'self' }, guncelle: true });
    expect(giden).toEqual([{ tur: 'gun.sonu', veri: { not: '' }, guncelle: true }, { tur: 'gun.sonu', veri: { not: '' } }, { tur: 'ayar.servis', veri: { mod: 'self' } }]);
  });
  it('gün sonu sekmesi sıraya alındığını ikinci kez duyurmaz (gonder duyurur)', () => {
    const kasa = read('src/pages/kontrol/KasaSekmesi.tsx');
    expect(kasa).toContain('gunSonuNedeni(panel, now)');
    expect(kasa).not.toMatch(/toast\.ok\(/);
  });
});

describe('ekran bağlantıları', () => {
  const files = (dir: string): string[] => readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]));
  const kaynaklar = [...files('src/pages/kontrol'), 'src/lib/kontrol.ts'].map((f) => ({ f, text: read(f) }));

  it('yalnız Uzaktan’da: rota, menüde Merkez’in yanında, patron panelinde kart', async () => {
    const { KONTROL_NAV, KONTROL_PATH, MERKEZ_NAV, DOWNLOAD_NAV } = await import('../src/lib/download');
    const { REMOTE_PATHS, remoteNav } = await import('../src/lib/remote');
    expect(KONTROL_PATH).toBe('/uzaktan-yonetim');
    expect(REMOTE_PATHS).toContain(KONTROL_PATH);
    expect(remoteNav([], true)).toEqual([MERKEZ_NAV, KONTROL_NAV, DOWNLOAD_NAV]);
    expect(remoteNav([], false)).toEqual([]);
    // Merkez yalnız sahibe; parolasız görünümde ikisi de yok (uçları 403 der)
    expect(remoteNav([], true, { merkez: false, kontrol: true })).toEqual([KONTROL_NAV, DOWNLOAD_NAV]);
    expect(remoteNav([], true, { merkez: false, kontrol: false })).toEqual([DOWNLOAD_NAV]);
    expect(KONTROL_NAV.title).toBe('Uzaktan yönetim');
    const app = read('src/App.tsx');
    expect(app).toMatch(/const KontrolPage = lazy\(\(\) => import\('\.\/pages\/kontrol\/KontrolPage'\)\);/);
    expect(app).toContain('{REMOTE && <Route path={KONTROL_PATH} element={<KontrolPage />} />}');
    expect(read('src/pages/patron/PatronPage.tsx')).toMatch(/\{REMOTE && <UzaktanYonetimKarti /);
  });
  it('davet edilen kişi giriş ekranında kodla ilk girişi açar; Erişim’in notu aynı düğmeyi anar', () => {
    const giris = read('src/pages/RemoteLoginPage.tsx');
    expect(giris).toContain("'Davet kodum var'");
    // Üyelik açıkken ('ready') de ilk giriş formu açılır: davet kodu, parola ve tekrarı /uzaktan/uye'ye
    expect(giris).toContain("const creating = member === 'new' || (!!member && davetKodum);");
    expect(read('src/pages/kontrol/ErisimSekmesi.tsx')).toContain('Üye girişi › Davet kodum var');
  });
  it('uzaktan e2e taramasında (telefon, tablet, bilgisayar, koyu; sekmeleriyle)', () => {
    const e2e = read('e2e/uzaktan.mjs');
    for (const s of ['', '?sekme=roller', '?sekme=menu', '?sekme=kasa', '?sekme=erisim', '?sekme=gecmis']) expect(e2e).toContain(`'/uzaktan-yonetim${s}'`);
  });
  it('PIN ve gizli değer günlüğe ve tarayıcı depolamasına yazılmaz; renk yalnız belirteçten', () => {
    for (const { f, text } of kaynaklar) {
      expect(text, f).not.toMatch(/console\.(log|info|warn|error|debug)/);
      expect(text, f).not.toMatch(/localStorage|sessionStorage|indexedDB/);
      expect(text, f).not.toMatch(/(?:bg|text|border|ring|fill|stroke)-\[#[0-9a-fA-F]{3,8}\]|['"]#[0-9a-fA-F]{6}['"]/);
    }
  });
  it('PIN alanı gizli yazılır, rakam klavyesi açar, tarayıcı saklamaz; gönderimden sonra boşalır', () => {
    const ekip = read('src/pages/kontrol/EkipSekmesi.tsx');
    // Şifre kutusu (PasswordInput): kapalıyken type="password", rakamlar sayfaya yazılmaz
    expect(ekip).toMatch(/const ortak = \{ inputMode: 'numeric'[^}]*autoComplete: 'off'/);
    expect(ekip.match(/<PasswordInput \{\.\.\.ortak\}/g)).toHaveLength(2);
    // Her PIN gönderiminin finally bloğu alanı boşaltır
    const gonderim = ekip.match(/finally \{[^}]*\}/g) ?? [];
    expect(gonderim.filter((b) => b.includes("setPin('')") && b.includes("setTekrar('')"))).toHaveLength(2);
  });
});
