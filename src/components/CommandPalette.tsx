import { useQuery } from '@tanstack/react-query';
import { Coffee, CornerDownLeft, Lock, Moon, Plus, Search, Sun, UserPlus, Users } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation, useNavigate } from 'react-router';
import { tl } from '@shared/money';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { trapTab } from '@/lib/focus';
import { navFor } from '@/lib/nav';
import { useServiceMode } from '@/lib/serviceMode';
import { fold, useShell } from '@/lib/shell';
import { resolveDark } from '@/lib/bootDark';
import { setBarTheme, useTheme } from '@/lib/theme';
import { confirmLeave } from '@/lib/unsavedGuard';
import { visibleSections } from './admin/sections';

interface Entry {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  keywords?: string;
  run: () => void;
}

/**
 * Komut paleti (⌘K / Ctrl K): ekranlara, yönetim bölümlerine, ürünlere ve personele atlar; sık eylemleri
 * çalıştırır. Innex tarifinin önerisi (§1.2 "üst çubukta ⌘K"); Türkçe harfleri katlayarak arar.
 */
export function CommandPalette() {
  const open = useShell((s) => s.paletteOpen);
  const setOpen = useShell((s) => s.setPalette);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLocaleLowerCase('en') === 'k') {
        e.preventDefault();
        setOpen(!useShell.getState().paletteOpen);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpen]);

  if (!open) return null;
  return createPortal(<Palette onClose={() => setOpen(false)} />, document.body);
}

