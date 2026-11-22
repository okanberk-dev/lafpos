/**
 * Uzaktan yönetim (docs/UZAKTAN-YONETIM.md): LafPOS Uzaktan'dan (lafpos.laffogato.net) kasaya giden yönetim komutları ve
 * kasanın buluta bildirdiği yönetim özeti. Tek sözleşme: bulut (api/_kontrol.ts, api/_merkez.ts nabzı), kasa
 * (server/sync/kontrol.ts) ve arayüz (src/pages/kontrol) yalnız bu dosyadaki türleri, doğrulamayı ve imza metnini kullanır.
 *
 * Akış: patron Uzaktan'da bir değişiklik ister → bulut komutu doğrular, sahibin adıyla özetler, kafenin ortak anahtarıyla
 * (LAFPOS_CLOUD_SECRET) imzalar ve kasanın kuyruğuna koyar → kasa Merkez nabzının yanıtında alır (yeni yoklama yok),
 * imzayı ve süresini denetler, kasadaki yönetim ekranının kullandığı uçla ve aynı kurallarla uygular → sonucu bir sonraki
 * nabızda bildirir; Uzaktan "bekliyor / uygulandı / reddedildi" gösterir.
 *
 * PIN bulutta açık durmaz: tarayıcı kasanın açık anahtarıyla (RSA-OAEP, SHA-256) şifreler; şifreyi yalnız kasa çözer.
 * Bu dosya tarayıcıda da çalışır: Node'a özgü modül (node:crypto) içermez.
 */
// Göreli yollar `.js` uzantılı: Vercel api/ işlevlerini dosya dosya Node ESM'e derler, uzantısız yol orada çözülmez
// (Vite, tsx ve vitest `.js`'i `.ts`'e çözer; tests/kontrol-sozlesme.test.ts derleyip Node'la yükler)
import { ALL_PERMISSIONS, type Permission, ROLE_LABELS, ROLES, type Role } from './permissions.js';
import { SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode } from './service-mode.js';

/** Sözleşmenin sürümü: kasa özetinde `v`; bulut bilmediği sürümdeki kasaya komut göndermez */
export const KONTROL_SURUM = 1;

/** Kasanın kabul ettiği komutlar (beyaz liste). Kasa bu listenin dışındaki hiçbir şeyi uygulamaz */
export const KOMUT_TURLERI = ['personel.ekle', 'personel.duzenle', 'personel.pin', 'rol.yetki', 'urun.satis', 'secenek.satis', 'ayar.servis', 'urun.gorunum', 'secenek.grubu'] as const;
export type KomutTuru = (typeof KOMUT_TURLERI)[number];

export const KOMUT_ETIKET: Record<KomutTuru, string> = {
  'personel.ekle': 'Personel ekleme',
  'personel.duzenle': 'Personel düzenleme',
  'personel.pin': 'PIN değişikliği',
  'rol.yetki': 'Rol yetkileri',
  'urun.satis': 'Ürün satışta / tükendi',
  'secenek.satis': 'Seçenek satışta / tükendi',
  'ayar.servis': 'Servis modu',
  'urun.gorunum': 'Ürün kasada göster / gizle',
  'secenek.grubu': 'Seçenek grubu ekleme',
};

/**
 * Uzaktan üyesinin rolü: `sahip` ortamdaki (LAFPOS_UYE_EPOSTA) ya da parolalı giriş, her şeyi yapar ve panele kimin
 * gireceğini belirler; `yonetici` patron olmayan personeli, menünün Tükendi'sini ve servis modunu yönetir; `izleyici`
 * yalnız görür (bugünkü salt okunur görünüm). Kasadaki `patron.panel` yetkisinden ayrıdır: o, kasadaki ekranı açar
 */
export const UYE_ROLLERI = ['sahip', 'yonetici', 'izleyici'] as const;
export type UyeRolu = (typeof UYE_ROLLERI)[number];
/** Panelden davet edilebilen roller (sahip yalnız Vercel ortamında tanımlanır) */
export const DAVET_ROLLERI = ['yonetici', 'izleyici'] as const satisfies readonly UyeRolu[];
export type DavetRolu = (typeof DAVET_ROLLERI)[number];
export const UYE_ROL_ETIKET: Record<UyeRolu, string> = { sahip: 'Sahip', yonetici: 'Yönetici', izleyici: 'Yalnız görür' };
export const UYE_ROL_ACIKLAMA: Record<UyeRolu, string> = {
  sahip: 'Her şeyi görür ve yönetir; panele kimin gireceğini belirler',
  yonetici: 'Görür; personeli (patron hariç), Tükendi’yi ve servis modunu yönetir',
  izleyici: 'Yalnız görür; değişiklik yapamaz',
};

