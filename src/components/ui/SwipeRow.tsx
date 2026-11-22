import { Trash2 } from 'lucide-react';
import { type PointerEvent, type ReactNode, useRef, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Kaydırarak silme (sahibin isteği, 22 Kas 2026): satır sola çekilince altından kırmızı "Sil" çıkar; yeterince
 * çekilip bırakılınca satır silinir, az çekilince yerine döner. Dokunmatik, kalem ve fareyle çalışır; dikey kaydırma
 * serbest (`touch-action: pan-y`). Tek yol bu değildir: satırdaki adet düğmesi de siler (klavye ve ekran okuyucu).
 * Kaydırmanın ardından gelen tıklama yutulur (satır yanlışlıkla düzenlemeye açılmaz)
 */
export function SwipeRow({ onRemove, children, className, rowClassName }: { onRemove: () => void; children: ReactNode; className?: string; rowClassName?: string }) {
  const [dx, setDx] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; y: number; id: number; active: boolean; width: number } | null>(null);
  const swiped = useRef(false);

  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    start.current = { x: e.clientX, y: e.clientY, id: e.pointerId, active: false, width: e.currentTarget.offsetWidth };
    swiped.current = false;
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s || s.id !== e.pointerId) return;
    const mx = e.clientX - s.x;
    const my = e.clientY - s.y;
    if (!s.active) {
      // Yatay niyet belli olana dek dokunuş ve dikey kaydırma olağan çalışır
      if (mx > -12 || Math.abs(mx) < Math.abs(my) * 1.5) return;
      s.active = true;
      swiped.current = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    setDx(Math.min(0, mx));
  };
  const onEnd = () => {
    const s = start.current;
    start.current = null;
    if (!s?.active) return;
    setDragging(false);
    if (dx < -Math.min(140, s.width * 0.4)) {
      setDx(-s.width);
      window.setTimeout(onRemove, 150);
    } else setDx(0);
  };

  return (
    <li className={cn('relative overflow-hidden', className)}>
      <div aria-hidden="true" className="absolute inset-y-0 right-0 flex items-center justify-end gap-1.5 bg-[var(--admin-danger-soft)] pr-4 text-sm font-medium text-[var(--admin-danger-ink)]" style={{ width: Math.max(0, -dx), opacity: dx < 0 ? 1 : 0 }}>
        <Trash2 className="size-4 shrink-0" />
        <span className="whitespace-nowrap">Sil</span>
      </div>
      <div
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onEnd}
        onPointerCancel={onEnd}
        onClickCapture={(e) => {
          if (!swiped.current) return;
          swiped.current = false;
          e.preventDefault();
          e.stopPropagation();
        }}
        className={cn('relative bg-surface select-none', rowClassName)}
        style={{ transform: dx ? `translateX(${dx}px)` : undefined, transition: dragging ? 'none' : 'transform 160ms var(--ease-out)', touchAction: 'pan-y' }}
      >
        {children}
      </div>
    </li>
  );
}
