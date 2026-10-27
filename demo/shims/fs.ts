import menuSnapshot from '../../server/db/menu-snapshot.json?raw';

/**
 * Tarayıcı demosunda `node:fs`: disk yok. Sunucunun okuduğu tek dosya, kurulumdaki site menüsü
 * (server/db/seed.ts), pakete gömülü gelir; yazma işleri bir şey yapmaz, klasörler boş görünür.
 */
const FILES: Record<string, string> = { 'server/db/menu-snapshot.json': menuSnapshot };

const bundled = (path: string) => Object.keys(FILES).find((name) => path === name || path.endsWith(`/${name}`));

function missing(path: string): Error {
  return Object.assign(new Error(`Demoda dosya yok: ${path}`), { code: 'ENOENT' });
}

export function existsSync(path: string): boolean {
  return !!bundled(path);
}

export function readFileSync(path: string, _enc?: string): string {
  const name = bundled(path);
  if (!name) throw missing(path);
  return FILES[name];
}

export function readdirSync(_path: string): string[] {
  return [];
}

export function statSync(path: string): never {
  throw missing(path);
}

export function mkdirSync(): void {}
export function writeFileSync(): void {}
export function renameSync(): void {}
export function rmSync(): void {}

export default { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync, renameSync, rmSync };
