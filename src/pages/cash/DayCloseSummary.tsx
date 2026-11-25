import { CircleCheck, ListChecks } from 'lucide-react';
import { type ReactNode, useId } from 'react';
import { tl } from '@shared/money';
import { handoverByRecipient } from '@shared/teslim';
import { fmtTime } from '@shared/time';
import type { ShiftCountDTO, ZSummary } from '@shared/types';
import { cn } from '@/lib/cn';
import { signedTL } from './CashCount';
import type { Movement } from './CashPage';

/**
 * Ayrıntılı gün sonu (sahibin isteği, 25 Kasım 2026: "detaylı alındığını belli etsin, basit ve anlaşılır olsun").
 * `DayCloseSummary` gün sonu penceresinin başında neyin kayda geçeceğini bir bakışta söyler; `DayCloseDone` gün
 * kapanınca sonucun özetidir (ayrıntılı Z raporu altında). Kör kasada ciro ve beklenen nakit yok: `summary` null gelir,
 * yalnız kasiyerin zaten gördüğü kasa hareketleri yazılır.
 */
export function DayCloseSummary({ summary, movements, shiftCounts, lafmaliyet }: { summary: ZSummary | null; movements: Movement[]; shiftCounts: ShiftCountDTO[]; lafmaliyet: boolean }) {
  const id = useId();
  const sum = (kind: Movement['kind']) => movements.filter((m) => m.kind === kind).reduce((a, m) => a + m.amount, 0);
  const count = (kind: Movement['kind']) => movements.filter((m) => m.kind === kind).length;
  const handover = handoverByRecipient(movements);
  return (
    <section aria-labelledby={id} className="rounded-[var(--r-card)] bg-surface-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[var(--r-tile)] bg-surface text-ink-2">
          <ListChecks className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h3 id={id} className="text-sm font-semibold text-ink">
            Kayda geçecekler
          </h3>
          <p className="text-pretty text-xs leading-5 text-muted">
            Ayrıntılı Z raporu: satışlar, ödeme türleri, KDV, kasa hareketleri ve sayım{lafmaliyet ? '. Gün sonunda ladmin’e (lafmaliyet) de gider' : ''}
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {summary && (
          <>
            <Tile label="Net ciro" value={tl(summary.netSales)} />
            <Tile label="Adisyon" value={String(summary.receipts)} />
          </>
        )}
        <Tile label="Harcama" value={tl(sum('harcama'))} note={count('harcama') ? `${count('harcama')} kayıt` : undefined} />
        <Tile label="Teslim" value={tl(sum('teslim'))} note={count('teslim') ? `${count('teslim')} kayıt` : undefined} />
        {(sum('giris') > 0 || !summary) && <Tile label="Kasaya giriş" value={tl(sum('giris'))} />}
        {summary && <Tile label="Beklenen nakit" value={tl(summary.expectedCash)} />}
        {shiftCounts.length > 0 && <Tile label="Vardiya devri" value={String(shiftCounts.length)} />}
      </dl>
      {handover.length > 0 && <HandoverList rows={handover} />}
    </section>
  );
}

/** Gün kapandıktan sonra: neyin kaydedildiği ve kasanın sonucu, ayrıntılı Z raporunun üstünde */
export function DayCloseDone({ summary, closedAt, lafmaliyet }: { summary: ZSummary; closedAt: number | null; lafmaliyet: boolean }) {
  const diff = summary.cashDiff;
  return (
    <section aria-label="Gün sonu özeti" className="rounded-[var(--r-card)] bg-surface-2 px-4 py-3">
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-[var(--r-tile)] bg-[var(--k-mint-soft)] text-[var(--k-mint-ink)]">
          <CircleCheck className="size-4.5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">Ayrıntılı gün sonu kaydedildi{closedAt ? ` · ${fmtTime(closedAt)}` : ''}</p>
          <p className="text-pretty text-xs leading-5 text-muted">
            Satışlar, ödeme türleri, KDV, kasa hareketleri ve sayım aşağıdaki Z raporunda.{lafmaliyet ? ' ladmin’e (lafmaliyet) gönderiliyor.' : ''} Z fişi için Yazdır’a basın
          </p>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Tile label="Net ciro" value={tl(summary.netSales)} />
        <Tile label="Nakit" value={tl(summary.byZField.cash)} />
        <Tile label="Kart" value={tl(summary.byZField.card)} />
        <Tile
          label="Kasa farkı"
          value={diff == null ? 'Sayılmadı' : diff === 0 ? 'Tuttu' : signedTL(diff)}
          tone={diff == null ? undefined : diff === 0 ? 'ok' : 'bad'}
        />
      </dl>
      {(summary.handedOverBy ?? []).length > 0 && <HandoverList rows={summary.handedOverBy ?? []} />}
    </section>
  );
}

/** Teslimin kime gittiği: alıcı başına tek satır (alıcısız eski teslim "Belirtilmemiş") */
function HandoverList({ rows }: { rows: { userId: string | null; name: string; count: number; amount: number }[] }) {
  return (
    <div className="mt-2 rounded-[var(--r-tile)] bg-surface px-3 py-2">
      <p className="text-xs font-medium text-muted">Teslim edilen</p>
      <ul className="mt-1 space-y-1 text-sm">
        {rows.map((r) => (
          <li key={r.userId ?? `ad:${r.name}`} className="flex justify-between gap-3">
            <span className="min-w-0 truncate text-ink-2">
              Kime: <span className="font-medium text-ink">{r.name}</span>
              {r.count > 1 ? <span className="text-muted"> · {r.count} teslim</span> : null}
            </span>
            <span className="tabular whitespace-nowrap font-semibold">{tl(r.amount)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: ReactNode; note?: string; tone?: 'ok' | 'bad' }) {
  return (
    <div className="min-w-0 rounded-[var(--r-tile)] bg-surface px-3 py-2">
      <dt className="truncate text-xs text-muted">{label}</dt>
      <dd className={cn('tabular truncate text-base font-semibold', tone === 'ok' && 'text-success-ink', tone === 'bad' && 'text-danger-ink')}>{value}</dd>
      {note && <dd className="truncate text-xs text-muted">{note}</dd>}
    </div>
  );
}
