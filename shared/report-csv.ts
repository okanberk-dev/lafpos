/**
 * Raporların CSV'si: kasa (server/routes/reports.ts) ve AsilPOS Uzaktan (api/uzaktan.ts) aynı satırları buradan kurar.
 * İçe aktarma yok (Vercel işlevi bunu çalışma anında yükler); para ve tarih biçimi shared/money.ts `tlPlain` ve
 * shared/time.ts `fmtDateTime` ile aynı (tests/uzaktan-ek-raporlar.test.ts denetler).
 *
 * Excel'in Türkçe ayarıyla açılır: noktalı virgül ayraç, virgüllü ondalık, UTF-8 BOM, CRLF satır sonu. Personelin
 * yazdığı metin formül olarak çalışmaz: =, +, -, @, sekme ya da CR ile başlayan metnin başına ' konur (OWASP "CSV
 * injection"); ; " CR ya da LF içeren hücre tırnağa alınır. Sayı ve para hücresine dokunulmaz.
 */
export type CsvValue = string | number | null | undefined | { kurus: number };

/** Para hücresi: "1234,50" */
export const money = (kurus: number): CsvValue => ({ kurus });

const NUMBER = new Intl.NumberFormat('tr-TR', { useGrouping: false, maximumFractionDigits: 2 });
const PLAIN = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const DATE_TIME = new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
export const csvDateTime = (ms: number) => DATE_TIME.format(new Date(ms));

export function csvCell(v: CsvValue): string {
  if (v == null) return '';
  if (typeof v === 'number') return NUMBER.format(v);
  if (typeof v === 'object') return PLAIN.format(v.kurus / 100);
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows: CsvValue[][]): string {
  return '﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export const CSV_TYPES = ['urunler', 'adisyonlar', 'iptal', 'ikram', 'indirim', 'saatlik', 'platformlar'] as const;
export type CsvType = (typeof CSV_TYPES)[number];

const COMP: Record<string, string> = { ikram: 'İkram', odenmez: 'Ödenmez', zayi: 'Zayi' };

interface ProductRep {
  products: { name: string; size: string; category: string; qty: number; revenue: number; share: number; complimentary: number; voided: number }[];
}
interface ChecksRep {
  rows: { no: number; status: string; type: string; place: string | null; openedAt: number; closedAt: number | null; waiter: string | null; qty: number; total: number; methods: string[] }[];
}
interface HourlyRep {
  hours: { hour: number; nextDay?: boolean; orders: number; revenue: number }[];
}
interface PlatformRep {
  platforms: {
    label: string;
    orders: number;
    revenue: number;
    avgBasket: number;
    share: number;
    discounts: number;
    platformDiscount: number;
    collectedByPlatform: number;
    collectedAtCounter: number;
    open: { orders: number; amount: number };
    missed: { rejected: number; expired: number; cancelled: number; unrecorded: number; amount: number };
    commissionPct?: number;
    commission?: number;
  }[];
}
interface ItemRep {
  rows: { at: number; orderNo: number; place: string; name: string; qty: number; value: number; compKind: string | null; person: { kind: string; name: string } | null; reason: string | null; by: string | null; approvedBy: string | null }[];
}

/** Bir CSV türünün satırları; `withCost` platformların komisyon sütunları (yalnız maliyet yetkisi, kasada) */
export function csvRows(type: CsvType, rep: unknown, withCost = false): CsvValue[][] {
  if (type === 'urunler') {
    const r = rep as ProductRep;
    return [['Ürün', 'Boy', 'Kategori', 'Adet', 'Ciro', 'Pay %', 'İkram adet', 'İptal adet'], ...r.products.map((p) => [p.name, p.size, p.category, p.qty, money(p.revenue), p.share, p.complimentary, p.voided])];
  }
  if (type === 'adisyonlar') {
    const r = rep as ChecksRep;
    return [['No', 'Durum', 'Tür', 'Yer', 'Açılış', 'Kapanış', 'Garson', 'Adet', 'Tutar', 'Ödeme'], ...r.rows.map((o) => [o.no, o.status, o.type, o.place ?? '', csvDateTime(o.openedAt), o.closedAt ? csvDateTime(o.closedAt) : '', o.waiter ?? '', o.qty, money(o.total), o.methods.join(', ')])];
  }
  if (type === 'saatlik') {
    // İş günü sırasıyla: 05:00'ten başlar, gece yarısından sonraki saatler, gün uzadıysa ertesi günün saatleri en sonda
    const r = rep as HourlyRep;
    return [['Saat', 'Adisyon', 'Ciro'], ...r.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00${h.nextDay ? ' (ertesi gün)' : ''}`, h.orders, money(h.revenue)])];
  }
  if (type === 'platformlar') {
    // Komisyon sütunları yalnız maliyet yetkisine (ekrandaki gibi); kaçan tutar müşterinin ödeyeceği, ciroya girmez
    const r = rep as PlatformRep;
    return [
      ['Platform', 'Sipariş', 'Ciro', 'Ort. sepet', 'Ciro payı %', 'Restoran indirimi', 'Platform kampanyası', 'Platformda tahsil', 'Kasada tahsil', 'Açık sipariş', 'Açık tutar', 'Reddedilen', 'Süresi dolan', 'İptal', 'Kasaya alınmadı', 'Kaçan tutar', ...(withCost ? ['Komisyon oranı % (bugünkü)', 'Tahmini komisyon'] : [])],
      ...r.platforms.map((p) => [
        p.label,
        p.orders,
        money(p.revenue),
        money(p.avgBasket),
        p.share,
        money(p.discounts),
        money(p.platformDiscount),
        money(p.collectedByPlatform),
        money(p.collectedAtCounter),
        p.open.orders,
        money(p.open.amount),
        p.missed.rejected,
        p.missed.expired,
        p.missed.cancelled,
        p.missed.unrecorded,
        money(p.missed.amount),
        ...(withCost ? [p.commissionPct ?? 0, money(p.commission ?? 0)] : []),
      ]),
    ];
  }
  // İkram listesinde tür (ikram, ödenmez, zayi) Excel'de süzülebilsin; ödenmezde kimin adına yazıldığı Kişi sütununda
  const r = rep as ItemRep;
  const kind = type === 'ikram';
  return [
    ['Zaman', 'Adisyon', 'Yer', 'Ürün', 'Adet', 'Tutar', ...(kind ? ['Tür', 'Kişi'] : []), 'Neden', 'Yapan', 'Onaylayan'],
    ...r.rows.map((x) => [
      csvDateTime(x.at),
      x.orderNo,
      x.place,
      x.name,
      x.qty,
      money(x.value),
      ...(kind ? [COMP[x.compKind ?? 'ikram'], x.person ? `${x.person.name} (${x.person.kind === 'user' ? 'personel' : 'müşteri'})` : ''] : []),
      x.reason ?? '',
      x.by ?? '',
      x.approvedBy ?? '',
    ]),
  ];
}
