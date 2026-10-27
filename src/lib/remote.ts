/**
 * LafPOS Uzaktan: Vercel'deki salt okunur görünüm (vercel.json derlemede VITE_LAFPOS_UZAKTAN=1 verir). Veri kafedeki
 * sunucunun ittiği canlı özetten gelir; işlem düğmeleri gizlidir, canlı bağlantı yerine kısa aralıkla yenilenir.
 */
export const REMOTE = import.meta.env.VITE_LAFPOS_UZAKTAN === '1' && import.meta.env.MODE !== 'demo';

/** Uzakta görünen ekranlar */
export const REMOTE_PATHS = ['/patron', '/masalar', '/mutfak'];
