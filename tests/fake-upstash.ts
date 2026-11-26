/**
 * Upstash Redis REST'in bellekteki karşılığı: api/uzaktan.ts'in özet, sürüm, rapor, üyelik ve platform gelen kutusu için,
 * api/_merkez.ts ve api/_kontrol.ts'in Merkez ve uzaktan yönetim için kullandığı komutlar. İstek gövdesi tek komut dizisidir
 * (`["GET","k"]`); yanıt `{ result }`. Hash'ler JSON nesne, liste ve kümeler JSON dizi olarak aynı Map'te durur:
 * `store.clear()` hepsini siler, kopyası hepsini taşır. Süreler (EX, EXPIRE) uygulanmaz. `log` verilirse her komut
 * sırasıyla yazılır (komut sayısı ve Redis'ten okunan bayt: tests/uzaktan-kota.test.ts)
 */
export interface UpstashCall {
  cmd: string;
  key: string;
  /** Yanıtın bayt sayısı (JSON) */
  bytes: number;
}

const hashOf = (store: Map<string, string>, key: string): Record<string, string> => {
  try {
    return JSON.parse(store.get(key) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
};

const listOf = (store: Map<string, string>, key: string): string[] => {
  try {
    const v = JSON.parse(store.get(key) ?? '[]') as unknown;
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
};

/** Boş liste ya da küme anahtarı Redis'teki gibi silinir */
const putList = (store: Map<string, string>, key: string, list: string[]) => (list.length ? store.set(key, JSON.stringify(list)) : store.delete(key));

/** LRANGE ve LTRIM aralığı: eksi sıra sondan sayılır, uçlar listeye kırpılır */
const range = (len: number, start: unknown, stop: unknown): [number, number] => {
  const at = (v: unknown) => (Number(v) < 0 ? len + Number(v) : Number(v));
  return [Math.max(0, at(start)), Math.min(len - 1, at(stop))];
};

export function upstashCommand(store: Map<string, string>, [cmd, key = '', ...rest]: string[], log?: UpstashCall[]): unknown {
  let result: unknown = null;
  const name = String(cmd).toUpperCase();
  if (name === 'GET') result = store.get(key) ?? null;
  else if (name === 'MGET') result = [key, ...rest].map((k) => store.get(k) ?? null);
  else if (name === 'SET') {
    if ((rest.includes('NX') && store.has(key)) || (rest.includes('XX') && !store.has(key))) result = null;
    else (store.set(key, rest[0]!), (result = 'OK'));
  } else if (name === 'DEL') result = [key, ...rest].filter((k) => store.delete(k)).length;
  else if (name === 'INCR') (store.set(key, String(Number(store.get(key) ?? 0) + 1)), (result = Number(store.get(key))));
  else if (name === 'EXPIRE') result = store.has(key) ? 1 : 0;
  else if (name === 'EXISTS') result = [key, ...rest].filter((k) => store.has(k)).length;
  else if (name === 'HGET') result = hashOf(store, key)[rest[0]!] ?? null;
  else if (name === 'HMGET') {
    const h = hashOf(store, key);
    result = rest.map((f) => h[f] ?? null);
  } else if (name === 'HGETALL') result = Object.entries(hashOf(store, key)).flat();
  else if (name === 'HVALS') result = Object.values(hashOf(store, key));
  else if (name === 'HLEN') result = Object.keys(hashOf(store, key)).length;
  else if (name === 'HSET') {
    const h = hashOf(store, key);
    let added = 0;
    for (let i = 0; i + 1 < rest.length; i += 2) {
      if (!(rest[i]! in h)) added++;
      h[rest[i]!] = rest[i + 1]!;
    }
    store.set(key, JSON.stringify(h));
    result = added;
  } else if (name === 'HDEL') {
    const h = hashOf(store, key);
    result = rest.filter((f) => f in h && delete h[f]).length;
    if (Object.keys(h).length) store.set(key, JSON.stringify(h));
    else store.delete(key);
  } else if (name === 'LPUSH') {
    // Her değer başa: son verilen en önde
    const list = [...[...rest].reverse().map(String), ...listOf(store, key)];
    putList(store, key, list);
    result = list.length;
  } else if (name === 'RPUSH') {
    const list = [...listOf(store, key), ...rest.map(String)];
    putList(store, key, list);
    result = list.length;
  } else if (name === 'LLEN') result = listOf(store, key).length;
  else if (name === 'LREM') {
    // LREM anahtar sayı değer: sayı > 0 baştan, < 0 sondan o kadar, 0 hepsi
    const list = listOf(store, key);
    const count = Number(rest[0]);
    const value = String(rest[1]);
    const order = count < 0 ? [...list.keys()].reverse() : [...list.keys()];
    const drop = new Set(order.filter((i) => list[i] === value).slice(0, count === 0 ? undefined : Math.abs(count)));
    putList(store, key, list.filter((_, i) => !drop.has(i)));
    result = drop.size;
  } else if (name === 'LRANGE') {
    const list = listOf(store, key);
    const [a, b] = range(list.length, rest[0], rest[1]);
    result = list.slice(a, b + 1);
  } else if (name === 'LTRIM') {
    const list = listOf(store, key);
    const [a, b] = range(list.length, rest[0], rest[1]);
    putList(store, key, list.slice(a, b + 1));
    result = 'OK';
  } else if (name === 'SADD') {
    const set = new Set(listOf(store, key));
    const before = set.size;
    for (const v of rest) set.add(String(v));
    putList(store, key, [...set]);
    result = set.size - before;
  } else if (name === 'SREM') {
    const set = new Set(listOf(store, key));
    result = rest.filter((v) => set.delete(String(v))).length;
    putList(store, key, [...set]);
  } else if (name === 'SMEMBERS') result = listOf(store, key);
  else if (name === 'SCARD') result = listOf(store, key).length;
  else throw new Error(`sahte Upstash: ${name} yok`);
  log?.push({ cmd: name, key, bytes: JSON.stringify(result).length });
  return result;
}

/** `fetch` yerine: Upstash adresine giden isteği bellekte yanıtlar */
export function upstashFetch(store: Map<string, string>, log?: UpstashCall[]) {
  return (init?: RequestInit) => new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[], log) }), { status: 200 });
}
