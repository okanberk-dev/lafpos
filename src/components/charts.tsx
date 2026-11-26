import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './ui/misc';

/**
 * Grafikler (dataviz kuralları; AsilPOS Keel, 22 Kasım 2026): raporlar, yönetim özeti ve patron paneli aynı dili kullanır.
 * Tek seri, sütunlar gri bağlam (`--chart-soft`) ve tek vurgulu sütun nane (`--chart-hi`: en yüksek değer ya da
 * sayfanın seçtiği; üstünde nane değer hapı ve beyaz nokta), çizgi ve lejant `--chart-accent`, ödeme türleri her yerde
 * aynı renkte (`--k-pay-*`), değişim hapı tek (`Delta`/`KPill`), kıyas
 * serisi gri ve ince, tek eksen, sütun en çok 36 px, uçları 6 px yuvarlak ve tabanda düz, ızgara 1 px ve geride. Değer ipucu
 * fareyle üzerine gelince, dokunmatikte dokununca ya da parmak yana kayınca (başka yere dokunana dek durur), klavyede
 * oklarla açılır; ekran okuyucu aynı değerleri gizli tablodan okur. Renkler CSS değişkenlerinden gelir, koyu temada
 * kendi adımları var.
 */


/**
 * 1-2-2,5-5 dizisinden adım: eksen değerleri yuvarlak olsun (100, 200, 250…). 2,5 yalnız onluk ve üstünde (25, 250);
 * birler basamağında 2 olur, eksende kesirli etiket çıkmaz (2,5 ₺ ya da 7,5 dk)
 */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? (exp >= 10 ? 2.5 : 2) : f <= 5 ? 5 : 10) * exp;
}

