import { Hono } from 'hono';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { type AppEnv, can, requirePermission } from '../lib/auth';
import { body, HttpError, isoDate } from '../lib/http';
import { getSyncState, updateSettings } from '../lib/settings';
import { okcStatus } from '../okc/service';
import { backfillDays, buildDayPayload, lafmaliyetStatus, pullCosts, pushDayNow, salesCsv } from '../sync/lafmaliyet';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import { requireSiteLinked, siteLinked, siteSigned } from '../sync/laffogato-link';
import { reportRange } from './reports';
import { refreshSiteKaraoke, siteKaraokeOn, siteKaraokeStatus, siteKaraokeView } from '../sync/laffogato-karaoke';
import { onlineAlertsView, onlineStatus, refreshOnlineOrders, setAvailability, setOnlineStage } from '../sync/laffogato-orders';
import { runMenuSync } from '../sync/menu-sync';
import { ackTableCall, tableCallsView } from '../sync/table-calls';
import { getSettings } from '../lib/settings';
import { eq } from 'drizzle-orm';

export const syncRoutes = new Hono<AppEnv>();

/**
 * Bağlantı durumu: Entegrasyon, Genel bakış ve menü sayacı okur (giriş yapan herkes). Maliyetin tarihi ve hatası yalnız
 * `rapor.maliyet`'e: personel maliyetin varlığını da görmez
 */
syncRoutes.get('/status', (c) => {
  const s = getSettings();
  return c.json({
    menu: { linked: siteLinked(), auto: s.menuAutoSync, state: getSyncState('laffogato.menu') },
    online: onlineStatus(),
    karaoke: siteKaraokeStatus(),
    lafmaliyet: lafmaliyetStatus(can(c.get('user'), 'rapor.maliyet')),
    okc: okcStatus(),
  });
});

syncRoutes.put('/settings', async (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  const input = await body(c, z.object({ menuAutoSync: z.boolean().optional(), onlineOrdersSync: z.boolean().optional() }));
  updateSettings(input);
  return c.json({ ok: true });
});

syncRoutes.post('/menu/preview', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'menu.yonet');
  requireSiteLinked();
  try {
    return c.json(await runMenuSync({ apply: false, force: true }));
  } catch (e) {
    throw new HttpError(502, `Site menüsü alınamadı: ${e instanceof Error ? e.message : e}`, 'site_menu');
  }
});

syncRoutes.post('/menu/apply', async (c) => {
  const user = c.get('user');
  if (!can(user, 'senkron.yonet')) requirePermission(user, 'menu.yonet');
  requireSiteLinked();
  try {
    return c.json(await runMenuSync({ apply: true, force: true, userId: user.id, userName: user.name }));
  } catch (e) {
    throw new HttpError(502, `Site menüsü uygulanamadı: ${e instanceof Error ? e.message : e}`, 'site_menu');
  }
});

/**
 * Sitedeki bugünkü karaoke rezervasyonları (oda kutusu, "Sayacı başlat"): `fresh=1` liste geride kaldıysa önce bir
 * çekim yapar (oda kutusu açılınca), hata eldeki listeyle döner. Bağlantı yoksa `kapali`, istek gitmez
 */
syncRoutes.get('/karaoke', async (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'rezervasyon.yonet');
  const fresh = c.req.query('fresh') === '1';
  return c.json(fresh && siteKaraokeOn() ? await refreshSiteKaraoke() : siteKaraokeView());
});

/** Oda kutusundaki "Yenile": en sık 30 sn'de bir gerçek çekim; site ulaşılamazsa 502 */
syncRoutes.post('/karaoke/refresh', async (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'rezervasyon.yonet');
  return c.json(await refreshSiteKaraoke({ force: true }));
});

/**
 * Cihazın sesli uyarıları (src/components/SiteInbox.tsx): "yeni" aşamasında bekleyen online siparişler (son 4 saat;
 * planlı sipariş saatine göre) ve açık masa çağrıları (15 dk). Yalnız yerel veritabanı; siteye istek atmaz (listeler var
 * olan sipariş çekiminden gelir, §2.5). Siparişi alan ya da bar ekranı yetkisi. Site bağlantısı yoksa `configured:
 * false` ve boş listeler
 */
