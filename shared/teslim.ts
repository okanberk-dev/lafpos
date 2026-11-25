/**
 * Kasadan teslim: paranın kime verildiği (sahibin isteği, 25 Kasım 2026). Teslim yazılırken alıcı seçilir (patron ya da
 * müdür hesabı, "Banka" ya da elle yazılan ad); gün sonu raporu, fiş ve WhatsApp metni teslimi alıcıya göre döker,
 * lafmaliyet'e satırın `recipient`'ı gider (docs/03-ENTEGRASYON.md §4.7). Saf işlevler: sunucu, ekran ve testler aynı.
 */

/** Alıcısı yazılmadan kaydedilmiş eski teslimin adı (bu özellikten önce) */
export const UNSPECIFIED_RECIPIENT = 'Belirtilmemiş';
/** Bankaya yatırılan nakit için hazır alıcı adı */
export const BANK_RECIPIENT = 'Banka';
/** Elle yazılan alıcı adının en uzun hâli */
export const RECIPIENT_MAX = 80;

/** Alıcıya göre teslim toplamı (kuruş). `userId`: alıcı kullanıcıysa kimliği, değilse null */
export interface HandoverRecipient {
  userId: string | null;
  name: string;
  count: number;
  amount: number;
}

/** Elle yazılan alıcı adı: baştaki ve sondaki boşluk atılır, aradaki boşluklar teke iner, en çok 80 karakter */
export function cleanRecipientName(name: string | null | undefined): string {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, RECIPIENT_MAX);
}

/**
 * Teslimlerin alıcıya göre dökümü: aynı kullanıcı (kimliğiyle) ya da aynı ad (büyük-küçük harf farkı gözetmeden) tek
 * satır, alıcısız eski teslim "Belirtilmemiş". Tutara göre azalan, eşitlikte ada göre. Σ amount = teslim toplamı.
 */
export function handoverByRecipient(moves: readonly { kind: string; amount: number; recipientUserId?: string | null; recipientName?: string | null }[]): HandoverRecipient[] {
  const rows = new Map<string, HandoverRecipient>();
  for (const m of moves) {
    if (m.kind !== 'teslim') continue;
    const name = cleanRecipientName(m.recipientName);
    const userId = m.recipientUserId ?? null;
    const key = userId ? `u:${userId}` : name ? `n:${name.toLocaleLowerCase('tr')}` : '';
    const row = rows.get(key) ?? { userId, name: name || UNSPECIFIED_RECIPIENT, count: 0, amount: 0 };
    row.count += 1;
    row.amount += m.amount;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name, 'tr'));
}
