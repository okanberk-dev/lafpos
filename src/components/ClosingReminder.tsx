import { AlarmClock } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { CLOSING_SNOOZE_KEY, type ClosingSnooze, closingPhase, snoozeUntil } from '@/lib/closingReminder';
import { useLocalPref, useTick } from '@/lib/hooks';
import { isAdminArea } from '@/lib/nav';
import { confirmLeave } from '@/lib/unsavedGuard';
import { Button } from './ui/Button';

/**
 * Kapanış saati hatırlatması (sahibin isteği, 25 Kasım 2026): Yönetim › Ayarlar › Gün sonu ve Z'deki kapanış saatine
 * 30 dakika kala, gün açıkken, gün sonu yetkisi (`kasa.gun`) olanın ekranında sağ altta kart: "Gün sonu al" Kasa'da gün
 * sonu penceresini açar (/kasa?gunsonu=1), "Sonra" bu cihazda kapanışa dek (kapanış geçtiyse 15 dakika) gizler.
 * Kurallar src/lib/closingReminder.ts'te. Ayar ve gün canlı gelir (bootstrap `settings` ve `cash` konularıyla yenilenir).
 *
 * Bar ekranında (tam ekran) ve yönetimde (yapışkan Kaydet şeridi) çıkmaz; Kasa'da gün sonu penceresi zaten açıkken de
 * kart pencerenin altında kalır. Telefonda alt sekme çubuğunun, adisyonda alt eylem şeridinin üstünde durur.
 */
export function ClosingReminder() {
  const boot = useBoot();
  const can = useCan();
  const now = useTick(15_000);
  const [snooze, setSnooze] = useLocalPref<ClosingSnooze | null>(CLOSING_SNOOZE_KEY, null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const closingTime = boot.settings.closingTime ?? null;
  const day = boot.day;
  const phase = closingPhase(day, closingTime, now, snooze);
  if (!phase || !day || !closingTime || !can('kasa.gun')) return null;
  if (pathname.startsWith('/mutfak') || isAdminArea(pathname)) return null;

  const title = phase.kind === 'yaklasiyor' ? `Kapanışa ${phase.minutesLeft} dk kaldı` : 'Kapanış saati geçti';
  const line = phase.kind === 'yaklasiyor' ? `Kapanış ${closingTime} · gün sonunu almayı unutmayın` : `Kapanış ${closingTime} · gün hâlâ açık (Z ${day.zNo})`;
  const takeClose = async () => {
    if (!(await confirmLeave())) return;
    navigate('/kasa?gunsonu=1');
  };
  return (
    <section
      role="status"
      aria-live="polite"
      aria-label="Kapanış hatırlatması"
      data-closing-reminder=""
      className={[
        'fixed z-40 rounded-[var(--r-card)] border border-[var(--admin-border-strong)] bg-surface p-3.5 text-ink shadow-[var(--shadow-pop)]',
        // Telefon: alt sekme çubuğunun (ve adisyonun alt eylem şeridinin) üstünde, kenarlardan dok kadar içeride
        'inset-x-2.5 bottom-[calc(4.5rem+env(safe-area-inset-bottom))] max-md:[html:has([data-action-bar])_&]:bottom-[calc(4.5rem+var(--action-bar-h,6rem)+env(safe-area-inset-bottom))]',
        // Tablet ve bilgisayar: sağ alt köşe; adisyonun Gönder / Öde şeridi açıkken onun üstünde
        'md:inset-x-auto md:right-[var(--shell-gap)] md:bottom-[max(var(--shell-gap),env(safe-area-inset-bottom))] md:w-[min(24rem,calc(100vw-2*var(--shell-gap)))] md:[html:has([data-action-bar])_&]:bottom-[calc(var(--action-bar-h,6rem)+var(--shell-gap))]',
      ].join(' ')}
    >
      <div className="flex items-start gap-3">
        <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[var(--r-tile)] bg-[var(--admin-warning-soft)] text-[var(--admin-warning)]">
          <AlarmClock className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold leading-5">{title}</p>
          <p className="mt-0.5 text-pretty text-[13px] leading-5 text-muted">{line}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={() => setSnooze({ dayId: day.id, until: snoozeUntil(phase, Date.now()) })}>
          Sonra
        </Button>
        <Button variant="primary" onClick={() => void takeClose()}>
          Gün sonu al
        </Button>
      </div>
    </section>
  );
}
