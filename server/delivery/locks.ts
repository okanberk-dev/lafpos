/**
 * Kabul ya da ret kararı o an verilen platform siparişleri (platform çağrısı sürüyor). Karar uçları kilitler; süre
 * dolumu ve platform iptali bu kayıtlara dokunmaz, sonraki turu bekler. Tek süreç, bellekte.
 */
export const deciding = new Set<string>();
