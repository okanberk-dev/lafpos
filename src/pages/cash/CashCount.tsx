import { Minus, Plus } from 'lucide-react';
import { useState } from 'react';
import { parseTL, tl, tlShort } from '@shared/money';
import type { ZSummary } from '@shared/types';
import { useBoot } from '@/lib/boot';
import { countStarted, type CountResult, DENOMINATIONS, slipDiff, slipRows } from '@/lib/cashCount';
import { fieldClass, Segmented } from '@/components/ui/Field';
import { cn } from '@/lib/cn';

export { DENOMINATIONS, type CountResult };

/** İşaretli tutar: "+₺50,00", "−₺150,00" (eksi işareti, kısa çizgi değil), "₺0,00"; fazla mı eksik mi ilk bakışta okunur */
export const signedTL = (k: number) => (k > 0 ? `+${tl(k)}` : k < 0 ? `−${tl(-k)}` : tl(0));

/**
 * Kasa föyü: banknot sayacıyla nakit, ödeme türü bazında sayılan tutar (banka POS gün sonu slipi, yemek kartı
 * raporları). Sistemle farkı anında gösterir. `summary` yoksa kör sayımdır (kasiyer `kasa.rakam` yetkisiz):
 * beklenen tutar ve fark gösterilmez, yalnız sayılan yazılır; fark yöneticinin ekranında.
 */
