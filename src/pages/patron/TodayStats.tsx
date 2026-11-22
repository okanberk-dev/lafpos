import { ArrowDownRight, ArrowUpRight, CalendarRange, LineChart } from 'lucide-react';
import { type KeyboardEvent, type PointerEvent, type ReactNode, useLayoutEffect, useRef, useState } from 'react';
import { tl, tlShort } from '@shared/money';
import { fmtTime } from '@shared/time';
import { type Compare, dayLabel, monthName, type Period, type todayStats } from '@shared/today-stats';
import { Badge } from '@/components/ui/misc';
import { cn } from '@/lib/cn';

/**
 * Patron panelinin "Bugün" kıyasları (shared/today-stats.ts hesaplar): dün, geçen hafta ve geçen ayın aynı günü; gün
 * boyu birikimli ciro (bugün ve geçen hafta aynı gün); hafta ve ay başından bugüne; gün sonu tahmini. Fark hep yazıyla:
 * ok, işaret ve yüzde (renk tek başına değil). Veri yoksa "veri yok", ₺0 değil.
 */
export type Stats = ReturnType<typeof todayStats>;

const PANEL = 'min-w-0 rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface shadow-[var(--card-shadow)]';
const pctText = (v: number) => `%${Math.abs(v).toLocaleString('tr-TR')}`;
const signed = (k: number) => `${k > 0 ? '+' : k < 0 ? '−' : ''}${tl(Math.abs(k))}`;

/** Değişim rozeti: ok, işaret ve yüzde; sıfır "değişmedi"; hesaplanamıyorsa nedeni */
export function Delta({ value, base, size = 'md' }: { value: number | null; base?: number | null; size?: 'sm' | 'md' }) {
  if (value == null) return <span className="whitespace-nowrap text-xs text-muted">{base === 0 ? 'o gün satış yoktu' : 'kıyas yok'}</span>;
  if (value === 0) return <Badge>değişmedi</Badge>;
  const up = value > 0;
  const Arrow = up ? ArrowUpRight : ArrowDownRight;
  return (
    <Badge tone={up ? 'success' : 'danger'} className={cn('tabular gap-0.5 font-semibold', size === 'md' && 'text-[13px]')}>
      <Arrow aria-hidden="true" className="size-3.5" />
      {up ? '+' : '−'}
      {pctText(value)}
      <span className="sr-only">{up ? ' arttı' : ' azaldı'}</span>
    </Badge>
  );
}

function Head({ title, sub, icon }: { title: string; sub?: ReactNode; icon: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 className="text-base font-semibold leading-6 tracking-[-0.015em]">{title}</h3>
        {sub && <p className="text-[13px] text-muted">{sub}</p>}
      </div>
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-full bg-[var(--admin-primary-soft)] text-[var(--admin-primary)] [&>svg]:size-[18px]">
        {icon}
      </span>
    </div>
  );
}

/** Kıyas satırının olmayan veri yazısı: tarih takvimde yoksa ayın adıyla, iş günü yoksa "veri yok" */
function missing(c: Compare, today: string) {
  if (c.date == null) {
    const m = Number(today.slice(5, 7));
    return `${monthName(`2000-${String(((m + 10) % 12) + 1).padStart(2, '0')}-01`)} ayında ${Number(today.slice(8))} yok`;
  }
  return 'Veri yok · kafe kapalıydı ya da LafPOS kullanılmıyordu';
}

