import { constants, createHmac, createPublicKey, generateKeyPairSync, publicEncrypt } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';
import {
  anahtarImzaMetni,
  DAVET_OMRU_MS,
  durumParmakIzi,
  GECMIS_EN_COK,
  imzaMetni,
  KOMUT_ID_RE,
  KOMUT_TURLERI,
  komutDogrula,
  type KomutKaydi,
  type KontrolDurumu,
  type KontrolGecmisi,
  type KontrolPaneli,
  KUYRUK_EN_COK,
  type NabizKontrolYaniti,
  SAATLIK_EN_COK,
  type UzaktanUye,
} from '../shared/kontrol';
import { ROLE_DEFAULTS } from '../shared/permissions';
import { type UpstashCall, upstashCommand } from './fake-upstash';
import { REDIS_ONEKI, VERCEL_ALANI } from '@shared/eski-adlar';

/**
 * Uzaktan yönetimin bulut tarafı (api/_kontrol.ts, api/_merkez.ts nabzı, api/uzaktan.ts üye rolleri;
 * docs/UZAKTAN-YONETIM.md): rol kapısı, kasanın özeti ve doğrulama, kuyruk ve saat sınırı, imza, nabızla teslim ve
 * sonuç, özet isteği, nabzın Redis bütçesi, açık PIN'in hiçbir yere girmediği, panel üyelerinin daveti ve kaldırılması.
 * Kasa gerçek bulut işleyicisiyle imzalı konuşur; Upstash yerine bellekte sahte Redis (tests/fake-upstash.ts).
 */
const ORIGIN = `https://${VERCEL_ALANI}`;
const SECRET = 'b'.repeat(40);
const OWNER = 'sahip@ornek.test';
const OWNER_PASSWORD = 'sahip-parola-2026';
const INVITE = 'BULT-7K3P-Q92X';
const KASA_KEY = 'kasa-anahtari-bulut-testi-'.padEnd(48, 'x');
/** Bilinen açık PIN: yalnız tarayıcıda şifrelenir; bulutta hiçbir yerde geçmemeli */
const PIN = '864213';
const PIN_RE = new RegExp(`(^|\\D)${PIN}(\\D|$)`);
const store = new Map<string, string>();
const log: UpstashCall[] = [];
/** Bütün yanıtların gövdesi (PIN taraması); panelinkiler ayrıca (şifreli PIN ve imza da geçmemeli) */
const seen: string[] = [];
const panelSeen: string[] = [];
const ciphers: string[] = [];
/**
 * Yarış senaryoları için: sahte Redis bir komutu yanıtladıktan hemen sonra bunu çağırır (başka bir isteğin araya girdiği
 * an). Döndüğü true ise bir kez çalışmış sayılır ve silinir
 */
let araya: ((cmd: string[]) => boolean) | null = null;
/** Güncelleme kanalının son derlemesi (surum.json); null: kanal okunamıyor (çoğu testte) */
let kanal: Record<string, unknown> | null = null;
const ENV = ['ASILPOS_CLOUD_SECRET', 'ASILPOS_UYE_EPOSTA', 'ASILPOS_UYE_DAVET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ASILPOS_UZAKTAN_DEMO', 'ASILPOS_UZAKTAN_PAROLA', 'ASILPOS_UZAKTAN_PAROLA_GEREKLI'];
const saved: Record<string, string | undefined> = {};

// Kasanın PIN anahtarı: tarayıcı açık anahtarla şifreler (RSA-OAEP, SHA-256)
const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ANAHTAR = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
function sifrele(pin: string): string {
  const out = publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(pin)).toString('base64');
  ciphers.push(out);
  return out;
}

beforeAll(() => {
  for (const k of ENV) saved[k] = process.env[k];
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, ASILPOS_UYE_EPOSTA: OWNER, ASILPOS_UYE_DAVET: INVITE, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const cmd = JSON.parse(String(init!.body)) as string[];
      const result = upstashCommand(store, cmd, log);
      if (araya?.(cmd)) araya = null;
      return new Response(JSON.stringify({ result }));
    }
    // Güncelleme kanalı (Merkez nabzı ve "Şimdi güncelle" sorar): yalnız `kanal` verilince
    if (url === `${ORIGIN}/guncelleme/surum.json` && kanal) return Response.json(kanal);
    return new Response('yok', { status: 404 });
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of ENV) saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]);
});
beforeEach(() => {
  for (const k of [...store.keys()]) if (k.startsWith(`${REDIS_ONEKI}giris:`)) store.delete(k);
});

const api = () => import('../api/uzaktan');
const merkezApi = () => import('../api/_merkez');
let kasaId = '';

interface Yanit<T = any> {
  status: number;
  body: T;
}

async function call<T = any>(method: 'GET' | 'POST', path: string, opts: { body?: unknown; token?: string; shop?: string | null; ip?: string } = {}): Promise<Yanit<T>> {
  const { GET, POST } = await api();
  const headers: Record<string, string> = { 'x-forwarded-for': opts.ip ?? '10.0.0.1' };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.shop !== null) headers['x-laf-dukkan'] = opts.shop ?? kasaId;
  const body = method === 'POST' ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body ?? {})) : undefined;
  const req = new Request(`${ORIGIN}/api/uzaktan?yol=${path}`, { method, headers, body });
  const res = await (method === 'GET' ? GET(req) : POST(req));
  const text = await res.text();
  seen.push(text);
  if (path.startsWith('kontrol/')) panelSeen.push(text);
  return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

const panel = (token: string, shop?: string | null) => call<KontrolPaneli>('GET', 'kontrol/durum', { token, shop });
const komut = (token: string, tur: string, veri: unknown, extra: Record<string, unknown> = {}) => call('POST', 'kontrol/komut', { token, body: { tur, veri, ...extra } });

/** Kasanın kaydı (kafenin ortak anahtarıyla imzalı) */
async function kayit(key: string): Promise<string> {
  const { installIdFor } = await merkezApi();
  const id = installIdFor(key);
  const body = JSON.stringify({ id, anahtar: key, surum: '0.4.0', build: 1000 });
  const { POST } = await api();
  const res = await POST(new Request(`${ORIGIN}/api/uzaktan?yol=merkez/kayit`, { method: 'POST', body, headers: { 'x-forwarded-for': '10.9.9.9', ...signedHeaders(SECRET, 'POST', new URL(`${ORIGIN}/api/merkez/kayit`), body) } }));
  expect(res.status).toBe(200);
  return id;
}

/** Kurulumun kendi anahtarıyla imzalı nabız */
async function nabiz(payload: Record<string, unknown> = {}, key = KASA_KEY): Promise<{ ok: boolean; kontrol?: NabizKontrolYaniti; lisans: unknown }> {
  const { installIdFor } = await merkezApi();
  const body = JSON.stringify({ surum: '0.4.0', build: 1000, gunAcik: true, kesinHedef: true, ...payload });
  const { POST } = await api();
  const res = await POST(new Request(`${ORIGIN}/api/uzaktan?yol=merkez/nabiz`, { method: 'POST', body, headers: { 'x-laf-kurulum': installIdFor(key), ...signedHeaders(key, 'POST', new URL(`${ORIGIN}/api/merkez/nabiz`), body) } }));
  const text = await res.text();
  seen.push(text);
  expect(res.status).toBe(200);
  return JSON.parse(text);
}

/** Kasanın açık anahtarının imzası (kasa ortak anahtarla, kurulumuna bağlı imzalar; bulut panele yalnız tutarsa verir) */
const anahtarImzasi = (kurulum: string, anahtar = ANAHTAR) => createHmac('sha256', SECRET).update(anahtarImzaMetni(kurulum, anahtar)).digest('base64url');