// ─── Komut verileri ──────────────────────────────────────────────────────────

export interface PersonelEkle {
  ad: string;
  rol: Role;
  /** #rrggbb; yoksa kasanın varsayılanı */
  renk?: string;
  /** İndirim sınırı (yüzde, 0-100); yoksa kasanın varsayılanı */
  indirim?: number;
  /** Kasanın açık anahtarıyla şifrelenmiş PIN (base64); açık PIN asla */
  pin: string;
}
export interface PersonelDuzenle {
  id: string;
  ad?: string;
  rol?: Role;
  aktif?: boolean;
  indirim?: number;
}
export interface PersonelPin {
  id: string;
  /** Kasanın açık anahtarıyla şifrelenmiş PIN (base64) */
  pin: string;
}
export interface RolYetki {
  rol: Role;
  izinler: Permission[];
}
export interface UrunSatis {
  id: string;
  satista: boolean;
}
export interface SecenekSatis {
  id: string;
  satista: boolean;
}
export interface AyarServis {
  mod: ServiceMode;
}
/** Ürünü kasanın ekranında göster ya da gizle (silmez; site siparişi ve raporlar etkilenmez). Çift ürünü ayıklamak için */
export interface UrunGorunum {
  id: string;
  gorunur: boolean;
}
/** Yeni seçenek grubu (tek seçim) ve bağlanacağı ürünler: "Latte çeşidi: Klasik, Spanish +₺50…". Fiyat kuruş */
export interface SecenekGrubu {
  ad: string;
  zorunlu: boolean;
  ogeler: { ad: string; fiyat: number; varsayilan: boolean }[];
  urunler: string[];
}

export interface KomutVerileri {
  'personel.ekle': PersonelEkle;
  'personel.duzenle': PersonelDuzenle;
  'personel.pin': PersonelPin;
  'rol.yetki': RolYetki;
  'urun.satis': UrunSatis;
  'secenek.satis': SecenekSatis;
  'ayar.servis': AyarServis;
  'urun.gorunum': UrunGorunum;
  'secenek.grubu': SecenekGrubu;
}
export type KomutVerisi = KomutVerileri[KomutTuru];

/** Kuyruktaki komut (bulut yazar, kasa nabızda alır). `imza` = HMAC-SHA256(LAFPOS_CLOUD_SECRET, imzaMetni(...)), base64url */
export interface KomutKaydi<T extends KomutTuru = KomutTuru> {
  id: string;
  tur: T;
  veri: KomutVerileri[T];
  /** Kuyruğa giriş anı (ms) */
  at: number;
  /** İsteyen üye (e-posta) ya da `parola` (parolalı giriş) */
  kim: string;
  /**
   * Komutun gittiği kurulum (Merkez kurulum kimliği). İmzalıdır: ortak anahtar bütün şubelerde aynı olduğundan bir
   * şubenin komutu başka şubenin kuyruğuna kopyalanırsa kasa kendi kimliğiyle karşılaştırıp reddeder
   */
  kurulum: string;
  /**
   * İsteyen üyenin rolü (komut anında). İmzalıdır: kasa yöneticinin komutunu patron olmayan bir kimlikle uygular ve
   * hedefin kasadaki gerçek rolünü yeniden denetler (bulutun gördüğü özet eski olabilir)
   */
  rol: UyeRolu;
  /** İnsan okur özet ("PIN değişikliği: Ayşe"); gizli değer içermez */
  ozet: string;
  imza: string;
}

/** Kasanın bildirdiği sonuç */
export type SonucDurumu = 'uygulandi' | 'reddedildi';
export interface KomutSonucu {
  id: string;
  durum: SonucDurumu;
  /** Kasanın kısa açıklaması (reddedildiyse nedeni); PIN ya da başka gizli değer içermez */
  mesaj: string;
  /** Kasada işlendiği an */
  at: number;
  /**
   * Kasanın kendi adlarıyla özet (`komutOzeti`; ürün ve seçenek `ozetAdi` ile). Bulut geçmişe bunu yazar: kuyruktaki
   * özetin ürün adı istekten gelir ve doğrulanmaz. Eski kasa göndermez
   */
  ozet?: string;
}