/** Dün, geçen hafta aynı gün, geçen ay aynı gün: tutar, fark ve gün sonu */
export function CompareCard({ s, today, now }: { s: Stats; today: string; now: number }) {
  const sub = s.mode === 'live' ? `Saat ${fmtTime(now)} itibarıyla; o günler de aynı saate kadar` : s.mode === 'closed' ? 'Gün kapandı: tam gün kıyası' : 'Bugün gün açılmadı: o günlerin gün sonu';
  return (
    <section aria-label="Kıyas" className={cn(PANEL, 'p-5')}>
      <Head title="Kıyas" sub={sub} icon={<CalendarRange />} />
      <ul className="mt-3 divide-y divide-[var(--admin-divider)]">
        {s.compares.map((c) => (
          <li key={c.key} className="py-3 last:pb-0">
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 text-sm">
                <span className="font-semibold">{c.label}</span>
                {c.date && <span className="text-muted"> · {dayLabel(c.date)}</span>}
              </span>
              {c.value && s.mode !== 'none' && <Delta value={c.change} base={c.value.netSales} />}
            </div>
            {c.value ? (
              <>
                <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="tabular whitespace-nowrap font-headline text-[22px] font-bold leading-tight tracking-[-0.03em]">{tl(c.value.netSales)}</span>
                  {c.diff != null && c.diff !== 0 && (
                    <span className="tabular whitespace-nowrap text-[13px] font-medium text-ink-2">
                      <span className="sr-only">Fark </span>
                      {signed(c.diff)}
                    </span>
                  )}
                </div>
                <div className="tabular mt-0.5 text-xs text-muted">
                  {c.value.receipts} adisyon
                  {s.mode === 'live' && c.full && (
                    <>
                      {' · '}
                      <span className="whitespace-nowrap">
                        gün sonu {tlShort(c.full.netSales)}, {c.full.receipts} adisyon
                      </span>
                    </>
                  )}
                </div>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-muted">{missing(c, today)}</p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const rangeText = (from: string, to: string) => {
  const [, fm, fd] = from.split('-');
  const [, tm, td] = to.split('-');
  return fm === tm ? `${Number(fd)}-${Number(td)} ${monthName(from)}` : `${Number(fd)} ${monthName(from)} - ${Number(td)} ${monthName(to)}`;
};
const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const weekdayOf = (date: string) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

function PeriodRow({ p }: { p: Period }) {
  const prevName = p.key === 'hafta' ? 'Geçen hafta' : p.wholePrev ? `${monthName(p.prev.from)} (tamamı)` : `Geçen ay`;
  return (
    <li className="py-3">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 text-sm">
          <span className="font-semibold">{p.label}</span>
          <span className="text-muted"> · {rangeText(p.cur.from, p.cur.to)}</span>
        </span>
        <Delta value={p.change} base={p.prev.days ? p.prev.netSales : null} />
      </div>
      <div className="tabular mt-1 font-headline text-[22px] font-bold leading-tight tracking-[-0.03em]">{tl(p.cur.netSales)}</div>
      <div className="tabular mt-0.5 text-xs text-muted">
        {p.cur.receipts} adisyon · {p.cur.days} gün
        {' · '}
        <span className="whitespace-nowrap">{p.prev.days ? `${prevName} ${tlShort(p.prev.netSales)} (${rangeText(p.prev.from, p.prev.to)}, ${p.prev.days} gün)` : `${prevName}: veri yok`}</span>
      </div>
    </li>
  );
}

/** Hafta ve ay başından bugüne, gün sonu tahmini */
export function PeriodCard({ s, today }: { s: Stats; today: string }) {
  const f = s.forecast;
  return (
    <section aria-label="Dönem ve tahmin" className={cn(PANEL, 'p-5')}>
      <Head
        title="Hafta ve ay"
        sub={s.mode === 'live' ? 'Bugün dahil; önceki dönemin aynı günü aynı saate kadar' : s.mode === 'closed' ? 'Bugün dahil, tam gün' : 'Düne kadar'}
        icon={<CalendarRange />}
      />
      <ul className="mt-1 divide-y divide-[var(--admin-divider)]">
        {s.periods.map((p) => (
          <PeriodRow key={p.key} p={p} />
        ))}
        {!s.periods.length && <li className="py-3 text-[13px] text-muted">Hafta ve ay bugün başlıyor; kıyas ilk satışla</li>}
        {s.mode === 'live' && (
          <li className="pb-0 pt-3">
            <div className="text-sm font-semibold">Gün sonu tahmini</div>
            {f ? (
              <>
                <div className="tabular mt-1 font-headline text-[22px] font-bold leading-tight tracking-[-0.03em]">
                  {tl(f.value)} <span className="font-sans text-xs font-medium text-muted">tahmini</span>
                </div>
                <p className="mt-0.5 text-xs text-muted">
                  {f.share >= 95
                    ? `Son ${f.days} ${weekdayOf(today)} bu saatte günü neredeyse bitirmişti; gün sonu bugünkü ciroya yakın`
                    : `Son ${f.days} ${weekdayOf(today)} bu saate kadar gün sonu cirosunun %${f.share.toLocaleString('tr-TR')} kadarını yapmıştı; bugünkü ciro bu paya bölündü`}
                </p>
              </>
            ) : (
              <p className="mt-1 text-[13px] text-muted">Tahmin için erken ya da geçmiş {weekdayOf(today)} verisi az (en az 2 gün gerekir)</p>
            )}
          </li>
        )}
      </ul>
    </section>
  );
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(([e]) => setW(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const compact = new Intl.NumberFormat('tr-TR', {
  notation: 'compact',
  maximumFractionDigits: 1,
});
const axisTl = (k: number) => `₺${compact.format(k / 100)}`;
const clock = (offset: number) => `${String((offset + 5) % 24).padStart(2, '0')}:00`;
function niceTop(max: number) {
  if (max <= 0) return 100_00;
  const mag = 10 ** Math.floor(Math.log10(max));
  const step = mag / 2;
  return Math.ceil(max / step) * step;
}

/**
 * Gün boyu ciro: bugün (gün sürerken şu ana kadar) ve geçen haftanın aynı günü birikimli, üst üste. Tek eksen; bugün ev
 * yeşili düz, geçen hafta gri kesikli; açıklama üstte, uçlarda ad; dokununca ya da oklarla saatin iki değeri
 */
export function CumulativeCard({ s, now }: { s: Stats; now: number }) {
  const c = s.curve;
  const [ref, w] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const today = c.today ?? [];
  const lw = c.lastWeek ?? [];
  // Bugünün noktaları saat başlarında; gün sürerken son nokta şu an
  const nowX = s.mode === 'live' && s.cutoffMin != null ? s.cutoffMin / 60 : null;
  const todayPts: [number, number][] = [
    ...today.map((v, i) => [i, v] as [number, number]),
    ...(nowX != null && c.todayNow != null && nowX > today.length - 1 ? [[nowX, c.todayNow] as [number, number]] : []),
  ];
  const active = (arr: number[]) => arr.findIndex((v) => v > 0);
  const firsts = [active(today), active(lw)].filter((i) => i >= 0);
  const start = Math.max(0, Math.min(2, ...firsts.map((i) => i - 1)));
  const lastRise = (arr: number[]) => arr.reduce((a, v, i) => (i > 0 && v !== arr[i - 1] ? i : a), 0);
  const end = Math.min(c.hours, Math.max(start + 8, lastRise(lw) + 1, Math.ceil(todayPts.at(-1)?.[0] ?? 0)));
  const max = Math.max(...todayPts.map((p) => p[1]), ...lw.slice(0, end + 1));
  const has = max > 0;
  const top = niceTop(max);

  const H = 220;
  const padL = 48;
  const padR = 64;
  const padT = 12;
  const padB = 26;
  const plotW = Math.max(40, w - padL - padR);
  const x = (h: number) => padL + ((h - start) / Math.max(1, end - start)) * plotW;
  const y = (v: number) => padT + (1 - v / top) * (H - padT - padB);
  const path = (pts: [number, number][]) =>
    pts
      .filter(([h]) => h >= start && h <= end)
      .map(([h, v], i) => `${i ? 'L' : 'M'}${x(h).toFixed(1)},${y(v).toFixed(1)}`)
      .join(' ');
  const lwPts = lw.map((v, i) => [i, v] as [number, number]);
  const tickEvery = end - start > 12 ? 3 : 2;
  const ticks = Array.from({ length: end - start + 1 }, (_, i) => start + i).filter((hh) => (hh + 5) % tickEvery === 0);

  // Uç etiketleri: iki uç çok yakınsa biri yukarı
  const tEnd = todayPts.filter(([h]) => h <= end).at(-1);
  const lEnd = lw.length ? ([end, lw[Math.min(end, lw.length - 1)]!] as [number, number]) : null;
  let tY = tEnd ? y(tEnd[1]) : 0;
  let lY = lEnd ? y(lEnd[1]) : 0;
  if (tEnd && lEnd && Math.abs(tY - lY) < 14) {
    if (tY <= lY) tY = lY - 14;
    else lY = tY - 14;
  }

  const hv =
    hover == null
      ? null
      : {
          h: hover,
          today: hover < today.length ? today[hover]! : null,
          lw: lw[hover] ?? null,
        };
  const pick = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const h = Math.round(start + ((e.clientX - r.left - padL) / plotW) * (end - start));
    setHover(Math.max(start, Math.min(end, h)));
  };
  const key = (e: KeyboardEvent<SVGSVGElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    setHover((cur) => Math.max(start, Math.min(end, (cur ?? end) + (e.key === 'ArrowLeft' ? -1 : 1))));
  };

  return (
    <section aria-label="Gün boyu ciro" className={cn(PANEL, 'flex flex-col p-5')}>
      <Head title="Gün boyu ciro" sub="Saat saat birikerek; geçen haftanın aynı günüyle" icon={<LineChart />} />
      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden="true" width="18" height="6">
            <line x1="1" y1="3" x2="17" y2="3" stroke="var(--chart-accent)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Bugün
          {s.mode === 'live' && c.todayNow != null ? ` · ${fmtTime(now)} itibarıyla ${tl(c.todayNow)}` : ''}
        </span>
        {c.lastWeek ? (
          <span className="inline-flex items-center gap-1.5">
            <svg aria-hidden="true" width="18" height="6">
              <line x1="1" y1="3" x2="17" y2="3" stroke="var(--chart-context)" strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            Geçen hafta aynı gün
          </span>
        ) : (
          <span className="text-muted">Geçen haftanın aynı günü: veri yok</span>
        )}
      </div>
      <div ref={ref} className="relative mt-2 min-h-[220px]">
        {!has ? (
          <p className="grid h-[220px] place-items-center text-sm text-muted">Bugün henüz kapanan adisyon yok</p>
        ) : (
          w > 0 && (
            <>
              <svg
                role="img"
                aria-label="Gün boyu birikimli ciro, bugün ve geçen hafta aynı gün; ayrıntı aşağıdaki tabloda"
                width={w}
                height={H}
                tabIndex={0}
                className="block touch-pan-y rounded-[var(--r-tile)] focus-visible:outline-2 focus-visible:outline-offset-2"
                onPointerMove={pick}
                onPointerDown={pick}
                onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(null)}
                onKeyDown={key}
                onBlur={() => setHover(null)}
              >
                {[0, 0.5, 1].map((f) => (
                  <g key={f}>
                    <line x1={padL} x2={padL + plotW} y1={y(top * f)} y2={y(top * f)} stroke="var(--chart-grid)" strokeWidth={1} />
                    <text x={padL - 8} y={y(top * f) + 4} textAnchor="end" className="fill-[var(--chart-context)] text-[11px] tabular-nums">
                      {axisTl(top * f)}
                    </text>
                  </g>
                ))}
                {ticks.map((hh) => (
                  <text key={hh} x={x(hh)} y={H - 6} textAnchor="middle" className="fill-[var(--chart-context)] text-[11px] tabular-nums">
                    {clock(hh).slice(0, 2)}
                  </text>
                ))}
                {lw.length > 0 && <path d={path(lwPts)} fill="none" stroke="var(--chart-context)" strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />}
                {todayPts.length > 0 && <path d={path(todayPts)} fill="none" stroke="var(--chart-accent)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" />}
                {tEnd && <circle cx={x(tEnd[0])} cy={y(tEnd[1])} r={4} fill="var(--chart-accent)" stroke="var(--surface)" strokeWidth={2} />}
                {tEnd && (
                  <text x={x(tEnd[0]) + 8} y={tY + 4} className="fill-[var(--ink)] text-[11px] font-semibold">
                    Bugün
                  </text>
                )}
                {lEnd && (
                  <text x={x(lEnd[0]) + 8} y={lY + 4} className="fill-[var(--chart-context)] text-[11px]">
                    Geçen hf.
                  </text>
                )}
                {hv && <line x1={x(hv.h)} x2={x(hv.h)} y1={padT} y2={H - padB} stroke="var(--chart-context)" strokeWidth={1} />}
              </svg>
              {hv && (
                <div
                  aria-live="polite"
                  className="pointer-events-none absolute top-1 z-10 rounded-[var(--r-tile)] border border-[var(--card-line)] bg-surface px-3 py-2 text-xs shadow-[var(--card-shadow)]"
                  style={x(hv.h) > w / 2 ? { right: w - x(hv.h) + 8 } : { left: x(hv.h) + 8 }}
                >
                  <div className="font-semibold">Saat {clock(hv.h)} itibarıyla</div>
                  <div className="tabular mt-0.5">Bugün {hv.today != null ? tl(hv.today) : '—'}</div>
                  {c.lastWeek && <div className="tabular text-muted">Geçen hafta {hv.lw != null ? tl(hv.lw) : '—'}</div>}
                </div>
              )}
            </>
          )
        )}
      </div>
      {has && (
        <table className="sr-only">
          <caption>Gün boyu birikimli ciro</caption>
          <thead>
            <tr>
              <th scope="col">Saat</th>
              <th scope="col">Bugün</th>
              <th scope="col">Geçen hafta aynı gün</th>
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: end - start + 1 }, (_, i) => start + i).map((hh) => (
              <tr key={hh}>
                <th scope="row">{clock(hh)}</th>
                <td>{hh < today.length ? tl(today[hh]!) : '—'}</td>
                <td>{lw[hh] != null ? tl(lw[hh]!) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