function durumOrnek(over: Partial<KontrolDurumu> = {}): KontrolDurumu {
  return {
    v: 1,
    at: Date.now(),
    acik: true,
    turler: [...KOMUT_TURLERI],
    anahtar: ANAHTAR,
    anahtarImza: anahtarImzasi(kasaId),
    personel: [
      { id: 'p_patron', ad: 'Elif Yılmaz', rol: 'patron', renk: '#1f3d2b', aktif: true, indirim: 100, sonGiris: null },
      { id: 'p_mudur', ad: 'Burak Demir', rol: 'mudur', renk: '#2f6b4f', aktif: true, indirim: 30, sonGiris: null },
      { id: 'p_kasa', ad: 'Zeynep Aksoy', rol: 'kasiyer', renk: '#c2703d', aktif: true, indirim: 10, sonGiris: null },
    ],
    roller: (['patron', 'mudur', 'kasiyer'] as const).map((rol) => ({ rol, izinler: ROLE_DEFAULTS[rol], ozel: false, kisi: 1 })),
    servisModu: 'masa',
    ...over,
  };
}

/** Kasanın özetini buluta yazar (nabızla, değişince) */
const ozetGonder = (d: KontrolDurumu = durumOrnek(), key = KASA_KEY) => nabiz({ kontrol: { ozet: durumParmakIzi(d), durum: d } }, key);

/** Uzaktan yönetimin bütün anahtarlarını siler (sayaç dahil) ve özeti yeniden yazar */
async function sifirla(d: KontrolDurumu = durumOrnek()) {
  for (const k of [...store.keys()]) if (k.startsWith(`${REDIS_ONEKI}kontrol:`)) store.delete(k);
  await ozetGonder(d);
}

const queueOf = (id = kasaId) => JSON.parse(store.get(`${REDIS_ONEKI}kontrol:komut:${id}`) ?? '{}') as Record<string, string>;
const historyOf = (id = kasaId) => (JSON.parse(store.get(`${REDIS_ONEKI}kontrol:gecmis:${id}`) ?? '[]') as string[]).map((s) => JSON.parse(s) as KontrolGecmisi);
/** Redis komutları; oturumun üye kaydı okuması hariç (bir dakika bellekte: sayısı saate bağlı) */
const cmds = () => log.filter((c) => !c.key.startsWith(`${REDIS_ONEKI}uye:`)).map((c) => c.cmd);

async function girisYap(eposta: string, parola: string): Promise<string> {
  const res = await call<{ token: string }>('POST', 'uzaktan/giris', { body: { eposta, parola }, shop: null });
  expect(res.status).toBe(200);
  return res.body.token;
}

/** Sahibin davetiyle panele kişi ekler ve kişinin ilk girişini yapar */
async function uyeEkle(sahip: string, eposta: string, rol: 'yonetici' | 'izleyici', parola = `${rol}-parola-2026`): Promise<string> {
  const davet = await call<{ ok: boolean; kod: string; bitis: number }>('POST', 'kontrol/uye', { token: sahip, body: { eposta, rol } });
  expect(davet.status).toBe(200);
  const made = await call<{ token: string }>('POST', 'uzaktan/uye', { body: { eposta, parola, davet: davet.body.kod }, shop: null });
  expect(made.status).toBe(200);
  return made.body.token;
}

let sahip = '';
let yonetici = '';
let izleyici = '';

beforeAll(async () => {
  // Sahip (Vercel ortamındaki e-posta): ortak davet koduyla ilk giriş
  const made = await call<{ token: string }>('POST', 'uzaktan/uye', { body: { eposta: OWNER, parola: OWNER_PASSWORD, davet: INVITE }, shop: null });
  expect(made.status).toBe(200);
  sahip = made.body.token;
  kasaId = await kayit(KASA_KEY);
  await ozetGonder();
  yonetici = await uyeEkle(sahip, 'mudur@ornek.test', 'yonetici');
  izleyici = await uyeEkle(sahip, 'izler@ornek.test', 'izleyici');
  // İşlevin ilk yüklenmesi ve üç parola özeti (scrypt) paylaşılan makinede uzun sürebilir
}, 120_000);

