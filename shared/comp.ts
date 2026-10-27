import type { Permission } from './permissions';
import type { CompKind, PublicSettings } from './types';

/**
 * Ciro dışı kapanışın türleri (`CompKind`): müşteriye ikram, ödenmez (personel yemeği, patron hesabı) ve zayi (döküldü,
 * yanlış hazırlandı, bozuk). Üçü de kalemi ücretsiz yapar ve cirodan düşer; raporda, Z'de ve lafmaliyet'e giden ikram
 * satırında ayrı görünür. Sıra ödeme ekranındaki ve İşlemler menüsündeki düğme sırasıdır.
 */
export const COMP_KINDS: readonly CompKind[] = ['ikram', 'odenmez', 'zayi'];

export const COMP_LABEL: Record<CompKind, string> = { ikram: 'İkram', odenmez: 'Ödenmez', zayi: 'Zayi' };

/** Adisyonun tamamını kapatan düğme (İşlemler menüsü, ödeme ekranı) */
export const COMP_CLOSE_LABEL: Record<CompKind, string> = { ikram: 'Hepsini ikram et', odenmez: 'Ödenmez kapat', zayi: 'Zayi kapat' };

export const COMP_HINT: Record<CompKind, string> = {
  ikram: 'Müşteriye ikram; ücret alınmaz, ikram raporuna girer',
  odenmez: 'Personel yemeği, patron hesabı; ciro dışı',
  zayi: 'Döküldü, yanlış hazırlandı, bozuk; ciro dışı, zayi raporuna girer',
};

export const COMP_CONFIRM_LABEL: Record<CompKind, string> = { ikram: 'İkram et ve kapat', odenmez: 'Ödenmez kapat', zayi: 'Zayi kapat' };

export const COMP_DONE_TOAST: Record<CompKind, string> = { ikram: 'Adisyon ikram edildi', odenmez: 'Adisyon ödenmez kapandı', zayi: 'Adisyon zayi kapandı' };

/** Gerekçe penceresinin alt satırı: tutar ve nereye düştüğü */
export function compCloseSubtitle(kind: CompKind, total: string): string {
  if (kind === 'ikram') return `${total} ücret alınmadan kapanır; ikram raporuna ve patron paneline düşer`;
  if (kind === 'odenmez') return `${total} ciro dışı kapanır; ödenmez olarak raporda ve Z'de ayrı görünür`;
  return `${total} ciro dışı kapanır; zayi olarak raporda, Z'de ve lafmaliyet'e giden listede ayrı görünür`;
}

/** İkram kendi yetkisiyle; ödenmez ve zayi aynı, daha dar yetkiyle (`siparis.odenmez`) */
export function compPermission(kind: CompKind): Permission {
  return kind === 'ikram' ? 'siparis.ikram' : 'siparis.odenmez';
}

/** Ayarlardaki gerekçe listesi (Yönetim › Ayarlar › Nedenler) */
export function compReasonsOf(s: Pick<PublicSettings, 'compReasons' | 'odenmezReasons' | 'zayiReasons'>, kind: CompKind): string[] {
  return kind === 'ikram' ? s.compReasons : kind === 'odenmez' ? s.odenmezReasons : s.zayiReasons;
}

/**
 * lafmaliyet gün paketinin `ikram[]` satırındaki gerekçe: sözleşmede tür alanı yok (docs/03-ENTEGRASYON.md §4), ödenmez
 * ve zayi gerekçenin başına yazılır ("Ödenmez: Personel yemeği", "Zayi: Döküldü"); ikram olduğu gibi gider
 */
export function compReasonText(kind: CompKind | null, reason: string | null): string {
  const r = reason ?? '';
  return kind === 'odenmez' ? `Ödenmez: ${r}` : kind === 'zayi' ? `Zayi: ${r}` : r;
}
