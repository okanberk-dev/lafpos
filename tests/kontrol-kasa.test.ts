import { createHmac, createPublicKey } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  anahtarImzaMetni,
  durumGecerli,
  HIZLI_NABIZ_MS,
  HIZLI_SURE_MS,
  imzaMetni,
  KOMUT_OMRU_MS,
  KOMUT_TURLERI,
  komutDogrula,
  type KomutKaydi,
  type KomutSonucu,
  type KomutTuru,
  type NabizKontrol,
  type NabizKontrolYaniti,
  SAAT_PAYI_MS,
  type UyeRolu,
} from '@shared/kontrol';
import { ALL_PERMISSIONS, ROLE_DEFAULTS } from '@shared/permissions';
import { type Harness, startApp } from './harness';

/**
 * Uzaktan yönetim, kasa tarafı (server/sync/kontrol.ts, docs/UZAKTAN-YONETIM.md): imza, tekrar, süre, kasadaki anahtar,
 * PIN'in çözülüp yeni PIN'le girilmesi, son patronun korunması, sonuçların nabızla bildirilmesi, eski bulut. Komutlar
 * bulutun yapacağı gibi imzalanır, PIN tarayıcının yapacağı gibi Web Crypto ile şifrelenir; Merkez sahte (bellekte)
 */
const CLOUD = 'https://merkez-kontrol.test';
const SECRET = 'k'.repeat(40);
const KIM = 'sahip@laffogato.test';
const YENI_PIN = '739153';
const GARSON_PIN = '864209';
let h: Harness;

/** Sahte Merkez: her nabzın gövdesi `gelen`e; yanıtın `kontrol`ü `siradaki`nden (boşsa komutsuz) */
const gelen: { kontrol?: NabizKontrol }[] = [];
let siradaki: Partial<NabizKontrolYaniti>[] = [];
let eskiBulut = false;
let hepDurumIste = false;
/** Şifreli PIN'ler (kasada da hiçbir yerde saklanmamalı) */
const sifreliler: string[] = [];
const loglar: unknown[][] = [];

beforeAll(async () => {
  h = await startApp();
  // Kurulum verisi self serviste: testin tabanı masaya servis (servis modu komutları değişikliği görsün)
  await h.ok('patron', 'PUT', '/admin/settings', { serviceMode: 'masa' });
  const { env } = await import('../server/env');
  Object.assign(env, { merkezUrl: CLOUD, cloudSecret: SECRET });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === `${CLOUD}/api/merkez/kayit`) return Response.json({ ok: true });
    if (url === `${CLOUD}/api/merkez/nabiz`) {
      gelen.push(JSON.parse(String(init?.body ?? '{}')));
      const kontrol = eskiBulut ? undefined : { durumIste: hepDurumIste, komutlar: [], ...(siradaki.shift() ?? {}) };
      return Response.json({ ok: true, lisans: { durum: 'aktif' }, mod: 'elle', ...(kontrol ? { kontrol } : {}) });
    }
    return realFetch(input, init);
  });
  // Günlüğe ne yazılırsa (açık PIN hiçbirinde olmamalı)
  for (const m of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...args: unknown[]) => void loglar.push(args));
}, 60_000);
afterAll(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  h?.cleanup();
});

const kontrol = () => import('../server/sync/kontrol');

let seq = 0;
const yeniId = () => `k_test${String(++seq).padStart(4, '0')}abcdefghijkl`;

/** Bu kasanın Merkez kurulum kimliği (bulut komutu bununla imzalar) */
let KURULUM = '';
beforeAll(async () => {
  KURULUM = (await import('../server/sync/merkez')).identity().id;
});

function imzala(k: Pick<KomutKaydi, 'id' | 'tur' | 'veri' | 'at' | 'kim' | 'kurulum' | 'rol'>, secret = SECRET): string {
  return createHmac('sha256', secret).update(imzaMetni(k)).digest('base64url');
}

/** Bulutun kuyruğa koyduğu gibi: doğrulanmış veri, kurulum ve üyenin rolü, imza */
function komut(tur: KomutTuru, veri: unknown, o: { at?: number; kim?: string; secret?: string; id?: string; kurulum?: string; rol?: UyeRolu } = {}): KomutKaydi {
  const d = komutDogrula(tur, veri);
  if (!d.ok) throw new Error(d.hata);
  const base = { id: o.id ?? yeniId(), tur: d.tur, veri: d.veri, at: o.at ?? Date.now(), kim: o.kim ?? KIM, kurulum: o.kurulum ?? KURULUM, rol: o.rol ?? 'sahip' };
  return { ...base, ozet: 'Bulutun özeti', imza: imzala(base, o.secret) };
}

/** Tarayıcının yapacağı gibi: kasanın açık anahtarıyla RSA-OAEP (SHA-256), Web Crypto */
async function sifrele(pin: string): Promise<string> {
  const { kontrolDurumu } = await kontrol();
  const key = await crypto.subtle.importKey('spki', Buffer.from(kontrolDurumu().anahtar, 'base64'), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const out = Buffer.from(await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(pin))).toString('base64');
  sifreliler.push(out);
  return out;
}

async function bekleyenler(): Promise<KomutSonucu[]> {
  const { getSyncState } = await import('../server/lib/settings');
  return getSyncState<KomutSonucu[]>('kontrol.sonuclar') ?? [];
}

