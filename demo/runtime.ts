import { desc } from 'drizzle-orm';
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import type { DemoServer } from '@shared/demo';
import { businessDate } from '@shared/time';
import { DEMO_USERS } from '../server/db/seed';
import { exportDatabase, openDatabase, setSqlJs } from './sqljs';
import { clearSaved, loadSaved, save } from './store';
import { acquireLead, follow, lead, resetAll, route } from './tabs';

/**
 * Tarayıcı demosunun çalışma zamanı: gerçek LafPOS sunucusu (Hono, aynı uçlar ve iş kuralları) sayfanın içinde
 * çalışır. Arayüzün `/api/*` istekleri ağa çıkmadan `app.fetch`'e gider; canlı olaylar da aynı yoldan (SSE).
 * Veritabanı sql.js (bellekte SQLite); her yazmadan sonra IndexedDB'ye kaydedilir. Dış sistemlere (laffogato,
 * lafmaliyet, LafPOS Uzaktan) istek gitmez. Birden çok sekmede sunucuyu biri çalıştırır (demo/tabs.ts).
 */
/**
 * Demonun ilk gününün sürümü (demo/scenario.ts). İlk gün değişince (ör. self servise geçiş) kayıtlı demo yeni ilk
 * günle açılır: eski kayıt eski kurguyu (masalı gün) göstermeye devam etmesin
 */
const DEMO_DAY_VERSION = 2;
const VERSION_KEY = 'demo.ilk-gun-surumu';

let persistent = true;
let resetting = false;
let saving: Promise<void> | null = null;
let dirty = false;
/** Yanıtı beklenen istek sayısı: onların yazması isteğin kendi kaydına girer */
let inRequest = 0;

/**
 * Veritabanını kaydeder. Yazan istek yanıtını kayıt bittikten sonra alır: onaylanan ödeme sekme hemen kapansa da
 * kaybolmaz. Kayıt sürerken gelen yazmalar bir sonraki turda birlikte kaydedilir.
 */
function persist(): Promise<void> {
  dirty = true;
  saving ??= (async () => {
    try {
      while (dirty && !resetting) {
        dirty = false;
        persistent = await save(exportDatabase());
      }
    } finally {
      saving = null;
    }
  })();
  return saving;
}

function aborted(): DOMException {
  return new DOMException('İstek iptal edildi', 'AbortError');
}

/**
 * Yanıt gövdesini isteğin iptal sinyaline bağlar (gerçek `fetch` gibi): canlı akış kapatılınca sunucu tarafındaki
 * döngü de biter.
 */
function bindAbort(res: Response, signal: AbortSignal | null | undefined): Response {
  if (!res.body || !signal) return res;
  const reader = res.body.getReader();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    async pull(c) {
      try {
        const { done, value } = await reader.read();
        if (done) c.close();
        else c.enqueue(value);
      } catch (e) {
        c.error(e);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  signal.addEventListener(
    'abort',
    () => {
      void reader.cancel(aborted()).catch(() => null);
      try {
        controller.error(aborted());
      } catch {
        /* akış zaten kapandı */
      }
    },
    { once: true },
  );
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}

/** Sunucuyu bu sekmede açar: kayıtlı veritabanı (yoksa kurulum ve örnek gün), sonra istekleri karşılar */
async function startServer() {
  setSqlJs(await initSqlJs({ locateFile: () => wasmUrl }));
  const saved = await loadSaved();
  openDatabase(saved ?? undefined);

  // Sunucu modülleri veritabanı açıldıktan sonra yüklenir
  const [{ db, runMigrations, schema }, { seedIfEmpty }, { createApp }, { bus }, { seedDemoDay }] = await Promise.all([
    import('../server/db/client'),
    import('../server/db/seed'),
    import('../server/app'),
    import('../server/lib/events'),
    import('./scenario'),
  ]);
  runMigrations();
  // Kayıt önceki bir iş gününden kaldıysa demo yeni günle açılır: dünden açık gün yeni satışı durdururdu
  // (stale_day), kapanmış günün ertesinde de kasa boş açılırdı
  const { getSyncState, setSyncState, upgradeRoleSets, upgradeStoredSettings } = await import('../server/lib/settings');
  const last = saved && db.select({ date: schema.businessDays.date }).from(schema.businessDays).orderBy(desc(schema.businessDays.date)).limit(1).get();
  if ((last && last.date < businessDate(Date.now())) || (saved && getSyncState<number>(VERSION_KEY) !== DEMO_DAY_VERSION)) {
    openDatabase();
    runMigrations();
  }
  const fresh = seedIfEmpty({ demo: true });
  upgradeRoleSets();
  upgradeStoredSettings();
  (await import('../server/sync/option-profile')).upgradeOptionProfiles();
  const app = createApp();
  if (fresh) {
    await seedDemoDay((req) => app.fetch(req));
    setSyncState(VERSION_KEY, DEMO_DAY_VERSION);
  }
  // Zamanlayıcıyla yazan işler de (yazarkasa simülatörü gibi) olay yayar: onlar da kaydedilir. Dışa aktarma hiçbir
  // zaman olayın içinde yapılmaz (sql.js bağlantıyı kapatıp açar); istek sürüyorsa onun kaydı alır
  bus.on('event', () => {
    if (inRequest) dirty = true;
    else setTimeout(() => void persist(), 0);
  });
  window.addEventListener('pagehide', () => void persist());
  if (fresh) await persist();

  lead(
    async (req) => {
      if (resetting) throw new TypeError('Demo sıfırlanıyor');
      if (req.signal?.aborted) throw aborted();
      inRequest++;
      let res: Response;
      try {
        res = await app.fetch(req);
      } finally {
        inRequest--;
      }
      if (req.method !== 'GET' || dirty) await persist();
      return bindAbort(res, req.signal);
    },
    async () => {
      resetting = true;
      await saving;
      await clearSaved();
    },
  );
}

export async function startDemoServer(): Promise<DemoServer> {
  const nativeFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    if (url.origin === location.origin && url.pathname.startsWith('/api/')) return route(req);
    // Demo dış sistemlere bağlanmaz (laffogato, lafmaliyet): senkron bütçesi ve gizlilik
    if (url.origin !== location.origin) throw new TypeError('Demoda dış sistemlere bağlanılmaz');
    return nativeFetch(input, init);
  };

  const release = await acquireLead(false);
  if (release) {
    try {
      await startServer();
    } catch (e) {
      release();
      throw e;
    }
  } else {
    // Sunucu başka sekmede: istekler ona gider; o sekme kapanınca sıra bu sekmeye gelebilir. Burada açılamazsa
    // (ör. yeni sürüm yayınlandı, eski parçalar yok) kilit bırakılır, sıradaki sekme dener
    follow();
    void acquireLead(true).then(async (won) => {
      if (!won) return;
      try {
        await startServer();
      } catch (e) {
        won();
        console.error('[demo] sunucu bu sekmede açılamadı', e);
      }
    });
  }

  return {
    users: DEMO_USERS.map((u) => ({ role: u.role, name: u.name, color: u.color, pin: u.pin })),
    get persistent() {
      return persistent;
    },
    reset: resetAll,
  };
}