describe('uzaktan yönetim: oturum ve rol kapısı', () => {
  it('jetonsuz 401; parolasız görünüm 403 remote_admin; parolalı giriş sahiptir', async () => {
    expect((await panel('yok')).status).toBe(401);
    expect((await komut('yok', 'urun.satis', { id: 'u1', satista: false })).status).toBe(401);
    delete process.env.ASILPOS_UYE_EPOSTA;
    try {
      // Parolasız görünüm: oturum geçerli ama gerçek değil
      const open = await call<{ token: string }>('POST', 'uzaktan/giris', { body: {}, shop: null });
      const denied = await call('GET', 'kontrol/durum', { token: open.body.token });
      expect([denied.status, denied.body.code]).toEqual([403, 'remote_admin']);
      expect((await komut(open.body.token, 'urun.satis', { id: 'u1', satista: false })).status).toBe(403);
      // Görünümün geri kalanı açık kalır (oturum düşmez)
      expect((await call('GET', 'auth/me', { token: open.body.token })).status).toBe(200);

      // Parolalı giriş: sahip, e-postası yok (`parola`); üyelik kapalıyken panele kişi eklenmez
      Object.assign(process.env, { ASILPOS_UZAKTAN_PAROLA_GEREKLI: '1', ASILPOS_UZAKTAN_PAROLA: 'bulut-parola-12' });
      const real = await call<{ token: string }>('POST', 'uzaktan/giris', { body: { parola: 'bulut-parola-12' }, shop: null });
      expect(real.status).toBe(200);
      const view = await panel(real.body.token);
      expect(view.status).toBe(200);
      expect(view.body.ben).toEqual({ eposta: null, rol: 'sahip' });
      const sent = await komut(real.body.token, 'urun.satis', { id: 'u_parola', satista: false }, { ad: 'Limonata' });
      expect(sent.status).toBe(200);
      expect(sent.body.komut).toMatchObject({ kim: 'parola', ozet: 'Tükendi: Limonata', durum: 'bekliyor' });
      expect((await call('POST', 'kontrol/uye', { token: real.body.token, body: { eposta: 'yeni@ornek.test', rol: 'izleyici' } })).body.code).toBe('member_mode_off');
    } finally {
      process.env.ASILPOS_UYE_EPOSTA = OWNER;
      delete process.env.ASILPOS_UZAKTAN_PAROLA_GEREKLI;
      delete process.env.ASILPOS_UZAKTAN_PAROLA;
      await sifirla();
    }
  });

  it('izleyici görür ama işlem gönderemez; yönetici patron hesabına ve rol yetkilerine dokunamaz; sahip dokunur', async () => {
    const seenBy = await panel(izleyici);
    expect(seenBy.status).toBe(200);
    expect(seenBy.body.ben).toEqual({ eposta: 'izler@ornek.test', rol: 'izleyici' });
    expect(seenBy.body.durum?.personel).toHaveLength(3);
    const ro = await komut(izleyici, 'urun.satis', { id: 'u1', satista: false });
    expect([ro.status, ro.body.code]).toEqual([403, 'remote_readonly']);

    const pin = sifrele(PIN);
    const notAllowed = [
      await komut(yonetici, 'personel.pin', { id: 'p_patron', pin }),
      await komut(yonetici, 'rol.yetki', { rol: 'kasiyer', izinler: ['siparis.al'] }),
      await komut(yonetici, 'personel.ekle', { ad: 'Yeni Patron', rol: 'patron', pin }),
      await komut(yonetici, 'personel.duzenle', { id: 'p_kasa', rol: 'patron' }),
      await komut(yonetici, 'personel.duzenle', { id: 'p_patron', aktif: false }),
    ];
    for (const r of notAllowed) expect([r.status, r.body.code]).toEqual([403, 'not_allowed']);
    // Kasanın özetinde olmayan personel: yönetici için hedefin rolü bilinmez, gönderilmez
    expect((await komut(yonetici, 'personel.pin', { id: 'p_yok', pin })).body.code).toBe('unknown_target');

    // Yönetici patron olmayan personeli, Tükendi'yi ve servis modunu yönetir
    expect((await komut(yonetici, 'personel.duzenle', { id: 'p_kasa', indirim: 15 })).status).toBe(200);
    expect((await komut(yonetici, 'personel.pin', { id: 'p_kasa', pin: sifrele(PIN) })).status).toBe(200);
    expect((await komut(yonetici, 'personel.ekle', { ad: 'Deniz Kara', rol: 'garson', pin: sifrele(PIN) })).status).toBe(200);
    expect((await komut(yonetici, 'ayar.servis', { mod: 'self' })).status).toBe(200);
    // Sahip her şeyi
    const own = await komut(sahip, 'personel.pin', { id: 'p_patron', pin: sifrele(PIN) });
    expect(own.status).toBe(200);
    expect(own.body.komut).toMatchObject({ tur: 'personel.pin', ozet: 'PIN değiştir: Elif Yılmaz', kim: OWNER, durum: 'bekliyor', mesaj: null, bitti: null });
    expect((await komut(sahip, 'rol.yetki', { rol: 'kasiyer', izinler: ['siparis.al', 'odeme.al'] })).status).toBe(200);
    expect(Object.keys(queueOf())).toHaveLength(6);
    // Panelin geri kalanı üyeye salt okunur kalır
    expect((await call('POST', 'orders', { token: yonetici, body: {} })).status).toBe(403);
    await sifirla();
  });

  it('örnek görünüm: kafe bağlanmadan örnek gün ve üyeler, her işlem 403', async () => {
    delete process.env.ASILPOS_UZAKTAN_DEMO;
    try {
      const demo = await call<{ token: string; demo: boolean }>('POST', 'uzaktan/giris', { body: {}, shop: null });
      expect(demo.body.demo).toBe(true);
      const view = await call<KontrolPaneli>('GET', 'kontrol/durum', { token: demo.body.token, shop: null });
      expect(view.status).toBe(200);
      const p = view.body;
      expect(p).toMatchObject({ demo: true, ben: { rol: 'sahip' }, durum: { v: 1, acik: true, servisModu: 'masa' } });
      expect(p.durum!.personel.map((x) => x.rol)).toEqual(['patron', 'mudur', 'kasiyer', 'kasiyer', 'garson']);
      expect(p.durum!.turler).toEqual([...KOMUT_TURLERI]);
      for (const r of p.durum!.roller) expect(r.izinler).toEqual(ROLE_DEFAULTS[r.rol]);
      // Gerçek bir RSA-2048 açık anahtarı (tarayıcı içe aktarabilsin)
      expect(createPublicKey({ key: Buffer.from(p.durum!.anahtar, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyDetails?.modulusLength).toBe(2048);
      expect(p.bekleyen).toHaveLength(1);
      expect(p.gecmis.map((g) => g.durum)).toEqual(['uygulandi', 'uygulandi', 'reddedildi', 'uygulandi']);
      for (const g of [...p.bekleyen, ...p.gecmis]) expect(KOMUT_ID_RE.test(g.id)).toBe(true);
      expect(p.kasa).toMatchObject({ gunAcik: true });
      const members = await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: demo.body.token, shop: null });
      expect(members.body.uyeler.map((u) => u.rol)).toEqual(['sahip', 'yonetici', 'izleyici']);
      for (const path of ['kontrol/komut', 'kontrol/iptal', 'kontrol/uye', 'kontrol/uye-rol', 'kontrol/uye-sil']) {
        const res = await call('POST', path, { token: demo.body.token, shop: null, body: { tur: 'ayar.servis', veri: { mod: 'self' } } });
        expect([res.status, res.body.code], path).toEqual([403, 'remote_readonly']);
      }
    } finally {
      process.env.ASILPOS_UZAKTAN_DEMO = '0';
    }
  });
});

describe('uzaktan yönetim: kasanın özeti, doğrulama ve sınırlar', () => {
  it('dükkân Merkez’e bağlı değilse durum ve kasa null, komut 409', async () => {
    const view = await panel(sahip, 'default');
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ durum: null, bekleyen: [], gecmis: [], kasa: null });
    expect((await call('POST', 'kontrol/komut', { token: sahip, shop: 'default', body: { tur: 'ayar.servis', veri: { mod: 'self' } } })).body.code).toBe('not_connected');
    // Başlık yoksa en son veri gönderen dükkân (kafe hiç özet itmedi: `default`)
    expect((await panel(sahip, null)).body.durum).toBeNull();
  });

  it('özet yoksa, eski sürümdeyse ya da türü desteklemiyorsa 409; kasada kapalıysa 409', async () => {
    store.delete(`${REDIS_ONEKI}kontrol:durum:${kasaId}`);
    const none = await komut(sahip, 'ayar.servis', { mod: 'self' });
    expect([none.status, none.body.code, none.body.error]).toEqual([409, 'kasa_eski', 'Kasa güncel değil: önce Merkez’den güncelleme gönderin']);
    store.set(`${REDIS_ONEKI}kontrol:durum:${kasaId}`, JSON.stringify({ ...durumOrnek(), v: 0 }));
    expect((await komut(sahip, 'ayar.servis', { mod: 'self' })).body.code).toBe('kasa_eski');
    await sifirla(durumOrnek({ turler: ['urun.satis'] }));
    expect((await komut(sahip, 'ayar.servis', { mod: 'self' })).body.code).toBe('kasa_eski');
    expect((await komut(sahip, 'urun.satis', { id: 'u1', satista: true })).status).toBe(200);
    await sifirla(durumOrnek({ acik: false }));
    const off = await komut(sahip, 'urun.satis', { id: 'u1', satista: true });
    expect([off.status, off.body.code]).toEqual([409, 'kontrol_kapali']);
    expect(off.body.error).toMatch(/Kasada uzaktan yönetim kapalı/);
    // Bulutun bilmediği yeni sözleşme sürümü
    await sifirla(durumOrnek({ v: 2 }));
    expect((await komut(sahip, 'urun.satis', { id: 'u1', satista: true })).body.code).toBe('bulut_eski');
    await sifirla();
    expect(Object.keys(queueOf())).toHaveLength(0);
  });

  it('bilinmeyen tür ve bozuk veri 400; açık PIN kuyruğa girmez', async () => {
    const unknown = await komut(sahip, 'personel.sil', { id: 'p_kasa' });
    expect([unknown.status, unknown.body.error]).toEqual([400, 'Bilinmeyen işlem']);
    const plain = await komut(sahip, 'personel.pin', { id: 'p_kasa', pin: PIN });
    expect([plain.status, plain.body.error]).toEqual([400, 'PIN şifrelenmemiş ya da bozuk']);
    expect((await komut(sahip, 'urun.satis', { id: 'u1', satista: 'evet' })).status).toBe(400);
    expect((await komut(sahip, 'rol.yetki', { rol: 'patron', izinler: [] })).status).toBe(400);
    expect((await komut(sahip, 'personel.duzenle', { id: 'p_kasa' })).body.error).toBe('Değişiklik yok');
    expect((await call('POST', 'kontrol/komut', { token: sahip, body: 'bozuk{' })).status).toBe(400);
    expect((await call('POST', 'kontrol/komut', { token: sahip, body: JSON.stringify({ tur: 'ayar.servis', veri: { mod: 'x'.repeat(9000) } }) })).status).toBe(413);
    expect((await call('GET', 'kontrol/yok', { token: sahip })).status).toBe(404);
    expect(Object.keys(queueOf())).toHaveLength(0);
    // Geçersiz istekler saatlik sayaca girmez
    expect([...store.keys()].some((k) => k.startsWith(`${REDIS_ONEKI}kontrol:sayac:`))).toBe(false);
  });

  it(`kuyruk en çok ${KUYRUK_EN_COK}, saatte en çok ${SAATLIK_EN_COK} komut`, async () => {
    // Saatin ortası (jetonlar gerçek saatle verildi: yalnız saat dilimi sabitlenir)
    const base = Math.floor(Date.now() / 3600_000) * 3600_000 + 1800_000;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(base);
      await sifirla();
      for (let i = 0; i < KUYRUK_EN_COK; i++) expect((await komut(sahip, 'urun.satis', { id: `u${i}`, satista: false })).status).toBe(200);
      const full = await komut(sahip, 'urun.satis', { id: 'u-son', satista: false });
      expect([full.status, full.body.code]).toEqual([429, 'queue_full']);
      expect(Object.keys(queueOf())).toHaveLength(KUYRUK_EN_COK);

      // Kuyruğun son payı sahibin: yönetici kuyruğu dolduramaz, sahip yine gönderir
      await sifirla();
      for (let i = 0; i < KUYRUK_EN_COK - 10; i++) expect((await komut(yonetici, 'urun.satis', { id: `y${i}`, satista: false })).status).toBe(200);
      expect((await komut(yonetici, 'urun.satis', { id: 'y-son', satista: false })).body.code).toBe('queue_full');
      expect((await komut(sahip, 'personel.duzenle', { id: 'p_kasa', aktif: false })).status).toBe(200);

      await sifirla();
      const saat = Math.floor(Date.now() / 3600_000);
      store.set(`${REDIS_ONEKI}kontrol:sayac:${kasaId}:${saat}:${OWNER}`, String(SAATLIK_EN_COK - 1));
      expect((await komut(sahip, 'urun.satis', { id: 'u1', satista: false })).status).toBe(200);
      const limited = await komut(sahip, 'urun.satis', { id: 'u2', satista: false });
      expect([limited.status, limited.body.code]).toEqual([429, 'rate_limited']);
      // Sayaç üye başına: bir üyenin sınırı dolunca öteki gönderir (yönetici sahibi bekletemez, tersi de)
      store.set(`${REDIS_ONEKI}kontrol:sayac:${kasaId}:${saat}:mudur@ornek.test`, String(SAATLIK_EN_COK));
      expect((await komut(yonetici, 'urun.satis', { id: 'u4', satista: false })).body.code).toBe('rate_limited');
      store.delete(`${REDIS_ONEKI}kontrol:sayac:${kasaId}:${saat}:${OWNER}`);
      expect((await komut(sahip, 'urun.satis', { id: 'u5', satista: false })).status).toBe(200);
      // Sonraki saat yeniden açılır
      vi.setSystemTime(base + 3600_000);
      expect((await komut(yonetici, 'urun.satis', { id: 'u3', satista: false })).status).toBe(200);
    } finally {
      vi.useRealTimers();
      await sifirla();
    }
  });

  it('Merkez kimliği ve anahtarları iki dosyada aynı', async () => {
    const { KURULUM_RE } = await import('../api/_kontrol');
    const { ID_RE } = await merkezApi();
    expect(KURULUM_RE.source).toBe(ID_RE.source);
    // Kasa bilgisi Merkez'in kaydından ve nabzından
    expect((await panel(sahip)).body.kasa).toMatchObject({ surum: '0.4.0', build: 1000, gunAcik: true, sonGorulme: expect.any(Number) });
  });
});