/** Komutları nabız yanıtındaki gibi işler; her komutun bildirilecek sonucu */
async function uygula(...komutlar: KomutKaydi[]): Promise<KomutSonucu[]> {
  const { kontrolYaniti } = await kontrol();
  await kontrolYaniti({ durumIste: false, komutlar });
  const list = await bekleyenler();
  return komutlar.map((c) => list.find((s) => s.id === c.id)!);
}

async function audits(action?: string) {
  const { db, schema } = await import('../server/db/client');
  return db
    .select()
    .from(schema.auditLog)
    .all()
    .filter((a) => !action || a.action === action);
}

type UserRow = { id: string; name: string; role: string; active: boolean; maxDiscountPct: number };
const users = () => h.ok<UserRow[]>('patron', 'GET', '/admin/users');
const login = (pin: string) => h.call<{ me: { name: string } }>('', 'POST', '/auth/login', { pin });

async function settings() {
  const { getSettings } = await import('../server/lib/settings');
  return getSettings();
}

let eklenen: KomutKaydi;

describe('Uzaktan yönetim: kasa', () => {
  it('özet: personel PIN’siz, roller ve servis modu; anahtar bir kez üretilir; özet yalnız değişince ya da istenince gider', async () => {
    const k = await kontrol();
    const d = k.kontrolDurumu();
    expect(durumGecerli(d)).toBe(true);
    expect(d).toMatchObject({ v: 1, acik: true, servisModu: 'masa', turler: [...KOMUT_TURLERI] });
    expect(d.personel.map((p) => p.ad)).toEqual(expect.arrayContaining(['Patron', 'Müdür', 'Kasa', 'Garson']));
    for (const p of d.personel) {
      expect(Object.keys(p)).toEqual(['id', 'ad', 'rol', 'renk', 'aktif', 'indirim', 'sonGiris']);
      // Son giriş saat başına yuvarlı (her girişte özet değişmesin)
      if (p.sonGiris != null) expect(p.sonGiris % 3_600_000).toBe(0);
    }
    expect(d.roller.find((r) => r.rol === 'patron')).toEqual({ rol: 'patron', izinler: ALL_PERMISSIONS, ozel: false, kisi: 1 });
    expect(d.roller.find((r) => r.rol === 'garson')).toMatchObject({ ozel: false, kisi: 1 });
    // Açık anahtar RSA 2048 (SPKI); bir kez üretilir, sonra hep aynı
    const pub = createPublicKey({ key: Buffer.from(d.anahtar, 'base64'), format: 'der', type: 'spki' });
    expect(pub.asymmetricKeyDetails?.modulusLength).toBe(2048);
    expect(k.kontrolDurumu().anahtar).toBe(d.anahtar);
    // Anahtar kuruluma bağlı olarak ortak anahtarla imzalı: bulut panele yalnız bu tutarsa verir
    expect(d.anahtarImza).toBe(createHmac('sha256', SECRET).update(anahtarImzaMetni(KURULUM, d.anahtar)).digest('base64url'));
    // Özet ilk nabızda gider; iletildikten sonra yalnız değişince ya da bulut isteyince
    const ilk = k.nabizKontrol(false);
    expect(ilk.durum).toBeDefined();
    k.nabizIletildi(ilk);
    expect(k.nabizKontrol(false)).toEqual({ ozet: ilk.ozet });
    expect(k.nabizKontrol(true).durum).toBeDefined();
    const garson = (await users()).find((u) => u.name === 'Garson')!;
    await h.ok('patron', 'PATCH', `/admin/users/${garson.id}`, { maxDiscountPct: 12 });
    const sonra = k.nabizKontrol(false);
    expect(sonra.ozet).not.toBe(ilk.ozet);
    expect(sonra.durum?.personel.find((p) => p.id === garson.id)?.indirim).toBe(12);
  });

  it('ağdan gelen istek uzaktan kimliğini taşıyamaz: kimlik istek nesnesinin kendisine bağlı', async () => {
    const { internalActors, remoteActor } = await import('../server/lib/auth');
    const { createApp } = await import('../server/app');
    const app = createApp();
    const uydurma: Record<string, string>[] = [{}, { authorization: 'Bearer uzaktan-kontrol' }, { authorization: 'Bearer uzaktan' }, { 'x-laf-kurulum': 'uzaktan' }];
    for (const headers of uydurma) {
      expect((await h.call('', 'PUT', '/admin/settings', { tipsEnabled: false }, headers)).status).toBe(401);
    }
    const make = () => new Request('http://kasa.local/api/admin/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tipsEnabled: false }) });
    const kayitli = make();
    internalActors.set(kayitli, remoteActor(KIM));
    try {
      // Aynı adres, başlık ve gövdeyle başka bir istek nesnesi (ağdan gelen gibi) kimliği taşımaz
      expect((await app.fetch(make())).status).toBe(401);
      expect((await app.fetch(kayitli.clone())).status).toBe(401);
      expect((await app.fetch(kayitli)).status).toBe(200);
    } finally {
      internalActors.delete(kayitli);
    }
    expect(remoteActor('parola').name).toBe('Uzaktan (parolalı giriş)');
    expect(remoteActor(KIM)).toMatchObject({ id: 'uzaktan', name: `Uzaktan (${KIM})`, role: 'patron', maxDiscountPct: 100, sessionId: 'uzaktan-kontrol' });
  });

  it('personel.ekle: kişi açılır ve yeni PIN’le giriş yapılır; denetim kaydında Uzaktan (e-posta)', async () => {
    eklenen = komut('personel.ekle', { ad: 'Uzak Ayşe', rol: 'garson', indirim: 5, renk: '#AA3366', pin: await sifrele(YENI_PIN) });
    const [s] = await uygula(eklenen);
    expect(s).toMatchObject({ id: eklenen.id, durum: 'uygulandi', mesaj: 'Uygulandı' });
    expect((await users()).find((u) => u.name === 'Uzak Ayşe')).toMatchObject({ role: 'garson', active: true, maxDiscountPct: 5 });
    const r = await login(YENI_PIN);
    expect(r.status).toBe(200);
    expect(r.json.me.name).toBe('Uzak Ayşe');
    const a = (await audits('user.create')).at(-1)!;
    expect(a).toMatchObject({ userId: 'uzaktan', message: `Uzaktan (${KIM}) personel ekledi: Uzak Ayşe (garson)` });
  });

  it('aynı komut ikinci kez uygulanmaz; sonucu bildirildiyse aynı sonuçla yeniden bildirilir', async () => {
    const k = await kontrol();
    const once = (await users()).length;
    await k.kontrolYaniti({ durumIste: false, komutlar: [eklenen, eklenen] });
    expect((await users()).length).toBe(once);
    expect((await bekleyenler()).filter((s) => s.id === eklenen.id)).toHaveLength(1);
    // Bildirildi (bulut kuyruktan silmedi, yeniden gönderdi): uygulanmaz, sonucu yeniden gider. İkinci kez uygulansaydı
    // PIN tekilliği reddederdi
    k.nabizIletildi({ ozet: '', sonuclar: await bekleyenler() });
    expect(await bekleyenler()).toEqual([]);
    await k.kontrolYaniti({ durumIste: false, komutlar: [eklenen] });
    expect((await users()).length).toBe(once);
    expect(await bekleyenler()).toEqual([expect.objectContaining({ id: eklenen.id, durum: 'uygulandi', mesaj: 'Uygulandı' })]);
  });

  it('personel.pin: eski PIN’le giriş düşer, yeni PIN’le girer; açık oturumu kapanır', async () => {
    const garson = (await users()).find((u) => u.name === 'Garson')!;
    expect((await login('2222')).status).toBe(200);
    const c = komut('personel.pin', { id: garson.id, pin: await sifrele(GARSON_PIN) });
    const [s] = await uygula(c);
    expect(s).toMatchObject({ durum: 'uygulandi' });
    expect((await login('2222')).status).toBe(401);
    expect((await login(GARSON_PIN)).status).toBe(200);
    expect((await h.call('garson', 'GET', '/bootstrap')).status).toBe(401);
    expect((await audits('user.update')).at(-1)!.message).toBe(`Uzaktan (${KIM}) Garson hesabını güncelledi (PIN değişti)`);
    // Başkasının PIN'i verilemez: kasanın kuralı, PIN'siz ileti
    const [taken] = await uygula(komut('personel.pin', { id: garson.id, pin: await sifrele('1897') }));
    expect(taken).toMatchObject({ durum: 'reddedildi', mesaj: 'Bu PIN kullanılamaz; farklı bir PIN seçin' });
  });

  it('bozuk imza, değiştirilmiş veri ve kişi reddedilir; hiçbir şey değişmez, önemli kayıt bir kez düşer', async () => {
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const yanlisAnahtar = komut('ayar.servis', { mod: 'self' }, { secret: 'y'.repeat(40) });
    const veriDegisti = { ...komut('urun.satis', { id: latte.id, satista: true }), veri: { id: latte.id, satista: false } } as KomutKaydi;
    const kisiDegisti = { ...komut('ayar.servis', { mod: 'self' }), kim: 'baska@laffogato.test' };
    const imzasiz = { ...komut('ayar.servis', { mod: 'self' }), imza: '' };
    // Başka şubenin kuyruğundan kopyalanan (ortak anahtar aynı) ve rolü yükseltilen komut
    const baskaSube = komut('ayar.servis', { mod: 'self' }, { kurulum: 'baskasubenin0kurulumu0000' });
    const rolDegisti = { ...komut('ayar.servis', { mod: 'self' }, { rol: 'yonetici' }), rol: 'sahip' } as KomutKaydi;
    const rolsuz = { ...komut('ayar.servis', { mod: 'self' }), rol: undefined } as unknown as KomutKaydi;
    const alarmOnce = (await audits('uzaktan.imza')).length;
    const sonuclar = await uygula(yanlisAnahtar, veriDegisti, kisiDegisti, imzasiz, baskaSube, rolDegisti, rolsuz);
    for (const s of sonuclar) expect(s).toMatchObject({ durum: 'reddedildi', mesaj: expect.stringMatching(/^İmza tutmadı/) });
    expect((await settings()).serviceMode).toBe('masa');
    expect((await h.ok<{ products: { id: string; active: boolean }[] }>('kasa', 'GET', '/bootstrap')).products.find((p) => p.id === latte.id)!.active).toBe(true);
    const alarmlar = await audits('uzaktan.imza');
    expect(alarmlar).toHaveLength(alarmOnce + 1);
    expect(alarmlar.at(-1)).toMatchObject({ severity: 'alarm', data: { sayi: 7 } });
    // Doğrulanamayan komut da uygulanmaz; bilinen bir komutun sonucunu ezemez
    const [bozuk] = await uygula({ ...komut('ayar.servis', { mod: 'self' }), tur: 'ayar.sil' as KomutTuru });
    expect(bozuk).toMatchObject({ durum: 'reddedildi', mesaj: 'Bilinmeyen işlem' });
    await uygula({ ...eklenen, veri: { ad: '' } as never });
    expect((await bekleyenler()).find((s) => s.id === eklenen.id)).toMatchObject({ durum: 'uygulandi' });
  });

  it('süresi dolmuş ve gelecekten gelen komut reddedilir; saat payı içindeki uygulanır', async () => {
    const now = Date.now();
    const [eski, ileri, payIcinde] = await uygula(
      komut('ayar.servis', { mod: 'self' }, { at: now - KOMUT_OMRU_MS - 60_000 }),
      komut('ayar.servis', { mod: 'yari_self' }, { at: now + SAAT_PAYI_MS + 60_000 }),
      komut('ayar.servis', { mod: 'self' }, { at: now + 60_000 }),
    );
    expect(eski).toMatchObject({ durum: 'reddedildi', mesaj: expect.stringMatching(/Süresi doldu/) });
    expect(ileri).toMatchObject({ durum: 'reddedildi', mesaj: expect.stringMatching(/ileride/) });
    expect(payIcinde).toMatchObject({ durum: 'uygulandi' });
    expect((await settings()).serviceMode).toBe('self');
    await uygula(komut('ayar.servis', { mod: 'masa' }));
    expect((await settings()).serviceMode).toBe('masa');
    // Reddedilen işlem de kasanın kaydına düşer (kimin istediği ve nedeni)
    expect((await audits('uzaktan.red')).some((a) => a.message === `Uzaktan (${KIM}) isteği reddedildi: Servis modu: Self servis. Neden: Süresi doldu: 24 saat içinde kasaya ulaşmadı`)).toBe(true);
  });

  it('rol.yetki: patron rolü reddedilir; başka rolün yetkileri uygulanır', async () => {
    const id = yeniId();
    const veri = { rol: 'patron', izinler: [] };
    const at = Date.now();
    const patronu = { id, tur: 'rol.yetki', veri, at, kim: KIM, kurulum: KURULUM, rol: 'sahip', ozet: 'x', imza: imzala({ id, tur: 'rol.yetki', veri: veri as never, at, kim: KIM, kurulum: KURULUM, rol: 'sahip' }) } as KomutKaydi;
    const [red] = await uygula(patronu);
    expect(red).toMatchObject({ durum: 'reddedildi', mesaj: expect.stringMatching(/Patron rolü/) });
    const [s] = await uygula(komut('rol.yetki', { rol: 'garson', izinler: ['siparis.al', 'urun.tukendi'] }));
    expect(s).toMatchObject({ durum: 'uygulandi' });
    const roles = await h.ok<{ roles: { role: string; permissions: string[]; custom: boolean }[] }>('patron', 'GET', '/admin/roles');
    expect(roles.roles.find((r) => r.role === 'garson')).toMatchObject({ permissions: ['siparis.al', 'urun.tukendi'], custom: true });
    expect((await audits('role.permissions')).at(-1)).toMatchObject({ userId: 'uzaktan' });
    // Varsayılana dönünce özel kayıt silinir
    await uygula(komut('rol.yetki', { rol: 'garson', izinler: ROLE_DEFAULTS.garson }));
    expect((await h.ok<{ roles: { role: string; custom: boolean }[] }>('patron', 'GET', '/admin/roles')).roles.find((r) => r.role === 'garson')!.custom).toBe(false);
  });

  it('son patron kapatılamaz, rolü değiştirilemez (assertPatronRemains): ret, neden ve kayıt', async () => {
    const patron = (await users()).find((u) => u.role === 'patron')!;
    const [kapat, rol] = await uygula(komut('personel.duzenle', { id: patron.id, aktif: false }), komut('personel.duzenle', { id: patron.id, rol: 'mudur' }));
    for (const s of [kapat, rol]) expect(s).toMatchObject({ durum: 'reddedildi', mesaj: 'Personel yönetimi olan son etkin patron hesabı kapatılamaz, rolü değiştirilemez' });
    expect((await users()).find((u) => u.id === patron.id)).toMatchObject({ role: 'patron', active: true });
    expect((await audits('uzaktan.red')).at(-1)!.message).toBe(
      `Uzaktan (${KIM}) isteği reddedildi: Personel düzenle: Patron (rol Müdür). Neden: Personel yönetimi olan son etkin patron hesabı kapatılamaz, rolü değiştirilemez`,
    );
    // Patron olmayan personel düzenlenir
    const ayse = (await users()).find((u) => u.name === 'Uzak Ayşe')!;
    const [s] = await uygula(komut('personel.duzenle', { id: ayse.id, ad: 'Uzak Ayşe K.', indirim: 15, aktif: false }));
    expect(s).toMatchObject({ durum: 'uygulandi' });
    expect((await users()).find((u) => u.id === ayse.id)).toMatchObject({ name: 'Uzak Ayşe K.', maxDiscountPct: 15, active: false });
    expect((await login(YENI_PIN)).status).toBe(401);
  });

  it('urun.satis, secenek.satis ve ayar.servis kasanın kendi ucuyla uygulanır', async () => {
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const secenek = db.select().from(schema.optionItems).where(eq(schema.optionItems.active, true)).get()!;
    const sonuclar = await uygula(komut('urun.satis', { id: latte.id, satista: false }), komut('secenek.satis', { id: secenek.id, satista: false }), komut('ayar.servis', { mod: 'yari_self' }));
    for (const s of sonuclar) expect(s).toMatchObject({ durum: 'uygulandi', mesaj: 'Uygulandı' });
    expect(db.select().from(schema.products).where(eq(schema.products.id, latte.id)).get()).toMatchObject({ active: false, soldOutBy: 'lafpos' });
    expect(db.select().from(schema.optionItems).where(eq(schema.optionItems.id, secenek.id)).get()).toMatchObject({ soldOut: true });
    expect((await settings()).serviceMode).toBe('yari_self');
    expect((await audits('product.sold_out')).at(-1)!.message).toMatch(new RegExp(`^Uzaktan \\(${KIM}\\): Latte tükendi`));
    expect((await audits('menu.option_sold_out')).at(-1)).toMatchObject({ userId: 'uzaktan', message: expect.stringMatching(/^Uzaktan \(/) });
    expect((await audits('settings.servis_modu')).at(-1)!.message).toBe(`Uzaktan (${KIM}) servis modunu değiştirdi: Masaya servis → Yarı self servis`);
    // Bilinmeyen ürün: ucun kendi iletisiyle ret
    const [yok] = await uygula(komut('urun.satis', { id: 'yok-boyle-urun', satista: false }));
    expect(yok).toMatchObject({ durum: 'reddedildi', mesaj: 'Ürün bulunamadı' });
    await uygula(komut('urun.satis', { id: latte.id, satista: true }), komut('secenek.satis', { id: secenek.id, satista: true }), komut('ayar.servis', { mod: 'masa' }));
    expect(db.select().from(schema.products).where(eq(schema.products.id, latte.id)).get()!.active).toBe(true);
    expect((await settings()).serviceMode).toBe('masa');
  });

  it('urun.gorunum ve secenek.grubu: çift ürün kasada gizlenir; Latte çeşidi grubu açılır ve ürüne bağlanır', async () => {
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const { db, schema } = await import('../server/db/client');
    const { and, eq } = await import('drizzle-orm');
    const grup = {
      ad: 'Latte çeşidi',
      zorunlu: false,
      ogeler: [
        { ad: 'Klasik', fiyat: 0, varsayilan: true },
        { ad: 'Spanish Latte', fiyat: 5000, varsayilan: false },
      ],
      urunler: [latte.id],
    };
    const [gizle, ekle] = await uygula(komut('urun.gorunum', { id: latte.id, gorunur: false }), komut('secenek.grubu', grup));
    expect(gizle).toMatchObject({ durum: 'uygulandi', ozet: 'Kasada gizle: Latte' });
    expect(ekle).toMatchObject({ durum: 'uygulandi' });
    expect(db.select().from(schema.products).where(eq(schema.products.id, latte.id)).get()).toMatchObject({ hidden: true, active: true });
    const g = db.select().from(schema.optionGroups).where(eq(schema.optionGroups.name, 'Latte çeşidi')).get()!;
    expect(g).toMatchObject({ kind: 'single', required: false, maxSelect: 1 });
    const ogeler = db.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).all();
    expect(ogeler.map((o) => [o.name, o.price, o.isDefault])).toEqual([
      ['Klasik', 0, true],
      ['Spanish Latte', 5000, false],
    ]);
    expect(db.select().from(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, latte.id), eq(schema.productOptionGroups.groupId, g.id))).get()).toBeTruthy();
    // urun.ekle: Meyveli Cup, kategori ve gruplarla; ürün ekranda açılır
    const [yeni] = await uygula(komut('urun.ekle', { ad: 'Meyveli Cup', kategori: latte.categoryId, fiyat: 25000, kdv: 10, gruplar: [g.id] }));
    expect(yeni).toMatchObject({ durum: 'uygulandi', ozet: 'Ürün ekle: Meyveli Cup (250 ₺)' });
    const cup = db.select().from(schema.products).where(eq(schema.products.name, 'Meyveli Cup')).get()!;
    expect(cup).toMatchObject({ price: 25000, kdvRate: 10, active: true, categoryId: latte.categoryId });
    expect(db.select().from(schema.productOptionGroups).where(and(eq(schema.productOptionGroups.productId, cup.id), eq(schema.productOptionGroups.groupId, g.id))).get()).toBeTruthy();
    await uygula(komut('urun.gorunum', { id: latte.id, gorunur: true }));
    expect(db.select().from(schema.products).where(eq(schema.products.id, latte.id)).get()!.hidden).toBe(false);
    // Doğrulama: fiyat kuruş tam sayı, tek varsayılan
    const { komutDogrula } = await import('@shared/kontrol');
    expect(komutDogrula('secenek.grubu', { ...grup, ogeler: [{ ad: 'X', fiyat: 1.5 }] })).toMatchObject({ ok: false });
    expect(komutDogrula('secenek.grubu', { ...grup, ogeler: [{ ad: 'A', fiyat: 0, varsayilan: true }, { ad: 'B', fiyat: 0, varsayilan: true }] })).toMatchObject({ ok: false });
  });

  it('kasada uzaktan yönetim kapalıyken her işlem reddedilir; anahtarı yalnız patron değiştirir, kayda düşer', async () => {
    const mudur = await h.call<{ code: string }>('mudur', 'PUT', '/admin/settings', { remoteControl: false });
    expect(mudur.status).toBe(403);
    expect(mudur.json.code).toBe('patron_only');
    await h.ok('patron', 'PUT', '/admin/settings', { remoteControl: false });
    expect((await audits('settings.remoteControl')).at(-1)).toMatchObject({ severity: 'uyari', message: 'Patron Uzaktan yönetim ayarını değiştirdi: açık → kapalı' });
    const k = await kontrol();
    expect(k.kontrolDurumu().acik).toBe(false);
    expect((await h.ok<{ settings: { remoteControl: boolean } }>('kasa', 'GET', '/bootstrap')).settings.remoteControl).toBe(false);
    try {
      const [s] = await uygula(komut('ayar.servis', { mod: 'self' }));
      expect(s).toMatchObject({ durum: 'reddedildi', mesaj: 'Kasada uzaktan yönetim kapalı' });
      expect((await settings()).serviceMode).toBe('masa');
    } finally {
      await h.ok('patron', 'PUT', '/admin/settings', { remoteControl: true });
    }
    expect(k.kontrolDurumu().acik).toBe(true);
  });

  it('açık PIN hiçbir denetim kaydında, sonuçta, sync state’te ya da günlükte yok; şifreli PIN de saklanmaz', async () => {
    const { db, schema } = await import('../server/db/client');
    // PIN rakam dizisi olarak ararız: zaman damgasının ya da base64 metnin içindeki rastlantı sayılmaz
    const izler = (pin: string) => new RegExp(`(^|[^0-9A-Za-z+/])${pin}([^0-9A-Za-z+/=]|$)`);
    const metinler = [
      ...db.select().from(schema.auditLog).all().map((a) => JSON.stringify(a)),
      ...db.select().from(schema.syncState).all().map((r) => `${r.key} ${JSON.stringify(r.value)}`),
      ...loglar.map((args) => args.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : typeof x === 'string' ? x : JSON.stringify(x))).join(' ')),
    ];
    expect(metinler.length).toBeGreaterThan(10);
    for (const pin of [YENI_PIN, GARSON_PIN]) for (const m of metinler) expect(m).not.toMatch(izler(pin));
    for (const s of sifreliler) for (const m of metinler) expect(m).not.toContain(s.slice(0, 40));
    // İşlenmiş komutlar ve sonuçlar sync state'te: yalnız kimlik, durum, kısa ileti
    const islenen = db.select().from(schema.syncState).all().find((r) => r.key === 'kontrol.islenen')!.value as Record<string, unknown>[];
    expect(islenen.length).toBeGreaterThan(5);
    for (const x of islenen) expect(Object.keys(x).filter((k) => k !== 'ozet').sort()).toEqual(['at', 'durum', 'id', 'komutAt', 'mesaj']);
  });

  it('sonuç kasanın kendi adlarıyla özetlenir (bulutun özeti istekten gelir, doğrulanmaz)', async () => {
    const k = await kontrol();
    k.nabizIletildi({ ozet: '', sonuclar: await bekleyenler() });
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const secenek = db.select().from(schema.optionItems).where(eq(schema.optionItems.active, true)).get()!;
    const grup = db.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, secenek.groupId)).get()!;
    const [u, o, yok] = await uygula(komut('urun.satis', { id: latte.id, satista: false }), komut('secenek.satis', { id: secenek.id, satista: false }), komut('urun.satis', { id: 'yok-boyle-urun', satista: true }));
    expect(u).toMatchObject({ durum: 'uygulandi', ozet: 'Tükendi: Latte' });
    expect(o).toMatchObject({ durum: 'uygulandi', ozet: `Tükendi: ${secenek.name} (${grup.name})` });
    expect(yok).toMatchObject({ durum: 'reddedildi', ozet: 'Satışa aç: ürün' });
    await uygula(komut('urun.satis', { id: latte.id, satista: true }), komut('secenek.satis', { id: secenek.id, satista: true }));
  });

  it('denetim kaydı yalnız uzaktan kayıtlarıyla süzülür (Ağ ve uzaktan erişim kartının son uzaktan işlemi)', async () => {
    // Araya başka işlem kaydı girer: süzgeç yine son uzaktan kaydı verir
    await h.ok('patron', 'PUT', '/admin/settings', { tipsEnabled: true });
    const rows = await h.ok<{ userId: string | null; action: string; message: string }[]>('patron', 'GET', '/admin/audit?uzaktan=1&limit=1');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.userId === 'uzaktan' || rows[0]!.action.startsWith('uzaktan.') || rows[0]!.message.startsWith('Uzaktan (')).toBe(true);
    const all = await h.ok<{ action: string }[]>('patron', 'GET', '/admin/audit?limit=1');
    expect(all[0]!.action).not.toMatch(/^uzaktan\./);
  });

  it('listeden düşen komutların en yeni anı alt sınır olur: 500’den eski komut 24 saat içinde de yeniden uygulanmaz', async () => {
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const now = Date.now();
    const once = getSyncState<{ id: string }[]>('kontrol.islenen') ?? [];
    // Liste dolu: en eskisi (anı now - 2 sa) bir sonraki komutla düşer
    const dolgu = Array.from({ length: 500 }, (_, i) => ({ id: `k_dolgu${String(i).padStart(12, '0')}`, durum: 'uygulandi', mesaj: 'Uygulandı', at: now, komutAt: now - 2 * 3_600_000 + i }));
    setSyncState('kontrol.islenen', dolgu);
    try {
      const [s] = await uygula(komut('ayar.servis', { mod: 'masa' }));
      expect(s).toMatchObject({ durum: 'uygulandi' });
      expect(getSyncState<number>('kontrol.taban')).toBe(now - 2 * 3_600_000);
      // Düşen komutun kimliği artık listede yok; aynı anlı ya da daha eski komut tekrar sayılır
      const [tekrar, yeni] = await uygula(komut('ayar.servis', { mod: 'self' }, { id: dolgu[0]!.id, at: now - 2 * 3_600_000 }), komut('ayar.servis', { mod: 'masa' }, { at: now - 3_600_000 }));
      expect(tekrar).toMatchObject({ durum: 'reddedildi', mesaj: 'Bu işlem daha önce işlendi ya da çok eski' });
      expect(yeni).toMatchObject({ durum: 'uygulandi' });
      expect((await settings()).serviceMode).toBe('masa');
    } finally {
      setSyncState('kontrol.islenen', once);
      setSyncState('kontrol.taban', 0);
    }
  });
});

