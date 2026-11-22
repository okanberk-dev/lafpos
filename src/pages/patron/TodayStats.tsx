import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode, useId, useLayoutEffect, useRef, useState } from 'react';
import { tl, tlShort } from '@shared/money';
import { fmtTime } from '@shared/time';
import { changeText, type Compare, dayLabel, monthName, type Period, type StatsMode, type todayStats } from '@shared/today-stats';
import { cn } from '@/lib/cn';

/**
 * Patron panelinin gruplanmış listesi (sahibin örneği, 22 Kas 2026: telefonun koyu "gruplanmış liste"si) ve "Bugün"
 * kıyasları (shared/today-stats.ts hesaplar). Kart: geniş köşe, ferah iç boşluk; gecede kenarsız ve gölgesiz (siyah
 * zeminden tonla ayrılır), açık temada panonun saç teli ve yumuşak gölgesi. İlk satır başlık (solda ad, sağda soluk not),
 * altında ince ayraçlı satırlar: solda soluk etiket, sağda yarı kalın tutar ve değişim hapı. Fark hep yazıyla: ok,
 * işaret ve yüzde (renk tek başına değil). Veri yoksa "veri yok", satış yoksa "satış yok"; ₺0 yazılmaz.
 */
export type Stats = ReturnType<typeof todayStats>;

export const GROUP = 'min-w-0 rounded-[var(--r-group)] border border-[var(--card-line)] bg-surface shadow-[var(--card-shadow)]';
/** Satır ayracı: kartın iç boşluğundan iç boşluğuna ince çizgi */
const ROWS = 'divide-y divide-[var(--admin-divider)]';
const ROW = 'flex min-h-[52px] w-full items-center justify-between gap-3 py-2.5 text-left';
/** Dokunulan satır (açılan ayrıntı, adisyona giden satır): üzerine gelme zemini kartın iç boşluğuna taşar, yazı hizası aynı kalır */
export const ROW_BUTTON = cn(ROW, '-mx-2 w-[calc(100%+1rem)] rounded-[var(--r-tile)] px-2 transition-colors duration-150 hover:bg-hover focus-visible:-outline-offset-2 active:bg-press');

/** Gruplanmış liste kartı: başlık satırı (solda ad, sağda soluk not ya da küçük denetim) ve içerik */
export function Group({ title, meta, label, children, footer, className, flush, style }: { title: ReactNode; meta?: ReactNode; label?: string; children: ReactNode; footer?: ReactNode; className?: string; flush?: boolean; style?: CSSProperties }) {
  return (
    <section aria-label={label ?? (typeof title === 'string' ? title : undefined)} style={style} className={cn(GROUP, 'px-5 pb-2 pt-4', className)}>
      <header className="flex min-h-7 flex-wrap items-center justify-between gap-x-3 gap-y-2 pb-1.5">
        <h3 className="text-sm font-semibold leading-5 tracking-normal text-ink-2">{title}</h3>
        {meta != null && meta !== false && <div className="tabular flex shrink-0 items-center gap-2 text-[13px] leading-5 text-muted">{meta}</div>}
      </header>
      {flush ? children : <ul className={ROWS}>{children}</ul>}
      {footer && <div className="pb-3 pt-2">{footer}</div>}
    </section>
  );
}

/**
 * Kartın başlığındaki görünüm seçici (grafik türü): sakin yazı düğmeleri, seçili olan nötr hap içinde ve kalın. Dokunma
 * hedefi 44 px (hap içeride 28 px); seçim `aria-pressed` ve ağırlıkla, renkle değil
 */
export function ViewTabs<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <div role="group" aria-label={label} className="-my-2 -mr-2 flex items-center">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className="group inline-flex min-h-9 items-center px-0.5 focus-visible:-outline-offset-2 pointer-coarse:min-h-11">
          <span className={cn('inline-flex min-h-7 items-center rounded-full px-2.5 text-[13px] leading-5 transition-colors duration-150', value === o.value ? 'bg-surface-3 font-semibold text-ink' : 'text-muted group-hover:text-ink')}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/** Soluk tek satır: boş durum ("Açık adisyon yok") */
export function QuietRow({ children }: { children: ReactNode }) {
  return <li className="flex min-h-[52px] items-center py-2.5 text-sm text-muted">{children}</li>;
}

/**
 * Değişim hapı (sahibin örneği): tam yuvarlak, yumuşak zemin; düşüşte ok aşağı ve "%63,4", artışta ok yukarı ve
 * "+%83,1"; sıfır nötr "%0". Yön ok, işaret ve gizli yazıyla (renk tek başına değil)
 */
