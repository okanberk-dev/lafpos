import { ESKI_ENV_ONEKI } from './eski-adlar.js';

/**
 * Ortam değişkenlerinin adı (26 Kasım 2026'dan beri `ASILPOS_*`). Kurulu kasaların ayarlar.env'i ve Vercel'deki
 * değişkenler eski adla (shared/eski-adlar.ts `ESKI_ENV_ONEKI`) durur ve yeniden yazılmaz: okuyan her yer önce yeni
 * adı, yoksa eskisini okur. Ayarlar dosyasına yazan, dosyada zaten duran adı korur (`yazilacakEnvAdi`).
 */
export const ENV_ONEKI = 'ASILPOS_';

type Vars = Readonly<Record<string, string | undefined>>;

/** `posEnv(vars, 'PORT')` = `ASILPOS_PORT ?? <eski önek>PORT` */
export function posEnv(vars: Vars, ad: string): string | undefined {
  return vars[ENV_ONEKI + ad] ?? vars[ESKI_ENV_ONEKI + ad];
}

/** İlk dolu değer: yeni ad boşsa eskisine düşer (anahtarlar ve klasörler için; boş değer tanımsız sayılır) */
export function posEnvDolu(vars: Vars, ad: string): string | undefined {
  return vars[ENV_ONEKI + ad] || vars[ESKI_ENV_ONEKI + ad] || undefined;
}

/** Yeni adın eski karşılığı (`ASILPOS_X` → eski önekle X); önekli olmayan ad için null */
export function eskiEnvAdi(tamAd: string): string | null {
  return tamAd.startsWith(ENV_ONEKI) ? ESKI_ENV_ONEKI + tamAd.slice(ENV_ONEKI.length) : null;
}

/** Eski adı yenisine çevirir (eski önekle X → `ASILPOS_X`); başka adı olduğu gibi bırakır */
export function yeniEnvAdi(tamAd: string): string {
  return tamAd.startsWith(ESKI_ENV_ONEKI) ? ENV_ONEKI + tamAd.slice(ESKI_ENV_ONEKI.length) : tamAd;
}

/** Tam adla okur: ad `ASILPOS_` ile başlıyorsa yoksa eski adı da dener (Bağlantı bilgileri, ladmin dağıtımı) */
export function envDegeri(vars: Vars, tamAd: string): string | undefined {
  const v = vars[tamAd];
  if (v !== undefined) return v;
  const eski = eskiEnvAdi(tamAd);
  return eski ? vars[eski] : undefined;
}

/** Durum ve hata metinleri için tanımlı olan ad: yeni ad tanımlıysa o, yalnız eski ad tanımlıysa o, hiçbiri yoksa yeni ad */
export function posEnvAdi(vars: Vars, ad: string): string {
  if (vars[ENV_ONEKI + ad] === undefined && vars[ESKI_ENV_ONEKI + ad] !== undefined) return ESKI_ENV_ONEKI + ad;
  return ENV_ONEKI + ad;
}

/**
 * Ayarlar dosyasına yazılacak ad: dosyada yalnız eski ad duruyorsa o (kurulu kasanın satırı yerinde değişir, yinelenen
 * ya da eskimiş satır kalmaz), değilse verilen ad. `dosyadakiler`: dosyadaki etkin anahtarlar
 */
export function yazilacakEnvAdi(dosyadakiler: ReadonlySet<string>, tamAd: string): string {
  const eski = eskiEnvAdi(tamAd);
  if (eski && !dosyadakiler.has(tamAd) && dosyadakiler.has(eski)) return eski;
  return tamAd;
}
