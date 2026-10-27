/** Tarayıcı demosunda `node:zlib`: LafPOS Uzaktan'a özet gönderilmez */
export function gzipSync(): never {
  throw new Error('Demoda uzaktan erişime veri gönderilmez');
}

export default { gzipSync };
