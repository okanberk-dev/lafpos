import { useEffect } from 'react';
import { useAuth } from './auth';
import { onLive } from './live';
import { beep } from './sound';
import { toast } from './toast';

/** Bar "Hazır"a basınca siparişi alan kişinin ekranında uyarı, ses ve titreşim ("Bahçe 4 · 2 ürün hazır") */
export function useReadyAlerts() {
  const meId = useAuth((s) => s.me?.id);
  useEffect(() => {
    if (!meId) return;
    return onLive((e) => {
      if (e.kind !== 'items.ready' || e.forUserId !== meId || e.byUserId === meId || !e.message) return;
      toast.ok(e.message);
      beep('tamam');
      if (navigator.vibrate) navigator.vibrate([60, 40, 60]);
    });
  }, [meId]);
}
