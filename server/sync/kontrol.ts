import { constants, createHmac, generateKeyPairSync, privateDecrypt, timingSafeEqual } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import {
  anahtarImzaMetni,
  type AyarServis,
  durumParmakIzi,
  GUN_SONU_OMRU_MS,
  imzaMetni,
  KOMUT_ID_RE,
  KOMUT_OMRU_MS,
  KOMUT_TURLERI,
  komutDogrula,
  komutOzeti,
  type KomutSonucu,
  type KomutTuru,
  type KomutVerisi,
  KONTROL_SURUM,
  type KontrolDurumu,
  KUYRUK_EN_COK,
  type NabizKontrol,
  type OzetAdlari,
  ozetAdi,
  type PersonelDuzenle,
  type PersonelEkle,
  type PersonelPin,
  type RolYetki,
  SAAT_PAYI_MS,
  type SecenekSatis,
  secenekOzetAdi,
  type SonucDurumu,
  type UrunSatis,
  UYE_ROLLERI,
  type UyeRolu,
  uyeYapabilir,
  type SecenekGrubu,
  type UrunEkle,
  type SecenekDuzenle,
  type GunSonu,
  type UrunGorsel,
  type UrunGorunum,
} from '@shared/kontrol';
import { ALL_PERMISSIONS, type Role, ROLES, rolePermissions } from '@shared/permissions';
import { serviceModeOf } from '@shared/service-mode';
import { db, schema, tx } from '../db/client';
import { env } from '../env';
import { internalActors, isValidPin, remoteActor } from '../lib/auth';
import { Effects } from '../lib/effects';
import { getSettings, getSyncState, setSyncState } from '../lib/settings';
import { MIN_SECRET_LENGTH } from '../lib/signature';
import { getOpenDay } from '../services/orders';
import { identity } from './merkez';

/**
 * Uzaktan yönetim, kasa tarafı (docs/UZAKTAN-YONETIM.md; sözleşme shared/kontrol.ts). Merkez nabzı (sync/merkez.ts)
 * her istekte kasanın yönetim özetinin parmak izini, gerektiğinde özetin kendisini ve bildirilmemiş sonuçları götürür;
 * yanıtta gelen komutları burası uygular. Ayrı yoklama ve ayrı zamanlayıcı yok.
 *
 * Her komut sırayla: doğrulama (`komutDogrula`, alanlar sabit sırayla yeniden kurulur) → imza (doğrulanmış veriden
 * `imzaMetni`, bu kurulumun kimliği ve üyenin rolüyle, kafenin ortak anahtarıyla HMAC-SHA256, sabit zamanlı
 * karşılaştırma) → daha önce işlendi mi (son 500 kimlik; daha eskisi için alt sınır) → süre (`KOMUT_OMRU_MS`; gün sonu
 * `GUN_SONU_OMRU_MS` ve istekten sonra açılan gün; gelecekten `SAAT_PAYI_MS`) → kasada uzaktan yönetim açık mı → üyenin
 * rolü bu işlemi verebilir mi (hedefin kasadaki gerçek rolüyle: `uyeYapabilir`) → PIN'i özel anahtarla çözer → kasanın
 * yönetim ekranının kullandığı uca süreç içi istek (yönetici patron olmayan kimlikle: remoteActor). Yetki, doğrulama,
 * denetim kaydı ve canlı olaylar o uçtadır; burada ayrı iş kuralı yok. Açık PIN hiçbir günlüğe, sonuca, denetim kaydına
 * ya da sync state'e yazılmaz.
 *
 * Tarayıcı demosunda yüklenmez: modülü yalnız Merkez açıkken nabız tembel yükler, demoda Merkez hiç açılmaz (RSA'nın
 * demo karşılığı yok; demo/shims/crypto.ts adları yalnız derleme için verir).
 */

