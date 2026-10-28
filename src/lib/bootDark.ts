/**
 * Zorla koyu açılan ekranlar: bar (cihaz tercihi koyuysa), çağrı ekranı (hep) ve müşteri ekranı (`?tema=acik`
 * değilse). Açılışta ilk kare de koyu çizilsin diye adres kökten okunur (beyaz flaş olmasın); her sayfa kendi
 * koyusunu `useLayoutEffect`'te kurup `releaseBootDark()` çağırır. DOM'a dokunmaz (testler sunucu ayarıyla koşar);
 * tarayıcı tarafı theme.ts'te
 */

/** Bar ekranının cihazdaki tercihi (`useLocalPref(KDS_THEME_PREF, 'koyu')`): gece koyu, cam önündeki tablette açık */
export const KDS_THEME_PREF = 'kds.tema';
export type KdsTheme = 'koyu' | 'acik';

const BOOT_DARK_PATHS = ['/mutfak', '/cagri', '/musteri-ekrani'];
const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/';
export const isBootDarkPath = (path: string) => BOOT_DARK_PATHS.includes(normalizePath(path));

/** Açılış adresi ilk karede koyu mu: sayfanın kuracağı temayla aynı karar (bar ekranında açık seçilmişse açık başlar) */
export function bootDarkFor(path: string, search: string, kdsTheme: KdsTheme): boolean {
  const p = normalizePath(path);
  if (!BOOT_DARK_PATHS.includes(p)) return false;
  if (p === '/mutfak') return kdsTheme === 'koyu';
  if (p === '/musteri-ekrani') return new URLSearchParams(search).get('tema') !== 'acik';
  return true;
}
