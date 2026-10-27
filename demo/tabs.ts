/**
 * Aynı tarayıcıda birden çok demo sekmesi (kasadan açılan müşteri ekranı ve çağrı ekranı, ikinci sekme): sunucuyu
 * yalnız biri çalıştırır (lider, Web Locks kilidi onda). Diğerleri `/api` isteklerini BroadcastChannel ile ona
 * iletir; yanıt gövdesi parça parça döner, canlı akış (SSE) da. Lider kapanınca bekleyen sekmelerden biri kilidi
 * alıp lider olur; yarım kalan istekler bağlantı hatası verir, arayüz yeniden dener (canlı akış kendiliğinden).
 */
type Headers = [string, string][];
type Msg =
  | { type: 'hello' }
  | { type: 'ready'; leader: string; since: number }
  | { type: 'req'; id: string; from: string; method: string; url: string; headers: Headers; body: ArrayBuffer | null }
  | { type: 'res'; id: string; to: string; status: number; statusText: string; headers: Headers }
  | { type: 'chunk'; id: string; to: string; data: Uint8Array }
  | { type: 'end'; id: string; to: string }
  | { type: 'err'; id: string; to: string; message: string }
  | { type: 'abort'; id: string }
  | { type: 'reset' }
  | { type: 'reload' };

const LOCK = 'lafpos-demo-sunucu';
const NULL_BODY = new Set([101, 204, 205, 304]);

const me = crypto.randomUUID();
const channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('lafpos-demo');
const post = (m: Msg) => channel?.postMessage(m);

interface Pending {
  resolve: (r: Response) => void;
  reject: (e: unknown) => void;
  stream: ReadableStreamDefaultController<Uint8Array> | null;
  sentAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/** Lider sekme yanıt başlığını bu sürede göndermezse istek bağlantı hatası verir (arayüz yeniden dener) */
const ANSWER_TIMEOUT_MS = 15_000;
const pending = new Map<string, Pending>();
const serving = new Map<string, AbortController>();

let leader: string | null = null;
let leadingSince = 0;
let serveLocal: ((req: Request) => Promise<Response>) | null = null;
let onReset: (() => Promise<void>) | null = null;
let readyWaiters: (() => void)[] = [];

/** Yanıtsız kalan iletilmiş istekler bağlantı hatası verir; `before` verilirse yalnız o andan önce gönderilenler */
function lost(message = 'Demo sunucusu sekmesi kapandı; yeniden bağlanılıyor', before = Infinity) {
  for (const [id, p] of pending) {
    if (p.sentAt >= before) continue;
    if (p.timer) clearTimeout(p.timer);
    const err = new TypeError(message);
    if (p.stream) {
      try {
        p.stream.error(err);
      } catch {
        /* akış zaten kapandı */
      }
    } else p.reject(err);
    pending.delete(id);
  }
}

/**
 * Kilit: alınırsa sekme kapanana dek ya da `release` çağrılana dek tutulur (sunucu açılamazsa sıra diğer sekmeye
 * geçsin). `wait` değilse boştaysa alır, doluysa hemen null.
 */
export function acquireLead(wait: boolean): Promise<(() => void) | null> {
  if (!('locks' in navigator)) return Promise.resolve(wait ? null : () => {});
  return new Promise((resolve) => {
    void navigator.locks.request(LOCK, { ifAvailable: !wait }, (lock) => {
      if (!lock) {
        resolve(null);
        return;
      }
      return new Promise<void>((release) => resolve(release));
    });
  });
}

/** Bu sekme lider: kendi isteklerini ve diğer sekmelerinkini `serve` karşılar */
export function lead(serve: (req: Request) => Promise<Response>, reset: () => Promise<void>) {
  serveLocal = serve;
  onReset = reset;
  leader = me;
  leadingSince = Date.now();
  lost();
  for (const ok of readyWaiters) ok();
  readyWaiters = [];
  post({ type: 'ready', leader: me, since: leadingSince });
}

/** Sıfırlamada lider artık istek karşılamaz; sekmeler yeniden yüklenince yeni lider seçilir */
function stopLeading() {
  serveLocal = null;
  onReset = null;
  leader = null;
}

export const isLeader = () => leader === me;

/** Diğer sekmenin liderliği bekleniyor: ilk istekten önce "hazırım" yanıtı alınır */
export function follow() {
  post({ type: 'hello' });
}

/** Kilidi tutan sekme açılırken takılırsa (hata verip açık kaldıysa) bu sekme sonsuza dek beklemez */
const READY_TIMEOUT_MS = 20_000;

function whenReady(): Promise<void> {
  if (leader) return Promise.resolve();
  return new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error('Demo başka bir sekmede açık ama yanıt vermiyor; diğer demo sekmelerini kapatıp yeniden deneyin')), READY_TIMEOUT_MS);
    readyWaiters.push(() => {
      clearTimeout(timer);
      ok();
    });
  });
}

