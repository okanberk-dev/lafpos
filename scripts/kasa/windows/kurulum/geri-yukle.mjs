// Buluttan geri yükleme, bekçi tarafı (server/sync/yedek.ts): sunucu hazır yedeği veri klasöründe
// geri-yukle/hazir.db olarak bırakıp kapanır. Bekçi sunucuyu açmadan önce mevcut veritabanının kopyasını alır
// (backups/lafpos-geri-yukleme-oncesi-<an>.db) ve hazır yedeği yerine koyar; -wal ve -shm eski veritabanına aittir,
// silinir. Kopya alınamazsa hiçbir şey değişmez (hazır yedek bir sonraki açılışa kalır).
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

/** Bekleyen geri yükleme varsa uygular; ne yapıldığını döner (günlüğe) */
export function applyPendingRestore(home, now = new Date()) {
  const dir = join(home, 'geri-yukle');
  const ready = join(dir, 'hazir.db');
  if (!existsSync(ready)) return null;
  const db = join(home, 'lafpos.db');
  const backups = join(home, 'backups');
  mkdirSync(backups, { recursive: true });
  const copy = join(backups, `lafpos-geri-yukleme-oncesi-${stamp(now)}.db`);
  try {
    if (existsSync(db)) {
      copyFileSync(db, copy);
      if (existsSync(`${db}-wal`)) copyFileSync(`${db}-wal`, `${copy}-wal`);
    }
  } catch (e) {
    return `geri yükleme ertelendi: mevcut veritabanının kopyası alınamadı (${e instanceof Error ? e.message : e})`;
  }
  for (const f of [`${db}-wal`, `${db}-shm`]) rmSync(f, { force: true });
  renameSync(ready, db);
  rmSync(join(dir, 'istek.json'), { force: true });
  writeFileSync(join(dir, 'son.json'), JSON.stringify({ at: now.getTime(), copy }));
  return `buluttan geri yüklendi; önceki veritabanı ${copy}`;
}
