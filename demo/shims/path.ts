/** Tarayıcı demosunda `node:path`: sunucunun yol birleştirmeleri için sade POSIX karşılığı */
function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts.join('/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

export function resolve(...parts: string[]): string {
  const from = parts.findLastIndex((p) => p.startsWith('/'));
  return normalize(from >= 0 ? parts.slice(from) : ['/', ...parts]);
}

export function join(...parts: string[]): string {
  return normalize(parts);
}

export function dirname(path: string): string {
  return normalize([path, '..']);
}

export function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? '';
}

export function relative(from: string, to: string): string {
  const a = resolve(from).split('/').filter(Boolean);
  const b = resolve(to).split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
}

export const sep = '/';

export default { resolve, join, dirname, basename, relative, sep };
