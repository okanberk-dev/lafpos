import { create } from 'zustand';

/**
 * Kabuk durumu: komut paleti, kullanıcı menüsü ve yönetim paneli tercihleri (dar menü, sıkı görünüm).
 * Tercihler bu cihazda saklanır; saklanamazsa oturum boyunca bellekte kalır.
 */
const KEY = 'asilpos.pref.admin';

interface AdminPrefs {
  rail: boolean;
  compact: boolean;
}

function readPrefs(): AdminPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<AdminPrefs>;
    return { rail: v.rail === true, compact: v.compact === true };
  } catch {
    return { rail: false, compact: false };
  }
}

function savePrefs(p: AdminPrefs) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* özel pencere */
  }
}

interface ShellState extends AdminPrefs {
  paletteOpen: boolean;
  userMenuOpen: boolean;
  setPalette: (open: boolean) => void;
  setUserMenu: (open: boolean) => void;
  toggleRail: () => void;
  toggleCompact: () => void;
}

export const useShell = create<ShellState>((set, get) => ({
  ...readPrefs(),
  paletteOpen: false,
  userMenuOpen: false,
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setUserMenu: (userMenuOpen) => set({ userMenuOpen }),
  toggleRail: () => {
    const next = { rail: !get().rail, compact: get().compact };
    savePrefs(next);
    set(next);
  },
  toggleCompact: () => {
    const next = { rail: get().rail, compact: !get().compact };
    savePrefs(next);
    set(next);
  },
}));

/** Türkçe aramada "cay" "Çay"ı, "sut" "Süt"ü bulsun: küçük harf, ı→i, aksanlar atılır */
export function fold(s: string): string {
  return s
    .toLocaleLowerCase('tr-TR')
    .replace(/ı/g, 'i')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
