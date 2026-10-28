/**
 * Tuş takımının saf kuralları (Numpad, useNumpadKeys, ödeme penceresi): tuşun metne uygulanması ve fiziksel klavye
 * tuşunun tuş takımı tuşuna çevrilmesi. DOM'a dokunmaz; testler doğrudan çağırır.
 */

/**
 * Numpad tuşunu metin değerine uygular (tutar alanları için virgül ve iki hane sınırı). Ana sıradaki "." (`key` ".")
 * shared/money.ts parseTL'nin kuralıyla okunur: ardından tam üç hane gelirse binlik ayırıcıdır ve düşer ("2.000" →
 * "2000"), daha azında ondalıktır ve metinde kalır ("45.90" → parseTL 4590 kuruş). Metindeki "." bu yüzden hep
 * ondalık adayıdır; gösterim (groupTyped) onu virgül yazar.
 */
export function applyNumpadKey(value: string, key: string, opts: { decimal?: boolean; maxLength?: number } = {}): string {
  const max = opts.maxLength ?? 9;
  if (key === 'back') return value.slice(0, -1);
  if (key === 'clear') return '';
  if (key === ',' || key === '.') {
    if (!opts.decimal || value.includes(',') || value.includes('.')) return value;
    // "0." ve ".5" binlik olamaz: doğrudan ondalık
    if (key === ',' || value === '' || value === '0') return (value || '0') + ',';
    return value + '.';
  }
  let next = value === '0' && key !== '00' ? key : value + key;
  if (opts.decimal && next.includes(',')) {
    const [, frac] = next.split(',');
    if (frac.length > 2) return value;
  }
  if (opts.decimal && next.includes('.')) {
    const [, frac] = next.split('.');
    if (frac.length > 3) return value;
    if (frac.length === 3) next = next.replace('.', '');
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

export type NumpadKeyAction = { type: 'key'; key: string } | { type: 'enter' } | null;

/**
 * Fiziksel klavye tuşunun tuş takımındaki karşılığı. 0-9 → rakam; "," ve sayısal tuş takımının ondalık tuşu → ","
 * (`decimal`); ana sıradaki "." → "." (applyNumpadKey parseTL kuralıyla binlik ya da ondalık okur); Backspace → "back",
 * Delete → "clear" (NumLock kapalıyken sayısal tuş takımının Del'i de: kodu NumpadDecimal, tuşu Delete), Enter →
 * `enter`. Karşılığı olmayan tuş `null` (tarayıcıya bırakılır).
 */
export function numpadKeyOf(e: { key: string; code?: string }, decimal?: boolean): NumpadKeyAction {
  if (/^\d$/.test(e.key)) return { type: 'key', key: e.key };
  if (e.key === 'Backspace') return { type: 'key', key: 'back' };
  if (e.key === 'Delete') return { type: 'key', key: 'clear' };
  if (e.key === 'Enter') return { type: 'enter' };
  if (e.key === ',' || e.key === '.') {
    if (!decimal) return null;
    return { type: 'key', key: e.key === ',' || e.code === 'NumpadDecimal' ? ',' : '.' };
  }
  return null;
}

/**
 * Tuş takımıyla yazılmakta olan tutar (ödeme, açılış nakdi, kasa hareketi). Değer henüz kuruş değil, kasiyerin yazdığı
 * metindir ("1250,5"); bu yüzden tl() yerine yalnız gösterim: tam kısım binlik noktayla ("1.250,5"), ₺ başta, sönük ve
 * küçük (uygulamanın geri kalanındaki "₺1.250" sırası). Boşsa "0". Metinde kalan ana sıra noktası ondalık adayıdır
 * (applyNumpadKey üç haneyi bulunca onu düşürür), bu yüzden virgül yazılır: "45.9" → "45,9".
 */
export function groupTyped(text: string): string {
  if (!text) return '0';
  const [int, frac] = text.replace('.', ',').split(',');
  const grouped = (int || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}
