import { AlarmClock } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useCan } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
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
 * Kabuğun akışında durur, ekranın üstüne binmez (gözden geçirme, 25 Kasım 2026): ekran sütununun dibinde, ana alanın
 * altında. Telefonda alt sekme çubuğunun hemen üstünde tam genişlik; tablet ve bilgisayarda sağ alt köşede. Kart varken
 * ana alan onun kadar kısalır: listenin son satırı, Kasa'nın "Gün sonu (Z)"si ve adisyonun Toplam'ı ile Gönder / Öde'si
 * hiç örtülmez. Boyu html'de `--closing-card-h`: telefonda geçici bildirim kartın üstünde çıkar (lib/toast.tsx).
 * Bar ekranında (tam ekran) ve yönetimde (yapışkan Kaydet şeridi) çıkmaz. Alçak ekranda (yatay telefon, en çok 34 rem: kabuğun alçak ekran eşiği)
 * tek satır. Adisyonda da durur: hesap yaprağı en az 12 rem, yer yetmezse kayar (toplamlar Gönder / Öde'nin üstüne
 * binmez; CartPanel, OrderPage `right`).
 */
export function ClosingReminder({ dock = true }: { /** Telefonda alt sekme çubuğu var mı (yoksa ev çubuğu payını kart bırakır) */ dock?: boolean }) {
  const boot = useBoot();
  const can = useCan();
  const now = useTick(15_000);
  const [snooze, setSnooze] = useLocalPref<ClosingSnooze | null>(CLOSING_SNOOZE_KEY, null);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const ref = useRef<HTMLElement>(null);
  const closingTime = boot.settings.closingTime ?? null;
  const day = boot.day;
  const phase = closingPhase(day, closingTime, now, snooze);
  const shown =
    !!phase && !!day && !!closingTime && can('kasa.gun') && !pathname.startsWith('/mutfak') && !isAdminArea(pathname);

  // Kartın boyu (üst payıyla) html'de: telefonda geçici bildirim kartın üstünde durur. Kart kalkınca silinir
  useEffect(() => {
    const el = ref.current;
    if (!shown || !el) return;
    const root = document.documentElement;
    const write = () => root.style.setProperty('--closing-card-h', `${Math.ceil(el.getBoundingClientRect().height + parseFloat(getComputedStyle(el).marginTop || '0'))}px`);
    write();
    const ro = new ResizeObserver(write);
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--closing-card-h');
    };
  }, [shown]);

  if (!shown || !phase || !day || !closingTime) return null;
  const title = phase.kind === 'yaklasiyor' ? `Kapanışa ${phase.minutesLeft} dk kaldı` : 'Kapanış saati geçti';
  const line = phase.kind === 'yaklasiyor' ? `Kapanış ${closingTime} · gün sonunu almayı unutmayın` : `Kapanış ${closingTime} · gün hâlâ açık (Z ${day.zNo})`;
  const takeClose = async () => {
    if (!(await confirmLeave())) return;
    // Kasa'dayken aynı adres geçmişe ikinci kez yazılmaz (geri tuşu boşa basılmış gibi olmasın)
    navigate('/kasa?gunsonu=1', { replace: pathname === '/kasa' });
  };
  return (
    <section
      ref={ref}
      role="status"
      aria-live="polite"
      aria-label="Kapanış hatırlatması"
      data-closing-reminder=""
      className={cn(
        'flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2.5 rounded-[var(--r-card)] border border-[var(--admin-border-strong)] bg-surface p-3 text-ink shadow-[var(--shadow-control)]',
        // Telefon: alt sekme çubuğunun üstünde, dok kadar içeride; tablet ve bilgisayar: sütunun sağ alt köşesi
        'mx-2.5 mt-1.5 md:mx-0 md:mt-0 md:ml-auto md:w-[min(34rem,100%)]',
        !dock && 'max-md:mb-[max(0.5rem,env(safe-area-inset-bottom))]',
        // Alçak ekran (yatay telefon): tek satır, ikinci satır ve iç pay küçülür
        '[@media(max-height:34rem)]:gap-y-1 [@media(max-height:34rem)]:py-1.5',
      )}
    >
      <span
        aria-hidden="true"
        className="grid size-10 shrink-0 place-items-center rounded-[var(--r-tile)] bg-[var(--admin-warning-soft)] text-[var(--admin-warning)] [@media(max-height:34rem)]:size-8"
      >
        <AlarmClock className="size-5" />
      </span>
      <div className="min-w-0 flex-1 basis-40">
        <p className="text-[15px] font-semibold leading-5">{title}</p>
        <p className="mt-0.5 text-pretty text-[13px] leading-5 text-muted [@media(max-height:34rem)]:hidden">{line}</p>
      </div>
      <div className="ml-auto flex shrink-0 gap-2">
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
