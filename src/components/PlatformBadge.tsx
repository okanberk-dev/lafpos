import { PLATFORM_COLOR, PLATFORM_LABEL, type PlatformId } from '@shared/platforms';
import { cn } from '@/lib/cn';

/**
 * Paket platformu rozeti: kitin nötr hapı (Badge ölçüsü: 22 px, 12 px yazı), platformun rengi yalnız noktada; yanında
 * adı ve kuryenin söylediği kısa kod. Dolu marka rengi durum renkleriyle karışıyordu (Getir'in moru online siparişin
 * moruyla, Yemeksepeti'nin kırmızısı iptalle, Trendyol'un turuncusu zamanın amberiyle)
 */
export function PlatformBadge({ platform, code, className }: { platform: PlatformId; code?: string | null; className?: string }) {
  return (
    <span className={cn('inline-flex min-h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full bg-[var(--admin-neutral-soft)] px-2.5 py-0.5 text-xs font-medium leading-4 text-ink', className)}>
      <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ background: PLATFORM_COLOR[platform] }} />
      {PLATFORM_LABEL[platform]}
      {code && <span className="tabular font-semibold tracking-[0.04em]">{code}</span>}
    </span>
  );
}
