/** Tarayıcı demosunda `node:zlib`: AsilPOS Uzaktan'a özet gönderilmez */
const NO_CLOUD = 'Demoda uzaktan erişime veri gönderilmez';

export function gzipSync(): never {
  throw new Error(NO_CLOUD);
}

/** Eşzamansız gzip (server/sync/cloud.ts): demoda hep hata döner */
export function gzip(_data: unknown, a: unknown, b?: unknown): void {
  const done = (typeof a === 'function' ? a : b) as (err: Error | null, out?: Uint8Array) => void;
  done(new Error(NO_CLOUD));
}

/** Bulut yedeğinin açılması (server/sync/yedek.ts): demoda çağrılmaz */
export function gunzipSync(): never {
  throw new Error('Tarayıcı demosunda bulut yedeği yok');
}

/** Token sürücü arşivinin açılması (server/okc/token-kablo-kurulum.ts): yalnız Windows kasada, demoda çağrılmaz */
export function inflateRawSync(): never {
  throw new Error('Tarayıcı demosunda sürücü kurulumu yok');
}

export default { gzipSync, gzip, gunzipSync, inflateRawSync };
