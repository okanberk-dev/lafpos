import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { tlPlain } from '@shared/money';
import { businessDate, fmtDateTime } from '@shared/time';
import { type AppEnv, can, requirePermission, seesStaffOf } from '../lib/auth';
import { query } from '../lib/http';
import { checksReport, hourlyReport, itemListReport, patronLive, prepReport, productReport, refundReport, staffReport, summaryReport } from '../services/reports';

export const reportRoutes = new Hono<AppEnv>();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
function range(c: Parameters<typeof query>[0]) {
  const today = businessDate(Date.now());
  const q = query(c, z.object({ from: date.default(today), to: date.default(today) }));
  return q.from <= q.to ? q : { from: q.to, to: q.from };
}

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

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Excel'in Türkçe ayarıyla açılan CSV (noktalı virgül, virgüllü ondalık, UTF-8 BOM) */
reportRoutes.get('/export.csv', (c) => {
  const r = range(c);
  const type = query(c, z.object({ type: z.enum(['urunler', 'adisyonlar', 'iptal', 'ikram', 'indirim', 'saatlik']) })).type;
  let rows: unknown[][] = [];
  if (type === 'urunler') {
    const rep = productReport(r, can(c.get('user'), 'rapor.maliyet'));
    rows = [['Ürün', 'Boy', 'Kategori', 'Adet', 'Ciro', 'Pay %', 'İkram adet', 'İptal adet'], ...rep.products.map((p) => [p.name, p.size, p.category, p.qty, tlPlain(p.revenue), p.share, p.complimentary, p.voided])];
  } else if (type === 'adisyonlar') {
    const rep = checksReport(r, 5000, waiterFor(c));
    rows = [['No', 'Durum', 'Tür', 'Yer', 'Açılış', 'Kapanış', 'Garson', 'Adet', 'Tutar', 'Ödeme'], ...rep.rows.map((o) => [o.no, o.status, o.type, o.place ?? '', fmtDateTime(o.openedAt), o.closedAt ? fmtDateTime(o.closedAt) : '', o.waiter ?? '', o.qty, tlPlain(o.total), o.methods.join(', ')])];
  } else if (type === 'saatlik') {
    const rep = hourlyReport(r);
    rows = [['Saat', 'Adisyon', 'Ciro'], ...rep.hours.map((h) => [`${String(h.hour).padStart(2, '0')}:00`, h.orders, tlPlain(h.revenue)])];
  } else {
    const rep = itemListReport(r, type);
    rows = [['Zaman', 'Adisyon', 'Yer', 'Ürün', 'Adet', 'Tutar', 'Neden', 'Yapan', 'Onaylayan'], ...rep.rows.map((x) => [fmtDateTime(x.at), x.orderNo, x.place, x.name, x.qty, tlPlain(x.value), x.reason ?? '', x.by ?? '', x.approvedBy ?? ''])];
  }
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-${type}-${r.from}_${r.to}.csv"`);
  return c.body('﻿' + rows.map((row) => row.map(csvCell).join(';')).join('\r\n') + '\r\n');
});
