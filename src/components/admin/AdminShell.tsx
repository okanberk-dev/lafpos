import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen, Rows4, Search, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link, NavLink, useLocation } from 'react-router';
import { LafTile } from '@/components/LafMark';
import { Avatar } from '@/components/ui/misc';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { topDialog, trapTab } from '@/lib/focus';
import { useMediaQuery } from '@/lib/hooks';
import { useLive } from '@/lib/live';
import { useHomePath } from '@/lib/serviceMode';
import { useShell } from '@/lib/shell';
import { ADMIN_GROUPS, type AdminSection, visibleSections } from './sections';
import { Badge, ROW_ICON } from './ui';

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
 * Sayacın ne saydığı, bölümün kendi sözüyle (dar menünün adı, sayacın ipucu): Ürünler'de tükenen ürün (Tükendi
 * sekmesinin sayısı), Site ve lafmaliyet'te gidemeyen gün ve Satışta bilgisi, menü hatası. Çıplak "N bekleyen" onay ya
 * da eşitleme bekleyen ürün gibi okunuyordu
 */
const COUNT_TEXT: Partial<Record<AdminSection['key'], (n: number) => string>> = {
  menu: (n) => `${n} ürün tükendi`,
  entegrasyon: (n) => `${n} sorun`,
};
const countText = (key: AdminSection['key'], n: number) => COUNT_TEXT[key]?.(n) ?? String(n);

/**
 * Tablette menünün tamamı (adlar ve sayaçlarla): dar ikon menüsündeki "Menüyü aç"la soldan açılır; dokunmatikte
 * ikonların ipucu görünmez, ad burada okunur. Kurallar hızlı bakış çekmecesiyle aynı: Escape (yalnız en üstteyken) ve
 * karartmaya dokunuş kapatır, Tab çekmecede döner, kapanınca odak açan düğmeye döner. Sayfa geçişinde kabuk kapatır
 */
