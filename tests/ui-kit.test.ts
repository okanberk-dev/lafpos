import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fmtAgo } from '../shared/time';
import { cn, cx, mergeClasses } from '../src/lib/cn';
import { joinMeta } from '../src/lib/text';

/** Ortak bileşen kitinin saf parçaları: sınıf birleştirme, meta satırı, yeni renk belirteçlerinin kontrastı */

/** WCAG 2.2 kontrast oranı (tests/design-tokens.test.ts ile aynı formül; o dosyayı içe almak testlerini ikiler) */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const h = hex.replace('#', '');
    const [r, g, bl] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

describe('cn: çakışan Tailwind sınıfında sonraki kazanır', () => {
  it('sayfanın verdiği genişlik kitin w-full’ünü ezer', () => {
    expect(cn('w-full rounded-xl px-3.5', 'w-24')).toBe('rounded-xl px-3.5 w-24');
    expect(cn('w-full', 'w-auto')).toBe('w-auto');
  });
  it('yazı rengi ile yazı boyu ayrı gruplar', () => {
    expect(cn('text-[15px] text-ink-2', 'text-[var(--admin-danger-ink)]')).toBe('text-[15px] text-[var(--admin-danger-ink)]');
    expect(cn('text-[15px] text-ink', 'text-sm')).toBe('text-ink text-sm');
    expect(cn('text-left', 'text-center')).toBe('text-center');
    expect(cn('text-white/80', 'text-ink')).toBe('text-ink');
  });
  it('zemin rengi, boyu ve konumu ayrı', () => {
    expect(cn('bg-surface bg-[length:16px] bg-[right_12px_center] bg-no-repeat', 'bg-surface-3')).toBe('bg-[length:16px] bg-[right_12px_center] bg-no-repeat bg-surface-3');
    expect(cn('bg-[var(--admin-surface)]', 'bg-[var(--admin-primary-soft)]/60')).toBe('bg-[var(--admin-primary-soft)]/60');
  });
  it('genel boşluk öncekini ezer, tek yanlı genele dokunmaz', () => {
    expect(cn('px-4 pl-2', 'p-0')).toBe('p-0');
    expect(cn('p-4', 'px-0')).toBe('p-4 px-0');
    expect(cn('h-11 px-4', 'w-11 px-0')).toBe('h-11 w-11 px-0');
    expect(cn('-mr-1.5', 'mr-0')).toBe('mr-0');
  });
  it('size genişlik ve yüksekliği ezer', () => {
    expect(cn('w-9 h-9', 'size-11')).toBe('size-11');
  });
  it('varyant ve önem işareti ayrı gruptur', () => {
    expect(cn('h-11 [[data-area=admin]_&]:pointer-fine:h-9', 'h-10')).toBe('[[data-area=admin]_&]:pointer-fine:h-9 h-10');
    expect(cn('hover:bg-surface-2', 'hover:bg-hover', 'bg-surface')).toBe('hover:bg-hover bg-surface');
    expect(cn('w-full', 'w-24!')).toBe('w-full w-24!');
    expect(cn('focus-visible:outline-offset-2', 'focus-visible:-outline-offset-2')).toBe('focus-visible:-outline-offset-2');
  });
  it('kenar kalınlığı ile rengi, köşe tümü ile tek köşe', () => {
    expect(cn('border border-line', 'border-[var(--admin-danger)]/35')).toBe('border border-[var(--admin-danger)]/35');
    expect(cn('border-2', 'border')).toBe('border');
    expect(cn('border-b border-line', 'border-transparent')).toBe('border-b border-transparent');
    expect(cn('rounded-t-2xl', 'rounded-xl')).toBe('rounded-xl');
    expect(cn('rounded-xl', 'rounded-t-none')).toBe('rounded-xl rounded-t-none');
  });
  it('görünüm, konum, esneklik', () => {
    expect(cn('grid grid-cols-2', false, 'hidden')).toBe('grid-cols-2 hidden');
    expect(cn('relative', 'absolute')).toBe('absolute');
    expect(cn('flex-1 flex-col', 'flex-none')).toBe('flex-col flex-none');
    expect(cn('inline-flex', 'flex w-full')).toBe('flex w-full');
  });
  it('tanımadığı ve kendi sınıflarına dokunmaz', () => {
    expect(cn('select-arrow select-none', 'tabular no-scrollbar skeleton')).toBe('select-arrow select-none tabular no-scrollbar skeleton');
    expect(cn('[overflow-wrap:anywhere] [&>svg]:size-4', '[&>svg]:size-5')).toBe('[overflow-wrap:anywhere] [&>svg]:size-5');
    expect(cn('stroke-[2.25] truncate')).toBe('stroke-[2.25] truncate');
  });
  it('nesne ve koşullu argümanlar, cx birleştirmeden dizer', () => {
    expect(cn('a', { b: true, c: false }, null, undefined, 0, '')).toBe('a b');
    expect(cx('w-full', 'w-24')).toBe('w-full w-24');
    expect(mergeClasses('  px-2   px-4 ')).toBe('px-4');
  });
});

