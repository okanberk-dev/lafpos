import { animate, AnimatePresence, motion, type Transition, useMotionValue, useReducedMotion, useTransform } from 'motion/react';
import { type ComponentProps, memo, type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/cn';
import { mod, toCells } from './rollingDigits';

/**
 * Kayan rakamlı sayaç (rare-ui animated-counter'dan, ladmin'deki uyarlamanın kurallarıyla): değer değişince her basamak
 * kendi çarkında yeni rakama döner; artışta yukarı, azalışta aşağı. LafPOS uyarlaması:
 * - Yazıyı ekranın kendi biçimleyicisi verir (`format`: `tl`, `tlShort`, sayı): sayaç biçim yazmaz, basamakları döndürür.
 *   Ekranda ve ekran okuyucuda bugünkü yazının aynısı (tests/kayan-sayac.test.ts).
 * - İlk boyamada çark dönmez (açılışta rakam hemen yerinde); hareket azaltma tercihinde hiç dönmez, rakam doğrudan
 *   değişir (e2e de hareket azaltmada çeker).
 * - Ekran okuyucu yalnız son değeri okur; dönen çark `aria-hidden`.
 * - Satırı büyütmez, üstündeki başlığa taşmaz: çarkın penceresi ve her yüzü yazının kendi satır yüksekliğinde; kenarlar
 *   yalnız dönerken söner (maske). Dururken pencerede yalnız rakamın kendisi durur (çark yalnız dönerken çizilir).
 * Yalnız ekranda değişen özet rakamlarda (patron paneli, raporların özet kartları); satış ve kasa akışında kullanılmaz.
 */

const FACES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
// Sondaki 0, 9'dan 0'a dönüşü aynı yüze indirir
const WHEEL = [...FACES, 0];
// Dönerken pencerenin üst ve alt kenarı söner (yalnız dönerken; duran rakama maske yok). Doğrusal geçiş sert kenar gibi
// görünür, yumuşatılmış eğri
const FADE = `linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.5) 7%, rgba(0,0,0,0.94) 12%, #000 16%, #000 84%, rgba(0,0,0,0.94) 88%, rgba(0,0,0,0.5) 93%, rgba(0,0,0,0) 100%)`;
// DESIGN.md §2 Hareket: durum geçişi 280 ms civarı, `--ease-out` ailesi; yay kısa ve az sekmeli
const EASE = [0.16, 1, 0.3, 1] as const;
const BOUNCE = 0.16;
const PACE = 0.55;
const LEAVE = { duration: 0.18, ease: EASE } as const;
const INSTANT = { duration: 0 } as const;

const spring = (duration: number): Transition => ({ type: 'spring', visualDuration: duration, bounce: BOUNCE });

// Bir kez kurulur: React her dönüşte basamak başına 11 span'i yeniden karşılaştırmaz. Her yüz tek satır: yüksekliği
// yazının satır yüksekliği, pencereyle aynı
const STACK = WHEEL.map((face, index) => (
  <span key={index} className="flex items-center justify-center">
    {face}
  </span>
));

/**
 * Basamağın çarkı. Yalnız dönerken çark (0-9) çizilir; dururken pencerede tek rakam kalır: sayfanın metni ve e2e'nin
 * "kırpılan düğme" taraması gizli çark rakamlarını görmez, sayfada aramada "0123456789" çıkmaz
 */
function useWheel(from: number, digit: number, dir: number, calm: boolean) {
  const pos = useMotionValue(from);
  const goal = useRef(from);
  const [rolling, setRolling] = useState(false);
  const [settled, setSettled] = useState(from);
  // Bağımlılık değil okunur: yalnız yön değişimi bütün sütunları yeniden başlatmasın
  const heading = useRef(dir);
  useEffect(() => {
    heading.current = dir;
  }, [dir]);

  useEffect(() => {
    if (calm) {
      goal.current = digit;
      pos.set(digit);
      setRolling(false);
      setSettled(digit);
      return;
    }
    // Yalnız yüz değişince hedefle; yoksa yön değişimi çarkı uzun yoldan döndürür. Çarkın şu anki yerinden: hızla
    // değişen değer tur biriktirmesin
    if (mod(goal.current, 10) !== digit) {
      const at = pos.get();
      goal.current = heading.current < 0 ? at - mod(at - digit, 10) : at + mod(digit - at, 10);
    }
    if (pos.get() === goal.current) {
      setRolling(false);
      setSettled(digit);
      return;
    }
    setRolling(true);
    const roll = animate(pos, goal.current, {
      ...spring(PACE),
      onComplete: () => {
        setRolling(false);
        setSettled(digit);
      },
    });
    return () => roll.stop();
  }, [digit, calm, pos]);

  const y = useTransform(pos, (p) => `${(-mod(p, 10) * 100) / WHEEL.length}%`);
  // Yeni rakam geldi ama efekt henüz başlamadı: o karede de çark (eski yüzde) çizilir, yeni rakam bir an görünüp kaybolmaz
  return { y, moving: !calm && (rolling || settled !== digit) };
}

interface Slot {
  calm: boolean;
  dep: number;
  shift: Transition;
  className?: string;
}

const shifts = ({ calm, dep, shift }: Slot) => ({ layout: !calm, layoutDependency: dep, transition: shift });
const fades = (calm: boolean) => ({ initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0, transition: calm ? INSTANT : LEAVE } });

