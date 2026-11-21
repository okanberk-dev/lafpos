import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/client';
import { type AppEnv, actorFrom, blindOrder, requirePermission } from '../lib/auth';
import { body, conflict } from '../lib/http';
import { getSettings, updateSettings } from '../lib/settings';
import {
  cancelDeviceBasket,
  findPavoDevices,
  handleTokenxWebhook,
  okcStatus,
  pairDevice,
  receiptsForOrder,
  refreshReceipt,
  runDeviceEod,
  sendOrderToDevice,
  setPavoDevice,
  simulatorBaskets,
  simulatorCancel,
  simulatorComplete,
  simulatorLock,
  simulatorRecent,
  testProvider,
  tokenx,
  verifyDeviceEod,
  webhookUrl,
} from '../okc/service';
import { getOrderDTO } from '../services/orders';

export const okcRoutes = new Hono<AppEnv>();

okcRoutes.get('/status', (c) => c.json(okcStatus(c.get('user'))));

okcRoutes.put('/settings', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const input = await body(
    c,
    z.object({
      provider: z.enum(['kapali', 'tokenx', 'pavo', 'simulator']).optional(),
      mode: z.enum(['anlik', 'liste']).optional(),
      sectionMap: z.record(z.string().regex(/^\d{1,2}$/), z.number().int().min(1).max(99)).optional(),
      operatorMethods: z.record(z.string().regex(/^\d{1,6}$/), z.string()).optional(),
      /** Pavo: gün kapanınca cihazda banka gün sonu */
      pavoAutoEod: z.boolean().optional(),
    }),
  );
  // Pavo yalnız kasada ödeme bilir (cihaz açık hesap listesi tutmaz)
  const mode = input.provider === 'pavo' ? 'anlik' : input.mode;
  if (input.mode === 'liste' && (input.provider ?? getSettings().okcProvider) === 'pavo') throw conflict('Pavo yalnız kasada ödemeyle çalışır', 'okc_mode');
  updateSettings({
    ...(input.provider ? { okcProvider: input.provider } : {}),
    ...(mode ? { okcMode: mode } : {}),
    ...(input.sectionMap ? { okcSectionMap: input.sectionMap } : {}),
    ...(input.operatorMethods ? { okcOperatorMethods: input.operatorMethods } : {}),
    ...(input.pavoAutoEod !== undefined ? { okcPavoAutoEod: input.pavoAutoEod } : {}),
  });
  return c.json(okcStatus(c.get('user')));
});

/**
 * Pavo cihazında banka gün sonu (elle ya da başarısız denemenin yenisi): gün sonu yetkisi (`kasa.gun`). Cihazın
 * hatası 502; tutarlar kör kasada gitmez (`kasa.rakam`)
 */
okcRoutes.post('/eod', async (c) => {
  requirePermission(c.get('user'), 'kasa.gun');
  const input = await body(c, z.object({ print: z.boolean().optional(), force: z.boolean().optional() }));
  return c.json(await runDeviceEod(actorFrom(c), input));
});

/** Cihazın son gün sonunu sorar (slip basılmaz); belirsiz ya da alınamayan deneme cihazdakine göre düzelir */
okcRoutes.post('/eod/verify', async (c) => {
  requirePermission(c.get('user'), 'kasa.gun');
  return c.json(await verifyDeviceEod(actorFrom(c)));
});

okcRoutes.post('/test', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(await testProvider());
});

/** Pavo eşleştirmesi: cihazda onay ekranı açılır (kasiyer onaylayana dek, en çok 2 dk) */
okcRoutes.post('/pair', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  return c.json(await pairDevice(actorFrom(c)));
});

/**
 * Pavo cihazının adresi ve seri numarası: yönetimden girilir (ayarlar dosyasına gerek yok). Değişince eşleştirme
 * sıfırlanır; cihaz meşgulken ya da sonucu beklenen sepet varken 409
 */
