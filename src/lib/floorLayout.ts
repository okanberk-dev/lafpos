/**
 * Masa planının kuralları: düzenleyicinin taslağı (yönetim › Masa planı) ve salonun en küçük boyu (Masalar). DOM'a
 * dokunmaz; testler doğrudan çağırır.
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

/**
 * Kayıttan sonra hâlâ kaydedilmemiş masalar: gönderilen konumda duran masa düşer, sunucudaki yerine geri bırakılmış
 * olan da (kaydedilecek bir şeyi yok). Kayıt sürerken yeniden sürüklenen masa işaretli kalır; sonraki yenileme onu
 * sunucudaki eski yerine zıplatmaz.
 */
export function settleSaved<T extends Geometry>(dirty: ReadonlySet<string>, local: T[], sent: Geometry[], server: Geometry[] = []): Set<string> {
  const sentById = new Map(sent.map((t) => [t.id, t]));
  const serverById = new Map(server.map((t) => [t.id, t]));
  const out = new Set(dirty);
  for (const t of local) {
    const s = sentById.get(t.id) ?? serverById.get(t.id);
    if (s && sameGeometry(t, s)) out.delete(t.id);
  }
  return out;
}

/** Plandaki en küçük masanın inmeyeceği ölçü (px): ad ve tutar sığar, dokunma hedefi 44 px'in üstünde */
export const PLAN_TILE_MIN = { w: 64, h: 56 } as const;
/** Planın en-boy oranı (16:10) */
export const PLAN_RATIO = 1.6;

/**
 * Planın en küçük boyu (px; 16:10 planın yüksekliği): en küçük masa `PLAN_TILE_MIN`'in altına inmesin. Alçak ekranda
 * (küçük kasa bilgisayarı, Windows ölçeği %125-150, yatay telefon) plan bunun altına küçülmez, yaprak kayar; masalar
 * düğme olmaktan çıkmaz (23 Kas 2026: 1366 × 768 ekranda %125 ölçekle masa 43 × 34 px'e iniyordu). Çok küçük çizilmiş
 * masa planı ekranlar boyu büyütmesin diye üst sınır, seyrek planda da okunur bir salon kalsın diye alt sınır var
 */
export function planMinHeight(tables: readonly { w: number; h: number }[]): number {
  if (!tables.length) return 0;
  const w = Math.max(1, Math.min(...tables.map((t) => t.w)));
  const h = Math.max(1, Math.min(...tables.map((t) => t.h)));
  const need = Math.max((PLAN_TILE_MIN.w * 100) / w / PLAN_RATIO, (PLAN_TILE_MIN.h * 100) / h);
  return Math.round(Math.min(640, Math.max(280, need)));
}
