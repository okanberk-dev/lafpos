import { Hono } from 'hono';
import { afterDayClose, afterDeviceEod } from '../sync/bildirim';
import { staleDayMessage } from '@shared/time';
import { z } from 'zod';
import { asc, eq } from 'drizzle-orm';
import type { ShiftCountDTO } from '@shared/types';
import { db, schema } from '../db/client';
import { type AppEnv, type AuthUser, actorFrom, can, requirePermission, seesCashNumbers } from '../lib/auth';
import { body, kurus, query } from '../lib/http';
import { summaryFor } from '../lib/kor-kasa';
import {
  addCashMovement,
  closeDay,
  closedToday,
  collectCustomerPayment,
  computeSummary,
  dayToDTO,
  getDay,
  lafmaliyetZ,
  listDays,
  openDay,
  recordCount,
  recordShiftCount,
  reopenDay,
  shiftCountsOf,
  shiftCountToDTO,
} from '../services/days';
import { deviceEndOfDay } from '../okc/service';
import { afterDayClosed, enqueueDay, flushOutbox } from '../sync/lafmaliyet';
import { onlineOrdersDayOpened } from '../sync/laffogato-orders';
import { getOpenDay } from '../services/orders';
import { write } from './pos';

export const cashRoutes = new Hono<AppEnv>();

const userNames = () => new Map(db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).all().map((u) => [u.id, u.name]));

