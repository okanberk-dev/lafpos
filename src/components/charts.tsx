import { useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { EmptyState } from './ui/misc';

/**
 * Grafikler (dataviz kuralları): tek seri tek renk (birincil mavi), kıyas serisi gri ve ince (vurgu biçimi),
 * tek eksen, sütun en çok 24 px, uçları 4 px yuvarlak ve tabanda düz, ızgara 1 px ve geride, değer etiketi
 * seçici, her işarette üzerine gelince ipucu. Renkler CSS değişkenlerinden gelir, koyu temada kendi adımları var.
 */

const compact = new Intl.NumberFormat('tr-TR', { notation: 'compact', maximumFractionDigits: 1 });

/** 1-2-2,5-5 dizisinden adım: eksen değerleri yuvarlak olsun (100, 200, 300…) */
function niceStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / exp;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * exp;
}

/** Ekseni gösterim biriminde (₺) kurar; döndürülen değerler ham birimde (kuruş) */
function niceScale(maxRaw: number, divisor: number, targetTicks = 4) {
  const maxDisplay = Math.max(1, maxRaw / divisor);
  // Tutar ekseninde kesirli adım olmasın (0,3 ₺ gibi)
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

export interface ColumnDatum {
  label: string;
  /** İpucunda etiket yerine (ör. "06:00 · ertesi gün") */
  title?: string;
  value: number;
  compare?: number | null;
}

export function ColumnChart({
  data,
  format,
  seriesLabel,
  compareLabel,
  height = 220,
  ariaLabel,
  unitDivisor = 100,
  emptyLabel = 'Bu dönemde satış yok',
  emptyHint,
}: {
  data: ColumnDatum[];
  format: (v: number) => string;
  seriesLabel: string;
  compareLabel?: string;
  height?: number;
  ariaLabel: string;
  /** Eksen değerlerini kuruştan liraya çevirmek için */
  unitDivisor?: number;
  /**
   * Veri yokken ekranın zamanını söyleyen boş durum: "Bugün henüz satış yok", "Bu günde satış yok",
   * "Bu dönemde hazırlanan kalem yok". "Veri" denmez
   */
  emptyLabel?: string;
  emptyHint?: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const empty = data.every((d) => !d.value && !d.compare);
  const hasCompare = !!compareLabel && data.some((d) => d.compare != null);
  const scale = niceScale(Math.max(1, ...data.map((d) => Math.max(d.value, d.compare ?? 0))), unitDivisor);
  const max = scale.max;
  const padL = 44;
  const padR = 8;
  const padT = 10;
  const padB = 24;
  const plotW = Math.max(0, width - padL - padR);
  const plotH = height - padT - padB;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(3, Math.min(24, band * 0.62));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = scale.ticks;
  const labelEvery = Math.max(1, Math.ceil(28 / Math.max(1, band)));

  const comparePath = useMemo(() => {
    if (!hasCompare) return '';
    return data
      .map((d, i) => (d.compare == null ? null : `${padL + band * i + band / 2},${y(d.compare)}`))
      .filter(Boolean)
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${p}`)
      .join(' ');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, hasCompare, band, max, plotH]);

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
  return (
    <div className="w-full">
      {hasCompare && (
        <div className="mb-2 flex flex-wrap gap-4 text-xs text-ink-2">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm" style={{ background: 'var(--chart-accent)' }} />
            {seriesLabel}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-0.5 w-4 rounded" style={{ background: 'var(--chart-context)' }} />
            {compareLabel}
          </span>
        </div>
      )}
      <div ref={ref} className="relative w-full" style={{ height }}>
        {width > 0 && (
          <svg width={width} height={height} role="img" aria-label={ariaLabel} className="block">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={padL} x2={width - padR} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth={1} />
                <text x={padL - 6} y={y(t) + 4} textAnchor="end" fontSize={11} fill="var(--muted)" className="tabular">
                  {compact.format(t / unitDivisor)}
                </text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = padL + band * i + (band - barW) / 2;
              const top = y(d.value);
              const h = padT + plotH - top;
              const r = Math.min(4, h, barW / 2);
              const path =
                h <= 0
                  ? ''
                  : `M${x},${padT + plotH} L${x},${top + r} Q${x},${top} ${x + r},${top} L${x + barW - r},${top} Q${x + barW},${top} ${x + barW},${top + r} L${x + barW},${padT + plotH} Z`;
              return (
                <g key={i}>
                  {path && <path d={path} fill="var(--chart-accent)" opacity={hover == null || hover === i ? 1 : 0.55} />}
                  {i % labelEvery === 0 && (
                    <text x={padL + band * i + band / 2} y={height - 6} textAnchor="middle" fontSize={11} fill="var(--muted)">
                      {d.label}
                    </text>
                  )}
                </g>
              );
            })}
            {hasCompare && <path d={comparePath} fill="none" stroke="var(--chart-context)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />}
            {hasCompare &&
              data.map((d, i) =>
                d.compare == null || hover !== i ? null : (
                  <circle key={`c${i}`} cx={padL + band * i + band / 2} cy={y(d.compare)} r={4} fill="var(--chart-context)" stroke="var(--surface)" strokeWidth={2} />
                ),
              )}
            {data.map((_, i) => (
              <rect
                key={`h${i}`}
                x={padL + band * i}
                y={padT}
                width={band}
                height={plotH}
                fill="transparent"
                onPointerEnter={() => setHover(i)}
                onPointerLeave={() => setHover((h) => (h === i ? null : h))}
                onPointerDown={() => setHover(i)}
              />
            ))}
          </svg>
        )}
        {hover != null && data[hover] && width > 0 && (
          <div
            className="pointer-events-none absolute z-10 min-w-36 rounded-xl border border-line bg-[var(--surface-raised)] px-3 py-2 text-xs shadow-[var(--shadow-pop)] dark:border-[var(--admin-border-strong)]"
            style={{ left: Math.min(width - 160, Math.max(0, padL + band * hover + band / 2 - 72)), top: 0 }}
          >
            <div className="font-semibold text-ink">{data[hover].title ?? data[hover].label}</div>
            <div className="mt-1 flex items-center justify-between gap-3 text-ink-2">
              <span className="inline-flex items-center gap-1.5">
                <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--chart-accent)' }} />
                {seriesLabel}
              </span>
              <span className="tabular font-semibold text-ink">{format(data[hover].value)}</span>
            </div>
            {hasCompare && data[hover].compare != null && (
              <div className="flex items-center justify-between gap-3 text-ink-2">
                <span className="inline-flex items-center gap-1.5">
                  <span className="h-0.5 w-3 rounded" style={{ background: 'var(--chart-context)' }} />
                  {compareLabel}
                </span>
                <span className="tabular">{format(data[hover].compare!)}</span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** Yatay çubuk listesi: sıralama ve pay (ödeme türleri, kategoriler, ürünler). Tek renk, değer uçta. */
export function BarList({
  items,
  format,
  max,
  className,
}: {
  items: { key: string; label: string; value: number; sub?: string }[];
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
          <div className="h-2 w-full rounded-full" style={{ background: 'var(--chart-track)' }}>
            <div className="h-2 rounded-full transition-[width] group-hover:brightness-110" style={{ width: `${Math.max(1, (it.value / top) * 100)}%`, background: 'var(--chart-accent)' }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Stat tile için küçük eğilim çizgisi (geçmiş gri, son nokta vurgulu) */
export function Sparkline({ values, width = 120, height = 32 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const max = Math.max(1, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => `${i * step},${height - 3 - (v / max) * (height - 6)}`);
  const last = pts[pts.length - 1].split(',').map(Number);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke="var(--chart-context)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={last[0]} cy={last[1]} r={4} fill="var(--chart-accent)" stroke="var(--surface)" strokeWidth={2} />
    </svg>
  );
}
