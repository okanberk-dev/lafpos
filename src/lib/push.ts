import { get, post } from './api';

/**
 * Patrona telefon bildirimi (LafPOS Uzaktan, Web Push; api/_bildirim.ts). Bu tarayıcının aboneliği: servis çalışanı
 * (`/sw.js`) kaydedilir, sitenin açık anahtarıyla abone olunur, abonelik gerçek oturumla siteye yazılır. iPhone'da
 * bildirim yalnız ana ekrana eklenmiş sitede çalışır (iOS 16.4+)
 */
export type PushState = 'desteklenmiyor' | 'ana-ekran' | 'kapali' | 'acik' | 'engelli';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const iOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) ?? navigator.serviceWorker.register('/sw.js', { scope: '/' });
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return iOS() && !standalone() ? 'ana-ekran' : 'desteklenmiyor';
  if (Notification.permission === 'denied') return 'engelli';
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  return sub ? 'acik' : 'kapali';
}

/** Bu telefonda bildirimleri açar: izin, abonelik, siteye kayıt */
export async function enablePush(): Promise<void> {
  const { ready, publicKey } = await get<{ ready: boolean; publicKey: string | null }>('/uzaktan/bildirim/anahtar');
  if (!ready || !publicKey) throw new Error('Bildirimler sitede henüz kurulmadı');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Bildirim izni verilmedi; tarayıcı ayarlarından açılabilir');
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  try {
    await post('/uzaktan/bildirim/abone', { abonelik: sub.toJSON() });
  } catch (e) {
    // Site aboneliği yazamadı (geçici hata, oturum düştü): tarayıcıdaki abonelik de bırakılır, yoksa kart "Açık" der ama
    // hiçbir bildirim gelmez. Yeniden "Bu telefonda aç" denebilir
    await sub.unsubscribe().catch(() => undefined);
    throw e;
  }
}

export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await post('/uzaktan/bildirim/birak', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}