/** Panelin gösterdiği satır: bekleyen (kuyrukta) ya da bitmiş */
export type GecmisDurumu = 'bekliyor' | SonucDurumu | 'iptal';
export interface KontrolGecmisi {
  id: string;
  tur: KomutTuru;
  ozet: string;
  kim: string;
  at: number;
  durum: GecmisDurumu;
  mesaj: string | null;
  bitti: number | null;
}

// ─── Kasanın yönetim özeti ───────────────────────────────────────────────────

export interface KontrolPersonel {
  id: string;
  ad: string;
  rol: Role;
  renk: string;
  aktif: boolean;
  /** İndirim sınırı (yüzde) */
  indirim: number;
  sonGiris: number | null;
}
export interface KontrolRol {
  rol: Role;
  izinler: Permission[];
  /** Varsayılandan farklı mı (Yönetim › Roller ve yetkiler'de düzenlenmiş) */
  ozel: boolean;
  /** Bu roldeki etkin kişi sayısı */
  kisi: number;
}
/**
 * Kasanın buluta bildirdiği yönetim özeti (nabızda, yalnız değişince): PIN, PIN özeti, maliyet ve kişisel veri YOK.
 * Ürün ve seçeneklerin Satışta bilgisi zaten uzaktan özetinde (bootstrap) gider; burada tekrar edilmez
 */
export interface KontrolDurumu {
  v: number;
  /** Kasanın özeti hazırladığı an */
  at: number;
  /** Kasada uzaktan yönetim açık mı (Yönetim › Ağ ve uzaktan erişim); kapalıysa kasa komutları reddeder */
  acik: boolean;
  /** Kasanın uyguladığı komut türleri */
  turler: KomutTuru[];
  /** PIN şifrelemesi için kasanın açık anahtarı (RSA-OAEP 2048, SHA-256; SPKI, base64) */
  anahtar: string;
  /**
   * Açık anahtarın imzası: HMAC-SHA256(LAFPOS_CLOUD_SECRET, anahtarImzaMetni(kurulum, anahtar)), base64url. Bulut panele
   * anahtarı yalnız imza tutarsa verir: Redis'e yazabilen biri anahtarı kendininkiyle değiştirip PIN'i okuyamaz
   */
  anahtarImza?: string;
  personel: KontrolPersonel[];
  roller: KontrolRol[];
  servisModu: ServiceMode;
}

/** Nabız isteğine eklenen kısım (kasa → bulut) */
export interface NabizKontrol {
  /** Kasadaki özetin parmak izi (durumParmakIzi); bulut kendisindekiyle aynı değilse `durumIste` der */
  ozet: string;
  /** Özetin kendisi: yalnız bulut istediğinde ya da değiştiğinde */
  durum?: KontrolDurumu;
  /** Bildirilmemiş sonuçlar */
  sonuclar?: KomutSonucu[];
}
/** Nabız yanıtına eklenen kısım (bulut → kasa) */
export interface NabizKontrolYaniti {
  /** Buluttaki özet kasanınkinden farklı ya da yok: kasa özeti hemen göndersin */
  durumIste: boolean;
  /** Kasanın uygulayacağı komutlar (sırayla) */
  komutlar: KomutKaydi[];
}

// ─── Panel uçları (api/_kontrol.ts ↔ src/pages/kontrol) ─────────────────────

/** `GET /api/kontrol/durum` (dükkân başlığıyla): panelin bütün verisi */
export interface KontrolPaneli {
  /** Oturumdaki üye: e-posta (parolalı girişte null) ve rolü */
  ben: { eposta: string | null; rol: UyeRolu };
  /** Kasanın son yönetim özeti; kasa bu özelliği içeren sürümde değilse null */
  durum: KontrolDurumu | null;
  /** Kuyrukta bekleyenler (eskiden yeniye) */
  bekleyen: KontrolGecmisi[];
  /** Bitmiş işlemler (yeniden eskiye, en çok GECMIS_EN_COK) */
  gecmis: KontrolGecmisi[];
  /** Merkez'in bildiği kasa: son nabız, kurulu sürüm; dükkân Merkez'de yoksa null */
  kasa: { sonGorulme: number | null; surum: string | null; build: number | null; gunAcik: boolean | null } | null;
  /** Kafe bağlanmadan önceki örnek görünüm: işlem gönderilmez */
  demo?: boolean;
}

