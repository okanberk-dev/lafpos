import { tl, tlShort } from '@shared/money';
import type { CSSProperties, ReactNode } from 'react';
import { AnimatedCounter } from '@/components/ui/AnimatedCounter';
import { KPill } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { PAY_KINDS, payKind } from './TodayStats';

/**
 * Patron panelinin Keel düzeni (DESIGN.md §0; sahibin isteği, 22 Kas 2026: "tasarımı patron panel için bununla birebir
 * aynı yap"). Kaynak pano: üstte etiket ve dev rakam (kuruş soluk) yanında mürekkep düğme; altında dört küçük karo
 * (rakam, köşede değişim hapı, altında etiket); ince çubuklu grafik kartı (gri bağlam, nane vurgu, yüzen değer çipleri,
 * hap eksen); sağda mini grafikli beyaz kart ve yarım halka göstergeli koyu kart. Rakamların hepsi panelin kendi
 * verisinden gelir; burada hesap yok, yalnız çizim
 */

/** Yüzdeyi hapa çevirir; null ise hap yok */
export function PctPill({ value }: { value: number | null | undefined }) {
  if (value == null) return null;
  return <KPill dir={value > 0 ? 'up' : value < 0 ? 'down' : 'flat'}>%{Math.abs(value).toLocaleString('tr-TR', { maximumFractionDigits: 1 })}</KPill>;
}

/** Küçük karo: rakam solda, hap sağ üstte, etiket altta */
export function KpiTile({ value, label, pill, className }: { value: ReactNode; label: ReactNode; pill?: ReactNode; className?: string }) {
  return (
    <div className={cn('k-tile min-w-0 rounded-[var(--k-r-tile)] px-4 py-4 sm:px-5', className)}>
      {/* Rakam asla kısalmaz ("₺26…" olmaz): hap yanına sığmazsa rakamın altına iner */}
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="tabular whitespace-nowrap font-headline text-[26px] font-medium leading-8 tracking-[-0.035em] text-ink">{value}</span>
        {pill}
      </div>
      <p className="mt-1 truncate text-[13px] leading-5 text-muted">{label}</p>
    </div>
  );
}

/**
 * Dev rakam: ₺ ve lira mürekkep, kuruş soluk (Keel'in "$422,525.82"si). Boy kabın enine ve rakamın uzunluğuna göre
 * (rakam başına ~0,62 em): telefonda taşmaz, geniş ekranda 96 px'e dek büyür
 */
export function HeroNumber({ k, label }: { k: number; label: string }) {
  const text = tl(k);
  const cut = text.lastIndexOf(',');
  const int = cut > 0 ? text.slice(0, cut) : text;
  const frac = cut > 0 ? text.slice(cut) : '';
  const digits = int.replace(/[^\d₺-]/g, '').length + frac.length;
  const units = 0.62 * digits + 0.28 * (int.split('.').length - 1) + 0.1;
  // Ciro yenilenince basamaklar kendi çarkında döner (kayan sayaç); yazı tl()'nin aynısı, kuruş soluk
  return (
    <p className="tabular whitespace-nowrap font-headline font-medium leading-[0.95] tracking-[-0.045em] text-ink" style={{ fontSize: `min(6rem, calc(100cqi / ${units.toFixed(2)}))` }}>
      <AnimatedCounter value={k} format={tl} srPrefix={label} fractionClassName="text-[var(--k-faint)]" />
    </p>
  );
}

/** Kartın küçük soru satırı, büyük rakamı ve altındaki etiket (Keel'in "67% Confident" başlığı) */
function CardHead({ caption, value, label, pill }: { caption: string; value: ReactNode; label: ReactNode; pill?: ReactNode }) {
  return (
    <>
      <p className="k-cap text-[12.5px] leading-[1.35]">{caption}</p>
      <div className="mt-2.5 flex items-center gap-2">
        <span className="tabular font-headline text-[34px] font-medium leading-none tracking-[-0.04em]">{value}</span>
        {pill}
      </div>
      <p className="k-cap mt-1.5 truncate text-[13px] leading-5">{label}</p>
    </>
  );
}

/**
 * Kıyas kartının mini grafiği (Keel'in bloklu grafiği): bugün nane ve üstünde tutar hapı; dün, geçen hafta bugün ve
 * geçen ay bugün gri bloklar. Veri yoksa blok kesik çizgili. Tutar ve yüzde hemen altındaki satırlarda yazıyla;
 * patron panelinde kıyas yalnız bu kartta (sahip: "iki defa kıyas olmasın", 22 Kas 2026)
 */
