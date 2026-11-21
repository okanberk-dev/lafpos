// Kafeye giden iki Windows ikilisinin sürümü ve özetleri: Node (nodejs.org) ve better-sqlite3'ün win32-x64 yerel
// modülü (WiseLibs). Kurulum dosyası (derle.mjs) bunları indirip özetle doğrular; güncelleme kanalı (kanal.mjs) aynı
// sabitleri surum.json'a yazar, kafedeki güncelleyici (guncelle.mjs) değiştiyse açık kaynaklarından indirip yine bu
// özetle doğrular. Bağımlılıksız; pakete girmez (değerler surum.json'la gider).

/**
 * Windows'a giden Node: 24 LTS'in son güvenlik sürümü. Değişince üçü birlikte: NODE_ABI nodejs.org/dist/index.json'da
 * "modules" (better-sqlite3'ün indirilen ikilisi buna göre), NODE_SHA256 o sürümün SHASUMS256.txt'sinde win-x64.zip
 */
export const NODE_VERSION = '24.22.3';
export const NODE_ABI = '137';
export const NODE_SHA256 = 'e612af99f626ab415ea225af6bce5c971feb448cb5cae250bb1c3fa50c5f7d9f';

/**
 * better-sqlite3'ün Windows ikilisinin (better-sqlite3-v<sürüm>-node-v<ABI>-win32-x64.tar.gz) SHA-256'sı, sürüme göre.
 * package-lock.json better-sqlite3'ü yükseltince yeni sürümün satırı eklenir (dosyayı GitHub'daki sürüm sayfasından
 * indirip `shasum -a 256` ile); yoksa kurulum ve güncelleme kanalı derlenmez. NODE_ABI değişince de yeniden yazılır
 */
export const SQLITE_SHA256 = {
  '12.11.1': '4ee5e653174d6ddd301605d351798cdae2613da06c4f37ecdce263021fcf1255',
};

export const nodeZipName = (version = NODE_VERSION) => `node-v${version}-win-x64.zip`;
export const nodeZipUrl = (version = NODE_VERSION) => `https://nodejs.org/dist/v${version}/${nodeZipName(version)}`;
export const sqliteTarName = (version, abi = NODE_ABI) => `better-sqlite3-v${version}-node-v${abi}-win32-x64.tar.gz`;
export const sqliteTarUrl = (version, abi = NODE_ABI) => `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/${sqliteTarName(version, abi)}`;

/** Bu sürümün ikilisinin özeti; tabloda yoksa açık hata (sabit yükseltilmeden derlenmez) */
export function sqliteSha256(version) {
  const sha = SQLITE_SHA256[version];
  if (!sha) {
    throw new Error(
      `better-sqlite3 ${version} için Windows ikilisinin SHA-256'sı scripts/kasa/windows/kurulum/surumler.mjs'te yok: ${sqliteTarUrl(version)} dosyasını indirip özetini SQLITE_SHA256'ya ekleyin`,
    );
  }
  return sha;
}