/** `POST /api/kontrol/komut` gövdesi. `ad`: ürün ya da seçeneğin adı (yalnız geçmişteki özet metni için) */
export interface KomutIstegi {
  tur: KomutTuru;
  veri: unknown;
  ad?: string;
}
/** `POST /api/kontrol/komut` yanıtı */
export interface KomutYaniti {
  ok: true;
  komut: KontrolGecmisi;
}

/** `GET /api/kontrol/uyeler` satırı (yalnız sahip görür) */
export interface UzaktanUye {
  eposta: string;
  rol: UyeRolu;
  /** `aktif`: parolasını belirlemiş; `davet`: davet kodu verildi, henüz girmedi */
  durum: 'aktif' | 'davet';
  /** Vercel ortamında tanımlı sahip (LAFPOS_UYE_EPOSTA): panelden değiştirilmez, kaldırılmaz */
  sabit: boolean;
  /** Üyeliğin ya da davetin açıldığı an */
  at: number | null;
  /** Davetin bitişi (yalnız `davet`) */
  davetBitis: number | null;
}
/** `POST /api/kontrol/uye` yanıtı: davet kodu yalnız burada bir kez görünür */
export interface DavetYaniti {
  ok: true;
  kod: string;
  bitis: number;
}

// ─── Sınırlar ────────────────────────────────────────────────────────────────

/** Davet kodunun ömrü */
export const DAVET_OMRU_MS = 7 * 86_400_000;

/** Komut kasaya bu süre içinde ulaşmazsa kasa uygulamaz ("süresi doldu") */
export const KOMUT_OMRU_MS = 24 * 3600_000;
/** Kasanın saatiyle bulutun saati arasında kabul edilen fark (gelecekten gelen komut) */
export const SAAT_PAYI_MS = 5 * 60_000;
/** Bir dükkânın kuyruğunda en çok bu kadar bekleyen komut */
export const KUYRUK_EN_COK = 50;
/** Bir dükkâna saatte en çok bu kadar komut */
export const SAATLIK_EN_COK = 120;
/** Panelin gösterdiği geçmiş */
export const GECMIS_EN_COK = 100;
/** Komut aldıktan sonra kasa nabzı bu süre boyunca dakikada bir atar (art arda değişiklikler beklemesin) */
export const HIZLI_NABIZ_MS = 60_000;
export const HIZLI_SURE_MS = 10 * 60_000;

// ─── Doğrulama ───────────────────────────────────────────────────────────────

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const RENK_RE = /^#[0-9a-fA-F]{6}$/;
/** RSA-2048 şifreli metin base64'te 344 karakter; başka uzunluk ve karakter kabul edilmez */
const SIFRELI_RE = /^[A-Za-z0-9+/_-]{300,700}={0,2}$/;
export const KOMUT_ID_RE = /^k_[A-Za-z0-9_-]{16,40}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const ad = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '');
const isRole = (v: unknown): v is Role => typeof v === 'string' && (ROLES as readonly string[]).includes(v);
const isPct = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 100;

export type Dogrulama<T extends KomutTuru = KomutTuru> = { ok: true; tur: T; veri: KomutVerileri[T] } | { ok: false; hata: string };

/**
 * Komutu doğrular ve alanları sabit sırayla yeniden kurar (imza metni iki tarafta da aynı çıksın; bilinmeyen alan
 * düşer). Bulut kuyruğa koymadan önce, kasa uygulamadan önce çağırır
 */
