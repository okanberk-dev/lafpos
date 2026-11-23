import { Hono } from 'hono';
import { z } from 'zod';
import { db, tx } from '../db/client';
import { type AppEnv, actorFrom, blindOrder, requirePermission } from '../lib/auth';
import { Effects } from '../lib/effects';
import { body, conflict, HttpError } from '../lib/http';
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
  takeEodSlip,
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
import { claimStoreCopy, pendingStoreCopies, storeCopyPrinted } from '../okc/store-copy';
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
      /** Pavo: ödeme türü cihazda önceden seçili */
      pavoOdemeSecili: z.boolean().optional(),
      pavoEodFis: z.boolean().optional(),
      /** Ödemeyi alınca cihaza gönder (kasada ödeme); null: varsayılan (gerçek cihazda açık, eğitim cihazında kapalı) */
      auto: z.boolean().nullable().optional(),
    }),
  );
  const user = c.get('user');
  const prev = getSettings();
  // Pavo yalnız kasada ödeme bilir (cihaz açık hesap listesi tutmaz)
  const mode = input.provider === 'pavo' ? 'anlik' : input.mode;
  if (input.mode === 'liste' && (input.provider ?? prev.okcProvider) === 'pavo') throw conflict('Pavo yalnız kasada ödemeyle çalışır', 'okc_mode');
  const providerChanged = !!input.provider && input.provider !== prev.okcProvider;
  const modeChanged = !!mode && mode !== prev.okcMode;
  // Sağlayıcı ve mod mali sonucu değiştirir (fiş kesilir mi, gün eğitim günü mü): yalnız patron, eski → yeni kayıtla
  if ((providerChanged || modeChanged) && user.role !== 'patron') throw new HttpError(403, 'Yazarkasa sağlayıcısını ve modunu yalnız patron değiştirir', 'patron_only');
  // Gerçek kullanım başladıktan sonra eğitim cihazına geçilmez: o gün eğitim günü sayılır, fişsiz kapanır
  if (providerChanged && input.provider === 'simulator' && prev.liveSince != null) throw new HttpError(422, 'Gerçek kullanım başladı: eğitim cihazına geçilmez. Cihaz arızalıysa Kapalı’yı seçin', 'live');
  const fx = new Effects();
  tx((t) => {
    updateSettings(
      {
        ...(input.provider ? { okcProvider: input.provider } : {}),
        ...(mode ? { okcMode: mode } : {}),
        ...(input.sectionMap ? { okcSectionMap: input.sectionMap } : {}),
        ...(input.operatorMethods ? { okcOperatorMethods: input.operatorMethods } : {}),
        ...(input.pavoAutoEod !== undefined ? { okcPavoAutoEod: input.pavoAutoEod } : {}),
        ...(input.pavoOdemeSecili !== undefined ? { okcPavoOdemeSecili: input.pavoOdemeSecili } : {}),
        ...(input.pavoEodFis !== undefined ? { okcPavoEodFis: input.pavoEodFis } : {}),
        ...(input.auto !== undefined ? { okcAuto: input.auto } : {}),
      },
      t,
    );
    if (providerChanged || modeChanged) {
      const parts = [providerChanged ? `sağlayıcı ${prev.okcProvider} → ${input.provider}` : null, modeChanged ? `mod ${prev.okcMode} → ${mode}` : null].filter(Boolean);
      fx.audit(t, {
        userId: user.id,
        action: 'okc.settings',
        severity: 'uyari',
        entity: 'settings',
        entityId: 'okc',
        message: `${user.name} yazarkasa ayarını değiştirdi: ${parts.join(', ')}`,
        data: { from: { provider: prev.okcProvider, mode: prev.okcMode }, to: { provider: input.provider ?? prev.okcProvider, mode: mode ?? prev.okcMode } },
      });
    }
  });
  fx.emit({ topic: 'settings', kind: 'settings.updated', byUserId: user.id });
  fx.flush();
  return c.json(okcStatus(user));
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

/**
 * Cihazda alınan son banka gün sonunun kâğıdı (fiş yazıcısı): batch başına bir kez, yalnız ilk soran kasa ekranına
 * verilir; basılacak bir şey yoksa `slip: null`. Kapanan günün Z'si kasa uçlarının kuralıyla (kör kasada `z: null`)
 */
okcRoutes.post('/eod/slip', (c) => {
  requirePermission(c.get('user'), 'odeme.al');
  return c.json({ slip: takeEodSlip(c.get('user')) });
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
  const input = await body(
    c,
    z.object({
      items: z.array(z.object({ itemId: z.string(), qty: z.number().int().min(1) })).nullish(),
      /** Gönderen ekran ödemeden sonra işyeri nüshası basan kasa ekranı: cihaz ödeyince nüsha sunucuda bekler */
      storeCopy: z.boolean().optional(),
      /** Kasada seçilen ödeme türü: Pavo'da cihazda önceden seçili gelir */
      odeme: z.enum(['nakit', 'kart']).optional(),
    }),
  );
  const actor = actorFrom(c);
  const receipt = await sendOrderToDevice(actor, c.req.param('id'), input.items?.length ? input.items : null, { storeCopy: input.storeCopy, odeme: input.odeme });
  return c.json({ receipt, order: blindOrder(c.get('user'), getOrderDTO(db, c.req.param('id'))) });
});

// ─── İşyeri nüshası (cihaz ödemesi; okc/store-copy.ts) ─────────────────────────

/** Basılmayı bekleyen nüshalar: kasa ekranı açılınca ve canlı bağlantı yeniden kurulunca sorar */
okcRoutes.get('/store-copies', (c) => {
  requirePermission(c.get('user'), 'odeme.al');
  return c.json(pendingStoreCopies());
});

/** Nüshayı bu ekran alır (atomik); başka ekran aldıysa 409 copy_taken */
okcRoutes.post('/store-copies/:id/claim', (c) => c.json(claimStoreCopy(actorFrom(c), c.req.param('id'))));

/** Nüsha basıldı (alışın anahtarıyla) */
okcRoutes.post('/store-copies/:id/printed', async (c) => {
  const input = await body(c, z.object({ claim: z.string().min(1).max(64) }));
  return c.json(storeCopyPrinted(actorFrom(c), c.req.param('id'), input.claim));
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
