/**
 * Fiş yazıcısı (Windows kurulumu, kablolu/USB ya da ağdaki Windows yazıcısı). Kasa ekranı Chrome'da `--kiosk-printing`
 * ile açılır: fiş, Z ve X önizlemesiz Windows'un varsayılan yazıcısından çıkar. Kasa kısayolu (AsilPOS-Kasa.bat) Chrome'u
 * açmadan önce `app\kasa-yazici.ps1`'i oturumdaki kullanıcı olarak çalıştırır: bilgisayardaki yazıcıları bu sunucuya
 * bildirir (`POST /api/kasa/yazicilar`, yalnız bu bilgisayardan) ve yanıttaki yazıcıyı o kullanıcının varsayılan yazıcısı
 * yapar. Yazıcı yönetimden seçilir (Yönetim › Ayarlar ve yedek › Fiş yazıcısı); seçilmediyse tek fiş yazıcısı
 * kendiliğinden seçilir (`pickReceiptPrinter`). Ayrıntı: docs/05-KASA-BILGISAYARI.md §3.
 */

/** Kasa betiğinin son bildirdiği yazıcılar (`sync_state`) */
export const PRINTERS_KEY = 'kasa.yazicilar';

export interface WinPrinter {
  name: string;
  port: string | null;
  driver: string | null;
  /** Kullanıcının şu anki varsayılan yazıcısı */
  isDefault: boolean;
  offline: boolean;
}

/** Kâğıda basmayan Windows yazıcıları (PDF, XPS, OneNote, faks...): fiş yazıcısı sayılmaz */
const VIRTUAL = /pdf|xps|onenote|fax|faks|send to|document writer|anydesk|teamviewer|microsoft print/i;
/** Fiş yazıcısı olduğu adından ya da sürücüsünden anlaşılan (80 mm termal) */
const RECEIPT = /\bpos\b|pos-?\d|receipt|thermal|termal|\b80\s?mm\b|xp-?\d|tm-?[a-z]?\d|rongta|xprinter|epson tm|star tsp|bixolon|sewoo|hprt|gprinter|zjiang|sunmi|sam4s|citizen ct/i;

export const isVirtualPrinter = (p: Pick<WinPrinter, 'name' | 'driver' | 'port'>) => VIRTUAL.test(`${p.name} ${p.driver ?? ''} ${p.port ?? ''}`);

/**
 * Kullanılacak fiş yazıcısı (saf): seçilen bilgisayarda varsa o; değilse gerçek (sanal olmayan) tek yazıcı ya da adından
 * fiş yazıcısı olduğu anlaşılan tek yazıcı. Kararsızsa null (yönetimden seçilir)
 */
export function pickReceiptPrinter(printers: WinPrinter[], chosen: string | null): { name: string | null; auto: boolean } {
  if (chosen && printers.some((p) => p.name === chosen)) return { name: chosen, auto: false };
  const real = printers.filter((p) => !isVirtualPrinter(p));
  if (real.length === 1) return { name: real[0]!.name, auto: true };
  const receipt = real.filter((p) => RECEIPT.test(`${p.name} ${p.driver ?? ''}`));
  if (receipt.length === 1) return { name: receipt[0]!.name, auto: true };
  return { name: null, auto: false };
}

/** Kasa betiğinin gönderdiği listeyi okur: Get-CimInstance Win32_Printer alanları (tek yazıcıda nesne, çokta dizi) */
export function parsePrinters(input: unknown): WinPrinter[] {
  const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : [];
  const out: WinPrinter[] = [];
  for (const raw of list.slice(0, 60)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.Name === 'string' ? r.Name.trim().slice(0, 200) : typeof r.name === 'string' ? r.name.trim().slice(0, 200) : '';
    if (!name || out.some((p) => p.name === name)) continue;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null);
    out.push({
      name,
      port: str(r.PortName ?? r.port),
      driver: str(r.DriverName ?? r.driver),
      isDefault: r.Default === true || r.isDefault === true,
      offline: r.WorkOffline === true || r.offline === true,
    });
  }
  return out;
}
