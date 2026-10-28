import { create } from 'zustand';
import type { Permission } from '@shared/permissions';
import type { MeDTO } from '@shared/types';
import { get, getToken, post, setToken, setUnauthorizedHandler } from './api';
import { endSession } from './sessionEnd';

interface AuthState {
  me: MeDTO | null;
  ready: boolean;
  init: () => Promise<void>;
  login: (pin: string) => Promise<MeDTO>;
  logout: () => Promise<void>;
  /** Oturumu sunucuda kapatmadan ekranı kilitler (aynı cihaz, başka kullanıcı) */
  clear: () => void;
}

export const useAuth = create<AuthState>((set) => ({
  me: null,
  ready: false,
  init: async () => {
    if (!getToken()) {
      set({ ready: true });
      return;
    }
    try {
      const me = await get<MeDTO>('/auth/me');
      set({ me, ready: true });
    } catch {
      setToken(null);
      set({ me: null, ready: true });
    }
  },
  login: async (pin) => {
    const res = await post<{ token: string; me: MeDTO }>('/auth/login', { pin, device: navigator.userAgent.slice(0, 120) });
    setToken(res.token);
    set({ me: res.me });
    return res.me;
  },
  logout: async () => {
    try {
      await post('/auth/logout');
    } catch {
      /* oturum zaten kapanmış olabilir */
    }
    setToken(null);
    set({ me: null });
    endSession();
  },
  clear: () => {
    setToken(null);
    set({ me: null });
    endSession();
  },
}));

setUnauthorizedHandler(() => useAuth.getState().clear());

export function useCan() {
  const me = useAuth((s) => s.me);
  return (p: Permission) => !!me?.permissions.includes(p);
}

export function can(p: Permission): boolean {
  return !!useAuth.getState().me?.permissions.includes(p);
}
