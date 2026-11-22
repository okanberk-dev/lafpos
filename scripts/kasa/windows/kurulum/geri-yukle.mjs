// Buluttan geri yükleme, bekçi tarafı (server/sync/yedek.ts): sunucu önce isteği (geri-yukle/istek.json: kim, hangi
// yedek, an), sonra hazır yedeği geri-yukle/hazir.db olarak bırakıp kapanır. Bekçi sunucuyu açmadan önce mevcut
// veritabanını (-wal ve -shm ile) backups/lafpos-geri-yukleme-oncesi-<an>.db olarak kenara taşır (aynı klasörde
// yeniden adlandırma: ek disk yeri istemez) ve hazır yedeği yerine koyar. İstek yoksa, okunamıyorsa ya da 15 dakikadan
// eskiyse yedek yerine konmaz, silinir: yarım kalmış ya da ertelenmiş bir geri yükleme günler sonra rastgele bir
// yeniden başlatmada canlı veritabanını değiştiremez. Sonuç geri-yukle/son.json'a yazılır; sunucu açılışta denetim
// kaydına geçirir (server/sync/yedek.ts recordRestoreResult).
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** Windows'ta kısa süreli kilit (Defender taraması, yedek yazılımı): yeniden adlandırma birkaç kez denenir */
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function renameRetry(rename, from, to, tries, waitMs) {
  for (let i = 1; ; i++) {
    try {
      return rename(from, to);
    } catch (e) {
      if (i >= tries) throw e;
      sleep(waitMs);
    }
  }
}

/**
 * Bekleyen geri yükleme varsa uygular ya da iptal eder; ne yapıldığını döner (günlüğe). Kenara alma ya da yerine koyma
 * düşer ve geri alma da düşerse (iki ardışık kilit) hazır yedek ve istek silinmez, son.json'a yazılır ve `RESTORE_STUCK`
 * kodlu hata fırlar: bekçi veritabanı yerinde değilken sunucuyu açmaz (recoverMissingDb)
 */
export function applyPendingRestore(home, now = new Date(), opts = {}) {
  const rename = opts.rename ?? renameSync;
  const tries = opts.tries ?? 8;
  const waitMs = opts.waitMs ?? 250;
  const dir = join(home, 'geri-yukle');
  const ready = join(dir, 'hazir.db');
  if (!existsSync(ready)) return null;
  const req = readRequest(dir);
  const writeResult = (result) =>
    writeFileSync(join(dir, 'son.json'), JSON.stringify({ at: now.getTime(), pathname: req?.pathname ?? null, by: req?.by ?? null, byName: req?.byName ?? null, requestedAt: req?.at ?? null, ...result }));
  const done = (result) => {
    rmSync(join(dir, 'istek.json'), { force: true });
    writeResult(result);
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
  // Geri alma: kenara alınanlar yerine (yeniden denemeyle). O da düşerse hiçbir şey silinmez
  const undo = (why) => {
    try {
      for (const [from, to] of moved.reverse()) renameRetry(rename, to, from, tries, waitMs);
    } catch (e) {
      writeResult({ hata: `${why}; geri alınamadı (${errText(e)}), önceki veritabanı ${copy}`, takili: true });
      const err = new Error(`geri yükleme yarıda kaldı: ${why}; önceki veritabanı ${copy}`);
      err.code = 'RESTORE_STUCK';
      throw err;
    }
    return cancel(why);
  };
  try {
    for (const [from, to] of [
      [db, copy],
      [`${db}-wal`, `${copy}-wal`],
      [`${db}-shm`, `${copy}-shm`],
    ]) {
      if (!existsSync(from)) continue;
      renameRetry(rename, from, to, tries, waitMs);
      moved.push([from, to]);
    }
  } catch (e) {
    return undo(`mevcut veritabanı kenara alınamadı (${errText(e)})`);
  }
  try {
    renameRetry(rename, ready, db, tries, waitMs);
  } catch (e) {
    return undo(`yedek yerine konamadı (${errText(e)})`);
  }
  done({ copy });
  return `buluttan geri yüklendi; önceki veritabanı ${copy}`;
}

const PRE_RESTORE_RE = /^lafpos-geri-yukleme-oncesi-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})\.db$/;

/**
 * Sunucu açılmadan önceki güvence (bekçi): veritabanı yok ama geri yükleme yarıda kalmışsa (hazır yedek duruyor ya da son
 * 15 dakikada kenara alınmış veritabanı var) sunucu boş veritabanıyla (örnek veri, yeni Merkez kimliği) açılmamalı.
 * Kenara alınan en yeni veritabanı (-wal ve -shm ile) yerine taşınır. Dönüş: null (açılabilir) ya da neden (açılmaz,
 * biraz sonra yeniden denenir)
 */
export function recoverMissingDb(home, now = new Date(), opts = {}) {
  const rename = opts.rename ?? renameSync;
  const db = join(home, 'lafpos.db');
  if (existsSync(db)) return null;
  const backups = join(home, 'backups');
  let names = [];
  try {
    names = readdirSync(backups);
  } catch {
    names = [];
  }
  const recent = names
    .map((n) => {
      const m = PRE_RESTORE_RE.exec(n);
      return m ? { n, at: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() } : null;
    })
    .filter((x) => x && now.getTime() - x.at <= RESTORE_MAX_AGE_MS && x.at <= now.getTime() + 60_000)
    .sort((a, b) => b.at - a.at)[0];
  const pending = existsSync(join(home, 'geri-yukle', 'hazir.db'));
  if (!recent && !pending) return null;
  if (!recent) return 'veritabanı yok ama geri yükleme yarıda; sunucu açılmıyor';
  const copy = join(backups, recent.n);
  try {
    for (const suffix of ['', '-wal', '-shm']) if (existsSync(`${copy}${suffix}`)) rename(`${copy}${suffix}`, `${db}${suffix}`);
    return null;
  } catch (e) {
    return `veritabanı yerine geri taşınamadı (${errText(e)}); sunucu açılmıyor, biraz sonra yeniden denenecek`;
  }
}
