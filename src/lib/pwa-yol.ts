/**
 * Ana ekrana eklemenin yolu (saf: tarayıcı nesnesi kullanmaz, sunucu testleri de içe aktarır). Kullanımı `pwa.ts`'te
 */

export type InstallWay = 'prompt' | 'ios' | 'android' | null;

export interface InstallContext {
  /** Zaten ana ekrandan (kendi penceresinde) açık */
  standalone: boolean;
  /** Sunucunun çalıştığı bilgisayar (localhost): AsilPOS orada kurulu program */
  kasaPc: boolean;
  /** Tarayıcı "yükle" olayını verdi */
  hasPrompt: boolean;
  ua: string;
  touchPoints: number;
  /** Güvenli adres (https ya da localhost) */
  secure: boolean;
}

/** Bu cihazda ana ekrana nasıl eklenir; null: önerilmez (saf; tests/masaustu-programi.test.ts) */
export function installWay(c: InstallContext): InstallWay {
  if (c.standalone || c.kasaPc) return null;
  if (c.hasPrompt) return 'prompt';
  const ios = /iPad|iPhone|iPod/.test(c.ua) || (/Macintosh/.test(c.ua) && c.touchPoints > 1);
  // iOS'ta yalnız Safari ana ekrana ekler (iOS 16.4'ten önce öbür tarayıcılar eklemez)
  if (ios) return /Safari/.test(c.ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(c.ua) ? 'ios' : null;
  // Android'de her tarayıcı (Chrome, Samsung Internet, Firefox): yol tarifi tarayıcı adı vermez
  if (/Android/.test(c.ua) && !c.secure) return 'android';
  return null;
}

/** Yükleme yolunun kısa açıklaması (menü satırının alt yazısı) */
export const INSTALL_HINT: Record<Exclude<InstallWay, null>, string> = {
  prompt: 'AsilPOS bu cihazda adres çubuğu olmadan, kendi penceresinde açılır',
  ios: 'Safari’de Paylaş düğmesi › Ana Ekrana Ekle',
  // http adresinde Android tam uygulama vermez: kısayol tarayıcıda açılır (docs/05-KASA-BILGISAYARI.md §5)
  android: 'Tarayıcı menüsü › Ana ekrana ekle; kısayol adres çubuğuyla açılır',
};

/** Sunucunun çalıştığı bilgisayar (kasa programı): localhost */
export const isLoopbackHost = (host: string) => /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host);
