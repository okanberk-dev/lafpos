import { useEffect } from 'react';
import { anaBetik } from '@shared/ana-betik';
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
/**
 * Açılışta eski bulunup yenilenen sayfanın hedef betiği: yenilemeden sonra da sayfa eskiyse (ara bir önbellek eski
 * index.html'i vermeyi sürdürüyorsa) ikinci kez yenilenmez, döngüye girmez
 */
const ESKI_SAYFA = 'asilpos.eski-sayfa';
/** İlk görülen derleme (git ile çalışan geliştirme sunucusunda null); `undefined`: henüz sorulmadı */
let seen: number | null | undefined;
let reloading = false;

/** Güncelleme penceresi dışındaki açık pencere: içinde iş yarımken sayfa yenilenmez */
const modalOpen = () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((d) => !d.querySelector('[data-guncelleme]'));

const oturumOku = (k: string) => {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
};
const oturumYaz = (k: string, v: string | null) => {
  try {
    if (v == null) sessionStorage.removeItem(k);
    else sessionStorage.setItem(k, v);
  } catch {
    /* depolama yoksa yazılmaz */
  }
};

/** Sayfayı yeniler: açık pencere (ödeme, onay) kapanana dek beklenir; yenilenen sayfa "Yeni sürüm kuruldu" der */
function reloadWhenFree(mark: string) {
  const reload = () => {
    if (modalOpen()) {
      setTimeout(reload, 2000);
      return;
    }
    oturumYaz(MARK, mark);
    window.location.reload();
  };
  reload();
}

/** Sayfanın yüklediği modül betiklerinin yolları */
const ownScripts = () => [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => new URL(s.src, location.href).pathname);

/**
 * Sunucunun şu an verdiği arayüz bu sayfadan yeni mi: index.html önbelleğe bakılmadan istenir, ana betiği sayfanın
 * betiklerinde yoksa onun yolu (sayfa eski), varsa ya da anlaşılamazsa null
 */
async function newerScript(): Promise<string | null> {
  const own = ownScripts();
  if (!own.length) return null;
  const res = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
  if (!res.ok) return null;
  const latest = anaBetik(await res.text());
  if (!latest) return null;
  const path = new URL(latest, location.href).pathname;
  return own.includes(path) ? null : path;
}

/**
 * Sunucunun derlemesini sorar; ilk yanıt "bu sürüm" olarak saklanır, sonra değişirse sayfa yenilenir. İlk bakışta sayfanın
 * kendisi de denetlenir (27 Kas 2026: güncellemeden sonra kasa ilk açılışta tarayıcı önbelleğindeki eski sürümle
 * açılıyordu; eski sayfa sunucunun yeni derlemesini "bu sürüm" sanıp hiç yenilenmiyordu): sunucunun verdiği index.html'in
 * ana betiği sayfanınkinden farklıysa sayfa bir kez yenilenir. Asıl önlem sunucuda (server/app.ts arayuzOnbellegi:
 * index.html önbellekten açılmaz); bu, ara bir önbellek ya da tarayıcının oturum geri yüklemesi için
 */
async function checkBuild() {
  if (reloading) return;
  const h = await get<{ build?: number | null }>('/health');
  const build = typeof h.build === 'number' ? h.build : null;
  if (seen === undefined) {
    seen = build;
    const yeni = await newerScript().catch(() => null);
    if (!yeni) {
      oturumYaz(ESKI_SAYFA, null);
      return;
    }
    if (reloading || oturumOku(ESKI_SAYFA) === yeni) return;
    oturumYaz(ESKI_SAYFA, yeni);
    reloading = true;
    reloadWhenFree(String(build ?? 1));
    return;
  }
  if (build == null || build === seen || reloading) return;
  reloading = true;
  reloadWhenFree(String(build));
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

const REMOTE_POLL_MS = 5 * 60_000;
let remoteReloading = false;

/** Sayfanın yüklendiği ana betik ile sitedeki son index.html'inki farklıysa (yeni yayın) sayfa yenilenir */
async function checkRemote() {
  if (remoteReloading || document.visibilityState !== 'visible') return;
  if (!(await newerScript())) return;
  remoteReloading = true;
  reloadWhenFree('1');
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
