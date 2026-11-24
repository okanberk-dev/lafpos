/**
 * lafmaliyet bağlantısının ekran metinleri (Yönetim › Entegrasyon, Raporlar, patron paneli). Saf: sunucunun
 * `lafmaliyetStatus` ve rapor yanıtlarını okur (server/sync/lafmaliyet.ts), docs/03-ENTEGRASYON.md §4.
 */

import { fmtDateLong } from '@shared/time';

/** lafmaliyet'in gün sonu yanıtından saklananlar (sunucudaki `DayAnswer`); eski lafmaliyet alanları göndermez */
export interface DayAnswer {
  date: string;
  at: number;
  lines?: number;
  matched?: number;
  unmatched?: string[];
  counted?: boolean;
  switchDay?: string | null;
  /** Ertesi günün beklenen açılışı (TL; kasa zinciri); kasa rakamlarını görmeyene gitmez */
  nextOpening?: { amount: number; source: 'kasa_raporu' | 'lafpos' } | null;
  /** Gövdenin `workedStaffRefs`'inin lafmaliyet'teki karşılığı (§4.8); yalnız personel ya da bağlantı yöneticisine */
  staff?: { counted: string[]; unknown: string[]; otherBranch: string[] };
}

/** lafmaliyet'in saymadığı personel kimlikleri, LafPOS'taki adıyla (`lafmaliyetStatus` `staffIssues`; ad bu kasada) */
export interface StaffIssues {
  unknown: { ref: string; name: string | null }[];
  otherBranch: { ref: string; name: string | null }[];
}

/**
 * Entegrasyon'da personel satırı: lafmaliyet o gün kaç bağlı kişiyi saydı, hangilerini bulamadı (ladmin'de silinmiş
 * kayıt: Yönetim › Personel'de yeniden bağlanır) ve hangileri başka şubenin kaydı (ladmin Maaşlar'da şubesi
 * düzeltilir). `null`: gün personelsiz gitti ya da lafmaliyet bu alanı bilmiyor
 */
export function staffAnswerText(a: DayAnswer, issues: StaffIssues | null | undefined): { tone: 'ok' | 'warn'; text: string; detail: string | null } | null {
  if (!a.staff) return null;
  const who = (list: { ref: string; name: string | null }[]) => list.map((p) => (p.name ? `${p.name} (${p.ref})` : p.ref)).join(', ');
  const parts = [
    issues?.unknown.length ? `lafmaliyet'te bulunamadı: ${who(issues.unknown)}` : null,
    issues?.otherBranch.length ? `başka şubenin kaydı: ${who(issues.otherBranch)}` : null,
  ].filter((x): x is string => !!x);
  const day = dayLabel(a.date);
  if (!parts.length) return { tone: 'ok', text: `${day}: lafmaliyet ${a.staff.counted.length} personelin gününü saydı`, detail: null };
  return {
    tone: 'warn',
    text: `${day}: lafmaliyet ${a.staff.counted.length} personelin gününü saydı; ${parts.join('; ')}`,
    detail: "Bulunamayan kişi Yönetim › Personel'de yeniden bağlanır; başka şubenin kaydı ladmin Maaşlar'da şubesi düzeltilince sayılır",
  };
}

/**
 * Açılış önerisi (`GET /api/cash/day` `opening`; kasa zinciri, docs/03-ENTEGRASYON.md §4.6): `source` beklenenin
 * kaynağı (lafmaliyet'in devri ya da kasanın sayımı); lafmaliyet'inse `ladminSource` onun kaynağı (`kasa_raporu`:
 * panelin Kasa raporu; `lafpos`: rapor yokken geri söylenen sayım)
 */
export interface OpeningSuggestion {
  suggested: number;
  source: 'lafmaliyet' | 'lafpos';
  ladminSource?: 'kasa_raporu' | 'lafpos';
  fromDate: string;
}

/**
 * "Günü aç" kartında beklenen açılışın kaynağı. Kasa raporu yalnız lafmaliyet devri gerçekten Kasa raporundan
 * hesapladıysa anılır; rapor yokken lafmaliyet kasanın sayımını geri söyler (gün sonu sayımı)
 */
