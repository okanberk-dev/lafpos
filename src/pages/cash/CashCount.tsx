import { Minus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { ZSummary } from '@shared/types';
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
 * raporları). Sistemle farkı anında gösterir.
 */
export function CashCount({ summary, value, onChange }: { summary: ZSummary; value: CountResult; onChange: (v: CountResult) => void }) {
  const [mode, setMode] = useState<'banknot' | 'toplam'>('banknot');
  const [totalText, setTotalText] = useState(value.countedCash ? String(value.countedCash / 100).replace('.', ',') : '');
  const methods = summary.payments.filter((p) => p.zField !== 'cash');
  const fromNotes = useMemo(() => DENOMINATIONS.reduce((a, d) => a + d * (value.banknotes[String(d)] ?? 0), 0), [value.banknotes]);

  const setNote = (d: number, n: number) => {
    const banknotes = { ...value.banknotes, [String(d)]: Math.max(0, n) };
    const countedCash = DENOMINATIONS.reduce((a, x) => a + x * (banknotes[String(x)] ?? 0), 0);
    onChange({ ...value, banknotes, countedCash });
  };
  const diff = value.countedCash - summary.expectedCash;

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="font-semibold">Nakit sayımı</h3>
          <div className="flex rounded-lg bg-surface-2 p-0.5 text-xs">
            {(['banknot', 'toplam'] as const).map((m) => (
              <button key={m} onClick={() => setMode(m)} className={cn('rounded-md px-2.5 py-1', mode === m && 'bg-surface shadow-sm')}>
                {m === 'banknot' ? 'Banknot banknot' : 'Toplam tutar'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'banknot' ? (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {DENOMINATIONS.map((d) => {
              const n = value.banknotes[String(d)] ?? 0;
              return (
                <div key={d} className="flex items-center gap-2 rounded-xl border border-line bg-surface px-2 py-1.5">
                  <span className="tabular w-14 text-sm font-semibold">{d >= 100 ? `${d / 100} ₺` : `${d} kr`}</span>
                  <button aria-label="Azalt" className="grid size-8 place-items-center rounded-lg bg-surface-2" onClick={() => setNote(d, n - 1)}>
                    <Minus className="size-3.5" />
                  </button>
                  <input
                    value={n || ''}
                    onChange={(e) => setNote(d, Number(e.target.value.replace(/\D/g, '')) || 0)}
                    inputMode="numeric"
                    className="tabular h-8 w-full min-w-0 rounded-lg border border-line bg-surface text-center text-sm"
                    placeholder="0"
                  />
                  <button aria-label="Artır" className="grid size-8 place-items-center rounded-lg bg-surface-2" onClick={() => setNote(d, n + 1)}>
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
            placeholder="Çekmecedeki nakit"
            className="tabular h-14 w-full rounded-2xl border border-line-strong bg-surface px-4 text-right text-2xl font-semibold"
          />
        )}
        <div className="mt-3 grid grid-cols-3 gap-2 text-sm">
          <Cell label="Beklenen" value={tl(summary.expectedCash)} />
          <Cell label="Sayılan" value={tl(value.countedCash)} />
          <Cell label="Fark" value={tl(diff)} tone={diff === 0 ? 'ok' : Math.abs(diff) < 5000 ? 'warn' : 'bad'} />
        </div>
      </section>

      {methods.length > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Diğer ödeme türleri</h3>
          <p className="mb-2 text-xs text-muted">Banka POS gün sonu slipindeki ve yemek kartı raporlarındaki tutarları yazın; boş bırakılan karşılaştırılmaz</p>
          <div className="space-y-2">
            {methods.map((m) => {
              const counted = value.methodCounts[m.methodId];
              const d = counted == null ? null : counted - m.amount;
              return (
                <div key={m.methodId} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                  <span className="min-w-0 flex-1 text-sm">
                    <span className="font-medium">{m.name}</span>
                    <span className="block text-xs text-muted">
                      Sistem {tl(m.amount)} · {m.count} işlem
                    </span>
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
                    placeholder="Slip"
                    className="tabular h-10 w-28 rounded-lg border border-line-strong bg-surface px-2 text-right"
                  />
                  <span className={cn('tabular w-24 text-right text-sm font-semibold', d == null ? 'text-muted' : d === 0 ? 'text-forest-500' : 'text-burgundy-500')}>{d == null ? '—' : tl(d)}</span>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={cn('rounded-xl border px-3 py-2', tone === 'bad' ? 'border-burgundy-300 bg-burgundy-50 dark:bg-burgundy-800/30' : tone === 'warn' ? 'border-brass-300 bg-brass-50 dark:bg-brass-700/20' : tone === 'ok' ? 'border-forest-300 bg-forest-50 dark:bg-forest-800' : 'border-line')}>
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular font-semibold">{value}</div>
    </div>
  );
}
