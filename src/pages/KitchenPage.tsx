import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, ChefHat, Clock, Globe, History, PackageX, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { KitchenTicket, KitchenTicketItem } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref, useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { beep, unlockAudio } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';

function mmss(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)} sa ${m % 60} dk` : `${m}:${String(s % 60).padStart(2, '0')}`;
}

export default function KitchenPage() {
  const boot = useBoot();
  const qc = useQueryClient();
  const setForceDark = useTheme((s) => s.setForceDark);
  const [station, setStation] = useLocalPref<string>('kds.station', '');
  const [history, setHistory] = useState(false);
  const [soldOut, setSoldOut] = useState(false);
  const can = useCan();
  const [sound, setSound] = useLocalPref<boolean>('kds.sound', true);
  const now = useTick(5_000);

  useEffect(() => {
    setForceDark(true);
    return () => setForceDark(false);
  }, [setForceDark]);

  const tickets = useQuery({
    queryKey: ['kitchen', station, history],
    queryFn: () => get<KitchenTicket[]>(`/kitchen?${new URLSearchParams({ ...(station ? { station } : {}), ...(history ? { history: '1' } : {}) })}`),
    refetchInterval: 15_000,
  });

  useEffect(
    () =>
      onLive((e) => {
        if (e.topic !== 'kitchen' || !sound) return;
        if (station && e.stationId && e.stationId !== station) return;
        if (e.kind === 'ticket.new') beep('yeni');
        if (e.kind === 'ticket.void') beep('iptal');
      }),
    [sound, station],
  );

  const setStatus = async (ids: string[], status?: KitchenTicketItem['status']) => {
    try {
      await post('/kitchen/status', { itemIds: ids, status });
      qc.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const onlineStage = async (orderId: string, action: 'preparing' | 'ready') => {
    try {
      await post(`/sync/online/${orderId}/stage`, { action });
      qc.invalidateQueries({ queryKey: ['kitchen'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const list = useMemo(() => tickets.data ?? [], [tickets.data]);
  const counts = useMemo(() => ({ waiting: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'yeni').length, 0), making: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'hazirlaniyor').length, 0) }), [list]);

  return (
    <div className="flex h-full flex-col bg-bg" onPointerDown={unlockAudio}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-3">
        <ChefHat className="size-6 text-brass-400" />
        <h1 className="mr-2 text-xl font-semibold">Bar ve mutfak</h1>
        <div className="flex gap-1.5">
          <Chip active={!station} onClick={() => setStation('')}>
            Tümü
          </Chip>
          {boot.stations.map((s) => (
            <Chip key={s.id} active={station === s.id} onClick={() => setStation(s.id)}>
              {s.name}
            </Chip>
          ))}
        </div>
        <div className="flex-1" />
        {!history && (
          <div className="flex gap-3 text-sm">
            <span className="text-brass-400">{counts.waiting} bekliyor</span>
            <span className="text-forest-300">{counts.making} hazırlanıyor</span>
          </div>
        )}
        <button onClick={() => setHistory(!history)} className={cn('inline-flex items-center gap-1.5 rounded-xl px-3 py-2 text-sm pointer-coarse:min-h-11', history ? 'bg-brass-500 text-espresso' : 'bg-surface-2')}>
          <History className="size-4" /> {history ? 'Aktif fişler' : 'Geçmiş'}
        </button>
        {(can('urun.tukendi') || can('menu.yonet')) && (
          <button onClick={() => setSoldOut(true)} className="inline-flex items-center gap-1.5 rounded-xl bg-surface-2 px-3 py-2 text-sm pointer-coarse:min-h-11">
            <PackageX className="size-4" /> Tükendi
          </button>
        )}
        <button onClick={() => setSound(!sound)} aria-label={sound ? 'Sesi kapat' : 'Sesi aç'} className="grid size-11 place-items-center rounded-xl bg-surface-2">
          {sound ? <Bell className="size-4" /> : <BellOff className="size-4 text-muted" />}
        </button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        {list.length === 0 && (
          <div className="grid h-full place-items-center text-center text-muted">
            <div>
              <CheckCheck className="mx-auto mb-2 size-12 opacity-60" />
              <p className="text-lg">{history ? 'Son 90 dakikada hazırlanan yok' : 'Bekleyen sipariş yok'}</p>
            </div>
          </div>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(270px,1fr))] items-start gap-3">
          {list.map((t) => {
            const live = t.items.filter((i) => !i.voided);
            const age = now - t.sentAt;
            const level = age > boot.settings.kitchenAlarmMinutes * 60_000 ? 'alarm' : age > boot.settings.kitchenWarnMinutes * 60_000 ? 'warn' : 'ok';
            const online = t.source === 'laffogato';
            const allStarted = live.every((i) => i.status !== 'yeni');
            return (
              <article key={t.key} className={cn('overflow-hidden rounded-2xl border bg-surface shadow-[var(--shadow-card)]', level === 'alarm' && !history ? 'border-burgundy-400' : 'border-line')}>
                <header
                  className={cn(
                    'flex items-center gap-2 px-3 py-2',
                    history ? 'bg-surface-3' : level === 'alarm' ? 'bg-burgundy-600 text-white' : level === 'warn' ? 'bg-brass-500 text-espresso' : online ? 'bg-rose-500 text-white' : 'bg-forest-600 text-white',
                  )}
                >
                  {online && <Globe className="size-4" />}
                  <span className="truncate text-lg font-semibold">{t.label}</span>
                  <span className="text-sm opacity-80">#{t.orderNo}</span>
                  <span className="flex-1" />
                  <span className="tabular inline-flex items-center gap-1 text-sm font-semibold">
                    <Clock className="size-3.5" />
                    {mmss(age)}
                  </span>
                </header>
                {(t.waiterName || t.note || t.scheduledFor) && (
                  <div className="border-b border-line px-3 py-1.5 text-xs text-muted">
                    {t.waiterName && <span>{t.waiterName}</span>}
                    {t.scheduledFor && <span className="ml-2 font-semibold text-brass-400">Saat {new Date(t.scheduledFor).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>}
                    {t.note && <div className="mt-0.5 text-sm italic text-brass-300">"{t.note}"</div>}
                  </div>
                )}
                <ul className="divide-y divide-line">
                  {t.items.map((i) => (
                    <li key={i.id}>
                      <button
                        disabled={i.voided || online}
                        onClick={() => setStatus([i.id], history ? 'hazirlaniyor' : undefined)}
                        className={cn('flex w-full items-start gap-3 px-3 py-2.5 text-left', !i.voided && !online && 'active:bg-surface-2', i.voided && 'bg-burgundy-600/15')}
                      >
                        <span className={cn('tabular min-w-8 rounded-lg px-1.5 py-0.5 text-center text-lg font-bold', i.voided ? 'bg-burgundy-600 text-white' : 'bg-surface-3')}>{i.qty}</span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-[17px] font-semibold leading-tight', i.voided && 'line-through opacity-70')}>
                            {i.name}
                            {i.size !== 'TEK' && <span className="ml-1.5 rounded bg-surface-3 px-1.5 text-sm font-semibold">{i.size}</span>}
                          </span>
                          {i.optionsText && <span className="block text-sm text-brass-300">{i.optionsText}</span>}
                          {i.note && <span className="block text-sm italic text-rose-300">"{i.note}"</span>}
                          {i.voided && <span className="block text-sm font-bold text-burgundy-300">İPTAL EDİLDİ, YAPMAYIN</span>}
                        </span>
                        {!i.voided && <StatusDot status={i.status} />}
                      </button>
                    </li>
                  ))}
                </ul>
                <footer className="flex gap-2 border-t border-line p-2">
                  {online ? (
                    <>
                      {!allStarted && (
                        <button onClick={() => onlineStage(t.orderId, 'preparing')} className="h-11 flex-1 rounded-xl bg-surface-2 text-sm font-semibold">
                          Hazırlanıyor
                        </button>
                      )}
                      <button onClick={() => onlineStage(t.orderId, 'ready')} className="h-11 flex-1 rounded-xl bg-rose-500 text-sm font-semibold text-white">
                        Hazır (siteye bildir)
                      </button>
                    </>
                  ) : history ? (
                    <button onClick={() => setStatus(live.map((i) => i.id), 'hazirlaniyor')} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-surface-2 text-sm font-semibold">
                      <Undo2 className="size-4" /> Geri al
                    </button>
                  ) : (
                    <>
                      {!allStarted && (
                        <button onClick={() => setStatus(live.filter((i) => i.status === 'yeni').map((i) => i.id), 'hazirlaniyor')} className="h-11 flex-1 rounded-xl bg-surface-2 text-sm font-semibold">
                          Başla
                        </button>
                      )}
                      <button onClick={() => setStatus(live.map((i) => i.id), 'hazir')} className="h-11 flex-[2] rounded-xl bg-forest-600 text-sm font-semibold text-white">
                        Hepsi hazır
                      </button>
                    </>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      </div>
      {tickets.isError && (
        <div className="flex items-center gap-2 bg-burgundy-600 px-4 py-2 text-sm text-white">
          <RotateCcw className="size-4" /> Bağlantı sorunu; yeniden deneniyor
        </div>
      )}
      <SoldOutDialog open={soldOut} onClose={() => setSoldOut(false)} />
    </div>
  );
}

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} className={cn('rounded-xl px-3.5 py-2 text-sm font-medium pointer-coarse:min-h-11', active ? 'bg-forest-600 text-white' : 'bg-surface-2 text-ink-2')}>
      {children}
    </button>
  );
}

function StatusDot({ status }: { status: KitchenTicketItem['status'] }) {
  const map = {
    yeni: { cls: 'border-2 border-brass-400', label: 'Bekliyor' },
    hazirlaniyor: { cls: 'bg-brass-400 animate-pulse', label: 'Hazırlanıyor' },
    hazir: { cls: 'bg-forest-400', label: 'Hazır' },
    servis: { cls: 'bg-muted', label: 'Serviste' },
  }[status];
  return (
    <span className="mt-1 flex flex-col items-center gap-1 text-[11px] text-muted">
      <span className={cn('size-4 rounded-full', map.cls)} />
      {map.label}
    </span>
  );
}