export function komutDogrula(tur: unknown, veri: unknown): Dogrulama {
  if (typeof tur !== 'string' || !(KOMUT_TURLERI as readonly string[]).includes(tur)) return { ok: false, hata: 'Bilinmeyen işlem' };
  if (!isRecord(veri)) return { ok: false, hata: 'İşlemin bilgileri eksik' };
  const t = tur as KomutTuru;
  switch (t) {
    case 'personel.ekle': {
      const name = ad(veri.ad);
      if (name.length < 1 || name.length > 40) return { ok: false, hata: 'Ad 1-40 karakter olmalı' };
      if (!isRole(veri.rol)) return { ok: false, hata: 'Rol anlaşılamadı' };
      if (veri.renk !== undefined && (typeof veri.renk !== 'string' || !RENK_RE.test(veri.renk))) return { ok: false, hata: 'Renk anlaşılamadı' };
      if (veri.indirim !== undefined && !isPct(veri.indirim)) return { ok: false, hata: 'İndirim sınırı 0-100 arası tam sayı olmalı' };
      if (typeof veri.pin !== 'string' || !SIFRELI_RE.test(veri.pin)) return { ok: false, hata: 'PIN şifrelenmemiş ya da bozuk' };
      // Alan sırası sabit (ad, rol, renk, indirim, pin): imza metni iki tarafta aynı çıkar
      const out = { ad: name, rol: veri.rol } as PersonelEkle;
      if (veri.renk !== undefined) out.renk = (veri.renk as string).toLowerCase();
      if (veri.indirim !== undefined) out.indirim = veri.indirim as number;
      out.pin = veri.pin;
      return { ok: true, tur: t, veri: out };
    }
    case 'personel.duzenle': {
      if (typeof veri.id !== 'string' || !ID_RE.test(veri.id)) return { ok: false, hata: 'Personel anlaşılamadı' };
      const out: PersonelDuzenle = { id: veri.id };
      if (veri.ad !== undefined) {
        const name = ad(veri.ad);
        if (name.length < 1 || name.length > 40) return { ok: false, hata: 'Ad 1-40 karakter olmalı' };
        out.ad = name;
      }
      if (veri.rol !== undefined) {
        if (!isRole(veri.rol)) return { ok: false, hata: 'Rol anlaşılamadı' };
        out.rol = veri.rol;
      }
      if (veri.aktif !== undefined) {
        if (typeof veri.aktif !== 'boolean') return { ok: false, hata: 'Etkin bilgisi anlaşılamadı' };
        out.aktif = veri.aktif;
      }
      if (veri.indirim !== undefined) {
        if (!isPct(veri.indirim)) return { ok: false, hata: 'İndirim sınırı 0-100 arası tam sayı olmalı' };
        out.indirim = veri.indirim;
      }
      if (Object.keys(out).length === 1) return { ok: false, hata: 'Değişiklik yok' };
      return { ok: true, tur: t, veri: out };
    }
    case 'personel.pin': {
      if (typeof veri.id !== 'string' || !ID_RE.test(veri.id)) return { ok: false, hata: 'Personel anlaşılamadı' };
      if (typeof veri.pin !== 'string' || !SIFRELI_RE.test(veri.pin)) return { ok: false, hata: 'PIN şifrelenmemiş ya da bozuk' };
      return { ok: true, tur: t, veri: { id: veri.id, pin: veri.pin } };
    }
    case 'rol.yetki': {
      if (!isRole(veri.rol)) return { ok: false, hata: 'Rol anlaşılamadı' };
      if (veri.rol === 'patron') return { ok: false, hata: 'Patron rolü her yetkiye sahiptir, değiştirilemez' };
      if (!Array.isArray(veri.izinler) || veri.izinler.length > ALL_PERMISSIONS.length) return { ok: false, hata: 'Yetkiler anlaşılamadı' };
      if (veri.izinler.some((p) => typeof p !== 'string' || !(ALL_PERMISSIONS as string[]).includes(p))) return { ok: false, hata: 'Bilinmeyen yetki' };
      // Sabit sıra (yetki listesinin sırası) ve tekil: imza metni iki tarafta aynı
      const izinler = ALL_PERMISSIONS.filter((p) => (veri.izinler as string[]).includes(p));
      return { ok: true, tur: t, veri: { rol: veri.rol, izinler } };
    }
    case 'urun.satis':
    case 'secenek.satis': {
      if (typeof veri.id !== 'string' || !ID_RE.test(veri.id)) return { ok: false, hata: t === 'urun.satis' ? 'Ürün anlaşılamadı' : 'Seçenek anlaşılamadı' };
      if (typeof veri.satista !== 'boolean') return { ok: false, hata: 'Satışta bilgisi anlaşılamadı' };
      return { ok: true, tur: t, veri: { id: veri.id, satista: veri.satista } };
    }
    case 'ayar.servis': {
      if (typeof veri.mod !== 'string' || !(SERVICE_MODES as readonly string[]).includes(veri.mod)) return { ok: false, hata: 'Servis modu anlaşılamadı' };
      return { ok: true, tur: t, veri: { mod: veri.mod as ServiceMode } };
    }
    case 'urun.gorunum': {
      if (typeof veri.id !== 'string' || !ID_RE.test(veri.id)) return { ok: false, hata: 'Ürün anlaşılamadı' };
      if (typeof veri.gorunur !== 'boolean') return { ok: false, hata: 'Görünürlük anlaşılamadı' };
      return { ok: true, tur: t, veri: { id: veri.id, gorunur: veri.gorunur } };
    }
    case 'secenek.grubu': {
      const name = ad(veri.ad);
      if (name.length < 1 || name.length > 40) return { ok: false, hata: 'Grup adı 1-40 karakter olmalı' };
      if (typeof veri.zorunlu !== 'boolean') return { ok: false, hata: 'Zorunlu bilgisi anlaşılamadı' };
      if (!Array.isArray(veri.ogeler) || veri.ogeler.length < 1 || veri.ogeler.length > 30) return { ok: false, hata: 'Grupta 1-30 seçenek olmalı' };
      const ogeler: SecenekGrubu['ogeler'] = [];
      for (const o of veri.ogeler as unknown[]) {
        if (!isRecord(o)) return { ok: false, hata: 'Seçenek anlaşılamadı' };
        const oad = ad(o.ad);
        if (oad.length < 1 || oad.length > 40) return { ok: false, hata: 'Seçenek adı 1-40 karakter olmalı' };
        if (!Number.isInteger(o.fiyat) || (o.fiyat as number) < 0 || (o.fiyat as number) > 10_000_000) return { ok: false, hata: 'Seçenek fiyatı kuruş olarak tam sayı olmalı' };
        ogeler.push({ ad: oad, fiyat: o.fiyat as number, varsayilan: o.varsayilan === true });
      }
      if (ogeler.filter((o) => o.varsayilan).length > 1) return { ok: false, hata: 'Tek seçimli grupta en çok bir varsayılan olur' };
      if (!Array.isArray(veri.urunler) || veri.urunler.length > 200 || veri.urunler.some((u) => typeof u !== 'string' || !ID_RE.test(u))) return { ok: false, hata: 'Ürünler anlaşılamadı' };
      return { ok: true, tur: t, veri: { ad: name, zorunlu: veri.zorunlu, ogeler, urunler: [...new Set(veri.urunler as string[])] } };
    }
  }
}

