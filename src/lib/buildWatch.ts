import { useEffect } from 'react';
import { get } from './api';
import { useLive } from './live';
import { toast } from './toast';

/**
 * Güncellemeden sonra kaldığı yerden devam (sahibin isteği, 22 Kas 2026): kasa yeni sürümü kurup yeniden açılınca açık
 * ekranlar bunu canlı bağlantı geri geldiğinde sunucunun derleme numarasından anlar ve sayfayı kendiliğinden yeniler.
 * Yenilemede hiçbir şey kaybolmaz: açık masalar ve adisyonlar veritabanında, gönderilmemiş sepet (`lafpos.cart`) ve
 * oturum cihazda saklı, açık ekran adreste. Açık bir pencere (ödeme, onay) varsa kapanana dek beklenir
 */
const MARK = 'lafpos.guncellendi';
/** İlk görülen derleme (git ile çalışan geliştirme sunucusunda null); `undefined`: henüz sorulmadı */
let seen: number | null | undefined;
let reloading = false;

/** Güncelleme penceresi dışındaki açık pencere: içinde iş yarımken sayfa yenilenmez */
const modalOpen = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((d) => !d.querySelector('[data-guncelleme]'));

/** Sunucunun derlemesini sorar; ilk yanıt "bu sürüm" olarak saklanır, sonra değişirse sayfa yenilenir */
async function checkBuild() {
  if (reloading) return;
  const h = await get<{ build?: number | null }>('/health');
  const build = typeof h.build === 'number' ? h.build : null;
  if (seen === undefined) {
    seen = build;
    return;
  }
  if (build == null || build === seen || reloading) return;
  reloading = true;
  const reload = () => {
    // Açık pencere (ödeme, onay) kapanana dek beklenir
    if (modalOpen()) {
      setTimeout(reload, 2000);
      return;
    }
    try {
      sessionStorage.setItem(MARK, String(build));
    } catch {
      /* depolama yoksa yine yenile */
    }
    window.location.reload();
  };
  reload();
}

export function useBuildWatch(enabled: boolean) {
  const live = useLive((s) => s.status);
  useEffect(() => {
    try {
      if (!sessionStorage.getItem(MARK)) return;
      sessionStorage.removeItem(MARK);
      toast.ok('Yeni sürüm kuruldu. Kaldığınız yerden devam edebilirsiniz');
    } catch {
      /* depolama yoksa bildirim de yok */
    }
  }, []);
  // Canlı bağlantı her kurulduğunda (açılışta ve kasa yeniden açılınca) derleme sorulur
  useEffect(() => {
    if (enabled && live === 'canli') void checkBuild().catch(() => undefined);
  }, [enabled, live]);
}
