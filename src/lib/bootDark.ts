/**
 * Kendi temasında açılan ekranlar: bar (cihaz tercihinde: koyu ya da açık), çağrı ekranı (hep koyu) ve müşteri ekranı
 * (`?tema=acik` ise açık, değilse koyu). Açılışta ilk kare de doğru temada çizilsin diye adres kökten okunur (beyaz ya
 * da koyu flaş olmasın); her sayfa kendi temasını `useLayoutEffect`'te kurup `releaseBootDark()` çağırır. DOM'a
 * dokunmaz (testler sunucu ayarıyla koşar); tarayıcı tarafı theme.ts'te
 */

/** Bar ekranının cihazdaki tercihi (`useLocalPref(KDS_THEME_PREF, 'koyu')`): gece koyu, cam önündeki tablette açık */
export const KDS_THEME_PREF = 'kds.tema';
export type KdsTheme = 'koyu' | 'acik';
/** Uygulamanın genel teması (kasa ekranları, yönetim) */
export type AppTheme = 'acik' | 'koyu' | 'sistem';
/**
 * Ekranın zorladığı tema: `dark` ve `light` uygulama ve cihaz temasını ezer (bar ekranı açık seçilmişse cihaz koyu
 * modda olsa da açık çizilir); null ise genel tema geçerli
 */
export type ForcedTheme = 'dark' | 'light' | null;

const BOOT_DARK_PATHS = ['/mutfak', '/cagri', '/musteri-ekrani'];
const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/';
export const isBootDarkPath = (path: string) => BOOT_DARK_PATHS.includes(normalizePath(path));

/** Açılış adresinin ilk karedeki teması: sayfanın kuracağı temayla aynı karar (bar ekranında açık seçilmişse açık) */
export function bootThemeFor(path: string, search: string, kdsTheme: KdsTheme): ForcedTheme {
  const p = normalizePath(path);
  if (!BOOT_DARK_PATHS.includes(p)) return null;
  if (p === '/mutfak') return kdsTheme === 'koyu' ? 'dark' : 'light';
  if (p === '/musteri-ekrani') return new URLSearchParams(search).get('tema') === 'acik' ? 'light' : 'dark';
  return 'dark';
}

/** Açılış adresi ilk karede koyu mu */
export function bootDarkFor(path: string, search: string, kdsTheme: KdsTheme): boolean {
  return bootThemeFor(path, search, kdsTheme) === 'dark';
}

/** Ekran koyu mu: zorlanan tema her şeyi ezer; yoksa genel tema, "sistem"de cihazın modu */
export function resolveDark(theme: AppTheme, force: ForcedTheme, systemDark: boolean): boolean {
  if (force) return force === 'dark';
  return theme === 'koyu' || (theme === 'sistem' && systemDark);
}

/** Bar tercihinin zorladığı tema */
export const forcedForKds = (t: KdsTheme): ForcedTheme => (t === 'koyu' ? 'dark' : 'light');
