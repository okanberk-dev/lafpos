import type { Database, SqlValue } from 'sql.js';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import { drizzle } from 'drizzle-orm/sql-js';
import * as schema from '../server/db/schema';
import { bundledMigrations } from './migrations';
import { currentDb, dbGeneration } from './sqljs';

/**
 * Tarayıcı demosunda `server/db/client.ts`: better-sqlite3 yerine sql.js (WASM SQLite). İkisi de eşzamanlı; sunucu
 * kodu aynı kalır. Farklar burada kapatılır:
 * - `run()` better-sqlite3 gibi değişen satır sayısını döndürür (okc/service.ts `.run().changes` okur).
 * - Kısıt hatası better-sqlite3'teki `code`'u taşır (server/lib/http.ts `constraintError` 500 yerine 409/422 döner).
 * - İç içe `tx()` kayıt noktası açar (better-sqlite3'ün `transaction`'ı gibi); `sqlite.inTransaction` derinlikten.
 */
const CONSTRAINTS: [RegExp, string][] = [
  [/^UNIQUE constraint failed/, 'SQLITE_CONSTRAINT_UNIQUE'],
  [/^FOREIGN KEY constraint failed/, 'SQLITE_CONSTRAINT_FOREIGNKEY'],
  [/^NOT NULL constraint failed/, 'SQLITE_CONSTRAINT_NOTNULL'],
  [/^CHECK constraint failed/, 'SQLITE_CONSTRAINT_CHECK'],
];

function withCode<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    const message = e instanceof Error ? e.message : '';
    const code = CONSTRAINTS.find(([re]) => re.test(message))?.[1];
    if (code && e instanceof Error) Object.assign(e, { code });
    throw e;
  }
}

const client = {
  prepare(query: string) {
    const raw = currentDb();
    const stmt = withCode(() => raw.prepare(query));
    const { run, step, get, getAsObject } = stmt;
    return Object.assign(stmt, {
      run: (params?: Parameters<typeof run>[0]) => {
        withCode(() => run.call(stmt, params));
        return { changes: raw.getRowsModified() };
      },
      step: () => withCode(() => step.call(stmt)),
      get: (params?: Parameters<typeof get>[0]) => withCode(() => get.call(stmt, params)),
      getAsObject: (params?: Parameters<typeof getAsObject>[0]) => withCode(() => getAsObject.call(stmt, params)),
    });
  },
};

export const db = drizzle(client as unknown as Database, { schema });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];

let active: Tx | null = null;

/** better-sqlite3 tutamağının sunucu ve testlerin kullandığı kadarı */
export const sqlite = {
  get inTransaction() {
    return active !== null;
  },
  pragma(_source: string) {},
  close() {},
  prepare(query: string) {
    // Toplu yazmada (testler) bir kez hazırlanır; veritabanı değişince yeniden
    let stmt: ReturnType<typeof client.prepare> | null = null;
    let generation = -1;
    return {
      run: (...params: SqlValue[]) => {
        if (!stmt || generation !== dbGeneration()) {
          stmt = client.prepare(query);
          generation = dbGeneration();
        }
        return stmt.run(params);
      },
    };
  },
  transaction<A extends unknown[]>(fn: (...args: A) => void) {
    return (...args: A) => tx(() => fn(...args));
  },
};

export function runMigrations() {
  const internal = db as unknown as { dialect: { migrate: (m: MigrationMeta[], session: unknown, config: object) => void }; session: unknown };
  internal.dialect.migrate(bundledMigrations(), internal.session, {});
}

/** Tek işlemde çalıştırır; iç içe çağrı kayıt noktası açar */
export function tx<T>(fn: (t: Tx) => T): T {
  const outer = active;
  const run = (t: Tx) => {
    active = t;
    try {
      return fn(t);
    } finally {
      active = outer;
    }
  };
  return outer ? outer.transaction(run) : db.transaction(run);
}

export { schema };
