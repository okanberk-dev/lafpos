import {
  durumGecerli,
  type GecmisDurumu,
  KONTROL_SURUM,
  komutOzeti,
  type KomutTuru,
  type KontrolDurumu,
  type KontrolGecmisi,
  type KontrolPaneli,
  ozetAdi,
  secenekOzetAdi,
  type UyeRolu,
  uyeYapabilir,
} from '@shared/kontrol';
import { type Role, ROLES } from '@shared/permissions';
import { SERVICE_MODES, type ServiceMode } from '@shared/service-mode';
import { fmtDateTime } from '@shared/time';
import type { BootstrapDTO } from '@shared/types';
import { REMOTE_STALE_MS } from '../../lib/remote';

/**
 * Uzaktan yönetim ekranının saf yardımcıları (tests/kontrol-arayuz.test.ts): sekmeler, PIN denetimi, rol kapısı
 * (düğme gizlenmez, kapanır ve nedeni yazılır; asıl denetim bulutta ve kasada), bekleyen işlemin satırı ve menünün
 * görünen satış durumu
 */

// ─── Sekmeler ────────────────────────────────────────────────────────────────

export const SEKMELER = ['ekip', 'roller', 'menu', 'kasa', 'erisim', 'gecmis'] as const;
export type Sekme = (typeof SEKMELER)[number];
export const SEKME_ETIKET: Record<Sekme, string> = { ekip: 'Ekip', roller: 'Roller', menu: 'Menü', kasa: 'Kasa', erisim: 'Erişim', gecmis: 'Geçmiş' };

/** Rolün gördüğü sekmeler: Erişim (internetteki panele kim girer) yalnız sahipte */
export function sekmeler(rol: UyeRolu | undefined): Sekme[] {
  return SEKMELER.filter((s) => s !== 'erisim' || rol === 'sahip');
}

/** Adresteki sekme (`?sekme=`); bilinmeyen ya da rolün görmediği sekme Ekip'tir */
export function sekmeSec(deger: string | null, rol: UyeRolu | undefined): Sekme {
  return (sekmeler(rol) as string[]).includes(deger ?? '') ? (deger as Sekme) : 'ekip';
}

// ─── PIN ─────────────────────────────────────────────────────────────────────

export const PIN_RE = /^\d{4,6}$/;
/** Alan yalnız rakam alır, en çok 6 */
export const pinGirdisi = (v: string) => v.replace(/\D/g, '').slice(0, 6);

/** PIN ve tekrarının iletileri (alanın altında); ikisi de null ise gönderilir */
export function pinHatasi(pin: string, tekrar: string): { pin: string | null; tekrar: string | null } {
  if (!pin) return { pin: 'PIN gerekli (4–6 rakam)', tekrar: null };
  if (!PIN_RE.test(pin)) return { pin: 'PIN 4–6 rakam olmalı', tekrar: null };
  if (!tekrar) return { pin: null, tekrar: 'PIN’i bir kez daha yazın' };
  if (tekrar !== pin) return { pin: null, tekrar: 'İki PIN aynı değil' };
  return { pin: null, tekrar: null };
}

/** Personelin adı (kasanın kuralı: 1-40 karakter, boşluklar teke iner) */
export const temizAd = (v: string) => v.trim().replace(/\s+/g, ' ');
export function adHatasi(v: string): string | null {
  const ad = temizAd(v);
  if (!ad) return 'Ad gerekli';
  return ad.length > 40 ? 'Ad en çok 40 karakter' : null;
}

// ─── Rol kapısı ──────────────────────────────────────────────────────────────

/** `kasa`: Merkez'in bildiği kasa; null ise kasa hiç bağlanmadı (verilmezse bilinmiyor sayılır) */
type Panel = Pick<KontrolPaneli, 'ben' | 'durum' | 'demo'> & { kasa?: KontrolPaneli['kasa'] };

/** Kasanın özeti okunur ve bu ekranın bildiği sürümde mi; değilse null (Kasa güncel değil) */
export function gecerliDurum(d: unknown): KontrolDurumu | null {
  return durumGecerli(d) ? d : null;
}

/** Sayfanın bütün işlemlerini kapatan neden (sayfanın üstünde bir kez yazılır); yoksa null */
export function genelNeden(p: Panel): string | null {
  if (p.demo) return 'Örnek görünüm: işlem gönderilmez';
  if (p.ben.rol === 'izleyici') return 'Yalnız görme yetkiniz var';
  const d = gecerliDurum(p.durum);
  // Kasa hiç bağlanmadıysa güncelleme sorunu değil: önce program kurulur
  if (!d) return p.kasa === null ? 'Kasa henüz bağlanmadı' : 'Kasa güncel değil';
  if (d.v > KONTROL_SURUM) return 'Kasa daha yeni bir sürümde: sayfayı yenileyin';
  if (!d.acik) return 'Kasada uzaktan yönetim kapalı';
  return null;
}

