import { create } from 'zustand';
import { type AppTheme, bootThemeFor, DISPLAY_CONFIG_KEY, type ForcedTheme, forcedForKds, KDS_THEME_PREF, type KdsTheme, resolveDark } from './bootDark';
import { readLocalPref, writeLocalPref } from './hooks';

export { isBootDarkPath, KDS_THEME_PREF, type ForcedTheme, type KdsTheme } from './bootDark';

type Theme = AppTheme;
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

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function apply(theme: Theme, force: ForcedTheme) {
  const dark = resolveDark(theme, force, systemDark());
  document.documentElement.classList.toggle('dark', dark);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0e0d0c' : '#f4f1ec');
}

export const useTheme = create<{
  theme: Theme;
  /** Ekranın zorladığı tema (bar, çağrı, müşteri ekranı); null ise genel tema */
  force: ForcedTheme;
  /** Açılış adresi kendi temasında açılan ekransa: sayfa kendi temasını kurana dek ilk kareler o temada */
  bootForce: ForcedTheme;
  setTheme: (t: Theme) => void;
  setForce: (f: ForcedTheme) => void;
  /** Adres o ekrandan çıkınca (ya da yetki yönlendirince) başlangıç teması bırakılır */
  releaseBootDark: () => void;
}>((set, get) => ({
  theme: read(),
  force: null,
  bootForce: null,
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* tercih yalnız bu oturumda kalır */
    }
    set({ theme });
    apply(theme, get().force ?? get().bootForce);
  },
  setForce: (force) => {
    set({ force });
    apply(get().theme, force ?? get().bootForce);
  },
  releaseBootDark: () => {
    if (!get().bootForce) return;
    set({ bootForce: null });
    apply(get().theme, get().force);
  },
}));

/** Bar ekranının teması: cihaza kaydedilir ve hemen uygulanır (uygulama ya da cihaz teması ne olursa olsun) */
export function setBarTheme(t: KdsTheme) {
  writeLocalPref(KDS_THEME_PREF, t);
  useTheme.getState().setForce(forcedForKds(t));
}

/** Ekran şu an koyu mu (zorlanan tema dahil); bileşen yeniden çizilsin diye mağazadan okunur */
export function useIsDark(): boolean {
  const theme = useTheme((s) => s.theme);
  const force = useTheme((s) => s.force ?? s.bootForce);
  return resolveDark(theme, force, systemDark());
}

/**
 * `path` yönlendiricinin gördüğü adres (demoda /demo öneki atılmış). Bar ekranı (cihaz tercihinde), çağrı ekranı ve
 * müşteri ekranı (`?tema=acik` ya da son görünümü porselense açık, değilse koyu) ilk karede kendi temasında
 */
/** Müşteri ekranının saklanan son teması (yoksa ya da okunamıyorsa null) */
function readDisplayTheme(): string | null {
  try {
    const cached = JSON.parse(localStorage.getItem(DISPLAY_CONFIG_KEY) ?? 'null') as { theme?: unknown } | null;
    return typeof cached?.theme === 'string' ? cached.theme : null;
  } catch {
    return null;
  }
}

export function initTheme(path?: string) {
  const bootForce = path ? bootThemeFor(path, window.location.search, readKdsTheme(), readDisplayTheme()) : null;
  useTheme.setState({ bootForce });
  apply(read(), bootForce);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useTheme.getState();
    apply(s.theme, s.force ?? s.bootForce);
  });
}