describe('uzaktan yönetim: imza, nabızla teslim ve sonuç', () => {
  it('komut kasanın doğrulayacağı biçimde imzalı; panel verisini ve imzayı görmez', async () => {
    await sifirla();
    const cipher = sifrele(PIN);
    const sent = await komut(yonetici, 'personel.pin', { id: 'p_kasa', pin: cipher, fazla: 'düşer' });
    expect(sent.status).toBe(200);
    const row = sent.body.komut as KontrolGecmisi;
    expect(Object.keys(row).sort()).toEqual(['at', 'bitti', 'durum', 'id', 'kim', 'mesaj', 'ozet', 'tur']);
    const k = JSON.parse(queueOf()[row.id]!) as KomutKaydi;
    expect(KOMUT_ID_RE.test(k.id)).toBe(true);
    expect(k).toMatchObject({ tur: 'personel.pin', kim: 'mudur@ornek.test', kurulum: kasaId, rol: 'yonetici', ozet: 'PIN değiştir: Zeynep Aksoy', veri: { id: 'p_kasa', pin: cipher } });
    // Kasa: aynı doğrulamadan aynı veri, aynı imza metni, kafenin anahtarıyla HMAC-SHA256 (base64url)
    const again = komutDogrula(k.tur, k.veri);
    expect(again.ok && again.veri).toEqual(k.veri);
    expect(k.imza).toBe(createHmac('sha256', SECRET).update(imzaMetni(k)).digest('base64url'));
    expect(k.imza).not.toBe(createHmac('sha256', 'y'.repeat(40)).update(imzaMetni(k)).digest('base64url'));
    expect(k.imza).not.toBe(createHmac('sha256', SECRET).update(imzaMetni({ ...k, kim: OWNER })).digest('base64url'));
    // Kurulum ve rol imzalı: başka şubeye kopyalanan ya da rolü yükseltilen komut kasada tutmaz
    expect(k.imza).not.toBe(createHmac('sha256', SECRET).update(imzaMetni({ ...k, kurulum: 'baskakurulum0000000000000' })).digest('base64url'));
    expect(k.imza).not.toBe(createHmac('sha256', SECRET).update(imzaMetni({ ...k, rol: 'sahip' })).digest('base64url'));

    // Panel: bekleyen satır yalnız özet alanlarıyla; şifreli PIN ve imza yanıtta yok
    log.length = 0;
    const view = await panel(sahip);
    expect(cmds()).toEqual(['MGET', 'LRANGE', 'HVALS']);
    expect(view.body.bekleyen).toEqual([row]);
    const text = JSON.stringify(view.body);
    expect(text).not.toContain(cipher);
    expect(text).not.toContain(k.imza);
    // Ürün adı yalnız özet için, en çok 60 karakter
    const named = await komut(sahip, 'urun.satis', { id: 'u_lim', satista: false }, { ad: `  Ev   yapımı limonata ${'x'.repeat(80)}` });
    expect(named.body.komut.ozet).toBe(`Tükendi: ${`Ev yapımı limonata ${'x'.repeat(80)}`.slice(0, 60)}`);
  });

  it('kontrol göndermeyen kasa yeni alan görmez; nabzın Redis komutları kontrol yokken aynı', async () => {
    expect(Object.keys(queueOf()).length).toBeGreaterThan(0);
    log.length = 0;
    const old = await nabiz();
    expect('kontrol' in old).toBe(false);
    expect(old.lisans).toBeTruthy();
    // Kurulum, nabız kaydı, kuyruk işareti ve özet tek MGET'te; yazım ve yanıtın tazesi (önceki nabızla aynı sayı)
    expect(cmds()).toEqual(['MGET', 'SET', 'MGET']);
    expect(Object.keys(queueOf()).length).toBeGreaterThan(0);
  });

  it('kontrol gönderen kasa komutları sırayla alır; kasaya giden komut iptal edilmez', async () => {
    const ozet = durumParmakIzi(durumOrnek());
    log.length = 0;
    const beat = await nabiz({ kontrol: { ozet } });
    // Teslim anı kuyruk okunmadan önce yazılır (iptalle yarış: komutIptal)
    expect(cmds()).toEqual(['MGET', 'SET', 'SET', 'HVALS', 'MGET']);
    const k = beat.kontrol!;
    expect(k.durumIste).toBe(false);
    expect(k.komutlar.map((x) => x.tur)).toEqual(['personel.pin', 'urun.satis']);
    expect(k.komutlar.map((x) => x.at)).toEqual([...k.komutlar.map((x) => x.at)].sort((a, b) => a - b));
    for (const x of k.komutlar) expect(x.imza).toBe(createHmac('sha256', SECRET).update(imzaMetni(x)).digest('base64url'));
    // Kasaya gitti: iptal edilmez (panel "iptal" deyip kasa uygulamasın)
    const late = await call('POST', 'kontrol/iptal', { token: sahip, body: { id: k.komutlar[0]!.id } });
    expect([late.status, late.body.code]).toEqual([409, 'delivered']);
    // Sonuç gelmeden yeniden sorulursa aynı komutlar yeniden gelir (kasa kimlikten tanır); teslim anı ilerler (aynı
    // milisaniyede yazılmaz: beklenir)
    await new Promise((r) => setTimeout(r, 5));
    log.length = 0;
    const again = await nabiz({ kontrol: { ozet } });
    expect(again.kontrol!.komutlar.map((x) => x.id)).toEqual(k.komutlar.map((x) => x.id));
    expect(cmds()).toEqual(['MGET', 'SET', 'SET', 'HVALS', 'MGET']);
  });

  it('sonuç geçmişe geçer, kuyruktan silinir, işaret temizlenir; bilinmeyen kimlik yok sayılır', async () => {
    const pending = (await panel(sahip)).body.bekleyen;
    expect(pending).toHaveLength(2);
    const [first, second] = pending as [KontrolGecmisi, KontrolGecmisi];
    const at = Date.now() - 5_000;
    const beat = await nabiz({
      kontrol: {
        ozet: durumParmakIzi(durumOrnek()),
        sonuclar: [
          { id: first.id, durum: 'uygulandi', mesaj: '', at },
          { id: second.id, durum: 'reddedildi', mesaj: `Ürün bulunamadı ${'ş'.repeat(400)}`, at: at + 1, ozet: 'Tükendi:\nkasadaki ad' },
          { id: 'k_bilinmeyen00000000000000', durum: 'uygulandi', mesaj: '', at },
          { id: first.id, durum: 'reddedildi', mesaj: 'tekrar', at },
          { id: 'bozuk', durum: 'uygulandi', mesaj: '', at },
        ],
      },
    });
    expect(beat.kontrol).toEqual({ durumIste: false, komutlar: [] });
    expect(store.has(`${REDIS_ONEKI}kontrol:komut:${kasaId}`)).toBe(false);
    expect(store.has(`${REDIS_ONEKI}kontrol:var:${kasaId}`)).toBe(false);
    expect(store.has(`${REDIS_ONEKI}kontrol:teslim:${kasaId}`)).toBe(false);
    const history = historyOf();
    expect(history.map((h) => [h.id, h.durum])).toEqual([
      [second.id, 'reddedildi'],
      [first.id, 'uygulandi'],
    ]);
    expect(history[0]!.mesaj).toHaveLength(300);
    // Kasanın gönderdiği özet geçmişe geçer (tek satır): kuyruktaki özetin ürün adı istekten gelir, doğrulanmaz
    expect(history[0]).toMatchObject({ ozet: 'Tükendi: kasadaki ad', kim: second.kim, at: second.at, bitti: at + 1 });
    expect(history[1]).toMatchObject({ ozet: first.ozet, mesaj: null, bitti: at });
    const view = (await panel(sahip)).body;
    expect(view.bekleyen).toEqual([]);
    expect(view.gecmis.map((g) => g.id)).toEqual([second.id, first.id]);
    // Kuyruk boşken nabız yine üç komut (önceki nabız işareti sildi; kuyruğu yeniden saydı)
    log.length = 0;
    await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()) } });
    expect(cmds()).toEqual(['MGET', 'SET', 'MGET']);
  });

  it(`bekleyen işlem iptal edilir; geçmiş en çok ${GECMIS_EN_COK} satır`, async () => {
    const a = (await komut(sahip, 'urun.satis', { id: 'u_a', satista: false })).body.komut as KontrolGecmisi;
    const b = (await komut(yonetici, 'urun.satis', { id: 'u_b', satista: true })).body.komut as KontrolGecmisi;
    expect((await call('POST', 'kontrol/iptal', { token: izleyici, body: { id: b.id } })).body.code).toBe('remote_readonly');
    expect((await call('POST', 'kontrol/iptal', { token: yonetici, body: { id: a.id } })).body.code).toBe('not_allowed');
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: 'k_' } })).status).toBe(400);
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: 'k_bilinmeyen00000000000000' } })).status).toBe(404);
    const own = await call('POST', 'kontrol/iptal', { token: yonetici, body: { id: b.id } });
    expect(own.status).toBe(200);
    expect(own.body.komut).toMatchObject({ id: b.id, durum: 'iptal', mesaj: 'İptal eden: mudur@ornek.test' });
    expect(store.has(`${REDIS_ONEKI}kontrol:var:${kasaId}`)).toBe(true);
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: a.id } })).status).toBe(200);
    // Kuyruk boşaldı: işaret silinir, nabız kuyruğu okumaz
    expect(store.has(`${REDIS_ONEKI}kontrol:var:${kasaId}`)).toBe(false);
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: a.id } })).status).toBe(404);
    expect(historyOf().slice(0, 2).map((h) => [h.id, h.durum])).toEqual([
      [a.id, 'iptal'],
      [b.id, 'iptal'],
    ]);
    // Geçmiş kırpılır
    store.set(`${REDIS_ONEKI}kontrol:gecmis:${kasaId}`, JSON.stringify(Array.from({ length: GECMIS_EN_COK }, () => JSON.stringify({ ...a, durum: 'uygulandi', bitti: 1 }))));
    const c = (await komut(sahip, 'urun.satis', { id: 'u_c', satista: false })).body.komut as KontrolGecmisi;
    await call('POST', 'kontrol/iptal', { token: sahip, body: { id: c.id } });
    expect(historyOf()).toHaveLength(GECMIS_EN_COK);
    expect(historyOf()[0]!.id).toBe(c.id);
    expect((await panel(sahip)).body.gecmis).toHaveLength(GECMIS_EN_COK);
  });

  it('kuyruk işareti yarışı: nabız boş kuyruğu görüp işareti silerken giren komut kaybolmaz', async () => {
    await sifirla();
    const ozet = durumParmakIzi(durumOrnek());
    const ilk = (await komut(sahip, 'urun.satis', { id: 'u_ilk', satista: false })).body.komut as KontrolGecmisi;
    await nabiz({ kontrol: { ozet } });
    // Sonuç nabzı kuyruğu boş okur; tam o anda başka bir örnekte sahip yeni işlem gönderir (HSET, sonra işaret)
    const arayaGiren = 'k_arayagiren0000000000';
    araya = (cmd) => {
      if (cmd[0] !== 'HVALS') return false;
      const kayit = { id: arayaGiren, tur: 'urun.satis', veri: { id: 'u_iki', satista: false }, at: Date.now(), kim: OWNER, kurulum: kasaId, rol: 'sahip', ozet: 'Tükendi: araya', imza: 'x' };
      upstashCommand(store, ['HSET', `${REDIS_ONEKI}kontrol:komut:${kasaId}`, arayaGiren, JSON.stringify(kayit)]);
      upstashCommand(store, ['SET', `${REDIS_ONEKI}kontrol:var:${kasaId}`, '1']);
      return true;
    };
    const sonuc = await nabiz({ kontrol: { ozet, sonuclar: [{ id: ilk.id, durum: 'uygulandi', mesaj: '', at: Date.now() }] } });
    expect(araya).toBeNull();
    expect(sonuc.kontrol!.komutlar).toEqual([]);
    // Nabız işareti sildikten sonra kuyruğu yeniden saydı: işaret geri kondu, komut panelde bekliyor ve kasaya gider
    expect(store.has(`${REDIS_ONEKI}kontrol:var:${kasaId}`)).toBe(true);
    expect((await panel(sahip)).body.bekleyen.map((b) => b.id)).toEqual([arayaGiren]);
    expect((await nabiz({ kontrol: { ozet } })).kontrol!.komutlar.map((k) => k.id)).toEqual([arayaGiren]);
    await sifirla();
  });

  it('iptal ile teslim yarışı: nabız komutu iptalin denetimiyle silmesi arasında okursa iptal edilmez, kayıt geri konur', async () => {
    await sifirla();
    const c = (await komut(sahip, 'personel.duzenle', { id: 'p_kasa', aktif: false })).body.komut as KontrolGecmisi;
    // İptal teslim anını eski okur; tam o anda nabız teslim anını yazar ve kuyruğu okur (komut kasaya gider)
    let teslimEdilen: string[] = [];
    araya = (cmd) => {
      if (cmd[0] !== 'GET' || cmd[1] !== `${REDIS_ONEKI}kontrol:teslim:${kasaId}`) return false;
      upstashCommand(store, ['SET', `${REDIS_ONEKI}kontrol:teslim:${kasaId}`, String(Date.now() + 2_000)]);
      teslimEdilen = (upstashCommand(store, ['HVALS', `${REDIS_ONEKI}kontrol:komut:${kasaId}`]) as string[]).map((r) => (JSON.parse(r) as KomutKaydi).id);
      return true;
    };
    const res = await call('POST', 'kontrol/iptal', { token: sahip, body: { id: c.id } });
    expect(teslimEdilen).toEqual([c.id]);
    expect([res.status, res.body.code]).toEqual([409, 'delivered']);
    // Kayıt kuyrukta (kasanın sonucu geçmişe yazılsın), işaret yerinde, geçmişte "iptal" yok
    expect(Object.keys(queueOf())).toEqual([c.id]);
    expect(store.has(`${REDIS_ONEKI}kontrol:var:${kasaId}`)).toBe(true);
    expect(historyOf().some((x) => x.id === c.id)).toBe(false);
    await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()), sonuclar: [{ id: c.id, durum: 'uygulandi', mesaj: 'Uygulandı', at: Date.now() }] } });
    expect(historyOf()[0]).toMatchObject({ id: c.id, durum: 'uygulandi' });
    await sifirla();
  });

  it('kasanın açık anahtarı panele yalnız kasanın imzası tutarsa gider (Redis’e yazan anahtarı değiştiremez)', async () => {
    await sifirla();
    const dogru = (await panel(sahip)).body.durum!;
    expect(dogru.anahtar).toBe(ANAHTAR);
    expect('anahtarImza' in dogru).toBe(false);
    // Redis'e yazabilen biri anahtarı kendininkiyle değiştirir: imzayı ortak anahtar olmadan kuramaz; başka şubenin imzalı
    // anahtarı da bu kurulumda tutmaz
    const sahte = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const kayitli = JSON.parse(store.get(`${REDIS_ONEKI}kontrol:durum:${kasaId}`)!) as KontrolDurumu;
    for (const anahtarImza of [kayitli.anahtarImza, undefined, 'x'.repeat(43), anahtarImzasi('baskakurulum00000000000', sahte)]) {
      store.set(`${REDIS_ONEKI}kontrol:durum:${kasaId}`, JSON.stringify({ ...kayitli, anahtar: sahte, anahtarImza }));
      const d = (await panel(sahip)).body.durum!;
      expect(d.anahtar).toBe('');
      // Özetin geri kalanı görünür (PIN dışındaki işlemler sürer)
      expect(d.personel).toHaveLength(3);
    }
    await sifirla();
    expect((await panel(sahip)).body.durum!.anahtar).toBe(ANAHTAR);
  });

  it('özet: parmak izini bulut hesaplar; yoksa ya da farklıysa durumIste; büyük ya da bozuk özet saklanmaz', async () => {
    const key2 = 'ikinci-kasa-anahtari-'.padEnd(48, 'z');
    const id2 = await kayit(key2);
    // Hiç özet yok: bulut ister, panel durum null
    expect((await nabiz({ kontrol: { ozet: 'yok' } }, key2)).kontrol).toEqual({ durumIste: true, komutlar: [] });
    expect((await panel(sahip, id2)).body.durum).toBeNull();
    // Kasa yanlış parmak izi söylese de bulut kendisi hesaplar
    const d = durumOrnek({ servisModu: 'self' });
    expect((await nabiz({ kontrol: { ozet: 'yanlis', durum: d } }, key2)).kontrol!.durumIste).toBe(true);
    expect(store.get(`${REDIS_ONEKI}kontrol:ozet:${id2}`)).toBe(durumParmakIzi(d));
    log.length = 0;
    expect((await nabiz({ kontrol: { ozet: durumParmakIzi(d) } }, key2)).kontrol!.durumIste).toBe(false);
    expect(cmds()).toEqual(['MGET', 'SET', 'MGET']);
    expect((await panel(sahip, id2)).body.durum).toMatchObject({ servisModu: 'self', acik: true });
    // Aynı özet yeniden gelirse yazılmaz
    log.length = 0;
    await nabiz({ kontrol: { ozet: durumParmakIzi(d), durum: d } }, key2);
    expect(cmds()).toEqual(['MGET', 'SET', 'MGET']);

    // Sözleşme dışı alan saklanmaz, parmak izi kasanın gönderdiğinden (kasa yeniden göndermeye zorlanmaz)
    const extra = { ...d, servisModu: 'masa', fazla: 'x', personel: d.personel.map((p) => ({ ...p, pinOzeti: 'gizli' })) } as KontrolDurumu;
    expect((await nabiz({ kontrol: { ozet: durumParmakIzi(extra), durum: extra } }, key2)).kontrol!.durumIste).toBe(false);
    const stored = store.get(`${REDIS_ONEKI}kontrol:durum:${id2}`)!;
    expect(stored).not.toContain('pinOzeti');
    expect(stored).not.toContain('fazla');
    expect(JSON.parse(stored).servisModu).toBe('masa');

    // Bozuk ya da 64 KB'tan büyük özet saklanmaz
    const before = store.get(`${REDIS_ONEKI}kontrol:durum:${id2}`);
    await nabiz({ kontrol: { ozet: 'x', durum: { v: 1, acik: true } } }, key2);
    const huge = durumOrnek({ personel: Array.from({ length: 500 }, (_, i) => ({ id: `p${i}`, ad: 'Ç'.repeat(40), rol: 'garson' as const, renk: '#000000', aktif: true, indirim: 0, sonGiris: null })) });
    expect(Buffer.byteLength(JSON.stringify(huge))).toBeGreaterThan(64 * 1024);
    expect((await nabiz({ kontrol: { ozet: durumParmakIzi(huge), durum: huge } }, key2)).kontrol!.durumIste).toBe(true);
    expect(store.get(`${REDIS_ONEKI}kontrol:durum:${id2}`)).toBe(before);
  });

  it('açık PIN hiçbir Redis değerinde ve hiçbir yanıtta yok; panelde şifreli PIN ve imza yok', async () => {
    // Kuyrukta şifreli PIN'li komut dururken ve teslimden sonra
    await komut(sahip, 'personel.ekle', { ad: 'Deniz Kara', rol: 'garson', pin: sifrele(PIN) }, { ad: PIN });
    await komut(sahip, 'personel.pin', { id: 'p_kasa', pin: sifrele(PIN) });
    const beat = await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()) } });
    const imzalar = beat.kontrol!.komutlar.map((k) => k.imza);
    expect(imzalar.length).toBeGreaterThan(0);
    await panel(sahip);
    await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()), sonuclar: beat.kontrol!.komutlar.map((k) => ({ id: k.id, durum: 'uygulandi', mesaj: 'Uygulandı', at: Date.now() })) } });
    await panel(sahip);
    for (const [k, v] of store) expect(PIN_RE.test(String(v)), k).toBe(false);
    for (const text of seen) expect(PIN_RE.test(text)).toBe(false);
    for (const text of panelSeen) {
      for (const c of ciphers) expect(text.includes(c)).toBe(false);
      for (const s of imzalar) expect(text.includes(s)).toBe(false);
    }
    // Geçmişte yalnız özet: şifreli PIN de yok
    const history = store.get(`${REDIS_ONEKI}kontrol:gecmis:${kasaId}`) ?? '';
    for (const c of ciphers) expect(history.includes(c)).toBe(false);
  });
});

