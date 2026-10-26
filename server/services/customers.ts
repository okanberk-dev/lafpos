import { desc, eq, like, or, sql } from 'drizzle-orm';
import { tl } from '@shared/money';
import { type DB, schema, type Tx } from '../db/client';
import { type Actor, need } from '../lib/auth';
import type { Effects } from '../lib/effects';
import { bad, conflict, notFound } from '../lib/http';
import { ulid } from '../lib/ids';

/** Telefonu karşılaştırma biçimine indirger: yalnız rakamlar, başta 90/0 yok ("0532 111 22 33" -> "5321112233") */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let d = phone.replace(/\D/g, '');
  if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return d.length >= 7 ? d : null;
}

export function searchCustomers(t: Tx | DB, q: string, limit = 20) {
  const term = q.trim();
  if (!term) return t.select().from(schema.customers).orderBy(desc(schema.customers.lastVisitAt)).limit(limit).all();
  const phone = normalizePhone(term) ?? term.replace(/\D/g, '');
  return t
    .select()
    .from(schema.customers)
    .where(or(like(schema.customers.name, `%${term}%`), phone.length >= 3 ? like(schema.customers.phone, `%${phone}%`) : undefined))
    .orderBy(desc(schema.customers.lastVisitAt))
    .limit(limit)
    .all();
}

export interface CustomerInput {
  name: string;
  phone?: string | null;
  email?: string | null;
  note?: string | null;
  birthday?: string | null;
  creditLimit?: number | null;
  tags?: string[];
}

export function createCustomer(t: Tx, actor: Actor, fx: Effects, input: CustomerInput) {
  // Damga kartı için müşteri eklemek sipariş alan herkese açık; açık hesap sınırı yalnız cari yetkisiyle
  if (input.creditLimit != null || !actor.user.permissions.has('siparis.al')) need(actor, 'cari.yonet');
  const name = input.name.trim();
  if (!name) throw bad('Müşteri adı yazılmalı');
  const phone = normalizePhone(input.phone);
  if (phone) {
    const dup = t.select({ id: schema.customers.id, name: schema.customers.name }).from(schema.customers).where(eq(schema.customers.phone, phone)).get();
    if (dup) throw conflict(`Bu telefon ${dup.name} adına kayıtlı`, 'duplicate_phone');
  }
  const id = ulid();
  t.insert(schema.customers)
    .values({
      id,
      name,
      phone,
      email: input.email?.trim() || null,
      note: input.note?.trim() || null,
      birthday: input.birthday || null,
      creditLimit: input.creditLimit ?? null,
      tags: input.tags ?? [],
      createdAt: Date.now(),
    })
    .run();
  fx.emit({ topic: 'customers', kind: 'created', byUserId: actor.user.id });
  return t.select().from(schema.customers).where(eq(schema.customers.id, id)).get()!;
}

export function updateCustomer(t: Tx, actor: Actor, fx: Effects, id: string, input: Partial<CustomerInput>) {
  need(actor, 'cari.yonet');
  const c = t.select().from(schema.customers).where(eq(schema.customers.id, id)).get();
  if (!c) throw notFound('Müşteri');
  const patch: Partial<typeof schema.customers.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name.trim() || c.name;
  if (input.phone !== undefined) {
    const phone = normalizePhone(input.phone);
    if (phone && phone !== c.phone) {
      const dup = t.select({ id: schema.customers.id }).from(schema.customers).where(eq(schema.customers.phone, phone)).get();
      if (dup) throw conflict('Bu telefon başka müşteriye kayıtlı', 'duplicate_phone');
    }
    patch.phone = phone;
  }
  if (input.email !== undefined) patch.email = input.email?.trim() || null;
  if (input.note !== undefined) patch.note = input.note?.trim() || null;
  if (input.birthday !== undefined) patch.birthday = input.birthday || null;
  if (input.creditLimit !== undefined) patch.creditLimit = input.creditLimit;
  if (input.tags !== undefined) patch.tags = input.tags;
  t.update(schema.customers).set(patch).where(eq(schema.customers.id, id)).run();
  fx.emit({ topic: 'customers', kind: 'updated', byUserId: actor.user.id });
}

/** Damga kartı: hedefe ulaşan müşteriye bir içecek ikram edilir, damga hedef kadar düşer. */
export function redeemStamps(t: Tx, actor: Actor, fx: Effects, customerId: string, goal: number) {
  need(actor, 'siparis.ikram');
  const c = t.select().from(schema.customers).where(eq(schema.customers.id, customerId)).get();
  if (!c) throw notFound('Müşteri');
  if (c.stamps < goal) throw conflict(`${c.name}: ${c.stamps}/${goal} damga; hediye için yetmez`);
  t.update(schema.customers).set({ stamps: sql`${schema.customers.stamps} - ${goal}` }).where(eq(schema.customers.id, customerId)).run();
  fx.audit(t, { userId: actor.user.id, action: 'customer.stamps', entity: 'customer', entityId: customerId, message: `${c.name} ${goal} damgayı hediye içecekle kullandı` });
  fx.emit({ topic: 'customers', kind: 'stamps', byUserId: actor.user.id });
}

export function customerDetail(t: Tx | DB, id: string) {
  const c = t.select().from(schema.customers).where(eq(schema.customers.id, id)).get();
  if (!c) throw notFound('Müşteri');
  const ledger = t.select().from(schema.customerLedger).where(eq(schema.customerLedger.customerId, id)).orderBy(desc(schema.customerLedger.createdAt)).limit(100).all();
  const addresses = t.select().from(schema.customerAddresses).where(eq(schema.customerAddresses.customerId, id)).all();
  const orders = t
    .select({ id: schema.orders.id, no: schema.orders.no, total: schema.orders.total, openedAt: schema.orders.openedAt, status: schema.orders.status, type: schema.orders.type })
    .from(schema.orders)
    .where(eq(schema.orders.customerId, id))
    .orderBy(desc(schema.orders.openedAt))
    .limit(30)
    .all();
  return { customer: c, ledger, addresses, orders, balanceText: tl(c.balance) };
}

export function addAddress(t: Tx, actor: Actor, customerId: string, input: { title: string; address: string; note?: string | null }) {
  need(actor, 'cari.yonet');
  if (!input.address.trim()) throw bad('Adres yazılmalı');
  t.insert(schema.customerAddresses).values({ id: ulid(), customerId, title: input.title.trim() || 'Ev', address: input.address.trim(), note: input.note?.trim() || null }).run();
}