function MenuDrawer({ onClose, children }: { onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  const downOnScrim = useRef(false);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    // Odak etkin bölüme (yoksa çekmeceye): klavyeyle açan kişi bulunduğu yerden devam eder
    (panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && topDialog() === panel.current) latest.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return createPortal(
    <div className="fixed inset-0 z-40">
      {/* Karartmaya dokunuş click'te kapatır (basış da karartmada başladıysa): alttaki sayfaya geçmez */}
      <div
        aria-hidden="true"
        className="animate-fade absolute inset-0 bg-[var(--scrim-soft)]"
        onPointerDown={(e) => {
          downOnScrim.current = e.target === e.currentTarget;
        }}
        onClick={(e) => {
          if (downOnScrim.current && e.target === e.currentTarget) onClose();
          downOnScrim.current = false;
        }}
      />
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-label="Yönetim menüsü"
        tabIndex={-1}
        onKeyDown={(e) => trapTab(e, panel.current)}
        className="animate-fade absolute inset-y-2 left-2 w-[15.5rem] overflow-hidden rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] shadow-[var(--shadow-pop)] outline-none dark:border-[var(--admin-border-strong)]"
      >
        {children}
      </div>
    </div>,
    document.body,
  );
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
  const mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  const searchKey = mac ? '⌘K' : 'Ctrl K';
  // Tablette açılan tam menü: sayfa geçişinde ve bilgisayar genişliğinde (kenar çubuğu zaten tam) kapanır
  const [drawer, setDrawer] = useState(false);
  const desktop = useMediaQuery('(min-width: 1024px)');
  useEffect(() => {
    setDrawer(false);
  }, [location.pathname, desktop]);

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

  const item = (s: AdminSection, narrow: boolean) => {
    const count = counts[s.key];
    const counted = count ? countText(s.key, count) : null;
    // Dar menüde yazı yok: ad ve sayacın ne saydığı ekran okuyucuya ve ipucuna (aynı metin: ad açıklama diye yinelenmez)
    const name = counted ? `${s.label}, ${counted}` : s.label;
    return (
      <NavLink
        key={s.key}
        to={s.to}
        title={narrow ? name : undefined}
        aria-label={narrow ? name : undefined}
        className={({ isActive }) =>
          cn(
            'flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium transition-colors pointer-fine:min-h-8',
            narrow && 'relative mx-auto size-11 justify-center px-0 pointer-fine:size-10',
            // Kurumsal yüzey: etkin öğe dolgu kapsül değil, 2 px yeşil sol çizgi ve kalın yazı
            isActive
              ? 'relative font-semibold text-[var(--admin-text)] before:absolute before:inset-y-1.5 before:left-0 before:w-0.5 before:bg-[var(--admin-primary)]'
              : 'text-[var(--admin-text-soft)] hover:bg-hover hover:text-[var(--admin-text)] active:bg-press',
          )
        }
      >
        <s.icon className="size-4 shrink-0" aria-hidden="true" />
        {/* Geniş menüde rakam hapta gözle okunur; ne saydığı adın parçası olarak ekran okuyucuya ("Ürünler 3" değil) */}
        {!narrow && (
          <span className="min-w-0 flex-1 truncate">
            {s.label}
            {counted && <span className="sr-only">, {counted}</span>}
          </span>
        )}
        {count != null &&
          (narrow ? (
            // Dar menüde de iş bekleyen yer görünür: ikonun köşesinde nötr sayaç (renk değil, sayı)
            <span aria-hidden="true" className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-[var(--admin-text)] px-1 text-[11px] font-semibold leading-none tabular-nums text-[var(--admin-surface)]">
              {count}
            </span>
          ) : (
            // Sayaç gri hapta (etkin satır dolgusuz, yalnız yeşil sol çizgi); ipucu ne saydığını söyler
            <span aria-hidden="true" title={counted ?? undefined} className="min-w-5 rounded-[var(--r-chip)] bg-[var(--admin-panel)] px-2 text-center text-xs font-medium tabular-nums text-[var(--admin-text-soft)] [[aria-current=page]_&]:text-[var(--admin-text)]">
              {count}
            </span>
          ))}
      </NavLink>
    );
  };

  /** Menünün sağ üstteki düğmesi: bilgisayarda daralt / genişlet, tablette tam menüyü aç, çekmecede kapat */
  const panelToggle = (label: string, opens: boolean, onClick: () => void) => (
    <button type="button" onClick={onClick} title={label} aria-label={label} className={cn(ROW_ICON, 'shrink-0')}>
      {opens ? <PanelLeftOpen className="size-4" aria-hidden="true" /> : <PanelLeftClose className="size-4" aria-hidden="true" />}
    </button>
  );

  const sidebar = (narrow: boolean, toggle: ReactNode) => (
    <nav aria-label="Yönetim" className="flex h-full flex-col">
      <div className={cn('flex items-center gap-2.5 px-3 pb-2.5 pt-3.5', narrow && 'flex-col justify-center gap-1.5 px-0')}>
        <LafTile size="sm" />
        {!narrow && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold text-[var(--admin-text)]">{boot.settings.businessName}</span>
            <span className="block truncate text-xs text-[var(--admin-text-mute)]">{boot.day ? `Z ${boot.day.zNo} açık` : 'Gün kapalı'} · LafPOS</span>
          </span>
        )}
        {toggle}
      </div>
      <div className={cn('scroll-thin min-h-0 flex-1 space-y-3 overflow-y-auto pb-5 [mask-image:linear-gradient(to_bottom,black_calc(100%-20px),transparent)]', narrow ? 'px-2' : 'px-2.5')}>
        {ADMIN_GROUPS.filter((g) => sections.some((s) => s.group === g.key)).map((g, gi) => {
          const list = sections.filter((s) => s.group === g.key);
          return (
            // Gruplar arasında ince ayraç (geniş menüde ilk grup hariç)
            <div key={g.key} className={cn(!narrow && gi > 0 && 'border-t border-[var(--admin-border)] pt-3')}>
              {narrow ? <div className="mx-2 mb-1.5 border-t border-[var(--admin-border)]" /> : <div className="px-2.5 pb-0.5 text-[11px] font-medium uppercase leading-4 tracking-[0.06em] text-[var(--admin-text-mute)]">{g.label}</div>}
              <div className="space-y-0.5">{list.map((s) => item(s, narrow))}</div>
            </div>
          );
        })}
      </div>
      <div className={cn('space-y-0.5 border-t border-[var(--admin-border)] py-2', narrow ? 'px-2' : 'px-2.5')}>
        <Link to={home} title={narrow ? 'Kasa ekranlarına dön' : undefined} aria-label={narrow ? 'Kasa ekranlarına dön' : undefined} className={cn('flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-sm font-medium text-[var(--admin-text-soft)] transition-colors hover:bg-hover hover:text-[var(--admin-text)] active:bg-press pointer-fine:min-h-8', narrow && 'mx-auto size-11 justify-center px-0 pointer-fine:size-10')}>
          <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
          {!narrow && 'Kasa ekranlarına dön'}
        </Link>
        <button
          type="button"
          // Çekmeceden açılırsa çekmece kapanır: kullanıcı menüsü onun arkasında kalmasın
          onClick={() => {
            setDrawer(false);
            setUserMenu(true);
          }}
          aria-label={`${me.name} menüsü`}
          className={cn('flex min-h-11 items-center gap-2.5 rounded-lg text-left transition-colors hover:bg-hover active:bg-press', narrow ? 'mx-auto size-11 justify-center' : 'w-full px-2 pointer-fine:min-h-9')}
        >
          <Avatar name={me.name} color={me.color} className="size-7 text-[11px]" />
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
  const back = !atIndex && (location.pathname.startsWith('/yonetim') || sections.length > 1);
  return (
    // Kurumsal yüzey (index.css .surface-corporate): yönetim ve raporlar küçük köşe, gölgesiz ince çizgi
    <div className="surface-corporate flex h-full min-h-0 bg-[var(--admin-surface)] text-[var(--admin-text)] md:gap-3 md:bg-[var(--admin-bg)] md:p-2">
      <aside className={cn('hidden shrink-0 rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface)] md:block', rail ? 'md:w-16' : 'md:w-16 lg:w-[15.5rem]')}>
        {/* Tablette dar ikon menüsü (daraltma yok); üstteki düğme adlı tam menüyü çekmecede açar */}
        <div className="h-full lg:hidden">{sidebar(true, panelToggle('Menüyü aç', true, () => setDrawer(true)))}</div>
        <div className="hidden h-full lg:block">{sidebar(rail, panelToggle(rail ? 'Menüyü genişlet' : 'Menüyü daralt', rail, toggleRail))}</div>
      </aside>
      {drawer && !desktop && <MenuDrawer onClose={() => setDrawer(false)}>{sidebar(false, panelToggle('Menüyü kapat', false, () => setDrawer(false)))}</MenuDrawer>}
      <div className="flex min-w-0 flex-1 flex-col md:overflow-hidden md:rounded-xl md:border md:border-[var(--admin-border)] md:bg-[var(--admin-surface)]">
        {/* Telefonda (ana ekrandan açılınca) çentik ve saat başlığın üstünde kalır */}
        <header className="flex min-h-14 shrink-0 items-center gap-2 border-b border-[var(--admin-border)] px-2 max-md:pt-[env(safe-area-inset-top)] sm:px-4">
          {back ? (
            <Link to="/yonetim" aria-label="Yönetim listesi" className={cn(ROW_ICON, 'md:hidden')}>
              <ChevronLeft className="size-5" />
            </Link>
          ) : null}
          {/* Geri düğmesi yokken başlık içerikle aynı çizgide başlar (telefonda 16 px) */}
          <nav aria-label="Konum" className={cn('min-w-0 flex-1 md:pl-0', back ? 'pl-1' : 'pl-2 sm:pl-1')}>
            <ol className="flex min-w-0 items-center gap-1.5 text-sm">
              <li className="hidden text-[var(--admin-text-mute)] md:block">
                <Link to="/yonetim" className="inline-flex min-h-11 items-center hover:text-[var(--admin-text)] pointer-fine:min-h-0">
                  Yönetim
                </Link>
              </li>
              <li aria-hidden="true" className="hidden text-[var(--admin-text-mute)] md:block">
                /
              </li>
              <li className="truncate text-base font-semibold md:text-sm md:font-medium">{current?.label ?? title}</li>
            </ol>
          </nav>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="inline-flex h-11 min-w-11 items-center justify-center gap-2 rounded-lg px-3 text-sm text-[var(--admin-text-mute)] transition-colors hover:bg-hover hover:text-[var(--admin-text)] md:w-64 md:border md:border-[var(--admin-border-strong)] md:bg-[var(--admin-surface)] md:hover:border-[var(--admin-border-field)] md:pointer-fine:h-9"
            aria-label={`Ara ya da git (${searchKey})`}
          >
            <Search className="size-4 shrink-0" aria-hidden="true" />
            <span className="hidden flex-1 text-left md:block">Ara ya da git…</span>
            {/* Kısayol yalnız klavyeli cihazda: dokunmatik tablette basılamayacak bir ipucu gürültü olur */}
            <kbd className="hidden rounded border border-[var(--admin-border)] bg-[var(--admin-surface-2)] px-1.5 py-px font-sans text-xs text-[var(--admin-text-mute)] md:pointer-fine:block">{searchKey}</kbd>
          </button>
          {/* Aç-kapa düğmesi: adı sabit, durumu aria-pressed ve gri zemin söyler (ad durumla değişseydi "Ferah görünüm,
              basılı" ters okunurdu); yalnız fareyle etkili, dokunmatikte hedefler 44 px kalır */}
          <button
            type="button"
            onClick={toggleCompact}
            aria-pressed={compact}
            aria-label="Sıkı görünüm"
            title={compact ? 'Sıkı görünüm açık' : 'Sıkı görünüm'}
            className={cn(ROW_ICON, 'hidden pointer-fine:inline-flex', compact && 'bg-[var(--admin-panel)] text-[var(--admin-text)]')}
          >
            <Rows4 className="size-4" aria-hidden="true" />
          </button>
          {/* Canlı bağlantı: sağlıklıyken sakin nokta (telefonda yalnız ekran okuyucuya); kopunca her genişlikte yazıyla
              söylenir (renk tek başına durum taşımaz). Telefonda kasanın üst şeridi yok: işaret burada */}
          <span role="status" aria-live="polite" className="inline-flex shrink-0">
            {live === 'kopuk' ? (
              <Badge tone="danger" title="Canlı güncellemeler gelmiyor; bağlantı gelince kendiliğinden yenilenir">
                <WifiOff aria-hidden="true" className="size-3" />
                Kopuk
              </Badge>
            ) : (
              <span title={live === 'canli' ? 'Canlı bağlantı' : 'Bağlanıyor…'} className={cn('size-2 rounded-full max-sm:sr-only', live === 'canli' ? 'bg-[var(--admin-success)]' : 'bg-[var(--admin-warning)]')}>
                <span className="sr-only">{live === 'canli' ? 'Canlı bağlantı' : 'Bağlanıyor…'}</span>
              </span>
            )}
          </span>
          <button type="button" onClick={() => setUserMenu(true)} aria-label={`${me.name} menüsü`} className="grid size-11 shrink-0 place-items-center md:hidden">
            <Avatar name={me.name} color={me.color} />
          </button>
        </header>
        <div className="scroll-thin @container min-h-0 flex-1 overflow-y-auto">
          <div className="px-4 pb-10 pt-5 sm:px-5">{children}</div>
        </div>
      </div>
    </div>
  );
}