syncRoutes.get('/alerts', (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'mutfak.ekran');
  return c.json({ configured: siteSigned(), online: onlineAlertsView(), calls: tableCallsView() } satisfies SiteAlertsDTO);
});

/**
 * Masa çağrısına "Gördüm": çağrı sitede yanıtlanır (imzalı `POST /api/panel/calls/ack`, kullanıcı eylemi), denetim
 * kaydına yazılır, bütün cihazlardan düşer. Uyarıyı gören yetki: siparişi alan (garson, kasiyer) ya da bar ekranı. Siteye
 * ulaşılamazsa 502, çağrı açık kalır
 */
syncRoutes.post('/calls/:id/ack', async (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'mutfak.ekran');
  return c.json(await ackTableCall(c.req.param('id'), { id: user.id, name: user.name }));
});

syncRoutes.post('/online/refresh', async (c) => {
  requirePermission(c.get('user'), 'siparis.al');
  return c.json(await refreshOnlineOrders());
});

syncRoutes.post('/online/:orderId/stage', async (c) => {
  const user = c.get('user');
  if (!can(user, 'siparis.al')) requirePermission(user, 'mutfak.ekran');
  const input = await body(c, z.object({ action: z.enum(['preparing', 'ready', 'delivered']) }));
  await setOnlineStage(c.req.param('orderId'), input.action, user.name);
  return c.json({ ok: true });
});

/**
 * Tükendi / Satışa aç: kasiyer de yapabilir (müşteri beklerken menü yöneticisi aranmasın). Sitenin kapattığını
 * yalnız menü yetkisi olan açar (Tükendi kilidi, `products.soldOutBy`)
 */
syncRoutes.post('/products/:id/availability', async (c) => {
  const user = c.get('user');
  const manager = can(user, 'menu.yonet');
  if (!manager) requirePermission(user, 'urun.tukendi');
  const input = await body(c, z.object({ active: z.boolean() }));
  return c.json(await setAvailability(c.req.param('id'), input.active, { name: user.name, manager }));
});

/** Raporlar › Aktarım: dönem raporlarla aynı denetlenir (gerçek tarih, en çok 400 gün, varsayılan açık iş günü) */
syncRoutes.get('/lafmaliyet/satislar.csv', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  const q = reportRange(c);
  c.header('content-type', 'text/csv; charset=utf-8');
  c.header('content-disposition', `attachment; filename="lafpos-satislar-${q.from}_${q.to}.csv"`);
  return c.body(salesCsv(q.from, q.to));
});

syncRoutes.get('/lafmaliyet/gun/:dayId', (c) => {
  requirePermission(c.get('user'), 'rapor.gor');
  return c.json(buildDayPayload(c.req.param('dayId')));
});

syncRoutes.post('/lafmaliyet/gun/:dayId/push', async (c) => {
  const user = c.get('user');
  if (!can(user, 'kasa.gun')) requirePermission(user, 'senkron.yonet');
  const day = db.select().from(schema.businessDays).where(eq(schema.businessDays.id, c.req.param('dayId'))).get();
  if (!day?.closedAt) throw new HttpError(409, 'Yalnız gün sonu alınmış gün gönderilir', 'day_open');
  return c.json(await pushDayNow(day.id));
});

/**
 * Yönetim › Entegrasyon › "Geçmiş günleri gönder": aralıktaki gönderilmemiş kapanmış günler kuyruğa (bağlantı
 * sonradan kurulduysa ya da günler gidemediyse). Kurulum modunda 409 `training_mode`
 */
syncRoutes.post('/lafmaliyet/backfill', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'senkron.yonet');
  const input = await body(c, z.object({ from: isoDate, to: isoDate }));
  return c.json(backfillDays(input, { id: user.id, name: user.name }));
});

/** "Maliyetleri çek": bağlantı yönetimi ve maliyet yetkisi (yanıt kaç ürünün maliyeti geldiğini söyler) */
syncRoutes.post('/lafmaliyet/costs/pull', async (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  requirePermission(c.get('user'), 'rapor.maliyet');
  return c.json(await pullCosts());
});
