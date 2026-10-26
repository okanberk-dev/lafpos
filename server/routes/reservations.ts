import { and, asc, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { businessDate } from '@shared/time';
import { db, schema } from '../db/client';
import { type AppEnv, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, notFound, patchOf, query } from '../lib/http';
import { ulid } from '../lib/ids';
import { normalizePhone } from '../services/customers';

export const reservationRoutes = new Hono<AppEnv>();

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const time = z.string().regex(/^\d{2}:\d{2}$/);

function emit(userId: string, message?: string) {
  const fx = new Effects();
  fx.emit({ topic: 'reservations', kind: 'changed', byUserId: userId, message });
  fx.flush();
}

reservationRoutes.get('/', (c) => {
  requirePermission(c.get('user'), 'rezervasyon.yonet');
  const q = query(c, z.object({ date: date.default(businessDate(Date.now())) }));
  const tables = new Map(db.select({ id: schema.tables.id, name: schema.tables.name }).from(schema.tables).all().map((t) => [t.id, t.name]));
  return c.json(
    db
      .select()
      .from(schema.reservations)
      .where(eq(schema.reservations.date, q.date))
      .orderBy(asc(schema.reservations.time))
      .all()
      .map((r) => ({ ...r, tableName: r.tableId ? (tables.get(r.tableId) ?? null) : null })),
  );
});

const shape = z.object({
  date,
  time,
  durationMin: z.number().int().min(15).max(600).default(120),
  name: z.string().min(1).max(80),
  phone: z.string().max(30).nullish(),
  guests: z.number().int().min(1).max(200).default(2),
  tableId: z.string().nullish(),
  note: z.string().max(300).nullish(),
});

reservationRoutes.post('/', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'rezervasyon.yonet');
  const input = await body(c, shape);
  const phone = normalizePhone(input.phone);
  const customer = phone ? db.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, phone)).get() : undefined;
  const id = ulid();
  db.insert(schema.reservations)
    .values({ id, ...input, phone, tableId: input.tableId ?? null, note: input.note ?? null, customerId: customer?.id ?? null, createdBy: user.id, createdAt: Date.now() })
    .run();
  emit(user.id, `Rezervasyon: ${input.date} ${input.time} ${input.name}`);
  return c.json({ id });
});

reservationRoutes.patch('/:id', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'rezervasyon.yonet');
  const input = await body(c, patchOf(shape).extend({ status: z.enum(['bekliyor', 'geldi', 'iptal', 'gelmedi']).optional() }));
  const r = db.select().from(schema.reservations).where(eq(schema.reservations.id, c.req.param('id'))).get();
  if (!r) throw notFound('Rezervasyon');
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (input.phone !== undefined) (patch as Record<string, unknown>).phone = normalizePhone(input.phone);
  db.update(schema.reservations).set(patch).where(and(eq(schema.reservations.id, r.id))).run();
  emit(user.id);
  return c.json({ ok: true });
});