okcRoutes.put('/pavo', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const input = await body(c, z.object({ address: z.string().max(200), serial: z.string().max(60) }));
  setPavoDevice(actorFrom(c), input);
  return c.json(okcStatus(c.get('user')));
});

/** Yerel ağda Pavo arar: REST portu açık ve `/Ping`'e yanıt veren adresler (birkaç saniye sürer) */
okcRoutes.post('/pavo/find', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const input = await body(c, z.object({ serial: z.string().max(60).nullish() }));
  return c.json(await findPavoDevices(input.serial));
});

/** Webhook adresini Token'a kaydeder (LAFPOS_PUBLIC_URL ve TOKENX_WEBHOOK_SECRET gerekir) */
okcRoutes.post('/webhook/register', async (c) => {
  requirePermission(c.get('user'), 'ayar.yonet');
  const url = webhookUrl();
  const secret = process.env.TOKENX_WEBHOOK_SECRET ?? '';
  const client = tokenx();
  if (!client) throw conflict('TokenX bilgileri eksik');
  if (!url || secret.length < 16) throw conflict('LAFPOS_PUBLIC_URL ve en az 16 karakterlik TOKENX_WEBHOOK_SECRET tanımlanmalı');
  await client.setClientSettings(url, `Bearer ${secret}`);
  return c.json({ ok: true, url });
});

okcRoutes.post('/orders/:id/send', async (c) => {
  const input = await body(c, z.object({ items: z.array(z.object({ itemId: z.string(), qty: z.number().int().min(1) })).nullish() }));
  const actor = actorFrom(c);
  const receipt = await sendOrderToDevice(actor, c.req.param('id'), input.items?.length ? input.items : null);
  return c.json({ receipt, order: blindOrder(c.get('user'), getOrderDTO(db, c.req.param('id'))) });
});

okcRoutes.get('/orders/:id/receipts', (c) => c.json(receiptsForOrder(c.req.param('id'))));

okcRoutes.post('/receipts/:id/cancel', async (c) => {
  const input = await body(c, z.object({ force: z.boolean().optional(), approverPin: z.string().nullish() }));
  const actor = actorFrom(c, input.approverPin);
  return c.json(await cancelDeviceBasket(actor, c.req.param('id'), input.force));
});

okcRoutes.post('/receipts/:id/refresh', async (c) => c.json(await refreshReceipt(c.req.param('id'))));

// ─── Simülatör (eğitim cihazı) ──────────────────────────────────────────────

okcRoutes.get('/simulator/baskets', (c) => c.json(simulatorBaskets()));
okcRoutes.get('/simulator/recent', (c) => c.json(simulatorRecent()));

okcRoutes.post('/simulator/baskets/:id/pay', async (c) => {
  const input = await body(
    c,
    z.object({ payments: z.array(z.object({ type: z.number().int(), amount: z.number().int().min(1), operatorId: z.number().int().optional() })).min(1).max(10) }),
  );
  return c.json(simulatorComplete(actorFrom(c), c.req.param('id'), input.payments));
});

okcRoutes.post('/simulator/baskets/:id/cancel', async (c) => {
  const input = await body(c, z.object({ voidReceipt: z.boolean().optional(), approverPin: z.string().nullish() }));
  return c.json(simulatorCancel(actorFrom(c, input.approverPin), c.req.param('id'), input.voidReceipt));
});

okcRoutes.post('/simulator/baskets/:id/lock', async (c) => {
  const input = await body(c, z.object({ locked: z.boolean() }));
  simulatorLock(actorFrom(c), c.req.param('id'), input.locked);
  return c.json({ ok: true });
});

/** Token'ın webhook'u: oturumsuz, `Authorization: Bearer <TOKENX_WEBHOOK_SECRET>` ile */
export const okcPublicRoutes = new Hono<AppEnv>();
okcPublicRoutes.post('/tokenx/webhook', async (c) => {
  let payload: unknown = null;
  try {
    payload = await c.req.json();
  } catch {
    payload = null;
  }
  return c.json(handleTokenxWebhook(c.req.header('authorization'), payload));
});
