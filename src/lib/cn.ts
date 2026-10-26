/** Koşullu sınıf birleştirme: cn('a', ok && 'b', { c: flag }) */
export function cn(...args: (string | false | null | undefined | Record<string, boolean | undefined>)[]): string {
  const out: string[] = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else for (const [k, v] of Object.entries(a)) if (v) out.push(k);
  }
  return out.join(' ');
}
