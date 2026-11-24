/**
 * Şifre gücü (PasswordInput.tsx'in güç çubuğu; rare-ui password-input'tan). React ve tarayıcı içermez; testler
 * (tests/zil-bildirim-sifre.test.ts) doğrudan bunu okur. Yalnız yeni şifre alanında gösterilir, girişte değil.
 */

export const STRENGTH_LABELS = ['Zayıf', 'Orta', 'İyi', 'Güçlü'] as const;
export type StrengthLevel = 0 | 1 | 2 | 3 | 4;

/**
 * 0 boş, 1 Zayıf … 4 Güçlü. Ölçüt: uzunluk (8 ve 12), büyük ve küçük harf birlikte, rakam, işaret; Türkçe harfler de
 * harf sayılır (ğ, Ş, İ). `min` karakterden kısa şifre ne içerirse içersin Zayıf: "Ab1!" güçlü görünmesin
 */
export function passwordStrength(value: string, min = 8): StrengthLevel {
  if (!value) return 0;
  if ([...value].length < min) return 1;
  const score = [value.length >= 8, value.length >= 12, /\p{Ll}/u.test(value) && /\p{Lu}/u.test(value), /\p{N}/u.test(value), /[^\p{L}\p{N}]/u.test(value)].filter(Boolean).length;
  return Math.min(Math.max(score, 1), 4) as StrengthLevel;
}
