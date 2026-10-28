import { Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseTL, tl, tlShort } from '@shared/money';
import type { ZSummary } from '@shared/types';
import { useBoot } from '@/lib/boot';
import { slipDiff, slipRows } from '@/lib/cashCount';
import { Segmented } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

/** Türk lirası banknot ve madeni paralar (kuruş) */
export const DENOMINATIONS = [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5];

export interface CountResult {
  countedCash: number;
  banknotes: Record<string, number>;
  methodCounts: Record<string, number>;
}

/**
 * Kasa föyü: banknot sayacıyla nakit, ödeme türü bazında sayılan tutar (banka POS gün sonu slipi, yemek kartı
 * raporları). Sistemle farkı anında gösterir. `summary` yoksa kör sayımdır (kasiyer `kasa.rakam` yetkisiz):
 * beklenen tutar ve fark gösterilmez, yalnız sayılan yazılır; fark yöneticinin ekranında.
 */
export function CashCount({ summary, value, onChange }: { summary: ZSummary | null; value: CountResult; onChange: (v: CountResult) => void }) {
  const boot = useBoot();
  const [mode, setMode] = useState<'banknot' | 'toplam'>('banknot');
  const [totalText, setTotalText] = useState(value.countedCash ? String(value.countedCash / 100).replace('.', ',') : '');
  const blind = !summary;
  const methods = slipRows(summary, boot.paymentMethods);
  const fromNotes = useMemo(() => DENOMINATIONS.reduce((a, d) => a + d * (value.banknotes[String(d)] ?? 0), 0), [value.banknotes]);

  const setNote = (d: number, n: number) => {
    const banknotes = { ...value.banknotes, [String(d)]: Math.max(0, n) };
    const countedCash = DENOMINATIONS.reduce((a, x) => a + x * (banknotes[String(x)] ?? 0), 0);
    onChange({ ...value, banknotes, countedCash });
  };
  const diff = summary ? value.countedCash - summary.expectedCash : 0;

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Nakit sayımı</h3>
          <Segmented
            size="sm"
            label="Sayım biçimi"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'banknot', label: 'Banknot banknot' },
              { value: 'toplam', label: 'Toplam tutar' },
            ]}
          />
        </div>
        {mode === 'banknot' ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {DENOMINATIONS.map((d) => {
              const n = value.banknotes[String(d)] ?? 0;
              // ₺ başta, uygulamanın her yerindeki gibi (₺200, ₺0,50)
              const label = tlShort(d);
              return (
                <div key={d} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-1.5">
                  <span className="tabular w-14 text-sm font-semibold">{label}</span>
                  <button type="button" aria-label={`${label} bir azalt`} className={STEP} onClick={() => setNote(d, n - 1)}>
                    <Minus className="size-3.5" />
                  </button>
                  <input
                    value={n || ''}
                    onChange={(e) => setNote(d, Number(e.target.value.replace(/\D/g, '')) || 0)}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={`${label} adedi`}
                    className="tabular h-8 w-full min-w-0 rounded-lg border border-line-strong bg-surface text-center text-sm pointer-coarse:h-11"
                    placeholder="0"
                  />
                  <button type="button" aria-label={`${label} bir artır`} className={STEP} onClick={() => setNote(d, n + 1)}>
                    <Plus className="size-3.5" />
                  </button>
                </div>
              );
            })}
            <div className="tabular col-span-full text-right text-sm text-muted">Banknotlardan: {tl(fromNotes)}</div>
          </div>
        ) : (
          <input
            value={totalText}
            onChange={(e) => {
              setTotalText(e.target.value);
              onChange({ ...value, countedCash: parseTL(e.target.value) ?? 0, banknotes: {} });
            }}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Çekmecedeki nakit"
            placeholder="Çekmecedeki nakit"
            className="tabular h-14 w-full rounded-2xl border border-line-strong bg-surface px-4 text-right text-2xl font-semibold"
          />
        )}
        {summary ? (
          <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
            <Cell label="Beklenen" value={tl(summary.expectedCash)} />
            <Cell label="Sayılan" value={tl(value.countedCash)} />
            <Cell label="Fark" value={tl(diff)} tone={diff === 0 ? 'ok' : Math.abs(diff) < 5000 ? 'warn' : 'bad'} />
          </div>
        ) : (
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:items-center">
            <Cell label="Sayılan" value={tl(value.countedCash)} />
            <p className="text-xs text-muted">Kör sayım: beklenen tutar ve fark bu rolde görünmez; yöneticinin ekranında ve Z raporunda</p>
          </div>
        )}
      </section>

      {methods.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Diğer ödeme türleri</h3>
          <p className="mb-2 text-xs text-muted">Banka POS gün sonu slipindeki ve yemek kartı raporlarındaki tutarları yazın; boş bırakılan {blind ? 'kaydedilmez' : 'karşılaştırılmaz'}</p>
          <div className="space-y-2">
            {methods.map((m) => {
              const counted = value.methodCounts[m.methodId];
              const d = slipDiff(m, counted);
              return (
                <div key={m.methodId} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{m.name}</span>
                    {m.expected != null && (
                      <span className="block text-xs text-muted">
                        Sistem {tl(m.expected)}
                        {m.tips ? ` (${tl(m.tips)} bahşiş dahil)` : ''} · {m.count} işlem
                      </span>
                    )}
                  </span>
                  <input
                    defaultValue={counted != null ? String(counted / 100).replace('.', ',') : ''}
                    onChange={(e) => {
                      const v = parseTL(e.target.value);
                      const next = { ...value.methodCounts };
                      if (v == null) delete next[m.methodId];
                      else next[m.methodId] = v;
                      onChange({ ...value, methodCounts: next });
                    }}
                    inputMode="decimal"
                    autoComplete="off"
                    aria-label={`${m.name} slip tutarı`}
                    placeholder="Slip"
                    className="tabular h-11 w-28 rounded-lg border border-line-strong bg-surface px-2 text-right"
                  />
                  {!blind && <span className={cn('tabular w-24 text-right text-sm font-semibold', d == null ? 'text-muted' : d === 0 ? 'text-success-ink' : 'text-danger-ink')}>{d == null ? '—' : tl(d)}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Banknot adedi düğmesi: farede 32, dokunmatikte 44 px */
const STEP = 'grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 transition-colors duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)] pointer-coarse:size-11';

/** Beklenen, sayılan ve fark: tonlu hücrenin kenarı durum çizgisi (iki temada da görünür) */
function Cell({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={cn('rounded-xl border px-3 py-2', tone === 'bad' ? 'border-danger-line bg-danger-soft' : tone === 'warn' ? 'border-warning-line bg-warning-soft' : tone === 'ok' ? 'border-success-line bg-success-soft' : 'border-line')}>
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}