describe('Uzaktan yönetim: üyenin rolü kasada da', () => {
  it('yönetici patron hesabına dokunamaz: bulutun özeti eski olsa da (aynı yanıtta önce patrona yükseltme) kasa reddeder', async () => {
    const k = await kontrol();
    k.nabizIletildi({ ozet: '', sonuclar: await bekleyenler() });
    const patron = (await users()).find((u) => u.role === 'patron')!;
    const kasa = (await users()).find((u) => u.name === 'Kasa')!;
    const MUDUR = 'mudur@laffogato.test';
    const [pin, ekle, rol, yetki] = await uygula(
      komut('personel.pin', { id: patron.id, pin: await sifrele('518273') }, { kim: MUDUR, rol: 'yonetici' }),
      komut('personel.ekle', { ad: 'Yeni Patron', rol: 'patron', pin: await sifrele('518274') }, { kim: MUDUR, rol: 'yonetici' }),
      komut('personel.duzenle', { id: kasa.id, rol: 'patron' }, { kim: MUDUR, rol: 'yonetici' }),
      komut('rol.yetki', { rol: 'garson', izinler: ['siparis.al'] }, { kim: MUDUR, rol: 'yonetici' }),
    );
    for (const s of [pin, ekle, rol]) expect(s).toMatchObject({ durum: 'reddedildi', mesaj: 'Patron hesabına yalnız sahip dokunabilir' });
    expect(yetki).toMatchObject({ durum: 'reddedildi', mesaj: 'Rol yetkilerini yalnız sahip değiştirebilir' });
    expect((await login('518273')).status).toBe(401);
    expect((await users()).some((u) => u.name === 'Yeni Patron')).toBe(false);

    // Sahip kasiyeri patrona yükseltir, yönetici hemen ardından onun PIN'ini ister (bulutun özetinde hâlâ kasiyer)
    const [yukselt, ardindan] = await uygula(komut('personel.duzenle', { id: kasa.id, rol: 'patron' }), komut('personel.pin', { id: kasa.id, pin: await sifrele('518275') }, { kim: MUDUR, rol: 'yonetici' }));
    expect(yukselt).toMatchObject({ durum: 'uygulandi' });
    expect(ardindan).toMatchObject({ durum: 'reddedildi', mesaj: 'Patron hesabına yalnız sahip dokunabilir' });
    expect((await login('518275')).status).toBe(401);
    await uygula(komut('personel.duzenle', { id: kasa.id, rol: 'kasiyer' }));
    expect((await users()).find((u) => u.id === kasa.id)!.role).toBe('kasiyer');

    // İzleyici hiçbir şey yapamaz
    const [izler] = await uygula(komut('ayar.servis', { mod: 'self' }, { kim: 'izler@laffogato.test', rol: 'izleyici' }));
    expect(izler).toMatchObject({ durum: 'reddedildi', mesaj: 'Yalnız görme yetkisi olan üye değişiklik yapamaz' });
    expect((await settings()).serviceMode).toBe('masa');
  });

  it('yönetici patron olmayan kimlikle uygular: personele PIN verme sınırı ve uyarı kaydı (patronun PIN’i taranamaz)', async () => {
    const { remoteActor, resetFailures } = await import('../server/lib/auth');
    expect(remoteActor('mudur@laffogato.test', 'yonetici')).toMatchObject({ id: 'uzaktan', name: 'Uzaktan (mudur@laffogato.test)', role: 'mudur' });
    const MUDUR = 'mudur@laffogato.test';
    const kasa = (await users()).find((u) => u.name === 'Kasa')!;
    const garson = (await users()).find((u) => u.name === 'Garson')!;
    try {
      // Yönetici olağan işini yapar: patron olmayan personelin indirim sınırı ve PIN'i
      const [indirim] = await uygula(komut('personel.duzenle', { id: kasa.id, indirim: 20 }, { kim: MUDUR, rol: 'yonetici' }));
      expect(indirim).toMatchObject({ durum: 'uygulandi' });
      // Başkasının PIN'i: çakışma uyarı olarak kayda düşer (patronun işleminde bilgi)
      const [cakisma] = await uygula(komut('personel.pin', { id: kasa.id, pin: await sifrele(GARSON_PIN) }, { kim: MUDUR, rol: 'yonetici' }));
      expect(cakisma).toMatchObject({ durum: 'reddedildi', mesaj: 'Bu PIN kullanılamaz; farklı bir PIN seçin' });
      expect((await audits('user.pin_conflict')).at(-1)).toMatchObject({ severity: 'uyari', entityId: garson.id });
      // Art arda PIN denemesi kilitlenir (kasadaki müdür gibi); sahibin işlemi kilitlenmez
      const denemeler = [];
      for (let i = 0; i < 12; i++) denemeler.push(komut('personel.pin', { id: kasa.id, pin: await sifrele(`7${String(i).padStart(3, '0')}91`) }, { kim: MUDUR, rol: 'yonetici' }));
      const sonuclar = await uygula(...denemeler);
      expect(sonuclar.some((s) => s.durum === 'reddedildi' && /^Çok fazla PIN değişikliği denendi/.test(s.mesaj))).toBe(true);
      const [sahip] = await uygula(komut('personel.pin', { id: kasa.id, pin: await sifrele('846135') }));
      expect(sahip).toMatchObject({ durum: 'uygulandi' });
    } finally {
      resetFailures();
    }
  });
});

