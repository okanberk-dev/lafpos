import { useEffect, useRef } from 'react';
import { useHref, useNavigate } from 'react-router';
import { confirmDialog } from '@/components/ui/Confirm';

/**
 * Kaydedilmemiş değişiklik koruması (Ayarlar): sekme kapanırken ve yenilenirken tarayıcı sorar (beforeunload);
 * uygulama içi geçişte (kenar çubuğu, alt sekme, sayfa bağlantısı, komut paleti) "Sayfada kal / Kaydetmeden çık"
 * sorulur. Uygulama BrowserRouter'da (veri yönlendiricisi değil, useBlocker yok): bağlantı tıklaması yakalanır,
 * programla geçen yerler (komut paleti, Kilitle) `confirmLeave()` sorar, geri hareketi koruyucu bir geçmiş kaydıyla
 * yakalanır. Otomatik kilit sormaz (kimse başında değil).
 */
let active: (() => boolean) | null = null;

/** Programla gezinmeden önce (komut paleti): değişiklik yoksa hemen true, varsa kullanıcıya sorar */
export async function confirmLeave(): Promise<boolean> {
  if (!active?.()) return true;
  return confirmDialog({
    title: 'Kaydedilmemiş değişiklikler var',
    body: 'Sayfadan çıkarsanız değişiklikler kaybolur',
    confirmLabel: 'Kaydetmeden çık',
    cancelLabel: 'Sayfada kal',
  });
}

export function useUnsavedGuard(dirty: boolean) {
  const navigate = useNavigate();
  // Yönlendiricinin öneki (demoda /demo): bağlantının tam yolundan atılıp navigate'e verilir
  const base = useHref('/').replace(/\/$/, '');
  const latest = useRef(dirty);
  useEffect(() => {
    latest.current = dirty;
  });
  useEffect(() => {
    const check = () => latest.current;
    active = check;
    return () => {
      if (active === check) active = null;
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    // Bağlantı tıklaması yakalanır (yakalama evresinde, yönlendiricinin işleyicisinden önce)
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]');
      if (!(a instanceof HTMLAnchorElement) || (a.target && a.target !== '_self') || a.hasAttribute('download')) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      e.preventDefault();
      e.stopPropagation();
      void confirmLeave().then((ok) => {
        if (!ok) return;
        latest.current = false;
        const path = base && url.pathname.startsWith(base) ? url.pathname.slice(base.length) || '/' : url.pathname;
        navigate(path + url.search + url.hash);
      });
    };
    // Tarayıcının ya da sistemin geri hareketi (Android geri, Alt+←): değişiklik varken aynı adrese bir koruyucu kayıt
    // eklenir; geri bu kaydı düşürür, sayfa yerinde kalır ve sorulur. "Kaydetmeden çık" asıl geriyi yapar, "Sayfada
    // kal" koruyucuyu yeniden ekler. Koruyucu, yönlendiricinin durumunu (anahtar, sıra) taşır: geçiş ona görünmez
    const armed = window.location.href;
    const arm = () => {
      if ((window.history.state as { lafposGuard?: boolean } | null)?.lafposGuard) return;
      window.history.pushState({ ...(window.history.state as object | null), lafposGuard: true }, '', armed);
    };
    arm();
    let leaving = false;
    const onPop = () => {
      if (leaving || !latest.current || window.location.href !== armed) return;
      if ((window.history.state as { lafposGuard?: boolean } | null)?.lafposGuard) return;
      void confirmLeave().then((ok) => {
        if (!ok) return arm();
        leaving = true;
        latest.current = false;
        window.history.back();
      });
    };
    window.addEventListener('beforeunload', warn);
    window.addEventListener('popstate', onPop);
    document.addEventListener('click', onClick, true);
    return () => {
      window.removeEventListener('beforeunload', warn);
      window.removeEventListener('popstate', onPop);
      document.removeEventListener('click', onClick, true);
    };
  }, [dirty, navigate, base]);
}
