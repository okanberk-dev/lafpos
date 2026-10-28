import { create } from 'zustand';
import { bootDarkFor, KDS_THEME_PREF, type KdsTheme } from './bootDark';
import { readLocalPref } from './hooks';

export { isBootDarkPath, KDS_THEME_PREF, type KdsTheme } from './bootDark';

type Theme = 'acik' | 'koyu' | 'sistem';
const KEY = 'lafpos.theme';

/** Bar ekranının bu cihazdaki tercihi (kaydedilmemişse koyu) */
export const readKdsTheme = (): KdsTheme => (readLocalPref<KdsTheme>(KDS_THEME_PREF, 'koyu') === 'acik' ? 'acik' : 'koyu');

function read(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'acik' || v === 'koyu' || v === 'sistem' ? v : 'sistem';
  } catch {
    return 'sistem';
  }
}

function apply(theme: Theme, forceDark: boolean) {
  const dark = forceDark || theme === 'koyu' || (theme === 'sistem' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d0f13' : '#edeff1');
}

export const useTheme = create<{
  theme: Theme;
  forceDark: boolean;
  /** Açılış adresi zorla koyu ekransa (bar, çağrı, müşteri ekranı): sayfa kendi koyusunu kurana dek ilk kareler koyu */
  bootDark: boolean;
  setTheme: (t: Theme) => void;
  setForceDark: (v: boolean) => void;
  /** Adres zorla koyu ekrandan çıkınca (ya da yetki yönlendirince) başlangıç koyusu bırakılır */
  releaseBootDark: () => void;
}>((set, get) => ({
  theme: read(),
  forceDark: false,
  bootDark: false,
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* tercih yalnız bu oturumda kalır */
    }
    set({ theme });
    apply(theme, get().forceDark || get().bootDark);
  },
  setForceDark: (forceDark) => {
    set({ forceDark });
    apply(get().theme, forceDark || get().bootDark);
  },
  releaseBootDark: () => {
    if (!get().bootDark) return;
    set({ bootDark: false });
    apply(get().theme, get().forceDark);
  },
}));

/**
 * `path` yönlendiricinin gördüğü adres (demoda /demo öneki atılmış). Bar ekranı (tercih koyuysa), çağrı ekranı ve
 * müşteri ekranı (`?tema=acik` değilse) ilk karede koyu
 */
export function initTheme(path?: string) {
  const bootDark = !!path && bootDarkFor(path, window.location.search, readKdsTheme());
  useTheme.setState({ bootDark });
  apply(read(), bootDark);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useTheme.getState();
    apply(s.theme, s.forceDark || s.bootDark);
  });
}
