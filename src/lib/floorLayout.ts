/**
 * Masa planı düzenleyicisinin taslak kuralları (yönetim › Masa planı). DOM'a dokunmaz; testler doğrudan çağırır.
 */
export interface Geometry {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

const sameGeometry = (a: Geometry, b: Geometry) => a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;

/**
 * Sunucudan yeni masa listesi gelince (bölüm değişimi, masa düzenleme, QR, kaldırma) sürüklenip kaydedilmemiş
 * masaların yeri korunur; geri kalan her şey (ad, kişi, şekil, yeni ve kaldırılan masalar) sunucudan gelir.
 */
export function mergeServerTables<T extends Geometry>(server: T[], local: T[], dirty: ReadonlySet<string>): T[] {
  if (!dirty.size) return server;
  const byId = new Map(local.map((t) => [t.id, t]));
  return server.map((t) => {
    const l = byId.get(t.id);
    return l && dirty.has(t.id) ? { ...t, x: l.x, y: l.y, w: l.w, h: l.h } : t;
  });
}

/** Kaydedilecek konumlar: dokunulmuş ve yeri sunucudakinden gerçekten farklı masalar (geri sürüklenen sayılmaz) */
export function layoutChanges<T extends Geometry>(local: T[], server: T[], dirty: ReadonlySet<string>): T[] {
  const byId = new Map(server.map((t) => [t.id, t]));
  return local.filter((t) => {
    if (!dirty.has(t.id)) return false;
    const s = byId.get(t.id);
    return !!s && !sameGeometry(t, s);
  });
}
