import { type Context, Hono } from 'hono';
import { z } from 'zod';
import { COMP_LABEL } from '@shared/comp';
import { fmtDateTime, isCalendarDate } from '@shared/time';
import { type AppEnv, can, requirePermission, seesCashNumbers, seesStaffOf } from '../lib/auth';
import { CSV_TYPES, csvRows, toCsv } from '@shared/report-csv';
import { HttpError, query } from '../lib/http';
import {
  checksReport,
  dayCount,
  hourlyReport,
  itemListReport,
  MAX_RANGE_DAYS,
  patronLive,
  platformReport,
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
/** Personelin adına yazılan ödenmez personel tutarıdır: maliyet yetkisi olmayana yalnız kendisininki adıyla */
const staffFor = (c: Context<AppEnv>) => (userId: string) => seesStaffOf(c.get('user'), userId);
reportRoutes.get('/items', (c) => {
  const kind = query(c, z.object({ kind: z.enum(['iptal', 'ikram', 'indirim', 'happy']) })).kind;
  return c.json(itemListReport(range(c), kind, staffFor(c)));
});
reportRoutes.get('/refunds', (c) => c.json(refundReport(range(c))));
/** Paket platformları: tahmini komisyon bir maliyettir, yalnız maliyet yetkisine gider */
reportRoutes.get('/platforms', (c) => c.json(platformReport(range(c), can(c.get('user'), 'rapor.maliyet'))));
/** Garsona göre toplanan adisyon listesi personel tutarıdır: maliyet yetkisi olmayana yalnız kendi adisyonlarının garsonu */
const waiterFor = (c: Context<AppEnv>) => (waiterId: string | null) => seesStaffOf(c.get('user'), waiterId);
reportRoutes.get('/checks', (c) => c.json(checksReport(range(c), 300, waiterFor(c))));
/** Yazarkasadan geçmeyen tutar kasa rakamıdır: kör kasada (patron paneli verilmiş olsa da) gitmez */
reportRoutes.get('/patron', (c) => c.json(patronLive(can(c.get('user'), 'rapor.maliyet'), seesCashNumbers(c.get('user')))));

/** Excel'in Türkçe ayarıyla açılan CSV (server/lib/csv.ts: noktalı virgül, virgüllü ondalık, formül korumalı) */
reportRoutes.get('/export.csv', (c) => {
  const r = range(c);
  const type = query(c, z.object({ type: z.enum(CSV_TYPES) })).type;
  const withCost = can(c.get('user'), 'rapor.maliyet');
  // Satırlar LafPOS Uzaktan'la ortak (shared/report-csv.ts); adisyonlarda dönemin hepsi (ekrandaki liste en yenilerle sınırlı)
  const rep =
    type === 'urunler'
      ? productReport(r, withCost)
      : type === 'adisyonlar'
        ? checksReport(r, null, waiterFor(c))
        : type === 'saatlik'
          ? hourlyReport(r)
          : type === 'platformlar'
            ? platformReport(r, withCost)
            : itemListReport(r, type, staffFor(c));
  const rows = csvRows(type, rep, withCost);
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-${type}-${r.from}_${r.to}.csv"`);
  return c.body(toCsv(rows));
});