/**
 * İmzalanan metin: iki taraf da doğrulanmış (yeniden kurulmuş) veriden üretir. Kurulum ve üyenin rolü de içinde: kasa
 * kurulumu kendi kimliğiyle kurar (başka şubenin komutu tutmaz), rolü kayıttan okur (değiştirilirse imza tutmaz)
 */
export function imzaMetni(k: Pick<KomutKaydi, 'id' | 'tur' | 'veri' | 'at' | 'kim' | 'kurulum' | 'rol'>): string {
  return `lafpos-kontrol:v${KONTROL_SURUM}:${k.kurulum}:${k.id}:${k.tur}:${k.at}:${k.kim}:${k.rol}:${JSON.stringify(k.veri)}`;
}

/** Kasanın açık anahtarının imzalanan metni (`KontrolDurumu.anahtarImza`): kuruluma bağlı, başka şubeye taşınmaz */
export const anahtarImzaMetni = (kurulum: string, anahtar: string) => `lafpos-kontrol-anahtar:v${KONTROL_SURUM}:${kurulum}:${anahtar}`;

/**
 * Üye rolü bu komutu verebilir mi. `hedefRol`: komutun dokunduğu personelin kasadaki rolü (düzenleme ve PIN'de) ya da
 * yeni rolü; patron hesabına (ve rol yetkilerine) yalnız sahip dokunur
 */
export function uyeYapabilir(rol: UyeRolu, tur: KomutTuru, hedefRoller: (Role | undefined)[] = []): boolean {
  if (rol === 'sahip') return true;
  if (rol === 'izleyici') return false;
  if (tur === 'rol.yetki') return false;
  if (tur.startsWith('personel.') && hedefRoller.some((r) => r === 'patron')) return false;
  return true;
}

// ─── Özet metni ──────────────────────────────────────────────────────────────

export interface OzetAdlari {
  personel?: Record<string, string>;
  urun?: Record<string, string>;
  secenek?: Record<string, string>;
}

