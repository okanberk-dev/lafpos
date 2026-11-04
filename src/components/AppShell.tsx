import { ChevronRight, Expand, Lock, LogOut, MonitorPlay, MoreHorizontal, Moon, Search, Shrink, SunMoon, WifiOff } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS } from '@shared/permissions';
import { fmtTime, shiftForgotten } from '@shared/time';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { DEMO } from '@/lib/demo';
import { useLive } from '@/lib/live';
import { EXTRA_TITLES, isAdminArea, navAlias, navAriaLabel, phoneTabs, useNavOrigin, visibleNav } from '@/lib/nav';
import { useServiceMode, useTablesInUse } from '@/lib/serviceMode';
import { useShell } from '@/lib/shell';
import { confirmLeave } from '@/lib/unsavedGuard';
import { type KdsTheme, setBarTheme, useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { useReadyAlerts } from '@/lib/readyAlert';
import { useWakeLock } from '@/lib/wakelock';
import { useMyTime } from '@/lib/mesai';
import { CommandPalette } from './CommandPalette';
import { LafMark, LafTile } from './LafMark';
import { MesaiRow } from './MesaiRow';
import { PlatformInbox } from './PlatformInbox';
import { Segmented } from './ui/Field';
import { Avatar, Badge } from './ui/misc';
import { Modal } from './ui/Modal';
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
 * Raydaki ekran listesi sığmıyorsa (alçak ekran, çok ekranlı rol) altı solar: dokunmatikte kaydırma çubuğu
 * görünmez, listenin devam ettiği böyle anlaşılır. Sona kaydırılınca solma kalkar.
 */
function useMoreBelow(dep: unknown) {
  const ref = useRef<HTMLElement>(null);
  const [more, setMore] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const check = () => setMore(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    el.addEventListener('scroll', check, { passive: true });
    return () => {
      ro.disconnect();
      el.removeEventListener('scroll', check);
    };
  }, [dep]);
  return [ref, more] as const;
}

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
  // Mesaide olan kişinin avatarında yeşil nokta (kullanıcı menüsünde süre ve Mesaiyi bitir)
  // Önceki günden açık kalmış (çıkışı unutulmuş) mesai "mesaide" sayılmaz
  const myOpen = useMyTime().data?.open;
  const onClock = !!myOpen && !shiftForgotten(myOpen.clockIn, Date.now());
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
  const [railNav, railMore] = useMoreBelow(items.length);
  const isAt = (to: string) => location.pathname === to || location.pathname.startsWith(`${to}/`);
  // Menüde olmayan ekranın menüdeki yeri (navAlias): adisyon açıkken geldiği ekran (Masalar, Tezgâh satışı ya da
  // Siparişler), Eğitim cihazında Kasa etkin görünür. Yalnız görünüm: aria-current'ı NavLink verir, yalnız adresin ekranına
  const origin = useNavOrigin((s) => s.to);
  const alias = navAlias(location.pathname, origin);
  const on = (to: string, isActive: boolean) => isActive || to === alias;
  // Telefon üst şeridinde saat yerine ekranın adı (saat rayda ve kilit ekranında); "Daha"daki ekrandaysa Daha etkin
  const current = items.find((n) => isAt(n.to));
  const moreHere = more.some((n) => isAt(n.to));
  const moreActive = moreHere || more.some((n) => n.to === alias);
  const admin = isAdminArea(location.pathname);
  const fullBleed = admin || location.pathname.startsWith('/adisyon/') || location.pathname === '/mutfak';
  // Üst şeridi olmayan ekranda (adisyon, bar ekranı) kişinin menüsü alt sekmede: tek ekranlı rol (Bar) de telefonda
  // kilitleyip mesaisini bitirebilsin. Tek sekmelik çubuk çizilmez (kuryenin tek ekranı; menüsü üst şeritte)
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
  const clock = <span className="tabular font-medium text-ink-2">{fmtTime(now)}</span>;
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
  // Rayda (84 px) alt alta: bağlantı ve saat tek satırda, altında gün; telefonun üst şeridinde yan yana, saatsiz
  const status = (rail = false) => {
    if (REMOTE) {
      const badge = (
        <Badge tone="blue" className={cn(rail && 'px-2')} title="Kafeden gelen canlı özet; 10 sn’de bir yenilenir">
          Uzaktan
        </Badge>
      );
      return rail ? (
        <div className="flex flex-col items-center gap-1.5 text-xs">
          {clock}
          {badge}
        </div>
      ) : (
        badge
      );
    }
    return (
      <div className={cn('flex items-center text-xs', rail ? 'flex-col gap-1.5' : 'gap-1')}>
        {rail ? (
          <div className="flex items-center gap-1">
            {conn}
            {live !== 'kopuk' && clock}
          </div>
        ) : (
          conn
        )}
        {day}
      </div>
    );
  };
  const avatar = (size: keyof typeof AVATAR, dot = true) => (
    // Kitin avatarı (personel ve giriş ekranıyla tek): ince iç halka, açık kişi renginde koyu harf. Mesaideyse sağ altta
    // yeşil nokta. Ad düğmenin etiketinde
    <Avatar name={me.name} color={me.color} className={AVATAR[size]}>
      {dot && onClock && <span className="absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-surface bg-[var(--admin-success)]" />}
    </Avatar>
  );
  // Alt sekme: ikon hapın içinde; etkin sekme yalnız renkle değil, gri hap ve kalın yazıyla da ayrılır
  const tab = (on: boolean) => cn('group flex min-h-12 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11px] transition-colors duration-150', on ? 'font-semibold text-ink' : 'font-medium text-muted');
  const tabPill = (on: boolean) => cn('grid h-7 w-14 place-items-center rounded-full transition-colors duration-150', on ? 'bg-surface-3' : 'group-active:bg-press');
  const sheetRow = 'flex min-h-14 w-full items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-left transition-[background-color,border-color,color] duration-150 hover:border-[var(--admin-border-field)] hover:bg-hover active:bg-press';
  const sheetIcon = 'grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 [&>svg]:size-[18px]';
  // Menünün başlığı kişi: adı ve rolü (tek şubeli kasada işletmenin adı bilgi taşımaz)
  const roleLabel = ROLE_LABELS[me.role];
  const menuSubtitle = REMOTE ? 'Yalnız görüntüleme' : [roleLabel !== me.name && roleLabel, onClock && 'mesaide'].filter(Boolean).join(' · ') || undefined;
  // Uzaktan giriş ekranı parola sormadan giriyorsa (demo ya da parolasız görünüm) çıkış aynı oturumu yeniden açar: satır yok
  const remoteSignOut = useRemoteSignOut();

  return (
    // Innex düzeni: gri zemin üstünde beyaz menü kartı; kasa ekranları zeminde kendi kartlarını çizer
    // Yatay telefonda çentik yanlarda: kök kapsayıcı yan güvenli alanı bırakır
    <div
      className={cn(
        'flex h-full bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]',
        !admin && 'md:gap-3 md:p-2 md:pl-[max(0.5rem,env(safe-area-inset-left))] md:pr-[max(0.5rem,env(safe-area-inset-right))]',
      )}
    >
      {/* Tablet ve bilgisayar: ikon rayı (Innex'in daraltılmış kenar çubuğu, docs/ADMIN-INNEX.md §1.2) */}
      <aside className={cn('hidden w-[84px] shrink-0 flex-col items-center rounded-2xl border border-line bg-surface py-3 shadow-[var(--shadow-card)]', !admin && 'md:flex')}>
        <NavLink to="/" className="mb-3 rounded-[10px]" title="LafPOS">
          <LafTile />
        </NavLink>
        {/* 768 px yüksek ekranda (yatay tablet, dizüstü) on ekran da sığsın: alçak ekranda satır boşluğu kalkar (46 px) */}
        <nav
          ref={railNav}
          aria-label="Ekranlar"
          data-more={railMore || undefined}
          className="scroll-thin flex w-full flex-1 flex-col items-center gap-0.5 overflow-y-auto px-2 data-[more]:[mask-image:linear-gradient(to_bottom,#000_calc(100%_-_28px),transparent)]"
        >
          {items.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              title={n.title}
              aria-label={navAriaLabel(n)}
              className={({ isActive }) =>
                cn(
                  'group flex w-full flex-col items-center gap-0.5 rounded-xl py-0.5 text-[11px] font-medium transition-colors duration-150 [@media(max-height:860px)]:py-0',
                  on(n.to, isActive) ? 'text-ink' : 'text-muted hover:text-ink',
                )
              }
            >
              {({ isActive }) => (
                <>
                  {/* Etkin ekran: yeşil hap içinde ikon (renk tek başına durum taşımaz: yazı da kalın) */}
                  <span
                    className={cn(
                      'grid h-7 w-12 place-items-center rounded-full transition-colors duration-150',
                      on(n.to, isActive) ? 'bg-primary text-primary-ink' : 'group-hover:bg-hover group-active:bg-press',
                    )}
                  >
                    <n.icon className="size-5" />
                  </span>
                  <span className={cn('leading-4', on(n.to, isActive) && 'font-semibold')}>{n.label}</span>
                </>
              )}
            </NavLink>
          ))}
        </nav>
        <div className="mt-2 flex flex-col items-center gap-1.5 border-t border-[var(--admin-divider)] px-2 pt-2">
          <button type="button" onClick={() => setPalette(true)} title="Ara ya da git (Ctrl K)" aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-xl text-muted transition-colors duration-150 hover:bg-hover hover:text-ink active:bg-press">
            <Search className="size-5" />
          </button>
          {status(true)}
          <button type="button" onClick={() => setMenuOpen(true)} className="grid size-11 place-items-center rounded-full" title={me.name} aria-label={`${me.name} menüsü`}>
            {avatar('md')}
          </button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        {/* Telefon: üst şerit */}
        {!fullBleed && (
          // Ana ekrandan açılan uygulamada çentik ve durum çubuğu payı
          <header className="flex items-center gap-0.5 border-b border-line bg-surface pb-1 pl-4 pr-2 pt-[max(0.25rem,env(safe-area-inset-top))] md:hidden">
            <LafMark className="h-4 shrink-0 text-ink" title="L'Affogato" />
            <span className="ml-2.5 min-w-0 flex-1 truncate text-base font-semibold tracking-[-0.01em]">{current?.title ?? EXTRA_TITLES[location.pathname] ?? ''}</span>
            <button type="button" onClick={() => setPalette(true)} aria-label="Ara ya da git" className="grid size-11 place-items-center rounded-xl text-muted active:bg-press">
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
        <main className={cn('min-h-0 flex-1 overflow-hidden', !showTabs && 'max-md:pb-[env(safe-area-inset-bottom)]')}>{children}</main>
        {/* Telefon: alt sekmeler; ev çubuğu payı alt boşluğa eklenir */}
        {showTabs && (
          <nav aria-label="Ekranlar" className="flex border-t border-line bg-surface pb-[max(0.25rem,env(safe-area-inset-bottom))] pt-1 md:hidden">
            {tabs.map((n) => (
              <NavLink key={n.to} to={n.to} aria-label={navAriaLabel(n)} className={({ isActive }) => tab(on(n.to, isActive))}>
                {({ isActive }) => (
                  <>
                    {/* Etkin sekme: ikon gri hapın içinde ve kalın (index.css svg.lucide 1.75'i sınıf ezer) */}
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
      </div>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Diğer ekranlar" size="sm">
        {/* Liste: ekranın tam adı (raydaki kısaltma değil), sağda ok */}
        <div className="space-y-2 p-4">
          {more.map((n) => (
            <NavLink key={n.to} to={n.to} onClick={() => setMoreOpen(false)} className={({ isActive }) => cn(sheetRow, on(n.to, isActive) && 'border-[var(--admin-border-field)] bg-surface-3')}>
              <span className={sheetIcon}>
                <n.icon />
              </span>
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{n.title}</span>
              <ChevronRight className="size-4 shrink-0 text-muted" />
            </NavLink>
          ))}
        </div>
      </Modal>

      <Modal
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        title={
          // Dokunulan avatar başlıkta da: menünün kimin olduğu bir bakışta
          <span className="flex min-w-0 items-center gap-2.5">
            {avatar('sm', false)}
            <span className="truncate">{me.name}</span>
          </span>
        }
        subtitle={menuSubtitle}
        size="sm"
      >
        <div className="space-y-2 p-4">
          {!REMOTE && <MesaiRow className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-3 py-2.5" />}
          {REMOTE && (
            // Uzaktan görünüm salt okunur; kasanın kendisi tarayıcı demosunda denenir (ayrı adres, ayrı veri)
            <a href="/demo/" className={sheetRow}>
              <span className={sheetIcon}>
                <MonitorPlay />
              </span>
              <span>
                <span className="block text-sm font-medium">Kasa ekranını dene</span>
                <span className="block text-xs text-muted">Gerçek LafPOS tarayıcıda çalışır; PIN yok, veriler yalnız bu tarayıcıda</span>
              </span>
            </a>
          )}
          {/* Kilit ve çıkış tek satır: ikisi de oturumu kapatıp giriş ekranına döner */}
          {!REMOTE && (
            <button type="button" onClick={lock} className={sheetRow}>
              <span className={sheetIcon}>
                <Lock />
              </span>
              <span>
                <span className="block text-sm font-medium">Ekranı kilitle</span>
                <span className="block text-xs text-muted">{DEMO ? 'Oturum kapanır; başka bir rolle devam edilir' : 'Oturum kapanır; sıradaki kişi PIN’iyle girer'}</span>
              </span>
            </button>
          )}
          {remoteSignOut && (
            <button type="button" onClick={lock} className={sheetRow}>
              <span className={sheetIcon}>
                <LogOut />
              </span>
              <span>
                <span className="block text-sm font-medium">Çıkış yap</span>
                <span className="block text-xs text-muted">Bu tarayıcıdaki uzaktan oturum kapanır</span>
              </span>
            </button>
          )}
          {/* Tema: üç seçenek (Cihaz bir dokunuşta kaybolmasın); bar ekranında bu cihazın bar tercihi */}
          <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-line px-3 py-2.5">
            <span className={sheetIcon}>{onBar ? <Moon /> : <SunMoon />}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{onBar ? 'Bar ekranı' : 'Tema'}</span>
              {onBar && <span className="block text-xs text-muted">Bu cihazda saklanır</span>}
            </span>
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
          </div>
          {typeof document !== 'undefined' && document.fullscreenEnabled && (
            <button type="button" onClick={toggleFull} className={sheetRow}>
              <span className={sheetIcon}>{full ? <Shrink /> : <Expand />}</span>
              <span>
                <span className="block text-sm font-medium">{full ? 'Tam ekrandan çık' : 'Tam ekran'}</span>
                <span className="block text-xs text-muted">{full ? 'Tarayıcının sekme ve adres çubuğu geri gelir' : 'Tarayıcının sekme ve adres çubuğu gizlenir'}</span>
              </span>
            </button>
          )}
        </div>
      </Modal>
      <CommandPalette />
    </div>
  );
}
