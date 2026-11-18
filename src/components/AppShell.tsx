import { Expand, Lock, LogOut, MoreHorizontal, Search, Shrink, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS } from '@shared/permissions';
import { fmtTime } from '@shared/time';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { DEMO } from '@/lib/demo';
import { useLive } from '@/lib/live';
import { EXTRA_TITLES, isAdminArea, navAlias, navAriaLabel, type NavItem, phoneTabs, useNavOrigin, visibleNav } from '@/lib/nav';
import { useServiceMode, useTablesInUse } from '@/lib/serviceMode';
import { useShell } from '@/lib/shell';
import { confirmLeave } from '@/lib/unsavedGuard';
import { type KdsTheme, setBarTheme, useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { useReadyAlerts } from '@/lib/readyAlert';
import { useWakeLock } from '@/lib/wakelock';
import { CommandPalette } from './CommandPalette';
import { LafTile } from './LafMark';
import { PlatformInbox } from './PlatformInbox';
import { DrawerArrow, DrawerGroup, DrawerLabel, drawerRow, ToolsDrawer } from './ToolsDrawer';
import { Segmented } from './ui/Field';
import { Avatar, Badge } from './ui/misc';
import { REMOTE, REMOTE_PATHS, useRemoteSignOut } from '@/lib/remote';

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

/**
 * Üst çubuktaki ekranlar: sığdığı kadarı çubukta, gerisi Araçlar çekmecesinde (kitte üst menüde 2-3 sayfa, gerisi
 * Tools). Genişlik görünmez ölçü kopyasından okunur; çubuk ya da yazı (yazı tipi geç yüklenince) boyut değiştirince
 * yeniden hesaplanır. Etkin ekran sığmayanlardaysa son görünen yerin yerine geçer (nerede olduğu hep görünür)
 */
function useNavFit(count: number) {
  const nav = useRef<HTMLElement>(null);
  const measure = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState(count);
  useLayoutEffect(() => {
    const n = nav.current;
    const m = measure.current;
    if (!n || !m) return;
    const calc = () => {
      const avail = n.clientWidth;
      if (!avail) return;
      let used = 0;
      let k = 0;
      for (const c of m.children) {
        const w = (c as HTMLElement).offsetWidth + (k ? 4 : 0);
        if (used + w > avail) break;
        used += w;
        k++;
      }
      setFit(k);
    };
    calc();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(calc);
    ro.observe(n);
    ro.observe(m);
    return () => ro.disconnect();
  }, [count]);
  return [nav, measure, fit] as const;
}

/** Üst çubuktaki ekran bağlantısı (kitin .mainnav'ı): düz yazı, seçilinin altında mürekkep çizgi, üstüne gelince soldan çizilir */
/*
 * Üst çubuğun sekmesi (18 Kasım 2026, operatör: "yukarıdaki menüyü daha minimalist"; shadcn/ui ve Untitled UI'ın sekme
 * düzeni): Poppins 14 px, kenarsız; üstüne gelince çok açık gri, seçili olan yan menüyle aynı açık nane hapta yeşil ve kalın
 */
const NAV_LINK =
  'relative inline-flex h-9 items-center rounded-full px-3 text-sm font-medium text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:h-11 pointer-coarse:px-3.5';
const NAV_ON = 'bg-[var(--menu-active-bg)] font-semibold text-[var(--menu-active-ink)] hover:bg-[var(--menu-active-bg)] hover:text-[var(--menu-active-ink)]';
/** Çubukta kısaltma yok: kısa ad noktayla bitiyorsa ("Rezerv.") tam ad */
const navText = (n: NavItem) => (n.label.endsWith('.') ? n.title : n.label);

const AVATAR = { xs: 'size-7 text-[11px]', sm: 'size-8 text-[11px]', md: 'size-9 text-xs' } as const;

/**
 * Kasa ekranlarının kabuğu. `notice`: ekranın üstünde, sayfanın dışında duran şerit (uzaktan görünümün demo notu);
 * sayfa `main`'in tam yüksekliğini kullandığı için içeride dursa sayfanın altını keserdi.
 */
export function AppShell({ children, notice }: { children: ReactNode; notice?: ReactNode }) {
  const boot = useBoot();
  const can = useCan();
  const me = useAuth((s) => s.me)!;
  const logout = useAuth((s) => s.logout);
  const live = useLive((s) => s.status);
  const { theme, setTheme } = useTheme();
  const barDark = useTheme((s) => s.force === 'dark');
  const navigate = useNavigate();
  const location = useLocation();
  const now = useClock();
  const menuOpen = useShell((s) => s.userMenuOpen);
  const setMenuOpen = useShell((s) => s.setUserMenu);
  const setPalette = useShell((s) => s.setPalette);
  const [moreOpen, setMoreOpen] = useState(false);
  // Ekran değişince gezinme sayfaları kapanır: kaydedilmemiş değişiklik koruması bağlantının tıklamasını yakalayıp
  // onaydan sonra kendisi gezdiğinde bağlantının onClick'i (sayfayı kapat) çalışmamış olur
  useEffect(() => {
    setMoreOpen(false);
    setMenuOpen(false);
  }, [location.pathname, setMenuOpen]);
  useAutoLock(boot.settings.autoLockMinutes);
  useWakeLock(boot.settings.keepAwake);
  useReadyAlerts();
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

  // Servis moduna göre menü: self modlarda "Satış" başta, Masalar ikinci planda (shared/service-mode.ts)
  const mode = useServiceMode();
  const tablesInUse = useTablesInUse(mode);
  const items = visibleNav(can, mode, { tablesInUse }).filter((n) => !REMOTE || REMOTE_PATHS.includes(n.to));
  const { tabs, more } = phoneTabs(items);
  const [railNav, measure, fit] = useNavFit(items.length);
  const isAt = (to: string) => location.pathname === to || location.pathname.startsWith(`${to}/`);
  // Menüde olmayan ekranın menüdeki yeri (navAlias): adisyon açıkken geldiği ekran (Masalar, Tezgâh satışı ya da
  // Siparişler), Eğitim cihazında Kasa etkin görünür. Yalnız görünüm: aria-current'ı NavLink verir, yalnız adresin ekranına
  const origin = useNavOrigin((s) => s.to);
  const alias = navAlias(location.pathname, origin);
  const on = (to: string, isActive: boolean) => isActive || to === alias;
  // Sığan ekranlar üst çubukta; etkin ekran sığmayanlardaysa son görünen yere o geçer
  const activeIndex = items.findIndex((n) => isAt(n.to) || n.to === alias);
  const shown = activeIndex >= fit && fit > 0 ? [...items.slice(0, fit - 1), items[activeIndex]] : items.slice(0, fit);
  const hidden = items.filter((n) => !shown.includes(n));
  // Telefon üst şeridinde saat yerine ekranın adı (saat rayda ve kilit ekranında); "Daha"daki ekrandaysa Daha etkin
  const current = items.find((n) => isAt(n.to));
  const moreHere = more.some((n) => isAt(n.to));
  const moreActive = moreHere || more.some((n) => n.to === alias);
  const admin = isAdminArea(location.pathname);
  const fullBleed = admin || location.pathname.startsWith('/adisyon/') || location.pathname === '/mutfak';
  // Üst şeridi olmayan ekranda (adisyon, bar ekranı) kişinin menüsü alt sekmede: tek ekranlı rol (Bar) de telefonda
  // kilitleyip oturumu kapatabilsin. Tek sekmelik çubuk çizilmez (kuryenin tek ekranı; menüsü üst şeritte)
  const meTab = !admin && fullBleed && tabs.length + (more.length ? 1 : 0) < 5;
  const showTabs = tabs.length > 1 || meTab;
  const lock = async () => {
    setMenuOpen(false);
    // Kilitlemek sayfadan çıkmaktır: Ayarlarda kaydedilmemiş değişiklik varsa önce sorulur (otomatik kilit sormaz)
    if (!(await confirmLeave())) return;
    await logout();
    navigate('/giris');
  };
  // Bar ekranı kendi tercihinde (cihazda, varsayılan koyu) açılır; orada tema satırı o tercihi değiştirir
  const onBar = location.pathname === '/mutfak';

  // Bağlantı: canlıyken yeşil nokta; koptuğunda yazıyla (dokunmatikte ipucu görünmez, yalnız ikon süs gibi okunurdu)
  const liveLabel = live === 'canli' ? 'Canlı bağlantı' : live === 'baglaniyor' ? 'Bağlanıyor…' : 'Bağlantı koptu; yeniden deneniyor';
  const conn = (
    <span
      role="status"
      title={liveLabel}
      aria-label={liveLabel}
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1 whitespace-nowrap rounded-full',
        live === 'kopuk' ? 'bg-danger-soft px-1.5 font-medium text-danger-ink ring-1 ring-inset ring-danger-line' : 'px-1.5',
      )}
    >
      {live === 'kopuk' ? (
        <>
          <WifiOff aria-hidden="true" className="size-3.5" />
          Koptu
        </>
      ) : (
        <span aria-hidden="true" className={cn('size-2.5 rounded-full', live === 'canli' ? 'bg-[var(--admin-success)]' : 'bg-[var(--admin-warning)]')} />
      )}
    </span>
  );
  const dayText = boot.day ? `Z ${boot.day.zNo}` : 'Gün kapalı';
  // Gün: kasaya girebilene Z no (dokununca kasa); giremeyene yalnız gün kapalıyken, dokunulmaz bir durum olarak
  const canKasa = (['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor'] as const).some((p) => can(p));
  const closed = (
    <Badge tone="warning" className="gap-1 px-2">
      <Lock aria-hidden="true" className="size-3 stroke-2" />
      Kapalı
    </Badge>
  );
  const day = canKasa ? (
    <NavLink to="/kasa" title={boot.day ? 'Kasa ve gün sonu' : 'Gün kapalı; kasada açılır'} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full pointer-fine:min-h-0 pointer-fine:min-w-0">
      {boot.day ? <Badge className="tabular">Z {boot.day.zNo}</Badge> : closed}
    </NavLink>
  ) : (
    !boot.day && (
      <span title="Gün kapalı" className="inline-flex">
        {closed}
      </span>
    )
  );
  // Telefonun üst şeridinde bağlantı ve gün yan yana, saatsiz
  const status = () => {
    if (REMOTE) {
      return (
        <Badge tone="blue" title="Kafeden gelen canlı özet; 10 sn’de bir yenilenir">
          Uzaktan
        </Badge>
      );
    }
    return (
      <div className="flex items-center gap-1 text-xs">
        {conn}
        {day}
      </div>
    );
  };
  /**
   * Durum hapı (kitin .health'i): nokta bağlantıyı söyler (canlı yeşil ve halkalı, bağlanıyor amber), yanında saat ve
   * gün; kopunca kırmızı dolgu ve yazı. Kasaya girebilene dokununca kasa (Z no), giremeyene yalnız durum
   */
  const healthText = REMOTE ? `Uzaktan · ${fmtTime(now)}` : live === 'kopuk' ? 'Bağlantı koptu' : `${fmtTime(now)} · ${dayText}`;
  const healthCls = cn(
    // Sakin durumda kenarsız metin (saat ve Z); kopukta kırmızı, gün kapalıyken amber hap: yalnız dikkat isteyen durum dolu
    'hidden h-9 shrink-0 items-center gap-2 whitespace-nowrap rounded-full px-3 text-[13px] font-medium pointer-coarse:h-11 lg:inline-flex',
    live === 'kopuk' && !REMOTE ? 'bg-[var(--admin-danger)] text-white' : 'text-ink-2',
    !boot.day && !REMOTE && live !== 'kopuk' && 'bg-warning-soft text-warning-ink',
  );
  const healthCalm = live !== 'kopuk' && !!boot.day;
  const healthDot = REMOTE ? (
    <span aria-hidden="true" className="size-2 rounded-full bg-[var(--admin-blue)]" />
  ) : live === 'kopuk' ? (
    <WifiOff aria-hidden="true" className="size-3.5" />
  ) : (
    <span aria-hidden="true" className={cn('size-2 rounded-full', live === 'canli' ? 'bg-[var(--admin-success)] shadow-[0_0_0_4px_var(--admin-success-soft)]' : 'bg-[var(--admin-warning)]')} />
  );
  const healthPill =
    canKasa && !REMOTE ? (
      <NavLink to="/kasa" title={boot.day ? `Kasa ve gün sonu · ${liveLabel}` : `Gün kapalı; kasada açılır · ${liveLabel}`} aria-label={`${liveLabel}, ${boot.day ? `Z ${boot.day.zNo} açık` : 'gün kapalı'}; kasa ve gün sonu`} className={cn(healthCls, 'transition-[color,background-color,filter] duration-150', healthCalm ? 'hover:bg-hover hover:text-ink' : 'hover:brightness-95')}>
        {healthDot}
        <span className="tabular">{healthText}</span>
      </NavLink>
    ) : (
      <span role="status" title={liveLabel} className={healthCls}>
        {healthDot}
        <span className="tabular">{healthText}</span>
        <span className="sr-only">, {liveLabel}</span>
      </span>
    );
  // Kitin avatarı (personel ve giriş ekranıyla tek): ince iç halka, açık kişi renginde koyu harf. Ad düğmenin etiketinde
  const avatar = (size: keyof typeof AVATAR) => <Avatar name={me.name} color={me.color} className={AVATAR[size]} />;
  // Alt sekme: ikon hapın içinde; etkin sekme yan menüyle aynı açık nane hapta yeşil ikonla ve kalın yazıyla
  const tab = (on: boolean) => cn('group flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-150', on ? 'font-semibold text-ink' : 'font-medium text-muted');
  const tabPill = (on: boolean) => cn('grid h-7 w-14 place-items-center rounded-full transition-colors duration-150', on ? 'bg-[var(--menu-active-bg)] text-[var(--menu-active-ink)]' : 'group-active:bg-press');
  // Menünün başlığı kişi: adı ve rolü (tek şubeli kasada işletmenin adı bilgi taşımaz)
  const roleLabel = ROLE_LABELS[me.role];
  const menuSubtitle = REMOTE ? 'Yalnız görüntüleme' : (roleLabel !== me.name ? roleLabel : undefined);
  // Uzaktan giriş ekranı parola sormadan giriyorsa (demo ya da parolasız görünüm) çıkış aynı oturumu yeniden açar: satır yok
  const remoteSignOut = useRemoteSignOut();

  // Araçlar çekmecesi kişinin menüsüdür de: telefonda avatar, "Daha" sekmesi ve geniş ekranda Araçlar düğmesi açar
  const toolsOpen = menuOpen || moreOpen;
  const closeTools = () => {
    setMenuOpen(false);
    setMoreOpen(false);
  };
  const drawerRows = items.map((n, i) => (
    <NavLink
      key={n.to}
      to={n.to}
      onClick={closeTools}
      aria-label={navAriaLabel(n)}
      aria-current={on(n.to, isAt(n.to)) ? 'page' : undefined}
      style={{ animationDelay: `${120 + i * 35}ms` }}
      className={cn(drawerRow, on(n.to, isAt(n.to)) && 'text-[var(--band-accent)]')}
    >
      <DrawerLabel>{n.title}</DrawerLabel>
      <DrawerArrow />
    </NavLink>
  ));
  const themeRow = (
    // Tema: üç seçenek (Cihaz bir dokunuşta kaybolmasın); bar ekranında bu cihazın bar tercihi
    <div className={cn(drawerRow, 'flex-wrap gap-y-2 hover:pl-0.5')} style={{ animationDelay: `${120 + items.length * 35}ms` }}>
      <DrawerLabel hint={onBar ? 'Bu cihazda saklanır' : undefined}>{onBar ? 'Bar teması' : 'Tema'}</DrawerLabel>
      <span className="[--admin-surface:var(--band-2)] [--admin-border-strong:var(--band-line)] [--admin-ink-fill:var(--band-text)] [--admin-on-ink:var(--band)] [--admin-text:var(--band-text)] [--admin-text-soft:var(--band-muted)] [--hover:rgb(255_255_255/0.08)]">
        {onBar ? (
          <Segmented<KdsTheme>
            label="Bar ekranı teması"
            value={barDark ? 'koyu' : 'acik'}
            onChange={setBarTheme}
            options={[
              { value: 'acik', label: 'Açık' },
              { value: 'koyu', label: 'Koyu' },
            ]}
          />
        ) : (
          <Segmented<typeof theme>
            label="Tema"
            value={theme}
            onChange={setTheme}
            options={[
              { value: 'acik', label: 'Açık' },
              { value: 'koyu', label: 'Koyu' },
              { value: 'sistem', label: 'Cihaz' },
            ]}
          />
        )}
      </span>
    </div>
  );

  return (
    // Kitin kabuğu: üstte buzlu çubuk (marka, ana ekranlar, durum, Araçlar), altında ekranın sahnesi. Telefonda üst şerit
    // ve alt sekme çubuğu. Yatay telefonda çentik yanlarda: kök kapsayıcı yan güvenli alanı bırakır
    <div className="flex h-full flex-col bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Tablet ve bilgisayar: üst çubuk (kitin .rail'i) */}
      <header className="relative z-30 hidden h-14 shrink-0 items-center gap-3 px-3 md:flex lg:gap-4">
        <NavLink to="/" title="L'Affogato · LafPOS" aria-label="Ana ekran" className="flex shrink-0 items-center gap-2.5 rounded-[10px]">
          <LafTile size="md" />
          <span className="hidden flex-col leading-none xl:flex">
            <span className="font-headline text-[17px] font-bold tracking-[-0.03em]">L’Affogato</span>
            <span className="mt-1 text-[11.5px] text-muted">LafPOS · {roleLabel}</span>
          </span>
        </NavLink>
        <nav ref={railNav} aria-label="Ekranlar" className="relative ml-1 flex min-w-0 flex-1 items-center gap-1 overflow-hidden lg:ml-3">
          {/* Ölçü kopyası: bağlantıların genişliği buradan okunur, sığmayanlar Araçlar'da (görünmez, okunmaz) */}
          <span ref={measure} aria-hidden="true" className="pointer-events-none invisible absolute left-0 top-0 flex gap-1 whitespace-nowrap">
            {items.map((n) => (
              <span key={n.to} className={NAV_LINK}>
                {navText(n)}
              </span>
            ))}
          </span>
          {shown.map((n) => (
            <NavLink key={n.to} to={n.to} title={n.title} aria-label={navText(n) === n.label ? navAriaLabel(n) : undefined} className={({ isActive }) => cn(NAV_LINK, 'shrink-0', on(n.to, isActive) && NAV_ON)}>
              {navText(n)}
            </NavLink>
          ))}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          {healthPill}
          <button type="button" onClick={() => setPalette(true)} title="Ara ya da git (Ctrl K)" aria-label="Ara ya da git" className="grid size-9 place-items-center rounded-full text-ink-2 transition-colors duration-150 hover:bg-hover hover:text-ink pointer-coarse:size-11">
            <Search className="size-[18px]" />
          </button>
          <span className="hidden min-w-0 flex-col items-end leading-tight 2xl:flex">
            <span className="max-w-40 truncate text-[13.5px] font-semibold">{me.name}</span>
            <span className="text-xs text-muted">{roleLabel}</span>
          </span>
          {/*
           * Araçlar: kişinin menüsü ve sığmayan ekranlar. Sade beyaz hap, solda avatar (dashboard'ların kullanıcı düğmesi);
           * ekranın tek ana eylemiyle yarışmasın diye mürekkep ve ok halkası yok
           */}
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-expanded={toolsOpen}
            aria-label={`${me.name} menüsü · Araçlar`}
            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-full border border-[var(--admin-border-strong)] bg-surface pl-1 pr-3 text-sm font-medium text-ink transition-colors duration-150 hover:border-[var(--admin-text-mute)] pointer-coarse:h-11 pointer-coarse:pl-1.5"
          >
            <Avatar name={me.name} color={me.color} className="size-7 text-[10.5px]" />
            Araçlar
            {hidden.length > 0 && (
              <span aria-hidden="true" className="tabular grid h-5 min-w-5 place-items-center rounded-full bg-surface-3 px-1.5 text-[11px] font-semibold text-ink-2">
                {hidden.length}
              </span>
            )}
          </button>
        </div>
      </header>

      {/* Telefon: üst şerit (adisyon, bar ve yönetimde yok: onların kendi şeridi var) */}
      {!fullBleed && (
        // Ana ekrandan açılan uygulamada çentik ve durum çubuğu payı
        <header className="flex items-center gap-0.5 bg-bg pb-1 pl-3 pr-1.5 pt-[max(0.25rem,env(safe-area-inset-top))] md:hidden">
          <LafTile size="sm" />
          <span className="ml-2.5 min-w-0 flex-1 truncate font-headline text-[17px] font-bold tracking-[-0.025em]">{current?.title ?? EXTRA_TITLES[location.pathname] ?? ''}</span>
          <button type="button" onClick={() => setPalette(true)} aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-full text-ink-2 active:bg-press">
            <Search className="size-5" />
          </button>
          {status()}
          <button type="button" onClick={() => setMenuOpen(true)} aria-label={`${me.name} menüsü`} className="grid size-11 place-items-center">
            {avatar('sm')}
          </button>
        </header>
      )}
      {!REMOTE && <PlatformInbox />}
      {notice && <div className="shrink-0">{notice}</div>}
      {/* Alt sekme çubuğu yokken (tek ekranlı rol: kuryenin Siparişler'i) ev çubuğu payını ana alan bırakır */}
      <main className={cn('min-h-0 flex-1 overflow-hidden', !showTabs && 'max-md:pb-[env(safe-area-inset-bottom)]')}>
        <div className="h-full md:px-3 md:pb-3">{children}</div>
      </main>
      {/* Telefon: alt sekmeler; ev çubuğu payı alt boşluğa eklenir. Etkin sekme açık nane hapta (yan menünün seçimi) */}
      {showTabs && (
        <nav aria-label="Ekranlar" className="flex border-t border-line bg-surface pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 md:hidden">
          {tabs.map((n) => (
            <NavLink key={n.to} to={n.to} aria-label={navAriaLabel(n)} className={({ isActive }) => tab(on(n.to, isActive))}>
              {({ isActive }) => (
                <>
                  <span className={tabPill(on(n.to, isActive))}>
                    <n.icon className={cn('size-[22px]', on(n.to, isActive) && 'stroke-[2.25]')} />
                  </span>
                  <span className="max-w-full truncate px-1">{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
          {more.length > 0 && (
            <button type="button" onClick={() => setMoreOpen(true)} aria-current={moreHere ? 'page' : undefined} className={tab(moreActive)}>
              <span className={tabPill(moreActive)}>
                <MoreHorizontal className={cn('size-[22px]', moreActive && 'stroke-[2.25]')} />
              </span>
              Daha
            </button>
          )}
          {meTab && (
            <button type="button" onClick={() => setMenuOpen(true)} aria-label={`${me.name} menüsü`} className={tab(false)}>
              <span className={tabPill(false)}>{avatar('xs')}</span>
              <span className="max-w-full truncate px-1">{me.name}</span>
            </button>
          )}
        </nav>
      )}

      <ToolsDrawer
        open={toolsOpen}
        onClose={closeTools}
        subtitle={
          <span className="flex items-center gap-2.5">
            {avatar('sm')}
            <span className="truncate">
              {me.name}
              {menuSubtitle && <span className="text-[var(--band-muted)]"> · {menuSubtitle}</span>}
            </span>
          </span>
        }
        foot={`L’Affogato · LafPOS · ${dayText}${boot.day ? ' açık' : ''} · ${fmtTime(now)}`}
      >
        <DrawerGroup label="Ekranlar">{drawerRows}</DrawerGroup>
        <DrawerGroup label="Bu cihaz ve oturum">
          {REMOTE && (
            // Uzaktan görünüm salt okunur; kasanın kendisi tarayıcı demosunda denenir (ayrı adres, ayrı veri)
            <a href="/demo/" className={drawerRow}>
              <DrawerLabel hint="Gerçek LafPOS tarayıcıda çalışır; PIN yok, veriler yalnız bu tarayıcıda">Kasa ekranını dene</DrawerLabel>
              <DrawerArrow />
            </a>
          )}
          {/* Kilit ve çıkış tek satır: ikisi de oturumu kapatıp giriş ekranına döner */}
          {!REMOTE && (
            <button type="button" onClick={lock} className={drawerRow}>
              <DrawerLabel hint={DEMO ? 'Oturum kapanır; başka bir rolle devam edilir' : 'Oturum kapanır; sıradaki kişi PIN’iyle girer'}>Ekranı kilitle</DrawerLabel>
              <Lock aria-hidden="true" className="size-5 shrink-0 text-[var(--band-muted)]" />
            </button>
          )}
          {remoteSignOut && (
            <button type="button" onClick={lock} className={drawerRow}>
              <DrawerLabel hint="Bu tarayıcıdaki uzaktan oturum kapanır">Çıkış yap</DrawerLabel>
              <LogOut aria-hidden="true" className="size-5 shrink-0 text-[var(--band-muted)]" />
            </button>
          )}
          {themeRow}
          {typeof document !== 'undefined' && document.fullscreenEnabled && (
            <button type="button" onClick={toggleFull} className={drawerRow}>
              <DrawerLabel hint={full ? 'Tarayıcının sekme ve adres çubuğu geri gelir' : 'Tarayıcının sekme ve adres çubuğu gizlenir'}>{full ? 'Tam ekrandan çık' : 'Tam ekran'}</DrawerLabel>
              {full ? <Shrink aria-hidden="true" className="size-5 shrink-0 text-[var(--band-muted)]" /> : <Expand aria-hidden="true" className="size-5 shrink-0 text-[var(--band-muted)]" />}
            </button>
          )}
        </DrawerGroup>
      </ToolsDrawer>
      <CommandPalette />
    </div>
  );
}
