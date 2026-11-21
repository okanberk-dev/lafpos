/**
 * Tarayıcı demosunda `node:net`: dışarıya bağlantı yok. İnternet dönüşünün TCP denemesi (server/sync/catch-up.ts)
 * demoda hiç çalışmaz (dış adres tanımlı değil); yine de çağrılırsa bağlanılamadı sayılır.
 */
export function connect(): never {
  throw new Error('Tarayıcı demosunda dışarıya bağlanılmaz');
}

export default { connect };
