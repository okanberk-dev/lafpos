import { Bell } from 'lucide-react';
import { lazy, Suspense } from 'react';
import { cn } from '@/lib/cn';
import { BELL_BADGE, BELL_CIRCLE, BELL_FILL, BELL_RING, type BellTone, badgeText } from './bell';
import type { NotificationBellProps } from './NotificationBell';

// Hareket kütüphanesi (motion) yalnız şerit belirince iner: satış ekranının ana paketine girmez
const NotificationBell = lazy(() => import('./NotificationBell'));

/** Parça inene kadar (ilk kez, birkaç ms) aynı daire ve rozet, hareketsiz: şerit kıpırdamaz */
function StillBell({ count, tone, className }: { count: number; tone: BellTone; className?: string }) {
  const text = badgeText(count);
  return (
    <span aria-hidden="true" className={cn(BELL_CIRCLE, BELL_FILL[tone], className)}>
      <Bell className="size-4 stroke-[2.25]" />
      {text && <span className={cn(BELL_BADGE, BELL_RING[tone], 'tabular-nums')}>{text}</span>}
    </span>
  );
}

/** Gelen işin şeritlerindeki zil (PlatformInbox, SiteInbox): şeridin yazısı adı verir, zil süs */
export function InboxBell(props: Omit<NotificationBellProps, 'label'>) {
  return (
    <Suspense fallback={<StillBell {...props} />}>
      <NotificationBell {...props} label={false} />
    </Suspense>
  );
}
