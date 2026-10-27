import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import type { MigrationMeta } from 'drizzle-orm/migrator';
import journal from '../drizzle/meta/_journal.json';

/** Göçler pakete gömülür (disk yok); drizzle'ın kendi göç adımı bunları sırayla uygular */
const FILES = import.meta.glob<string>('../drizzle/*.sql', { query: '?raw', import: 'default', eager: true });

/** drizzle-orm/migrator `readMigrationFiles` ile aynı biçim: kayıtlı demo veritabanına yalnız yeni göçler uygulanır */
export function bundledMigrations(): MigrationMeta[] {
  return journal.entries.map((entry) => {
    const query = FILES[`../drizzle/${entry.tag}.sql`];
    if (query === undefined) throw new Error(`Göç dosyası pakette yok: ${entry.tag}`);
    return {
      sql: query.split('--> statement-breakpoint'),
      bps: entry.breakpoints,
      folderMillis: entry.when,
      hash: bytesToHex(sha256(utf8ToBytes(query))),
    };
  });
}