describe('Uzaktan yönetim: Merkez nabzı', () => {
  it('komut nabızla gelir, uygulanır; sonuç hemen bir nabız daha ile bildirilir ve silinir; sonra 10 dakika hızlı nabız', async () => {
    const { merkezBeat, merkezTick, nabizAraligi, MERKEZ_BEAT_MS } = await import('../server/sync/merkez');
    const k = await kontrol();
    // Önceki testlerin bildirilmemiş sonuçları gitmiş sayılır
    k.nabizIletildi({ ozet: '', sonuclar: await bekleyenler() });
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const mudur = (await users()).find((u) => u.name === 'Müdür')!;
    const c = komut('urun.satis', { id: latte.id, satista: false });
    const c2 = komut('personel.duzenle', { id: mudur.id, indirim: 40 });
    siradaki = [{ komutlar: [c, c2] }];
    gelen.length = 0;
    const t0 = Date.now();
    expect(await merkezBeat(t0)).toBe(true);
    // Nabız + hemen ek nabız: sonuçlar ve değişen özet beklemesin
    expect(gelen).toHaveLength(2);
    expect(gelen[0]!.kontrol).toMatchObject({ ozet: expect.stringMatching(/^[0-9a-f]{14}$/) });
    expect(gelen[0]!.kontrol!.sonuclar).toBeUndefined();
    expect(gelen[1]!.kontrol!.sonuclar).toEqual([
      expect.objectContaining({ id: c.id, durum: 'uygulandi', mesaj: 'Uygulandı' }),
      expect.objectContaining({ id: c2.id, durum: 'uygulandi' }),
    ]);
    expect(gelen[1]!.kontrol!.ozet).not.toBe(gelen[0]!.kontrol!.ozet);
    expect(gelen[1]!.kontrol!.durum?.personel.find((p) => p.id === mudur.id)?.indirim).toBe(40);
    expect(await bekleyenler()).toEqual([]);
    expect(k.nabizKontrol(false).sonuclar).toBeUndefined();
    // Komut geldi: 10 dakika dakikada bir
    expect(nabizAraligi(t0 + 1_000)).toBe(HIZLI_NABIZ_MS);
    expect(await merkezTick(t0 + 30_000)).toBe(false);
    expect(gelen).toHaveLength(2);
    expect(await merkezTick(t0 + HIZLI_NABIZ_MS)).toBe(true);
    expect(gelen).toHaveLength(3);
    // Hızlı süre bitince yine 5 dakikada bir
    const sonra = t0 + HIZLI_SURE_MS + 60_000;
    expect(nabizAraligi(sonra)).toBe(MERKEZ_BEAT_MS);
    expect(await merkezTick(sonra)).toBe(true);
    expect(await merkezTick(sonra + 2 * 60_000)).toBe(false);
    expect(await merkezTick(sonra + MERKEZ_BEAT_MS)).toBe(true);
    expect(gelen).toHaveLength(5);
    await uygula(komut('urun.satis', { id: latte.id, satista: true }));
  });

  it('kasanın saati geri alınırsa nabız durmaz (son nabız ileride görünür)', async () => {
    const { merkezBeat, merkezTick, nabizAraligi, MERKEZ_BEAT_MS } = await import('../server/sync/merkez');
    // Açılışta BIOS saati bir yıl ileri: son nabız ve hızlı nabzın bitişi o tarihte kalır
    const ileri = Date.now() + 365 * 86_400_000;
    siradaki = [{ komutlar: [komut('ayar.servis', { mod: 'masa' }, { at: ileri })] }];
    expect(await merkezBeat(ileri)).toBe(true);
    // Saat düzeldi: nabzın zamanı gelmiş sayılır, hızlı nabız da sürmez (bitişi çok uzakta)
    const simdi = Date.now();
    expect(nabizAraligi(simdi)).toBe(MERKEZ_BEAT_MS);
    gelen.length = 0;
    expect(await merkezTick(simdi)).toBe(true);
    expect(gelen.length).toBeGreaterThan(0);
    expect(await merkezTick(simdi + 30_000)).toBe(false);
  });

  it('bulut özeti isterse hemen gönderilir; zincir en çok bir ek nabız', async () => {
    const { merkezBeat } = await import('../server/sync/merkez');
    hepDurumIste = true;
    gelen.length = 0;
    try {
      expect(await merkezBeat()).toBe(true);
    } finally {
      hepDurumIste = false;
    }
    expect(gelen).toHaveLength(2);
    expect(gelen[1]!.kontrol!.durum).toMatchObject({ v: 1, acik: true });
    expect(durumGecerli(gelen[1]!.kontrol!.durum)).toBe(true);
  });

  it('eski bulut (yanıtta kontrol yok) sorunsuz: tek nabız, lisans işlenir', async () => {
    const { merkezBeat, merkezLast, merkezSyncState } = await import('../server/sync/merkez');
    eskiBulut = true;
    gelen.length = 0;
    try {
      expect(await merkezBeat()).toBe(true);
    } finally {
      eskiBulut = false;
    }
    expect(gelen).toHaveLength(1);
    expect(gelen[0]!.kontrol).toMatchObject({ ozet: expect.any(String) });
    expect(merkezLast()).toMatchObject({ lisans: { durum: 'aktif' } });
    expect(merkezSyncState().lastError).toBeNull();
  });
});
