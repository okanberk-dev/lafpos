import { useQuery } from '@tanstack/react-query';
import { Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtTime } from '@shared/time';
import type { PickupBoardDTO, PickupEntryDTO } from '@shared/types';
import { LafMark } from '@/components/LafMark';
import { IconButton } from '@/components/ui/Button';
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
      <header className="flex items-center gap-4 px-1">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
          <LafMark className="h-5" bean="#e8c877" />
        </span>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-[-0.01em] md:text-2xl">{businessName}</h1>
          {/* Telefonda sütunlar alt alta: yön tarifi yalnız geniş ekranda */}
          <p className="hidden text-base text-muted md:block">Numaranız Hazır listesine geçince siparişiniz hazırdır</p>
        </div>
        {/* Personel kontrolü müşteri yüzünde sessiz: yalnız ikon */}
        <IconButton label={sound ? 'Sesi kapat' : 'Sesi aç'} aria-pressed={sound} onClick={() => setSound(!sound)} className="text-muted">
          {sound ? <Volume2 className="size-5" /> : <VolumeX className="size-5" />}
        </IconButton>
        <span className="tabular text-2xl font-bold md:text-4xl">{fmtTime(now)}</span>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 md:grid-cols-[1fr_1.4fr]">
        <Column title="Hazırlanıyor" count={preparing.length} tone="muted" empty="Hazırlanan sipariş yok">
          {preparing.map((e) => (
            <Entry key={e.id} entry={e} />
          ))}
        </Column>
        <Column title="Hazır" count={ready.length} tone="ready" empty="Hazır sipariş yok">
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
        <h2 className={cn('text-2xl font-bold tracking-[-0.01em] md:text-3xl', tone === 'ready' ? 'text-[var(--admin-success)]' : 'text-ink-2')}>{title}</h2>
        <span className="tabular inline-flex min-h-7 items-center rounded-md bg-surface-3 px-2.5 text-base font-semibold text-ink-2">{count}</span>
      </header>
      <div className="scroll-thin grid min-h-0 flex-1 auto-rows-min grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3 overflow-y-auto p-4">
        {count === 0 ? <p className="col-span-full py-12 text-center text-xl text-muted">{empty}</p> : children}
      </div>
    </section>
  );
}

function Entry({ entry, ready, fresh }: { entry: PickupEntryDTO; ready?: boolean; fresh?: boolean }) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-xl border px-3 py-5 text-center',
        ready ? 'border-success-200 bg-[var(--admin-success-soft)] dark:border-success-800' : 'border-line bg-surface-2',
        fresh && 'animate-ring motion-reduce:animate-none',
      )}
    >
      {/* Yarı self servis: numara yerine masa; müşteri kalkmaz, personel getirir */}
      {entry.table && <span className="mb-1 text-sm font-semibold uppercase tracking-[0.06em] text-muted">Masa</span>}
      <span className={cn('tabular max-w-full truncate font-bold leading-none tracking-tight', ready ? 'text-7xl text-[var(--admin-success)]' : 'text-6xl text-ink-2')}>{entry.table ?? entry.no}</span>
      {entry.table && <span className="mt-2 text-sm font-medium text-ink-2">{ready ? 'Masanıza geliyor' : 'Masanıza getirilecek'}</span>}
      {entry.name && <span className="mt-2 max-w-full truncate text-lg font-semibold">{entry.name}</span>}
      {entry.online && <span className="mt-1 text-xs font-medium uppercase tracking-[0.06em] text-muted">Uygulama</span>}
    </div>
  );
}
