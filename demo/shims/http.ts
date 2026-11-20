/**
 * Tarayıcı demosunda `node:http` ve `node:https`: yerel ağdaki cihaza (Pavo yazarkasa) istek gitmez. Demoda
 * yazarkasa yalnız eğitim cihazıdır; Pavo seçilse de ayar dosyası olmadığından istemci hiç kurulmaz.
 */
export function request(): never {
  throw new Error('Tarayıcı demosunda yerel ağdaki cihaza bağlanılmaz');
}

export default { request };
