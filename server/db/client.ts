import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolve } from 'node:path';
import { env, ROOT } from '../env';
import * as schema from './schema';

export const sqlite = new Database(env.dbFile);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

export const db = drizzle(sqlite, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

export function runMigrations() {
  migrate(db, { migrationsFolder: resolve(ROOT, 'drizzle') });
}

/** Tek işlemde çalıştırır (better-sqlite3 eşzamanlıdır; iç içe çağrı kayıt noktası açar). */
export function tx<T>(fn: (t: Tx) => T): T {
  return db.transaction(fn);
}

export { schema };
