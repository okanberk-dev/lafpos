import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Link2, Mic2, Play, RefreshCw, Square } from 'lucide-react';
import { useState } from 'react';
import { blockTerms, bookingCode, bookingHours, bookingPayment, holdsRoom, linkChoices, type RoomBookingSnapshot, type SiteKaraokeBooking } from '@shared/karaoke';
import { tl } from '@shared/money';
import { fmtElapsed, fmtTime } from '@shared/time';
import type { OrderDTO, SiteKaraokeBookingDTO, SiteKaraokeDTO, TableDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/misc';
import { errorMessage, get, post } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { REMOTE } from '@/lib/remote';
import { toast } from '@/lib/toast';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, okMessage?: string) => Promise<T | null>;

/** Ekranda gösterilen her rezervasyon için tek satır: saat, ad, kişi */
const who = (b: SiteKaraokeBooking) => [b.firstName || 'Adsız', `${b.guests || '?'} kişi`].join(' · ');

/**
 * Sitedeki bugünkü karaoke rezervasyonları (docs/03-ENTEGRASYON.md §2.4). Açılınca liste geride kaldıysa sunucu bir
 * çekim yapar (`fresh=1`); sonra yalnız rezervasyon olayıyla yenilenir. Site bağlantısı yoksa hiç sorulmaz.
 */