const ANAHTAR = 'kontrol.anahtar';
const ISLENEN = 'kontrol.islenen';
const SONUCLAR = 'kontrol.sonuclar';
const GONDERILEN = 'kontrol.gonderilen';
/** Listeden düşen en yeni komutun anı: bundan eski ya da aynı anlı, listede olmayan komut uygulanmaz (tekrar) */
const TABAN = 'kontrol.taban';
/** Tekrar oynatmaya karşı hatırlanan son komutlar; listeden düşenler için TABAN */
const ISLENEN_EN_COK = 500;
/** Bildirilmeyi bekleyen en çok sonuç (internet yokken birikir) ve bir nabızda giden en çok sonuç (nabız gövdesi küçük kalsın) */
const SONUC_EN_COK = 200;
const NABIZ_SONUC_EN_COK = 20;
const MESAJ_EN_COK = 200;
const SAAT_MS = 3_600_000;

interface Anahtar {
  /** Açık anahtar: SPKI (DER), base64 */
  pub: string;
  /** Özel anahtar: PKCS8 (PEM); yalnız bu veritabanında */
  priv: string;
}

/** İşlenmiş komut: kimliği ve sonucu (aynı komut yeniden gelirse uygulanmaz, sonucu yeniden bildirilir) */
interface Islenen {
  id: string;
  durum: SonucDurumu;
  mesaj: string;
  at: number;
  /** Komutun buluttaki anı (imzalı): listeden düşünce alt sınır olur */
  komutAt: number;
  /** Kasanın kendi adlarıyla özet (yeniden bildirilirken de gider) */
  ozet?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

// ─── Anahtar ve özet ─────────────────────────────────────────────────────────

/**
 * Kasanın anahtar çifti (RSA-OAEP 2048, SHA-256): ilk gerektiğinde üretilir ve hep aynı kalır. Açık anahtar özetle
 * buluta gider (tarayıcı PIN'i onunla şifreler), özel anahtar yalnız bu veritabanında
 */
function anahtar(): Anahtar {
  const kayitli = getSyncState<Anahtar>(ANAHTAR);
  if (kayitli?.pub && kayitli.priv) return kayitli;
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const yeni: Anahtar = { pub: publicKey.toString('base64'), priv: privateKey };
  setSyncState(ANAHTAR, yeni);
  return yeni;
}

/**
 * Son giriş saat başına yuvarlanır: her PIN girişinde özetin parmak izi değişip nabızla yeniden gitmesin (Redis bütçesi;
 * panel için "bugün 14 sularında" yeter)
 */
const saatBasi = (t: number | null) => (t == null ? null : Math.floor(t / SAAT_MS) * SAAT_MS);

/** Kasanın yönetim özeti: personel (PIN ve PIN özeti yok), rollerin yetkileri, servis modu, açık anahtar */
export function kontrolDurumu(now = Date.now()): KontrolDurumu {
  const s = getSettings();
  const users = db
    .select({ id: schema.users.id, name: schema.users.name, role: schema.users.role, color: schema.users.color, active: schema.users.active, maxDiscountPct: schema.users.maxDiscountPct, lastLoginAt: schema.users.lastLoginAt })
    .from(schema.users)
    .orderBy(asc(schema.users.name), asc(schema.users.id))
    .all();
  const matrix = s.rolePermissions;
  const pub = anahtar().pub;
  return {
    v: KONTROL_SURUM,
    at: now,
    acik: s.remoteControl !== false,
    turler: [...KOMUT_TURLERI],
    anahtar: pub,
    // Bulut anahtarı panele yalnız bu imza tutarsa verir: Redis'e yazabilen biri anahtarı kendininkiyle değiştiremez
    ...(env.cloudSecret.length >= MIN_SECRET_LENGTH ? { anahtarImza: createHmac('sha256', env.cloudSecret).update(anahtarImzaMetni(identity(now).id, pub)).digest('base64url') } : {}),
    personel: users.map((u) => ({ id: u.id, ad: u.name, rol: u.role, renk: u.color, aktif: u.active, indirim: u.maxDiscountPct, sonGiris: saatBasi(u.lastLoginAt) })),
    // Yetkiler listedeki sırayla: aynı set her zaman aynı parmak izini verir
    roller: ROLES.map((rol) => {
      const set = rolePermissions(rol, matrix);
      return { rol, izinler: ALL_PERMISSIONS.filter((p) => set.includes(p)), ozel: !!matrix[rol], kisi: users.filter((u) => u.active && u.role === rol).length };
    }),
    servisModu: serviceModeOf(s),
  };
}

const islenenler = () => getSyncState<Islenen[]>(ISLENEN) ?? [];
const bekleyenler = () => getSyncState<KomutSonucu[]>(SONUCLAR) ?? [];

/**
 * İşlenmiş komutun sonucu (son 500 içinde); kasa henüz görmediyse null. "Gün sonu al ve güncelle"de Merkez'in güncelleme
 * isteği bu gün sonunun sonucuna bağlıdır (sync/merkez.ts takeRemoteUpdate). Yarıda kalan işlem reddedilmiş sayılır.
 * İmzası ya da verisi tutmayan komut işlenmiş listeye yazılmaz, yalnız bildirilecek sonuca (komutIsle): onun reddi de
 * görülür. Yoksa bağlı istek 30 dakika bekleyip "uygulanmadı" diye kapanıyordu (inceleme, 23 Kas 2026)
 */
export const komutDurumu = (id: string): SonucDurumu | null => (islenenler().find((x) => x.id === id) ?? bekleyenler().find((x) => x.id === id))?.durum ?? null;

/**
 * Nabız isteğine eklenen kısım: özetin parmak izi her zaman; özetin kendisi yalnız bulut istediyse ya da son iletilenden
 * farklıysa; bildirilmemiş sonuçlar (bir nabızda en çok 20)
 */
export function nabizKontrol(cloudIstedi = false, now = Date.now()): NabizKontrol {
  const durum = kontrolDurumu(now);
  const ozet = durumParmakIzi(durum);
  const out: NabizKontrol = { ozet };
  if (cloudIstedi || getSyncState<string>(GONDERILEN) !== ozet) out.durum = durum;
  const sonuclar = bekleyenler().slice(0, NABIZ_SONUC_EN_COK);
  if (sonuclar.length) out.sonuclar = sonuclar;
  return out;
}

/** Nabız başarıyla gitti: iletilen özet kaydedilir, iletilen sonuçlar silinir */
export function nabizIletildi(giden: NabizKontrol) {
  if (giden.durum) setSyncState(GONDERILEN, giden.ozet);
  if (giden.sonuclar?.length) {
    const gitti = new Set(giden.sonuclar.map((s) => s.id));
    setSyncState(SONUCLAR, bekleyenler().filter((s) => !gitti.has(s.id)));
  }
}

// ─── Komutlar ────────────────────────────────────────────────────────────────

/**
 * İmza: doğrulanmış veriden imza metni, kafenin ortak anahtarıyla HMAC-SHA256 (base64url), sabit zamanlı karşılaştırma.
 * Kurulum kasanın kendi kimliği: başka şubenin kuyruğundan kopyalanan komut tutmaz
 */
function imzaTutar(k: { id: string; tur: KomutTuru; veri: KomutVerisi; at: number; kim: string; rol: UyeRolu }, imza: string): boolean {
  if (env.cloudSecret.length < MIN_SECRET_LENGTH) return false;
  const beklenen = Buffer.from(createHmac('sha256', env.cloudSecret).update(imzaMetni({ ...k, kurulum: identity().id })).digest('base64url'));
  const gelen = Buffer.from(imza.replace(/=+$/, ''));
  return gelen.length === beklenen.length && timingSafeEqual(gelen, beklenen);
}

/** Tarayıcının kasanın açık anahtarıyla şifrelediği PIN; çözülemezse null */
function pinCoz(sifreli: string): string | null {
  try {
    return privateDecrypt({ key: anahtar().priv, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(sifreli, 'base64')).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Kasanın kendi adlarıyla özet ("PIN değiştir: Ayşe"): bulutun gönderdiği özet metni imzalı değil, kayda girmez. Sonuçla
 * buluta da gider (geçmişe bu yazılır): ürün ve seçenek adı arayüzün eşlediği biçimde (`ozetAdi`, seçenek grubuyla)
 */
function yerelOzet(tur: KomutTuru, veri: KomutVerisi): string {
  const adlar: OzetAdlari = {};
  const id = (veri as { id?: unknown }).id;
  if (typeof id === 'string') {
    if (tur === 'personel.duzenle' || tur === 'personel.pin') {
      const u = db.select({ name: schema.users.name }).from(schema.users).where(eq(schema.users.id, id)).get();
      if (u) adlar.personel = { [id]: u.name };
    } else if (tur === 'urun.satis' || tur === 'urun.gorunum' || tur === 'urun.gorsel') {
      const p = db.select({ name: schema.products.name }).from(schema.products).where(eq(schema.products.id, id)).get();
      if (p) adlar.urun = { [id]: ozetAdi(p.name) };
    } else if (tur === 'secenek.satis') {
      const o = db
        .select({ name: schema.optionItems.name, grup: schema.optionGroups.name })
        .from(schema.optionItems)
        .innerJoin(schema.optionGroups, eq(schema.optionGroups.id, schema.optionItems.groupId))
        .where(eq(schema.optionItems.id, id))
        .get();
      if (o) adlar.secenek = { [id]: ozetAdi(secenekOzetAdi(o.name, o.grup)) };
    }
  }
  return komutOzeti(tur, veri, adlar);
}

/** İşlemin dokunduğu personelin kasadaki rolü ve (eklemede, rol değişiminde) yeni rolü: rol kapısı bunlarla */
function hedefRolleri(tur: KomutTuru, veri: KomutVerisi): (Role | undefined)[] {
  if (tur === 'personel.ekle') return [(veri as PersonelEkle).rol];
  if (tur !== 'personel.duzenle' && tur !== 'personel.pin') return [];
  const id = (veri as PersonelDuzenle | PersonelPin).id;
  const u = db.select({ role: schema.users.role }).from(schema.users).where(eq(schema.users.id, id)).get();
  return [u?.role, tur === 'personel.duzenle' ? (veri as PersonelDuzenle).rol : undefined];
}

interface Istek {
  method: 'POST' | 'PATCH' | 'PUT';
  yol: string;
  govde: Record<string, unknown>;
}

/** Komutun karşılığı olan uç: kasadaki yönetim ekranının kullandığı uç ve gövde (docs/UZAKTAN-YONETIM.md tablosu) */
function istekOf(tur: KomutTuru, veri: KomutVerisi, pin: string | null): Istek {
  const id = (v: { id: string }) => encodeURIComponent(v.id);
  switch (tur) {
    case 'personel.ekle': {
      const v = veri as PersonelEkle;
      return {
        method: 'POST',
        yol: '/api/admin/users',
        govde: { name: v.ad, role: v.rol, ...(v.renk !== undefined ? { color: v.renk } : {}), ...(v.indirim !== undefined ? { maxDiscountPct: v.indirim } : {}), pin },
      };
    }
    case 'personel.duzenle': {
      const v = veri as PersonelDuzenle;
      const govde: Record<string, unknown> = {};
      if (v.ad !== undefined) govde.name = v.ad;
      if (v.rol !== undefined) govde.role = v.rol;
      if (v.aktif !== undefined) govde.active = v.aktif;
      if (v.indirim !== undefined) govde.maxDiscountPct = v.indirim;
      return { method: 'PATCH', yol: `/api/admin/users/${id(v)}`, govde };
    }
    case 'personel.pin':
      return { method: 'PATCH', yol: `/api/admin/users/${id(veri as PersonelPin)}`, govde: { pin } };
    case 'rol.yetki': {
      const v = veri as RolYetki;
      return { method: 'PUT', yol: `/api/admin/roles/${encodeURIComponent(v.rol)}`, govde: { permissions: v.izinler } };
    }
    case 'urun.satis': {
      const v = veri as UrunSatis;
      return { method: 'POST', yol: `/api/sync/products/${id(v)}/availability`, govde: { active: v.satista } };
    }
    case 'secenek.satis': {
      const v = veri as SecenekSatis;
      return { method: 'POST', yol: `/api/option-items/${id(v)}/sold-out`, govde: { soldOut: !v.satista } };
    }
    case 'ayar.servis':
      return { method: 'PUT', yol: '/api/admin/settings', govde: { serviceMode: (veri as AyarServis).mod } };
    case 'urun.gorunum': {
      const v = veri as UrunGorunum;
      return { method: 'PATCH', yol: `/api/admin/products/${id(v)}`, govde: { hidden: !v.gorunur } };
    }
    case 'urun.gorsel': {
      const v = veri as UrunGorsel;
      return { method: 'PATCH', yol: `/api/admin/products/${id(v)}`, govde: { image: v.gorsel } };
    }
    case 'gun.sonu':
      // Kasanın kendi gün sonu ucu: Pavo banka gün sonu, lafmaliyet gönderimi ve bildirimler aynı (sayımsız kapanış)
      return { method: 'POST', yol: '/api/cash/day/close', govde: { countedCash: null, note: `Uzaktan gün sonu${(veri as GunSonu).not ? `: ${(veri as GunSonu).not}` : ''}` } };
    case 'secenek.duzenle': {
      // Yalnız ekleme: grubun bugünkü hali ve bağları kasadan okunur, yenileri eklenir (PUT tam listeyi ister)
      const v = veri as SecenekDuzenle;
      const g = db.select().from(schema.optionGroups).where(eq(schema.optionGroups.id, v.grup)).get();
      if (!g) return { method: 'PUT', yol: `/api/admin/option-groups/${encodeURIComponent(v.grup)}`, govde: {} };
      const items = db.select().from(schema.optionItems).where(eq(schema.optionItems.groupId, g.id)).orderBy(asc(schema.optionItems.sort)).all().filter((i) => i.active);
      const linked = db.select({ id: schema.productOptionGroups.productId }).from(schema.productOptionGroups).where(eq(schema.productOptionGroups.groupId, g.id)).all().map((r) => r.id);
      const have = new Set(items.map((i) => i.name.toLocaleLowerCase('tr')));
      return {
        method: 'PUT',
        yol: `/api/admin/option-groups/${encodeURIComponent(g.id)}`,
        govde: {
          name: g.name,
          kind: g.kind,
          required: g.required,
          maxSelect: g.maxSelect,
          sort: g.sort,
          active: g.active,
          items: [
            ...items.map((i) => ({ id: i.id, name: i.name, price: i.price, isDefault: i.isDefault, maxQty: i.maxQty, active: i.active })),
            ...v.ogeler.filter((o) => !have.has(o.ad.toLocaleLowerCase('tr'))).map((o) => ({ name: o.ad, price: o.fiyat })),
          ],
          productIds: [...new Set([...linked, ...v.urunler])],
        },
      };
    }
    case 'urun.ekle': {
      const v = veri as UrunEkle;
      return { method: 'POST', yol: '/api/admin/products', govde: { categoryId: v.kategori, name: v.ad, price: v.fiyat, kdvRate: v.kdv, groupIds: v.gruplar } };
    }
    case 'secenek.grubu': {
      const v = veri as SecenekGrubu;
      return {
        method: 'POST',
        yol: '/api/admin/option-groups',
        govde: { name: v.ad, kind: 'single', required: v.zorunlu, maxSelect: 1, items: v.ogeler.map((o) => ({ name: o.ad, price: o.fiyat, isDefault: o.varsayilan })), productIds: v.urunler },
      };
    }
  }
}

type Kasa = { fetch: (req: Request) => Response | Promise<Response> };
let kasaApp: Promise<Kasa> | null = null;

/** Kasanın kendi uygulaması, tek örnek; tembel yüklenir (app.ts → merkez.ts → burası döngüsü olmasın) */
function kasa(): Promise<Kasa> {
  kasaApp ??= import('../app')
    .then((m) => m.createApp())
    .catch((e: unknown) => {
      // Yükleme düştüyse bir sonraki komut yeniden dener
      kasaApp = null;
      throw e;
    });
  return kasaApp;
}

/**
 * Süreç içi istek: istek nesnesi uzaktan kimliğiyle `internalActors`'a kaydedilir (ağdan gelen istek bu kimliği
 * taşıyamaz). 2xx uygulandı; değilse ucun Türkçe hata iletisi
 */
async function uygula(kim: string, rol: 'sahip' | 'yonetici', istek: Istek): Promise<{ ok: boolean; mesaj: string }> {
  const app = await kasa();
  const req = new Request(`http://kasa.local${istek.yol}`, { method: istek.method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(istek.govde) });
  internalActors.set(req, remoteActor(kim, rol));
  try {
    const res = await app.fetch(req);
    const text = await res.text().catch(() => '');
    if (res.ok) return { ok: true, mesaj: 'Uygulandı' };
    let hata: unknown = null;
    try {
      hata = (JSON.parse(text) as { error?: unknown }).error;
    } catch {
      hata = null;
    }
    return { ok: false, mesaj: typeof hata === 'string' && hata.trim() ? hata.trim() : `İşlem uygulanamadı (${res.status})` };
  } finally {
    internalActors.delete(req);
  }
}

/** Sonuç metni kısa ve tek satır; PIN geçiyorsa gizlenir (uçların iletileri PIN içermez, yine de) */
function temizle(mesaj: string, pin: string | null): string {
  let m = mesaj.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (pin) m = m.split(pin).join('••••');
  return m.slice(0, MESAJ_EN_COK) || 'Reddedildi';
}

/** Listeden düşmüş komutların alt sınırı: bundan eski ya da aynı anlı, listede olmayan komut tekrar sayılır */
const taban = () => getSyncState<number>(TABAN) ?? 0;

/**
 * İşlenmiş komutlar listesine yazar (aynı kimlik varsa yerini alır; en çok 500). Düşen kayıtların en yeni anı alt sınır
 * olur: liste dolsa da eski bir komut (24 saat içinde) yeniden uygulanmaz. Kuyruk komutun anına göre sıralı gelir, liste
 * de işlenme sırasıyla dolar: düşen kayıt bekleyen her komuttan eskidir
 */
function islenenYaz(kayit: Islenen) {
  const list = islenenler().filter((x) => x.id !== kayit.id);
  list.push(kayit);
  const dusen = list.slice(0, Math.max(0, list.length - ISLENEN_EN_COK));
  if (dusen.length) setSyncState(TABAN, Math.max(taban(), ...dusen.map((x) => (Number.isFinite(x.komutAt) ? x.komutAt : x.at))));
  setSyncState(ISLENEN, list.slice(-ISLENEN_EN_COK));
}

/** Bildirilecek sonuç (aynı kimlik varsa yerini alır; en çok 200, eskiler düşer) */
function sonucYaz(sonuc: KomutSonucu) {
  const list = bekleyenler().filter((x) => x.id !== sonuc.id);
  list.push(sonuc);
  setSyncState(SONUCLAR, list.slice(-SONUC_EN_COK));
}

/** Komutun son sonucu: işlenmiş listeye ve bildirilecekler listesine birlikte; özet kasanın kendi adlarıyla */
function bitir(id: string, durum: SonucDurumu, mesaj: string, at: number, komutAt: number, ozet: string) {
  const m = mesaj.slice(0, MESAJ_EN_COK);
  tx(() => {
    islenenYaz({ id, durum, mesaj: m, at, komutAt, ozet });
    sonucYaz({ id, durum, mesaj: m, at, ozet });
  });
}

/** Reddedilen uzaktan işlem kasanın denetim kaydına (uygulanan işlemi ucun kendisi "Uzaktan (e-posta)" adıyla yazar) */
function redKaydi(id: string, kim: string, ozet: string, mesaj: string) {
  const fx = new Effects();
  fx.audit(db, { userId: 'uzaktan', action: 'uzaktan.red', entity: 'kontrol', entityId: id, message: `${remoteActor(kim).name} isteği reddedildi: ${ozet}. Neden: ${mesaj}` });
  fx.flush();
}

/** İmzası tutmayan komutlar: işlem başına değil, yanıt başına tek önemli kayıt */
function imzaAlarmi(n: number) {
  const fx = new Effects();
  fx.audit(db, {
    action: 'uzaktan.imza',
    severity: 'alarm',
    entity: 'kontrol',
    message: `Uzaktan yönetim: ${n} işlem imzası tutmadığı için reddedildi. İşlem LafPOS Uzaktan’dan ya da bu kasa için gelmiyor olabilir (başka şubenin işlemi) ya da kasadaki ve Vercel’deki LAFPOS_CLOUD_SECRET farklı`,
    data: { sayi: n },
  });
  fx.flush();
}

type Islem = 'yeni' | 'imza' | null;

/** Tek komut; dönüş: yeni sonuç yazıldı mı (`imza`: imzası tutmadı), null: bildirilecek bir şey yok */
async function komutIsle(raw: unknown, now: number): Promise<Islem> {
  if (!isRecord(raw)) return null;
  const id = raw.id;
  // Kimliksiz komutun sonucu bildirilemez: hiç işlenmez
  if (typeof id !== 'string' || !KOMUT_ID_RE.test(id)) return null;
  const bilinen = islenenler().find((x) => x.id === id);
  const bekliyor = bekleyenler().some((s) => s.id === id);
  const d = komutDogrula(raw.tur, raw.veri);
  const { at, kim, rol, imza } = raw;
  const imzali =
    d.ok &&
    typeof at === 'number' &&
    Number.isSafeInteger(at) &&
    typeof kim === 'string' &&
    kim.length > 0 &&
    kim.length <= 254 &&
    typeof rol === 'string' &&
    (UYE_ROLLERI as readonly string[]).includes(rol) &&
    typeof imza === 'string' &&
    imzaTutar({ id, tur: d.tur, veri: d.veri, at, kim, rol: rol as UyeRolu }, imza);
  if (!d.ok || !imzali) {
    // Doğrulanamayan ya da imzasız komut uygulanmaz; bilinen bir komutun sonucunu da ezemez
    if (bilinen || bekliyor) return null;
    sonucYaz({ id, durum: 'reddedildi', mesaj: d.ok ? 'İmza tutmadı: işlem bu kasa için LafPOS Uzaktan’dan gelmiyor ya da kasanın anahtarı farklı' : d.hata, at: now });
    return d.ok ? 'imza' : 'yeni';
  }
  const by = kim as string;
  const when = at as number;
  const uye = rol as UyeRolu;
  // Aynı komut ikinci kez uygulanmaz: sonucu bildirilmediyse bekler, bildirildiyse yeniden bildirilir (bulut kapatsın)
  if (bilinen) {
    if (bekliyor) return null;
    sonucYaz({ id, durum: bilinen.durum, mesaj: bilinen.mesaj, at: bilinen.at, ...(bilinen.ozet ? { ozet: bilinen.ozet } : {}) });
    return 'yeni';
  }
  const ozet = yerelOzet(d.tur, d.veri);
  const red = (mesaj: string): Islem => {
    bitir(id, 'reddedildi', mesaj, now, when, ozet);
    redKaydi(id, by, ozet, mesaj);
    return 'yeni';
  };
  // Listeden düşmüş (500'den eski) komut yeniden gelirse: tekrar sayılır
  if (when <= taban()) return red('Bu işlem daha önce işlendi ya da çok eski');
  if (now - when > KOMUT_OMRU_MS) return red('Süresi doldu: 24 saat içinde kasaya ulaşmadı');
  // Gün sonu yalnız taze gelirse ve istendiği gün hâlâ açıksa: çevrimdışı kasaya gece verilen istek ertesi sabah ulaşıp
  // o arada açılan (ya da yeniden açılan) günü sayımsız kapatıyordu (inceleme, 23 Kas 2026). Açılış anı kasanın,
  // isteğin anı bulutun saatinden: iki saat arasındaki fark kadar (birkaç dakika) belirsizlik kalır
  if (d.tur === 'gun.sonu') {
    const gun = getOpenDay(db);
    if (now - when > GUN_SONU_OMRU_MS || (gun && Math.max(gun.openedAt, gun.reopenedAt ?? 0) > when)) return red('Gün sonu isteği eskidi: istekten sonra gün değişti ya da kasaya geç ulaştı');
  }
  if (when - now > SAAT_PAYI_MS) return red('İşlemin zamanı ileride: kasanın saati yanlış olabilir');
  if (getSettings().remoteControl === false) return red('Kasada uzaktan yönetim kapalı');
  // Rol kapısı kasada da: bulutun gördüğü özet eski olabilir (kuyrukta bekleyen rol değişikliği, yeni patron). Hedefin
  // rolü şimdiki kayıttan; önceki komutlar sırayla uygulandığından aynı yanıttaki değişiklik de görülür
  if (uye === 'izleyici') return red('Yalnız görme yetkisi olan üye değişiklik yapamaz');
  if (!uyeYapabilir(uye, d.tur, hedefRolleri(d.tur, d.veri))) return red(d.tur === 'rol.yetki' ? 'Rol yetkilerini yalnız sahip değiştirebilir' : d.tur === 'gun.sonu' ? 'Gün sonunu uzaktan yalnız sahip alır' : 'Patron hesabına yalnız sahip dokunabilir');
  let pin: string | null = null;
  if (d.tur === 'personel.ekle' || d.tur === 'personel.pin') {
    pin = pinCoz((d.veri as PersonelEkle | PersonelPin).pin);
    if (pin === null) return red('PIN çözülemedi: kasanın anahtarı değişmiş olabilir; Uzaktan’da sayfayı yenileyip yeniden deneyin');
    if (!isValidPin(pin)) return red('PIN 4-6 haneli rakam olmalı');
  }
  // Önce "işlendi" yazılır: kasa uygulama sırasında kapanırsa komut ikinci kez uygulanmaz (en çok bir kez)
  islenenYaz({ id, durum: 'reddedildi', mesaj: 'İşlem yarıda kaldı (kasa yeniden başladı); sonucu kasada denetleyin', at: now, komutAt: when, ozet });
  let sonuc: { ok: boolean; mesaj: string };
  try {
    sonuc = await uygula(by, uye === 'sahip' ? 'sahip' : 'yonetici', istekOf(d.tur, d.veri, pin));
  } catch {
    sonuc = { ok: false, mesaj: 'Kasada beklenmeyen bir hata oluştu' };
  }
  const mesaj = temizle(sonuc.mesaj, pin);
  bitir(id, sonuc.ok ? 'uygulandi' : 'reddedildi', mesaj, Date.now(), when, ozet);
  if (!sonuc.ok) redKaydi(id, by, ozet, mesaj);
  return 'yeni';
}

export interface KontrolIslemi {
  /** Bulut özeti istedi: sonraki nabız özeti göndersin */
  durumIste: boolean;
  /** Yanıttaki komut sayısı (hızlı nabız bundan başlar) */
  komut: number;
  /** Yazılan yeni sonuç sayısı (beklemesin: hemen bir nabız daha) */
  sonuc: number;
}

/**
 * Bulutun nabız yanıtındaki `kontrol` (NabizKontrolYaniti): komutlar sırayla işlenir. Eski bulut alanı göndermez
 * (`undefined`): hiçbir şey yapılmaz
 */
export async function kontrolYaniti(yanit: unknown, now = Date.now()): Promise<KontrolIslemi> {
  if (!isRecord(yanit)) return { durumIste: false, komut: 0, sonuc: 0 };
  const komutlar = Array.isArray(yanit.komutlar) ? yanit.komutlar.slice(0, KUYRUK_EN_COK) : [];
  let sonuc = 0;
  let imzasiz = 0;
  for (const raw of komutlar) {
    let r: Islem = null;
    try {
      r = await komutIsle(raw, now);
    } catch {
      // Beklenmeyen hata (veritabanı): ayrıntı günlüğe yazılmaz (komutta şifreli PIN var); sonraki komut sürer
      console.error('[uzaktan] bir işlem işlenemedi');
    }
    if (r) sonuc++;
    if (r === 'imza') imzasiz++;
  }
  if (imzasiz) imzaAlarmi(imzasiz);
  return { durumIste: yanit.durumIste === true, komut: komutlar.length, sonuc };
}