function movementsOf(dayId: string) {
  const names = userNames();
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
const seesNumbers = seesCashNumbers;

// Personel tutarlarının süzgeci (`summaryFor`) lib/kor-kasa.ts'te: fiş yazıcısının gün sonu kâğıdı da onu kullanır

/**
 * Vardiya sayımı kişiye göre: kör kasada beklenen nakit ve fark gitmez (sayılandan çıkarılıp beklenen nakit
 * bulunmasın); sayılan tutar ve banknotlar yalnız sayana ve devralana.
 */
function blindShiftCount(user: AuthUser, s: ShiftCountDTO): ShiftCountDTO {
  if (seesNumbers(user)) return s;
  const own = s.userId === user.id || s.toUserId === user.id;
  return { ...s, expected: null, diff: null, shiftDiff: null, ...(own ? {} : { counted: null, banknotes: null }) };
}

/** Vardiya devirlerini kasa ekranını kullanan görür (Kasa'nın yetkileri); kurye, mutfak, yalnız garson görmez (notlar) */
const SHIFT_COUNT_READERS = ['kasa.gun', 'kasa.hareket', 'odeme.al', 'rapor.gor'] as const;
const readsShiftCounts = (user: AuthUser) => SHIFT_COUNT_READERS.some((p) => can(user, p));

function shiftCountsFor(user: AuthUser, dayId: string): ShiftCountDTO[] {
  if (!readsShiftCounts(user)) return [];
  const names = userNames();
  return shiftCountsOf(db, dayId).map((s, i, all) => blindShiftCount(user, shiftCountToDTO(s, names, i ? all[i - 1].diff : 0)));
}

/** Açık gün, ara rapor (X) ve kasa hareketleri */
cashRoutes.get('/day', (c) => {
  const user = c.get('user');
  const day = getOpenDay(db);
  const blind = !seesNumbers(user);
  if (!day) {
    const closed = closedToday(db);
    return c.json({ day: null, summary: null, movements: [], shiftCounts: [], blind, closedToday: closed ? dayToDTO(db, closed) : null });
  }
  // Dünden açık kalan gün: yeni satış reddedilir (409 stale_day), kasa aynı metni bant olarak gösterir
  return c.json({
    day: dayToDTO(db, day),
    summary: blind ? null : summaryFor(user, computeSummary(db, day)),
    movements: movementsOf(day.id),
    shiftCounts: shiftCountsFor(user, day.id),
    blind,
    stale: staleDayMessage(day),
  });
});

/**
 * Vardiya kasa sayımı: kasiyer değişirken devreden kasayı sayar (açık ve bugünün günü, `kasa.gun`). `approverPin`
 * devralanın PIN'idir: verilirse devir onaylanır, `toUserId` yoksa PIN'in sahibi devralır.
 */
cashRoutes.post('/shift-counts', async (c) => {
  const input = await body(
    c,
    z.object({
      countedCash: kurus,
      banknotes: z.record(z.string().regex(/^\d{1,7}$/), z.number().int().min(0).max(100000)).optional(),
      note: z.string().max(500).nullish(),
      toUserId: z.string().max(40).nullish(),
      approverPin: z.string().nullish(),
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  const row = write((t, fx) => recordShiftCount(t, actor, fx, input));
  return c.json(shiftCountsFor(c.get('user'), row.dayId).find((s) => s.id === row.id));
});

/** Günün vardiya sayımları (varsayılan açık gün); başka bir günün sayımları rapor yetkisi ister */
cashRoutes.get('/shift-counts', (c) => {
  const user = c.get('user');
  const q = query(c, z.object({ dayId: z.string().max(40).optional() }));
  if (!readsShiftCounts(user)) requirePermission(user, 'kasa.gun');
  const open = getOpenDay(db);
  if (q.dayId && q.dayId !== open?.id) {
    requirePermission(user, 'rapor.gor');
    getDay(db, q.dayId);
  }
  const dayId = q.dayId ?? open?.id;
  return c.json(dayId ? shiftCountsFor(user, dayId) : []);
});

cashRoutes.post('/day/open', async (c) => {
  const input = await body(c, z.object({ openingCash: kurus }));
  const actor = actorFrom(c);
  const day = write((t, fx) => openDay(t, actor, fx, input));
  // Online siparişler hemen çekilir: gece seyrek sorulan sinyal, gün yokken bekleyen liste (beklemeden)
  void onlineOrdersDayOpened();
  return c.json(dayToDTO(db, day));
});

cashRoutes.post('/day/close', async (c) => {
  const input = await body(
    c,
    z.object({ countedCash: kurus.nullable(), cashCounts: z.record(z.string(), z.number().int().min(0)).nullish(), note: z.string().max(500).nullish() }),
  );
  const actor = actorFrom(c);
  // Uzaktan gün sonu (kontrol komutu `gun.sonu`): kasada kişi yok, kapanış sistem kapanışı gibi (closedBy boş: personel
  // tablosuna bağlı). Denetim kaydı isteyenin adıyla, `uzaktan` kimliğiyle: otomatik gün sonuyla karışmasın (inceleme,
  // 23 Kas 2026)
  const remote = actor.user.id === 'uzaktan';
  const day = write((t, fx) => closeDay(t, remote ? null : actor, fx, input, remote ? { userId: actor.user.id, name: actor.user.name } : undefined));
  // Gün lafmaliyet'e gider (bağlıysa, kurulum modunda değilse); maliyetler günde bir yenilenir
  afterDayClosed(day.id);
  // Kasa farkı eşiği geçtiyse patronun telefonuna
  afterDayClose(day.summary, day.zNo);
  // Pavo: cihazda banka gün sonu; beklenmez, cihaz yanıt vermese de gün kapalı kalır (docs/04-YAZARKASA.md §8.5)
  void deviceEndOfDay(day.id, remote ? null : actor.user.id)
    .then(afterDeviceEod)
    .catch((e) => console.warn('[pavo] gün sonu', e instanceof Error ? e.message : e));
  if (!seesNumbers(c.get('user'))) return c.json({ day: dayToDTO(db, day), summary: null, lafmaliyet: null, blind: true });
  return c.json({ day: dayToDTO(db, day), summary: summaryFor(c.get('user'), day.summary), lafmaliyet: day.summary ? lafmaliyetZ(day, day.summary) : null, blind: false });
});

cashRoutes.post('/days/:id/reopen', async (c) => {
  const input = await body(c, z.object({ reason: z.string().max(200), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  const day = write((t, fx) => reopenDay(t, actor, fx, c.req.param('id'), input.reason));
  void onlineOrdersDayOpened();
  return c.json(dayToDTO(db, day));
});

cashRoutes.post('/days/:id/count', async (c) => {
  const input = await body(
    c,
    z.object({
      countedCash: kurus,
      methodCounts: z.record(z.string(), kurus).optional(),
      banknotes: z.record(z.string(), z.number().int().min(0).max(100000)).optional(),
      note: z.string().max(500).nullish(),
      approverPin: z.string().nullish(),
    }),
  );
  const actor = actorFrom(c, input.approverPin);
  const day = write((t, fx) => recordCount(t, actor, fx, c.req.param('id'), input));
  if (enqueueDay(day.id)) void flushOutbox();
  const blind = !seesNumbers(c.get('user'));
  return c.json({ day: dayToDTO(db, day), summary: blind ? null : summaryFor(c.get('user'), day.summary), blind });
});

cashRoutes.post('/movements', async (c) => {
  const input = await body(c, z.object({ kind: z.enum(['harcama', 'teslim', 'giris']), amount: kurus, description: z.string().max(200).default(''), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  write((t, fx) => addCashMovement(t, actor, fx, input));
  return c.json({ ok: true });
});

cashRoutes.post('/collect', async (c) => {
  const input = await body(
    c,
    z.object({
      customerId: z.string(),
      methodId: z.string(),
      amount: kurus,
      note: z.string().max(200).nullish(),
      // Tahsilat denemesinin kimliği (istemci üretir): yeniden gelen istek ikinci kez yazılmaz
      requestId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/).nullish(),
      approverPin: z.string().nullish(),
    }),
  );
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
  return c.json({
    day: dayToDTO(db, day),
    summary: summaryFor(c.get('user'), summary),
    movements: movementsOf(day.id),
    shiftCounts: shiftCountsFor(c.get('user'), day.id),
    lafmaliyet: lafmaliyetZ(day, summary),
    note: day.note,
    cashCounts: day.cashCounts,
  });
});

cashRoutes.get('/days/:id/lafmaliyet.json', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const day = getDay(db, c.req.param('id'));
  const summary = day.summary ?? computeSummary(db, day);
  c.header('content-disposition', `attachment; filename="lafpos-z-${day.date}.json"`);
  return c.json(lafmaliyetZ(day, summary));
});
