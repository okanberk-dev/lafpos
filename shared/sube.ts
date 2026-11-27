/**
 * Kasanın şubesi (çok şubeli kasa, sahibin kararı 26–27 Kasım 2026): her fiziksel şubenin kendi AsilPOS kasası olabilir;
 * panel (ladmin) şubeyi kasanın kendi imza anahtarından tanır. Kasa şubesini ladmin'in kurulum bağlantısından alır
 * (server/sync/kurulum-kodu.ts); yeni kurulum şubesiz açılır, şube belli olana dek şubeye bağlı senkron bekler.
 * Ekran ve sunucu ortak metinleri burada. docs/03-ENTEGRASYON.md §4c
 */

/** Şube seçilmeden bekleyen işlerin metni (Entegrasyon, Bağlantı bilgileri, Ayarlar; hata kodu `no_branch`) */
export const SUBE_YOK_METNI =
  "Şube seçilmedi: gün sonu, devir, personel listesi, site ve platform anahtarları şube belli olunca başlar. Kasa şubesini ladmin'in kurulum bağlantısından kendiliğinden alır; elle kurulan kasada patron Yönetim › Ayarlar ve yedek › Şube kimliği'ne yazar";

/** Şube kimliğinden okunur ad (kurulumdan ad gelmediyse): 'marina' → 'Marina', 'tuzla-2' → 'Tuzla 2' */
export function subeAdiOf(id: string | null | undefined): string | null {
  if (!id) return null;
  const words = id.split('-').filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => w.charAt(0).toLocaleUpperCase('tr-TR') + w.slice(1)).join(' ');
}

/**
 * Bildirim ve gün sonu metninin başlığı: işletme adı ve şube ("L'Affogato Marina"). İşletme adı şubeyi zaten
 * içeriyorsa (patron "L'Affogato Marina" yazdıysa) ya da şube bilinmiyorsa işletme adı olduğu gibi; ikisi de boşsa boş
 */
export function isletmeVeSube(isletme: string, subeAdi: string | null | undefined): string {
  const name = isletme.trim();
  const branch = subeAdi?.trim() ?? '';
  if (!branch) return name;
  if (!name) return branch;
  return name.toLocaleLowerCase('tr-TR').includes(branch.toLocaleLowerCase('tr-TR')) ? name : `${name} ${branch}`;
}