function Palette({ onClose }: { onClose: () => void }) {
  const boot = useBoot();
  const can = useCan();
  const navigate = useNavigate();
  const logout = useAuth((s) => s.logout);
  const { theme, setTheme } = useTheme();
  const barDark = useTheme((s) => s.force === 'dark');
  const onBar = useLocation().pathname === '/mutfak';
  const mode = useServiceMode();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const dialog = useRef<HTMLDivElement>(null);
  /** Basış karartmada mı başladı: kapanış click'te (Modal gibi), aynı dokunuş alttaki öğeye düşmesin */
  const downOnBackdrop = useRef(false);
  const users = useQuery({ queryKey: ['users', 'admin'], queryFn: () => get<{ id: string; name: string; role: string; active: boolean }[]>('/admin/users'), enabled: can('personel.yonet'), staleTime: 60_000 });

  // Kapanınca odak açan öğeye döner (⌘K'ya basılan alan, sol menüdeki büyüteç)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus?.();
    };
  }, []);

  const go = (to: string) => async () => {
    onClose();
    // Ayarlarda kaydedilmemiş değişiklik varsa önce sorulur
    if (await confirmLeave()) navigate(to);
  };

  const entries = useMemo<Entry[]>(() => {
    const out: Entry[] = [];
    // Paletten her ekran bulunur (self serviste kullanılmayan Masalar da)
    for (const n of navFor(mode, { tablesInUse: true })) {
      if (n.to === '/yonetim' || !n.perms.some((p) => can(p))) continue;
      out.push({ id: `ekran:${n.to}`, group: 'Ekranlar', label: n.title, icon: <n.icon />, run: go(n.to) });
    }
    for (const s of visibleSections(can)) {
      if (out.some((e) => e.id === `ekran:${s.to}`)) continue;
      out.push({ id: `yonetim:${s.key}`, group: 'Yönetim', label: s.label, hint: s.desc, icon: <s.icon />, keywords: s.keywords, run: go(s.to) });
    }
    if (can('menu.yonet')) {
      out.push({ id: 'eylem:urun', group: 'Eylemler', label: 'Yerel ürün ekle', icon: <Plus />, keywords: 'yeni ürün', run: go('/yonetim/menu?urun=yeni') });
      for (const p of boot.products) {
        out.push({ id: `urun:${p.id}`, group: 'Ürünler', label: p.name, hint: `${tl(p.price)}${p.active ? '' : ' · tükendi'}`, icon: <Coffee />, run: go(`/yonetim/menu?urun=${p.id}`) });
      }
    }
    if (can('personel.yonet')) {
      out.push({ id: 'eylem:personel', group: 'Eylemler', label: 'Personel ekle', icon: <UserPlus />, keywords: 'yeni kullanıcı pin', run: go('/yonetim/personel?kisi=yeni') });
      for (const u of users.data ?? []) out.push({ id: `kisi:${u.id}`, group: 'Personel', label: u.name, hint: u.active ? undefined : 'kapalı', icon: <Users />, run: go(`/yonetim/personel?kisi=${u.id}`) });
    }
    // Bar ekranında eylem bu cihazın bar tercihini değiştirir (kullanıcı menüsündeki satır gibi); başka ekranda genel
    // temayı. Yön `.dark` sınıfından değil (bar zorlaması onu ezer) temanın kendisinden okunur: etiket ve sonuç aynı yönde
    const dark = onBar ? barDark : resolveDark(theme, null, window.matchMedia('(prefers-color-scheme: dark)').matches);
    out.push({
      id: 'eylem:tema',
      group: 'Eylemler',
      label: onBar ? (dark ? 'Bar ekranını açık yap' : 'Bar ekranını koyu yap') : dark ? 'Açık temaya geç' : 'Koyu temaya geç',
      icon: dark ? <Sun /> : <Moon />,
      keywords: 'tema gece gündüz bar ekranı',
      run: () => {
        onClose();
        if (onBar) setBarTheme(dark ? 'acik' : 'koyu');
        else setTheme(dark ? 'acik' : 'koyu');
      },
    });
    out.push({
      id: 'eylem:kilit',
      group: 'Eylemler',
      label: 'Kilitle ve kullanıcı değiştir',
      icon: <Lock />,
      keywords: 'çıkış oturum',
      run: async () => {
        onClose();
        // Kilitlemek sayfadan çıkmaktır: Ayarlarda kaydedilmemiş değişiklik varsa önce sorulur
        if (!(await confirmLeave())) return;
        await logout();
        navigate('/giris');
      },
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boot.products, users.data, theme, mode, onBar, barDark]);

  const results = useMemo(() => {
    const k = fold(q.trim());
    if (!k) return entries.filter((e) => e.group !== 'Ürünler' && e.group !== 'Personel');
    const words = k.split(/\s+/);
    return entries
      .map((e) => {
        const hay = fold(`${e.label} ${e.keywords ?? ''} ${e.group}`);
        if (!words.every((w) => hay.includes(w))) return null;
        const score = fold(e.label).startsWith(words[0]) ? 0 : 1;
        return { e, score };
      })
      .filter((x): x is { e: Entry; score: number } => !!x)
      .sort((a, b) => a.score - b.score)
      .slice(0, 40)
      .map((x) => x.e);
  }, [entries, q]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(results.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      results[active]?.run();
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div className="animate-fade fixed inset-0 z-[70] flex items-start justify-center bg-[var(--scrim-soft)] p-3 pt-[min(18vh,140px)]" onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Komut paleti"
        onKeyDown={(e) => trapTab(e, dialog.current)}
        className="animate-in flex max-h-[min(560px,80dvh)] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-line bg-surface shadow-[var(--shadow-pop)] dark:border-[var(--admin-border-strong)]"
      >
        <div className="flex items-center gap-2.5 border-b border-line px-4">
          <Search className="size-4 shrink-0 text-muted" aria-hidden="true" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Ekran, ürün ya da personel ara"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={results[active] ? `palette-${results[active].id}` : undefined}
            className="h-14 min-w-0 flex-1 bg-transparent text-[15px] text-ink outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-line px-1.5 text-[11px] text-muted pointer-coarse:hidden">Esc</kbd>
        </div>
        <ul ref={list} id="palette-list" role="listbox" className="scroll-thin min-h-0 flex-1 overflow-y-auto overscroll-contain p-1.5">
          {results.length === 0 && (
            <li role="presentation" className="px-3 py-8 text-center">
              <p className="text-sm font-medium text-ink">“{q}” için sonuç yok</p>
              <p className="mt-0.5 text-[13px] text-muted">Ekran, ürün ya da personel adının bir bölümünü yazın</p>
            </li>
          )}
          {results.map((r, i) => {
            const head = r.group !== lastGroup;
            lastGroup = r.group;
            return (
              <li key={r.id} role="presentation">
                {head && <div className="px-2.5 pb-1 pt-2.5 text-xs font-medium text-muted">{r.group}</div>}
                <div
                  id={`palette-${r.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  onPointerMove={() => setActive(i)}
                  onClick={() => r.run()}
                  className={cn('flex min-h-11 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-sm pointer-fine:min-h-10', i === active ? 'bg-surface-3 text-ink' : 'text-ink-2')}
                >
                  <span className="shrink-0 text-muted [&>svg]:size-4" aria-hidden="true">
                    {r.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-medium">{r.label}</span>
                  {r.hint && <span className="hidden max-w-[45%] truncate text-xs text-muted sm:block">{r.hint}</span>}
                  {i === active && <CornerDownLeft className="size-3.5 shrink-0 text-muted" aria-hidden="true" />}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