describe('uzaktan gün sonu ve güncelleme', () => {
  const kurulum = () => JSON.parse(store.get(`${REDIS_ONEKI}merkez:kurulum:${kasaId}`)!) as Record<string, unknown>;
  const merkezSatiri = async () => (await call<{ kurulumlar: Record<string, unknown>[] }>('GET', 'merkez/kurulumlar', { token: sahip })).body.kurulumlar.find((x) => x.id === kasaId)!;
  afterEach(async () => {
    kanal = null;
    (await api()).resetReleaseCache();
  });

  it('yalnız sahip: yönetici 403 (kasa ve panelle aynı neden), izleyici 403; hiçbir şey yazılmaz', async () => {
    await sifirla();
    const y = await komut(yonetici, 'gun.sonu', { not: '' }, { guncelle: true });
    expect([y.status, y.body.code, y.body.error]).toEqual([403, 'not_allowed', 'Gün sonunu uzaktan yalnız sahip alır']);
    const i = await komut(izleyici, 'gun.sonu', { not: '' }, { guncelle: true });
    expect([i.status, i.body.code]).toEqual([403, 'remote_readonly']);
    expect(Object.keys(queueOf())).toHaveLength(0);
    expect(kurulum().guncelleIstek).toBeUndefined();
  });

  it('kasa çevrimdışıyken gün sonu kuyruğa girmez (saatler sonra o arada açılan günü kapatırdı); öteki işlem girer', async () => {
    await sifirla();
    const k = `${REDIS_ONEKI}merkez:durum:${kasaId}`;
    store.set(k, JSON.stringify({ ...JSON.parse(store.get(k)!), lastSeen: Date.now() - 11 * 60_000 }));
    const off = await komut(sahip, 'gun.sonu', { not: '' }, { guncelle: true });
    expect([off.status, off.body.code, off.body.error]).toEqual([409, 'kasa_cevrimdisi', 'Kasa şu an çevrimdışı: gün sonu yalnız kasa bağlıyken uzaktan alınır. Kasa yeniden bağlanınca deneyin']);
    expect(Object.keys(queueOf())).toHaveLength(0);
    expect(kurulum().guncelleIstek).toBeUndefined();
    expect([...store.keys()].some((x) => x.startsWith(`${REDIS_ONEKI}kontrol:sayac:`))).toBe(false);
    // Öteki işlemler kasa açılınca (24 saat içinde) uygulanmak üzere sıraya girer
    expect((await komut(sahip, 'ayar.servis', { mod: 'self' })).status).toBe(200);
    await sifirla();
  });

  it('"Gün sonu al ve güncelle" Merkez’in "Şimdi güncelle"siyle aynı kaydı yazar, gün sonuna bağlı; kasa nabızla ikisini birlikte alır', async () => {
    await sifirla();
    kanal = { v: 1, version: '0.5.0', build: 2000, date: '2026-11-23T10:00:00.000Z', not: 'Yeni sürüm' };
    (await api()).resetReleaseCache();
    // Güncellemesiz gün sonu Merkez kaydına dokunmaz
    expect((await komut(sahip, 'gun.sonu', { not: '' })).status).toBe(200);
    expect(kurulum().guncelleIstek).toBeUndefined();
    await sifirla();
    const sent = await komut(sahip, 'gun.sonu', { not: '' }, { guncelle: true });
    expect(sent.status).toBe(200);
    const { id, at } = sent.body.komut as KontrolGecmisi;
    // Hedef ve gönderim anı da yazılır: Merkez satırı adımları gösterir, kasa sürümü Merkez'den gönderilmiş sayar
    // (kasiyere sorulmaz), güncelleyicinin Merkez sınırı gönderilene ayarlı kalır
    expect(kurulum()).toMatchObject({ guncelleIstek: at, guncelleKomut: id, hedef: 2000, gonderildi: at });
    expect(await merkezSatiri()).toMatchObject({ hedef: 2000, istekBekliyor: true, gonderim: { etiket: expect.stringMatching(/^Gönderildi \d{2}:\d{2}$/) } });
    const beat = await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()) } });
    expect(beat).toMatchObject({ guncelleIstek: at, guncelleKomut: id, hedef: 2000 });
    expect(beat.kontrol!.komutlar.map((x) => x.id)).toEqual([id]);

    // Merkez'in kendi düğmesi aynı yoldan, bağsız
    await new Promise((r) => setTimeout(r, 5));
    const asked = await call('POST', 'merkez/simdi-guncelle', { token: sahip, body: { ids: [kasaId] } });
    expect(asked.body).toMatchObject({ ok: true, istenen: 1, build: 2000 });
    expect(kurulum()).toMatchObject({ guncelleKomut: null, hedef: 2000 });
    expect(kurulum().guncelleIstek).toBeGreaterThan(at);
    expect(await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()) } })).toMatchObject({ guncelleKomut: null });
    await sifirla();
  });

  it('kasaya gitmeden iptal edilen gün sonunun güncelleme isteği de geri alınır; Merkez "Şimdi güncelle" yeniden açık', async () => {
    await sifirla();
    kanal = { v: 1, version: '0.5.0', build: 2000, date: '2026-11-23T10:00:00.000Z', not: 'Yeni sürüm' };
    (await api()).resetReleaseCache();
    const sent = await komut(sahip, 'gun.sonu', { not: '' }, { guncelle: true });
    const { id, at } = sent.body.komut as KontrolGecmisi;
    expect(await merkezSatiri()).toMatchObject({ istekBekliyor: true });
    const iptal = await call('POST', 'kontrol/iptal', { token: sahip, body: { id } });
    expect(iptal.body.komut).toMatchObject({ id, durum: 'iptal' });
    // İstek geri alındı: Merkez "Güncelleme istendi" demez, düğmesi açık; kasa nabızda isteği görmez (30 dakika gün
    // sonunu bekleyip "kasaya ulaşmadı" yazmaz). Gönderilen hedef kalır (reddedilen gün sonundaki gibi)
    expect(kurulum()).toMatchObject({ guncelleIstek: null, guncelleKomut: null, hedef: 2000, gonderildi: at });
    expect(await merkezSatiri()).toMatchObject({ istekBekliyor: false, hedef: 2000 });
    const beat = await nabiz({ kontrol: { ozet: durumParmakIzi(durumOrnek()) } });
    expect(beat).toMatchObject({ guncelleIstek: null, guncelleKomut: null });
    expect(beat.kontrol!.komutlar).toEqual([]);

    // Arada Merkez'den verilen "Şimdi güncelle" (bağsız) eski gün sonunun iptaliyle geri alınmaz; başka işlemin iptali de
    // isteğe dokunmaz
    const ikinci = (await komut(sahip, 'gun.sonu', { not: '' }, { guncelle: true })).body.komut as KontrolGecmisi;
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('POST', 'merkez/simdi-guncelle', { token: sahip, body: { ids: [kasaId] } })).body).toMatchObject({ ok: true, istenen: 1 });
    const merkezIstegi = kurulum().guncelleIstek;
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: ikinci.id } })).status).toBe(200);
    expect(kurulum()).toMatchObject({ guncelleIstek: merkezIstegi, guncelleKomut: null });
    expect(await merkezSatiri()).toMatchObject({ istekBekliyor: true });
    const servis = (await komut(sahip, 'ayar.servis', { mod: 'self' })).body.komut as KontrolGecmisi;
    expect((await call('POST', 'kontrol/iptal', { token: sahip, body: { id: servis.id } })).status).toBe(200);
    expect(kurulum()).toMatchObject({ guncelleIstek: merkezIstegi });
    await sifirla();
  });
});

