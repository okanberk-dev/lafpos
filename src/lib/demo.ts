import { create } from 'zustand';
import type { DemoServer, DemoUser } from '@shared/demo';
import type { MeDTO } from '@shared/types';
import { get, getToken, post, setToken } from './api';
import { useAuth } from './auth';

/**
 * Tarayıcı demosu (vite build --mode demo, lafpos.vercel.app/demo): LafPOS sunucusu sayfanın içinde çalışır
 * (demo/runtime.ts), PIN sorulmaz. Uzaktan görünümle (REMOTE) ilgisi yoktur.
 */
export const DEMO = import.meta.env.MODE === 'demo';

/** Uygulamanın kendi adresi: yönlendirici dışı geçişlerde (window.open) demonun /demo öneki korunur */
export const appUrl = (path: string) => `${import.meta.env.BASE_URL.replace(/\/$/, '')}${path}`;

export const useDemo = create<{ server: DemoServer | null }>(() => ({ server: null }));

const ROLE_KEY = 'lafpos.demo.rol';

function lastRole(): string {
  try {
    return localStorage.getItem(ROLE_KEY) ?? 'patron';
  } catch {
    return 'patron';
  }
}

function rememberRole(role: string) {
  try {
    localStorage.setItem(ROLE_KEY, role);
  } catch {
    /* özel pencere: her açılışta Patron */
  }
}

/** Demo sunucusunu başlatır ve son seçilen rolle (ilk açılışta Patron) girer */
export async function startDemo() {
  // Sunucu kodunun okuduğu kadar `process`: ortam değişkeni yok (dış sistem bağlanmaz), komut satırı yok
  const g = globalThis as { process?: { env: Record<string, string>; argv: string[] } };
  g.process ??= { env: {}, argv: [] };
  const { startDemoServer } = await import('virtual:lafpos-demo');
  const server = await startDemoServer();
  useDemo.setState({ server });
  const user = server.users.find((u) => u.role === lastRole()) ?? server.users[0];
  // Açık oturum (aynı demonun başka sekmesi, yenileme) korunur: çıkış yapmak diğer sekmeyi de düşürürdü
  if (getToken()) {
    const me = await get<MeDTO>('/auth/me').catch(() => null);
    if (me?.role === user.role) return;
  }
  const res = await post<{ token: string }>('/auth/login', { pin: user.pin, device: 'Tarayıcı demosu' });
  setToken(res.token);
}

export async function enterAs(user: DemoUser) {
  rememberRole(user.role);
  await useAuth.getState().login(user.pin);
}

/**
 * Ürün görseli: kasada sunucu küçük kopyayı diskten verir (/media/products), demoda disk yok. Görsel sitenin
 * küçültme ucundan doğrudan gelir (yalnız laffogato.net görselleri; sunucudaki `thumbSource` ile aynı sınır).
 */
export function demoProductImage(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' || u.host !== 'laffogato.net') return null;
    return `${u.origin}/_next/image?url=${encodeURIComponent(u.pathname)}&w=256&q=75`;
  } catch {
    return null;
  }
}

/** Yetkili onayı verebilen demo personeli (müdür, patron): onay penceresinde PIN yerine düğme */
export function demoApprovers(): DemoUser[] {
  return (useDemo.getState().server?.users ?? []).filter((u) => u.role === 'mudur' || u.role === 'patron');
}
