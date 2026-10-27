import { PLATFORM_COLOR, PLATFORM_LABEL, type PlatformId } from '@shared/platforms';
import { cn } from '@/lib/cn';

/** Paket platformu rozeti: platformun rengi, adı ve kuryenin söylediği kısa kod */
export function PlatformBadge({ platform, code, className }: { platform: PlatformId; code?: string | null; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-semibold text-white', className)} style={{ background: PLATFORM_COLOR[platform] }}>
      {PLATFORM_LABEL[platform]}
      {code && <span className="tabular font-mono">{code}</span>}
    </span>
  );
}
