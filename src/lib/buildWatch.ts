import { useEffect } from 'react';
import { eskiSayfaKarari, yeniAnaBetik } from '@shared/ana-betik';
import { get, getToken } from './api';
import { useLive } from './live';
import { toast } from './toast';

/**
 * Güncellemeden sonra kaldığı yerden devam (sahibin isteği, 22 Kas 2026): kasa yeni sürümü kurup yeniden açılınca açık
 * ekranlar bunu canlı bağlantı geri geldiğinde sunucunun derleme numarasından anlar ve sayfayı kendiliğinden yeniler.
 * Yenilemede hiçbir şey kaybolmaz: açık masalar ve adisyonlar veritabanında, gönderilmemiş sepet (`asilpos.cart`) ve
 * oturum cihazda saklı, açık ekran adreste. Açık bir pencere (ödeme, onay) varsa kapanana dek beklenir.
 *
 * Eski sayfa (27 Kas 2026: otomatik güncellemeden sonra sahip kasayı ilk açtığında eski sürüm, ör. eski yeşil kenar
 * çubuğu görünüyor, elle yenileyince düzeliyordu). İki yol vardı: (1) tarayıcı index.html'i sunucuya sormadan
 * önbellekten açıyordu (asıl önlem sunucuda: server/app.ts `arayuzOnbellegi`); (2) sayfa güncellemeden hemen önce eski
 * sunucudan açılmıştı (kasa sabah açılır, güncelleme 2 dk sonra kurulur) ve giriş ekranındayken sunucu yenilendi: ilk
 * derleme sorusu girişten sonra yeni sunucuya gidiyor, eski sayfa yeni derlemeyi "bu sürüm" sanıp hiç yenilenmiyordu.
 * Artık sayfa kendi ana betiğini sunucunun index.html'iyle karşılaştırır: açılışta, giriş ekranında dakikada bir, ekrana
 * dönünce ve canlı bağlantı her kurulduğunda. Farklıysa bir kez yenilenir (döngüsüz)
 */
const MARK = 'asilpos.guncellendi';
/**
 * Eski bulunup yenilenen sayfanın hedef betiği: yenilemeden sonra da sayfa eskiyse (ara bir önbellek eski index.html'i
 * vermeyi sürdürüyorsa) ikinci kez yenilenmez, döngüye girmez
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

/**
 * Sayfayı yeniler: açık pencere (ödeme, onay) kapanana dek beklenir. `mark` verilirse yenilenen sayfa "Yeni sürüm
 * kuruldu" der (oturum açıkken; giriş ekranında ve müşteri ekranında söylenmez)
 */
function reloadWhenFree(mark: string | null) {
  const reload = () => {
    if (modalOpen()) {
      setTimeout(reload, 2000);
      return;
    }
    if (mark != null) oturumYaz(MARK, mark);
    window.location.reload();
  };
  reload();
}

/** Sayfanın yüklediği modül betiklerinin yolları */
const ownScripts = () => [...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]')].map((s) => new URL(s.src, location.href).pathname);

/**
 * Sunucunun şu an verdiği arayüz bu sayfadan yeni mi: index.html önbelleğe bakılmadan istenir; ana betiği sayfanın
 * betiklerinde yoksa onun yolu (sayfa eski), varsa ya da anlaşılamazsa null. Sunucuya ulaşılamazsa hata atar
 */
async function newerScript(): Promise<string | null> {
  const own = ownScripts();
  if (!own.length) return null;
  const res = await fetch('/', { cache: 'no-store', headers: { accept: 'text/html' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return yeniAnaBetik(own, await res.text(), location.href);
}

/**
 * Sayfa eski derlemedense bir kez yeniler (`eskiSayfaKarari`: aynı hedefe ikinci kez yenilemez). Sunucuya ulaşılamazsa
 * bir şey yapmaz (iz de silinmez)
 */
async function eskiSayfayiYenile(mark: string | null): Promise<void> {
  if (reloading) return;
  let yeni: string | null;
  try {
    yeni = await newerScript();
  } catch {
    return;
  }
  const karar = eskiSayfaKarari(yeni, oturumOku(ESKI_SAYFA));
  if (karar === 'guncel') oturumYaz(ESKI_SAYFA, null);
  if (karar !== 'yenile' || reloading) return;
  oturumYaz(ESKI_SAYFA, yeni);
  reloading = true;
  reloadWhenFree(mark);
}

/**
 * Sunucunun derlemesini sorar (canlı bağlantı her kurulduğunda): ilk yanıt "bu sürüm" olarak saklanır, sonra değişirse
 * sayfa yenilenir. Değişmediyse sayfanın kendisi denetlenir: ilk yanıt güncellemeden sonraki sunucudan geldiyse eski
 * sayfa onu "bu sürüm" sanardı
 */
async function checkBuild() {
  if (reloading) return;
  const h = await get<{ build?: number | null }>('/health');
  const build = typeof h.build === 'number' ? h.build : null;
  if (seen === undefined) seen = build;
  else if (build != null && build !== seen && !reloading) {
    reloading = true;
    reloadWhenFree(String(build));
    return;
  }
  await eskiSayfayiYenile(String(build ?? 1));
}

/** Giriş ekranında, müşteri ekranında ve bağlantı kopukken sayfanın denetlenme aralığı (yerel sunucunun index.html'i) */
export const ESKI_SAYFA_YOKLAMA_MS = 60_000;

/**
 * Kasa (yerel sunucu): sayfa açılır açılmaz, oturum açılmadan da eski derlemeden mi diye bakılır; canlı bağlantı yokken
 * (giriş ekranı, müşteri ekranı, çağrı ekranı, kopukluk) dakikada bir ve ekrana dönünce (sekme öne gelince, geri
 * gelişte saklı sayfa açılınca) yeniden. Bağlantı canlıyken denetim `checkBuild`'de (bağlantı her kurulduğunda).
 * Kasa sabah açılınca sayfa eski sunucudan gelir, güncelleme birkaç dakika sonra kurulur: giriş ekranı kendiliğinden
 * yeni sürüme geçer. Cihazda oturum varsa yenilenen sayfa "Yeni sürüm kuruldu" der
 */
export function useStalePageWatch(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;
    const run = () => {
      if (document.visibilityState === 'visible') void eskiSayfayiYenile(getToken() ? '1' : null);
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) run();
    };
    run();
    const t = setInterval(() => {
      if (useLive.getState().status !== 'canli') run();
    }, ESKI_SAYFA_YOKLAMA_MS);
    document.addEventListener('visibilitychange', run);
    window.addEventListener('pageshow', onShow);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', run);
      window.removeEventListener('pageshow', onShow);
    };
  }, [enabled]);
}

export function useBuildWatch(enabled: boolean) {
  const live = useLive((s) => s.status);
  useEffect(() => {
    // Sayfa yenilenmek üzereyken (açılış denetimi eski buldu, yenileme başladı) işaret yeni sayfanındır
    if (reloading) return;
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
  if (!(await newerScript().catch(() => null))) return;
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
