import { createContext, type ReactNode, useContext, useState } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/cn';

/**
 * Sahne (gnbsite Area Board UI kitinin `.sahne-sayfa`'sı, LafPOS'a uyarlandı; DESIGN.md §3 "Sahne"). Ekranı dolduran gri
 * sahne; geniş ekranda (lg) iki sütun: solda ekranın kimliği (sakin başlık ve tek cümle durum, görsel, yan menü, büyük
 * sayılar, tek ana eylem), sağda içeriğin kendi içinde kaydığı beyaz yaprak; üstte isteğe bağlı cam çubuk. Daha dar
 * ekranda tek sütun: kimlik yaprağın üstünde sıkı bir şerit, yan menü yatay kayan hap şeridi.
 *
 * Kitin dev büyük harfli adı (OPEN POSITIONS) kasada yok (17 Kasım 2026, operatör: "dev patron vs. yazmasına gerek yok"):
 * ekranın adı ölçülü bir başlıktır, üst çubukta da etkin sekme olarak görünür.
 *
 * Sayfanın kendi `PageHeader`'ı (ui/misc ya da admin/ui) sahnenin içindeyse başlığı ve açıklaması sol sütunun başına,
 * eylemleri ana eylemin yerine taşınır (portal): sayfa yapısını değiştirmeden sahneye girer.
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

/** Ekranın başlığı: Gabarito, ölçülü boy, sıkı aralık (büyük harf yok) */
export function StageTitle({ children, className, as: Tag = 'h1', id }: { children: ReactNode; className?: string; as?: 'h1' | 'h2' | 'p'; id?: string }) {
  return (
    <Tag id={id} className={cn('lp-name', className)}>
      {children}
    </Tag>
  );
}

/** Büyük sayılar: etiket üstte (DOM'da sonra; ekran okuyucu "5, Dolu masa" okur), sayı altta */
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
 * Yan menü (shadcn'in Sidebar'ı gibi sade): geniş ekranın sol sütununda alt alta satırlar (ikon, ad, sağda soluk sayı;
 * seçili satır beyaz yüzeyde), daha darda yatay kayan hap şeridi. Öğeler sayfanın kendi düğmesi ya da bağlantısıdır:
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
  /** Sol sütunun ortasındaki tek görsel (kadran); yalnız geniş ekranda */
  visual?: ReactNode;
  /** Menünün altında ikinci dizin (masasız siparişler); yalnız geniş ekranda, darda sayfa yaprağa koyar */
  aside?: ReactNode;
  /** Cam çubuğun içeriği */
  bar?: ReactNode;
  /** Sol sütun yok: yaprak tam en (bar ekranı) */
  side?: boolean;
  /**
   * Sayfanın PageHeader'ı yaprağın başında kalır, sol sütun yalnız gezinmedir (yönetim: shadcn'in Sidebar düzeni; başlık,
   * açıklama ve eylemler içeriğin üstünde)
   */
  headerInLeaf?: boolean;
  /** Yaprak zeminsiz: içerik sahnenin üstünde kendi kartlarını çizer */
  bare?: boolean;
  leafLabel?: string;
  leafClassName?: string;
  className?: string;
  children: ReactNode;
}) {
  // Sayfanın PageHeader'ı buraya taşınır: başlık ve açıklama sütunun başına (display: contents), eylemler ana eylemin yerine
  const [head, setHead] = useState<HTMLElement | null>(null);
  const [actionSlot, setActionSlot] = useState<HTMLElement | null>(null);
  const slots: Slots | null = side && !headerInLeaf ? { head, actions: actionSlot } : null;
  return (
    <div className={cn('lp-stage', side && 'lp-split', className)}>
      {bar && <div className="lp-glass">{bar}</div>}
      {side && (
        <aside className="lp-side">
          {!headerInLeaf && (
            <div className="lp-side-head">
              {name && <StageTitle>{name}</StageTitle>}
              {sub && <p className="lp-sub">{sub}</p>}
              <div ref={setHead} className="contents" />
            </div>
          )}
          {visual && <div className="lp-visual">{visual}</div>}
          {menu && <div className="lp-side-menu">{menu}</div>}
          {aside && <div className="lp-side-extra">{aside}</div>}
          {hero && <Hero items={hero} />}
          <div ref={setActionSlot} className="lp-actions">
            {actions}
          </div>
        </aside>
      )}
      <section aria-label={leafLabel} className={cn('lp-leaf', bare && 'lp-bare', leafClassName)}>
        <StageSlots.Provider value={slots}>{children}</StageSlots.Provider>
      </section>
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