/**
 * Bu işlem verilebilir mi; verilemezse nedeni. `hedefRoller`: işlemin dokunduğu kişinin kasadaki ve yeni rolü
 * (patron hesabına ve rol yetkilerine yalnız sahip dokunur: `uyeYapabilir`)
 */
export function islemNedeni(p: Panel, tur: KomutTuru, hedefRoller: (Role | undefined)[] = []): string | null {
  const genel = genelNeden(p);
  if (genel) return genel;
  const d = p.durum as KontrolDurumu;
  // Güncellemeyi Merkez'den yalnız sahip gönderir (yönetici ve izleyici Merkez'i açamaz)
  if (!d.turler.includes(tur)) return p.ben.rol === 'sahip' ? 'Kasanın sürümü bu işlemi bilmiyor: Merkez’den güncelleme gönderin' : 'Kasanın sürümü bu işlemi bilmiyor: güncelleme için panelin sahibine haber verin';
  // Anahtar yok ya da bulut doğrulayamadı (kasanın imzası tutmadı): PIN şifrelenmez
  if ((tur === 'personel.ekle' || tur === 'personel.pin') && !d.anahtar) return 'Kasanın PIN anahtarı henüz gelmedi ya da doğrulanamadı; kasa bir sonraki bağlantısında yeniler';
  if (!uyeYapabilir(p.ben.rol, tur, hedefRoller)) return tur === 'rol.yetki' ? 'Rol yetkilerini yalnız sahip değiştirir' : 'Patron hesabına yalnız sahip dokunur';
  return null;
}

/**
 * Bekleyen işlemi iptal edebilir mi (kasanın durumundan bağımsız). Başkasının gönderdiğini yalnız sahip iptal eder
 * (bulutun kuralı); kasaya gitmiş işlemi bulut reddeder, ileti oradan gelir
 */
export function iptalNedeni(p: Pick<KontrolPaneli, 'ben' | 'demo'>, k?: Pick<KontrolGecmisi, 'kim'>): string | null {
  if (p.demo) return 'Örnek görünüm: işlem gönderilmez';
  if (p.ben.rol === 'izleyici') return 'Yalnız görme yetkiniz var';
  if (k && p.ben.rol !== 'sahip' && k.kim !== (p.ben.eposta ?? 'parola')) return 'Başkasının gönderdiği işlemi yalnız sahip iptal eder';
  return null;
}

// ─── Bekleyen işlemin satırı ─────────────────────────────────────────────────

/** Satırın anahtarı: `urun:<id>`, `secenek:<id>`, `personel:<id>`, `rol:<rol>`, `servis` */
export interface Hedef {
  anahtar: string;
  /** Ürün ve seçenekte istenen durum */
  satista?: boolean;
  /** Servis modunda istenen mod */
  mod?: ServiceMode;
}

export interface HedefAdlari {
  personel: { id: string; ad: string }[];
  urun: { id: string; ad: string }[];
  secenek: { id: string; ad: string }[];
}

/** Ürün ya da seçeneğin özetteki adı (boşluklar teke iner, en çok 60 karakter): bulut ve kasa da aynı kuralla */
export { ozetAdi, secenekOzetAdi };

/**
 * İşlemin dokunduğu satırlar. Geçmiş satırı komutun verisini taşımaz; özet bulutta `komutOzeti` ile kurulur, burada aynı
 * kuralla eşlenir (ürün ve seçenekte istekteki ad, personelde kasanın bildirdiği ad). Ad iki satırda aynıysa ikisi de
 * döner (temkinli); eşleşmeyen işlem yalnız Geçmiş'te görünür
 */