export function CashCount({
  summary,
  value,
  onChange,
  cashOnly,
  baseDiff = 0,
}: {
  summary: ZSummary | null;
  value: CountResult;
  onChange: (v: CountResult) => void;
  /** Yalnız nakit (vardiya devri): ödeme türü slipleri sorulmaz */
  cashOnly?: boolean;
  /** Vardiya devrinde önceki sayımın farkı: beklenen bu vardiyanınki olur (fark sunucunun shiftDiff'i), gün toplamı ayrıca */
  baseDiff?: number;
}) {
  const boot = useBoot();
  // Yalnız toplamı kaydedilmiş sayım (föy düzeltme) toplam tutarla açılır; banknotlu sayım ve yeni sayım adet adet
  const [mode, setMode] = useState<'banknot' | 'toplam'>(() => (value.countedCash > 0 && !Object.values(value.banknotes).some((n) => n > 0) ? 'toplam' : 'banknot'));
  const [totalText, setTotalText] = useState(value.countedCash ? String(value.countedCash / 100).replace('.', ',') : '');
  const blind = !summary;
  const methods = cashOnly ? [] : slipRows(summary, boot.paymentMethods);
  // Açık hesap satırı slipe değil müşterilere yazılan borca (veresiye defterine) bakar
  const cari = new Set(boot.paymentMethods.filter((m) => m.kind === 'cari').map((m) => m.id));

  const setNote = (d: number, n: number) => {
    const banknotes = { ...value.banknotes, [String(d)]: Math.max(0, n) };
    const countedCash = DENOMINATIONS.reduce((a, x) => a + x * (banknotes[String(x)] ?? 0), 0);
    onChange({ ...value, banknotes, countedCash, touched: true });
  };
  // Sayım başlamadan fark yazılmaz (boş çekmece "eksik" görünmesin): bir adet ya da tutar girilince (sıfır da). Gün
  // sonu aynı kuralla gönderir: "Sayılmadı" görünen sayaç ₺0 sayılmış gibi kaydedilmez (countStarted)
  const touched = countStarted(value);
  // Vardiya devrinde beklenen bu vardiyanınki: önceki devirde bulunan fark eklenir, üç hücre birbirini tutar
  // (sayılan − beklenen = fark, sunucunun shiftDiff'i); günün başından biriken fark notta
  const expected = summary ? summary.expectedCash + baseDiff : 0;
  const diff = value.countedCash - expected;
  const dayDiff = summary ? value.countedCash - summary.expectedCash : 0;

  return (
    <div className="space-y-5">
      <section>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-semibold">Nakit sayımı</h3>
          <Segmented
            size="sm"
            label="Sayım biçimi"
            value={mode}
            onChange={setMode}
            options={[
              { value: 'banknot', label: 'Adet adet' },
              { value: 'toplam', label: 'Toplam tutar' },
            ]}
          />
        </div>
        {mode === 'banknot' ? (
          <div className="grid grid-cols-1 gap-2 min-[480px]:grid-cols-2 lg:grid-cols-3">
            {DENOMINATIONS.map((d) => {
              const n = value.banknotes[String(d)] ?? 0;
              // ₺ başta, uygulamanın her yerindeki gibi (₺200, ₺0,50)
              const label = tlShort(d);
              return (
                // Satır tek kutu (kuyu); etiket sütunu sabit, adet alanı kalanı alır: eksi, alan ve artı her satırda aynı yerde
                <div key={d} className="flex items-center gap-2 rounded-xl bg-surface-2 px-2 py-1.5">
                  <span className="tabular w-14 shrink-0 text-sm font-semibold">{label}</span>
                  <button type="button" aria-label={`${label} bir azalt`} className={STEP} disabled={!n} onClick={() => setNote(d, n - 1)}>
                    <Minus className="size-3.5" />
                  </button>
                  <input
                    value={n || ''}
                    onChange={(e) => setNote(d, Number(e.target.value.replace(/\D/g, '')) || 0)}
                    inputMode="numeric"
                    autoComplete="off"
                    aria-label={`${label} adedi`}
                    className={cn(fieldClass, 'tabular h-8 min-w-0 flex-1 px-1 text-center text-sm pointer-coarse:h-11')}
                    placeholder="0"
                  />
                  <button type="button" aria-label={`${label} bir artır`} className={STEP} onClick={() => setNote(d, n + 1)}>
                    <Plus className="size-3.5" />
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <input
            value={totalText}
            onChange={(e) => {
              setTotalText(e.target.value);
              // Silinip boş bırakılan tutar sayım değildir: yeniden "Sayılmadı"
              onChange({ ...value, countedCash: parseTL(e.target.value) ?? 0, banknotes: {}, touched: e.target.value.trim() !== '' });
            }}
            inputMode="decimal"
            autoComplete="off"
            aria-label="Çekmecedeki nakit"
            placeholder="Çekmecedeki nakit"
            className={cn(fieldClass, 'tabular font-headline h-14 rounded-2xl px-4 text-right text-2xl font-semibold')}
          />
        )}
        {summary ? (
          <div className="mt-3 space-y-2">
            <div className="grid grid-cols-3 gap-2 text-sm">
              <Cell label="Beklenen" value={tl(expected)} hint={baseDiff !== 0 ? 'Bu vardiya' : undefined} />
              <Cell label="Sayılan" value={tl(value.countedCash)} />
              <Cell
                label="Fark"
                value={touched ? signedTL(diff) : '—'}
                hint={!touched ? 'Sayılmadı' : diff > 0 ? 'Kasada fazla' : diff < 0 ? 'Kasada eksik' : 'Kasa tuttu'}
                tone={!touched ? undefined : diff === 0 ? 'ok' : Math.abs(diff) < 5000 ? 'warn' : 'bad'}
              />
            </div>
            {baseDiff !== 0 && (
              <p className="text-pretty text-xs text-muted">
                Önceki devirdeki {signedTL(baseDiff)} fark beklenene eklendi
                {touched && `; günün toplam farkı ${dayDiff === 0 ? 'yok' : signedTL(dayDiff)}`}
              </p>
            )}
          </div>
        ) : (
          <div className="mt-3 grid gap-2 text-sm sm:grid-cols-[auto_1fr] sm:items-center">
            <Cell label="Sayılan" value={tl(value.countedCash)} hint={touched ? undefined : 'Sayılmadı'} />
            <p className="text-xs text-muted">Kör sayım: beklenen tutar ve fark bu rolde görünmez; {cashOnly ? 'yöneticinin ekranında, vardiya devirlerinde' : 'yöneticinin ekranında ve Z raporunda'}</p>
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
              const isCari = cari.has(m.methodId);
              return (
                <div key={m.methodId} className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2">
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
                    aria-label={`${m.name} ${isCari ? 'defter' : 'slip'} tutarı`}
                    placeholder={isCari ? 'Defter' : 'Slip'}
                    className={cn(fieldClass, 'tabular h-11 w-28 shrink-0 px-3 text-right')}
                  />
                  {!blind && <span className={cn('tabular w-24 shrink-0 text-right text-sm font-semibold', d == null ? 'text-muted' : d === 0 ? 'text-success-ink' : 'text-danger-ink')}>{d == null ? '—' : signedTL(d)}</span>}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/** Banknot adedi düğmesi: farede 32, dokunmatikte 44 px; sıfırdayken eksi kapalı */
const STEP =
  'grid size-8 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 transition-[background-color,opacity] duration-150 hover:bg-[var(--admin-border)] active:bg-[var(--admin-border)] disabled:opacity-40 disabled:hover:bg-surface-3 pointer-coarse:size-11';

/** Beklenen, sayılan ve fark: tonlu hücrenin kenarı durum çizgisi (iki temada da görünür); ipucu rakamın altında, kelime rakamın yerine geçmez */
function Cell({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'ok' | 'warn' | 'bad' }) {
  return (
    <div className={cn('min-w-0 rounded-xl border px-2.5 py-2 sm:px-3', tone === 'bad' ? 'border-danger-line bg-danger-soft' : tone === 'warn' ? 'border-warning-line bg-warning-soft' : tone === 'ok' ? 'border-success-line bg-success-soft' : 'border-line')}>
      <div className="text-xs text-muted">{label}</div>
      <div className="tabular font-semibold [overflow-wrap:anywhere]">{value}</div>
      {hint && <div className="text-xs text-muted">{hint}</div>}
    </div>
  );
}
