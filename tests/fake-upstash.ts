/**
 * Upstash Redis REST'in bellekteki karşılığı: api/uzaktan.ts'in özet, sürüm, rapor ve üyelik için kullandığı komutlar.
 * İstek gövdesi tek komut dizisidir (`["GET","k"]`); yanıt `{ result }`. Hash'ler aynı Map'te JSON nesne olarak durur:
 * `store.clear()` hepsini siler, kopyası hepsini taşır. `log` verilirse her komut sırasıyla yazılır (komut sayısı ve
 * Redis'ten okunan bayt: tests/uzaktan-kota.test.ts)
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

export function upstashCommand(store: Map<string, string>, [cmd, key = '', ...rest]: string[], log?: UpstashCall[]): unknown {
  let result: unknown = null;
  const name = String(cmd).toUpperCase();
  if (name === 'GET') result = store.get(key) ?? null;
  else if (name === 'MGET') result = [key, ...rest].map((k) => store.get(k) ?? null);
  else if (name === 'SET') {
    if (rest.includes('NX') && store.has(key)) result = null;
    else (store.set(key, rest[0]!), (result = 'OK'));
  } else if (name === 'DEL') result = [key, ...rest].filter((k) => store.delete(k)).length;
  else if (name === 'INCR') (store.set(key, String(Number(store.get(key) ?? 0) + 1)), (result = Number(store.get(key))));
  else if (name === 'EXPIRE') result = store.has(key) ? 1 : 0;
  else if (name === 'EXISTS') result = [key, ...rest].filter((k) => store.has(k)).length;
  else if (name === 'HGET') result = hashOf(store, key)[rest[0]!] ?? null;
  else if (name === 'HGETALL') result = Object.entries(hashOf(store, key)).flat();
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
  } else throw new Error(`sahte Upstash: ${name} yok`);
  log?.push({ cmd: name, key, bytes: JSON.stringify(result).length });
  return result;
}

/** `fetch` yerine: Upstash adresine giden isteği bellekte yanıtlar */
export function upstashFetch(store: Map<string, string>, log?: UpstashCall[]) {
  return (init?: RequestInit) => new Response(JSON.stringify({ result: upstashCommand(store, JSON.parse(String(init!.body)) as string[], log) }), { status: 200 });
}
