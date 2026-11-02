import { Hono } from 'hono';
import { z } from 'zod';
import { businessDate, isCalendarDate } from '@shared/time';
import { db } from '../db/client';
import { type AppEnv, clientKey, requirePermission, verifyLoginPin } from '../lib/auth';
import { body, HttpError, patchFields, patchOf, query } from '../lib/http';
import { dayCount } from '../services/reports';
import * as time from '../services/time';
import { write } from './pos';

/**
 * Mesai: personelin giriş-çıkışı. Kişi kendi girişini oturumdan (`/clock-in`, `/clock-out`) ya da kilit ekranında
 * PIN'le (`/punch`, oturumsuz; PIN giriş ekranıyla aynı deneme sınırında) yapar. Çizelge ve düzeltmeler
 * `mesai.yonet` ister (müdür, patron); yöneticinin her yazması denetim kaydına düşer.
 */
export const timeRoutes = new Hono<AppEnv>();

/** Kişinin kendi mesaisi: açık mesai, bugün ve son 7 iş günü */
timeRoutes.get('/me', (c) => c.json(time.myTime(db, c.get('user').id)));

timeRoutes.post('/clock-in', (c) => {
  const user = c.get('user');
  const row = write((t, fx) => time.clockIn(t, user, fx, 'oturum'));
  return c.json({ entry: time.entryDTO(db, row), me: time.myTime(db, user.id) });
});

timeRoutes.post('/clock-out', (c) => {
  const user = c.get('user');
  const row = write((t, fx) => time.clockOut(t, user, fx));
  return c.json({ entry: time.entryDTO(db, row), me: time.myTime(db, user.id) });
});

/**
 * Kilit ekranında PIN'le giriş-çıkış (oturum açılmaz, jeton dönmez). `action` yoksa durum değişir; kapalı hesap
 * basamaz (hatalı PIN gibi).
 */
timeRoutes.post('/punch', async (c) => {
  const input = await body(c, z.object({ pin: z.string(), action: z.enum(['in', 'out']).optional() }));
  const person = verifyLoginPin(input.pin, clientKey(c));
  return c.json(write((t, fx) => time.punch(t, person, fx, input.action)));
});

// ─── Yönetici: çizelge ve düzeltmeler ───────────────────────────────────────

/** Gerçek takvim günü: 2026-13-01 ya da 2026-02-30 422 */
const date = z.string().refine(isCalendarDate);

/** Çizelge dönemi (iş günü): varsayılanı bugün; ters verilirse çevrilir; en çok 93 gün */
function sheetRange(c: Parameters<typeof query>[0]) {
  const today = businessDate(Date.now());
  const q = query(c, z.object({ from: date.default(today), to: date.default(today), userId: z.string().max(40).optional() }));
  const r = q.from <= q.to ? { from: q.from, to: q.to } : { from: q.to, to: q.from };
  if (dayCount(r) > time.MAX_SHEET_DAYS) {
    throw new HttpError(422, `Mesai çizelgesi en çok ${time.MAX_SHEET_DAYS} gün gösterir; daha kısa bir aralık seçin`, 'range_too_long');
  }
  return { ...r, userId: q.userId };
}

/** Epoch milisaniye */
const ms = z.number().int().positive();
const entryShape = z.object({
  clockIn: ms,
  clockOut: ms.nullable(),
  note: z.string().max(200).nullable(),
});

timeRoutes.get('/', (c) => {
  requirePermission(c.get('user'), 'mesai.yonet');
  return c.json(time.timeSheet(db, sheetRange(c)));
});

timeRoutes.get('/export.csv', (c) => {
  requirePermission(c.get('user'), 'mesai.yonet');
  const r = sheetRange(c);
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-mesai-${r.from}_${r.to}.csv"`);
  return c.body(time.timeSheetCsv(time.timeSheet(db, r)));
});

/** Elle mesai (kişi girişini unuttu): çıkış boşsa açık mesai */
timeRoutes.post('/entries', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'mesai.yonet');
  const input = await body(c, entryShape.extend({ userId: z.string().max(40), clockOut: ms.nullish(), note: z.string().max(200).nullish() }));
  const row = write((t, fx) => time.createEntry(t, user, fx, input));
  return c.json(time.entryDTO(db, row));
});

/** Düzeltme: gönderilen alanlar değişir (`clockOut: null` mesaiyi yeniden açar) */
timeRoutes.patch('/entries/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'mesai.yonet');
  const input = patchFields(await body(c, patchOf(entryShape)));
  const row = write((t, fx) => time.editEntry(t, user, fx, c.req.param('id'), input));
  return c.json(time.entryDTO(db, row));
});

/** Açık mesaiyi kapatır: şimdi ya da verilen saatte (`at`, çıkışı unutulmuş mesai) */
timeRoutes.post('/entries/:id/close', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'mesai.yonet');
  const input = await body(c, z.object({ at: ms.optional() }));
  const row = write((t, fx) => time.closeEntry(t, user, fx, c.req.param('id'), input.at));
  return c.json(time.entryDTO(db, row));
});

timeRoutes.delete('/entries/:id', (c) => {
  const user = c.get('user');
  requirePermission(user, 'mesai.yonet');
  write((t, fx) => time.deleteEntry(t, user, fx, c.req.param('id')));
  return c.json({ ok: true });
});
