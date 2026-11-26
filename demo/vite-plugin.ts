import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const at = (p: string) => resolve(ROOT, p);

/** Sunucunun diske ve yerel SQLite'a bağlı iki modülü: demoda yerlerine tarayıcı karşılıkları */
const SWAP = new Map([
  [at('server/env.ts'), at('demo/env.ts')],
  [at('server/db/client.ts'), at('demo/db.ts')],
]);

/** Node modülleri: sunucunun kullandığı kadar tarayıcı karşılığı (demo/shims) */
const BUILTINS: Record<string, string> = {
  'node:child_process': at('demo/shims/child_process.ts'),
  'node:crypto': at('demo/shims/crypto.ts'),
  'node:events': at('demo/shims/events.ts'),
  'node:fs': at('demo/shims/fs.ts'),
  'node:http': at('demo/shims/http.ts'),
  'node:https': at('demo/shims/http.ts'),
  'node:path': at('demo/shims/path.ts'),
  'node:os': at('demo/shims/os.ts'),
  'node:net': at('demo/shims/net.ts'),
  'node:zlib': at('demo/shims/zlib.ts'),
  '@hono/node-server/serve-static': at('demo/shims/serve-static.ts'),
};

const VIRTUAL = 'virtual:asilpos-demo';
const MISSING = '\0asilpos-demo-yok';
/** sql.js Node'da olduğunu anlayınca kullandığı modüller: tarayıcıda o yola girmez */
const EMPTY = '\0asilpos-demo-bos';

/**
 * AsilPOS sunucusunu tarayıcıda çalıştırmak için (vite build --mode demo, docs/DEMO.md).
 * - `server`: sunucu modüllerini demo karşılıklarına çevirir (env, veritabanı).
 * - `builtins`: Node modüllerini tarayıcı karşılıklarına çevirir (testte Node'un kendisi kalır).
 * - `virtual:asilpos-demo` arayüzün demo çalışma zamanına açılan kapısıdır; demo dışındaki derlemede boştur.
 */
export function asilposDemo(opts: { server: boolean; builtins: boolean }): Plugin {
  return {
    name: 'asilpos-demo',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (source === VIRTUAL) return opts.server ? at('demo/runtime.ts') : MISSING;
      if (opts.builtins && source in BUILTINS) return BUILTINS[source];
      if (opts.builtins && importer?.includes('/sql.js/') && ['fs', 'path', 'crypto'].includes(source)) return EMPTY;
      if (!opts.server || !importer || !source.startsWith('.')) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      const swapped = resolved && SWAP.get(resolved.id);
      return swapped || null;
    },
    load(id) {
      if (id === MISSING) return 'export async function startDemoServer() { throw new Error("Bu derlemede demo yok"); }';
      if (id === EMPTY) return 'export default {};';
      return null;
    },
  };
}
