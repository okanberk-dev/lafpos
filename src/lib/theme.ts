import { create } from 'zustand';

type Theme = 'acik' | 'koyu' | 'sistem';
const KEY = 'lafpos.theme';

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

export const useTheme = create<{ theme: Theme; forceDark: boolean; setTheme: (t: Theme) => void; setForceDark: (v: boolean) => void }>((set, get) => ({
  theme: read(),
  forceDark: false,
  setTheme: (theme) => {
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* tercih yalnız bu oturumda kalır */
    }
    set({ theme });
    apply(theme, get().forceDark);
  },
  setForceDark: (forceDark) => {
    set({ forceDark });
    apply(get().theme, forceDark);
  },
}));

export function initTheme() {
  apply(read(), false);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    const s = useTheme.getState();
    apply(s.theme, s.forceDark);
  });
}