function Mark({ char, ref, ...slot }: Slot & { char: string; ref?: Ref<HTMLSpanElement> }) {
  return (
    <motion.span ref={ref} {...shifts(slot)} {...fades(slot.calm)} className={cn('inline-block whitespace-pre', slot.className)}>
      {char}
    </motion.span>
  );
}

const Digit = memo(function Digit({ digit, from, dir, ref, ...slot }: Slot & { digit: number; from: number; dir: number; ref?: Ref<HTMLSpanElement> }) {
  const { y, moving } = useWheel(from, digit, dir, slot.calm);
  return (
    <motion.span
      ref={ref}
      {...shifts(slot)}
      {...fades(slot.calm)}
      className={cn('relative inline-grid', moving && 'overflow-hidden', slot.className)}
      style={moving ? { maskImage: FADE, WebkitMaskImage: FADE } : undefined}
    >
      {/* Duran rakam pencerenin enini ve boyunu verir (tabular rakamlar eşit enli, boy bir satır); dönerken yerini çark alır */}
      <span className={cn('flex items-center justify-center', moving && 'invisible')}>{digit}</span>
      {moving && (
        <motion.span style={{ y }} className="absolute inset-x-0 top-0">
          {STACK}
        </motion.span>
      )}
    </motion.span>
  );
});

export type AnimatedCounterProps = Omit<ComponentProps<'span'>, 'children' | 'onAnimationStart' | 'onDrag' | 'onDragStart' | 'onDragEnd'> & {
  value: number;
  /** Ekranın biçimleyicisi: `tl`, `tlShort` ya da ekranın sayı yazısı (raporların `fmtN`'i) */
  format: (value: number) => string;
  /** Kuruş (virgül ve sonrası) için sınıf: dev rakamda soluk kuruş */
  fractionClassName?: string;
  /** Ekran okuyucunun okuyacağı ek (ör. "Bugünkü ciro"); yoksa yalnız değer */
  srPrefix?: ReactNode;
};

export function AnimatedCounter({ value, format, fractionClassName, srPrefix, className, ...props }: AnimatedCounterProps) {
  const calm = useReducedMotion() ?? false;
  const text = format(value);
  const cells = toCells(text);

  const [previous, setPrevious] = useState(value);
  const [dir, setDir] = useState(1);
  if (previous !== value && Number.isFinite(value)) {
    setDir(value >= previous ? 1 : -1);
    setPrevious(value);
  }
  // İlk boyamadaki yüzler; sonradan eklenen basamak 0'dan dönerek gelir
  const [seed] = useState(() => Object.fromEntries(cells.flatMap((c) => (c.kind === 'digit' ? [[c.key, c.digit] as const] : []))) as Record<string, number>);
  const shift = useMemo<Transition>(() => (calm ? INSTANT : spring(PACE)), [calm]);

  return (
    <span data-slot="animated-counter" className={cn('inline-flex items-center tabular-nums', className)} {...props}>
      <span className="sr-only">
        {srPrefix}
        {srPrefix ? ' ' : ''}
        {text}
      </span>
      <span aria-hidden="true" className="inline-flex select-none items-center">
        <AnimatePresence mode="popLayout" initial={false}>
          {cells.map((c) => {
            const slot: Slot = { calm, dep: text.length, shift, className: c.frac ? fractionClassName : undefined };
            return c.kind === 'digit' ? <Digit key={c.key} {...slot} digit={c.digit} from={seed[c.key] ?? 0} dir={dir} /> : <Mark key={c.key} {...slot} char={c.char} />;
          })}
        </AnimatePresence>
      </span>
    </span>
  );
}
