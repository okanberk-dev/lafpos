import { toast } from './toast';

/**
 * Metni panoya alır; alınamazsa hata bildirimi gösterir ve false döner (test: tests/pano.test.ts). Pano API'si yalnız
 * güvenli bağlamda var (https ya da localhost): kafe ağında telefon ya da tablet kasaya http://192.168.x.x ile bağlanır,
 * orada `navigator.clipboard` yok. Eskiden "WhatsApp için kopyala" o zaman sessizce hata verip hiçbir bildirim
 * göstermiyordu (inceleme, 23 Kas 2026). Pano API'si yoksa ya da izin vermezse ekran dışındaki salt okunur bir metin
 * alanı seçilip eski kopyalama komutu denenir (dokunuşun içinde çalışır; iOS dahil)
 */
export async function copyText(text: string, failMessage = 'Panoya kopyalanamadı'): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // İzin verilmedi ya da sayfa odakta değil: eski yol denenir
  }
  if (legacyCopy(text)) return true;
  toast.err(failMessage);
  return false;
}

/** Eski yol: ekran dışında salt okunur metin alanı seçilir, `document.execCommand('copy')` (odak sonra geri verilir) */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const area = document.createElement('textarea');
  area.value = text;
  // Salt okunur: telefonda klavye açılmaz. 16 px: iOS odaklanınca yakınlaştırmaz. Sabit konum: sayfa kaymaz
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '-9999px';
  area.style.fontSize = '16px';
  const before = document.activeElement as HTMLElement | null;
  document.body.appendChild(area);
  try {
    area.select();
    area.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    before?.focus?.();
  }
}
