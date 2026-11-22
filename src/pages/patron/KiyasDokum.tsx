import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import { type Compare, dayLabel, monthName, type Period, type StatsMode } from '@shared/today-stats';
import { Modal } from '@/components/ui/Modal';
import { cn } from '@/lib/cn';
import { Delta } from './TodayStats';

/**
 * Kıyas kartının ayrıntılı dökümü (sahip, 22 Kas 2026: karta dokununca açılan pencere; telefonda tam ekran sayfa,
 * bilgisayarda geniş pencere): bugün, dün / geçen hafta bugün / geçen ay bugün için aynı saate kadarki ve gün sonu
 * tutarları, adisyon, ortalama sepet, ₺ fark ve değişim; altında hafta ve ay başından dönem kıyası
 */
const avg = (s: { netSales: number; receipts: number } | null | undefined) => (s && s.receipts > 0 ? tl(Math.round(s.netSales / s.receipts)) : '—');
const signed = (k: number) => `${k > 0 ? '+' : k < 0 ? '−' : ''}${tl(Math.abs(k))}`;
const range = (from: string, to: string) => {
  const d = (x: string) => `${Number(x.slice(8))} ${monthName(x)}`;
  return from === to ? d(from) : `${d(from)} – ${d(to)}`;
};

function Satir({ k, v, strong }: { k: string; v: React.ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
      <span className="text-muted">{k}</span>
      <span className={cn('tabular text-right', strong ? 'font-semibold text-ink' : 'text-ink-2')}>{v}</span>
    </div>
  );
}

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
      <div className="space-y-5 p-4 sm:p-5">
        <section aria-label="Bugün" className="rounded-[var(--r-group)] bg-[var(--k-well-2)] px-4 py-3">
          <p className="text-[13px] font-semibold text-muted">Bugün · {dayLabel(today.date)}</p>
          <p className="tabular mt-1 font-headline text-3xl font-medium tracking-[-0.03em] text-ink">{tl(today.netSales)}</p>
          <p className="tabular text-sm text-muted">
            {today.receipts} adisyon · ortalama {avg(today)}
          </p>
        </section>

        <section aria-label="Gün kıyası">
          <h3 className="mb-2 text-sm font-semibold text-ink">Gün kıyası</h3>
          <div className="grid gap-3 md:grid-cols-3">
            {compares.map((c) => (
              <article key={c.key} className="rounded-[var(--r-group)] border border-[var(--admin-border)] bg-surface px-4 py-3">
                <header className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block font-semibold text-ink">{c.label}</span>
                    <span className="block text-xs text-muted">{c.date ? dayLabel(c.date) : 'bu tarih takvimde yok'}</span>
                  </span>
                  {c.change != null && <Delta value={c.change} />}
                </header>
                {c.value ? (
                  <div className="mt-2 divide-y divide-[var(--admin-divider)]">
                    <Satir strong k={live && c.grain !== 'gun' ? 'Aynı saate kadar' : 'Ciro'} v={tl(c.value.netSales)} />
                    <Satir k="Adisyon" v={c.value.receipts} />
                    <Satir k="Ortalama sepet" v={avg(c.value)} />
                    {c.full && c.full.netSales !== c.value.netSales && <Satir k="Gün sonu" v={`${tl(c.full.netSales)} · ${c.full.receipts} adisyon`} />}
                    {c.diff != null && <Satir k="Bugünle fark" v={signed(c.diff)} />}
                    {live && c.grain === 'gun' && <p className="pt-1.5 text-xs text-muted">O günün yalnız gün sonu toplamı biliniyor; gün sürerken yüzde hesaplanmaz</p>}
                    {live && c.grain === 'saat' && <p className="pt-1.5 text-xs text-muted">O gün saat saat biliniyor: tamamlanan saatlere kadar</p>}
                  </div>
                ) : (
                  <p className="mt-2 text-sm text-muted">Veri yok: o gün kafe kapalıydı ya da LafPOS kullanılmıyordu</p>
                )}
              </article>
            ))}
          </div>
        </section>

        {periods && periods.length > 0 && (
          <section aria-label="Dönem kıyası">
            <h3 className="mb-2 text-sm font-semibold text-ink">Dönem kıyası</h3>
            <div className="grid gap-3 md:grid-cols-3">
              {periods.map((p) => (
                <article key={p.key} className="rounded-[var(--r-group)] border border-[var(--admin-border)] bg-surface px-4 py-3">
                  <header className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-ink">{p.label}</span>
                    {p.change != null && <Delta value={p.change} />}
                  </header>
                  <div className="mt-2 divide-y divide-[var(--admin-divider)]">
                    <Satir strong k={`Bu dönem (${range(p.cur.from, p.cur.to)})`} v={tl(p.cur.netSales)} />
                    <Satir k="Adisyon · ortalama" v={`${p.cur.receipts} · ${avg(p.cur)}`} />
                    <Satir k={`Önceki (${range(p.prev.from, p.prev.to)})`} v={p.prev.days ? tl(p.prev.netSales) : 'veri yok'} />
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
