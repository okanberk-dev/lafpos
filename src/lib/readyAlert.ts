import { useEffect } from 'react';
import { readyAlertFor } from '@shared/events';
import { useAuth } from './auth';
import { onLive } from './live';
import { beep } from './sound';
import { toast } from './toast';

/**
 * Bar "Hazır"a basınca siparişi alan kişinin ekranında uyarı, ses ve titreşim ("Bahçe 4 · 2 ürün hazır"); paket
 * platformu siparişinde paket yetkili her cihazda ("Yemeksepeti A7KX · 2 ürün hazır"; `readyAlertFor`)
 */
export function useReadyAlerts() {
  const me = useAuth((s) => s.me);
  useEffect(() => {
    if (!me) return;
    return onLive((e) => {
      if (!e.message || !readyAlertFor(e, me)) return;
      toast.ok(e.message);
      beep('tamam');
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    });
  }, [me]);
}
