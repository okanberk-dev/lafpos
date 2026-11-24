/**
 * Zilin (NotificationBell.tsx, InboxBell.tsx) saf kuralları: rozet yazısı, ekran okuyucu adı, çalma kararı ve renkler.
 * React ve tarayıcı içermez; testler (tests/zil-bildirim-sifre.test.ts) doğrudan bunu okur.
 */

/** Rozetin üst sınırı: 99'dan çoğu "99+" (rozet dar kalır, şeridin yazısı zaten tam sayıyı söyler) */
export const BELL_MAX = 99;

/** Rozet yazısı: 0 ve geçersiz sayıda boş, sınırın üstünde "99+" */
export function badgeText(count: number, max = BELL_MAX): string {
  const n = bellCount(count);
  if (n <= 0) return '';
  return n > max ? `${max}+` : String(n);
}

/** Geçersiz ya da kesirli sayı zili çaldırmasın: tam ve sıfırdan küçük olmayan */
export const bellCount = (count: number) => (Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0);

/** Zil tek başına (şeridin yazısı olmadan) kullanılınca ekran okuyucunun okuyacağı ad */
export const bellLabel = (count: number) => {
  const n = bellCount(count);
  return n > 0 ? `Bildirimler, ${n} okunmamış` : 'Bildirimler';
};

/**
 * Zil sallanır mı: sayı artınca (yeni sipariş, yeni çağrı). Şerit bekleyen iş gelince belirdiği için ilk çizimde de
 * (önceki yok) sayı varsa sallanır; azalınca ("Gördüm", kabul) sallanmaz. Hareket azaltmada hiç
 */
export const shouldRing = (previous: number | null, next: number, calm: boolean) => !calm && next > 0 && (previous === null || next > previous);

/** Şeridin rengi: platform siparişi zamanı daralan (ahududu), sitenin uyarısı online sipariş (mor) */
export type BellTone = 'signal' | 'violet';

export const BELL_FILL: Record<BellTone, string> = {
  signal: 'bg-[var(--admin-signal)]',
  violet: 'bg-[var(--admin-hue-violet)]',
};

/** Rozet şeridin zemin rengiyle çevrili: daireden kesilmiş gibi durur */
export const BELL_RING: Record<BellTone, string> = {
  signal: 'ring-[var(--admin-signal-soft)]',
  violet: 'ring-[var(--admin-hue-violet-soft)]',
};

/** Daire 32 px (şeridin 44 px satırında), zil 18 px; rozet sağ üstte, 16 px boy, 11 px rakam (en küçük yazı ölçeği) */
export const BELL_CIRCLE = 'relative grid size-8 shrink-0 place-items-center rounded-full text-[var(--admin-surface)]';
export const BELL_BADGE =
  'pointer-events-none absolute -right-1.5 -top-1 z-10 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--admin-text)] px-1 text-[11px] font-semibold leading-4 text-[var(--admin-surface)] ring-2';