export function openingSourceText(o: Pick<OpeningSuggestion, 'source' | 'ladminSource' | 'fromDate'>): string {
  const day = fmtDateLong(o.fromDate);
  if (o.source === 'lafpos') return `${day} gün sonu sayımı`;
  if (o.ladminSource === 'kasa_raporu') return `${day} devri, lafmaliyet kasa raporundan`;
  if (o.ladminSource === 'lafpos') return `${day} gün sonu sayımı, lafmaliyet'ten`;
  return `${day} devri, lafmaliyet'ten`;
}

const dayFmt = new Intl.DateTimeFormat('tr-TR', { timeZone: 'UTC', day: 'numeric', month: 'long' });
/** "2026-11-10" → "10 Kasım" */
export const dayLabel = (date: string) => dayFmt.format(new Date(`${date}T12:00:00Z`));

/**
 * Son gönderilen günün lafmaliyet'teki durumu. `idle`: hata değil, sakin bilgi (geçiş gününden önceki günler deneme
 * olarak saklanır, hesaplara girmez; sahibin kararı). Geçiş gününün sahibi lafmaliyet'tir, LafPOS yalnız yanıtı okur.
 */
export function answerText(a: DayAnswer): { tone: 'ok' | 'idle'; text: string } {
  const day = dayLabel(a.date);
  if (a.counted === true) {
    return { tone: 'ok', text: a.switchDay ? `${day} lafmaliyet'te sayılıyor (geçiş günü ${dayLabel(a.switchDay)})` : `${day} lafmaliyet'te sayılıyor` };
  }
  if (a.counted === false) {
    return {
      tone: 'idle',
      text: a.switchDay
        ? `lafmaliyet ${day} gününü saymıyor (geçiş günü ${dayLabel(a.switchDay)}): deneme olarak saklandı, hesaplara girmez`
        : `lafmaliyet ${day} gününü saymıyor: geçiş günü seçilmedi, kasa ModPOS. Gün deneme olarak saklandı, hesaplara girmez`,
    };
  }
  return { tone: 'idle', text: `${day} lafmaliyet'e gönderildi (lafmaliyet geçiş gününü bildirmedi)` };
}

/** "Gönder" sonrası kısa bildirim */
export function pushToast(a: DayAnswer | null | undefined): string {
  if (a?.counted === false) return `Gün lafmaliyet'e gönderildi; deneme olarak saklandı (${a.switchDay ? `geçiş günü ${dayLabel(a.switchDay)}` : 'geçiş günü seçilmedi'})`;
  return "Gün lafmaliyet'e gönderildi";
}

/**
 * lafmaliyet'te ürüne bağlanamayan satır sayısı. lafmaliyet en çok 50 ad gönderir; gerçek sayı `lines - matched`
 * (`matched` ürüne ya da hizmete bağlanan satırlar). İkisi yoksa (eski lafmaliyet) gelen adların sayısı
 */
export function unmatchedCount(a: DayAnswer): number {
  if (typeof a.lines === 'number' && typeof a.matched === 'number') return Math.max(0, a.lines - a.matched);
  return a.unmatched?.length ?? 0;
}

/** lafmaliyet'te ürüne bağlanamayan adlar: ilk birkaçı ve kalan sayı (`total`: gerçek sayı, gelen adlardan çok olabilir) */
export function unmatchedText(names: string[], total = names.length, shown = 5): string {
  const head = names.slice(0, shown).join(', ');
  const rest = Math.max(total, names.length) - Math.min(shown, names.length);
  return rest > 0 ? (head ? `${head} ve ${rest} ad daha` : `${rest} ad`) : head;
}

/** Maliyetler bu kadar günden eskiyse raporlarda uyarı (kendiliğinden yenileme her gün sonunda) */
export const COSTS_STALE_DAYS = 7;

/** "Maliyetler 9 gün önce alındı": yalnız maliyet yetkisi olanın ekranında; sunucu `costsAt`'i başkasına göndermez */
export function staleCostsText(costsAt: number | null | undefined, now = Date.now()): string | null {
  if (!costsAt) return null;
  const days = Math.floor((now - costsAt) / 86_400_000);
  return days > COSTS_STALE_DAYS ? `Maliyetler ${days} gün önce alındı; kâr eski reçete maliyetiyle hesaplanıyor` : null;
}
