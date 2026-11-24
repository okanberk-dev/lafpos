import { useQuery, useQueryClient } from '@tanstack/react-query';
import { VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { type OnlineAlertDTO, type SiteAlertsDTO, type TableCallDTO, tableCallReasonText } from '@shared/site-alerts';
import { fmtAgo, fmtTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { InboxBell } from '@/components/ui/InboxBell';
import { Modal } from '@/components/ui/Modal';
import { useAlertPrefs } from '@/lib/alertPrefs';
import { ApiError, errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import {
  ACKS_KEY,
  type Acks,
  addAcks,
  alertPerms,
  callsTitle,
  notYetDue,
  onlineAckKey,
  onlineAckKeys,
  parseAcks,
  pendingCalls,
  pendingOnline,
  pendingTitle,
  RING_CYCLE_MS,
  ringLevel,
  setOnlineRinger,
  siteEventCue,
} from '@/lib/siteAlerts';
import { audioUnlocked, beep, onAudioChange, ring, unlockAudio } from '@/lib/sound';
import { toast } from '@/lib/toast';

/** Siparişin alt satırı: "Az önce geldi", "12 dk önce geldi"; planlı siparişte "Saat 09:00 için" */
function alertWhen(o: OnlineAlertDTO, now: number): string {
  const at = o.scheduledFor ? Date.parse(o.scheduledFor) : Number.NaN;
  if (Number.isFinite(at)) return `Saat ${fmtTime(at)} için`;
  const ago = fmtAgo(o.openedAt, now);
  return ago === 'az önce' ? 'Az önce geldi' : `${ago} önce geldi`;
}

function readAcks(): Acks {
  try {
    return parseAcks(localStorage.getItem(ACKS_KEY), Date.now());
  } catch {
    return {};
  }
}

function writeAcks(acks: Acks) {
  try {
    localStorage.setItem(ACKS_KEY, JSON.stringify(acks));
  } catch {
    /* özel pencere: bu sekmede bellekte */
  }
}

/**
 * Diğer sistemlerden gelen sesli uyarılar (operatör, 20 Kas 2026: "siparişler, karaoke gelince LafPOS'ta da ötsün").
 * Kabukta, platform şeridinin yanında; her ekranda takılı. Yeni online sipariş (uygulama, web, masa QR) sitenin
 * panelindeki zille 3 sn'de bir çalar ve üstte şerit durur: "Gördüm" (bu cihaz), siparişi açmak, aşamanın değişmesi ya
 * da siteden kalkması susturur. Masadan çağrı (uygulamada "Garson çağır", su, peçete) aynı zille, şeridin başında:
 * "Gördüm" çağrıyı sitede yanıtlar, bütün cihazlarda susar. Siteden kalkan sipariş ve sitedeki karaoke tek ses ve
 * bildirimle. İlk dokunuş sesi
 * açar (tarayıcı kuralı); ses kilitliyken şeritte "Sesi açmak için dokunun". Tercihler Araçlar › Sesli uyarılar'da,
 * bu cihazda. Kurallar src/lib/siteAlerts.ts; siteye istek atmaz (liste var olan sipariş çekiminden).
 */
export function SiteInbox() {
  const can = useCan();
  const perms = alertPerms(can);
  const any = perms.online || perms.karaoke;
  const prefs = useAlertPrefs();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const unlocked = useSyncExternalStore(onAudioChange, audioUnlocked, () => false);
  const data = useQuery({
    queryKey: ['site-alerts'],
    queryFn: () => get<SiteAlertsDTO>('/sync/alerts'),
    enabled: perms.online,
    // Yalnız yerel liste; olaylar zaten yeniler. Site bağlantısı yoksa yoklama yok
    refetchInterval: (q) => (q.state.data?.configured ? 60_000 : false),
  });
  const online = data.data?.online;
  const [acks, setAcks] = useState<Acks>(readAcks);
  const [open, setOpen] = useState(false);
  // Ses kilitliyken tek seferlik bir uyarı çalamadı: şerit sesi açmayı önerir
  const [missed, setMissed] = useState(false);
  const now = useTick(15_000);

  const ack = useCallback((ids: string[]) => {
    if (!ids.length) return;
    setAcks((prev) => {
      const next = addAcks(prev, ids, Date.now());
      writeAcks(next);
      return next;
    });
  }, []);
  const unack = useCallback((id: string) => {
    setAcks((prev) => {
      if (!prev[id]) return prev;
      const next = { ...prev };
      delete next[id];
      writeAcks(next);
      return next;
    });
  }, []);

  // İlk dokunuş sesi açar (tarayıcılar sesi ancak sayfaya dokunulunca çalar); iPad'in kestiği bağlam da yeniden açılır
  useEffect(() => {
    if (!any) return;
    const on = () => {
      if (!audioUnlocked()) void unlockAudio();
    };
    window.addEventListener('pointerdown', on, { capture: true, passive: true });
    window.addEventListener('keydown', on, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', on, { capture: true });
      window.removeEventListener('keydown', on, { capture: true });
    };
  }, [any]);

  useEffect(() => {
    if (unlocked) setMissed(false);
  }, [unlocked]);

  // Başka sekmedeki "Gördüm"
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === null || e.key === ACKS_KEY) setAcks(readAcks());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  // Canlı olaylar: liste yenilenir, tek seferlik ses ve bildirim
  const latest = useRef({ prefs, perms, online });
  useEffect(() => {
    latest.current = { prefs, perms, online };
  });
  useEffect(() => {
    if (!any) return;
    // Aynı olay ikinci kez gelirse (yeniden bağlanan akışın artığı) ikinci ses ve bildirim çıkmaz
    // (anahtar sıra ve an: sunucu yeniden başlayınca sıra 1'den başlar)
    const handled = new Set<string>();
    return onLive((e) => {
      const key = `${e.seq}:${e.at}`;
      if (handled.has(key)) return;
      handled.add(key);
      if (handled.size > 200) handled.delete(handled.values().next().value as string);
      const { prefs: p, perms: allowed, online: list } = latest.current;
      const cue = siteEventCue(e, p, allowed);
      if (!cue) return;
      if (cue.refetch) void qc.invalidateQueries({ queryKey: ['site-alerts'] });
      // Saati gelmemiş planlı siparişe "Gördüm" yazılmaz: saati gelince yine çalar
      if (cue.ack) ack(onlineAckKeys(list, [cue.ack], Date.now()));
      if (cue.sound) {
        if (!audioUnlocked()) setMissed(true);
        else if (cue.sound === 'ring') ring(p.volume);
        else beep(cue.sound, p.volume);
      }
      if (cue.toast) toast[cue.toast.tone](cue.toast.text);
    });
  }, [any, qc, ack]);

  // Açılan sipariş bu cihazda görülmüş sayılır: adisyondan çıkınca yeniden çalmaz. Saati gelmemiş planlı sipariş saati
  // gelince sayılır (ekranda hâlâ açıksa); öncesinde çıkılırsa saatinde çalar
  const openOrderId = /^\/adisyon\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  useEffect(() => {
    const o = openOrderId ? online?.find((x) => x.orderId === openOrderId) : undefined;
    if (o && !notYetDue(o, now) && !acks[onlineAckKey(o)]) ack([onlineAckKey(o)]);
  }, [openOrderId, online, acks, ack, now]);

  const pending = pendingOnline(data.data, acks, prefs, perms, now, openOrderId);
  const calls = pendingCalls(data.data, acks, prefs, perms, now);
  const total = calls.length + pending.length;

  // "Gördüm" (çağrı): bu cihazda hemen susar, çağrı sitede yanıtlanır; sunucunun olayı öteki cihazları da susturur.
  // Site yanıtı almadıysa çağrı her cihazda açık kalır: bu cihazda da geri gelir, yeniden denenir. Çağrı bu arada
  // düştüyse (404: sitede ya da başka cihazda yanıtlandı, süresi geçti) sessizce susar
  const [answering, setAnswering] = useState<string | null>(null);
  const answer = async (c: TableCallDTO) => {
    ack([c.id]);
    setAnswering(c.id);
    try {
      await post(`/sync/calls/${encodeURIComponent(c.id)}/ack`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {
        unack(c.id);
        toast.err(errorMessage(e));
      }
    } finally {
      setAnswering(null);
      void qc.invalidateQueries({ queryKey: ['site-alerts'] });
    }
  };

  // Zil: bekleyen varken 3 sn'de bir (sitenin panelindeki gibi); döngü yalnız başlar ya da durur, liste ref'ten okunur.
  // Masa çağrısı masa siparişi gibi tam düzeyde
  const ringing = total > 0 && prefs.sound && unlocked;
  const ringList = [...calls.map(() => ({ table: true })), ...pending];
  const ringRef = useRef({ list: ringList, volume: prefs.volume });
  // Çizimden sonra (zil efektinden önce): döngü en son listeyi ve düzeyi okur
  useEffect(() => {
    ringRef.current = { list: ringList, volume: prefs.volume };
  });
  useEffect(() => {
    if (!ringing) return;
    const tick = () => {
      const { list, volume } = ringRef.current;
      if (list.length) ring(ringLevel(list, volume));
    };
    tick();
    const t = setInterval(tick, RING_CYCLE_MS);
    return () => clearInterval(t);
  }, [ringing]);

  // Bar ekranı online fişte kendi sesini çalmasın (src/pages/KitchenPage.tsx)
  const ringerOn = perms.online && prefs.online && prefs.sound;
  useEffect(() => {
    setOnlineRinger(ringerOn);
    return () => setOnlineRinger(false);
  }, [ringerOn]);

  useEffect(() => {
    if (open && total === 0) setOpen(false);
  }, [open, total]);

  const needsUnlock = prefs.sound && !unlocked && (total > 0 || missed);
  if (!any || (total === 0 && !needsUnlock)) return null;
  const firstCall = calls[0];
  const first = pending[0];
  const canOpen = can('siparis.al') || can('odeme.al');
  const unlockChip = needsUnlock && (
    <button
      type="button"
      onClick={() => void unlockAudio()}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[13px] font-semibold text-violet-ink transition-colors duration-150 hover:bg-hover active:bg-press"
    >
      <VolumeX aria-hidden="true" className="size-4" />
      <span className="max-sm:hidden">Sesi açmak için dokunun</span>
      <span className="sm:hidden">Sesi aç</span>
    </button>
  );

  return (
    <>
      {/* Şerit (platform şeridinin kardeşi): online siparişin rengi mor (Masalar ve Siparişler'de olduğu gibi), başında
          dolu mor dairede zil (yeni çağrı ya da sipariş gelince sallanır, rozetin rakamı döner); dokununca liste, sağda "Gördüm". Telefonda tam genişlik, tablet ve bilgisayarda sahnenin üstünde hap */}
      <div
        role="region"
        aria-label="Sitenin uyarıları"
        className="flex min-h-11 w-full shrink-0 items-center gap-1 border-b border-violet-line bg-violet-soft py-0.5 pl-3 pr-1.5 text-sm text-ink md:w-auto md:rounded-[1.25rem] md:border md:pl-2"
      >
        {firstCall ? (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left transition-[filter] duration-150 hover:brightness-[0.98] active:brightness-95">
            <InboxBell count={total} tone="violet" />
            <span className="min-w-0 flex-1 truncate font-semibold text-violet-ink">
              {callsTitle(calls.length)}
              <span className="font-normal text-ink-2">
                {' '}
                · {firstCall.label} · {tableCallReasonText(firstCall.reason)}
                {/* Bekleyen online sipariş de varsa listede: şerit onu da söyler */}
                {pending.length > 0 && ` · ${pendingTitle(pending.length).toLocaleLowerCase('tr-TR')}`}
              </span>
            </span>
          </button>
        ) : first ? (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left transition-[filter] duration-150 hover:brightness-[0.98] active:brightness-95">
            <InboxBell count={total} tone="violet" />
            <span className="min-w-0 flex-1 truncate font-semibold text-violet-ink">
              {pendingTitle(pending.length)}
              <span className="font-normal text-ink-2">
                {' '}
                · #{first.no}
                {first.label ? ` · ${first.label}` : ''}
              </span>
            </span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate font-semibold text-violet-ink">Tarayıcının sesi kapalı; uyarı çalamadı</span>
        )}
        {unlockChip}
        {firstCall ? (
          <button
            type="button"
            disabled={answering === firstCall.id}
            onClick={() => void answer(firstCall)}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 font-semibold text-violet-ink underline underline-offset-2 transition-colors duration-150 hover:bg-hover active:bg-press disabled:cursor-progress"
          >
            Gördüm
          </button>
        ) : first && (
          <button
            type="button"
            onClick={() => ack(pending.map((o) => onlineAckKey(o)))}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 font-semibold text-violet-ink underline underline-offset-2 transition-colors duration-150 hover:bg-hover active:bg-press"
          >
            Gördüm
          </button>
        )}
      </div>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={!calls.length ? (pending.length === 1 ? 'Yeni online sipariş' : 'Yeni online siparişler') : !pending.length ? (calls.length === 1 ? 'Masa çağrısı' : 'Masa çağrıları') : 'Sitenin uyarıları'}
        subtitle={!calls.length ? 'Sitede ödendi; bar ekranında da görünür' : !pending.length ? 'Uygulamadan; Gördüm çağrıyı sitede de yanıtlar' : 'Masa çağrıları ve yeni online siparişler'}
        size="sm"
      >
        <ul className="divide-y divide-line px-4 pb-4">
          {calls.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  {c.label} · {tableCallReasonText(c.reason)}
                </span>
                <span className="block text-[13px] text-muted">{fmtAgo(c.createdAt, now) === 'az önce' ? 'Az önce çağırdı' : `${fmtAgo(c.createdAt, now)} önce çağırdı`}</span>
              </span>
              <Button size="sm" loading={answering === c.id} onClick={() => void answer(c)}>
                Gördüm
              </Button>
            </li>
          ))}
          {pending.map((o) => (
            <li key={o.orderId} className="flex flex-wrap items-center gap-2 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  #{o.no}
                  {o.label ? ` · ${o.label}` : ''}
                </span>
                <span className="block text-[13px] text-muted">{alertWhen(o, now)}</span>
              </span>
              <Button size="sm" onClick={() => ack([onlineAckKey(o)])}>
                Gördüm
              </Button>
              {canOpen && (
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    ack([onlineAckKey(o)]);
                    setOpen(false);
                    navigate(`/adisyon/${o.orderId}`);
                  }}
                >
                  Aç
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Modal>
    </>
  );
}
