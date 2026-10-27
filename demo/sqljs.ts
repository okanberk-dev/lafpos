import type { Database, SqlJsStatic } from 'sql.js';

/**
 * Demonun o anki SQLite veritabanı (sql.js, bellekte). Sunucu modülleri yüklenirken açık olması gerekmez: drizzle
 * her sorguda buradan alır, böylece sıfırlama ya da başka sekmeden gelen kopya veritabanını yerinde değiştirir.
 */
let SQL: SqlJsStatic | null = null;
let current: Database | null = null;
/** Veritabanı açılınca ya da dışa aktarılınca artar: o andan önce hazırlanan sorgular geçersizdir */
let generation = 0;

export const dbGeneration = () => generation;

export function setSqlJs(sql: SqlJsStatic) {
  SQL = sql;
}

function applyPragmas(db: Database) {
  db.run('PRAGMA foreign_keys = ON');
}

/** Boş ya da kayıtlı (dışa aktarılmış) veritabanını açar; öncekini kapatır */
export function openDatabase(bytes?: Uint8Array): Database {
  if (!SQL) throw new Error('sql.js yüklenmedi');
  current?.close();
  current = new SQL.Database(bytes);
  generation++;
  applyPragmas(current);
  return current;
}

export function currentDb(): Database {
  if (!current) throw new Error('Demo veritabanı açılmadı');
  return current;
}

/**
 * Veritabanının dosya hâli. sql.js dışa aktarırken bağlantıyı kapatıp yeniden açar: hazır sorgular silinir (drizzle
 * her sorgudan sonra zaten siler) ve PRAGMA'lar sıfırlanır, yeniden yazılır. İşlem açıkken çağrılmaz (işlemler
 * eşzamanlı, kaydetme zamanlayıcıdan çalışır).
 */
export function exportDatabase(): Uint8Array {
  const db = currentDb();
  const bytes = db.export();
  generation++;
  applyPragmas(db);
  return bytes;
}