export function Delta({ value, size = 'md' }: { value: number; size?: 'sm' | 'md' }) {
  const up = value > 0;
  const flat = value === 0;
  const Arrow = up ? ArrowUp : ArrowDown;
  return (
    <span
      className={cn(
        'tabular inline-flex shrink-0 items-center gap-0.5 whitespace-nowrap rounded-full font-medium',
        size === 'md' ? 'min-h-6 px-2 text-[13px] leading-5' : 'min-h-5 px-1.5 text-xs leading-4',
        flat ? 'bg-surface-3 text-ink-2' : up ? 'bg-success-soft text-success-ink' : 'bg-danger-soft text-danger-ink',
      )}
    >
      {!flat && <Arrow aria-hidden="true" className="size-3 stroke-[2.25]" />}
      {changeText(value)}
      <span className="sr-only">{flat ? ' değişmedi' : up ? ' arttı' : ' azaldı'}</span>
    </span>
  );
}

/** Satırın sağındaki soluk not ("satış yok", "veri yok", "gün sonu") */
export const Faint = ({ children }: { children: ReactNode }) => <span className="whitespace-nowrap text-sm text-muted">{children}</span>;

/**
 * Liste satırı: solda soluk etiket, sağda değer (tutar, hap, not). `detail` verilirse satır dokunulunca açılır
 * (ayrıntı satırın altında; kart sade kalır, bilgi kaybolmaz)
 */
export function Row({ label, sub, children, detail }: { label: ReactNode; sub?: ReactNode; children: ReactNode; detail?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const body = (
    <>
      <span className="min-w-0">
        <span className="block text-[15px] leading-5 text-muted">{label}</span>
        {sub && <span className="mt-0.5 block text-xs leading-4 text-muted">{sub}</span>}
      </span>
      <span className="flex min-w-0 shrink-0 items-center gap-2">
        {children}
        {detail && <ChevronDown aria-hidden="true" className={cn('size-4 text-muted transition-transform duration-200', open && 'rotate-180')} />}
      </span>
    </>
  );
  if (!detail) return <li className={ROW}>{body}</li>;
  return (
    <li>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} className={ROW_BUTTON}>
        {body}
      </button>
      <div id={id} hidden={!open} className="pb-3 text-[13px] leading-5 text-ink-2">
        {detail}
      </div>
    </li>
  );
}

/** Ayrıntı satırları: solda soluk ad, sağda değer */
export function Facts({ items, note }: { items: [string, ReactNode][]; note?: ReactNode }) {
  return (
    <>
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="tabular text-right font-medium text-ink">{v}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </>
  );
}

/** Tutar: yarı kalın, tablo rakamı; kuruşu yoksa kısa ("₺975") */
export const ROW_STATIC = ROW;

export const Amount = ({ k }: { k: number }) => <span className="tabular whitespace-nowrap text-[15px] font-semibold leading-5 text-ink">{tlShort(k)}</span>;

const signed = (k: number) => `${k > 0 ? '+' : k < 0 ? '−' : ''}${tl(Math.abs(k))}`;

/** Kıyas gününün olmayan verisi: tarih takvimde yoksa ayın adıyla, iş günü yoksa nedeni */
function missing(c: Compare, today: string) {
  if (c.date == null) {
    const m = Number(today.slice(5, 7));
    return `${monthName(`2000-${String(((m + 10) % 12) + 1).padStart(2, '0')}-01`)} ayında ${Number(today.slice(8))} yok`;
  }
  return 'O gün kafe kapalıydı ya da LafPOS kullanılmıyordu';
}

/**
 * Kıyas (sahibin örneğiyle aynı yapı): "Dün", "Geçen hafta bugün", "Geçen ay bugün"; sağda aynı saate kadarki tutar ve
 * değişim hapı. O gün satış yoksa "satış yok", veri yoksa "veri yok". Satıra dokununca tarih ve gün adı, gün sonu
 * toplamı, adisyon ve ₺ fark. `fresh`: başlığın sağındaki canlılık ("Az önce")
 */
export function CompareGroup({ compares, mode, today, now, fresh }: { compares: Compare[]; mode: StatsMode; today: string; now: number; fresh: ReactNode }) {
  const title = mode === 'live' ? `Kıyas · ${fmtTime(now)} itibarıyla` : mode === 'closed' ? 'Kıyas · gün sonu' : 'Kıyas · gün açılmadı';
  return (
    <Group title={title} label="Kıyas" meta={fresh}>
      {compares.map((c) => {
        const v = c.value;
        const empty = !!v && v.netSales === 0 && v.receipts === 0;
        // Gün sürerken tutar aynı saate kadar; yalnız gün sonu toplamı bilinen günde not düşülür
        const dayEnd = mode === 'live' && c.grain === 'gun';
        const facts: [string, ReactNode][] = [];
        if (v && c.date) {
          if (mode === 'live' && !dayEnd) facts.push(['Aynı saate kadar', `${tl(v.netSales)} · ${v.receipts} adisyon`]);
          if (c.full) facts.push(['Gün sonu', `${tl(c.full.netSales)} · ${c.full.receipts} adisyon`]);
          if (c.diff != null && c.diff !== 0) facts.push(['Fark', signed(c.diff)]);
        }
        const note = !v ? missing(c, today) : dayEnd ? 'O günün yalnız gün sonu toplamı biliniyor; gün sürerken yüzde hesaplanmaz' : mode === 'live' && c.grain === 'saat' ? 'O gün saat saat biliniyor: tamamlanan saatlere kadar' : undefined;
        return (
          <Row
            key={c.key}
            label={c.label}
            detail={
              <>
                {c.date && <p className="mb-1.5 font-medium text-ink">{dayLabel(c.date)}</p>}
                {facts.length > 0 && <Facts items={facts} />}
                {note && <p className={cn('text-xs text-muted', facts.length > 0 && 'mt-1.5')}>{note}</p>}
              </>
            }
          >
            {!v ? (
              <Faint>veri yok</Faint>
            ) : empty ? (
              <Faint>satış yok</Faint>
            ) : (
              <>
                <Amount k={v.netSales} />
                {c.change != null ? <Delta value={c.change} /> : dayEnd && <span className="whitespace-nowrap text-xs text-muted">gün sonu</span>}
              </>
            )}
          </Row>
        );
      })}
    </Group>
  );
}

