/**
 * Demo veritabanının tarayıcıdaki kaydı (IndexedDB). Bağlantı açık tutulur: sayfa kapanırken (`pagehide`) yazma
 * beklemeden başlar. Özel pencere ya da kapalı site verisinde açılamazsa demo yalnız bellekte çalışır; hiçbir yerde
 * hata vermez.
 */
const NAME = 'asilpos-demo';
const STORE = 'veri';
const KEY = 'veritabani';

let connection: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  connection ??= new Promise<IDBDatabase>((ok, fail) => {
    const req = indexedDB.open(NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => {
      const db = req.result;
      // Başka sekme veritabanını silerse (açılamadı → sıfırla) bağlantı bırakılır
      db.onversionchange = () => {
        db.close();
        connection = null;
      };
      ok(db);
    };
    req.onerror = () => fail(req.error);
    req.onblocked = () => fail(new Error('IndexedDB meşgul'));
  }).catch((e) => {
    connection = null;
    throw e;
  });
  return connection;
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise<T>((ok, fail) => {
    const tr = db.transaction(STORE, mode);
    const req = fn(tr.objectStore(STORE));
    tr.oncomplete = () => ok(req.result);
    tr.onerror = () => fail(tr.error);
    tr.onabort = () => fail(tr.error);
  });
}

export async function loadSaved(): Promise<Uint8Array | null> {
  try {
    const value = await run('readonly', (s) => s.get(KEY));
    return value instanceof Uint8Array ? value : null;
  } catch {
    return null;
  }
}

/** Kaydeder; kaydedilemezse false (demo bellekte sürer) */
export async function save(bytes: Uint8Array): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(bytes, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function clearSaved(): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(KEY));
  } catch {
    /* kayıt yoksa silinecek bir şey de yok */
  }
}
