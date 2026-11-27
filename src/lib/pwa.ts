import { create } from 'zustand';
import { INSTALL_HINT, type InstallWay, installWay, isLoopbackHost } from './pwa-yol';

/**
 * Ana ekrana ekleme (27 Kasım 2026, sahibin isteği: AsilPOS tablette ve telefonda da program gibi). Tablet ve telefon
 * kurulum istemez: kafenin ağından adresle açılır, ana ekrana eklenince adres çubuksuz kendi penceresinde açılır
 * (`public/manifest.webmanifest`: `id`, `scope`, `display: standalone`, simgeler). Sayfalar önbelleğe alınmaz (`sw.js`
 * yalnız Uzaktan'ın bildirimi): eklenen uygulama da her açılışta sunucunun güncel sürümünü alır.
 *
 * Yol tarayıcıya göre: Chrome ve Edge "yükle" olayını verir (güvenli adreste: https ya da bu bilgisayar), kullanıcı
 * menüsündeki "Ana ekrana ekle" onu açar. iPhone ve iPad'de Safari'nin Paylaş menüsü (http'de de çalışır). Android'de
 * kafenin ağındaki http adresinde Chrome tam yükleme vermez (güvenli adres değil): menüden "Ana ekrana ekle" kısayol
 * ekler; adres çubuksuz pencere için https gerekir (docs/05-KASA-BILGISAYARI.md §5).
 *
 * Kasa bilgisayarında (sunucunun kendisi: localhost) hiç önerilmez: orada AsilPOS kurulu programdır (kasa kısayolu) ve
 * tarayıcının kendi yükleme önerisi de bastırılır, kiosk penceresinde yükleme çubuğu çıkmaz.
 */

/** Tarayıcının "yükle" olayı (Chrome, Edge; Safari ve Firefox vermez) */
interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export { INSTALL_HINT, installWay, isLoopbackHost, type InstallContext, type InstallWay } from './pwa-yol';

const usePrompt = create<{ prompt: InstallPromptEvent | null }>(() => ({ prompt: null }));

/**
 * Tarayıcının "yükle" olayını yakalar (main.tsx, ilk iş): olay sayfa açılır açılmaz gelir. Tarayıcının kendi alt çubuğu
 * gösterilmez; yükleme kullanıcı menüsünden
 */
export function listenInstallPrompt() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    if (!isLoopbackHost(window.location.hostname)) usePrompt.setState({ prompt: e as InstallPromptEvent });
  });
  window.addEventListener('appinstalled', () => usePrompt.setState({ prompt: null }));
}

function standaloneNow(): boolean {
  if (typeof window === 'undefined') return false;
  const mode = (m: string) => window.matchMedia?.(`(display-mode: ${m})`).matches ?? false;
  return mode('standalone') || mode('fullscreen') || mode('minimal-ui') || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** Kullanıcı menüsünün "Ana ekrana ekle" satırı: yol yoksa null */
export function useInstallOffer(): { way: InstallWay; hint: string; install: () => Promise<boolean> } | null {
  const prompt = usePrompt((s) => s.prompt);
  if (typeof window === 'undefined') return null;
  const way = installWay({
    standalone: standaloneNow(),
    kasaPc: isLoopbackHost(window.location.hostname),
    hasPrompt: !!prompt,
    ua: navigator.userAgent,
    touchPoints: navigator.maxTouchPoints ?? 0,
    secure: window.isSecureContext,
  });
  if (!way) return null;
  return {
    way,
    hint: INSTALL_HINT[way],
    install: async () => {
      if (way !== 'prompt' || !prompt) return false;
      await prompt.prompt();
      const choice = await prompt.userChoice.catch(() => ({ outcome: 'dismissed' as const }));
      // Olay bir kez kullanılır
      usePrompt.setState({ prompt: null });
      return choice.outcome === 'accepted';
    },
  };
}