describe('panel üyeleri', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('davet → kodla ilk giriş → normal giriş → rol değişimi → kaldırınca oturum düşer', async () => {
    const eposta = 'yeni@ornek.test';
    const davet = await call<{ ok: boolean; kod: string; bitis: number }>('POST', 'kontrol/uye', { token: sahip, body: { eposta: ' Yeni@Ornek.TEST ', rol: 'yonetici' } });
    expect(davet.status).toBe(200);
    expect(davet.body.kod).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(davet.body.bitis).toBeGreaterThan(Date.now() + DAVET_OMRU_MS - 60_000);
    // Redis'te kodun kendisi değil özeti
    const saved = store.get(`${REDIS_ONEKI}uye-davet:${eposta}`)!;
    expect(saved).not.toContain(davet.body.kod.replace(/-/g, ''));
    expect(saved).not.toContain(davet.body.kod);
    expect(JSON.parse(saved)).toMatchObject({ rol: 'yonetici', kim: OWNER, kod: expect.stringMatching(/^[0-9a-f]{64}$/) });
    let list = (await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: sahip })).body.uyeler;
    expect(list.find((u) => u.eposta === eposta)).toMatchObject({ rol: 'yonetici', durum: 'davet', sabit: false, davetBitis: davet.body.bitis });

    // Yanlış kod ve davetsiz e-posta aynı yanıtı alır
    const wrong = await call('POST', 'uzaktan/uye', { body: { eposta, parola: 'yeni-parola-2026', davet: 'AAAA-BBBB-CCCC' }, shop: null });
    const stranger = await call('POST', 'uzaktan/uye', { body: { eposta: 'baska@ornek.test', parola: 'yeni-parola-2026', davet: davet.body.kod }, shop: null });
    expect([wrong.status, stranger.status]).toEqual([403, 403]);
    expect(wrong.body).toEqual(stranger.body);
    // Kod büyük-küçük harf, boşluk ve tireden bağımsız
    const made = await call<{ token: string }>('POST', 'uzaktan/uye', { body: { eposta, parola: 'yeni-parola-2026', davet: ` ${davet.body.kod.toLowerCase().replace(/-/g, ' ')} ` }, shop: null });
    expect(made.status).toBe(200);
    expect(store.has(`${REDIS_ONEKI}uye-davet:${eposta}`)).toBe(false);
    expect(JSON.parse(store.get(`${REDIS_ONEKI}uye:${eposta}`)!)).toMatchObject({ rol: 'yonetici', h: expect.stringMatching(/^s1\$/) });
    // Kod bir kez
    expect((await call('POST', 'uzaktan/uye', { body: { eposta, parola: 'baska-parola-2026', davet: davet.body.kod }, shop: null })).status).toBe(403);
    list = (await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: sahip })).body.uyeler;
    expect(list.find((u) => u.eposta === eposta)).toMatchObject({ durum: 'aktif', davetBitis: null });

    const token = await girisYap(eposta, 'yeni-parola-2026');
    expect((await panel(token)).body.ben).toEqual({ eposta, rol: 'yonetici' });
    expect((await komut(token, 'urun.satis', { id: 'u_yeni', satista: false })).status).toBe(200);
    // Görünümün geri kalanı açık (kafe özet itmedi: oturum geçerli, veri yok)
    expect((await call('GET', 'bootstrap', { token })).body.code).toBe('no_snapshot');

    // Rol değişimi: oturum düşmez, yeni rol hemen
    expect((await call('POST', 'kontrol/uye-rol', { token: sahip, body: { eposta, rol: 'izleyici' } })).status).toBe(200);
    expect((await panel(token)).body.ben.rol).toBe('izleyici');
    expect((await komut(token, 'urun.satis', { id: 'u_yeni', satista: true })).body.code).toBe('remote_readonly');

    // Kaldırma: kayıt silinir, oturum düşer
    expect((await call('POST', 'kontrol/uye-sil', { token: sahip, body: { eposta } })).status).toBe(200);
    expect(store.has(`${REDIS_ONEKI}uye:${eposta}`)).toBe(false);
    expect((await panel(token)).status).toBe(401);
    expect((await call('GET', 'bootstrap', { token })).status).toBe(401);
    expect((await call('POST', 'uzaktan/giris', { body: { eposta, parola: 'yeni-parola-2026' }, shop: null })).status).toBe(401);
    list = (await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: sahip })).body.uyeler;
    expect(list.some((u) => u.eposta === eposta)).toBe(false);
    await sifirla();
  });

  it('ortamdaki sahip davet edilmez, rolü değişmez, kaldırılmaz; panel erişimini yalnız sahip yönetir', async () => {
    for (const path of ['kontrol/uye', 'kontrol/uye-rol', 'kontrol/uye-sil']) {
      const res = await call('POST', path, { token: sahip, body: { eposta: OWNER.toUpperCase(), rol: 'izleyici' } });
      expect([res.status, res.body.code], path).toEqual([409, 'owner_fixed']);
    }
    expect(store.has(`${REDIS_ONEKI}uye:${OWNER}`)).toBe(true);
    const list = (await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: sahip })).body.uyeler;
    expect(list[0]).toMatchObject({ eposta: OWNER, rol: 'sahip', durum: 'aktif', sabit: true });
    expect(list.filter((u) => !u.sabit).map((u) => [u.eposta, u.rol])).toEqual([
      ['izler@ornek.test', 'izleyici'],
      ['mudur@ornek.test', 'yonetici'],
    ]);
    // Biçim ve rol denetlenir; sahip panelden verilmez
    expect((await call('POST', 'kontrol/uye', { token: sahip, body: { eposta: 'eposta-degil', rol: 'izleyici' } })).status).toBe(400);
    expect((await call('POST', 'kontrol/uye', { token: sahip, body: { eposta: 'ikinci@ornek.test', rol: 'sahip' } })).status).toBe(400);
    expect((await call('POST', 'kontrol/uye', { token: sahip, body: { eposta: 'mudur@ornek.test', rol: 'izleyici' } })).body.code).toBe('member_exists');
    expect((await call('POST', 'kontrol/uye-rol', { token: sahip, body: { eposta: 'yok@ornek.test', rol: 'izleyici' } })).status).toBe(404);
    for (const token of [yonetici, izleyici]) {
      expect((await call('GET', 'kontrol/uyeler', { token })).body.code).toBe('not_allowed');
      expect((await call('POST', 'kontrol/uye', { token, body: { eposta: 'kotu@ornek.test', rol: 'yonetici' } })).body.code).toBe('not_allowed');
      expect((await call('POST', 'kontrol/uye-sil', { token, body: { eposta: 'izler@ornek.test' } })).body.code).toBe('not_allowed');
    }
    expect(store.has(`${REDIS_ONEKI}uye:izler@ornek.test`)).toBe(true);
  });

  it('davet edilen üye Merkez ve bildirimde 403 alır, oturumu düşmez; süresi dolan davet listeden düşer', async () => {
    for (const token of [yonetici, izleyici]) {
      const m = await call('GET', 'merkez/kurulumlar', { token });
      expect([m.status, m.body.code]).toEqual([403, 'remote_admin']);
      expect((await call('POST', 'uzaktan/bildirim/abone', { token, body: {} })).status).toBe(403);
      expect((await panel(token)).status).toBe(200);
    }
    expect((await call('GET', 'merkez/kurulumlar', { token: sahip })).status).toBe(200);

    // Davet 7 gün: süresi dolan (Redis'te silinmemiş olsa da) listeden ve kümeden düşer
    const davet = await call<{ kod: string }>('POST', 'kontrol/uye', { token: sahip, body: { eposta: 'gec@ornek.test', rol: 'izleyici' } });
    expect(davet.status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + DAVET_OMRU_MS + 60_000);
    const list = (await call<{ uyeler: UzaktanUye[] }>('GET', 'kontrol/uyeler', { token: sahip })).body.uyeler;
    expect(list.some((u) => u.eposta === 'gec@ornek.test')).toBe(false);
    expect(JSON.parse(store.get(`${REDIS_ONEKI}uyeler`) ?? '[]')).not.toContain('gec@ornek.test');
  });
});
