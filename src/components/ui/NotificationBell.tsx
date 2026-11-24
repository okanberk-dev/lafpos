import {
  animate,
  type AnimationPlaybackControls,
  motion,
  type MotionValue,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform,
  useVelocity,
} from 'motion/react';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/cn';
import { AnimatedCounter } from './AnimatedCounter';
import { BELL_BADGE, BELL_CIRCLE, BELL_FILL, BELL_MAX, BELL_RING, type BellTone, badgeText, bellCount, bellLabel, shouldRing } from './bell';

/**
 * Sallanan zil ve kayan rakamlı rozet (rare-ui notification-bell'den). LafPOS uyarlaması:
 * - Gelen işin şeritlerinde (platform siparişi, sitenin uyarıları) başlangıçtaki dairenin yerine; şeridin kendisi düğme,
 *   davranışı, sesi ve yazısı aynı. Zil yalnız görünümü ve hareketi değiştirir.
 * - Sayı artınca (yeni sipariş, masa çağrısı) ve şerit ilk belirdiğinde bir kez sallanır, dil (tokmak) gecikerek izler;
 *   azalınca sallanmaz. Hareket azaltmada hiç sallanmaz, rozetin rakamı dönmeden değişir.
 * - Rozetin rakamı patron panelinin kayan sayacıyla döner (AnimatedCounter); 99'dan çoğu "99+".
 * - Renkler Keel belirteçlerinden (ahududu, mor; rozet mürekkep); rare-ui'nin iOS renkleri ve logosu yok.
 * - Ad: tek başına "Bildirimler, N okunmamış"; şeritte `label={false}` (şeridin yazısı zaten söyler, iki kez okunmaz).
 * Hareket kütüphanesi yalnız bu parçada: InboxBell tembel yükler, satış ekranının ana paketine girmez.
 */

// Az sönümlü yay: bir süre sallanır (rare-ui'nin değerleri; Keel'in kısa hareketine göre biraz daha sıkı)
const SWING = { type: 'spring', stiffness: 240, damping: 11, mass: 1, restDelta: 0.01 } as const;
const CLAPPER_SPRING = { stiffness: 300, damping: 14, mass: 1 };
const ENTER = { type: 'spring', stiffness: 600, damping: 22 } as const;
const INSTANT = { duration: 0 } as const;
// Derece / saniye
const IMPULSE = 480;
const MAX_VELOCITY = 860;
const BURST = 5;
const CLAPPER_SWEEP = 13;
const CLAPPER_VELOCITY = 450;

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));

function useBellRing(total: number, calm: boolean) {
  const swing = useMotionValue(0);
  const swingVelocity = useVelocity(swing);
  // Tokmak zilin hızını izler, kendiliğinden geride kalır
  const clapperLag = useTransform(swingVelocity, [-CLAPPER_VELOCITY, 0, CLAPPER_VELOCITY], [CLAPPER_SWEEP, 0, -CLAPPER_SWEEP], { clamp: true });
  const clapper = useSpring(clapperLag, CLAPPER_SPRING);
  const previous = useRef<number | null>(null);
  const ringing = useRef<AnimationPlaybackControls | null>(null);

  useEffect(() => {
    const before = previous.current;
    previous.current = total;
    if (!shouldRing(before, total, calm)) return;
    const delta = before === null ? 1 : total - before;
    const weight = 0.7 + (0.6 * Math.min(delta, BURST)) / BURST;
    const moving = swing.getVelocity();
    // Zaten sallanıyorsa aynı yöne iter: daha güçlü sallanır
    const along = moving > 1 ? 1 : -1;
    ringing.current?.stop();
    ringing.current = animate(swing, 0, { ...SWING, velocity: clamp(moving + along * IMPULSE * weight, MAX_VELOCITY) });
  }, [total, calm, swing]);

  useEffect(() => () => ringing.current?.stop(), []);
  return { swing, clapper };
}

function BellGlyph({ swing, clapper }: { swing: MotionValue<number>; clapper: MotionValue<number> }) {
  return (
    // Zil tepesinden asılı: ortadan dönmesi yanlış görünür
    <motion.svg viewBox="0 0 18 18" fill="currentColor" aria-hidden="true" className="size-[18px]" style={{ rotate: swing, transformOrigin: '50% 12%' }}>
      <path d="M3.5 6.5C3.5 3.46 5.96 1 9 1s5.5 2.46 5.5 5.5v4.25c0 .69.56 1.25 1.25 1.25a.75.75 0 0 1 0 1.5H2.25a.75.75 0 0 1 0-1.5c.69 0 1.25-.56 1.25-1.25V6.5Z" />
      <motion.path
        style={{ rotate: clapper, transformBox: 'fill-box', transformOrigin: '50% 0%' }}
        d="M10.2 15H7.8a.5.5 0 0 0-.49.6c.17.83.87 1.4 1.69 1.4s1.52-.57 1.69-1.4a.5.5 0 0 0-.49-.6Z"
      />
    </motion.svg>
  );
}

export interface NotificationBellProps {
  count: number;
  tone: BellTone;
  /** Ekran okuyucu adı; `false`: süs (şeridin yazısı söyler). Varsayılan "Bildirimler, N okunmamış" */
  label?: string | false;
  className?: string;
}

export default function NotificationBell({ count, tone, label, className }: NotificationBellProps) {
  const calm = useReducedMotion() ?? false;
  const total = bellCount(count);
  const { swing, clapper } = useBellRing(total, calm);
  const name = label === false ? undefined : (label ?? bellLabel(total));
  const text = badgeText(total);

  return (
    <span
      data-slot="notification-bell"
      role={name ? 'img' : undefined}
      aria-label={name}
      aria-hidden={name ? undefined : true}
      className={cn(BELL_CIRCLE, BELL_FILL[tone], className)}
    >
      <BellGlyph swing={swing} clapper={clapper} />
      {text && (
        <motion.span
          aria-hidden="true"
          className={cn(BELL_BADGE, BELL_RING[tone])}
          initial={calm ? false : { scale: 0, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={calm ? INSTANT : ENTER}
        >
          {/* Rakam patron panelinin sayacıyla döner (artışta yukarı); sınırın üstünde "99+" */}
          <AnimatedCounter value={Math.min(total, BELL_MAX + 1)} format={() => text} className="leading-4" />
        </motion.span>
      )}
    </span>
  );
}
