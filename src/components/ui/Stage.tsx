import { createContext, type ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { TopTabsSlot } from '@/components/shellSlots';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/hooks';

/**
 * Sahne (pano, 20 Kasım 2026; DESIGN.md §3 "Sahne"). Zeminin üstünde ekranın başlık satırı (panonun "Welcome back"
 * satırı): solda başlık ve tek cümle durum, sağda büyük sayılar (küçük beyaz kartlar) ve eylemler (en sağda ana eylem).
 * Altında içeriğin kendi içinde kaydığı beyaz yaprak; geniş ekranda (lg) sağda ikinci dizin kartı (`aside`). Ekranın
 * sekmeleri (`menu`) tablette ve bilgisayarda üst çubuğun ortasına taşınır (TopTabsSlot, portal), telefonda başlığın
 * altında yatay hap şeridi. Ekranlar arası gezinme kabuğun marka rayında (AppShell).
 *
 * Yönetimde (`headerInLeaf`) sayfanın PageHeader'ı yaprağın başında kalır; `menu` ve `actions` geniş ekranda solda beyaz
 * alt menü kartıdır, tablette içeriğin üstünde şerit.
 *
 * Sayfanın kendi `PageHeader`'ı (ui/misc ya da admin/ui) sahnenin içindeyse başlığı ve açıklaması başlık satırına,
 * eylemleri eylemlerin yerine taşınır (portal): sayfa yapısını değiştirmeden sahneye girer.
 */

export interface HeroItem {
  label: ReactNode;
  value: ReactNode;
  /** Rakamın rengi yalnız anlam taşıyınca: magenta zamanı daralan, yeşil olumlu, amber uyarı, kırmızı hata */
  tone?: 'signal' | 'ok' | 'warn' | 'bad';
  /** Tutar: sayıdan bir boy küçük (₺ ve kuruşla uzun) */
  money?: boolean;
  title?: string;
}

interface Slots {
  head: HTMLElement | null;
  actions: HTMLElement | null;
}
const StageSlots = createContext<Slots | null>(null);

/** Ekranın başlığı: Inter kalın, sıkı aralık (büyük harf yok; panonun "Welcome back" başlığı) */
export function StageTitle({ children, className, as: Tag = 'h1', id }: { children: ReactNode; className?: string; as?: 'h1' | 'h2' | 'p'; id?: string }) {
  return (
    <Tag id={id} className={cn('lp-name', className)}>
      {children}
    </Tag>
  );
}

/** Büyük sayılar (küçük beyaz kartlar): etiket üstte (DOM'da sonra; ekran okuyucu "5, Dolu masa" okur), sayı altta */
export function Hero({ items, className }: { items: HeroItem[]; className?: string }) {
  if (!items.length) return null;
  return (
    <div className={cn('lp-hero', className)}>
      {items.map((h, i) => (
        <div key={i} className="lp-hs" data-tone={h.tone} data-money={h.money ? '' : undefined} title={h.title}>
          <b className="tabular">{h.value}</b>
          <span>{h.label}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * Ekranın sekmeleri (panonun üst sekmeleri): tablette ve bilgisayarda üst çubuğun ortasında, telefonda yatay kayan hap
 * şeridi; seçili sekme açık nane zeminde yeşil. Yönetimin alt menü kartında alt alta. Öğeler sayfanın kendi düğmesi ya da bağlantısıdır:
 * `className="lp-menu-item"`, seçili olanda `aria-current` (bağlantı), `aria-selected` (sekme) ya da `aria-pressed`
 * (düğme); sayı `<span className="n">` içinde, grup başlığı `<span className="lp-menu-label">`
 */
export function StageMenu({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <nav aria-label={label} className="min-w-0">
      <div className={cn('lp-menu', className)}>{children}</div>
    </nav>
  );
}

export function Stage({
  name,
  sub,
  hero,
  actions,
  menu,
  visual,
  aside,
  bar,
  side = true,
  headerInLeaf,
  bare,
  float,
  leafLabel,
  leafClassName,
  className,
  children,
}: {
  /** Ekranın başlığı (sayfanın PageHeader'ı da verebilir) */
  name?: ReactNode;
  sub?: ReactNode;
  hero?: HeroItem[];
  actions?: ReactNode;
  menu?: ReactNode;
  /** Tek görsel (kadran): geniş ekranda sağdaki ikinci dizin kartının başında */
  visual?: ReactNode;
  /** İkinci dizin (masasız siparişler): geniş ekranda sağda kart, darda sayfa yaprağa koyar */
  aside?: ReactNode;
  /** Cam çubuğun içeriği */
  bar?: ReactNode;
  /** Başlık satırı yok: yaprak tam en (bar ekranı) */
  side?: boolean;
  /**
   * Sayfanın PageHeader'ı yaprağın başında kalır; `menu` ve `actions` alt menü kartıdır (yönetim: geniş ekranda solda
   * beyaz kart, tablette şerit)
   */
  headerInLeaf?: boolean;
  /** Yaprak zeminsiz: içerik sahnenin üstünde kendi kartlarını çizer */
  bare?: boolean;
  /**
   * Pano yaprağı: zeminsiz ama kendi içinde kayar; kartlar zeminde yüzer (beyaz, köşe 24, kenarsız, yumuşak gölge).
   * Patron paneli, yönetim ve raporlar
   */
  float?: boolean;
  leafLabel?: string;
  leafClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  // Sayfanın PageHeader'ı buraya taşınır: başlık ve açıklama başlık satırının soluna, eylemler sağına
  const [head, setHead] = useState<HTMLElement | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const slots: Slots | null = side && !headerInLeaf ? { head, actions: actionSlot } : null;
  // Ekranın sekmeleri tablette ve bilgisayarda üst çubuğun ortasında (kabuk varsa); telefonda başlığın altında şerit
  const topTabs = useContext(TopTabsSlot);
  const wide = useMediaQuery('(min-width: 48rem)');
  const menuNode = menu ? <div className="lp-side-menu">{menu}</div> : null;
  const menuOnTop = !!menuNode && !headerInLeaf && wide && !!topTabs;
  return (
    <div className={cn('lp-stage', side && 'lp-split', side && headerInLeaf && 'lp-nav', className)}>
      {bar && <div className="lp-glass">{bar}</div>}
      {side &&
        (headerInLeaf ? (
          // Yönetim: alt menü kartı (geniş ekranda solda), tablette içeriğin üstünde şerit; telefonda yok (kabuğun şeridi ve
          // /yonetim'in bölüm listesi), boş kutu boşluk bırakmasın
          <aside className="lp-side max-md:hidden">
            {menuNode}
            <div className="lp-actions">{actions}</div>
          </aside>
        ) : (
          <header className="lp-side">
            <div className="lp-side-head">
              {name && <StageTitle>{name}</StageTitle>}
              {sub && <p className="lp-sub">{sub}</p>}
              <div ref={setHead} className="contents" />
            </div>
            {hero && <Hero items={hero} />}
            <div ref={setActionSlot} className="lp-actions">
              {actions}
            </div>
            {menuOnTop ? createPortal(menuNode, topTabs) : menuNode}
          </header>
        ))}
      <div className="lp-body">
        <section aria-label={leafLabel} className={cn('lp-leaf', bare && 'lp-bare', float && 'lp-float', leafClassName)}>
          <StageSlots.Provider value={slots}>{children}</StageSlots.Provider>
        </section>
        {(aside || visual) && (
          <aside className="lp-side-extra">
            {visual && <div className="lp-visual">{visual}</div>}
            {aside}
          </aside>
        )}
      </div>
    </div>
  );
}

/**
 * Sayfa başlığı sahnenin içindeyse sol sütuna taşınır (portal); değilse null ve başlık yerinde çizilir. `children`
 * (başlığın altındaki sekme ya da not) yerinde kalır
 */
export function useStageHeader({ title, subtitle, actions, compactOnPhone }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; compactOnPhone?: boolean }): ReactNode | null {
  const slots = useContext(StageSlots);
  if (!slots?.head) return null;
  return (
    <>
      {createPortal(
        <>
          <StageTitle>{title}</StageTitle>
          {/* compactOnPhone: telefonda açıklama da yok (üst şerit ve sekmeler yeter) */}
          {subtitle && <p className={cn('lp-sub', compactOnPhone && 'max-md:hidden')}>{subtitle}</p>}
        </>,
        slots.head,
      )}
      {actions && slots.actions && createPortal(actions, slots.actions)}
    </>
  );
}

/** Yaprağın içinde mi (sayfa başlığı taşındı mı): yaprak içi düzen buna göre üst boşluk bırakır */
export function useInStage(): boolean {
  return useContext(StageSlots)?.head != null;
}
