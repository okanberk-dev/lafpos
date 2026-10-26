import { tlPlain } from '@shared/money';

/**
 * Excel'in Türkçe ayarıyla açılan CSV: noktalı virgül ayraç, virgüllü ondalık, UTF-8 BOM, CRLF satır sonu.
 * Hücre türü bellidir: metin, sayı ya da para (kuruş). Personelin yazdığı metin (iptal nedeni, ad) formül olarak
 * çalışmaz: =, +, -, @, sekme ya da CR ile başlayan metnin başına ' konur (OWASP "CSV injection"); ; " CR ya da
 * LF içeren hücre tırnağa alınır, satır bölünmez. Sayı ve para hücresine dokunulmaz (eksi tutar sayı kalır).
 */
export type CsvValue = string | number | null | undefined | { kurus: number };

/** Para hücresi: "1.234,50" */
export const money = (kurus: number): CsvValue => ({ kurus });

const NUMBER = new Intl.NumberFormat('tr-TR', { useGrouping: false, maximumFractionDigits: 2 });

export function csvCell(v: CsvValue): string {
  if (v == null) return '';
  if (typeof v === 'number') return NUMBER.format(v);
  if (typeof v === 'object') return tlPlain(v.kurus);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvValue[][]): string {
  return '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}
