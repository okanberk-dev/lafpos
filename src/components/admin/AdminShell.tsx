import { useQuery } from '@tanstack/react-query';
import { ArrowLeftRight, ChevronLeft, Rows4, Search, WifiOff } from 'lucide-react';
import { Fragment, type ReactNode, useEffect } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { LafTile } from '@/components/LafMark';
import { Avatar, RAIL_FADE, useRail } from '@/components/ui/misc';
import { Stage } from '@/components/ui/Stage';
import { get } from '@/lib/api';
import { useAuth, useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
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
 * Yönetim paneli kabuğu (LafPOS Sahne): tablet ve bilgisayarda kasanın üst çubuğunun altında gri sahne. Geniş ekranda
 * (lg) sol sütunda shadcn'in Sidebar'ı gibi sade yan menü (grup başlıkları, ikonlu bölümler, seçili satır beyaz;
 * dipte kasaya dönüş ve sıkı görünüm), sağda beyaz yaprakta sayfanın başlığı, eylemleri ve içeriği. Tablette menü yatay
 * kayan hap şeridi. Telefonda kendi üst şeridi (geri, ad, arama, bağlantı, kişi) ve kasanın alt sekme çubuğu; bölüm
 * listesi /yonetim'de.
 */
export function AdminShell({ title, children }: { title: string; children: ReactNode }) {
  const can = useCan();
  const me = useAuth((s) => s.me)!;
  const live = useLive((s) => s.status);
  const { compact, toggleCompact, setPalette, setUserMenu } = useShell();
  const location = useLocation();
  const counts = useCounts();
  const home = useHomePath();
  const sections = visibleSections(can);
  const atIndex = location.pathname === '/yonetim' || location.pathname === '/yonetim/';
  const strip = useRail<HTMLDivElement>(location.pathname);

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

  const current = sections.find((s) => location.pathname.startsWith(s.to));
  const groups = ADMIN_GROUPS.filter((g) => sections.some((s) => s.group === g.key));
  const back = !atIndex && (location.pathname.startsWith('/yonetim') || sections.length > 1);

  /** Bölümün sayacı: rakam gözle okunur, ne saydığı adın parçası olarak ekran okuyucuya ("Ürünler 3" değil) */
  const counted = (key: AdminSection['key']) => {
    const count = counts[key];
    return count ? { count, text: countText(key, count) } : null;
  };
  const sectionLink = (sec: AdminSection, icon: boolean) => {
    const c = counted(sec.key);
    return (
      <NavLink key={sec.key} to={sec.to} className="lp-menu-item">
        {icon && <sec.icon aria-hidden="true" />}
        <span className="min-w-0 flex-1 truncate">
          {sec.label}
          {c && <span className="sr-only">, {c.text}</span>}
        </span>
        {c && (
          <span aria-hidden="true" title={c.text} className="n">
            {c.count}
          </span>
        )}
      </NavLink>
    );
  };

  // Geniş ekran (shadcn'in Sidebar'ı gibi sade): grup başlığı küçük ve soluk, altında bölümler ikonlarıyla; seçili satır
  // beyaz yüzeyde. Bütün bölümler bir bakışta, açılıp kapanan grup yok
  const columnMenu = (
    <nav aria-label="Yönetim" className="max-lg:hidden">
      <div className="lp-menu lp-menu-col">
        {groups.map((g) => (
          <Fragment key={g.key}>
            <span className="lp-menu-label">{g.label}</span>
            {sections.filter((x) => x.group === g.key).map((x) => sectionLink(x, true))}
          </Fragment>
        ))}
      </div>
    </nav>
  );
  // Tablet: bütün bölümler yatay kayan hap şeridinde (seçili olan görünür kalır)
  const stripMenu = (
    <nav aria-label="Yönetim" className="max-md:hidden lg:hidden">
      <div ref={strip} className={cn('lp-menu', RAIL_FADE)}>
        {sections.map((x) => sectionLink(x, false))}
      </div>
    </nav>
  );
  // Sütunun dibi (shadcn'in SidebarFooter'ı): kasaya dönüş ve sıkı görünüm
  const tools = (
    <div className="flex w-full items-center gap-1 border-t border-[var(--admin-border)] pt-2 max-md:hidden">
      <Link to={home} className={cn(ROW_ICON, 'flex-1 justify-start gap-2.5 rounded-[0.625rem] px-2.5 text-sm font-medium text-[var(--admin-text-soft)] hover:bg-hover pointer-fine:min-h-9')}>
        <ArrowLeftRight className="size-4 shrink-0" aria-hidden="true" />
        Kasa ekranlarına dön
      </Link>
      {/* Aç-kapa düğmesi: adı sabit, durumu aria-pressed ve gri zemin söyler; yalnız fareyle etkili */}
      <button
        type="button"
        onClick={toggleCompact}
        aria-pressed={compact}
        aria-label="Sıkı görünüm"
        title={compact ? 'Sıkı görünüm açık' : 'Sıkı görünüm'}
        className={cn(ROW_ICON, 'hidden rounded-[0.625rem] hover:bg-hover pointer-fine:inline-flex pointer-fine:min-h-9 pointer-fine:min-w-9', compact && 'bg-[var(--menu-active-bg)] text-[var(--menu-active-ink)] hover:bg-[var(--menu-active-bg)]')}
      >
        <Rows4 className="size-4" aria-hidden="true" />
      </button>
    </div>
  );

  return (
    <div className="flex h-full min-h-0 flex-col text-[var(--admin-text)]">
      {/* Telefonda (ana ekrandan açılınca) çentik ve saat başlığın üstünde kalır */}
      <header className="flex min-h-14 shrink-0 items-center gap-2 bg-[var(--admin-bg)] px-2 pt-[env(safe-area-inset-top)] md:hidden">
        {back ? (
          <Link to="/yonetim" aria-label="Yönetim listesi" className={ROW_ICON}>
            <ChevronLeft className="size-5" />
          </Link>
        ) : (
          <LafTile size="sm" className="ml-1.5" />
        )}
        <p className={cn('min-w-0 flex-1 truncate font-headline text-[17px] font-bold tracking-[-0.025em]', !back && 'pl-1')}>{current?.label ?? title}</p>
        <button type="button" onClick={() => setPalette(true)} className={ROW_ICON} aria-label="Ara ya da git">
          <Search className="size-[18px] shrink-0" aria-hidden="true" />
        </button>
        {/* Canlı bağlantı: sağlıklıyken yalnız ekran okuyucuya; kopunca yazıyla söylenir (renk tek başına durum taşımaz) */}
        <span role="status" aria-live="polite" className="inline-flex shrink-0">
          {live === 'kopuk' ? (
            <Badge tone="danger" title="Canlı güncellemeler gelmiyor; bağlantı gelince kendiliğinden yenilenir">
              <WifiOff aria-hidden="true" className="size-3" />
              Kopuk
            </Badge>
          ) : (
            <span className="sr-only">{live === 'canli' ? 'Canlı bağlantı' : 'Bağlanıyor…'}</span>
          )}
        </span>
        <button type="button" onClick={() => setUserMenu(true)} aria-label={`${me.name} menüsü`} className="grid size-11 shrink-0 place-items-center">
          <Avatar name={me.name} color={me.color} />
        </button>
      </header>
      <Stage
        // shadcn düzeni: sol sütun yalnız gezinme (menü ve dipte kasaya dönüş); sayfanın başlığı, açıklaması ve eylemleri
        // yaprağın başında. Telefonda başlığı kabuğun kendi şeridi yazar (PageHeader'ın h1'i ekran okuyucuda)
        headerInLeaf
        className="min-h-0 flex-1"
        menu={
          <>
            {columnMenu}
            {stripMenu}
          </>
        }
        actions={tools}
        leafClassName="scroll-thin @container"
      >
        <div className="px-4 pb-10 pt-5 sm:px-5 lg:px-7 lg:pt-6">{children}</div>
      </Stage>
    </div>
  );
}
