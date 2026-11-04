/**
 * Baş harf avatarının harf rengi (misc.tsx `Avatar`). Saf modül: testler (tests/ui-kit.test.ts) kitin bileşen
 * dosyasını içe almadan sınar.
 */

const NIGHT_INK = '#211c18';

/** WCAG 2.2 göreli parlaklık, #rrggbb */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const NIGHT_LUMINANCE = luminance(NIGHT_INK);

/**
 * Kişi renginin üstündeki baş harfler: beyaz ya da gece mürekkebi (#211c18), hangisi o zeminde daha okunursa.
 * Personel renklerinin açıklarında (#a87c2e, #5e8f45) beyaz 12 px harf 3.8:1'de kalır, mürekkep 4.4:1 okunur;
 * koyularda (#3f6b8a, #1e4031) beyaz. #rrggbb dışındaki değerde beyaz
 */
export function initialsInk(color: string): string {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return '#fff';
  const l = luminance(color);
  return 1.05 / (l + 0.05) >= (l + 0.05) / (NIGHT_LUMINANCE + 0.05) ? '#fff' : NIGHT_INK;
}
