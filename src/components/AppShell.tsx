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

  // Bağlantı ve gün durumu. 84 px'lik rayda alt alta (yan yana "Gün kapalı" taşar)
  const liveLabel = live === 'canli' ? 'Canlı bağlantı' : live === 'baglaniyor' ? 'Bağlanıyor' : 'Bağlantı koptu; yeniden deneniyor';
  const status = (rail = false) => (
    <div className={cn('flex items-center text-xs', rail ? 'flex-col gap-1.5' : 'gap-1')}>
      <span title={liveLabel} aria-label={liveLabel} className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-1', live === 'kopuk' ? 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]' : 'text-muted')}>
        {live === 'kopuk' ? <WifiOff className="size-3.5" /> : <span className={cn('size-2 rounded-full', live === 'canli' ? 'bg-success-600 dark:bg-success-300' : 'bg-warn-500')} />}
        {rail && live !== 'kopuk' && <Wifi className="size-3.5" />}
      </span>
      <NavLink to="/kasa" title="Kasa ve gün sonu" className="inline-flex min-h-11 min-w-11 items-center justify-center pointer-fine:min-h-0 pointer-fine:min-w-0">
        {boot.day ? (
          <span className="tabular rounded-md bg-surface-3 px-1.5 py-0.5 font-medium text-ink-2">Z {boot.day.zNo}</span>
        ) : (
          <span className={cn('rounded-md bg-[var(--admin-warning-soft)] px-1.5 py-0.5 font-medium text-[var(--admin-warning)]', rail && 'max-w-[68px] text-center leading-tight')}>Gün kapalı</span>
        )}
      </NavLink>
    </div>
  );
  const avatar = (size: 'sm' | 'md') => (
    <span className={cn('grid place-items-center rounded-full font-semibold text-white', size === 'md' ? 'size-9 text-xs' : 'size-8 text-[11px]')} style={{ background: me.color }}>
      {me.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
    </span>
  );
  const sheetRow = 'flex min-h-14 w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition hover:border-[var(--admin-border-field)] hover:bg-surface-2';
  const sheetIcon = 'grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 [&>svg]:size-[18px]';

  return (
    // Innex düzeni: gri zemin üstünde beyaz menü kartı; kasa ekranları zeminde kendi kartlarını çizer
    <div className={cn('flex h-full bg-bg', !admin && 'md:gap-2 md:p-2')}>
      {/* Tablet ve bilgisayar: ikon rayı (Innex'in daraltılmış kenar çubuğu, docs/ADMIN-INNEX.md §1.2) */}
      <aside className={cn('hidden w-[84px] shrink-0 flex-col items-center rounded-2xl border border-line bg-surface py-3', !admin && 'md:flex')}>
        <NavLink to="/" className="mb-3 grid size-11 place-items-center rounded-xl bg-night text-white dark:bg-surface-3" title="LafPOS">
          <span className="font-[Didot,'Bodoni_72',Georgia,serif] text-[14px] font-bold">L’Af</span>
        </NavLink>
        <nav className="scroll-thin flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto px-2">
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              className={({ isActive }) =>
                cn(
                  'flex w-full flex-col items-center gap-1 rounded-xl py-2 text-[11px] font-medium transition-colors',
                  isActive ? 'bg-surface-3 text-ink' : 'text-muted hover:bg-surface-2 hover:text-ink',
                )
              }
            >
              <n.icon className="size-5" strokeWidth={1.75} />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="mt-2 flex flex-col items-center gap-1.5 border-t border-[var(--admin-divider)] px-2 pt-2">
          <button type="button" onClick={() => setPalette(true)} title="Ara ya da git (Ctrl K)" aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-ink">
            <Search className="size-5" strokeWidth={1.75} />
          </button>
          <div className="tabular text-xs font-medium text-ink-2">{fmtTime(now)}</div>
          {status(true)}
          <button onClick={() => setMenuOpen(true)} className="grid size-11 place-items-center rounded-full" title={me.name} aria-label={`${me.name} menüsü`}>
            {avatar('md')}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Telefon: üst şerit */}
        {!fullBleed && (
          <header className="flex items-center gap-1 border-b border-line bg-surface py-1 pl-4 pr-1 md:hidden">
            <span className="font-[Didot,'Bodoni_72',Georgia,serif] text-lg font-bold text-ink">L’Af</span>
            <span className="tabular ml-1.5 text-sm text-muted">{fmtTime(now)}</span>
            <div className="flex-1" />
            <button type="button" onClick={() => setPalette(true)} aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-xl text-muted">
              <Search className="size-5" strokeWidth={1.75} />
            </button>
            {status()}
            <button onClick={() => setMenuOpen(true)} aria-label={`${me.name} menüsü`} className="grid size-11 place-items-center">
              {avatar('sm')}
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
              className={({ isActive }) => cn('flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium', isActive ? 'text-primary' : 'text-muted')}
            >
              <n.icon className="size-5" strokeWidth={1.75} />
              {n.label}
            </NavLink>
          ))}
          {rest.length > 0 && (
            <button onClick={() => setMoreOpen(true)} className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px] font-medium text-muted">
              <MoreHorizontal className="size-5" strokeWidth={1.75} />
              Daha
            </button>
          )}
        </nav>
      </div>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Diğer ekranlar" size="sm">
        <div className="grid grid-cols-3 gap-2 p-4">
          {rest.map((n) => (
            <NavLink key={n.to} to={n.to} onClick={() => setMoreOpen(false)} className="flex flex-col items-center gap-2 rounded-xl border border-line p-4 text-sm font-medium hover:bg-surface-2">
              <span className={sheetIcon}>
                <n.icon strokeWidth={1.75} />
              </span>
              {n.label}
            </NavLink>
          ))}
        </div>
      </Modal>

      <Modal open={menuOpen} onClose={() => setMenuOpen(false)} title={me.name} subtitle={boot.settings.businessName} size="sm">
        <div className="space-y-2 p-4">
          <button onClick={lock} className={sheetRow}>
            <span className={sheetIcon}>
              <Lock strokeWidth={1.75} />
            </span>
            <span>
              <span className="block text-sm font-medium">Kilitle / kullanıcı değiştir</span>
              <span className="block text-xs text-muted">Başka personel PIN'iyle devam etsin</span>
            </span>
          </button>
          <button onClick={() => setTheme(theme === 'koyu' || (theme === 'sistem' && dark) ? 'acik' : 'koyu')} className={sheetRow}>
            <span className={sheetIcon}>{dark ? <Sun strokeWidth={1.75} /> : <Moon strokeWidth={1.75} />}</span>
            <span className="text-sm font-medium">{dark ? 'Açık tema' : 'Koyu tema'}</span>
          </button>
          {typeof document !== 'undefined' && document.fullscreenEnabled && (
            <button onClick={toggleFull} className={sheetRow}>
              <span className={sheetIcon}>{full ? <Shrink strokeWidth={1.75} /> : <Expand strokeWidth={1.75} />}</span>
              <span>
                <span className="block text-sm font-medium">{full ? 'Tam ekrandan çık' : 'Tam ekran'}</span>
                <span className="block text-xs text-muted">Kasa bilgisayarında kiosk başlatıcısı bunu kendisi yapar</span>
              </span>
            </button>
          )}
          <button onClick={lock} className="flex min-h-11 w-full items-center gap-2 rounded-xl px-3 text-left text-sm text-muted hover:bg-surface-2 hover:text-ink">
            <LogOut className="size-4" /> Çıkış yap
          </button>
        </div>
      </Modal>
      <CommandPalette />
    </div>
  );
}
