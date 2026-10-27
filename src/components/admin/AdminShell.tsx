import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, Rows3, Rows4, Search } from 'lucide-react';
import { type ReactNode, useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { LafMark } from '@/components/LafMark';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLive } from '@/lib/live';
import { useHomePath } from '@/lib/serviceMode';
import { useShell } from '@/lib/shell';
import { ADMIN_GROUPS, type AdminSection, visibleSections } from './sections';
import { ROW_ICON } from './ui';

interface SyncStatus {
  /** `failing`: denenip gidemeyen günler (kuyruğa yeni giren gün sayaca girmez) */
  lafmaliyet: { configured: boolean; failing: number; lastError: string | null };
  menu: { state: { lastError?: string | null } | null };
  online: { soldOutPush: { pending: number; rejected: number } };
}

/** İş bekleyen yerlerin sayacı (Innex §3 fikir 1): tükenen ürün, gönderilemeyen gün */
function useCounts(): Partial<Record<AdminSection['key'], number>> {
  const boot = useBoot();
  const can = useCan();
  const sync = useQuery({ queryKey: ['sync', 'status'], queryFn: () => get<SyncStatus>('/sync/status'), staleTime: 60_000, enabled: can('senkron.yonet') || can('ayar.yonet') });
  const soldOut = boot.products.filter((p) => !p.active && !p.hidden).length;
  const failing = sync.data ? sync.data.lafmaliyet.failing + sync.data.online.soldOutPush.pending + sync.data.online.soldOutPush.rejected + (sync.data.menu.state?.lastError ? 1 : 0) : 0;
  return { menu: soldOut || undefined, entegrasyon: failing || undefined };
}

/**
 * Yönetim paneli kabuğu (Innex §1.1): gri zemin üstünde iki beyaz kart, solda gruplu kenar çubuğu, sağda
 * sayfa kartı (üstte yol ve arama). Tablette dar menü (yalnız ikon), telefonda kart yok: beyaz sayfa,
 * kendi üst çubuğu ve kasanın alt sekme çubuğu.
 */
