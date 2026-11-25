import { ChevronDown, Expand, Lock, LogOut, MoreHorizontal, Search, Shrink, SlidersHorizontal, WifiOff } from 'lucide-react';
import { lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router';
import { ROLE_LABELS } from '@shared/permissions';
import { fmtTime } from '@shared/time';
import { useAuth, useCan } from '@/lib/auth';
import { useBankEodSlip, useDeviceCopies } from '@/lib/after-payment';
import { useBoot } from '@/lib/boot';
import { useBuildWatch, useRemoteBuildWatch } from '@/lib/buildWatch';
import { useOutbox } from '@/lib/outbox';
import { cn } from '@/lib/cn';
import { DEMO } from '@/lib/demo';
import { useLive } from '@/lib/live';
import { EXTRA_TITLES, isAdminArea, navAlias, navAriaLabel, type NavItem, phoneTabs, useNavOrigin, visibleNav } from '@/lib/nav';
import { useBarEnabled, useServiceMode, useTablesInUse } from '@/lib/serviceMode';
import { useShell } from '@/lib/shell';
import { alertPerms } from '@/lib/siteAlerts';
import { confirmLeave } from '@/lib/unsavedGuard';
import { type KdsTheme, setBarTheme, useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { useReadyAlerts } from '@/lib/readyAlert';
import { useWakeLock } from '@/lib/wakelock';
import { ClosingReminder } from './ClosingReminder';
import { CommandPalette } from './CommandPalette';
import { InternetBadge } from './InternetBadge';
import { LafTile } from './LafMark';
import { LicenseStrip } from './LicenseStrip';
import { PlatformInbox } from './PlatformInbox';
import { UpdateOffer } from './UpdateOffer';
import { RemoteShopPicker } from './RemoteShopPicker';
import { SiteInbox } from './SiteInbox';
import { AlertSoundGroup, DrawerArrow, DrawerGroup, DrawerLabel, drawerRow, ToolsDrawer } from './ToolsDrawer';
import { Segmented } from './ui/Field';
import { Avatar, Badge } from './ui/misc';
import { useUzaktanErisim } from '@/lib/kontrol';
import { REMOTE, remoteNav, useRemoteSignOut } from '@/lib/remote';
import { TopTabsClaim, TopTabsSlot } from './shellSlots';
import { Button, IconButton } from './ui/Button';

/** "Denemeyi bitir" penceresi yalnız patron basınca yüklenir (yönetim kodu kasa ekranının paketine girmez) */
const DenemeFinish = lazy(() => import('./admin/DenemeCard').then((m) => ({ default: m.DenemeFinishLauncher })));

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

/*
 * Marka rayı (pano, 20 Kasım 2026; operatör: "menüsüne kadar 1:1"): tablette ve bilgisayarda solda ev yeşilinin
 * degradesinde dikey ray. Her ekran ikon üstte, kısa ad altta; seçili ekran beyaz karoda, ikonu açık nane karede yeşil,
 * adı yeşil ve kalın (panonun seçili rayı). Dipte Araçlar (kişinin menüsü, tema, tam ekran) ve Kilitle. Sınıflar
 * index.css'te (.lp-rail, .lp-rail-item)
 */
const AVATAR = { xs: 'size-7 text-[11px]', sm: 'size-8 text-[11px]', md: 'size-9 text-xs' } as const;

/**
 * Kasa ekranlarının kabuğu. `notice`: ekranın üstünde, sayfanın dışında duran şerit (uzaktan görünümün demo notu);
 * sayfa `main`'in tam yüksekliğini kullandığı için içeride dursa sayfanın altını keserdi.
 */
export function AppShell({ children, notice }: { children: ReactNode; notice?: ReactNode }) {
  const boot = useBoot();
  // Cihaz ödemesinin işyeri nüshası (kasa ekranında): ödeme penceresi kapanmış olsa da; olay kaçtıysa açılışta ve canlı
  // bağlantı yeniden kurulunca sunucuda bekleyenler basılır
  useDeviceCopies(boot);
  useBankEodSlip(boot);
  const can = useCan();
  const me = useAuth((s) => s.me)!;
  const [finishing, setFinishing] = useState(false);
  const closeFinish = useCallback(() => setFinishing(false), []);
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
  // Üst çubuğun ortası: ekranın sekmeleri buraya taşınır (Stage)
  const [tabsSlot, setTabsSlot] = useState<HTMLElement | null>(null);
  // Üst çubuk yalnız ekranın sekmeleri (Masalar'ın bölümleri, Siparişler, Kasa) varken görünür; boşken kaldırılır ve
  // içerik yukarı yayılır (sahibin isteği, 21 Kas 2026). Durum ve arama o zaman marka rayında. Sekmeleri taşıyan sahne
  // bunu çizimden önce bildirir (TopTabsClaim): çubuk sayfa çizildikten sonra gelip içeriği itmez
  const [tabClaims, setTabClaims] = useState(0);
  const claimTopTabs = useCallback(() => {
    setTabClaims((n) => n + 1);
    return () => setTabClaims((n) => n - 1);
  }, []);
  const hasTabs = tabClaims > 0;
  // Ekran değişince gezinme sayfaları kapanır: kaydedilmemiş değişiklik koruması bağlantının tıklamasını yakalayıp
  // onaydan sonra kendisi gezdiğinde bağlantının onClick'i (sayfayı kapat) çalışmamış olur
  useEffect(() => {
    setMoreOpen(false);
    setMenuOpen(false);
  }, [location.pathname, setMenuOpen]);
  // Kasa yeni sürümle yeniden açılınca ekran kendiliğinden yenilenir ve kaldığı yerden devam eder
  useBuildWatch(!REMOTE && !DEMO);
  // Uzaktan: ekrana dönünce sitedeki son yayına bakılır, yeniyse yenilenir
  useRemoteBuildWatch(REMOTE && !DEMO);
  useAutoLock(boot.settings.autoLockMinutes);
  useWakeLock(boot.settings.keepAwake);
  // Kasaya ulaşamayan gönderimler kasa dönünce kendiliğinden gider (hangi ekranda olunursa olsun)
  useOutbox(boot);
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
  // Bar ekranı ayardan kapalıysa Bar menüde yok (Yönetim › Ayarlar › "Bar ekranı ve Bara gönder")
  const bar = useBarEnabled();
  // Uzakta Merkez yalnız panelin sahibine, Uzaktan yönetim parolasız görünümde hiç (kasada etkisiz)
  const erisim = useUzaktanErisim();
  const items = remoteNav(visibleNav(can, mode, { tablesInUse, bar }), REMOTE, erisim);
  const { tabs, more } = phoneTabs(items);
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
        <div className="flex items-center gap-2">
          <RemoteShopPicker />
          <Badge tone="blue" title="Kafeden gelen canlı özet; 15 sn’de bir yenilenir">
            Uzaktan
          </Badge>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1 text-xs">
        <InternetBadge compact />
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
  // Telefonun alt menüsü (yüzen dok): her sekme 56 px yüksek, yuvarlak karo; etkin sekmenin bütün karosu açık nane, ikonu
  // ve adı yeşil (yan menünün seçimi). Dokununca hafifçe içe basar (hareket azaltmada yok)
  const tab = (on: boolean) =>
    cn(
      'group relative flex min-h-14 min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-[1.125rem] text-[11px] leading-4 transition-[background-color,color,transform] duration-150 active:scale-[0.96] motion-reduce:active:scale-100',
      on ? 'bg-[var(--menu-active-bg)] font-semibold text-[var(--menu-active-ink)]' : 'font-medium text-muted active:bg-press',
    );
  const tabPill = (_on: boolean) => 'grid h-7 place-items-center';
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
  // Telefonda (alt pencere) ekranlar üçlü karo ızgarası: ikon yuvarlak karede, altında kısa ad; etkin ekran açık nane
  const drawerTiles = items.map((n) => {
    const here = on(n.to, isAt(n.to));
    return (
      <NavLink
        key={n.to}
        to={n.to}
        onClick={closeTools}
        aria-label={navAriaLabel(n)}
        aria-current={here ? 'page' : undefined}
        className={cn(
          'flex min-h-[5.5rem] flex-col items-center justify-center gap-2 rounded-[1.125rem] px-1 text-center text-[13px] font-medium leading-4 transition-[background-color,transform] duration-150 active:scale-[0.97] motion-reduce:active:scale-100',
          here ? 'bg-[var(--menu-active-bg)] font-semibold text-[var(--menu-active-ink)]' : 'bg-[var(--admin-surface-2)] text-[var(--admin-text)] active:bg-press',
        )}
      >
        <span aria-hidden="true" className={cn('grid size-11 place-items-center rounded-[0.875rem]', here ? 'bg-[color-mix(in_oklab,var(--menu-active-ink)_16%,transparent)]' : 'bg-[var(--admin-panel)]')}>
          <n.icon className="size-[22px]" />
        </span>
        <span className="max-w-full truncate">{n.label}</span>
      </NavLink>
    );
  });
  const themeRow = (
    // Tema: üç seçenek (Cihaz bir dokunuşta kaybolmasın); bar ekranında bu cihazın bar tercihi
    <div className={cn(drawerRow, 'flex-wrap gap-y-2 hover:pl-0.5')} style={{ animationDelay: `${120 + items.length * 35}ms` }}>
      <DrawerLabel hint={onBar ? 'Bu cihazda saklanır' : undefined}>{onBar ? 'Bar teması' : 'Tema'}</DrawerLabel>
      <span className="[--admin-surface:var(--band-2)] [--surface-2:var(--band-2)] [--admin-border:var(--band-line)] [--admin-border-strong:var(--band-line)] [--admin-ink-fill:var(--band-text)] [--admin-on-ink:var(--admin-surface)] [--shadow-action:none] [--admin-text:var(--band-text)] [--admin-text-soft:var(--band-muted)] [--ink:var(--band-text)] [--ink-2:var(--band-muted)]">
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
    // Kitin kabuğu: tablette ve bilgisayarda solda tam boy marka rayı (marka, ana ekranlar, durum, Araçlar), sağında
    // sekmeler varken üst çubuk, uyarı şeritleri ve ekranın sahnesi. Telefonda üst şerit ve alt sekme çubuğu. Yatay
    // telefonda çentik yanlarda: kök kapsayıcı yan güvenli alanı bırakır
    <div className="flex h-full flex-col bg-bg pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]">
      {/* Telefon: üst şerit (adisyon, bar ve yönetimde yok: onların kendi şeridi var) */}
      {!fullBleed && (
        // Ana ekrandan açılan uygulamada çentik ve durum çubuğu payı
        <header className="flex min-h-16 items-center gap-0.5 bg-bg pb-1.5 pl-3 pr-1.5 pt-[max(0.5rem,env(safe-area-inset-top))] md:hidden">
          <LafTile size="md" />
          <span className="ml-3 min-w-0 flex-1 truncate font-headline text-[19px] font-bold leading-6 tracking-[-0.025em]">{current?.title ?? EXTRA_TITLES[location.pathname] ?? ''}</span>
          <IconButton label="Ara ya da git" size="lg" onClick={() => setPalette(true)} className="rounded-full pointer-coarse:size-11">
            <Search className="size-5" />
          </IconButton>
          {status()}
          <button type="button" onClick={() => setMenuOpen(true)} aria-label={`${me.name} menüsü`} className="grid size-11 place-items-center">
            {avatar('sm')}
          </button>
        </header>
      )}
      <div className="flex min-h-0 flex-1 md:gap-[var(--shell-gap)] md:p-[var(--shell-gap)] md:pb-[max(var(--shell-gap),env(safe-area-inset-bottom))]">
        {/* Tablet ve bilgisayar: marka rayı (panonun menüsü). Ekranlar ikon ve kısa adla; dipte Araçlar ve Kilitle */}
        <nav aria-label="Ekranlar" className="lp-rail">
          {/* Marka karosu rayın başında (her ekranda aynı yerde; ana ekrana götürür) */}
          <NavLink to="/" title="L'Affogato · LafPOS" aria-label="Ana ekran" className="lp-rail-brand">
            <LafTile size="md" />
          </NavLink>
          <div className="lp-rail-list">
            {items.map((n) => (
              // Seçili görünüm data-on'da: menüde olmayan ekranın yeri de (adisyonun geldiği ekran, Eğitim cihazında Kasa)
              // etkin görünür; aria-current'ı NavLink yalnız adresin ekranına verir
              <NavLink key={n.to} to={n.to} title={n.title} aria-label={navAriaLabel(n)} data-on={on(n.to, isAt(n.to)) || undefined} className="lp-rail-item">
                <span aria-hidden="true" className="lp-rail-icon">
                  <n.icon />
                </span>
                <span className="lp-rail-label">{n.label}</span>
              </NavLink>
            ))}
          </div>
          <div className="lp-rail-foot">
            {/*
             * Üst çubuk yokken durum rayın dibinde tek satırda: nokta ve saat (gün kapalıyken "Kapalı"; dokununca kasa),
             * genişte yanında arama (Ctrl K da açar). İnternet sorunu varsa rozeti üstünde. Ray kısa kalsın diye öğe değil satır
             */}
            {!hasTabs && (
              <>
                <span className="flex justify-center empty:hidden">
                  <InternetBadge compact />
                </span>
                {/* Durum ve arama alt alta: yan yana sığmıyor, saat "1…" diye kısalıyordu (22 Kas 2026). Arama düğmesi yalnız
                    geniş ve yüksek ekranda (fareyle; alçak ekranda ray listesi kesilmesin, Ctrl K yine açar); uzaktan
                    görünümde yok */}
                <div className="flex min-w-0 flex-col items-stretch">
                  {canKasa && !REMOTE ? (
                    <NavLink
                      to="/kasa"
                      title={boot.day ? `Kasa ve gün sonu · ${liveLabel}` : `Gün kapalı; kasada açılır · ${liveLabel}`}
                      aria-label={`${liveLabel}, ${boot.day ? `Z ${boot.day.zNo} açık` : 'gün kapalı'}; kasa ve gün sonu`}
                      className="lp-rail-item min-h-11 min-w-0 flex-1 flex-row gap-1.5 px-1"
                    >
                      {healthDot}
                      <span className="tabular min-w-0 truncate text-xs">{live === 'kopuk' ? 'Koptu' : boot.day ? fmtTime(now) : 'Kapalı'}</span>
                    </NavLink>
                  ) : (
                    <span role="status" title={liveLabel} className="lp-rail-item min-h-11 min-w-0 flex-1 cursor-default flex-row gap-1.5 px-1">
                      {healthDot}
                      <span className="tabular min-w-0 truncate text-xs">{REMOTE ? 'Uzaktan' : live === 'kopuk' ? 'Koptu' : fmtTime(now)}</span>
                      <span className="sr-only">, {liveLabel}</span>
                    </span>
                  )}
                  {!REMOTE && (
                    <button type="button" onClick={() => setPalette(true)} title="Ara ya da git (Ctrl K)" aria-label="Ara ya da git" className="lp-rail-item hidden h-9 min-h-0 w-full shrink-0 p-0 [@media(min-width:64rem)_and_(min-height:860px)_and_(pointer:fine)]:flex">
                      <Search aria-hidden="true" className="size-[18px]" />
                    </button>
                  )}
                </div>
              </>
            )}
            {/* Üst çubuk yokken kimin oturumda olduğu burada: kişinin avatarı ve adı (menüsünü açar); varken Araçlar */}
            {hasTabs ? (
              <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={toolsOpen} title="Araçlar: tema, tam ekran, kilit" className="lp-rail-item">
                <span aria-hidden="true" className="lp-rail-icon">
                  <SlidersHorizontal />
                </span>
                <span className="lp-rail-label">Araçlar</span>
              </button>
            ) : (
              <button type="button" onClick={() => setMenuOpen(true)} aria-expanded={toolsOpen} aria-label={`${me.name} menüsü · Araçlar`} title={`${me.name} · ${roleLabel} · Araçlar`} className="lp-rail-item">
                <span className="lp-rail-icon lp-rail-avatar">{avatar('xs')}</span>
                <span aria-hidden="true" className="lp-rail-label max-w-full truncate">
                  {me.name.split(' ')[0]}
                </span>
              </button>
            )}
            {!REMOTE && (
              <button type="button" onClick={lock} title={DEMO ? 'Oturum kapanır; başka bir rolle devam edilir' : 'Oturum kapanır; sıradaki kişi PIN’iyle girer'} className="lp-rail-item">
                <span aria-hidden="true" className="lp-rail-icon">
                  <LogOut />
                </span>
                <span className="lp-rail-label">Kilitle</span>
              </button>
            )}
            {remoteSignOut && (
              <button type="button" onClick={lock} title="Bu tarayıcıdaki uzaktan oturum kapanır" className="lp-rail-item">
                <span aria-hidden="true" className="lp-rail-icon">
                  <LogOut />
                </span>
                <span className="lp-rail-label">Çıkış</span>
              </button>
            )}
          </div>
        </nav>
        {/*
         * Rayın sağındaki sütun: üst çubuk, uyarı şeritleri ve ekran. Çubuk ve şeritler (platform siparişi, site zili,
         * deneme, lisans) yalnız bu sütunda açılıp kapanır: sol ray hiçbir ekranda ve hiçbir uyarıda yerinden oynamaz
         */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col md:gap-[var(--shell-gap)]">
              {/*
               * Tablet ve bilgisayar: üst çubuk (pano), rayın sağındaki sütunda: ortada ekranın sekmeleri (sayfa sahnesi
               * buraya taşır, TopTabsSlot); sağda durum (saat ve Z), arama ve kişinin düğmesi (avatar ve ok). İskelet
               * (operatör, 20 Kas 2026: "belli bir iskelet, çerçevelerle ayrım"): ray, üst çubuk ve içerik zeminde
               * --shell-gap (12 px) aralıklı çerçeveli bloklar. Çubuk rayın üstünü kaplamaz: açılıp kapanınca ray kaymaz
               */}
          <header
            className={cn(
              'relative z-30 hidden h-16 shrink-0 items-center gap-3 rounded-[var(--r-card)] border border-line bg-surface px-3 shadow-[var(--shadow-control)] lg:gap-4',
              hasTabs && 'md:flex',
            )}
          >
            <div ref={setTabsSlot} className="lp-topnav flex min-w-0 flex-1 items-center justify-center" />
            <div className="flex shrink-0 items-center gap-1.5">
              {/* İnternet yokken bekleyen kayıtlar ve dönünce "Bekleyenler gönderildi" (her şey yolundayken boş) */}
              <span className="hidden xl:inline-flex">
                <InternetBadge />
              </span>
              <span className="inline-flex xl:hidden">
                <InternetBadge compact />
              </span>
              {/* Uzakta iki ve daha çok dükkân: seçici tablet ve bilgisayarda da (telefonda üst şeritte) */}
              {REMOTE && <RemoteShopPicker />}
              {healthPill}
              <IconButton label="Ara ya da git" title="Ara ya da git (Ctrl K)" onClick={() => setPalette(true)} className="rounded-xl">
                <Search className="size-5" />
              </IconButton>
              {/*
               * Kişinin düğmesi (panonun avatarı ve oku): kişinin menüsünü (Araçlar çekmecesi) açar. Ana eylemle yarışmasın diye
               * kenarsız; geniş ekranda adı ve rolü yanında
               */}
              <button
                type="button"
                onClick={() => setMenuOpen(true)}
                aria-expanded={toolsOpen}
                aria-label={`${me.name} menüsü · Araçlar`}
                className="inline-flex h-11 shrink-0 items-center gap-2 rounded-xl pl-1 pr-2 text-ink transition-colors duration-150 hover:bg-hover"
              >
                {avatar('md')}
                <span className="hidden min-w-0 flex-col items-start leading-tight 2xl:flex">
                  <span className="max-w-36 truncate text-[13.5px] font-semibold">{me.name}</span>
                  <span className="text-xs text-muted">{roleLabel}</span>
                </span>
                <ChevronDown aria-hidden="true" className="size-4 text-muted" />
              </button>
            </div>
          </header>
          {!REMOTE && <PlatformInbox />}
          {/* Diğer sistemlerin uyarıları: online sipariş zili ve karaoke (laffogato, lafmobil); ilk dokunuş sesi açar */}
          {!REMOTE && <SiteInbox />}
          {/*
           * Deneme modu (yeni kurulum; patron Yönetim › Ayarlar ve yedek'ten bitirir): her ekranda sakin, ince bir şerit.
           * Gecede renkli zemin siyah sahnede parlar: şerit nötr yüzeyde, bilgi rengi yalnız küçük noktada.
           * Tarayıcı demosunda yok (demo şeridi zaten var)
           */}
          {!DEMO && boot.integrations.deneme && (
            <div
              role="note"
              className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[var(--admin-info-line)] bg-[var(--admin-info-soft)] px-4 py-1.5 text-center text-[13px] font-medium leading-5 text-ink md:rounded-xl md:border dark:border-[var(--admin-border)] dark:bg-surface dark:text-ink-2"
            >
              <span className="inline-flex items-center gap-2">
                <span aria-hidden="true" className="hidden size-1.5 shrink-0 rounded-full bg-[var(--admin-info)] dark:inline-block" />
                Deneme modu: yapılan satışlar gerçek sayılmaz
              </span>
              {/* Çıkış patronun: yedek alınır, deneme kayıtları silinir, PIN'le onaylanır (Ayarlar ve yedek'teki kartla aynı pencere) */}
              {me.role === 'patron' && (
                <Button size="sm" variant="soft" onClick={() => setFinishing(true)}>
                  Denemeyi bitir
                </Button>
              )}
            </div>
          )}
          {/* Deneme kapanmış ama geçiş yarım (eski sürümde PIN değişince): yalnız patrona, aynı pencereyle tamamlanır */}
          {!DEMO && !REMOTE && !boot.integrations.deneme && boot.integrations.goLivePending && me.role === 'patron' && (
            <div
              role="note"
              className="flex shrink-0 flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-[var(--admin-info-line)] bg-[var(--admin-info-soft)] px-4 py-1.5 text-center text-[13px] font-medium leading-5 text-ink md:rounded-xl md:border"
            >
              <span>Gerçek kullanıma geçiş tamamlanmadı</span>
              <Button size="sm" variant="soft" onClick={() => setFinishing(true)}>
                Geçişi tamamla
              </Button>
            </div>
          )}
          {finishing && (
            <Suspense fallback={null}>
              <DenemeFinish onClose={closeFinish} />
            </Suspense>
          )}
          <LicenseStrip />
          {notice && <div className="shrink-0">{notice}</div>}
          {/* Alt sekme çubuğu yokken (tek ekranlı rol: kuryenin Siparişler'i) ev çubuğu payını ana alan bırakır */}
          <main
            className={cn(
              'min-h-0 min-w-0 flex-1 overflow-hidden',
              // Ev çubuğu payını dok yoksa ana alan bırakır; kapanış kartı varken kartın kendisi bırakır (iki kez değil)
              !showTabs && 'max-md:pb-[env(safe-area-inset-bottom)] max-md:[html:has([data-closing-reminder])_&]:pb-0',
            )}
          >
            <TopTabsClaim.Provider value={claimTopTabs}>
              <TopTabsSlot.Provider value={tabsSlot}>
                <div className="h-full">{children}</div>
              </TopTabsSlot.Provider>
            </TopTabsClaim.Provider>
          </main>
          {/* Kapanış saatine 30 dk kala "Gün sonu al" (Ayarlar › Gün sonu ve Z; uzaktan görünümde yok): akışta, ana alanın
              altında; ekranın üstüne binmez, telefonda dokun üstünde, geniş ekranda sağ alt köşede */}
          {!REMOTE && <ClosingReminder dock={showTabs} />}
        </div>
      </div>
      {/*
       * Telefon: alt menü, zeminin üstünde yüzen yuvarlak dok (kenarlarda zemin görünür); ev çubuğu payı dokun altında.
       * Akışın içinde durur: içeriğin üstüne binmez, son kart dokun arkasında kalmaz
       */}
      {showTabs && (
        <nav
          aria-label="Ekranlar"
          className="mx-2.5 mb-[max(0.5rem,env(safe-area-inset-bottom))] mt-1.5 flex shrink-0 gap-0.5 rounded-[1.5rem] border border-line bg-surface p-1 shadow-[0_12px_32px_-16px_rgb(16_24_20/0.4)] md:hidden dark:shadow-none"
        >
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

      {/* Kasada yeni sürüm teklifi: Şimdi güncelle / Gün sonunda güncelle (uzaktan görünümde ve demoda yok) */}
      {!REMOTE && !DEMO && <UpdateOffer />}
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
        <DrawerGroup label="Ekranlar" className="max-md:hidden">
          {drawerRows}
        </DrawerGroup>
        <section aria-label="Ekranlar" className="mt-4 md:hidden">
          <h2 className="mb-2 font-sans text-xs font-medium tracking-normal text-[var(--band-muted)]">Ekranlar</h2>
          <div className="grid grid-cols-3 gap-2">{drawerTiles}</div>
        </section>
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
        {!REMOTE && <AlertSoundGroup {...alertPerms(can)} delay={160 + items.length * 35} />}
        {/* Yardım en sonda: sık sorulan sorular, kişinin yetkisine göre (src/lib/faq.ts); uzaktan görünümde yok */}
        {!REMOTE && (
          <DrawerGroup label="Yardım">
            <NavLink to="/yardim" onClick={closeTools} aria-current={isAt('/yardim') ? 'page' : undefined} className={cn(drawerRow, isAt('/yardim') && 'text-[var(--band-accent)]')}>
              <DrawerLabel hint="Gün sonu, iade, yazıcı, PIN… yanıtlar ekrandaki adlarla">Sık sorulan sorular</DrawerLabel>
              <DrawerArrow />
            </NavLink>
          </DrawerGroup>
        )}
      </ToolsDrawer>
      <CommandPalette />
    </div>
  );
}