export function hedefBulucu(adlar: HedefAdlari): (k: Pick<KontrolGecmisi, 'tur' | 'ozet'>) => Hedef[] {
  const satis = new Map<string, Hedef[]>();
  const ekle = (ozet: string, h: Hedef) => satis.set(ozet, [...(satis.get(ozet) ?? []), h]);
  for (const u of adlar.urun) for (const satista of [true, false]) ekle(komutOzeti('urun.satis', { id: u.id, satista }, { urun: { [u.id]: ozetAdi(u.ad) } }), { anahtar: `urun:${u.id}`, satista });
  for (const s of adlar.secenek) for (const satista of [true, false]) ekle(komutOzeti('secenek.satis', { id: s.id, satista }, { secenek: { [s.id]: ozetAdi(s.ad) } }), { anahtar: `secenek:${s.id}`, satista });
  // Değişen alanlar özetin parantezinde: "Personel düzenle: Ayşe (rol Garson)" → "Personel düzenle: Ayşe (" ile başlar
  const duzenleBasi = (p: { id: string; ad: string }) => komutOzeti('personel.duzenle', { id: p.id }, { personel: { [p.id]: p.ad } }).slice(0, -1);
  const rolBasi = (r: Role) => {
    const s = komutOzeti('rol.yetki', { rol: r, izinler: [] });
    return s.slice(0, s.lastIndexOf('(') + 1);
  };
  return (k) => {
    switch (k.tur) {
      case 'urun.satis':
      case 'secenek.satis':
        return (satis.get(k.ozet) ?? []).filter((h) => h.anahtar.startsWith(k.tur === 'urun.satis' ? 'urun:' : 'secenek:'));
      case 'personel.pin':
        return adlar.personel.filter((p) => komutOzeti('personel.pin', { id: p.id, pin: '' }, { personel: { [p.id]: p.ad } }) === k.ozet).map((p) => ({ anahtar: `personel:${p.id}` }));
      case 'personel.duzenle':
        return adlar.personel.filter((p) => k.ozet.startsWith(duzenleBasi(p))).map((p) => ({ anahtar: `personel:${p.id}` }));
      case 'rol.yetki':
        return ROLES.filter((r) => r !== 'patron' && k.ozet.startsWith(rolBasi(r))).map((r) => ({ anahtar: `rol:${r}` }));
      case 'ayar.servis':
        return SERVICE_MODES.filter((m) => komutOzeti('ayar.servis', { mod: m }) === k.ozet).map((m) => ({ anahtar: 'servis', mod: m }));
      default:
        // Yeni personel henüz satır değil: Ekip'te bekleyen ekleme olarak ayrıca listelenir
        return [];
    }
  };
}

export interface BekleyenIs {
  komut: KontrolGecmisi;
  hedef: Hedef;
}

/** Bekleyen işlemler satıra göre, kuyruk sırasıyla (sonuncusu geçerli olur) */
export function bekleyenHaritasi(bekleyen: KontrolGecmisi[], bul: (k: KontrolGecmisi) => Hedef[]): Map<string, BekleyenIs[]> {
  const out = new Map<string, BekleyenIs[]>();
  for (const komut of [...bekleyen].sort((a, b) => a.at - b.at))
    for (const hedef of bul(komut)) out.set(hedef.anahtar, [...(out.get(hedef.anahtar) ?? []), { komut, hedef }]);
  return out;
}

/**
 * Kasada uygulanmış ama menünün açılış verisine henüz yansımamış Tükendi / Satışa aç: kasa sonucu nabızla hemen bildirir,
 * menü özeti ayrıca (en geç birkaç dakikada) gelir. `sonra`: açılış verisinin anı (`serverTime`); ondan sonra uygulanan
 * işlem satırın görünen durumu olur, yeni özet gelince kendiliğinden düşer
 */
export function uygulananHaritasi(gecmis: KontrolGecmisi[], sonra: number, bul: (k: KontrolGecmisi) => Hedef[]): Map<string, Hedef> {
  const out = new Map<string, Hedef>();
  const yeni = gecmis.filter((k) => (k.tur === 'urun.satis' || k.tur === 'secenek.satis') && k.durum === 'uygulandi' && k.bitti != null && k.bitti > sonra);
  for (const k of yeni.sort((a, b) => (a.bitti ?? 0) - (b.bitti ?? 0))) for (const h of bul(k)) out.set(h.anahtar, h);
  return out;
}

/** Satırın görünen satış durumu: bekleyen istek ve henüz yansımamış uygulanan işlem açılış verisinin önüne geçer */
export function satisGorunumu(anahtar: string, asil: boolean, bekleyen: Map<string, BekleyenIs[]>, uygulanan: Map<string, Hedef>): { satista: boolean; bekliyor: boolean } {
  const son = bekleyen.get(anahtar)?.at(-1);
  if (son?.hedef.satista != null) return { satista: son.hedef.satista, bekliyor: true };
  const yapilan = uygulanan.get(anahtar);
  return { satista: yapilan?.satista ?? asil, bekliyor: false };
}

// ─── Menü satırları (uzaktan özetin açılış verisinden) ───────────────────────

export interface UrunSatiri {
  id: string;
  ad: string;
  kategoriId: string;
  kategori: string;
  satista: boolean;
  /** Sitenin kapattığı ürün ("Sitede satışta değil") */
  site: boolean;
}

