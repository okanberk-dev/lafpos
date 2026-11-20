import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, VolumeX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import { fmtAgo } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { useAlertPrefs } from '@/lib/alertPrefs';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useTick } from '@/lib/hooks';
import { onLive } from '@/lib/live';
import { ACKS_KEY, type Acks, addAcks, alertPerms, parseAcks, pendingOnline, pendingTitle, RING_CYCLE_MS, ringLevel, setOnlineRinger, siteEventCue } from '@/lib/siteAlerts';
import { audioUnlocked, beep, onAudioChange, ring, unlockAudio } from '@/lib/sound';
import { toast } from '@/lib/toast';

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
 * da siteden kalkması susturur. Siteden kalkan sipariş ve sitedeki karaoke tek ses ve bildirimle. İlk dokunuş sesi
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
  const latest = useRef({ prefs, perms });
  latest.current = { prefs, perms };
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
      const { prefs: p, perms: allowed } = latest.current;
      const cue = siteEventCue(e, p, allowed);
      if (!cue) return;
      if (cue.refetch) void qc.invalidateQueries({ queryKey: ['site-alerts'] });
      if (cue.ack) ack([cue.ack]);
      if (cue.sound) {
        if (!audioUnlocked()) setMissed(true);
        else if (cue.sound === 'ring') ring(p.volume);
        else beep(cue.sound, p.volume);
      }
      if (cue.toast) toast[cue.toast.tone](cue.toast.text);
    });
  }, [any, qc, ack]);

  // Açılan sipariş bu cihazda görülmüş sayılır: adisyondan çıkınca yeniden çalmaz
  const openOrderId = /^\/adisyon\/([^/]+)/.exec(location.pathname)?.[1] ?? null;
  const online = data.data?.online;
  useEffect(() => {
    if (openOrderId && !acks[openOrderId] && online?.some((o) => o.orderId === openOrderId)) ack([openOrderId]);
  }, [openOrderId, online, acks, ack]);

  const pending = pendingOnline(data.data, acks, prefs, perms, now, openOrderId);

  // Zil: bekleyen varken 3 sn'de bir (sitenin panelindeki gibi); döngü yalnız başlar ya da durur, liste ref'ten okunur
  const ringing = pending.length > 0 && prefs.sound && unlocked;
  const ringRef = useRef({ pending, volume: prefs.volume });
  ringRef.current = { pending, volume: prefs.volume };
  useEffect(() => {
    if (!ringing) return;
    const tick = () => {
      const { pending: list, volume } = ringRef.current;
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
    if (open && pending.length === 0) setOpen(false);
  }, [open, pending.length]);

  const needsUnlock = prefs.sound && !unlocked && (pending.length > 0 || missed);
  if (!any || (pending.length === 0 && !needsUnlock)) return null;
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
          dolu mor daire; dokununca liste, sağda "Gördüm". Telefonda tam genişlik, tablet ve bilgisayarda sahnenin üstünde hap */}
      <div
        role="region"
        aria-label="Sitenin uyarıları"
        className="flex min-h-11 w-full shrink-0 items-center gap-1 border-b border-violet-line bg-violet-soft py-0.5 pl-3 pr-1.5 text-sm text-ink md:mx-3 md:mt-3 md:w-auto md:rounded-[1.25rem] md:border md:pl-2"
      >
        {first ? (
          <button type="button" onClick={() => setOpen(true)} className="flex min-h-11 min-w-0 flex-1 items-center gap-2.5 text-left transition-[filter] duration-150 hover:brightness-[0.98] active:brightness-95">
            <span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full bg-[var(--admin-hue-violet)] text-[var(--admin-surface)]">
              <Globe className="size-3.5 stroke-[2.25]" />
            </span>
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
          <span className="min-w-0 flex-1 truncate font-semibold text-violet-ink">Ses kapalı: uyarılar çalamadı</span>
        )}
        {unlockChip}
        {first && (
          <button
            type="button"
            onClick={() => ack(pending.map((o) => o.orderId))}
            className="inline-flex min-h-11 shrink-0 items-center rounded-full px-3 font-semibold text-violet-ink underline underline-offset-2 transition-colors duration-150 hover:bg-hover active:bg-press"
          >
            Gördüm
          </button>
        )}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title={pending.length === 1 ? 'Yeni online sipariş' : 'Yeni online siparişler'} subtitle="Sitede ödendi; bar ekranında da görünür" size="sm">
        <ul className="divide-y divide-line px-4 pb-4">
          {pending.map((o) => (
            <li key={o.orderId} className="flex flex-wrap items-center gap-2 py-3">
              <span className="min-w-0 flex-1">
                <span className="block font-semibold">
                  #{o.no}
                  {o.label ? ` · ${o.label}` : ''}
                </span>
                <span className="block text-[13px] text-muted">
                  {fmtAgo(o.openedAt, now) === 'az önce' ? 'Az önce geldi' : `${fmtAgo(o.openedAt, now)} önce geldi`}
                </span>
              </span>
              <Button size="sm" onClick={() => ack([o.orderId])}>
                Gördüm
              </Button>
              {canOpen && (
                <Button
                  size="sm"
                  variant="soft"
                  onClick={() => {
                    ack([o.orderId]);
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
