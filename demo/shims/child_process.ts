/**
 * Tarayıcı demosunda `node:child_process`: süreç başlatılmaz. Token kablolu köprüsü (server/okc/token-kablo.ts) ve
 * kurulumu yalnız Windows kasa bilgisayarında çalışır; demoda hiç çağrılmaz, çağrılırsa başlatılamadı sayılır.
 */
export function spawn(): never {
  throw new Error('Tarayıcı demosunda süreç başlatılmaz');
}

export type ChildProcess = never;

export default { spawn };