/** Özetteki ürün ya da seçenek adı: boşluklar teke iner, en çok 60 karakter (bulut, kasa ve arayüz aynı kuralla) */
export const ozetAdi = (v: string) => v.trim().replace(/\s+/g, ' ').slice(0, 60);
/** Seçeneğin özetteki adı: aynı ad başka grupta da olabilir ("Büyük"), grubun adıyla */
export const secenekOzetAdi = (secenek: string, grup: string) => `${secenek} (${grup})`;

/** Geçmişte görünen kısa metin ("PIN değişikliği: Ayşe"); gizli değer içermez */
export function komutOzeti<T extends KomutTuru>(tur: T, veri: KomutVerileri[T], adlar: OzetAdlari = {}): string {
  const kisi = (id: string) => adlar.personel?.[id] ?? 'bilinmeyen personel';
  switch (tur) {
    case 'personel.ekle': {
      const v = veri as PersonelEkle;
      return `Personel ekle: ${v.ad} (${ROLE_LABELS[v.rol]})`;
    }
    case 'personel.duzenle': {
      const v = veri as PersonelDuzenle;
      const parts = [
        v.ad !== undefined && `ad “${v.ad}”`,
        v.rol !== undefined && `rol ${ROLE_LABELS[v.rol]}`,
        v.aktif !== undefined && (v.aktif ? 'hesabı aç' : 'hesabı kapat'),
        v.indirim !== undefined && `indirim sınırı %${v.indirim}`,
      ].filter(Boolean);
      return `Personel düzenle: ${kisi(v.id)} (${parts.join(', ')})`;
    }
    case 'personel.pin':
      return `PIN değiştir: ${kisi((veri as PersonelPin).id)}`;
    case 'rol.yetki': {
      const v = veri as RolYetki;
      return `Rol yetkileri: ${ROLE_LABELS[v.rol]} (${v.izinler.length} yetki)`;
    }
    case 'urun.satis': {
      const v = veri as UrunSatis;
      return `${v.satista ? 'Satışa aç' : 'Tükendi'}: ${adlar.urun?.[v.id] ?? 'ürün'}`;
    }
    case 'secenek.satis': {
      const v = veri as SecenekSatis;
      return `${v.satista ? 'Satışa aç' : 'Tükendi'}: ${adlar.secenek?.[v.id] ?? 'seçenek'}`;
    }
    case 'ayar.servis':
      return `Servis modu: ${SERVICE_MODE_LABEL[(veri as AyarServis).mod]}`;
    case 'urun.gorunum': {
      const v = veri as UrunGorunum;
      return `${v.gorunur ? 'Kasada göster' : 'Kasada gizle'}: ${adlar.urun?.[v.id] ?? 'ürün'}`;
    }
    case 'secenek.grubu': {
      const v = veri as SecenekGrubu;
      return `Seçenek grubu: ${v.ad} (${v.ogeler.map((o) => o.ad).join(', ')}; ${v.urunler.length} ürün)`;
    }
    default:
      return KOMUT_ETIKET[tur];
  }
}

// ─── Parmak izi ──────────────────────────────────────────────────────────────

/** Kararlı JSON (anahtarlar sıralı): aynı özet her yerde aynı metni verir */
export function kararliJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(kararliJson).join(',')}]`;
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${kararliJson(v[k])}`)
      .join(',')}}`;
  return JSON.stringify(v ?? null);
}

/**
 * Özetin parmak izi (değişiklik tespiti; güvenlik için değil): `at` dışındaki alanların kararlı JSON'unun 53 bitlik
 * cyrb53 özeti, onaltılık. Tarayıcıda ve Node'da aynı
 */
export function durumParmakIzi(d: KontrolDurumu): string {
  const { at: _at, ...rest } = d;
  const s = kararliJson(rest);
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/** Kasanın özeti okunur mu (bulut ve arayüz eski ya da bozuk özetle komut göndermesin) */
export function durumGecerli(d: unknown): d is KontrolDurumu {
  if (!isRecord(d)) return false;
  return (
    Number.isInteger(d.v) &&
    (d.v as number) >= 1 &&
    typeof d.acik === 'boolean' &&
    Array.isArray(d.turler) &&
    typeof d.anahtar === 'string' &&
    Array.isArray(d.personel) &&
    Array.isArray(d.roller) &&
    typeof d.servisModu === 'string'
  );
}
