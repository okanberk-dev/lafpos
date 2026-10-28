/**
 * Tuş takımının saf kuralları (Numpad, useNumpadKeys, ödeme penceresi): tuşun metne uygulanması ve fiziksel klavye
 * tuşunun tuş takımı tuşuna çevrilmesi. DOM'a dokunmaz; testler doğrudan çağırır.
 */

/** Numpad tuşunu metin değerine uygular (tutar alanları için virgül ve iki hane sınırı). */
export function applyNumpadKey(value: string, key: string, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  const max = opts.maxLength ?? 9;
  if (key === 'back') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (key === ',') {
    if (!opts.decimal || value.includes(',')) return value;
    return (value || '0') + ',';
  }
  const next = value === '0' && key !== '00' ? key : value + key;
  if (opts.decimal && next.includes(',')) {
    const [, frac] = next.split(',');
    if (frac.length > 2) return value;
  }
  return next.length > max ? value : next;
}

/**
 * Önceden doldurulmuş değer (ödeme penceresinde kalan tutar) seçili metin gibi davranır: ilk rakam, "00" ya da ","
 * değerin yerine geçer; "back" ve "clear" değeri olduğu gibi düzenler. Dönüşte `replace` bayrağı her durumda kalkar.
 */
export function typeOverPrefill(value: string, key: string, replace: boolean, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  const fresh = replace && key !== 'back' && key !== 'clear';
  return applyNumpadKey(fresh ? '' : value, key, opts);
}

export type NumpadKeyAction = { type: 'key'; key: string } | { type: 'enter' } | { type: 'ignore' } | null;

/**
 * Fiziksel klavye tuşunun tuş takımındaki karşılığı. 0-9 → rakam; "," ve sayısal tuş takımının ondalık tuşu → ","
 * (`decimal`); ana sıradaki "." Türkçe yazımda binlik ayırıcıdır ("2.000"), ondalık sayılmaz, yutulur (`ignore`);
 * Backspace → "back", Delete → "clear", Enter → `enter`. Karşılığı olmayan tuş `null` (tarayıcıya bırakılır).
 */
export function numpadKeyOf(e: { key: string; code?: string }, decimal?: boolean): NumpadKeyAction {
  if (/^\d$/.test(e.key)) return { type: 'key', key: e.key };
  if (e.key === ',' || e.key === '.' || e.code === 'NumpadDecimal') {
    if (!decimal) return null;
    return e.key === ',' || e.code === 'NumpadDecimal' ? { type: 'key', key: ',' } : { type: 'ignore' };
  }
  if (e.key === 'Backspace') return { type: 'key', key: 'back' };
  if (e.key === 'Delete') return { type: 'key', key: 'clear' };
  if (e.key === 'Enter') return { type: 'enter' };
  return null;
}
