import { useQueryClient } from '@tanstack/react-query';
import { Clock3 } from 'lucide-react';
import { useState } from 'react';
import { fmtDateTime, fmtTime, shiftForgotten } from '@shared/time';
import { errorMessage, post } from '@/lib/api';
import { useTick } from '@/lib/hooks';
import { fmtDuration, useMyTime } from '@/lib/mesai';
import { toast } from '@/lib/toast';
import { Button } from './ui/Button';

/**
 * Kullanıcı menüsündeki mesai satırı: içerideyse süre ve "Mesaiyi bitir", değilse bugünün toplamı ve "Mesaiyi
 * başlat". Kilit ekranındaki Mesai sekmesiyle aynı kayıt (PIN'siz, açık oturumdan).
 */
export function MesaiRow({ className }: { className?: string }) {
  const qc = useQueryClient();
  const me = useMyTime();
  const now = useTick(30_000);
  const [busy, setBusy] = useState(false);
  if (me.isPending || me.isError || !me.data) return null;
  const { open, today, weekMs } = me.data;
  // Önceki günden açık kalan mesai şimdiye kapatılmaz (sunucu da reddeder): "Mesaiyi bitir" yerine ne yapılacağı
  if (open && shiftForgotten(open.clockIn, now)) {
    return (
      <div className={className}>
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-[var(--admin-warning-soft)] text-[var(--admin-warning)] [&>svg]:size-[18px]">
          <Clock3 />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">Önceki günden açık mesai</span>
          <span className="block text-xs text-muted">Giriş {fmtDateTime(open.clockIn)} · çıkışını bir yetkili girer</span>
        </span>
      </div>
    );
  }
  // Sunucunun saatiyle çizilen toplam, istemcinin saatine göre ilerler (açık mesai şu ana kadar)
  const drift = open ? Math.max(0, now - me.data.serverTime) : 0;
  const punch = async () => {
    setBusy(true);
    try {
      await post(open ? '/time/clock-out' : '/time/clock-in');
      await qc.invalidateQueries({ queryKey: ['time'] });
      toast.ok(open ? `Mesai bitti · bugün ${fmtDuration(today.workedMs + drift)}` : 'Mesai başladı');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={className}>
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-surface-3 text-ink-2 [&>svg]:size-[18px]">
        <Clock3 />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{open ? `Mesaide · ${fmtDuration(now - open.clockIn)}` : 'Mesai başlamadı'}</span>
        <span className="block text-xs text-muted">
          {open ? `Giriş ${fmtTime(open.clockIn)} · bugün ${fmtDuration(today.workedMs + drift)}` : `Bugün ${fmtDuration(today.workedMs)} · son 7 gün ${fmtDuration(weekMs)}`}
        </span>
      </span>
      <Button size="sm" variant={open ? 'secondary' : 'primary'} loading={busy} onClick={punch}>
        {open ? 'Mesaiyi bitir' : 'Mesaiyi başlat'}
      </Button>
    </div>
  );
}