export function CompareBars({ today, items }: { today: number; items: { key: string; label: string; value: number | null }[] }) {
  const max = Math.max(today, ...items.map((i) => i.value ?? 0), 1);
  const h = (v: number | null) => (v == null ? 14 : v <= 0 ? 4 : Math.max(10, Math.round((v / max) * 100)));
  const cols = [...items.slice(0, 1), { key: 'bugun', label: 'Bugün', value: today as number | null }, ...items.slice(1)];
  const grid = { gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` };
  return (
    <div aria-hidden="true" className="pb-2 pt-6">
      <div className="grid h-[92px] items-end gap-1.5 border-b border-[var(--k-line)]" style={grid}>
        {cols.map((c) =>
          c.key === 'bugun' ? (
            <div key={c.key} className="relative w-full rounded-t-[10px]" style={{ height: `${h(today)}%`, background: 'linear-gradient(180deg, var(--k-mint) 0%, color-mix(in oklab, var(--k-mint) 18%, transparent) 100%)' }}>
              <span className="tabular absolute left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 whitespace-nowrap rounded-full bg-[var(--k-mint)] px-2 py-0.5 text-[11px] font-semibold leading-4 text-[#0b3d22]">{tlShort(today)}</span>
            </div>
          ) : c.value == null ? (
            <div key={c.key} className="w-full rounded-t-[10px] border border-b-0 border-dashed border-[var(--k-line-strong)]" style={{ height: `${h(null)}%` }} />
          ) : (
            <div key={c.key} className="w-full rounded-t-[10px] bg-[var(--k-chart-bar)]" style={{ height: `${h(c.value)}%` }} />
          ),
        )}
      </div>
      <div className="mt-1.5 grid gap-1.5 text-center text-[11px] leading-4 text-muted" style={grid}>
        {cols.map((c) => (
          <span key={c.key} className={cn('truncate', c.key === 'bugun' && 'font-medium text-ink')}>
            {c.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Koyu kart: ödeme türleri (nakit, kart, yemek kartı, diğer) yarım halka göstergede, altında tür tür tutar ve yüzde.
 * Açık temada mürekkep zemin, gecede açık zemin (`.k-inverse`); renkler o zemine göre (src/styles/keel.css)
 */
export function PaymentGaugeCard({ payments, className }: { payments: { name: string; zField?: string; amount: number; count: number }[]; className?: string }) {
  const total = payments.reduce((a, p) => a + Math.max(0, p.amount), 0);
  const groups = PAY_KINDS.map((k) => {
    const rows = payments.filter((p) => payKind(p) === k.key);
    const amount = rows.reduce((a, r) => a + r.amount, 0);
    return { ...k, amount, count: rows.reduce((a, r) => a + r.count, 0), share: total > 0 ? Math.round((Math.max(0, amount) / total) * 1000) / 10 : 0 };
  });
  const top = groups.reduce((best, g) => (g.share > best.share ? g : best), groups[0]!);
  // Yarım halka: yol uzunluğu 100 birim; dilimler arasında boşluk, uçlar yuvarlak
  const GAP = 5;
  const shown = groups.filter((g) => g.share > 0);
  const usable = 100 - GAP * Math.max(0, shown.length - 1);
  let at = 0;
  const arcs = shown.map((g) => {
    const len = Math.max(1.5, (g.share / 100) * usable);
    const arc = { key: g.key, color: g.color, len, at };
    at += len + GAP;
    return arc;
  });
  const pct = (n: number) => `%${n.toLocaleString('tr-TR', { maximumFractionDigits: 1 })}`;
  return (
    <section aria-label="Ödeme türleri" className={cn('k-inverse flex min-w-0 flex-col rounded-[var(--r-group)] p-5', className)}>
      <CardHead caption="Bugün ödemeler hangi türden geldi?" value={total > 0 ? pct(top.share) : '—'} label={total > 0 ? top.label : 'Henüz ödeme alınmadı'} />
      <svg viewBox="0 0 200 104" role="img" aria-label={total > 0 ? `Ödeme dağılımı: ${shown.map((g) => `${g.label} ${pct(g.share)}`).join(', ')}` : 'Ödeme yok'} className="mx-auto mt-2 block w-full max-w-[260px] flex-1">
        <path d="M 14 98 A 86 86 0 0 1 186 98" fill="none" stroke="var(--k-inv-track)" strokeWidth="7" strokeLinecap="round" />
        {arcs.map((a) => (
          <path key={a.key} d="M 14 98 A 86 86 0 0 1 186 98" pathLength={100} fill="none" stroke={a.color} strokeWidth="7" strokeLinecap="round" strokeDasharray={`${a.len} ${100 - a.len}`} strokeDashoffset={-a.at} />
        ))}
      </svg>
      <ul className="mt-2 grid gap-1 text-[12.5px] leading-5">
        {groups.map((g) => (
          <li key={g.key} className="flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: g.color }} />
              <span className="truncate">{g.label}</span>
            </span>
            {g.count > 0 ? (
              <span className="tabular flex shrink-0 items-baseline gap-2 whitespace-nowrap">
                <span className="font-semibold">{tlShort(g.amount)}</span>
                <span className="k-cap w-[3.25rem] text-right">{pct(g.share)}</span>
              </span>
            ) : (
              <span className="k-cap">yok</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export interface ThinHour {
  /** "14:00" */
  title: string;
  value: number;
}

/**
 * İnce çubuklu grafik (Keel'in "Financial health score"u): her saat altı ince çubuk; 10 dakikalık gerçek dilimler
 * varsa (`bins`, saat başına altı değer) onlarla, yoksa saatin tutarıyla (şeritli sütun). Geçmiş gri, vurgulu aralık
 * nane: gün sürerken son iki saat, gün kapalıyken en yoğun saat. Değerler yüzen çiplerde ve hap eksende yazıyla;
 * saat saat tablo kartın "Tablo" görünümünde
 */
export function ThinBars({ hours, bins, nowIndex, emptyLabel }: { hours: ThinHour[]; bins?: number[] | null; nowIndex: number | null; emptyLabel: string }) {
  const STRIPES = 6;
  const total = hours.reduce((a, h) => a + h.value, 0);
  if (!hours.length || total <= 0) return <p className="grid h-[220px] place-items-center text-sm text-muted">{emptyLabel}</p>;
  // 10 dakikalık gerçek dilimler yalnız gün yeterince doluysa (en az 12 dolu dilim); seyrek günde tek ince çizgi yerine
  // saatin tutarı şeritli sütun olarak çizilir
  const dense = !!bins && bins.length === hours.length * STRIPES && bins.filter((v) => v > 0).length >= 12;
  const cols = dense ? bins! : hours.flatMap((h) => Array.from({ length: STRIPES }, () => h.value));
  const max = Math.max(...cols, 1);
  const peak = hours.reduce((best, h, i) => (h.value > hours[best]!.value ? i : best), 0);
  const now = nowIndex != null && nowIndex >= 0 && nowIndex < hours.length ? nowIndex : null;
  // Vurgu: gün sürerken son iki saat (şimdi dahil), değilse en yoğun saat
  const hiFrom = now != null ? Math.max(0, now - 1) : peak;
  const hiTo = now != null ? now : peak;
  const hourTop = (i: number) => Math.max(...cols.slice(i * STRIPES, (i + 1) * STRIPES), 0);
  const chips = [...new Set([peak, ...(now != null && hours[now]!.value > 0 ? [now] : [])])].map((i) => ({
    i,
    left: Math.min(90, Math.max(10, ((i + 0.5) / hours.length) * 100)),
    bottom: Math.min(74, (hourTop(i) / max) * 100),
    value: hours[i]!.value,
    note: i === now ? (i === peak ? `${hours[i]!.title} · bu saat, en yoğun` : `${hours[i]!.title} · bu saat`) : `${hours[i]!.title} · en yoğun`,
  }));
  const step = hours.length > 14 ? 3 : hours.length > 8 ? 2 : 1;
  return (
    <div role="img" aria-label={`Gün boyu ciro: en yoğun saat ${hours[peak]!.title}, ${tl(hours[peak]!.value)}${now != null ? `; bu saat ${tl(hours[now]!.value)}` : ''}`}>
      <div className="relative h-[200px]">
        <div aria-hidden="true" className="absolute inset-x-0 bottom-0 flex h-[150px] items-end gap-px sm:gap-[2px]">
          {cols.map((v, c) => {
            const hour = Math.floor(c / STRIPES);
            const hi = hour >= hiFrom && hour <= hiTo;
            const future = now != null && hour > now;
            return <span key={c} className="min-w-px flex-1 rounded-t-[1px]" style={{ height: `${v > 0 ? Math.max(3, (v / max) * 100) : 1.5}%`, background: hi ? 'var(--k-mint)' : 'var(--k-chart-bar)', opacity: future ? 0.35 : hi ? 1 : 0.9 }} />;
          })}
        </div>
        {chips.map((c) => (
          <div key={c.i} aria-hidden="true" className="absolute -translate-x-1/2 rounded-[10px] bg-surface px-2.5 py-1.5 text-center shadow-[var(--k-shadow-float)]" style={{ left: `${c.left}%`, bottom: `calc(${(c.bottom * 150) / 100}px + 8px)` } as CSSProperties}>
            <span className="tabular block font-headline text-[15px] font-medium leading-5 tracking-[-0.02em] text-ink">{tlShort(c.value)}</span>
            <span className="block whitespace-nowrap text-[11px] leading-4 text-muted">{c.note}</span>
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="relative mt-2.5 h-6">
        {hours.map((h, i) =>
          i % step === 0 ? (
            <span
              key={h.title}
              className={cn(
                'tabular absolute top-0 -translate-x-1/2 rounded-full px-2 text-[11px] font-medium leading-[22px]',
                i >= hiFrom && i <= hiTo ? 'bg-[var(--k-mint)] text-[#0b3d22]' : now != null && i > now ? 'bg-surface text-muted ring-1 ring-inset ring-[var(--k-line)]' : 'bg-[var(--k-well-2)] text-ink-2',
              )}
              style={{ left: `${((i + 0.5) / hours.length) * 100}%` }}
            >
              {h.title.slice(0, 2)}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
