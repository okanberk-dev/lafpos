import { queryOptions, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { type DavetRolu, type DavetYaniti, komutDogrula, type KomutIstegi, type KomutYaniti, type KontrolPaneli, type UzaktanUye } from '@shared/kontrol';
import { get, post } from './api';
import { REMOTE, REMOTE_STALE_MS, remoteSetupQuery, type UzaktanErisim } from './remote';

/**
 * LafPOS Uzaktan › Uzaktan yönetim'in istemcisi (docs/UZAKTAN-YONETIM.md; sözleşme shared/kontrol.ts): panel uçları,
 * sorgu anahtarları, yoklama ve PIN şifrelemesi. İstekler seçili dükkânın başlığıyla gider (api.ts).
 *
 * Açık PIN yalnız formun belleğinde durur: gönderirken kasanın açık anahtarıyla burada şifrelenir, buluta yalnız şifreli
 * metin gider. PIN hiçbir günlüğe, hata iletisine ya da depolamaya yazılmaz; form gönderimden sonra alanı boşaltır.
 */

/** Panel uçları (api/_kontrol.ts): okuma GET, her değişiklik POST (e-posta adreste değil gövdede gider) */
export const KONTROL_UCLARI = {
  durum: '/kontrol/durum',
  komut: '/kontrol/komut',
  iptal: '/kontrol/iptal',
  uyeler: '/kontrol/uyeler',
  uye: '/kontrol/uye',
  uyeRol: '/kontrol/uye-rol',
  uyeSil: '/kontrol/uye-sil',
} as const;

export const kontrolAnahtari = {
  hepsi: ['kontrol'] as const,
  durum: ['kontrol', 'durum'] as const,
  uyeler: ['kontrol', 'uyeler'] as const,
};

/**
 * Yoklama: bekleyen işlem varken ve kasa çevrimiçiyken 15 sn (kasa komutu alınca dakikada bir uğrar, sonuç çabuk
 * görünsün), yoksa 60 sn: kasa kapalıyken bekleyen işlem saatlerce sürebilir, her yoklama Redis'i okur. Sekme gizliyken
 * hiç sorulmaz (TanStack Query `refetchIntervalInBackground` kapalı; görünür olunca bir kez yenilenir), src/lib/remote.ts'teki kalıp
 */
export const KONTROL_HIZLI_MS = 15_000;
export const KONTROL_YAVAS_MS = 60_000;
export const kontrolYoklamaMs = (d: Pick<KontrolPaneli, 'bekleyen' | 'kasa'> | undefined, now = Date.now()) => {
  const sonGorulme = d?.kasa?.sonGorulme;
  const cevrimici = sonGorulme != null && now - sonGorulme <= REMOTE_STALE_MS;
  return d?.bekleyen.length && cevrimici ? KONTROL_HIZLI_MS : KONTROL_YAVAS_MS;
};

export const kontrolDurumSorgusu = queryOptions({
  queryKey: kontrolAnahtari.durum,
  queryFn: () => get<KontrolPaneli>(KONTROL_UCLARI.durum),
  refetchInterval: (q) => kontrolYoklamaMs(q.state.data),
});

/**
 * Kabuğun menüsü ve patron panelinin kartı için: Merkez yalnız panelin sahibine, Uzaktan yönetim parolasız görünümde hiç
 * (uçları 403 der, "Yeniden dene" bir şey değiştirmez). Rol, Uzaktan yönetim'in kendi sorgusundan bir kez okunur
 * (açılışta; yoklanmaz, sayfa açıkken sayfanın yoklaması tazeler). Rol bilinmezken (yükleniyor, hata) menü açık kalır:
 * uç zaten denetler
 */
export function useUzaktanErisim(): UzaktanErisim {
  const setup = useQuery({ ...remoteSetupQuery, enabled: REMOTE, staleTime: Infinity, refetchOnWindowFocus: false });
  // Parolasız görünüm gerçek giriş değil; kafe bağlanmadan örnek gün (demo) ise örnek panel açılır
  const parolasiz = !!setup.data?.open && !setup.data.demo;
  const rol = useQuery({ ...kontrolDurumSorgusu, enabled: REMOTE && setup.isSuccess && !parolasiz, refetchInterval: false, staleTime: 5 * 60_000, retry: false, select: (d) => d.ben.rol });
  const merkez = !parolasiz && (rol.data === undefined || rol.data === 'sahip');
  // Aynı değerde aynı nesne: menüyü kuran useMemo'lar her çizimde yeniden kurmasın
  return useMemo(() => ({ merkez, kontrol: !parolasiz }), [merkez, parolasiz]);
}

/** Panele kim girer (yalnız sahip): elle değişir, yoklanmaz */
export const uyelerSorgusu = queryOptions({
  queryKey: kontrolAnahtari.uyeler,
  queryFn: () => get<{ uyeler: UzaktanUye[] }>(KONTROL_UCLARI.uyeler),
});

/**
 * Komutu kuyruğa koyar. Önce sözleşmenin doğrulaması burada da koşar (bulut ve kasa yeniden doğrular): eksik alan
 * istek gitmeden Türkçe iletiyle döner, veri sabit sırayla gider. `guncelle` (yalnız gün sonu) da gider: düşüyordu,
 * "Gün sonu al ve güncelle" güncellemeyi hiç istemiyordu (inceleme, 23 Kas 2026)
 */
export async function komutGonder(istek: KomutIstegi): Promise<KomutYaniti> {
  const v = komutDogrula(istek.tur, istek.veri);
  if (!v.ok) throw new Error(v.hata);
  return post<KomutYaniti>(KONTROL_UCLARI.komut, { tur: v.tur, veri: v.veri, ...(istek.ad ? { ad: istek.ad } : {}), ...(v.tur === 'gun.sonu' && istek.guncelle === true ? { guncelle: true } : {}) });
}

/**
 * Bekleyen işlemi kuyruktan çeker; yanıt geçmişe yazılan "İptal" satırıdır. Kasaya gitmiş işlem ve (sahip değilse)
 * başkasının işlemi iptal edilmez: ileti sunucudan
 */
export const komutIptal = (id: string) => post<KomutYaniti>(KONTROL_UCLARI.iptal, { id });

/** Kişiyi panele ekler (yeniden davet eskisinin yerine geçer); davet kodu yalnız bu yanıtta bir kez görünür */
export const uyeDavetEt = (eposta: string, rol: DavetRolu) => post<DavetYaniti>(KONTROL_UCLARI.uye, { eposta, rol });
export const uyeRolDegistir = (eposta: string, rol: DavetRolu) => post<{ ok: true }>(KONTROL_UCLARI.uyeRol, { eposta, rol });
/** Oturumu en geç bir dakikada kapanır */
export const uyeKaldir = (eposta: string) => post<{ ok: true }>(KONTROL_UCLARI.uyeSil, { eposta });

// ─── PIN şifrelemesi ─────────────────────────────────────────────────────────

/** Web Crypto yalnız güvenli adreste (https) ve güncel tarayıcıda var */
export const SIFRELEME_YOK = 'Bu tarayıcı PIN’i şifreleyemiyor: güncel bir tarayıcıyla ve https adresinden açın';

/** Tarayıcının (ve testte Node'un) Web Crypto'su; tür adı ortamdan bağımsız */
type Subtle = typeof globalThis.crypto.subtle;

export function sifrelemeVar(): boolean {
  return typeof globalThis.crypto !== 'undefined' && !!globalThis.crypto.subtle;
}

/**
 * PIN'i kasanın açık anahtarıyla (`KontrolDurumu.anahtar`: RSA-OAEP 2048, SHA-256; SPKI, base64) şifreler, base64
 * döner. Şifreyi yalnız kasa çözer. Hata iletisi PIN'i içermez
 */
export async function pinSifrele(pin: string, anahtar: string, subtle: Subtle | null = globalThis.crypto?.subtle ?? null): Promise<string> {
  if (!subtle) throw new Error(SIFRELEME_YOK);
  const key = await (async () => {
    try {
      return await subtle.importKey('spki', base64Bytes(anahtar), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
    } catch {
      throw new Error('Kasanın PIN anahtarı okunamadı: kasa bir sonraki bağlantısında yeniler, birkaç dakika sonra yeniden deneyin');
    }
  })();
  const sifreli = await subtle.encrypt({ name: 'RSA-OAEP' }, key, new TextEncoder().encode(pin));
  return bytesBase64(new Uint8Array(sifreli));
}

/** base64 ya da base64url (dolgulu ya da dolgusuz) → bayt */
function base64Bytes(b64: string): Uint8Array<ArrayBuffer> {
  let s = b64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesBase64(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}