/** Ekseni gösterim biriminde (₺, dakika) kurar; döndürülen değerler ham birimde (kuruş, saniye) */
function niceScale(maxRaw: number, divisor: number, targetTicks = 4) {
  const maxDisplay = Math.max(1, maxRaw / divisor);
  // Eksende kesirli adım olmasın (0,3 ₺ gibi)
  const step = Math.max(1, niceStep(maxDisplay / targetTicks));
  const top = Math.ceil(maxDisplay / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v * divisor);
  return { max: top * divisor, ticks };
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

/**
 * Sütunun üst köşesi belirteçten (--r-bar, index.css): kasa ekranlarında 4 px, kurumsal yüzeyde (yönetim, raporlar)
 * köşesiz. SVG yolu JavaScript'te çizildiği için değer kabın hesaplanmış stilinden okunur
 */
function useBarRadius(ref: { current: HTMLElement | null }, width: number): number {
  const [radius, setRadius] = useState(4);
  useEffect(() => {
    if (!ref.current) return;
    const v = parseFloat(getComputedStyle(ref.current).getPropertyValue('--r-bar'));
    setRadius(Number.isFinite(v) ? v : 4);
  }, [ref, width]);
  return radius;
}

export interface ColumnDatum {
  label: string;
  /** İpucunda etiket yerine (ör. "06:00 · ertesi gün") */
  title?: string;
  value: number;
  compare?: number | null;
}

/** İpucunun genişliği (etiket ve "Ortalama süre" satırı): sağ kenara bu kadar yakın sütunda ipucu sağa yaslanır */
const TIP_WIDTH = 190;

export function ColumnChart({
  data,
  format,
  seriesLabel,
  compareLabel,
  height = 220,
  ariaLabel,
  unitDivisor = 100,
  empty: emptyProp,
  emptyLabel = 'Bu dönemde satış yok',
  emptyHint,
  highlight = 'max',
  pillFormat,
}: {
  data: ColumnDatum[];
  format: (v: number) => string;
  seriesLabel: string;
  compareLabel?: string;
  height?: number;
  ariaLabel: string;
  /** Eksen adımının birimi: kuruştan liraya 100 (varsayılan), saniyeden dakikaya 60 */
  unitDivisor?: number;
  /** Eski dikey eksenin etiketi; Keel grafiğinde dikey eksen yok, değer çipte ve ipucunda (çağıranlar bozulmasın diye durur) */
  tickFormat?: (raw: number) => string;
  /** Boş durum sayfadan: değerler sıfıra yuvarlansa da veri varsa (1 saniyelik hazırlama) grafik çizilir */
  empty?: boolean;
  /**
   * Veri yokken ekranın zamanını söyleyen boş durum: "Bugün henüz satış yok", "Bu günde satış yok",
   * "Bu dönemde hazırlanan kalem yok". "Veri" denmez
   */
  emptyLabel?: string;
  emptyHint?: string;
  /**
   * Vurgulu sütun (ev yeşili, üstünde değer hapı): en yüksek değer (varsayılan), sayfanın verdiği sıra (şimdiki saat) ya
   * da yok. Üzerine gelinen ya da oklarla seçilen sütun vurguyu alır
   */
  highlight?: number | 'max' | null;
  /** Değer hapının yazısı (kısa tutar: "₺5.175"); verilmezse format */
  pillFormat?: (v: number) => string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const barRadius = useBarRadius(ref, width);
  const [hover, setHover] = useState<number | null>(null);
  // Klavyeyle gezilen değer ekran okuyucuya da söylenir (fareyle gezinti sessiz)
  const [said, setSaid] = useState('');
  // Veri yenilenip sütun sayısı değişince eski seçim yok sayılır (sütunlar soluk kalmasın)
  const active = hover != null && hover < data.length ? hover : null;
  const empty = emptyProp ?? data.every((d) => !d.value && !d.compare);
  // Hep sıfır kıyas (geçen hafta satış yok; saat dolgusu 0) çizilmez: eksende düz gri çizgi, açıklama ve ipucu satırı olmaz
  const hasCompare = !!compareLabel && data.some((d) => (d.compare ?? 0) > 0);
  const scale = niceScale(Math.max(1, ...data.map((d) => Math.max(d.value, d.compare ?? 0))), unitDivisor);
  const max = scale.max;
  // Vurgulu sütun: sayfanın verdiği sıra ya da en yüksek değer; değeri sıfırsa vurgu yok
  const maxAt = data.reduce((best, d, i) => (d.value > (data[best]?.value ?? 0) ? i : best), 0);
  const pinned = highlight === 'max' ? maxAt : highlight;
  const pin = pinned != null && pinned >= 0 && pinned < data.length && data[pinned].value > 0 ? pinned : null;
  const padL = 6;
  const padR = 6;
  // Vurgulu sütunun yüzen çipine yer (değer ve altında etiket): en yüksek sütunun üstünde de sığar
  const padT = pin != null ? 56 : 10;
  // Eksen hapları (22 px) ve çubuklarla arasındaki boşluk
  const padB = 34;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const band = data.length ? plotW / data.length : 0;
  // Keel'in ince çubukları: her sütun yan yana ince şeritler (en çok 6); dar bantta şerit azalır, en az bir şerit kalır
  const stripeW = band >= 48 ? 3 : 2;
  const stripeGap = stripeW;
  const stripes = Math.max(1, Math.min(6, Math.floor((band * 0.8 + stripeGap) / (stripeW + stripeGap))));
  const barW = stripes * stripeW + (stripes - 1) * stripeGap;
  const base = padT + plotH;
  const y = (v: number) => base - (v / max) * plotH;
  // Eksen etiketi hap içinde; haplar üst üste binmesin diye en geniş etikete göre seyreltilir
  const pillW = (t: string) => Math.max(26, t.length * 6.4 + 14);
  const labelEvery = Math.max(1, Math.ceil((Math.max(0, ...data.map((d) => pillW(d.label))) + 6) / Math.max(1, band)));

  const comparePath = useMemo(() => {
    if (!hasCompare) return '';
    return data
      .map((d, i) => (d.compare == null ? null : `${padL + band * i + band / 2},${y(d.compare)}`))
      .filter(Boolean)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`)
      .join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hasCompare, band, max, plotH]);

  // Dokunmatikte ipucu dokunulan sütunda kalır: grafiğin dışına dokunmak ya da Escape kapatır
  useEffect(() => {
    if (hover == null) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setHover(null);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setHover(null);
    };
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [hover, ref]);

  const describe = (d: ColumnDatum) => `${d.title ?? d.label}: ${format(d.value)}${hasCompare && d.compare != null ? `, ${compareLabel} ${format(d.compare)}` : ''}`;

  /**
   * İmlecin ya da parmağın altındaki sütun. Telefonda 24 saatlik grafikte sütun 11 px'e iner: dokunmatikte grafiğin
   * tamamı tek hedeftir (eksen yazısının üstü en yakın sütuna), farede yalnız çizim alanı
   */
  const columnAt = (clientX: number, touch: boolean): number | null => {
    const el = ref.current;
    if (!el || band <= 0) return null;
    const i = Math.floor((clientX - el.getBoundingClientRect().left - padL) / band);
    if (touch) return Math.min(data.length - 1, Math.max(0, i));
    return i >= 0 && i < data.length ? i : null;
  };

  /** Sol ve sağ ok sütunlar arasında gezer, Home ve End uçlara gider */
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!data.length) return;
    const last = data.length - 1;
    let next: number;
    if (e.key === 'ArrowRight') next = active == null ? 0 : Math.min(last, active + 1);
    else if (e.key === 'ArrowLeft') next = active == null ? last : Math.max(0, active - 1);
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = last;
    else return;
    e.preventDefault();
    setHover(next);
    setSaid(describe(data[next]));
  };

  if (empty) {
    // Grafik yüksekliğinde (veri gelince kart zıplamasın); kesik çerçeve yok (bırakma alanı çağrışımı)
    return (
      <div role="img" aria-label={`${ariaLabel}: ${emptyLabel}`} className="grid place-items-center rounded-xl bg-surface-2" style={{ height }}>
        <EmptyState compact art="affogato" title={emptyLabel}>
          {emptyHint}
        </EmptyState>
      </div>
    );
  }
  const tip = active != null ? data[active] : undefined;
  const center = active != null ? padL + band * active + band / 2 : 0;
  return (
    <div className="w-full">
      {hasCompare && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--chart-hi)' }} />
            {seriesLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: 'var(--chart-context)' }} />
            {compareLabel}
          </span>
        </div>
      )}
      {/* Klavye odağı grafiğin kendisinde: oklar ipucunu sütundan sütuna taşır, odak çıkınca kapanır. Fare ve kalem
          üzerine gelince gösterir, çıkınca kapatır. Dokunmatikte dokunuş gösterir, parmak yana kaydıkça altındaki sütuna
          geçer (dikey kaydırma ve yakınlaştırma sayfanın: touch-action pan-y pinch-zoom); parmak kalkınca gelen
          pointerleave ipucunu silmez, kaydırmaya dönen dokunuş (pointercancel) siler */}
      <div
        ref={ref}
        tabIndex={0}
        role="img"
        aria-label={`${ariaLabel}; değerler için sol ve sağ ok tuşları`}
        onKeyDown={onKeyDown}
        onBlur={() => setHover(null)}
        onPointerDown={(e) => setHover(columnAt(e.clientX, e.pointerType === 'touch'))}
        onPointerMove={(e) => setHover(columnAt(e.clientX, e.pointerType === 'touch'))}
        onPointerLeave={(e) => e.pointerType !== 'touch' && setHover(null)}
        onPointerCancel={() => setHover(null)}
        // contain: inline-size: kabın genişliği içeriğinden (ölçülen eski genişlikte çizilmiş SVG) değil, yerleşimden gelir;
        // tek sütunlu ızgarada grafik izini genişletip sayfayı yana taşırmaz (telefonda 3 px, Genel bakış)
        className="relative w-full touch-pan-y touch-pinch-zoom rounded-lg [contain:inline-size]"
        style={{ height }}
      >
        {width > 0 && (
          <svg width={width} height={height} aria-hidden="true" className="block">
            {/* Taban: kesik ince çizgi (Keel'de ızgara ve dikey eksen yok; değerler çipte, ipucunda ve gizli tabloda) */}
            <line x1={padL} x2={width - padR} y1={base + 0.5} y2={base + 0.5} stroke="var(--k-line-strong)" strokeWidth={1} strokeDasharray="1 4" strokeLinecap="round" />
            {data.map((d, i) => {
              const x0 = padL + band * i + (band - barW) / 2;
              const h = d.value > 0 ? Math.max(3, base - y(d.value)) : 1.5;
              // Vurgu: üzerine gelinen sütun, yoksa sabit vurgulu sütun nane; ötekiler gri bağlam
              const on = active != null ? active === i : pin === i;
              const r = Math.min(barRadius, 1.5, stripeW / 2);
              const w = pillW(d.label);
              const cx = padL + band * i + band / 2;
              const px = Math.min(Math.max(0, cx - w / 2), Math.max(0, width - w));
              return (
                <g key={i}>
                  {Array.from({ length: stripes }, (_, k) => (
                    <rect key={k} x={x0 + k * (stripeW + stripeGap)} y={base - h} width={stripeW} height={h} rx={r} fill={on ? 'var(--chart-hi)' : 'var(--chart-soft)'} opacity={d.value > 0 || on ? 1 : 0.55} />
                  ))}
                  {i % labelEvery === 0 && (
                    <>
                      <rect x={px} y={height - 23} width={w} height={22} rx={11} fill={on ? 'var(--chart-hi)' : 'var(--k-well-2)'} />
                      <text x={px + w / 2} y={height - 8} textAnchor="middle" fontSize={11} fontWeight={500} fill={on ? 'var(--chart-on-hi)' : 'var(--k-ink-2)'} className="tabular">
                        {d.label}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
            {hasCompare && <path d={comparePath} fill="none" stroke="var(--chart-context)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />}
            {/* Vurgulu sütunun yüzen çipi (Keel): beyaz kart, iri değer ve altında etiket; üzerine gelinince ipucu bu işi yapar */}
            {active == null &&
              pin != null &&
              (() => {
                const cx = padL + band * pin + band / 2;
                const text = (pillFormat ?? format)(data[pin].value);
                const cap = data[pin].title ?? data[pin].label;
                const w = Math.max(60, Math.max(text.length * 8.4, cap.length * 5.9) + 24);
                const left = Math.min(Math.max(0, cx - w / 2), Math.max(0, width - w));
                const top = Math.max(2, y(data[pin].value) - 52);
                return (
                  <g style={{ filter: 'drop-shadow(0 10px 18px rgb(23 26 38 / 0.16))' }}>
                    <rect x={left} y={top} width={w} height={44} rx={10} fill="var(--surface-raised)" />
                    <text x={left + w / 2} y={top + 19} textAnchor="middle" fontSize={14.5} fontWeight={600} fill="var(--ink)" className="tabular">
                      {text}
                    </text>
                    <text x={left + w / 2} y={top + 35} textAnchor="middle" fontSize={10.5} fill="var(--muted)">
                      {cap}
                    </text>
                  </g>
                );
              })()}
            {hasCompare &&
              data.map((d, i) =>
                d.compare == null || active !== i ? null : (
                  <circle key={`c${i}`} cx={padL + band * i + band / 2} cy={y(d.compare)} r={4} fill="var(--chart-context)" stroke="var(--surface)" strokeWidth={2} />
                ),
              )}
          </svg>
        )}
        {tip && width > 0 && (
          <div
            className="pointer-events-none absolute top-0 z-10 min-w-36 whitespace-nowrap rounded-xl border border-line bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-[var(--shadow-pop)] dark:border-[var(--admin-border-strong)]"
            style={center + TIP_WIDTH - 72 > width ? { right: 0 } : { left: Math.max(0, center - 72) }}
          >
            <div className="font-semibold text-ink">{tip.title ?? tip.label}</div>
            <div className="mt-1 flex items-center justify-between gap-3 text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--chart-hi)' }} />
                {seriesLabel}
              </span>
              <span className="tabular font-semibold text-ink">{format(tip.value)}</span>
            </div>
            {hasCompare && tip.compare != null && (
              <div className="flex items-center justify-between gap-3 text-ink-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded" style={{ background: 'var(--chart-context)' }} />
                  {compareLabel}
                </span>
                <span className="tabular">{format(tip.compare)}</span>
              </div>
            )}
          </div>
        )}
      </div>
      <span className="sr-only" aria-live="polite">
        {said}
      </span>
      {/* Ekran okuyucu için değerler: çizimin kendisi bir görüntü, rakamlar burada */}
      <table className="sr-only">
        <caption>{ariaLabel}</caption>
        <thead>
          <tr>
            <td />
            <th scope="col">{seriesLabel}</th>
            {hasCompare && <th scope="col">{compareLabel}</th>}
          </tr>
        </thead>
        <tbody>
          {data.map((d, i) => (
            <tr key={i}>
              <th scope="row">{d.title ?? d.label}</th>
              <td>{format(d.value)}</td>
              {hasCompare && <td>{d.compare == null ? '—' : format(d.compare)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Yatay çubuk listesi: sıralama ve pay (ödeme türleri, kategoriler, ürünler). Tek renk, değer uçta; sıfır çubuk çizilmez */
export function BarList({
  items,
  format,
  max,
  className,
}: {
  /** `color`: çubuğun rengi (ödeme türü gibi anlamı olan renk); verilmezse grafiğin vurgusu */
  items: { key: string; label: string; value: number; sub?: string; color?: string }[];
  format: (v: number) => string;
  max?: number;
  className?: string;
}) {
  const top = max ?? Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className={cn('space-y-2.5', className)}>
      {items.map((it) => (
        <li key={it.key} className="group" title={`${it.label}: ${format(it.value)}${it.sub ? ` · ${it.sub}` : ''}`}>
          <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
            <span className="truncate text-ink">{it.label}</span>
            <span className="tabular shrink-0 font-semibold text-ink">
              {format(it.value)}
              {it.sub && <span className="ml-1.5 text-xs font-normal text-muted">{it.sub}</span>}
            </span>
          </div>
          <div className="h-2 w-full rounded-[var(--r-track)]" style={{ background: 'var(--chart-track)' }}>
            <div className="h-2 rounded-[var(--r-track)] transition-[width] group-hover:brightness-110" style={{ width: `${it.value > 0 ? Math.max(1, (it.value / top) * 100) : 0}%`, background: it.color ?? 'var(--chart-hi)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
