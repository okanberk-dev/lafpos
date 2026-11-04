import type { Permission } from './permissions';
import type { Role } from './permissions';
import type { CompKind, CompPersonKind, OdenmezPersonDTO, PublicSettings } from './types';

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
  odenmez: 'Personel yemeği, patron hesabı; kayıtlı kişinin adına, ciro dışı',
  zayi: 'Döküldü, yanlış hazırlandı, bozuk; ciro dışı, zayi raporuna girer',
};

export const COMP_CONFIRM_LABEL: Record<CompKind, string> = { ikram: 'İkram et ve kapat', odenmez: 'Ödenmez kapat', zayi: 'Zayi kapat' };

export const COMP_DONE_TOAST: Record<CompKind, string> = { ikram: 'Adisyon ikram edildi', odenmez: 'Adisyon ödenmez kapandı', zayi: 'Adisyon zayi kapandı' };

/** Gerekçe penceresinin alt satırı: tutar ve nereye düştüğü */
export function compCloseSubtitle(kind: CompKind, total: string): string {
  if (kind === 'ikram') return `${total} ücret alınmadan kapanır; ikram raporuna ve patron paneline düşer`;
  if (kind === 'odenmez') return `${total} ciro dışı kapanır; seçilen kişinin adına ödenmez olarak raporda ve Z'de ayrı görünür`;
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

/**
 * Ödenmez penceresinin neden önerisi: patron seçilince "Patron hesabı", öteki personelde "Personel yemeği"; müşteride
 * öneri yok. Kasiyerin yazdığı neden ezilmez (öneri yalnız boş ya da önceki öneri duruyorsa yazılır)
 */
export function odenmezSuggestion(kind: CompPersonKind, role: Role | null): string | null {
  if (kind !== 'user') return null;
  return role === 'patron' ? 'Patron hesabı' : 'Personel yemeği';
}

/** Telefonun son dört hanesi ("0530 000 11 22" → "1122"); dört haneden kısa ya da boşsa null */
export function phoneTail(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : null;
}

/**
 * Ödenmez kalemlerinin kişi bazında toplamı (en büyük tutar üstte): rapor, Z ve CSV aynı kuralla. `showStaff`
 * personelin adını gösterip göstermeyeceğini söyler (personel tutarı, maliyet yetkisi): gösterilmeyen personel tek
 * "Personel" satırında toplanır. Kişisi olmayan eski ödenmez kayıtları "Kişi seçilmemiş" satırına düşer.
 */
export function odenmezByPerson(
  items: { qty: number; unitPrice: number; compPersonKind: CompPersonKind | null; compPersonId: string | null; compPersonName: string | null }[],
  showStaff: (userId: string) => boolean = () => true,
): OdenmezPersonDTO[] {
  const rows = new Map<string, OdenmezPersonDTO>();
  for (const i of items) {
    const known = !!i.compPersonKind && !!i.compPersonId;
    const hidden = known && i.compPersonKind === 'user' && !showStaff(i.compPersonId!);
    const key = !known ? 'yok' : hidden ? 'user:gizli' : `${i.compPersonKind}:${i.compPersonId}`;
    const r =
      rows.get(key) ??
      (!known
        ? { kind: null, id: null, name: 'Kişi seçilmemiş', qty: 0, amount: 0 }
        : { kind: i.compPersonKind, id: hidden ? null : i.compPersonId, name: hidden ? 'Personel' : (i.compPersonName ?? 'Bilinmiyor'), qty: 0, amount: 0 });
    r.qty += i.qty;
    r.amount += i.qty * i.unitPrice;
    rows.set(key, r);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'tr'));
}

/** Kayıtlı Z'nin kişi dökümünü görene göre süzer: gösterilmeyen personel satırları tek "Personel" satırında toplanır */
export function maskOdenmezPeople(rows: readonly OdenmezPersonDTO[], showStaff: (userId: string) => boolean): OdenmezPersonDTO[] {
  const out = new Map<string, OdenmezPersonDTO>();
  for (const r of rows) {
    const hidden = r.kind === 'user' && !!r.id && !showStaff(r.id);
    const key = hidden ? 'user:gizli' : `${r.kind ?? 'yok'}:${r.id ?? r.name}`;
    const cur = out.get(key) ?? (hidden ? { kind: 'user' as const, id: null, name: 'Personel', qty: 0, amount: 0 } : { ...r, qty: 0, amount: 0 });
    cur.qty += r.qty;
    cur.amount += r.amount;
    out.set(key, cur);
  }
  return [...out.values()].sort((x, y) => y.amount - x.amount || x.name.localeCompare(y.name, 'tr'));
}
