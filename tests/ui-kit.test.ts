import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTL } from '../shared/money';
import { fmtAgo } from '../shared/time';
import { initialsInk } from '../src/components/ui/initials';
import { cn, cx, mergeClasses } from '../src/lib/cn';
import { joinMeta } from '../src/lib/text';
import { ApiError } from '../src/lib/api';
import { useApproval, withApproval } from '../src/lib/approvalStore';
import { bootThemeFor, resolveDark } from '../src/lib/bootDark';
import { consumeLines, restoreLines, type PendingLine } from '../src/lib/cart';
import { layoutChanges, mergeServerTables, PLAN_TILE_MIN, planMinHeight, settleSaved } from '../src/lib/floorLayout';
import { kpiCellSpan, kpiGridCols } from '../src/lib/kpiGrid';
import { applyNumpadKey, groupTyped, numpadKeyOf, typeOverPrefill } from '../src/lib/numpad';
import { lossParts, previousShort } from '../src/lib/reportLabels';
import { endSession } from '../src/lib/sessionEnd';
import { draftConflicts, fromLines, rebaseDraft } from '../src/lib/settingsDraft';
import { useToasts } from '../src/lib/toastStore';

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
    for (const k of ['primary', 'success', 'warning', 'danger', 'rose', 'info', 'violet']) expect(contrast(hex(dark, `admin-${k}-line`), hex(dark, 'admin-bg')), k).toBeGreaterThanOrEqual(2.5);
  });
  it('yüzen yüzeyde metin okunur', () => {
    for (const vars of [light, dark]) {
      for (const t of ['admin-text', 'admin-text-soft', 'admin-text-mute']) expect(contrast(hex(vars, t), hex(vars, 'surface-raised')), t).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('bildirim ikonları gece mürekkebinde seçilir (3:1, renk yalnız ikonda)', () => {
    const night = css.match(/--color-night:\s*(#[0-9a-f]{6})/i)![1];
    for (const name of ['danger-300', 'success-300', 'warn-300']) {
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

describe('baş harf avatarı', () => {
  it('avatarın baş harfleri kişinin renginde okunur: açık renkte gece mürekkebi, koyu renkte beyaz', () => {
    // Kasa ve Bar ekranı kullanıcılarının tohum renkleri: beyaz 12 px harf ~3.8:1'de kalıyordu
    expect(initialsInk('#a87c2e')).toBe('#211c18');
    expect(initialsInk('#5e8f45')).toBe('#211c18');
    expect(initialsInk('#3f6b8a')).toBe('#fff');
    expect(initialsInk('#1e4031')).toBe('#fff');
    // Seçilen harf rengi o zeminde ötekinden okunaklı
    for (const c of ['#a87c2e', '#5e8f45', '#3f6b8a', '#1e4031']) {
      const [chosen, other] = initialsInk(c) === '#fff' ? ['#ffffff', '#211c18'] : ['#211c18', '#ffffff'];
      expect(contrast(chosen, c), c).toBeGreaterThan(contrast(other, c));
    }
    // #rrggbb dışındaki değer (belirteç, kısa yazım) beyaz
    expect(initialsInk('var(--admin-primary)')).toBe('#fff');
  });
});

/** Klavyeyle yazılan tutar: tuşları sırayla tuş takımı kuralından geçirir (useNumpadKeys ile aynı eşleme) */
function typeKeys(keys: { key: string; code?: string }[], start = '', decimal = true): string {
  let v = start;
  for (const e of keys) {
    const a = numpadKeyOf(e, decimal);
    if (a?.type === 'key') v = applyNumpadKey(v, a.key, { decimal, maxLength: 9 });
  }
  return v;
}
const chars = (s: string) => [...s].map((key) => ({ key }));

describe('tuş takımı: fiziksel klavye', () => {
  const kurus = (typed: string) => parseTL(typeKeys(chars(typed)));
  it('ana sıradaki "." parseTL kuralıyla okunur: ardından üç hane binlik, daha azı ondalık', () => {
    expect(typeKeys(chars('2.000'))).toBe('2000');
    expect(kurus('2.000')).toBe(200000);
    expect(kurus('45.90')).toBe(4590);
    expect(kurus('12.5')).toBe(1250);
    expect(kurus('7.5')).toBe(750);
    expect(kurus('1.234.567')).toBe(123456700);
    expect(kurus('0.5')).toBe(50);
    // Klavyenin kendi yazımı ile para ayrıştırıcısı aynı sonucu verir
    for (const t of ['45.90', '12.5', '2.000', '1.250,50', '3']) expect(kurus(t), t).toBe(parseTL(t));
    expect(numpadKeyOf({ key: '.', code: 'Period' }, true)).toEqual({ type: 'key', key: '.' });
  });
  it('metinde kalan nokta ondalık gösterilir; dördüncü kesir hanesi ve ikinci ayırıcı reddedilir', () => {
    expect(groupTyped(typeKeys(chars('45.9')))).toBe('45,9');
    expect(groupTyped(typeKeys(chars('2.000')))).toBe('2.000');
    expect(typeKeys(chars('45.9,'))).toBe('45.9');
    expect(typeKeys(chars('12,5.'))).toBe('12,5');
    expect(applyNumpadKey('2.00', '00', { decimal: true })).toBe('2.00');
    expect(applyNumpadKey('2.0', '00', { decimal: true })).toBe('2000');
  });
  it('"," ve sayısal tuş takımının ondalığı virgül', () => {
    expect(typeKeys(chars('12,5'))).toBe('12,5');
    expect(numpadKeyOf({ key: '.', code: 'NumpadDecimal' }, true)).toEqual({ type: 'key', key: ',' });
    expect(numpadKeyOf({ key: ',', code: 'NumpadDecimal' }, true)).toEqual({ type: 'key', key: ',' });
  });
  it('ondalıksız tuş takımında virgül ve nokta tarayıcıya kalır', () => {
    expect(numpadKeyOf({ key: ',' }, false)).toBeNull();
    expect(numpadKeyOf({ key: '.' }, false)).toBeNull();
  });
  it('Enter, Backspace, Delete', () => {
    expect(numpadKeyOf({ key: 'Enter' })).toEqual({ type: 'enter' });
    expect(numpadKeyOf({ key: 'Backspace' })).toEqual({ type: 'key', key: 'back' });
    expect(numpadKeyOf({ key: 'Delete' })).toEqual({ type: 'key', key: 'clear' });
  });
  it('NumLock kapalıyken sayısal tuş takımının Del’i her alanda temizler (virgül yazmaz)', () => {
    expect(numpadKeyOf({ key: 'Delete', code: 'NumpadDecimal' }, true)).toEqual({ type: 'key', key: 'clear' });
    expect(numpadKeyOf({ key: 'Delete', code: 'NumpadDecimal' }, false)).toEqual({ type: 'key', key: 'clear' });
  });
});

describe('ödeme penceresi: önceden doldurulan kalan', () => {
  it('ilk rakam kalanın yerine geçer: "250" üstüne 100 yazılınca 100', () => {
    let v = '250';
    let replace = true;
    for (const k of ['1', '0', '0']) {
      v = typeOverPrefill(v, k, replace, { decimal: true });
      replace = false;
    }
    expect(v).toBe('100');
  });
  it('virgülle başlayan yazım da yerine geçer; geri sil değeri düzenler', () => {
    expect(typeOverPrefill('250', ',', true, { decimal: true })).toBe('0,');
    expect(typeOverPrefill('250', 'back', true, { decimal: true })).toBe('25');
    expect(typeOverPrefill('250', '5', false, { decimal: true })).toBe('2505');
  });
  it('kalandan fazla tutar kırpılmaz, ödeme düğmesi kapanır (kaynak)', () => {
    const src = readFileSync(join(__dirname, '../src/pages/order/PaymentModal.tsx'), 'utf8');
    expect(src).toMatch(/overRemaining = mode === 'tutar' && typed > remaining/);
    expect(src).toMatch(/const valid = [^;]*!overRemaining/);
    expect(src).not.toMatch(/Math\.min\(remaining, mode === 'kalem' \? itemsAmount : mode === 'paylas' \? nextShare : \(parseTL/);
  });
});

describe('klavyeli tuş takımında Enter', () => {
  it('klavye girişi açık her tuş takımı Enter’ı ya onaylar ya da hiç yapmaz (odaktaki rakam yinelenmez)', () => {
    const root = join(__dirname, '..');
    const walk = (dir: string): string[] =>
      readdirSync(join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith('.tsx') ? [join(dir, e.name)] : []));
    const bad: string[] = [];
    for (const f of walk('src')) {
      const text = readFileSync(join(root, f), 'utf8');
      for (const m of text.matchAll(/<Numpad\b[^>]*?\/>/gs)) if (/\bkeyboard\b/.test(m[0]) && !/\b(onEnter|confirm)=/.test(m[0])) bad.push(f);
    }
    expect(bad).toEqual([]);
    // Onaysız tuş takımında Enter, tuş takımının içindeyse yutulur
    expect(readFileSync(join(root, 'src/components/ui/Numpad.tsx'), 'utf8')).toMatch(/if \(!enter\) \{\s*if \(inPad\) e\.preventDefault\(\);/);
  });
});

describe('yetkili onayı', () => {
  it('yanlış PIN kırmızı uyarı olarak kalır, her soruda PIN alanı boşalır; oturum kapanınca soru vazgeçilir', async () => {
    let calls = 0;
    const fn = async (pin?: string) => {
      calls++;
      if (!pin) throw new ApiError(403, 'Yetkili onayı gerekli', 'approval_required', { permission: 'siparis.indirim' });
      if (pin !== '9999') throw new ApiError(403, 'Yetkili PIN hatalı', 'approval_invalid', {});
      return 'tamam';
    };
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const run = withApproval(fn);
    await flush();
    const first = useApproval.getState().pending!;
    expect(first.error).toBeNull();
    first.resolve('1111');
    await flush();
    const second = useApproval.getState().pending!;
    expect(second.error).toBe('Yetkili PIN hatalı');
    expect(second.attempt).toBeGreaterThan(first.attempt);
    second.resolve('1111');
    await flush();
    const third = useApproval.getState().pending!;
    // Aynı hata ikinci kez: ileti aynı ama soru yeni (PIN alanı yine boşalır)
    expect(third.error).toBe('Yetkili PIN hatalı');
    expect(third.attempt).toBeGreaterThan(second.attempt);
    third.resolve('9999');
    expect(await run).toBe('tamam');
    expect(useApproval.getState().pending).toBeNull();
    expect(calls).toBe(4);

    const pendingRun = withApproval(fn);
    await flush();
    expect(useApproval.getState().pending).not.toBeNull();
    endSession();
    expect(await pendingRun).toBeNull();
    expect(useApproval.getState().pending).toBeNull();
  });
});

describe('bildirim eylemi ("Geri al")', () => {
  it('en çok bir kez çalışır: kapanırken ikinci basış etkisiz', () => {
    let runs = 0;
    const id = useToasts.getState().push({ tone: 'ok', text: '3 ürün silindi', action: { label: 'Geri al', run: () => runs++ } });
    useToasts.getState().act(id);
    useToasts.getState().act(id);
    expect(runs).toBe(1);
    expect(useToasts.getState().list.find((x) => x.id === id)?.leaving).toBe(true);
  });
  it('kapanırken de dokunuşu bildirim alır: alttaki ürüne, pencerenin arka planına geçmez', () => {
    const src = readFileSync(join(__dirname, '../src/lib/toast.tsx'), 'utf8');
    expect(src).not.toMatch(/inert=/);
    expect(src).not.toMatch(/t\.leaving \? 'pointer-events-none'/);
  });
  it('geri alınan satırlar sepette zaten varsa yeniden eklenmez', () => {
    const line = (key: string): PendingLine => ({ key, productId: 'p', size: 'TEK', qty: 1, options: [], note: '' });
    const saved = [line('a'), line('b')];
    const once = restoreLines([], saved);
    expect(once.map((l) => l.key)).toEqual(['a', 'b']);
    expect(restoreLines(once, saved)).toBe(once);
    expect(restoreLines([line('c'), line('a')], saved).map((l) => l.key)).toEqual(['c', 'a', 'b']);
  });
});

describe('adisyon: gönderim', () => {
  const line = (key: string, qty = 1): PendingLine => ({ key, productId: key, size: 'TEK', qty, options: [], note: '' });
  it('yalnız gönderilen adetler düşer: istek sürerken "Geri al"la geri konan satır kalır', () => {
    // [A] silindi, B gönderiliyor; istek sürerken A geri alındı
    const sent = new Map([['b', 1]]);
    const onScreen = restoreLines([line('b')], [line('a')]);
    expect(consumeLines(onScreen, sent).map((l) => l.key)).toEqual(['a']);
  });
  it('istek sürerken aynı ürüne dokunulunca artan adet ve yeni satır beklemede kalır', () => {
    const sent = new Map([['b', 1]]);
    expect(consumeLines([line('b', 2), line('c')], sent)).toEqual([line('b', 1), line('c')]);
    expect(consumeLines([line('b', 1)], sent)).toEqual([]);
  });
  it('gönderim sepeti toptan silmez; "Gönder ve çık" tek seferlik, gönderim sürerken "Sil ve çık" kapalı (kaynak)', () => {
    const src = readFileSync(join(__dirname, '../src/pages/order/OrderPage.tsx'), 'utf8');
    const send = src.slice(src.indexOf('const send = async'), src.indexOf('// Tezgâhta tek ekran'));
    expect(send).toMatch(/cart\.consume\(order\.id, sent\)/);
    expect(send).not.toMatch(/cart\.clear/);
    expect(src).toMatch(/loading=\{sending\}\s*onClick=\{\(\) =>\s*void once\(async \(\) => \{\s*if \(!\(await send\(\)\)\) return;/);
    expect(src).toMatch(/<Button variant="dangerGhost" disabled=\{sending\} onClick=\{\(\) => \{ discardPending\(\); navigate\(backPath\); \}\}>/);
  });
  it('kalem taşıma tek seferlik; kalem penceresi istek sürerken kapanmaz; boş indirimde Enter kaldırmaz (kaynak)', () => {
    const ops = readFileSync(join(__dirname, '../src/pages/order/TableOps.tsx'), 'utf8');
    const transfer = ops.slice(ops.indexOf('export function TransferModal'), ops.indexOf('kalemi taşı'));
    expect(transfer).toMatch(/if \(busyRef\.current \|\| !chosen\.length\) return;/);
    expect(transfer).toMatch(/loading=\{busy\} onClick=\{\(\) => void submit\(\)\}/);
    const cart = readFileSync(join(__dirname, '../src/pages/order/CartPanel.tsx'), 'utf8');
    expect(cart).toMatch(/onClose=\{dismiss\}\s*persistent=\{busy\}/);
    expect(cart).toMatch(/if \(discValue !== ''\) void submit\(\);/);
    const pay = readFileSync(join(__dirname, '../src/pages/order/PaymentModal.tsx'), 'utf8');
    expect(pay).toMatch(/if \(m\.kind !== 'nakit' && focus === 'bahsis'\) requestAnimationFrame\(\(\) => panelRef\.current\?\.focus/);
  });
});

describe('arka plan, arama, gezinme (kaynak)', () => {
  it('komut paleti de Modal gibi click’te kapanır (basış karartmada başladıysa)', () => {
    const src = readFileSync(join(__dirname, '../src/components/CommandPalette.tsx'), 'utf8');
    expect(src).not.toMatch(/onPointerDown=\{\(e\) => e\.target === e\.currentTarget && onClose\(\)\}/);
    expect(src).toMatch(/if \(downOnBackdrop\.current && e\.target === e\.currentTarget\) onClose\(\);/);
  });
  it('aramayı temizle dokunmatikte alana odak vermez (ekran klavyesi açılmaz)', () => {
    const src = readFileSync(join(__dirname, '../src/components/ui/Field.tsx'), 'utf8');
    expect(src).toMatch(/if \(isFinePointer\(\)\) inner\.current\?\.focus\(\);/);
  });
  it('kaydedilmemiş değişiklik: geri hareketi ve Kilitle de sorar, ekran değişince gezinme sayfaları kapanır', () => {
    const guard = readFileSync(join(__dirname, '../src/lib/unsavedGuard.ts'), 'utf8');
    expect(guard).toMatch(/addEventListener\('popstate', onPop\)/);
    const shell = readFileSync(join(__dirname, '../src/components/AppShell.tsx'), 'utf8');
    expect(shell).toMatch(/const lock = async \(\) => \{[^}]*if \(!\(await confirmLeave\(\)\)\) return;/);
    expect(shell).toMatch(/setMoreOpen\(false\);\s*setMenuOpen\(false\);\s*\}, \[location\.pathname/);
    const palette = readFileSync(join(__dirname, '../src/components/CommandPalette.tsx'), 'utf8');
    expect(palette).toMatch(/if \(!\(await confirmLeave\(\)\)\) return;\s*await logout\(\);/);
  });
});

describe('zorla tema (bar, çağrı, müşteri ekranı)', () => {
  it('bar ekranı açık seçilmişse cihaz ve uygulama koyu olsa da açık', () => {
    expect(resolveDark('koyu', 'light', true)).toBe(false);
    expect(resolveDark('sistem', 'light', true)).toBe(false);
    expect(resolveDark('acik', 'dark', false)).toBe(true);
    expect(resolveDark('sistem', null, true)).toBe(true);
    expect(resolveDark('acik', null, true)).toBe(false);
  });
  it('açılışın ilk karesi de aynı karar', () => {
    expect(bootThemeFor('/mutfak', '', 'acik')).toBe('light');
    expect(bootThemeFor('/mutfak', '', 'koyu')).toBe('dark');
    expect(bootThemeFor('/musteri-ekrani', '?tema=acik', 'koyu')).toBe('light');
    // Müşteri ekranının son görünümü porselense ilk kare açık (yeniden açılışta koyu flaş yok)
    expect(bootThemeFor('/musteri-ekrani', '', 'koyu', 'porselen')).toBe('light');
    expect(bootThemeFor('/musteri-ekrani', '', 'koyu', 'gece')).toBe('dark');
    expect(bootThemeFor('/musteri-ekrani', '', 'koyu', null)).toBe('dark');
    expect(bootThemeFor('/cagri', '', 'acik')).toBe('dark');
    expect(bootThemeFor('/masalar', '', 'koyu')).toBeNull();
  });
});

describe('ayarlar taslağı', () => {
  it('satır listesi kaydedilirken kırpılır; alanın metni ayrı taslakta (SettingsAdmin LinesTextarea)', () => {
    expect(fromLines('Müşteri vazgeçti\nYanlış \n\n')).toEqual(['Müşteri vazgeçti', 'Yanlış']);
    const src = readFileSync(join(__dirname, '../src/pages/admin/SettingsAdmin.tsx'), 'utf8');
    expect(src).not.toMatch(/<Textarea value=\{lines\(/);
    expect(src).not.toMatch(/<Textarea value=\{s\.quickCash/);
  });
  it('sunucudan yeni veri gelince kaydedilmemiş alan korunur, dokunulmayan alan güncellenir', () => {
    const prev = { businessName: 'L’Affogato', serviceMode: 'masa', autoLockMinutes: 5 };
    const draft = { ...prev, businessName: 'L’Affogato Tuzla' };
    const next = { ...prev, serviceMode: 'self', autoLockMinutes: 10 };
    expect(rebaseDraft(prev, draft, next)).toEqual({ businessName: 'L’Affogato Tuzla', serviceMode: 'self', autoLockMinutes: 10 });
    expect(rebaseDraft(prev, prev, next)).toEqual(next);
  });
  it('aynı alanı başka cihaz da değiştirdiyse çakışma olarak söylenir', () => {
    const prev = { voidReasons: ['A'], businessName: 'Eski', autoLockMinutes: 5 };
    const draft = { ...prev, voidReasons: ['A', 'Yerel'], businessName: 'Yeni' };
    const next = { ...prev, voidReasons: ['A', 'Uzak'], businessName: 'Yeni', autoLockMinutes: 10 };
    expect(draftConflicts(prev, draft, next)).toEqual(['voidReasons']);
    expect(draftConflicts(prev, prev, next)).toEqual([]);
  });
  it('kayıt sonrası taslak kayıt ucunun yanıtıyla kurulur (yenileme başarısızsa eski ayarlar geri gelmez) (kaynak)', () => {
    const src = readFileSync(join(__dirname, '../src/pages/admin/SettingsAdmin.tsx'), 'utf8');
    const save = src.slice(src.indexOf('const save = async'), src.indexOf('const backupNow'));
    expect(save).toMatch(/const saved = await put<Settings>\('\/admin\/settings', rest\);/);
    expect(save).toMatch(/base\.current = saved;\s*qc\.setQueryData\(\['admin', 'settings'\], saved\);/);
    expect(save).not.toMatch(/getQueryData/);
    // Satır alanı odaktayken de dışarıdan gelen listeyi alır, kullanıcı yazmadıysa
    expect(src).toMatch(/if \(!focused\.current \|\| JSON\.stringify\(parse\(draft\)\) === prevKey\.current\) setDraft\(format\(value\)\);/);
  });
});

describe('masa planı taslağı', () => {
  const t = (id: string, x: number, name = id) => ({ id, name, x, y: 0, w: 10, h: 10 });
  it('sunucu listesi yenilenince sürüklenip kaydedilmemiş masanın yeri korunur', () => {
    const server = [t('m1', 0, 'M1 yeni ad'), t('m2', 0)];
    const local = [t('m1', 40), t('m2', 0)];
    expect(mergeServerTables(server, local, new Set(['m1']))).toEqual([t('m1', 40, 'M1 yeni ad'), t('m2', 0)]);
    expect(mergeServerTables(server, local, new Set())).toBe(server);
  });
  it('sayaç yalnız yeri gerçekten değişen masaları sayar', () => {
    const server = [t('m1', 0), t('m2', 0)];
    expect(layoutChanges([t('m1', 40), t('m2', 0)], server, new Set(['m1', 'm2'])).map((x) => x.id)).toEqual(['m1']);
  });
  it('kayıt sürerken sürüklenen masa işaretli kalır, yalnız gönderilen yerde duran düşer', () => {
    const before = [t('a', 0), t('b', 50), t('c', 20)];
    const sent = [{ id: 'a', x: 30, y: 0, w: 10, h: 10 }];
    // A gönderildi, istek sürerken B sürüklendi; C sürüklenip eski yerine bırakılmıştı
    const local = [t('a', 30), t('b', 0), t('c', 20)];
    expect([...settleSaved(new Set(['a', 'b', 'c']), local, sent, before)]).toEqual(['b']);
    // İstek sürerken A yeniden sürüklendiyse o da kalır
    expect([...settleSaved(new Set(['a']), [t('a', 60)], sent, before)]).toEqual(['a']);
  });
});

describe('KPI şeridi iskeleti', () => {
  it('iskelet yüklenecek şeritle aynı ızgarayı kullanır (tablette beş hücre iki satır)', () => {
    expect(kpiGridCols(5)).toBe('md:grid-cols-6 xl:grid-cols-5');
    expect([0, 1, 2, 3, 4].map((i) => kpiCellSpan(5, i))).toEqual(['md:col-span-2 xl:col-span-1', 'md:col-span-2 xl:col-span-1', 'md:col-span-2 xl:col-span-1', 'md:col-span-3 xl:col-span-1', 'md:col-span-3 xl:col-span-1']);
    const src = readFileSync(join(__dirname, '../src/components/admin/ui.tsx'), 'utf8');
    expect(src.match(/kpiGridCols\(/g)?.length).toBe(2);
    expect(src.match(/kpiCellSpan\(/g)?.length).toBe(2);
  });
});

describe('raporlar KPI etiketleri', () => {
  it('kıyas "Geçen hafta" demez, neyle kıyaslandığını ve saat kesimini söyler', () => {
    expect(previousShort('geçen haftanın aynı günleri')).toBe('1 hafta önce');
    expect(previousShort('geçen haftanın aynı günleri, aynı saate kadar')).toBe('1 hafta önce, bu saate dek');
    expect(previousShort('3 hafta önceki aynı günler')).toBe('3 hafta önce');
    expect(previousShort('önceki ayın aynı günleri, aynı saate kadar', { from: '2026-09-01', to: '2026-09-12' })).toBe('Önceki ayın ilk 12 günü, bu saate dek');
    expect(previousShort('önceki ayın aynı günleri')).toBe('Önceki ayın aynı günleri');
  });
  it('"İndirim ve ikram" dökümü değeri oluşturan kalemleri yazar', () => {
    const fmt = (k: number) => `₺${k / 100}`;
    expect(lossParts({ discounts: 0, complimentary: 50000, odenmez: 0, zayi: 50000, voided: 0 }, fmt)).toBe('İndirim ₺0 · zayi ₺500');
    expect(lossParts({ discounts: 1000, complimentary: 20000, odenmez: 5000, zayi: 0, voided: 3000 }, fmt)).toBe('İndirim ₺10 · ikram ₺150 · ödenmez ₺50 · iptal ₺30');
  });
});

describe('Button wrap: uzun etiket alt satıra iner, düğme uzar', () => {
  it('uzayan merdivende sabit yükseklik yok (dokunmatikte de), yazı satıra iner', () => {
    const src = readFileSync(join(__dirname, '../src/components/ui/Button.tsx'), 'utf8');
    const block = /const wrapSizes[^{]*\{([\s\S]*?)\n\};/.exec(src)?.[1] ?? '';
    const sizes = [...block.matchAll(/^\s*(sm|md|lg|xl): '([^']*)'/gm)];
    expect(sizes.map((m) => m[1])).toEqual(['sm', 'md', 'lg', 'xl']);
    for (const [, , cls] of sizes) {
      expect(cls.split(' ').filter((c) => /(^|:)h-\d/.test(c))).toEqual([]);
      expect(cls).toMatch(/(^| )min-h-/);
      expect(cls).toMatch(/pointer-coarse:min-h-/);
    }
    expect(src).toMatch(/const WRAP = 'whitespace-normal/);
    expect(src).toContain('opts.wrap ? cn(wrapSizes[size], WRAP) : sizes[size]');
  });
});

/**
 * Masalar planı her ekranda düğme kalır (23 Kas 2026, sahip: "exe'deki butonlar her ekrana tam uyumlu değil"): alçak
 * ekranda plan en küçük boyunun altına inmez (yaprak kayar), kart içeriği boya göre sadeleşir
 */
describe('masa planının en küçük boyu', () => {
  const tile = (t: { w: number; h: number }, planH: number) => ({ w: (planH * 1.6 * t.w) / 100, h: (planH * t.h) / 100 });

  it('örnek salonda (22 × 28 masalar, 71 × 18 bar) en alçak masa 56 px, en dar masa 64 px altına inmez', () => {
    const salon = [...Array.from({ length: 8 }, () => ({ w: 22, h: 28 })), { w: 71, h: 18 }];
    const h = planMinHeight(salon);
    expect(h).toBe(311);
    for (const t of salon) {
      expect(tile(t, h).w).toBeGreaterThanOrEqual(PLAN_TILE_MIN.w);
      expect(tile(t, h).h).toBeGreaterThanOrEqual(PLAN_TILE_MIN.h - 0.5);
    }
  });

  it('seyrek planda alt sınır (280), çok küçük çizilmiş masada üst sınır (640); masasız bölümde sıfır', () => {
    expect(planMinHeight([{ w: 60, h: 45 }])).toBe(280);
    expect(planMinHeight([{ w: 4, h: 4 }])).toBe(640);
    expect(planMinHeight([])).toBe(0);
    // Dar masa eni belirler: 8 × 30 masa 64 px ene 500 px'lik planda varır
    expect(planMinHeight([{ w: 8, h: 30 }])).toBe(500);
  });

  it('kart planda adlı kapta boya göre sadeleşir; varyantlar index.css’te büyükten küçüğe', () => {
    const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
    const heights = ['low', 'short', 'mini', 'flat'].map((n) => Number(new RegExp(`@custom-variant tile-${n} \\{\\s*@container tile \\(max-height: ([\\d.]+)rem\\)`).exec(css)?.[1]));
    expect(heights.every((h) => h > 0)).toBe(true);
    expect([...heights].sort((a, b) => b - a)).toEqual(heights);
    const page = readFileSync(new URL('../src/pages/FloorPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("plan ? '[container:tile/size]' : '@container'");
    // Plan en küçük boyunun altına inmez: kabın tabanı ve planın en az eni
    expect(page).toContain('md:min-h-[var(--plan-min)]');
    expect(page).toContain('max(160cqh,var(--plan-min-w))');
  });
});
