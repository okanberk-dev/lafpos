import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { type AppEnv, actorFrom, can, requirePermission } from '../lib/auth';
import { body, kurus, query } from '../lib/http';
import { getSettings } from '../lib/settings';
import { addAddress, createCustomer, customerDetail, redeemStamps, searchCustomers, updateCustomer } from '../services/customers';
import { write } from './pos';

export const customerRoutes = new Hono<AppEnv>();

/** Kasada müşteri bulmak için ad/telefon araması. Personel bakiyeyi görür (açık hesap için gerekli). */
customerRoutes.get('/', (c) => {
  const user = c.get('user');
  if (!can(user, 'cari.yonet') && !can(user, 'siparis.al')) requirePermission(user, 'cari.yonet');
  const q = query(c, z.object({ q: z.string().max(60).default(''), limit: z.coerce.number().int().min(1).max(200).default(20) }));
  return c.json(searchCustomers(db, q.q, q.limit));
});

const customerShape = {
  name: z.string().min(1).max(80),
  phone: z.string().max(30).nullish(),
  email: z.string().max(120).nullish(),
  note: z.string().max(300).nullish(),
  birthday: z.string().max(10).nullish(),
  creditLimit: kurus.nullish(),
  tags: z.array(z.string().max(30)).max(10).optional(),
};

customerRoutes.post('/', async (c) => {
  const input = await body(c, z.object({ ...customerShape, approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  const created = write((t, fx) => createCustomer(t, actor, fx, input));
  return c.json(created);
});

customerRoutes.get('/:id', (c) => {
  requirePermission(c.get('user'), 'cari.yonet');
  return c.json(customerDetail(db, c.req.param('id')));
});

customerRoutes.patch('/:id', async (c) => {
  const input = await body(c, z.object({ ...Object.fromEntries(Object.entries(customerShape).map(([k, v]) => [k, v.optional()])), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin as string | null | undefined);
  write((t, fx) => updateCustomer(t, actor, fx, c.req.param('id'), input as Parameters<typeof updateCustomer>[4]));
  return c.json(customerDetail(db, c.req.param('id')));
});

customerRoutes.post('/:id/addresses', async (c) => {
  const input = await body(c, z.object({ title: z.string().max(30).default('Ev'), address: z.string().min(3).max(400), note: z.string().max(200).nullish() }));
  const actor = actorFrom(c);
  write((t) => addAddress(t, actor, c.req.param('id'), input));
  return c.json(customerDetail(db, c.req.param('id')));
});

customerRoutes.post('/:id/redeem', async (c) => {
  const input = await body(c, z.object({ approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => redeemStamps(t, actor, fx, c.req.param('id'), getSettings().stampGoal));
  return c.json(customerDetail(db, c.req.param('id')));
});