/** İsteği sunucuya: lider bu sekmeyse doğrudan, değilse lider sekmeye iletir */
export async function route(req: Request): Promise<Response> {
  await whenReady();
  if (serveLocal) return serveLocal(req);
  const id = crypto.randomUUID();
  const body = req.method === 'GET' || req.method === 'HEAD' ? null : await req.arrayBuffer();
  if (req.signal.aborted) throw new DOMException('İstek iptal edildi', 'AbortError');
  return new Promise<Response>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new TypeError('Demo sunucusu yanıt vermedi'));
    }, ANSWER_TIMEOUT_MS);
    pending.set(id, { resolve, reject, stream: null, sentAt: Date.now(), timer });
    req.signal.addEventListener(
      'abort',
      () => {
        post({ type: 'abort', id });
        const p = pending.get(id);
        pending.delete(id);
        const err = new DOMException('İstek iptal edildi', 'AbortError');
        if (!p) return;
        if (p.timer) clearTimeout(p.timer);
        if (p.stream) {
          try {
            p.stream.error(err);
          } catch {
            /* akış zaten kapandı */
          }
        } else p.reject(err);
      },
      { once: true },
    );
    post({ type: 'req', id, from: me, method: req.method, url: req.url, headers: [...req.headers], body });
  });
}

async function answer(m: Extract<Msg, { type: 'req' }>) {
  if (!serveLocal) return;
  const to = m.from;
  const abort = new AbortController();
  serving.set(m.id, abort);
  try {
    const res = await serveLocal(new Request(m.url, { method: m.method, headers: m.headers, body: m.body, signal: abort.signal }));
    post({ type: 'res', id: m.id, to, status: res.status, statusText: res.statusText, headers: [...res.headers] });
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        post({ type: 'chunk', id: m.id, to, data: value });
      }
    }
    post({ type: 'end', id: m.id, to });
  } catch (e) {
    post({ type: 'err', id: m.id, to, message: e instanceof Error ? e.message : 'Sunucu hatası' });
  } finally {
    serving.delete(m.id);
  }
}

/** Sıfırlama bütün sekmelerde: lider veriyi siler, herkes yeniden yüklenir */
export async function resetAll(): Promise<void> {
  if (onReset && isLeader()) {
    await onReset();
    stopLeading();
    post({ type: 'reload' });
    return;
  }
  await new Promise<void>((ok) => {
    const timer = setTimeout(ok, 3000);
    channel?.addEventListener('message', (e: MessageEvent<Msg>) => {
      if (e.data.type === 'reload') {
        clearTimeout(timer);
        ok();
      }
    });
    post({ type: 'reset' });
  });
}

channel?.addEventListener('message', (e: MessageEvent<Msg>) => {
  const m = e.data;
  switch (m.type) {
    case 'hello':
      if (isLeader()) post({ type: 'ready', leader: me, since: leadingSince });
      break;
    case 'ready':
      if (m.leader !== leader) {
        // Lider değişti: yeni lider açılmadan önce gönderilenler eskisine gitti, yanıtsız kalır; sonrakileri yenisi karşılar
        lost(undefined, m.since);
        leader = m.leader;
      }
      for (const ok of readyWaiters) ok();
      readyWaiters = [];
      break;
    case 'req':
      if (isLeader()) void answer(m);
      break;
    case 'abort':
      serving.get(m.id)?.abort();
      break;
    case 'res': {
      const p = m.to === me ? pending.get(m.id) : undefined;
      if (!p) break;
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      if (NULL_BODY.has(m.status)) {
        pending.delete(m.id);
        p.resolve(new Response(null, { status: m.status, statusText: m.statusText, headers: m.headers }));
        break;
      }
      const body = new ReadableStream<Uint8Array>({
        start: (c) => {
          p.stream = c;
        },
        cancel: () => {
          pending.delete(m.id);
          post({ type: 'abort', id: m.id });
        },
      });
      p.resolve(new Response(body, { status: m.status, statusText: m.statusText, headers: m.headers }));
      break;
    }
    case 'chunk':
      if (m.to === me) pending.get(m.id)?.stream?.enqueue(m.data);
      break;
    case 'end': {
      const p = m.to === me ? pending.get(m.id) : undefined;
      pending.delete(m.id);
      p?.stream?.close();
      break;
    }
    case 'err': {
      const p = m.to === me ? pending.get(m.id) : undefined;
      if (!p) break;
      pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      const err = new TypeError(m.message);
      if (p.stream) p.stream.error(err);
      else p.reject(err);
      break;
    }
    case 'reset':
      if (isLeader() && onReset)
        void onReset().then(() => {
          stopLeading();
          post({ type: 'reload' });
          window.location.reload();
        });
      break;
    case 'reload':
      window.location.reload();
      break;
  }
});

// Kapanan sekmenin açık istekleri (canlı akış) liderde de kapansın: yoksa olaylar boşa yayılmaya devam eder
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const id of pending.keys()) post({ type: 'abort', id });
  });
}
