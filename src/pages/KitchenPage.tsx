import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, BellOff, CheckCheck, ChefHat, Clock, Globe, History, Layers, MonitorUp, MoreHorizontal, PackageX, RotateCcw, Undo2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { kitchenTotals } from '@shared/kitchen';
import { ticketHead } from '@shared/service-mode';
import { fmtTime } from '@shared/time';
import type { KitchenTicket, KitchenTicketItem } from '@shared/types';
import { SoldOutDialog } from '@/components/SoldOutDialog';
import { IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { EmptyState, Tabs } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useLocalPref, useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { beep, unlockAudio } from '@/lib/sound';
import { useTheme } from '@/lib/theme';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';
import { useServiceMode } from '@/lib/serviceMode';
import { appUrl } from '@/lib/demo';

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
  // Telefonda araç çubuğu tek düğmeye iner: Toplam, Geçmiş ve Tükendi bu pencerede
  const [more, setMore] = useState(false);
  const can = useCan();
  const mode = useServiceMode();
  const [sound, setSound] = useLocalPref<boolean>('kds.sound', true);
  // "Toplam": açık fişlerdeki ürünler toplu (6 latte, 2'si yulaflı); yoğunlukta topluca hazırlamak için
  const [totalsView, setTotalsView] = useLocalPref<boolean>('kds.toplam', false);
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
  const totals = useMemo(() => kitchenTotals(list), [list]);
  const showTotals = totalsView && !history;
  const counts = useMemo(() => ({ waiting: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'yeni').length, 0), making: list.reduce((a, t) => a + t.items.filter((i) => !i.voided && i.status === 'hazirlaniyor').length, 0) }), [list]);

  const canSoldOut = can('urun.tukendi') || can('menu.yonet');
  const callScreen = REMOTE ? null : (
    <ToolButton onClick={() => window.open(appUrl('/cagri'), 'lafpos-cagri')} title="Çağrı ekranını yeni pencerede aç (televizyon, müşteriye dönük tablet)">
      <MonitorUp className="size-4" /> Çağrı ekranı
    </ToolButton>
  );
  const tools = (
    <>
      {!history && (
        <ToolButton pressed={totalsView} onClick={() => setTotalsView(!totalsView)} title="Açık fişlerdeki ürünleri topla">
          <Layers className="size-4" /> {totalsView ? 'Fişler' : 'Toplam'}
        </ToolButton>
      )}
      <ToolButton pressed={history} onClick={() => setHistory(!history)}>
        <History className="size-4" /> {history ? 'Aktif fişler' : 'Geçmiş'}
      </ToolButton>
      {canSoldOut && (
        <ToolButton onClick={() => setSoldOut(true)}>
          <PackageX className="size-4" /> Tükendi
        </ToolButton>
      )}
    </>
  );

  return (
    <div className="flex h-full flex-col gap-3 bg-bg p-2 md:p-0" onPointerDown={unlockAudio}>
      {/* Başlık kartı iki satır: üstte ad, sayaçlar ve araçlar; altta istasyon sekmeleri (telefonda kayar) */}
      <div className="rounded-2xl border border-line bg-surface">
        <div className="flex items-center gap-2 px-3 py-2 md:px-4 md:py-2.5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2">
            <ChefHat className="size-5" />
          </span>
          <h1 className="min-w-0 truncate text-lg font-semibold tracking-[-0.01em]">Bar ve mutfak</h1>
          <div className="flex-1" />
          {!history && (
            <div className="flex gap-1.5 text-[13px] font-medium">
              <span className={cn('tabular inline-flex min-h-6 items-center rounded-md px-2', counts.waiting > 0 ? 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]' : 'bg-surface-3 text-muted')}>{counts.waiting} bekliyor</span>
              {counts.making > 0 && <span className="tabular inline-flex min-h-6 items-center rounded-md bg-[var(--admin-primary-soft)] px-2 text-[var(--admin-primary)]">{counts.making} hazırlanıyor</span>}
            </div>
          )}
          {/* Araçlar 1024 px üstünde satırda; tablet ve telefonda "Diğer" penceresinde (768 px'te satır taşıyordu) */}
          <div className="hidden items-center gap-1 lg:flex">
            {tools}
            {callScreen}
          </div>
          <IconButton label="Diğer" className="lg:hidden" onClick={() => setMore(true)}>
            <MoreHorizontal className="size-5" />
          </IconButton>
          <button onClick={() => setSound(!sound)} aria-label={sound ? 'Sesi kapat' : 'Sesi aç'} aria-pressed={sound} className="grid size-11 shrink-0 place-items-center rounded-xl text-ink-2 transition-colors duration-150 hover:bg-surface-2 active:bg-surface-3">
            {sound ? <Bell className="size-[18px]" /> : <BellOff className="size-[18px] text-muted" />}
          </button>
        </div>
        <Tabs label="İstasyon" className="border-t border-[var(--admin-divider)] px-2 py-1.5 md:px-3" value={station} onChange={setStation} options={[{ value: '', label: 'Tümü' }, ...boot.stations.map((s) => ({ value: s.id, label: s.name }))]} />
      </div>

      <Modal open={more} onClose={() => setMore(false)} title="Bar ekranı" size="sm">
        <div className="grid gap-1.5 p-3 [&_button]:w-full [&_button]:justify-start [&_button]:px-3" onClick={() => setMore(false)}>
          {tools}
          {/* Telefonda çağrı ekranı açılmaz (televizyon ya da müşteriye dönük tablet içindir) */}
          <span className="contents max-md:hidden">{callScreen}</span>
        </div>
      </Modal>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        {list.length === 0 && (
          <div className="grid h-full place-items-center">
            <EmptyState large icon={<CheckCheck />} title={history ? 'Son 90 dakikada hazırlanan yok' : 'Bekleyen sipariş yok'}>
              {history ? 'Hazır işaretlenen fişler 90 dakika burada kalır' : 'Yeni sipariş gelince ses çalar ve fiş burada belirir'}
            </EmptyState>
          </div>
        )}
        {showTotals && list.length > 0 && (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-3">
            {totals.map((r) => (
              <article key={r.key} className="rounded-2xl border border-line bg-surface p-3">
                <div className="flex items-start gap-3">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[19px] font-semibold leading-tight">
                      {r.name}
                      {r.size !== 'TEK' && <span className="ml-1.5 rounded-md bg-surface-3 px-1.5 text-sm font-semibold">{r.size}</span>}
                    </span>
                    <span className="tabular mt-1 block text-[13px] text-muted">
                      {[r.waiting && `${r.waiting} bekliyor`, r.making && `${r.making} hazırlanıyor`].filter(Boolean).join(' · ')}
                    </span>
                  </span>
                  <span className="tabular text-4xl font-bold leading-none tracking-tight">×{r.qty}</span>
                </div>
                {r.options.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {r.options.map((o) => (
                      <span key={o.text} className="tabular rounded-md bg-[var(--admin-warning-soft)] px-2 py-0.5 text-sm font-medium text-[var(--admin-warning)]">
                        {o.text} {o.qty}
                      </span>
                    ))}
                  </div>
                )}
              </article>
            ))}
          </div>
        )}
        <div className={cn('grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] items-start gap-3', showTotals && 'hidden')}>
          {list.map((t) => {
            const live = t.items.filter((i) => !i.voided);
            const age = now - t.sentAt;
            const level = age > boot.settings.kitchenAlarmMinutes * 60_000 ? 'alarm' : age > boot.settings.kitchenWarnMinutes * 60_000 ? 'warn' : 'ok';
            const online = t.source === 'laffogato';
            const allStarted = live.every((i) => i.status !== 'yeni');
            // Self modlarda numara, yarı selfte masa no büyük rozet: barista çağıracağı ya da götürüleceği yeri görür
            const head = ticketHead(t, mode);
            return (
              // Fiş: başlık nötr; süre rozeti yalnız gecikince renklenir (amber uyarı, kırmızı alarm)
              <article key={t.key} className={cn('overflow-hidden rounded-2xl border bg-surface', level === 'alarm' && !history ? 'border-danger-300 ring-2 ring-[var(--admin-danger-soft)] dark:border-danger-400' : 'border-line')}>
                <header className="flex items-center gap-2 border-b border-[var(--admin-divider)] px-3 py-2.5">
                  {online && (
                    <span className="inline-flex items-center gap-1 rounded-md bg-[var(--admin-hue-violet-soft)] px-1.5 py-0.5 text-xs font-medium text-[var(--admin-hue-violet)]">
                      <Globe className="size-3.5" /> Online
                    </span>
                  )}
                  {head.call && (
                    <span className="tabular shrink-0 rounded-lg bg-[var(--admin-primary-soft)] px-2 py-0.5 text-xl font-bold leading-tight text-[var(--admin-primary)]">{head.call}</span>
                  )}
                  {/* Nereye gideceği en büyük yazı: barın üstündeki tablet 1-2 m'den okunur */}
                  {head.label && <span className={cn('truncate', head.call ? 'text-sm text-ink-2' : 'text-xl font-bold tracking-[-0.01em]')}>{head.label}</span>}
                  {head.showNo && <span className="tabular shrink-0 text-sm text-muted">#{t.orderNo}</span>}
                  {t.waiterName && <span className="min-w-0 truncate text-sm text-muted">· {t.waiterName}</span>}
                  <span className="flex-1" />
                  <span
                    className={cn(
                      'tabular inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[15px] font-semibold',
                      history ? 'bg-surface-3 text-muted' : level === 'alarm' ? 'bg-[var(--admin-danger-soft)] text-[var(--admin-danger-ink)]' : level === 'warn' ? 'bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]' : 'bg-surface-3 text-ink-2',
                    )}
                  >
                    <Clock className="size-4" />
                    {mmss(age)}
                  </span>
                </header>
                {(t.note || t.scheduledFor) && (
                  <div className="border-b border-[var(--admin-divider)] px-3 py-1.5 text-sm">
                    {t.scheduledFor && <span className="font-semibold text-[var(--admin-warning)]">Saat {fmtTime(Date.parse(t.scheduledFor))}</span>}
                    {t.note && <div className="italic text-[var(--admin-warning)]">"{t.note}"</div>}
                  </div>
                )}
                <ul className="divide-y divide-[var(--admin-divider)]">
                  {t.items.map((i) => (
                    <li key={i.id}>
                      <button
                        disabled={i.voided || online || REMOTE}
                        onClick={() => setStatus([i.id], history ? 'hazirlaniyor' : undefined)}
                        className={cn('flex w-full items-start gap-3 px-3 py-3 text-left transition-colors duration-100', !i.voided && !online && 'active:bg-surface-3', i.voided && 'bg-[var(--admin-danger-soft)]')}
                      >
                        <span className={cn('tabular min-w-8 rounded-md px-1.5 py-0.5 text-center text-lg font-bold', i.voided ? 'bg-danger-600 text-white' : 'bg-surface-3')}>{i.qty}</span>
                        <span className="min-w-0 flex-1">
                          <span className={cn('block text-[17px] font-semibold leading-tight', i.voided && 'line-through opacity-70')}>
                            {i.name}
                            {i.size !== 'TEK' && <span className="ml-1.5 rounded-md bg-surface-3 px-1.5 text-sm font-semibold">{i.size}</span>}
                          </span>
                          {i.optionsText && <span className="block text-sm font-medium text-[var(--admin-warning)]">{i.optionsText}</span>}
                          {i.note && <span className="block text-sm italic text-[var(--admin-hue-rose)]">"{i.note}"</span>}
                          {i.voided && <span className="block text-sm font-bold text-[var(--admin-danger-ink)]">İPTAL EDİLDİ, YAPMAYIN</span>}
                        </span>
                        {!i.voided && <StatusDot status={i.status} />}
                      </button>
                    </li>
                  ))}
                </ul>
                <footer className={cn('flex gap-2 border-t border-[var(--admin-divider)] p-2', REMOTE && 'hidden')}>
                  {online ? (
                    <>
                      {!allStarted && (
                        <button onClick={() => onlineStage(t.orderId, 'preparing')} className="h-11 flex-1 rounded-xl border border-[var(--admin-border-strong)] text-sm font-semibold transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3">
                          Hazırlanıyor
                        </button>
                      )}
                      <button onClick={() => onlineStage(t.orderId, 'ready')} className="h-11 flex-1 rounded-xl bg-success-600 text-sm font-semibold text-white transition-colors duration-100 hover:bg-success-700 active:bg-success-700 active:brightness-95">
                        Hazır (siteye bildir)
                      </button>
                    </>
                  ) : history ? (
                    <button onClick={() => setStatus(live.map((i) => i.id), 'hazirlaniyor')} className="inline-flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-[var(--admin-border-strong)] text-sm font-semibold transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3">
                      <Undo2 className="size-4" /> Geri al
                    </button>
                  ) : (
                    <>
                      {!allStarted && (
                        <button onClick={() => setStatus(live.filter((i) => i.status === 'yeni').map((i) => i.id), 'hazirlaniyor')} className="h-11 flex-1 rounded-xl border border-[var(--admin-border-strong)] text-sm font-semibold transition-colors duration-100 hover:bg-surface-2 active:bg-surface-3">
                          Başla
                        </button>
                      )}
                      <button onClick={() => setStatus(live.map((i) => i.id), 'hazir')} className="h-11 flex-[2] rounded-xl bg-success-600 text-sm font-semibold text-white transition-colors duration-100 hover:bg-success-700 active:bg-success-700 active:brightness-95">
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
        <div className="flex items-center gap-2 rounded-xl bg-danger-600 px-4 py-2 text-sm text-white">
          <RotateCcw className="size-4" /> Bağlantı sorunu; yeniden deneniyor
        </div>
      )}
      <SoldOutDialog open={soldOut} onClose={() => setSoldOut(false)} />
    </div>
  );
}

/** Araç çubuğu düğmesi: Tabs ile aynı dil (basılı gri, renksiz); aria-pressed ile açık/kapalı */
function ToolButton({ pressed, className, children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { pressed?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex min-h-11 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-sm transition-colors duration-150 active:bg-surface-3 pointer-fine:min-h-9',
        pressed ? 'bg-surface-3 font-semibold text-ink' : 'font-medium text-ink-2 hover:bg-surface-2 hover:text-ink',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}

/** Kalem durumu: bekleyen içi boş halka (varsayılan, yazısız), hazırlanan dolu amber, hazır yeşil */
function StatusDot({ status }: { status: KitchenTicketItem['status'] }) {
  const map = {
    yeni: { cls: 'border-2 border-[var(--admin-warning)]', label: 'Bekliyor' },
    hazirlaniyor: { cls: 'bg-warn-500 animate-pulse', label: 'Hazırlanıyor' },
    hazir: { cls: 'bg-success-600 dark:bg-success-300', label: 'Hazır' },
    servis: { cls: 'bg-muted', label: 'Serviste' },
  }[status];
  return (
    <span className="mt-1 flex shrink-0 flex-col items-center gap-1 text-xs font-medium text-muted" role="img" aria-label={map.label}>
      <span className={cn('size-3.5 rounded-full', map.cls)} />
      {status !== 'yeni' && <span aria-hidden="true">{map.label}</span>}
    </span>
  );
}
