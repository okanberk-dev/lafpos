/**
 * Oturum kapanınca (çıkış, otomatik kilit, sunucunun 401'i) bekleyen sorular vazgeçilmiş sayılır: onay ve gerekçe
 * pencereleri ile yetkili PIN'i giriş ekranının üstünde kalmaz, sonraki kasiyer öncekinin penceresini görmez.
 * Pencere depoları burada kayıt olur; auth.ts oturum düşünce `endSession()` çağırır.
 */
const listeners = new Set<() => void>();

export function onSessionEnd(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function endSession() {
  for (const fn of [...listeners]) fn();
}
