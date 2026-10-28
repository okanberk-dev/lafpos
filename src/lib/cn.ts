/**
 * Koşullu sınıf birleştirme: cn('a', ok && 'b', { c: flag }).
 *
 * Aynı özelliği yazan iki Tailwind sınıfı yan yana gelirse (ör. kitin `h-11`'i ile sayfanın `h-10`'u, ghost
 * düğmenin `text-ink-2`'si ile sayfanın `text-[var(--admin-danger-ink)]`'i) SONRAKİ kalır: bileşene `className`
 * ile verilen değer kitin varsayılanını ezer. Tarayıcıda hangisinin kazanacağını CSS dosyasındaki sıra belirlerdi,
 * yazılış sırası değil; bu yüzden sayfanın verdiği renk ya da genişlik sessizce kaybolabiliyordu.
 *
 * Çözücü yalnız tanıdığı grupları ayıklar (genişlik, yükseklik, boşluk, yazı boyu ve rengi, zemin, kenar, köşe,
 * gölge, görünüm…); tanımadığı sınıfa dokunmaz. Varyant (`hover:`, `pointer-fine:`, `[[data-area=admin]_&]:`) ve
 * `!` önemi grubun parçasıdır: `h-11` ile `pointer-fine:h-9` çakışmaz. Bağımlılık eklememek için tailwind-merge'in
 * küçük bir karşılığıdır; testleri `tests/ui-kit.test.ts`.
 */
type ClassArg = string | number | bigint | boolean | null | undefined | Record<string, boolean | undefined | null>;

export function cn(...args: ClassArg[]): string {
  return mergeClasses(cx(...args));
}

/** Birleştirmeden yan yana dizer (eski davranış); sınıfların sırası bilinçli olarak korunacaksa */
export function cx(...args: ClassArg[]): string {
  const out: string[] = [];
  for (const a of args) {
    if (!a) continue;
    if (typeof a === 'string') out.push(a);
    else if (typeof a === 'object') for (const [k, v] of Object.entries(a)) if (v) out.push(k);
  }
  return out.join(' ');
}

/** Boşlukla ayrılmış sınıf dizisinde aynı grubu yazan önceki sınıfları atar (sonraki kazanır) */
export function mergeClasses(classes: string): string {
  const tokens = classes.split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return tokens.join(' ');
  const seen = new Set<string>();
  const kept: string[] = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i];
    const parsed = parse(token);
    if (!parsed) {
      kept.push(token);
      continue;
    }
    const key = `${parsed.prefix}|${parsed.group}`;
    if (seen.has(key)) continue;
    seen.add(key);
    for (const g of parsed.overrides) seen.add(`${parsed.prefix}|${g}`);
    kept.push(token);
  }
  // Aynı sınıf iki kez yazıldıysa ikincisi zaten düştü; sıra korunur
  return kept.reverse().join(' ');
}

interface Parsed {
  /** Varyantlar ve önem işareti: aynı önekli sınıflar çakışır */
  prefix: string;
  group: string;
  overrides: readonly string[];
}