const rangeText = (from: string, to: string) => {
  const [, fm, fd] = from.split('-');
  const [, tm, td] = to.split('-');
  return from === to ? `${Number(fd)} ${monthName(from)}` : fm === tm ? `${Number(fd)}-${Number(td)} ${monthName(from)}` : `${Number(fd)} ${monthName(from)} - ${Number(td)} ${monthName(to)}`;
};
const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];
const weekdayOf = (date: string) => DAY_NAMES[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

function PeriodRow({ p }: { p: Period }) {
  const prevName = p.key === 'hafta' ? 'Geçen hafta' : p.wholePrev ? `${monthName(p.prev.from)} (tamamı)` : 'Geçen ay';
  return (
    <Row
      label={p.label}
      detail={
        <Facts
          items={[
            [rangeText(p.cur.from, p.cur.to), `${tl(p.cur.netSales)} · ${p.cur.receipts} adisyon · ${p.cur.days} gün`],
            [p.prev.days ? `${prevName} · ${rangeText(p.prev.from, p.prev.to)}` : prevName, p.prev.days ? `${tl(p.prev.netSales)} · ${p.prev.days} gün` : 'veri yok'],
          ]}
        />
      }
    >
      <Amount k={p.cur.netSales} />
      {p.change != null && <Delta value={p.change} />}
    </Row>
  );
}

/** Hafta ve ay başından bugüne, gün sonu tahmini */
export function PeriodGroup({ s, today }: { s: Stats; today: string }) {
  const f = s.forecast;
  return (
    <Group title="Hafta ve ay" meta={s.mode === 'none' ? 'düne kadar' : 'bugün dahil'}>
      {s.periods.map((p) => (
        <PeriodRow key={p.key} p={p} />
      ))}
      {!s.periods.length && <QuietRow>Hafta ve ay bugün başlıyor; kıyas ilk satışla</QuietRow>}
      {s.mode === 'live' && (
        <Row
          label="Gün sonu tahmini"
          detail={
            <p className="text-xs text-muted">
              {f
                ? f.share >= 95
                  ? `Son ${f.days} ${weekdayOf(today)} bu saatte günü neredeyse bitirmişti; gün sonu bugünkü ciroya yakın`
                  : `Son ${f.days} ${weekdayOf(today)} bu saate kadar gün sonu cirosunun %${f.share.toLocaleString('tr-TR')} kadarını yapmıştı; bugünkü ciro bu paya bölündü`
                : `Tahmin için erken ya da geçmiş ${weekdayOf(today)} verisi az (en az 2 gün gerekir)`}
            </p>
          }
        >
          {/* Tahmin kuruşuyla yazılmaz (sahte kesinlik): liraya yuvarlanır */}
          {f ? <Amount k={Math.round(f.value / 100) * 100} /> : <Faint>henüz yok</Faint>}
        </Row>
      )}
    </Group>
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
export function CumulativeChart({ s }: { s: Stats }) {
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
  const padL = 44;
  const padR = 60;
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
    <div className="pb-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-2">
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden="true" width="18" height="6">
            <line x1="1" y1="3" x2="17" y2="3" stroke="var(--chart-accent)" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          Bugün
        </span>
        {c.lastWeek ? (
          <span className="inline-flex items-center gap-1.5">
            <svg aria-hidden="true" width="18" height="6">
              <line x1="1" y1="3" x2="17" y2="3" stroke="var(--chart-context)" strokeWidth="2" strokeDasharray="4 3" />
            </svg>
            Geçen hafta bugün
          </span>
        ) : (
          <span className="text-muted">Geçen hafta bugün: veri yok</span>
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
                aria-label="Gün boyu birikimli ciro, bugün ve geçen hafta bugün; ayrıntı aşağıdaki tabloda"
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
                  className="pointer-events-none absolute top-1 z-10 rounded-[var(--r-tile)] bg-raised px-3 py-2 text-xs shadow-[var(--shadow-lift)]"
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
              <th scope="col">Geçen hafta bugün</th>
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
    </div>
  );
}