export function useSiteKaraoke(enabled: boolean) {
  return useQuery({
    queryKey: ['site-karaoke'],
    queryFn: () => get<SiteKaraokeDTO>('/sync/karaoke?fresh=1'),
    enabled: enabled && !REMOTE,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
}

/** "1 sa 20 dk", "45 dk" */
const fmtMin = (m: number) => [Math.floor(m / 60) ? `${Math.floor(m / 60)} sa` : '', m % 60 ? `${m % 60} dk` : ''].filter(Boolean).join(' ') || '0 dk';

/** Bağlı rezervasyonun bloğu sayaç çalışırken: ne kadarı kaldı ya da ne kadar aşıldı */
function blockLine(booking: Pick<SiteKaraokeBooking, 'status' | 'paymentStatus' | 'totalMinor' | 'hours'> & { note?: string }, prepaid: number, elapsedMin: number, hourlyRate: number): string {
  const terms = blockTerms(booking);
  if (!terms) return booking.status === 'cancelled' ? 'Rezervasyon iptal: bütün süre saat ücretiyle' : booking.paymentStatus === 'pending' ? 'Ödemesi sürüyor: ödenmezse bütün süre saat ücretiyle' : 'Blok sayılmıyor: bütün süre saat ücretiyle';
  const left = prepaid - elapsedMin;
  const head = terms === 'paid' ? 'Sitede ödendi' : booking.totalMinor ? `Köşkte ödenecek ${tl(booking.totalMinor)}` : 'Ücretsiz telafi saati';
  if (left > 0) return `${head} · blokta ${fmtMin(left)} kaldı`;
  return `${head} · blok bitti, aşan süre saatlik ${tl(hourlyRate)}`;
}

/**
 * Karaoke odasının adisyondaki kutusu: sayaç (başlat / durdur) ve site bağlıysa bugünkü rezervasyonlar. "Başlat" o
 * saate düşen rezervasyonu önerir; seçilen rezervasyon sayaca bağlanır, sitede ödenmiş blok kasada yeniden alınmaz.
 * Liste gelmeden "Başlat" karar vermez (beklenir); rezervasyonsuz başlamış sayaç sonradan bağlanabilir. Sayaç
 * blokta kalıp boş adisyon kapanınca `onClosed` (plana dönüş).
 */
export function RoomBox({ order, table, editable, act, now, onClosed }: { order: OrderDTO; table: TableDTO; editable: boolean; act: Act; now: number; onClosed?: () => void }) {
  const boot = useBoot();
  const qc = useQueryClient();
  const can = useCan();
  // Liste siparişi alan ya da rezervasyonu yöneten role açık (sunucu da aynı kapıyı uygular)
  const siteOn = boot.integrations.siteKaraoke && (can('siparis.al') || can('rezervasyon.yonet'));
  const karaoke = useSiteKaraoke(siteOn);
  // Seçim penceresi: sayacı başlatırken ya da çalışan rezervasyonsuz sayacı bağlarken
  const [choose, setChoose] = useState<'start' | 'link' | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const list = karaoke.data?.bookings ?? [];
  const room = order.room;
  const linkedId = room?.bookingId ?? null;
  const linkedLive = linkedId ? list.find((b) => b.id === linkedId) : undefined;
  const linked: (RoomBookingSnapshot & { note?: string }) | null = linkedLive ?? room?.booking ?? null;
  // Odayı tutan, bitmemiş, bu sayaca bağlı olmayan rezervasyonlar; en çok üçü
  const upcoming = list.filter((b) => holdsRoom(b) && Date.parse(b.endsAt) > now && b.id !== linkedId);
  const choices = linkChoices(list, now);
  const anyChoice = choices.atHand.length + choices.later.length > 0;
  // Liste gelmeden karar verilmez: sitede ödenmiş rezervasyon görünmeden sayaç rezervasyonsuz başlamasın
  const listLoading = siteOn && !REMOTE && (karaoke.isFetching || (!karaoke.data && !karaoke.isError));
  const listBroken = karaoke.isError || karaoke.data?.state === 'hata';

  const start = async (bookingId: string | null) => {
    setChoose(null);
    const res = await act((pin) => post<OrderDTO>(`/orders/${order.id}/room/start`, { approverPin: pin, bookingId }), bookingId ? `Oda sayacı ${bookingCode(bookingId)} ile başladı` : 'Oda sayacı başladı');
    if (res) void qc.invalidateQueries({ queryKey: ['site-karaoke'] });
  };
  const stop = async () => {
    const before = new Set(order.items.map((i) => i.id));
    const res = await act((pin) => post<OrderDTO>(`/orders/${order.id}/room/stop`, { approverPin: pin }));
    if (!res) return;
    void qc.invalidateQueries({ queryKey: ['site-karaoke'] });
    // Bağlı blokta kalan süre adisyona satır yazmaz; adisyonda başka bir şey yoksa sunucu adisyonu da kapatır
    if (res.status === 'kapali') {
      toast.ok('Oda sayacı durdu: süre rezervasyon bloğunda kaldı, boş adisyon kapandı');
      onClosed?.();
      return;
    }
    toast.ok(res.items.some((i) => !before.has(i.id)) ? 'Oda ücreti adisyona eklendi' : 'Oda sayacı durdu: süre rezervasyon bloğunda kaldı, ücret yok');
  };
  const link = async (bookingId: string) => {
    setChoose(null);
    const res = await act(() => post<OrderDTO>(`/orders/${order.id}/room/link`, { bookingId }), `Sayaç ${bookingCode(bookingId)} rezervasyonuna bağlandı`);
    if (res) void qc.invalidateQueries({ queryKey: ['site-karaoke'] });
  };
  // Bağlanabilecek rezervasyon varsa ya da liste okunamadıysa seçim penceresi açılır; yoksa bugünkü gibi başlar
  const onStart = () => (siteOn && !REMOTE && (anyChoice || listBroken) ? setChoose('start') : void start(null));
  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(['site-karaoke'], await post<SiteKaraokeDTO>('/sync/karaoke/refresh'));
    } catch (e) {
      toast.err(errorMessage(e));
      void qc.invalidateQueries({ queryKey: ['site-karaoke'] });
    } finally {
      setRefreshing(false);
    }
  };

  const elapsedMin = room ? Math.max(0, Math.floor((now - room.startedAt) / 60_000)) : 0;
  const state = karaoke.data?.state;
  const siteNote = !siteOn || REMOTE ? null : state === 'kapali' ? (karaoke.data?.message ?? 'Site karaoke rezervasyonlarını kasaya açmadı') : state === 'hata' ? `Liste güncel olmayabilir: ${karaoke.data?.message ?? 'site yanıt vermedi'}` : null;

  return (
    <div className={cn('border-b border-[var(--admin-divider)]', room && 'bg-[var(--admin-hue-violet-soft)]')}>
      <div className="flex items-center gap-3 px-4 py-2">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', room ? 'bg-surface text-[var(--admin-hue-violet)]' : 'bg-surface-3 text-ink-2')}>
          <Mic2 className="size-4" strokeWidth={1.75} />
        </span>
        <span className="min-w-0 flex-1 text-[13px]">
          {room ? (
            <>
              <span className="tabular block font-semibold">Oda açık · {fmtElapsed(room.startedAt, now)}</span>
              <span className="block text-muted">
                {fmtTime(room.startedAt)}'den beri · saatlik {tl(room.hourlyRate)}
              </span>
            </>
          ) : (
            <span className="font-medium text-ink-2">Oda sayacı kapalı</span>
          )}
        </span>
        {editable &&
          (room ? (
            <Button size="sm" variant="danger" icon={<Square className="size-3.5" />} onClick={() => void stop()}>
              Durdur
            </Button>
          ) : (
            // Liste gelirken düğme bekler: sitede ödenmiş rezervasyon görünmeden sayaç rezervasyonsuz başlamasın
            <Button size="sm" variant="secondary" icon={<Play className="size-3.5" />} loading={listLoading} onClick={onStart}>
              {listLoading ? 'Rezervasyonlar yükleniyor' : 'Başlat'}
            </Button>
          ))}
      </div>

      {room && !linkedId && editable && siteOn && !REMOTE && anyChoice && (
        // Rezervasyonsuz başlamış sayaç sonradan bağlanır (liste geç geldi, grup erken geldi)
        <div className="flex items-center gap-3 px-4 pb-2">
          <span className="min-w-0 flex-1 text-xs text-muted">Sitede rezervasyonu varsa bağlayın: sitede ödenen saat kasada alınmaz</span>
          <Button size="sm" variant="secondary" icon={<Link2 className="size-3.5" />} onClick={() => setChoose('link')}>
            Rezervasyona bağla
          </Button>
        </div>
      )}

      {room && linkedId && (
        // Bağlı rezervasyon: kodu, saati ve bloğun durumu (sayaç satırının altında, tam genişlikte). Uzaktan özetinde
        // kod yoktur (kişisel veri; §2.4)
        <p className="px-4 pb-2 text-[13px] text-ink-2">
          <span className="tabular whitespace-nowrap font-medium">{REMOTE ? 'Site rezervasyonu' : bookingCode(linkedId)}</span>
          {linked && (
            <>
              {' · '}
              <span className="tabular whitespace-nowrap">{bookingHours(linked)}</span>
              {` · ${blockLine(linked, room.prepaidMinutes ?? 0, elapsedMin, room.hourlyRate)}`}
            </>
          )}
        </p>
      )}

      {siteOn && !REMOTE && (upcoming.length > 0 || siteNote) && (
        <div className="px-4 pb-2">
          <div className="flex items-center gap-2 text-xs text-muted">
            <CalendarClock className="size-3.5 shrink-0" strokeWidth={1.75} />
            <span className="flex-1">{upcoming.length ? 'Sitedeki rezervasyonlar (bugün)' : 'Sitedeki rezervasyonlar'}</span>
            <IconButton label="Sitedeki rezervasyonları yenile" onClick={refresh} disabled={refreshing} className="-my-2 -mr-2">
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} strokeWidth={1.75} />
            </IconButton>
          </div>
          {siteNote && <p className={cn('text-xs', state === 'hata' ? 'text-[var(--admin-warning)]' : 'text-muted')}>{siteNote}</p>}
          <ul className="space-y-1">
            {upcoming.slice(0, 3).map((b) => {
              const pay = bookingPayment(b);
              return (
                <li key={b.id} className="text-[13px]">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <span className="tabular whitespace-nowrap font-semibold">{bookingHours(b)}</span>
                    <span className="min-w-0 truncate">{who(b)}</span>
                    <Badge tone={pay.tone}>{pay.text}</Badge>
                    {b.session?.active && <span className="text-xs text-muted">#{b.session.orderNo} adisyonda sayaçta</span>}
                  </div>
                  {b.note && <div className="truncate text-xs italic text-ink-2" title={b.note}>{b.note}</div>}
                </li>
              );
            })}
            {upcoming.length > 3 && <li className="text-xs text-muted">ve {upcoming.length - 3} rezervasyon daha</li>}
          </ul>
        </div>
      )}

      <Modal
        open={!!choose}
        onClose={() => setChoose(null)}
        title={choose === 'link' ? `${table.name}: rezervasyona bağla` : `${table.name}: sayacı başlat`}
        subtitle={choose === 'link' && room ? `Blok sayacın başladığı ${fmtTime(room.startedAt)}'den sayılır; sitede ödenen saat kasada alınmaz` : 'Sitedeki rezervasyonla bağlayın: sitede ödenen saat kasada yeniden alınmaz'}
        size="sm"
      >
        <div className="space-y-2 p-4">
          {listBroken && (
            <p className="text-xs text-[var(--admin-warning)]">
              Sitedeki liste güncel olmayabilir{karaoke.data?.message ? `: ${karaoke.data.message}` : ''}. Rezervasyon burada yoksa kapatıp listeyi yenileyin; sayaç sonradan da bağlanabilir
            </p>
          )}
          {choices.atHand.map((b) => (
            <BookingChoice key={b.id} booking={b} onPick={() => (choose === 'link' ? link(b.id) : start(b.id))} />
          ))}
          {choices.later.length > 0 && (
            <>
              <p className="pt-1 text-xs font-medium text-muted">Bugün daha sonra</p>
              {choices.later.map((b) => (
                <BookingChoice key={b.id} booking={b} onPick={() => (choose === 'link' ? link(b.id) : start(b.id))} />
              ))}
            </>
          )}
          {choose === 'link' ? (
            <Button block variant="ghost" onClick={() => setChoose(null)}>
              Vazgeç
            </Button>
          ) : (
            <Button block variant="ghost" onClick={() => start(null)}>
              Rezervasyonsuz başlat
            </Button>
          )}
        </div>
      </Modal>
    </div>
  );
}

/** Seçim penceresinde bir rezervasyon: saat, ad, kişi, ödeme durumu, kod, not */
function BookingChoice({ booking: b, onPick }: { booking: SiteKaraokeBookingDTO; onPick: () => void }) {
  const pay = bookingPayment(b);
  return (
    <button type="button" onClick={onPick} className="flex min-h-14 w-full flex-col items-start gap-1 rounded-xl border border-line px-4 py-2.5 text-left transition-colors hover:border-[var(--admin-border-field)] hover:bg-surface-2">
      <span className="flex w-full items-baseline gap-2 text-sm">
        <span className="tabular font-semibold">{bookingHours(b)}</span>
        <span className="min-w-0 flex-1 truncate font-medium">{who(b)}</span>
      </span>
      <span className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <Badge tone={pay.tone}>{pay.text}</Badge>
        <span className="tabular">{bookingCode(b.id)}</span>
      </span>
      {b.note && <span className="text-xs italic text-ink-2">{b.note}</span>}
    </button>
  );
}