/** `hover:[&>svg]:size-4` → ['hover', '[&>svg]', 'size-4']; köşeli ve normal parantez içindeki iki nokta bölmez */
function splitVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) {
      parts.push(token.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(token.slice(start));
  return parts;
}

function parse(token: string): Parsed | null {
  const parts = splitVariants(token);
  let utility = parts.pop()!;
  let important = false;
  if (utility.startsWith('!')) {
    important = true;
    utility = utility.slice(1);
  } else if (utility.endsWith('!')) {
    important = true;
    utility = utility.slice(0, -1);
  }
  if (utility.startsWith('-')) utility = utility.slice(1);
  const hit = classify(utility);
  if (!hit) return null;
  return { prefix: `${parts.join(':')}${important ? '!' : ''}`, group: hit[0], overrides: hit[1] ?? NONE };
}

const NONE: readonly string[] = [];

const DISPLAY = new Set(['block', 'inline-block', 'inline', 'flex', 'inline-flex', 'grid', 'inline-grid', 'contents', 'hidden', 'table', 'inline-table', 'table-row', 'table-cell', 'table-caption', 'table-column', 'table-row-group', 'table-header-group', 'table-footer-group', 'flow-root', 'list-item']);
const POSITION = new Set(['static', 'fixed', 'absolute', 'relative', 'sticky']);
const VISIBILITY = new Set(['visible', 'invisible', 'collapse']);
const FONT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);
const FONT_WEIGHTS = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black']);
const TEXT_ALIGN = new Set(['left', 'center', 'right', 'justify', 'start', 'end']);
const TEXT_WRAP = new Set(['wrap', 'nowrap', 'balance', 'pretty']);
const BG_POSITION = new Set(['bottom', 'center', 'left', 'left-bottom', 'left-top', 'right', 'right-bottom', 'right-top', 'top', 'bottom-left', 'bottom-right', 'top-left', 'top-right']);
const BG_REPEAT = new Set(['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'repeat-round', 'repeat-space']);
// card ve pop: index.css @theme'deki gölge belirteçleri (boyut, renk değil)
const SHADOW_SIZES = new Set(['2xs', 'xs', 'sm', 'md', 'lg', 'xl', '2xl', 'none', 'inner', 'card', 'pop']);
const TEXT_TRANSFORM = new Set(['uppercase', 'lowercase', 'capitalize', 'normal-case']);
const DECORATION_LINE = new Set(['underline', 'overline', 'line-through', 'no-underline']);

/** Yan ve köşe adları: genel olan, kendisinden sonra gelen tek yanlıyı değil, önceki tek yanlıyı ezer */
const PADDING: Record<string, readonly string[]> = { p: ['px', 'py', 'pt', 'pr', 'pb', 'pl', 'ps', 'pe'], px: ['pl', 'pr', 'ps', 'pe'], py: ['pt', 'pb'], pt: [], pr: [], pb: [], pl: [], ps: [], pe: [] };
const MARGIN: Record<string, readonly string[]> = { m: ['mx', 'my', 'mt', 'mr', 'mb', 'ml', 'ms', 'me'], mx: ['ml', 'mr', 'ms', 'me'], my: ['mt', 'mb'], mt: [], mr: [], mb: [], ml: [], ms: [], me: [] };
const INSET: Record<string, readonly string[]> = { inset: ['inset-x', 'inset-y', 'top', 'right', 'bottom', 'left', 'start', 'end'], 'inset-x': ['left', 'right', 'start', 'end'], 'inset-y': ['top', 'bottom'], top: [], right: [], bottom: [], left: [], start: [], end: [] };
const SIDES = ['t', 'r', 'b', 'l', 'x', 'y', 's', 'e'] as const;
const SIDE_OVERRIDES: Record<string, readonly string[]> = { x: ['l', 'r', 's', 'e'], y: ['t', 'b'] };
const CORNERS = ['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'br', 'bl', 'ss', 'se', 'ee', 'es'] as const;
const CORNER_OVERRIDES: Record<string, readonly string[]> = { t: ['tl', 'tr'], r: ['tr', 'br'], b: ['br', 'bl'], l: ['tl', 'bl'], s: ['ss', 'es'], e: ['se', 'ee'] };

/** `[15px]`, `[1.5rem]`, `[length:…]`, `[clamp(…)]` → uzunluk; `[var(--x)]`, `[#fff]`, `[rgb(…)]` → renk */
function arbitrary(value: string): string | null {
  const m = /^\[(.*)\]$/.exec(value) ?? /^\((.*)\)$/.exec(value);
  return m ? m[1] : null;
}
const isLength = (v: string) => /^(length:|size:)/.test(v) || /^-?[\d.]+(px|rem|em|%|vw|vh|dvh|svh|ch|ex|lh)?$/.test(v) || /^(clamp|calc|min|max)\(/.test(v);
const isNumberish = (v: string) => /^\d+(\.\d+)?$/.test(v) || (arbitrary(v) !== null && isLength(arbitrary(v)!) && !/^(size:)/.test(arbitrary(v)!));

/** Grup ve sonraki sınıfın ezdiği alt gruplar (`p` → `px`, `pt`…) */
type Hit = [group: string, overrides?: readonly string[]];

/** Önce kesin adlar, sonra önekler; bilinmeyen sınıf null (dokunulmaz) */
function classify(u: string): Hit | null {
  if (DISPLAY.has(u)) return ['display'];
  if (POSITION.has(u)) return ['position'];
  if (VISIBILITY.has(u)) return ['visibility'];
  if (TEXT_TRANSFORM.has(u)) return ['text-transform'];
  if (DECORATION_LINE.has(u)) return ['decoration-line'];
  if (u === 'italic' || u === 'not-italic') return ['font-style'];
  if (u === 'grow' || u.startsWith('grow-')) return ['grow'];
  if (u === 'shrink' || u.startsWith('shrink-')) return ['shrink'];

  const dash = u.indexOf('-');
  if (dash < 0) {
    if (u === 'border') return ['border-w', BORDER_W_ALL];
    if (u === 'rounded') return ['rounded', ROUNDED_ALL];
    if (u === 'shadow') return ['shadow'];
    if (u === 'ring') return ['ring-w'];
    if (u === 'outline') return ['outline-w'];
    if (u === 'transition') return ['transition'];
    if (u === 'truncate') return null;
    return null;
  }

  // Boyut
  for (const name of ['min-w', 'min-h', 'max-w', 'max-h']) if (u.startsWith(`${name}-`)) return [name];
  if (u.startsWith('size-')) return ['size', ['w', 'h']];
  if (u.startsWith('w-')) return ['w'];
  if (u.startsWith('h-')) return ['h'];

  // Boşluk ve konum
  const head = u.slice(0, dash);
  if (head in PADDING) return [head, PADDING[head]];
  if (head in MARGIN) return [head, MARGIN[head]];
  if (u.startsWith('inset-x-') || u.startsWith('inset-y-')) return [u.slice(0, 7), INSET[u.slice(0, 7)]];
  if (head in INSET) return [head, INSET[head]];
  if (u.startsWith('gap-x-')) return ['gap-x'];
  if (u.startsWith('gap-y-')) return ['gap-y'];
  if (head === 'gap') return ['gap', ['gap-x', 'gap-y']];
  if (u.startsWith('space-x-')) return ['space-x'];
  if (u.startsWith('space-y-')) return ['space-y'];
  if (head === 'z') return ['z'];
  if (head === 'order') return ['order'];

  // Esnek ve ızgara
  if (head === 'flex') {
    const v = u.slice(5);
    if (v === 'shrink' || v.startsWith('shrink-')) return ['shrink'];
    if (v === 'grow' || v.startsWith('grow-')) return ['grow'];
    if (['row', 'row-reverse', 'col', 'col-reverse'].includes(v)) return ['flex-direction'];
    if (['wrap', 'wrap-reverse', 'nowrap'].includes(v)) return ['flex-wrap'];
    return ['flex'];
  }
  if (head === 'basis') return ['basis'];
  if (u.startsWith('grid-cols-')) return ['grid-cols'];
  if (u.startsWith('grid-rows-')) return ['grid-rows'];
  if (u.startsWith('col-span-') || u === 'col-auto') return ['col-span'];
  if (u.startsWith('row-span-')) return ['row-span'];
  if (u.startsWith('items-')) return ['align-items'];
  if (u.startsWith('justify-items-')) return ['justify-items'];
  if (u.startsWith('justify-self-')) return ['justify-self'];
  if (u.startsWith('justify-')) return ['justify-content'];
  if (u.startsWith('self-')) return ['align-self'];
  if (u.startsWith('place-items-')) return ['place-items'];
  if (u.startsWith('place-content-')) return ['place-content'];
  if (u.startsWith('place-self-')) return ['place-self'];

  // Yazı
  if (head === 'text') return [textGroup(u.slice(5))];
  if (head === 'font') {
    const v = u.slice(5);
    if (FONT_WEIGHTS.has(v) || /^\[\d+\]$/.test(v)) return ['font-weight'];
    if (['sans', 'serif', 'mono'].includes(v)) return ['font-family'];
    return null;
  }
  if (head === 'leading') return ['leading'];
  if (head === 'tracking') return ['tracking'];
  if (head === 'whitespace') return ['whitespace'];
  if (u.startsWith('line-clamp-')) return ['line-clamp'];
  if (u.startsWith('underline-offset-')) return ['underline-offset'];

  // Zemin
  if (head === 'bg') return [bgGroup(u.slice(3))];

  // Kenar ve köşe
  if (head === 'border') return borderGroup(u.slice(7));
  if (head === 'rounded') return roundedGroup(u.slice(8));

  // Gölge, halka, saydamlık
  if (head === 'shadow') {
    const v = u.slice(7);
    if (SHADOW_SIZES.has(v)) return ['shadow'];
    const a = arbitrary(v);
    if (a !== null) return [a.startsWith('color:') ? 'shadow-color' : 'shadow'];
    return ['shadow-color'];
  }
  if (head === 'ring') {
    const v = u.slice(5);
    if (v === 'inset') return ['ring-inset'];
    if (v.startsWith('offset-')) return null;
    if (isNumberish(v)) return ['ring-w'];
    return ['ring-color'];
  }
  if (head === 'outline') {
    const v = u.slice(8);
    if (v.startsWith('offset-')) return ['outline-offset'];
    if (['none', 'hidden', 'dashed', 'dotted', 'double', 'solid'].includes(v)) return ['outline-style'];
    if (isNumberish(v)) return ['outline-w'];
    return ['outline-color'];
  }
  if (head === 'opacity') return ['opacity'];

  // Davranış ve hareket
  if (head === 'cursor') return ['cursor'];
  if (u.startsWith('pointer-events-')) return ['pointer-events'];
  // `select-arrow` (index.css) bir zemin resmidir, kullanıcı seçimi değil
  if (head === 'select' && ['none', 'text', 'all', 'auto'].includes(u.slice(7))) return ['user-select'];
  if (u.startsWith('overflow-x-')) return ['overflow-x'];
  if (u.startsWith('overflow-y-')) return ['overflow-y'];
  if (head === 'overflow') return ['overflow', ['overflow-x', 'overflow-y']];
  if (u.startsWith('overscroll-x-')) return ['overscroll-x'];
  if (u.startsWith('overscroll-y-')) return ['overscroll-y'];
  if (head === 'overscroll') return ['overscroll', ['overscroll-x', 'overscroll-y']];
  if (head === 'transition') return ['transition'];
  if (head === 'duration') return ['duration'];
  if (head === 'ease') return ['ease'];
  if (head === 'delay') return ['delay'];
  if (head === 'animate') return ['animate'];
  if (head === 'aspect') return ['aspect'];
  if (head === 'object' && ['contain', 'cover', 'fill', 'none', 'scale-down'].includes(u.slice(7))) return ['object-fit'];
  if (head === 'accent') return ['accent'];
  if (head === 'caret') return ['caret'];
  return null;
}

function textGroup(v: string): string {
  const bare = v.split('/')[0];
  if (FONT_SIZES.has(bare)) return 'font-size';
  if (TEXT_ALIGN.has(v)) return 'text-align';
  if (TEXT_WRAP.has(v)) return 'text-wrap';
  if (v === 'ellipsis' || v === 'clip') return 'text-overflow';
  const a = arbitrary(v.replace(/\/[\w.[\]%-]+$/, ''));
  if (a !== null) return isLength(a) ? 'font-size' : 'text-color';
  return 'text-color';
}

function bgGroup(v: string): string {
  if (['fixed', 'local', 'scroll'].includes(v)) return 'bg-attachment';
  if (v.startsWith('clip-')) return 'bg-clip';
  if (v.startsWith('origin-')) return 'bg-origin';
  if (v.startsWith('blend-')) return 'bg-blend';
  if (BG_REPEAT.has(v)) return 'bg-repeat';
  if (['auto', 'cover', 'contain'].includes(v)) return 'bg-size';
  if (BG_POSITION.has(v)) return 'bg-position';
  if (v === 'none' || /^(linear|gradient|radial|conic)(-|$)/.test(v)) return 'bg-image';
  const a = arbitrary(v.replace(/\/[\w.[\]%-]+$/, ''));
  if (a !== null) {
    if (/^(length|size):/.test(a)) return 'bg-size';
    if (a.startsWith('position:')) return 'bg-position';
    if (/^(image:|url\(|(repeating-)?(linear|radial|conic)-gradient\()/.test(a)) return 'bg-image';
    if (/(^|_)(top|right|bottom|left|center)(_|$)/.test(a)) return 'bg-position';
    return 'bg-color';
  }
  return 'bg-color';
}

const BORDER_W_ALL = SIDES.map((s) => `border-w-${s}`);
const BORDER_C_ALL = SIDES.map((s) => `border-c-${s}`);

function borderGroup(v: string): Hit {
  if (['solid', 'dashed', 'dotted', 'double', 'hidden', 'none'].includes(v)) return ['border-style'];
  if (v === 'collapse' || v === 'separate') return ['border-collapse'];
  if (v.startsWith('spacing')) return ['border-spacing'];
  if (isNumberish(v)) return ['border-w', BORDER_W_ALL];
  const side = SIDES.find((s) => v === s || v.startsWith(`${s}-`));
  if (side) {
    const rest = v.slice(side.length + 1);
    const over = (SIDE_OVERRIDES[side] ?? []) as readonly string[];
    if (!rest || isNumberish(rest)) return [`border-w-${side}`, over.map((s) => `border-w-${s}`)];
    return [`border-c-${side}`, over.map((s) => `border-c-${s}`)];
  }
  return ['border-c', BORDER_C_ALL];
}

const ROUNDED_ALL = CORNERS.map((c) => `rounded-${c}`);

function roundedGroup(v: string): Hit {
  const corner = [...CORNERS].sort((a, b) => b.length - a.length).find((c) => v === c || v.startsWith(`${c}-`));
  if (corner) return [`rounded-${corner}`, (CORNER_OVERRIDES[corner] ?? []).map((c) => `rounded-${c}`)];
  return ['rounded', ROUNDED_ALL];
}
