import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { type Compare, dayLabel, monthName, type Period, type StatsMode } from '@shared/today-stats';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/cn';
import { CompareBars, PctPill } from './KeelPanel';
import { COMPARE_SHORT, signed } from './TodayStats';

/**
 * Kıyas kartının ayrıntılı dökümü (sahip, 22 Kas 2026: karta dokununca açılan pencere; telefonda tam ekran sayfa,
 * bilgisayarda geniş pencere): bugün, dün / geçen hafta bugün / geçen ay bugün için aynı saate kadarki ve gün sonu
 * tutarları, adisyon, ortalama sepet, ₺ fark ve değişim; altında hafta ve ay başından dönem kıyası
 */
const avg = (s: { netSales: number; receipts: number } | null | undefined) => (s && s.receipts > 0 ? tl(Math.round(s.netSales / s.receipts)) : '—');
const range = (from: string, to: string) => {
  const d = (x: string) => `${Number(x.slice(8))} ${monthName(x)}`;
  return from === to ? d(from) : `${d(from)} – ${d(to)}`;
};

function Satir({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-[13px]">
      <span className="text-muted">{k}</span>
      <span className="tabular text-right font-medium text-ink">{v}</span>
    </div>
  );
}

/** Keel'in iri rakamı: lira mürekkep, kuruş soluk */
function Rakam({ k, className }: { k: number; className?: string }) {
  const t = tl(k);
  return (
    <span className={cn('tabular font-headline font-medium tracking-[-0.04em]', className)}>
      {t.slice(0, -3)}
      <span className="text-[var(--k-faint)]">{t.slice(-3)}</span>
    </span>
  );
}

const KART = 'rounded-[var(--r-card)] bg-surface px-5 py-4';

export function KiyasDokum({
  open,
  onClose,
  mode,
  now,
  today,
  compares,
  periods,
}: {
  open: boolean;
  onClose: () => void;
  mode: StatsMode;
  now: number;
  today: { date: string; netSales: number; receipts: number };
  compares: Compare[];
  periods: Period[] | null | undefined;
}) {
  const live = mode === 'live';
  return (
    <Modal open={open} onClose={onClose} size="xl" title="Kıyas dökümü" subtitle={live ? `Bugün ${fmtTime(now)} itibarıyla; kıyas günleri aynı saate kadar` : 'Gün sonu tutarlarıyla'}>
      {/* LafPOS Keel: soğuk gri zemin, kenarsız beyaz kartlar, bugün ters (mürekkep) kartta, nane vurgu */}
      <div className="space-y-4 bg-[var(--admin-bg)] p-4 sm:p-5">
        <div className="grid gap-4 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <section aria-label="Bugün" className="k-inverse flex flex-col justify-between rounded-[var(--r-card)] px-5 py-5">
            <p className="k-cap text-[12.5px]">Bugün · {dayLabel(today.date)}</p>
            <Rakam k={today.netSales} className="mt-3 block text-[44px] leading-none sm:text-[52px]" />
            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>
                <span className="tabular font-semibold">{today.receipts}</span> <span className="k-cap">adisyon</span>
              </span>
              <span>
                <span className="tabular font-semibold">{avg(today)}</span> <span className="k-cap">ortalama sepet</span>
              </span>
            </div>
          </section>
          <section aria-label="Kıyas grafiği" className={cn(KART, 'flex flex-col justify-end')}>
            <p className="k-cap text-[12.5px]">Bugün ve kıyas günleri</p>
            <CompareBars today={today.netSales} items={compares.map((c) => ({ key: c.key, label: COMPARE_SHORT[c.key], value: c.value ? c.value.netSales : null }))} />
          </section>
        </div>

        <section aria-label="Gün kıyası">
          <h3 className="mb-2 px-1 text-[13px] font-semibold text-muted">Gün kıyası</h3>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {compares.map((c) => (
              <article key={c.key} className={KART}>
                <header className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold text-ink">{c.label}</span>
                    <span className="block text-xs text-muted">{c.date ? dayLabel(c.date) : 'bu tarih takvimde yok'}</span>
                  </span>
                  <PctPill value={c.change} />
                </header>
                {c.value ? (
                  <>
                    <Rakam k={c.value.netSales} className="mt-3 block text-[30px] leading-none text-ink" />
                    <p className="mt-1 text-xs text-muted">{live && c.grain !== 'gun' ? 'aynı saate kadar' : 'gün sonu'}</p>
                    <div className="mt-3 divide-y divide-[var(--admin-divider)] border-t border-[var(--admin-divider)]">
                      <Satir k="Adisyon" v={c.value.receipts} />
                      <Satir k="Ortalama sepet" v={avg(c.value)} />
                      {c.full && c.full.netSales !== c.value.netSales && <Satir k="Gün sonu" v={`${tl(c.full.netSales)} · ${c.full.receipts}`} />}
                      {c.diff != null && <Satir k="Bugünle fark" v={signed(c.diff)} />}
                    </div>
                    {live && c.grain === 'gun' && <p className="mt-2 text-xs text-muted">O günün yalnız gün sonu toplamı biliniyor; gün sürerken yüzde hesaplanmaz</p>}
                    {live && c.grain === 'saat' && <p className="mt-2 text-xs text-muted">O gün saat saat biliniyor: tamamlanan saatlere kadar</p>}
                  </>
                ) : (
                  <p className="mt-3 text-sm text-muted">Veri yok: o gün kafe kapalıydı ya da LafPOS kullanılmıyordu</p>
                )}
              </article>
            ))}
          </div>
        </section>

        {periods && periods.length > 0 && (
          <section aria-label="Dönem kıyası">
            <h3 className="mb-2 px-1 text-[13px] font-semibold text-muted">Dönem kıyası</h3>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {periods.map((p) => (
                <article key={p.key} className={KART}>
                  <header className="flex items-start justify-between gap-2">
                    <span className="min-w-0">
                      <span className="block text-[15px] font-semibold text-ink">{p.label}</span>
                      <span className="block text-xs text-muted">{range(p.cur.from, p.cur.to)}</span>
                    </span>
                    <PctPill value={p.change} />
                  </header>
                  <Rakam k={p.cur.netSales} className="mt-3 block text-[30px] leading-none text-ink" />
                  <div className="mt-3 divide-y divide-[var(--admin-divider)] border-t border-[var(--admin-divider)]">
                    <Satir k="Adisyon · ortalama" v={`${p.cur.receipts} · ${avg(p.cur)}`} />
                    <Satir k={`Önceki · ${range(p.prev.from, p.prev.to)}`} v={p.prev.days ? tl(p.prev.netSales) : 'veri yok'} />
                    {p.diff != null && <Satir k="Fark" v={signed(p.diff)} />}
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </div>
    </Modal>
  );
}