export function AdminShell({ title, children }: { title: string; children: ReactNode }) {
  const can = useCan();
  const boot = useBoot();
  const me = useAuth((s) => s.me)!;
  const live = useLive((s) => s.status);
  const { rail, compact, toggleRail, toggleCompact, setPalette, setUserMenu } = useShell();
  const location = useLocation();
  const counts = useCounts();
  const home = useHomePath();
  const sections = visibleSections(can);
  const atIndex = location.pathname === '/yonetim' || location.pathname === '/yonetim/';

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.area = 'admin';
    return () => {
      delete root.dataset.area;
    };
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    if (compact) root.dataset.density = 'compact';
    else delete root.dataset.density;
  }, [compact]);

  const item = (s: AdminSection, narrow: boolean) => (
    <NavLink
      key={s.key}
      to={s.to}
      title={narrow ? s.label : undefined}
      aria-label={narrow ? s.label : undefined}
      className={({ isActive }) =>
        cn(
          'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors pointer-fine:min-h-8',
          narrow && 'mx-auto size-11 justify-center px-0 pointer-fine:size-10',
          isActive ? 'bg-[var(--admin-panel)] text-[var(--admin-text)]' : 'text-[var(--admin-text-soft)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-text)]',
        )
      }
    >
      <s.icon className="size-4 shrink-0" aria-hidden="true" />
      {!narrow && <span className="min-w-0 flex-1 truncate">{s.label}</span>}
      {!narrow && counts[s.key] != null && <span className="min-w-5 rounded-md bg-[var(--admin-panel)] px-1.5 text-center text-xs font-medium tabular-nums text-[var(--admin-text-soft)]">{counts[s.key]}</span>}
    </NavLink>
  );

  const sidebar = (narrow: boolean) => (
    <nav aria-label="Yönetim" className="flex h-full flex-col">
      <div className={cn('flex items-center gap-2.5 px-3 pb-3 pt-3.5', narrow && 'justify-center px-0')}>
        <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-night text-white dark:bg-surface-3">
          <LafMark className="h-3" bean="#e8c877" />
        </span>
        {!narrow && (
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-[var(--admin-text)]">{boot.settings.businessName}</span>
            <span className="block truncate text-xs text-[var(--admin-text-mute)]">{boot.day ? `Z ${boot.day.zNo} açık` : 'Gün kapalı'} · LafPOS</span>
          </span>
        )}
      </div>
      <div className={cn('scroll-thin min-h-0 flex-1 space-y-4 overflow-y-auto pb-3', narrow ? 'px-2' : 'px-2.5')}>
        {ADMIN_GROUPS.map((g) => {
          const list = sections.filter((s) => s.group === g.key);
          if (!list.length) return null;
          return (
            <div key={g.key}>
              {narrow ? <div className="mx-2 mb-1.5 border-t border-[var(--admin-border)]" /> : <div className="px-2.5 pb-1 text-[11px] font-medium uppercase tracking-[0.06em] text-[#606264] dark:text-[var(--admin-text-mute)]">{g.label}</div>}
              <div className="space-y-0.5">{list.map((s) => item(s, narrow))}</div>
            </div>
          );
        })}
      </div>
      <div className={cn('space-y-0.5 border-t border-[var(--admin-border)] py-2.5', narrow ? 'px-2' : 'px-2.5')}>
        <Link to={home} title={narrow ? 'Kasa ekranlarına dön' : undefined} aria-label={narrow ? 'Kasa ekranlarına dön' : undefined} className={cn('flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-[var(--admin-text-soft)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-text)] pointer-fine:min-h-8', narrow && 'mx-auto size-11 justify-center px-0 pointer-fine:size-10')}>
          <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
          {!narrow && 'Kasa ekranlarına dön'}
        </Link>
        <button type="button" onClick={toggleRail} title={rail ? 'Menüyü genişlet' : 'Menüyü daralt'} aria-label={rail ? 'Menüyü genişlet' : 'Menüyü daralt'} className={cn('hidden min-h-11 items-center gap-2.5 rounded-lg text-sm font-medium text-[var(--admin-text-soft)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-text)] pointer-fine:min-h-8 lg:flex', narrow ? 'mx-auto size-11 justify-center pointer-fine:size-10' : 'w-full px-2.5')}>
          {rail ? <PanelLeftOpen className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
          {!narrow && 'Menüyü daralt'}
        </button>
        <button type="button" onClick={() => setUserMenu(true)} aria-label={`${me.name} menüsü`} className={cn('mt-1 flex min-h-11 items-center gap-2.5 rounded-lg text-left hover:bg-[var(--admin-surface-2)]', narrow ? 'mx-auto size-11 justify-center' : 'w-full px-2')}>
          <span className="grid size-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold text-white" style={{ background: me.color }}>
            {me.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
          </span>
          {!narrow && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--admin-text)]">{me.name}</span>
              </span>
              <ChevronRight className="size-4 text-[var(--admin-text-mute)]" aria-hidden="true" />
            </>
          )}
        </button>
      </div>
    </nav>
  );

  const current = sections.find((s) => location.pathname.startsWith(s.to));
  return (
    <div className="flex h-full min-h-0 bg-[var(--admin-surface)] text-[var(--admin-text)] md:gap-3 md:bg-[var(--admin-bg)] md:p-2">
      <aside className={cn('hidden shrink-0 rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] md:block', rail ? 'md:w-16' : 'md:w-16 lg:w-[15.5rem]')}>
        <div className="h-full lg:hidden">{sidebar(true)}</div>
        <div className="hidden h-full lg:block">{sidebar(rail)}</div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col md:overflow-hidden md:rounded-xl md:border md:border-[var(--admin-border)] md:bg-[var(--admin-surface)]">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-[var(--admin-border)] px-2 sm:px-4">
          {!atIndex && (location.pathname.startsWith('/yonetim') || sections.length > 1) ? (
            <Link to="/yonetim" aria-label="Yönetim listesi" className={cn(ROW_ICON, 'md:hidden')}>
              <ChevronLeft className="size-5" />
            </Link>
          ) : null}
          <nav aria-label="Konum" className="min-w-0 flex-1 pl-1 md:pl-0">
            <ol className="flex min-w-0 items-center gap-1.5 text-sm">
              <li className="hidden text-[var(--admin-text-mute)] md:block">
                <Link to="/yonetim" className="inline-flex min-h-11 items-center hover:text-[var(--admin-text)] pointer-fine:min-h-0">
                  Yönetim
                </Link>
              </li>
              <li aria-hidden="true" className="hidden text-[var(--admin-text-mute)] md:block">
                /
              </li>
              <li className="truncate font-semibold md:font-medium">{current?.label ?? title}</li>
            </ol>
          </nav>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm text-[var(--admin-text-mute)] hover:bg-[var(--admin-surface-2)] md:w-64 md:border md:border-[var(--admin-border-strong)] md:bg-[var(--admin-surface)] md:pointer-fine:h-9"
            aria-label="Ara ya da git (Ctrl K)"
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden flex-1 text-left md:block">Ara ya da git…</span>
            <kbd className="hidden rounded border border-[var(--admin-border-strong)] px-1.5 font-sans text-[11px] md:block">⌘K</kbd>
          </button>
          <button
            type="button"
            onClick={toggleCompact}
            aria-pressed={compact}
            title={compact ? 'Ferah görünüm' : 'Sıkı görünüm'}
            aria-label={compact ? 'Ferah görünüm' : 'Sıkı görünüm'}
            className="hidden min-h-8 min-w-8 items-center justify-center rounded-md text-[var(--admin-text-mute)] hover:bg-[var(--admin-panel)] hover:text-[var(--admin-text)] pointer-fine:inline-flex"
          >
            {compact ? <Rows3 className="size-4" /> : <Rows4 className="size-4" />}
          </button>
          <span title={live === 'canli' ? 'Canlı bağlantı' : 'Bağlantı kopuk'} className={cn('hidden size-2 rounded-full sm:block', live === 'canli' ? 'bg-[var(--admin-success)]' : live === 'kopuk' ? 'bg-[var(--admin-danger)]' : 'bg-[var(--admin-warning)]')} />
          <button type="button" onClick={() => setUserMenu(true)} aria-label={`${me.name} menüsü`} className="grid size-11 shrink-0 place-items-center md:hidden">
            <span className="grid size-8 place-items-center rounded-full text-xs font-semibold text-white" style={{ background: me.color }}>
              {me.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
            </span>
          </button>
        </header>
        <div className="scroll-thin @container min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 pb-10 pt-5 sm:px-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
