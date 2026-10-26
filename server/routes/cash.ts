import { Hono } from 'hono';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import { db, schema } from '../db/client';
import { type AppEnv, actorFrom, requirePermission } from '../lib/auth';
import { body, kurus, query } from '../lib/http';
import { addCashMovement, closeDay, collectCustomerPayment, computeSummary, dayToDTO, getDay, lafmaliyetZ, listDays, openDay, recordCount } from '../services/days';
import { enqueueDay, flushOutbox } from '../sync/lafmaliyet';
import { getOpenDay } from '../services/orders';
import { write } from './pos';

export const cashRoutes = new Hono<AppEnv>();

function movementsOf(dayId: string) {
  const names = new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));
  return db
    .select()
    .from(schema.cashMovements)
    .where(eq(schema.cashMovements.dayId, dayId))
    .orderBy(asc(schema.cashMovements.createdAt))
    .all()
    .map((m) => ({ ...m, userName: m.userId ? (names.get(m.userId) ?? null) : null }));
}

/**
 * Kör kasa (ModPOS "Kör Kasa" gibi): `kasa.rakam` ya da `rapor.gor` yetkisi olmayan kasiyer ara raporu,
 * beklenen nakdi ve kasa farkını görmez; gün sonunda saydığını yazar, fark yöneticinin ekranındadır.
 */
const seesNumbers = (user: AppEnv['Variables']['user']) => user.permissions.has('kasa.rakam') || user.permissions.has('rapor.gor');

/** Açık gün, ara rapor (X) ve kasa hareketleri */
cashRoutes.get('/day', (c) => {
  const user = c.get('user');
  const day = getOpenDay(db);
  const blind = !seesNumbers(user);
  if (!day) return c.json({ day: null, summary: null, movements: [], blind });
  return c.json({ day: dayToDTO(db, day), summary: blind ? null : computeSummary(db, day), movements: movementsOf(day.id), blind });
});

cashRoutes.post('/day/open', async (c) => {
  const input = await body(c, z.object({ openingCash: kurus }));
  const actor = actorFrom(c);
  const day = write((t, fx) => openDay(t, actor, fx, input));
  return c.json(dayToDTO(db, day));
});

cashRoutes.post('/day/close', async (c) => {
  const input = await body(
    c,
    z.object({ countedCash: kurus.nullable(), cashCounts: z.record(z.string(), z.number().int().min(0)).nullish(), note: z.string().max(500).nullish() }),
  );
  const actor = actorFrom(c);
  const day = write((t, fx) => closeDay(t, actor, fx, input));
  if (enqueueDay(day.id)) void flushOutbox();
  if (!seesNumbers(c.get('user'))) return c.json({ day: dayToDTO(db, day), summary: null, lafmaliyet: null, blind: true });
  return c.json({ day: dayToDTO(db, day), summary: day.summary, lafmaliyet: day.summary ? lafmaliyetZ(day, day.summary) : null, blind: false });
});

cashRoutes.post('/days/:id/count', async (c) => {
  const input = await body(
    c,
    z.object({
      countedCash: kurus,
      methodCounts: z.record(z.string(), kurus).optional(),
      banknotes: z.record(z.string(), z.number().int().min(0).max(100000)).optional(),
      note: z.string().max(500).nullish(),
    }),
  );
  const actor = actorFrom(c);
  const day = write((t, fx) => recordCount(t, actor, fx, c.req.param('id'), input));
  if (enqueueDay(day.id)) void flushOutbox();
  const blind = !seesNumbers(c.get('user'));
  return c.json({ day: dayToDTO(db, day), summary: blind ? null : day.summary, blind });
});

cashRoutes.post('/movements', async (c) => {
  const input = await body(c, z.object({ kind: z.enum(['harcama', 'teslim', 'giris']), amount: kurus, description: z.string().max(200).default(''), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => addCashMovement(t, actor, fx, input));
  return c.json({ ok: true });
});

cashRoutes.post('/collect', async (c) => {
  const input = await body(c, z.object({ customerId: z.string(), methodId: z.string(), amount: kurus, note: z.string().max(200).nullish(), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => collectCustomerPayment(t, actor, fx, input));
  return c.json({ ok: true });
});

cashRoutes.get('/days', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const q = query(c, z.object({ limit: z.coerce.number().int().min(1).max(366).default(60) }));
  return c.json(
    listDays(db, q.limit).map((d) => ({
      ...dayToDTO(db, d),
      netSales: d.summary?.netSales ?? null,
      cashDiff: d.cashDiff,
      receipts: d.summary?.receipts ?? null,
    })),
  );
});

cashRoutes.get('/days/:id', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const day = getDay(db, c.req.param('id'));
  const summary = day.summary ?? computeSummary(db, day);
  return c.json({ day: dayToDTO(db, day), summary, movements: movementsOf(day.id), lafmaliyet: lafmaliyetZ(day, summary), note: day.note, cashCounts: day.cashCounts });
});

cashRoutes.get('/days/:id/lafmaliyet.json', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const day = getDay(db, c.req.param('id'));
  const summary = day.summary ?? computeSummary(db, day);
  c.header('content-disposition', `attachment; filename="lafpos-z-${day.date}.json"`);
  return c.json(lafmaliyetZ(day, summary));
});
