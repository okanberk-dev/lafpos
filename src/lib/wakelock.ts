import { useEffect } from 'react';

/**
 * Ekranın kararmasını engeller (Screen Wake Lock): kasa bilgisayarı, bar ekranı ve tabletler gün boyu açık
 * kalsın. Sekme gizlenince tarayıcı kilidi bırakır, görünür olunca yeniden istenir. Desteklemeyen tarayıcıda
 * ya da izin verilmezse sessizce geçer (ekran bilgisayarın güç ayarına kalır, docs/05-KASA-BILGISAYARI.md).
 */
export function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let stopped = false;
    const request = async () => {
      try {
        lock = await navigator.wakeLock.request('screen');
      } catch {
        /* izin yok, pil tasarrufu ya da sekme gizli */
      }
    };
    const onVisible = () => {
      if (!stopped && document.visibilityState === 'visible') void request();
    };
    void request();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => null);
    };
  }, [enabled]);
}
