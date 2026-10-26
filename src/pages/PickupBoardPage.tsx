import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '@shared/time';
import type { PickupBoardDTO, PickupEntryDTO } from '@shared/types';
import { LafMark } from '@/components/LafMark';
import { get } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { useBusinessName } from '@/lib/publicInfo';
import { beep, unlockAudio } from '@/lib/sound';
import { useWakeLock } from '@/lib/wakelock';

/** Yeni hazır olan bu kadar süre vurgulu kalır */
const FRESH_MS = 45_000;

/**
 * Çağrı ekranı (televizyon ya da müşteriye dönük tablet): tezgâh ve gel-al siparişlerinin numarası, online
 * siparişte yalnız ad. Bar "Hazır"a basınca numara sağa geçer, ses çalar; 10 dakika sonra ya da teslim edilince
 * düşer. Kasa menüsü olmadan tam ekran açılır, personel girişi istemez (Bar ekranındaki "Çağrı ekranı" düğmesi yeni pencerede açar).
 */
export default function PickupBoardPage() {
  const businessName = useBusinessName();
  const now = useTick(5_000);
  useWakeLock(true);
  // Oturumsuz ekran: canlı bağlantı yok, birkaç saniyede bir yoklanır
  const board = useQuery({ queryKey: ['pickup-board'], queryFn: () => get<PickupBoardDTO>('/public/board'), refetchInterval: 3_000 });

  // Yeni hazır olan için ses (ilk yüklemede çalmaz)
  const known = useRef<Set<string> | null>(null);
  const [sound, setSound] = useState(true);
  useEffect(() => {
    const ready = board.data?.ready ?? [];
    if (known.current && sound && ready.some((r) => !known.current!.has(r.id))) beep('tamam');
    known.current = new Set(ready.map((r) => r.id));
  }, [board.data, sound]);

  const preparing = board.data?.preparing ?? [];
  const ready = board.data?.ready ?? [];

  return (
    <div className="flex h-full flex-col gap-3 bg-bg p-3 md:p-5" onPointerDown={unlockAudio}>
      <header className="flex items-center gap-3 px-1">
        <span className="grid size-12 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
          <LafMark className="h-5" bean="#e8c877" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em] md:text-2xl">{businessName}</h1>
          <p className="text-sm text-muted md:text-base">Numaranız sağdaki listeye geçince siparişiniz hazırdır</p>
        </div>
        <button type="button" onClick={() => setSound(!sound)} className="min-h-11 rounded-xl px-3 text-sm text-muted hover:bg-surface-3" aria-pressed={sound}>
          {sound ? 'Ses açık' : 'Ses kapalı'}
        </button>
        <span className="tabular text-2xl font-semibold md:text-3xl">{fmtTime(now)}</span>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[1fr_1.4fr]">
        <Column title="Hazırlanıyor" count={preparing.length} tone="muted" empty="Hazırlanan sipariş yok">
          {preparing.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </Column>
        <Column title="Hazır" count={ready.length} tone="ready" empty="Hazır bekleyen sipariş yok">
          {ready.map((e) => (
            <Entry key={e.id} entry={e} ready fresh={now - e.readyAt < FRESH_MS} />
          ))}
        </Column>
      </div>
    </div>
  );
}

function Column({ title, count, tone, empty, children }: { title: string; count: number; tone: 'muted' | 'ready'; empty: string; children: React.ReactNode }) {
  return (
    <section className={cn('flex min-h-0 flex-col overflow-hidden rounded-2xl border bg-surface', tone === 'ready' ? 'border-success-200 dark:border-success-800' : 'border-line')}>
      <header className={cn('flex items-center gap-3 border-b px-5 py-3.5', tone === 'ready' ? 'border-success-200 bg-[var(--admin-success-soft)] dark:border-success-800' : 'border-[var(--admin-divider)]')}>
        <h2 className={cn('text-xl font-semibold md:text-2xl', tone === 'ready' ? 'text-[var(--admin-success)]' : 'text-ink-2')}>{title}</h2>
        <span className="tabular rounded-md bg-surface-3 px-2 py-0.5 text-sm font-semibold text-ink-2">{count}</span>
      </header>
      <div className="scroll-thin grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 overflow-y-auto p-4">
        {count === 0 ? <p className="col-span-full py-12 text-center text-lg text-muted">{empty}</p> : children}
      </div>
    </section>
  );
}

function Entry({ entry, ready, fresh }: { entry: PickupEntryDTO; ready?: boolean; fresh?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border px-3 py-4 text-center',
        ready ? 'border-success-200 bg-[var(--admin-success-soft)] dark:border-success-800' : 'border-line bg-surface-2',
        fresh && 'animate-ring motion-reduce:animate-none',
      )}
    >
      <span className={cn('tabular font-bold leading-none tracking-tight', ready ? 'text-6xl text-[var(--admin-success)]' : 'text-5xl text-ink-2')}>{entry.no}</span>
      {entry.name && <span className="mt-2 max-w-full truncate text-lg font-semibold">{entry.name}</span>}
      {entry.online && <span className="mt-1 text-xs font-medium uppercase tracking-[0.06em] text-muted">Uygulama</span>}
    </div>
  );
}