describe('meta satırı', () => {
  it('boş parça düşer, tire dolgusu yok', () => {
    expect(joinMeta(['3 ürün', null, '', undefined, false, 'Garson'])).toBe('3 ürün · Garson');
    expect(joinMeta(['a', 'b', 'c', 'd'], 3)).toBe('a · b · c');
    expect(joinMeta([])).toBe('');
  });
  it('geçen süre: bir dakikadan kısası "az önce"', () => {
    const t = Date.UTC(2026, 9, 28, 12, 0);
    expect(fmtAgo(t, t + 30_000)).toBe('az önce');
    expect(fmtAgo(t, t + 12 * 60_000)).toBe('12 dk');
    expect(fmtAgo(t, t + 65 * 60_000)).toBe('1 sa 5 dk');
  });
});

describe('yeni renk belirteçleri (index.css)', () => {
  const css = readFileSync(join(__dirname, '../src/index.css'), 'utf8');
  const block = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    const body = css.slice(start, css.indexOf('}', start));
    return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  };
  const light = block(':root');
  const dark = { ...light, ...block('.dark') };
  const hex = (vars: Record<string, string>, name: string): string => {
    const v = vars[name];
    const ref = v?.match(/^var\(--([\w-]+)\)$/);
    return ref ? hex(vars, ref[1]) : v;
  };

  it('kıyas çizgisi iki temada kartta 3:1 (grafik nesnesi)', () => {
    for (const vars of [light, dark]) expect(contrast(hex(vars, 'chart-context'), hex(vars, 'admin-surface'))).toBeGreaterThanOrEqual(3);
  });
  it('koyu temada durum çizgileri zeminde seçilir (2.5:1)', () => {
    for (const k of ['primary', 'success', 'warning', 'danger', 'rose', 'info']) expect(contrast(hex(dark, `admin-${k}-line`), hex(dark, 'admin-bg')), k).toBeGreaterThanOrEqual(2.5);
  });
  it('yüzen yüzeyde metin okunur', () => {
    for (const vars of [light, dark]) {
      for (const t of ['admin-text', 'admin-text-soft', 'admin-text-mute']) expect(contrast(hex(vars, t), hex(vars, 'surface-raised')), t).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('bildirim ikonları gece mürekkebinde seçilir (3:1, renk yalnız ikonda)', () => {
    const night = css.match(/--color-night:\s*(#[0-9a-f]{6})/i)![1];
    for (const name of ['danger-300', 'success-300']) {
      const v = css.match(new RegExp(`--color-${name}:\\s*(#[0-9a-f]{6})`, 'i'))![1];
      expect(contrast(v, night), name).toBeGreaterThanOrEqual(3);
    }
  });
  it('koyu karartma ve yüzen yüzey tanımlı, karartma açıktakinden yoğun', () => {
    const alpha = (v: string) => Number(v.match(/\/\s*([\d.]+)\)/)?.[1]);
    expect(alpha(dark.scrim)).toBeGreaterThanOrEqual(0.5);
    expect(alpha(dark.scrim)).toBeGreaterThan(alpha(light.scrim));
    expect(dark['surface-raised']).not.toBe(dark['admin-surface']);
  });
});
