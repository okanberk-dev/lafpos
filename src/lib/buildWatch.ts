import { useEffect } from 'react';
import { get } from './api';
import { useLive } from './live';
import { toast } from './toast';

/**
 * Güncellemeden sonra kaldığı yerden devam (sahibin isteği, 22 Kas 2026): kasa yeni sürümü kurup yeniden açılınca açık
 * ekranlar bunu canlı bağlantı geri geldiğinde sunucunun derleme numarasından anlar ve sayfayı kendiliğinden yeniler.
 * Yenilemede hiçbir şey kaybolmaz: açık masalar ve adisyonlar veritabanında, gönderilmemiş sepet (`asilpos.cart`) ve
 * oturum cihazda saklı, açık ekran adreste. Açık bir pencere (ödeme, onay) varsa kapanana dek beklenir
 */
const MARK = 'asilpos.guncellendi';
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

/** Uzaktan'da (Vercel) yayımlanan sürüm: index.html'in ana betiği; dosya adı derlemenin özetini taşır */
const mainScript = (html: string) => /<script[^>]+type="module"[^>]+src="([^"]+)"/.exec(html)?.[1] ?? null;
const REMOTE_POLL_MS = 5 * 60_000;
let remoteReloading = false;

/** Sayfanın yüklendiği ana betik ile sitedeki son index.html'inki farklıysa (yeni yayın) sayfa yenilenir */
async function checkRemote() {
  if (remoteReloading || document.visibilityState !== 'visible') return;
  const own = [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => new URL(s.src, location.href).pathname);
  if (!own.length) return;
  const res = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
  if (!res.ok) return;
  const latest = mainScript(await res.text());
  if (!latest || own.includes(new URL(latest, location.href).pathname)) return;
  remoteReloading = true;
  const reload = () => {
    if (modalOpen()) {
      setTimeout(reload, 2000);
      return;
    }
    try {
      sessionStorage.setItem(MARK, '1');
    } catch {
      /* depolama yoksa yine yenile */
    }
    window.location.reload();
  };
  reload();
}

/**
 * AsilPOS Uzaktan (sahibin isteği, 22 Kas 2026: "ben girince direk yenilensin"): ekrana dönüldüğünde (sekme, uygulama
 * öne gelince) ve açıkken 5 dakikada bir sitedeki son yayına bakılır; yeniyse sayfa kendiliğinden yenilenir. Yalnız
 * statik index.html okunur (Redis ve işlev çağrısı yok); açık pencere (onay, düzenleme) kapanana dek beklenir
 */
export function useRemoteBuildWatch(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => void checkRemote().catch(() => undefined);
    const onVisible = () => {
      if (document.visibilityState === 'visible') run();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', run);
    const t = setInterval(run, REMOTE_POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', run);
      clearInterval(t);
    };
  }, [enabled]);
}
