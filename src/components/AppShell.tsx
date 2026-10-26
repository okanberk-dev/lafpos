import { Expand, Lock, LogOut, MoreHorizontal, Moon, Search, Shrink, Sun, Wifi, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { fmtTime } from '@shared/time';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLive } from '@/lib/live';
import { isAdminArea, POS_NAV } from '@/lib/nav';
import { useShell } from '@/lib/shell';
import { useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { useWakeLock } from '@/lib/wakelock';
import { CommandPalette } from './CommandPalette';
import { Modal } from './ui/Modal';

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** Ayarlardaki süre boyunca dokunulmazsa ekranı kilitler (oturumu kapatır). */
function useAutoLock(minutes: number) {
  const logout = useAuth((s) => s.logout);
  const last = useRef(Date.now());
  useEffect(() => {
    if (!minutes) return;
    const touch = () => (last.current = Date.now());
    const events = ['pointerdown', 'keydown', 'wheel'];
    events.forEach((e) => window.addEventListener(e, touch, { passive: true }));
    const t = setInterval(() => {
      if (Date.now() - last.current > minutes * 60_000) void logout();
    }, 15_000);
    return () => {
      events.forEach((e) => window.removeEventListener(e, touch));
      clearInterval(t);
    };
  }, [minutes, logout]);
}

export function AppShell({ children }: { children: ReactNode }) {
  const boot = useBoot();
  const can = useCan();
  const me = useAuth((s) => s.me)!;
  const logout = useAuth((s) => s.logout);
  const live = useLive((s) => s.status);
  const { theme, setTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();
  const now = useClock();
  const menuOpen = useShell((s) => s.userMenuOpen);
  const setMenuOpen = useShell((s) => s.setUserMenu);
  const setPalette = useShell((s) => s.setPalette);
  const [moreOpen, setMoreOpen] = useState(false);
  useAutoLock(boot.settings.autoLockMinutes);
  useWakeLock(boot.settings.keepAwake);
  const [full, setFull] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement);
  useEffect(() => {
    const on = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const toggleFull = () => {
    setMenuOpen(false);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => null);
    else void document.documentElement.requestFullscreen().catch(() => toast.warn('Tarayıcı tam ekrana izin vermedi'));
  };

  const items = POS_NAV.filter((n) => n.perms.some((p) => can(p)));
  const primary = items.filter((n) => n.primary).slice(0, 4);
  const rest = items.filter((n) => !primary.includes(n));
  const admin = isAdminArea(location.pathname);
  const fullBleed = admin || location.pathname.startsWith('/adisyon/') || location.pathname === '/mutfak';
  const lock = async () => {
    setMenuOpen(false);
    await logout();
    navigate('/giris');
  };
  const dark = document.documentElement.classList.contains('dark');

  const status = (
    <div className="flex items-center gap-2 text-xs">
      <span
        title={live === 'canli' ? 'Canlı bağlantı' : live === 'baglaniyor' ? 'Bağlanıyor' : 'Bağlantı koptu; yeniden deneniyor'}
        className={cn('inline-flex items-center gap-1 rounded-full px-2 py-1', live === 'canli' ? 'text-forest-500' : live === 'kopuk' ? 'bg-burgundy-100 text-burgundy-600' : 'text-muted')}
      >
        {live === 'kopuk' ? <WifiOff className="size-3.5" /> : <Wifi className="size-3.5" />}
      </span>
      {boot.day ? (
        <NavLink to="/kasa" title="Kasa ve gün sonu" className="inline-flex min-h-11 min-w-11 items-center justify-center pointer-fine:min-h-0 pointer-fine:min-w-0">
          <span className="rounded-full bg-forest-100 px-2 py-1 font-medium text-forest-700 dark:bg-forest-800 dark:text-forest-100">Z {boot.day.zNo}</span>
        </NavLink>
      ) : (
        <NavLink to="/kasa" title="Kasa ve gün sonu" className="inline-flex min-h-11 min-w-11 items-center justify-center pointer-fine:min-h-0 pointer-fine:min-w-0">
          <span className="rounded-full bg-brass-100 px-2 py-1 font-medium text-brass-700">Gün kapalı</span>
        </NavLink>
      )}
    </div>
  );

  return (
    <div className="flex h-full">
      {/* Tablet ve bilgisayar: sol menü */}
      <aside className={cn('hidden w-[84px] shrink-0 flex-col items-center border-r border-line bg-surface py-3', !admin && 'md:flex')}>
        <NavLink to="/" className="mb-3 grid size-12 place-items-center rounded-2xl bg-forest-700 text-cream" title="LafPOS">
          <span className="font-[Didot,'Bodoni_72',Georgia,serif] text-[15px] font-bold">L’Af</span>
        </NavLink>
        <nav className="scroll-thin flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto px-2">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'flex w-full flex-col items-center gap-1 rounded-2xl py-2.5 text-[11px] font-medium transition',
                  isActive ? 'bg-forest-700 text-cream' : 'text-ink-2 hover:bg-surface-2',
                )
              }
            >
              <n.icon className="size-5" />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-2 flex flex-col items-center gap-2">
          <button type="button" onClick={() => setPalette(true)} title="Ara ya da git (Ctrl K)" aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-2xl text-ink-2 hover:bg-surface-2">
            <Search className="size-5" />
          </button>
          <div className="tabular text-xs text-muted">{fmtTime(now)}</div>
          {status}
          <button onClick={() => setMenuOpen(true)} className="grid size-11 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: me.color }} title={me.name}>
            {me.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Telefon: üst şerit */}
        {!fullBleed && (
          <header className="flex items-center gap-2 border-b border-line bg-surface py-1 pl-4 pr-2 md:hidden">
            <span className="font-[Didot,'Bodoni_72',Georgia,serif] text-lg font-bold text-forest-700 dark:text-forest-300">L’Af</span>
            <span className="tabular text-sm text-muted">{fmtTime(now)}</span>
            <div className="flex-1" />
            <button type="button" onClick={() => setPalette(true)} aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-full text-ink-2">
              <Search className="size-5" />
            </button>
            {status}
            <button onClick={() => setMenuOpen(true)} aria-label={`${me.name} menüsü`} className="grid size-11 place-items-center">
              <span className="grid size-9 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: me.color }}>
                {me.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
              </span>
            </button>
          </header>
        )}
        <main className="min-h-0 flex-1 overflow-hidden">{children}</main>
        {/* Telefon: alt sekmeler */}
        <nav className="safe-bottom flex border-t border-line bg-surface md:hidden">
          {primary.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-forest-600 dark:text-forest-300' : 'text-muted')}
            >
              <n.icon className="size-5" />
              {n.label}
            </NavLink>
          ))}
          {rest.length > 0 && (
            <button onClick={() => setMoreOpen(true)} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted">
              <MoreHorizontal className="size-5" />
              Daha
            </button>
          )}
        </nav>
      </div>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Diğer ekranlar" size="sm">
        <div className="grid grid-cols-3 gap-2 p-4">
          {rest.map((n) => (
            <NavLink key={n.to} to={n.to} onClick={() => setMoreOpen(false)} className="flex flex-col items-center gap-2 rounded-2xl border border-line p-4 text-sm">
              <n.icon className="size-6 text-forest-600" />
              {n.label}
            </NavLink>
          ))}
        </div>
      </Modal>

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title={me.name} subtitle={boot.settings.businessName} size="sm">
        <div className="space-y-2 p-4">
          <button onClick={lock} className="flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left hover:bg-surface-2">
            <Lock className="size-5 text-forest-600" />
            <div>
              <div className="font-medium">Kilitle / kullanıcı değiştir</div>
              <div className="text-xs text-muted">Başka personel PIN'iyle devam etsin</div>
            </div>
          </button>
          <button
            onClick={() => setTheme(theme === 'koyu' || (theme === 'sistem' && dark) ? 'acik' : 'koyu')}
            className="flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left hover:bg-surface-2"
          >
            {dark ? <Sun className="size-5 text-brass-500" /> : <Moon className="size-5 text-forest-600" />}
            <div className="font-medium">{dark ? 'Açık tema' : 'Koyu tema'}</div>
          </button>
          {typeof document !== 'undefined' && document.fullscreenEnabled && (
            <button onClick={toggleFull} className="flex w-full items-center gap-3 rounded-2xl border border-line p-4 text-left hover:bg-surface-2">
              {full ? <Shrink className="size-5 text-forest-600" /> : <Expand className="size-5 text-forest-600" />}
              <div>
                <div className="font-medium">{full ? 'Tam ekrandan çık' : 'Tam ekran'}</div>
                <div className="text-xs text-muted">Kasa bilgisayarında kiosk başlatıcısı bunu kendisi yapar</div>
              </div>
            </button>
          )}
          <button onClick={lock} className="flex w-full items-center gap-3 rounded-2xl p-3 text-left text-sm text-muted hover:bg-surface-2">
            <LogOut className="size-4" /> Çıkış yap
          </button>
        </div>
      </Modal>
      <CommandPalette />
    </div>
  );
}
