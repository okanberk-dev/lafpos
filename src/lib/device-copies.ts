import type { LiveEvent } from '@shared/events';

/**
 * Bu sekmenin yazarkasaya gönderdiği adisyonlar: cihaz ödeyince (okc.paid) işyeri nüshası bu sekmede basılır, ödeme
 * penceresi kapanmış, adisyon ekranından çıkılmış ya da başka adisyona geçilmiş olsa da. Kayıt kısa sürelidir (10 dk)
 * ve sekmenin oturumunda durur (kiosk Chrome yeniden çizilse de kaybolmaz); depolama yoksa bellekte
 */
const KEY = 'lafpos.okcSent';
const TTL = 10 * 60_000;
let memory: Record<string, number> = {};

function read(): Record<string, number> {
  try {
    const raw = sessionStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return memory;
  }
}

function write(m: Record<string, number>) {
  memory = m;
  try {
    sessionStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    // Depolama yok: bellekteki kayıt yeter
  }
}

/** Sepet bu sekmeden cihaza gitti */
export function markDeviceSent(orderId: string, now = Date.now()) {
  const m = read();
  for (const [id, at] of Object.entries(m)) if (now - at > TTL) delete m[id];
  m[orderId] = now;
  write(m);
}

/** Gönderim başarısız ya da sepet iptal edildi: nüsha beklenmez */
export function unmarkDeviceSent(orderId: string) {
  const m = read();
  if (!(orderId in m)) return;
  delete m[orderId];
  write(m);
}

/** Bu sekme bu adisyonu cihaza göndermiş miydi (bir kez doğru döner, kayıt silinir) */
export function takeDeviceSent(orderId: string, now = Date.now()): boolean {
  const m = read();
  const at = m[orderId];
  if (at == null) return false;
  delete m[orderId];
  write(m);
  return now - at <= TTL;
}

/**
 * Uygulama düzeyindeki tek dinleyici (AppShell): okc.paid bu sekmenin gönderdiği adisyona aitse nüsha bir kez basılır;
 * cihazda iptal edilen sepetin kaydı düşer
 */
export function deviceCopyListener(print: (orderId: string) => void) {
  return (e: Pick<LiveEvent, 'topic' | 'kind' | 'orderId'>) => {
    if (e.topic !== 'okc' || !e.orderId) return;
    if (e.kind === 'okc.cancelled') unmarkDeviceSent(e.orderId);
    else if (e.kind === 'okc.paid' && takeDeviceSent(e.orderId)) print(e.orderId);
  };
}

/** Testler için: kayıtları sıfırlar */
export function resetDeviceSent() {
  write({});
}
