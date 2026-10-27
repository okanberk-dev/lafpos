import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { fmtDateTime, isCalendarDate } from '@shared/time';
import { type AppEnv, can, requirePermission, seesStaffOf } from '../lib/auth';
import { type CsvValue, money, toCsv } from '../lib/csv';
import { HttpError, query } from '../lib/http';
import {
  checksReport,
  dayCount,
  hourlyReport,
  itemListReport,
  MAX_RANGE_DAYS,
  patronLive,
  prepReport,
  productReport,
  refundReport,
  reportToday,
  staffReport,
  summaryReport,
} from '../services/reports';

export const reportRoutes = new Hono<AppEnv>();

/** Gerçek takvim günü: 2026-13-01 ya da 2026-02-30 iç hata değil, 422 */
const date = z.string().refine(isCalendarDate);

/**
 * Rapor dönemi: varsayılanı bugün (açık iş günü); ters verilirse çevrilir; en çok MAX_RANGE_DAYS gün. Raporlar ve
 * Raporlar › Aktarım'ın lafmaliyet satış listesi (server/routes/sync.ts) aynı denetimi kullanır.
 */
function range(c: Parameters<typeof query>[0]) {
  const today = reportToday();
  const q = query(c, z.object({ from: date.default(today), to: date.default(today) }));
  const r = q.from <= q.to ? q : { from: q.to, to: q.from };
  if (dayCount(r) > MAX_RANGE_DAYS) throw new HttpError(422, `Rapor dönemi en çok ${MAX_RANGE_DAYS} gün olabilir; daha kısa bir aralık seçin`, 'range_too_long');
  return r;
}
export { range as reportRange };

reportRoutes.use('*', async (c, next) => {
  if (c.req.path.endsWith('/patron')) requirePermission(c.get('user'), 'patron.panel');
  else requirePermission(c.get('user'), 'rapor.gor');
  return next();
});

reportRoutes.get('/summary', (c) => c.json(summaryReport(range(c))));
reportRoutes.get('/products', (c) => c.json(productReport(range(c), can(c.get('user'), 'rapor.maliyet'))));
reportRoutes.get('/hourly', (c) => c.json(hourlyReport(range(c))));
reportRoutes.get('/prep', (c) => c.json(prepReport(range(c))));
reportRoutes.get('/staff', (c) => {
  requirePermission(c.get('user'), 'rapor.maliyet');
  return c.json(staffReport(range(c)));
});
reportRoutes.get('/items', (c) => {
  const kind = query(c, z.object({ kind: z.enum(['iptal', 'ikram', 'indirim', 'happy']) })).kind;
  return c.json(itemListReport(range(c), kind));
});
reportRoutes.get('/refunds', (c) => c.json(refundReport(range(c))));
/** Garsona göre toplanan adisyon listesi personel tutarıdır: maliyet yetkisi olmayana yalnız kendi adisyonlarının garsonu */
const waiterFor = (c: Context<AppEnv>) => (waiterId: string | null) => seesStaffOf(c.get('user'), waiterId);
reportRoutes.get('/checks', (c) => c.json(checksReport(range(c), 300, waiterFor(c))));
reportRoutes.get('/patron', (c) => c.json(patronLive(can(c.get('user'), 'rapor.maliyet'))));

/** Excel'in Türkçe ayarıyla açılan CSV (server/lib/csv.ts: noktalı virgül, virgüllü ondalık, formül korumalı) */
reportRoutes.get('/export.csv', (c) => {
  const r = range(c);
  const type = query(c, z.object({ type: z.enum(['urunler', 'adisyonlar', 'iptal', 'ikram', 'indirim', 'saatlik']) })).type;
  let rows: CsvValue[][] = [];
  if (type === 'urunler') {
    const rep = productReport(r, can(c.get('user'), 'rapor.maliyet'));
    rows = [['Ürün', 'Boy', 'Kategori', 'Adet', 'Ciro', 'Pay %', 'İkram adet', 'İptal adet'], ...rep.products.map((p) => [p.name, p.size, p.category, p.qty, money(p.revenue), p.share, p.complimentary, p.voided])];
  } else if (type === 'adisyonlar') {
    // Dönemin bütün adisyonları (ekrandaki liste en yenilerle sınırlı)
    const rep = checksReport(r, null, waiterFor(c));
    rows = [['No', 'Durum', 'Tür', 'Yer', 'Açılış', 'Kapanış', 'Garson', 'Adet', 'Tutar', 'Ödeme'], ...rep.rows.map((o) => [o.no, o.status, o.type, o.place ?? '', fmtDateTime(o.openedAt), o.closedAt ? fmtDateTime(o.closedAt) : '', o.waiter ?? '', o.qty, money(o.total), o.methods.join(', ')])];
  } else if (type === 'saatlik') {
    // İş günü sırasıyla: 05:00'ten başlar, gece yarısından sonraki saatler, gün uzadıysa ertesi günün saatleri en sonda
    const rep = hourlyReport(r);
    rows = [['Saat', 'Adisyon', 'Ciro'], ...rep.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00${h.nextDay ? ' (ertesi gün)' : ''}`, h.orders, money(h.revenue)])];
  } else {
    const rep = itemListReport(r, type);
    // İkram listesinde tür (ikram ya da ödenmez) Excel'de süzülebilsin
    const kind = type === 'ikram';
    rows = [
      ['Zaman', 'Adisyon', 'Yer', 'Ürün', 'Adet', 'Tutar', ...(kind ? ['Tür'] : []), 'Neden', 'Yapan', 'Onaylayan'],
      ...rep.rows.map((x) => [fmtDateTime(x.at), x.orderNo, x.place, x.name, x.qty, money(x.value), ...(kind ? [x.compKind === 'odenmez' ? 'Ödenmez' : 'İkram'] : []), x.reason ?? '', x.by ?? '', x.approvedBy ?? '']),
    ];
  }
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-${type}-${r.from}_${r.to}.csv"`);
  return c.body(toCsv(rows));
});
