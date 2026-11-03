import { addDays, DAY_ROLLOVER_HOUR, isCalendarDate, istanbulParts, MAX_SHIFT_MS } from '@shared/time';
import type { TimeEntryDTO } from '@shared/types';

/**
 * Yönetim › Mesai çizelgesindeki düzeltme ve elle kayıt taslağı (saf: testi tests/mesai-taslak.test.ts). Tarih iş
 * günüdür (05:00 kuralı, tablodaki "Gün" sütunuyla aynı): 00:00–04:59 arası giriş o iş gününün gecesidir.
 */
export interface MesaiDraft {
  /** Düzeltilen kayıt (elle kayıtta yok): yalnız değişen alanlar gönderilir */
  entry?: TimeEntryDTO;
  userId: string;
  /** İş günü, "YYYY-MM-DD" */
  date: string;
  inTime: string;
  outTime: string;
  note: string;
}

export type MesaiPatch = { clockIn?: number; clockOut?: number | null; note?: string | null };

/** İstanbul saatiyle "HH:MM" */
export const hm = (ms: number) => {
  const p = istanbulParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
};

/** İstanbul saatiyle "YYYY-MM-DD" ve "HH:MM" → an (UTC+3, yaz saati yok) */
export const toMs = (date: string, time: string) => Date.parse(`${date}T${time}:00+03:00`);

const ROLLOVER = `${String(DAY_ROLLOVER_HOUR).padStart(2, '0')}:00`;

/** Kaydın taslağı: iş günü kaydın kendi iş günü, saatler dakikasıyla */
export function draftOf(e: TimeEntryDTO): MesaiDraft {
  return { entry: e, userId: e.userId, date: e.businessDate, inTime: hm(e.clockIn), outTime: e.clockOut ? hm(e.clockOut) : '', note: e.note ?? '' };
}

const HM = /^\d{2}:\d{2}$/;

/**
 * Taslağın anları: giriş iş gününe göre (05:00'ten önceki saat ertesi takvim günü), çıkış girişten önceyse ertesi gün.
 * Tarih ya da saat eksikse (alan temizlendi) NaN: tarih hesabı çizim sırasında hata atıp sayfayı düşürmesin.
 */
export function draftTimes(d: MesaiDraft): { clockIn: number; clockOut: number | null } {
  if (!isCalendarDate(d.date) || !HM.test(d.inTime)) return { clockIn: Number.NaN, clockOut: d.outTime ? Number.NaN : null };
  const clockIn = toMs(d.inTime < ROLLOVER ? addDays(d.date, 1) : d.date, d.inTime);
  if (!d.outTime) return { clockIn, clockOut: null };
  if (!HM.test(d.outTime)) return { clockIn, clockOut: Number.NaN };
  const inDate = istanbulParts(clockIn).date;
  const out = toMs(inDate, d.outTime);
  return { clockIn, clockOut: out < clockIn ? toMs(addDays(inDate, 1), d.outTime) : out };
}

/** Saatler (iş günü, giriş, çıkış) açıldıkları gibi mi; elle kayıtta hep değişmiş sayılır */
export const timesChanged = (d: MesaiDraft) =>
  !d.entry || d.date !== d.entry.businessDate || d.inTime !== hm(d.entry.clockIn) || d.outTime !== (d.entry.clockOut ? hm(d.entry.clockOut) : '');

const sameMinute = (a: number, b: number) => Math.floor(a / 60_000) === Math.floor(b / 60_000);

/**
 * Alan hataları. Saatler yalnız değiştiyse denetlenir: açıldığı gibi kalan saat (bir dakikadan kısa mesai, 24 saatten
 * eski açık mesai) yalnız not düzeltilirken engel olmasın. Sunucu bir dakikaya kadar ileriyi kabul eder (saat kayması).
 */
export function draftErrors(d: MesaiDraft, now: number): { who?: string; date?: string; in?: string; out?: string } {
  if (!d.userId) return { who: 'Kişi seçin' };
  if (!timesChanged(d)) return {};
  if (!isCalendarDate(d.date)) return { date: 'Gün seçin' };
  if (!HM.test(d.inTime)) return { in: 'Giriş saati gerekli' };
  if (d.outTime && !HM.test(d.outTime)) return { out: 'Saat ss:dd biçiminde' };
  const t = draftTimes(d);
  const limit = now + 60_000;
  if (t.clockIn > limit) return { in: 'Gelecekteki bir saat girilemez' };
  if (t.clockOut == null) return now - t.clockIn > MAX_SHIFT_MS ? { out: '24 saatten eski mesai açık kalamaz; çıkışı girin' } : {};
  if (t.clockOut > limit) return { out: 'Gelecekteki bir saat girilemez' };
  if (t.clockOut <= t.clockIn) return { out: 'Çıkış girişten sonra olmalı' };
  return {};
}

/**
 * Düzeltmenin gövdesi: yalnız değişen alan. Dakikası aynı kalan saat gönderilmez (kayıttaki saniyeler korunur, sahte
 * bir düzeltme denetime düşmez); açık mesaiye not eklenirken o arada yapılan çıkış geri alınmaz. Değişiklik yoksa null.
 */
export function editBody(d: MesaiDraft): MesaiPatch | null {
  const e = d.entry;
  if (!e) return null;
  const body: MesaiPatch = {};
  if (timesChanged(d)) {
    const t = draftTimes(d);
    if (!sameMinute(t.clockIn, e.clockIn)) body.clockIn = t.clockIn;
    if (t.clockOut == null ? e.clockOut != null : e.clockOut == null || !sameMinute(t.clockOut, e.clockOut)) body.clockOut = t.clockOut;
  }
  const note = d.note.trim() || null;
  if (note !== (e.note ?? null)) body.note = note;
  return Object.keys(body).length ? body : null;
}