/** Kasada satılan ürünler (gizli ve hizmet kalemi hariç), kategori ve ürün sırasıyla */
export function urunSatirlari(boot: Pick<BootstrapDTO, 'products' | 'categories'>): UrunSatiri[] {
  const kat = new Map(boot.categories.map((c) => [c.id, c]));
  return boot.products
    .filter((p) => !p.hidden && !p.isService)
    .sort((a, b) => (kat.get(a.categoryId)?.sort ?? 0) - (kat.get(b.categoryId)?.sort ?? 0) || a.sort - b.sort || a.name.localeCompare(b.name, 'tr'))
    .map((p) => ({ id: p.id, ad: p.name, kategoriId: p.categoryId, kategori: kat.get(p.categoryId)?.name ?? 'Kategorisiz', satista: p.active, site: !p.active && p.soldOutBy === 'site' }));
}

export interface SecenekGrubu {
  id: string;
  ad: string;
  /** Grubu kullanan ürünlerin kısa adları (iki "Şeker" grubu karışmasın) */
  kullanan: string[];
  secenekler: { id: string; ad: string; ozetAdi: string; satista: boolean }[];
}

/** Kasada satılan bir ürüne bağlı gruplar; sitenin "hiçbiri" seçeneği (Şurup yok) tükenmez, listelenmez */
export function secenekGruplari(boot: Pick<BootstrapDTO, 'products' | 'optionGroups'>): SecenekGrubu[] {
  const satilan = boot.products.filter((p) => !p.hidden && !p.isService);
  return boot.optionGroups
    .map((g) => ({
      id: g.id,
      ad: g.name,
      kullanan: satilan.filter((p) => p.optionGroupIds.includes(g.id)).map((p) => p.shortName?.trim() || p.name),
      secenekler: g.items.filter((i) => i.code !== 'none').map((i) => ({ id: i.id, ad: i.name, ozetAdi: secenekOzetAdi(i.name, g.name), satista: !i.soldOut })),
    }))
    .filter((g) => g.kullanan.length > 0 && g.secenekler.length > 0);
}

// ─── Geçmiş ve kasa ──────────────────────────────────────────────────────────

export const GECMIS_ETIKET: Record<GecmisDurumu, string> = { bekliyor: 'Bekliyor', uygulandi: 'Uygulandı', reddedildi: 'Reddedildi', iptal: 'İptal' };
export const GECMIS_TON: Record<GecmisDurumu, 'info' | 'success' | 'danger' | 'neutral'> = { bekliyor: 'info', uygulandi: 'success', reddedildi: 'danger', iptal: 'neutral' };

/** İşlemi isteyen: kendisi "Siz", parolalı giriş "Parolalı giriş", üye e-postasıyla */
export function kimEtiketi(kim: string, ben: string | null): string {
  if (kim === 'parola') return ben == null ? 'Siz' : 'Parolalı giriş';
  // E-posta Türkçe kurala göre küçültülmez (I → ı olurdu)
  if (ben && kim.toLowerCase() === ben.toLowerCase()) return 'Siz';
  return kim;
}

/** Kasa çevrimiçi mi: nabız 5 dakikada bir, 10 dakikadır ses yoksa değil */
export const kasaCevrimici = (sonGorulme: number | null | undefined, simdi: number) => sonGorulme != null && simdi - sonGorulme <= REMOTE_STALE_MS;

/** Son görülme: "az önce", "12 dk önce", "3 sa önce", bir günden eskisi tarih ve saat */
export function gorulmeMetni(at: number | null | undefined, simdi: number): string {
  if (at == null) return 'hiç bağlanmadı';
  const dk = Math.floor(Math.max(0, simdi - at) / 60_000);
  if (dk < 1) return 'az önce';
  if (dk < 60) return `${dk} dk önce`;
  if (dk < 24 * 60) return `${Math.floor(dk / 60)} sa önce`;
  return fmtDateTime(at);
}

/**
 * Kişinin son girişi (Ekip satırı). Kasa saati saat başına yuvarlar (her girişte özet değişmesin): giriş `at` ile bir
 * saat sonrası arasındadır, dakika gösterilmez
 */
export function sonGirisMetni(at: number | null, simdi: number): string {
  if (at == null) return 'Hiç girmedi';
  const sa = Math.floor(Math.max(0, simdi - at) / 3_600_000);
  if (sa < 1) return 'Son giriş son bir saat içinde';
  if (sa < 24) return `Son giriş yaklaşık ${sa} sa önce`;
  return `Son giriş ${fmtDateTime(at)} sularında`;
}
