// Buluttan geri yükleme, bekçi tarafı (server/sync/yedek.ts): sunucu önce isteği (geri-yukle/istek.json: kim, hangi
// yedek, an), sonra hazır yedeği geri-yukle/hazir.db olarak bırakıp kapanır. Bekçi sunucuyu açmadan önce mevcut
// veritabanını (-wal ve -shm ile) backups/lafpos-geri-yukleme-oncesi-<an>.db olarak kenara taşır (aynı klasörde
// yeniden adlandırma: ek disk yeri istemez) ve hazır yedeği yerine koyar. İstek yoksa, okunamıyorsa ya da 15 dakikadan
// eskiyse yedek yerine konmaz, silinir: yarım kalmış ya da ertelenmiş bir geri yükleme günler sonra rastgele bir
// yeniden başlatmada canlı veritabanını değiştiremez. Sonuç geri-yukle/son.json'a yazılır; sunucu açılışta denetim
// kaydına geçirir (server/sync/yedek.ts recordRestoreResult).
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
/** İstek bu kadar eskiyse yerine konmaz (sunucu isteği yazıp yarım saniye sonra kapanır) */
export const RESTORE_MAX_AGE_MS = 15 * 60_000;
const errText = (e) => (e instanceof Error ? e.message : String(e));

function readRequest(dir) {
  try {
    const r = JSON.parse(readFileSync(join(dir, 'istek.json'), 'utf8'));
    return r && typeof r === 'object' && typeof r.at === 'number' ? r : null;
  } catch {
    return null;
  }
}

/** Bekleyen geri yükleme varsa uygular ya da iptal eder; ne yapıldığını döner (günlüğe) */
export function applyPendingRestore(home, now = new Date()) {
  const dir = join(home, 'geri-yukle');
  const ready = join(dir, 'hazir.db');
  if (!existsSync(ready)) return null;
  const req = readRequest(dir);
  const done = (result) => {
    rmSync(join(dir, 'istek.json'), { force: true });
    writeFileSync(join(dir, 'son.json'), JSON.stringify({ at: now.getTime(), pathname: req?.pathname ?? null, by: req?.by ?? null, byName: req?.byName ?? null, requestedAt: req?.at ?? null, ...result }));
  };
  const cancel = (why) => {
    rmSync(ready, { force: true });
    done({ hata: why });
    return `geri yükleme iptal: ${why}`;
  };
  if (!req) return cancel('istek bulunamadı ya da okunamadı');
  if (now.getTime() - req.at > RESTORE_MAX_AGE_MS || req.at > now.getTime() + 60_000) return cancel('istek eski (yarım kalmış geri yükleme)');

  const db = join(home, 'lafpos.db');
  const backups = join(home, 'backups');
  mkdirSync(backups, { recursive: true });
  const copy = join(backups, `lafpos-geri-yukleme-oncesi-${stamp(now)}.db`);
  const moved = [];
  try {
    for (const [from, to] of [
      [db, copy],
      [`${db}-wal`, `${copy}-wal`],
      [`${db}-shm`, `${copy}-shm`],
    ]) {
      if (!existsSync(from)) continue;
      renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (e) {
    for (const [from, to] of moved.reverse()) renameSync(to, from);
    return cancel(`mevcut veritabanı kenara alınamadı (${errText(e)})`);
  }
  try {
    renameSync(ready, db);
  } catch (e) {
    for (const [from, to] of moved.reverse()) renameSync(to, from);
    return cancel(`yedek yerine konamadı (${errText(e)})`);
  }
  done({ copy });
  return `buluttan geri yüklendi; önceki veritabanı ${copy}`;
}
