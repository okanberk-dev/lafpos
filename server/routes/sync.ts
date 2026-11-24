import { Hono } from 'hono';
import { type NotifySettings, notify, notifySettings, pendingNotices, setNotifySettings } from '../sync/bildirim';
import { tl } from '@shared/money';
import { resendReports } from '../sync/cloud-reports';
import { cloudEnabled } from '../sync/cloud';
import { Effects } from '../lib/effects';
import { licenseNow, merkezLast, merkezSyncState } from '../sync/merkez';
import { z } from 'zod';
import { db, schema } from '../db/client';
import { type AppEnv, type AuthUser, can, requirePermission, seesCashNumbers } from '../lib/auth';
import { body, HttpError, isoDate, patchOf } from '../lib/http';
import { getSyncState, updateSettings } from '../lib/settings';
import { okcStatus } from '../okc/service';
import { answerFor, backfillDays, buildDayPayload, lafmaliyetStatus, pullCosts, pushDayNow, salesCsv } from '../sync/lafmaliyet';
import type { SiteAlertsDTO } from '@shared/site-alerts';
import { requireSiteLinked, siteLinked, siteSigned } from '../sync/laffogato-link';
import { reportRange } from './reports';
import { refreshSiteKaraoke, siteKaraokeOn, siteKaraokeStatus, siteKaraokeView } from '../sync/laffogato-karaoke';
import { onlineAlertsView, onlineStatus, refreshOnlineOrders, setAvailability, setOnlineStage } from '../sync/laffogato-orders';
import { runMenuSync } from '../sync/menu-sync';
import { internetStatus } from '../sync/catch-up';
import { menuStaleError } from '../sync/laffogato-menu';
import { getOpenDay } from '../services/orders';
import { ackTableCall, tableCallsView } from '../sync/table-calls';
import { getSettings } from '../lib/settings';
import { cloudState } from '../sync/cloud';
import { eq } from 'drizzle-orm';

export const syncRoutes = new Hono<AppEnv>();

/** lafmaliyet'in personel yanıtını (kimlikler, adlar) görür mü: bağlantı ya da personel yöneticisi (§4.8) */
const seesStaffRefs = (user: AuthUser) => can(user, 'senkron.yonet') || can(user, 'personel.yonet');

/**
 * Bağlantı durumu: Entegrasyon, Genel bakış ve menü sayacı okur (giriş yapan herkes). Maliyetin tarihi ve hatası yalnız
 * `rapor.maliyet`'e: personel maliyetin varlığını da görmez
 */
syncRoutes.get('/status', (c) => {
  const s = getSettings();
  const state = getSyncState<{ lastSuccessAt?: number; lastError?: string | null }>('laffogato.menu');
  const day = getOpenDay(db);
  // Gün açıkken menü sessizce bayatladıysa (yoklama çalışmadı, hata da yazılmadı) hata gibi gösterilir: kasa eski fiyattan
  // satmasın diye Entegrasyon "Hata" der, yönetim çubuğu sayar
  const stale = menuStaleError({ linked: siteLinked(), auto: s.menuAutoSync, dayOpenedAt: day ? Math.max(day.openedAt, day.reopenedAt ?? 0) : null, state, now: Date.now() });
  return c.json({
    menu: { linked: siteLinked(), auto: s.menuAutoSync, state: stale ? { ...state, lastError: stale } : state },
    online: onlineStatus(),
    karaoke: siteKaraokeStatus(),
    lafmaliyet: lafmaliyetStatus(can(c.get('user'), 'rapor.maliyet'), seesCashNumbers(c.get('user')), seesStaffRefs(c.get('user'))),
    okc: okcStatus(),
    internet: internetStatus(),
    cloud: (({ lastSize: _size, ...cloud }) => cloud)(cloudState()),
  });
});

/**
 * Merkez lisansı (giriş yapan herkes): kasa şeridi ve Yönetim; Merkez kapalıysa `enabled: false`. Şube kodu ve lisansın
 * son günü Uzaktan › Merkez'den gelir (nabzın yanıtı)
 */
syncRoutes.get('/lisans', (c) => {
  const lic = licenseNow();
  const last = merkezLast();
  return c.json({
    enabled: !!lic,
    ...(lic ?? {}),
    ad: last?.ad ?? null,
    kod: last?.kod ?? null,
    bitis: last?.lisans.durum === 'aktif' ? (last.lisans.bitis ?? null) : null,
    sonGorusme: last?.at ?? null,
    ...(can(c.get('user'), 'senkron.yonet') ? { kurulum: merkezSyncState() } : {}),
  });
});

/** Telefon bildirimleri: ayar (eşikler) ve deneme bildirimi */
syncRoutes.get('/bildirim', (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  return c.json({ ready: cloudEnabled(), settings: notifySettings(), pending: pendingNotices() });
});

syncRoutes.put('/bildirim', async (c) => {
  const user = c.get('user');
  requirePermission(user, 'senkron.yonet');
  const tlMax = z.number().int().min(0).max(100_000_000);
  const input = await body(c, patchOf(z.object({ enabled: z.boolean(), voidMin: tlMax, compMin: tlMax, cashDiffMin: tlMax, internetMin: z.number().int().min(1).max(24 * 60), pavo: z.boolean() })));
  const patch = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<NotifySettings>;
  const old = notifySettings();
  const next = { ...old, ...patch };
  // Bildirim tam da büyük iptali ve kasa farkını patrona haber vermek için: kapatmak ya da eşiği yükseltmek yalnız
  // patronun işi. Müdür eşiği düşürebilir (daha çok bildirim)
  if (weakens(old, next) && user.role !== 'patron') throw new HttpError(403, 'Bildirimi kapatmayı ya da eşiği yükseltmeyi yalnız patron yapar', 'forbidden');
  setNotifySettings(patch);
  const fx = new Effects();
  fx.audit(db, { userId: user.id, action: 'ayar', severity: user.role === 'patron' ? 'info' : 'uyari', message: `Telefon bildirimi ayarları değişti: ${notifyDiff(old, next)}` });
  fx.flush();
  return c.json({ ok: true, settings: notifySettings() });
});

/** Ayar bildirimi azaltıyor mu: kapanıyor, bir eşik yükseliyor ya da Pavo bildirimi kapanıyor */
function weakens(a: NotifySettings, b: NotifySettings) {
  return (a.enabled && !b.enabled) || b.voidMin > a.voidMin || b.compMin > a.compMin || b.cashDiffMin > a.cashDiffMin || b.internetMin > a.internetMin || (a.pavo && !b.pavo);
}

/** Denetim kaydı için değişenler, eskisi → yenisi */
function notifyDiff(a: NotifySettings, b: NotifySettings) {
  const onOff = (v: boolean) => (v ? 'açık' : 'kapalı');
  const parts = [
    a.enabled !== b.enabled && `bildirim ${onOff(a.enabled)} → ${onOff(b.enabled)}`,
    a.voidMin !== b.voidMin && `iptal eşiği ${tl(a.voidMin)} → ${tl(b.voidMin)}`,
    a.compMin !== b.compMin && `ikram eşiği ${tl(a.compMin)} → ${tl(b.compMin)}`,
    a.cashDiffMin !== b.cashDiffMin && `kasa farkı eşiği ${tl(a.cashDiffMin)} → ${tl(b.cashDiffMin)}`,
    a.internetMin !== b.internetMin && `internet ${a.internetMin} → ${b.internetMin} dk`,
    a.pavo !== b.pavo && `Pavo ${onOff(a.pavo)} → ${onOff(b.pavo)}`,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : 'değişiklik yok';
}

syncRoutes.post('/bildirim/dene', async (c) => {
  requirePermission(c.get('user'), 'senkron.yonet');
  if (!cloudEnabled()) throw new HttpError(409, 'LafPOS Uzaktan kurulu değil', 'not_configured');
  await notify({ kind: 'deneme', title: 'LafPOS deneme bildirimi', body: 'Kasadan gönderildi; bu bildirimi görüyorsanız telefon hazır' });
  return c.json({ ok: true, pending: pendingNotices() });
});

/** Uzaktan raporları yeniden gönder: gönderim geçmişi sıfırlanır (denetim kaydına yazılır) */
syncRoutes.post('/cloud-reports/resend', (c) => {
  const user = c.get('user');
  requirePermission(user, 'senkron.yonet');
  if (!cloudEnabled()) throw new HttpError(409, 'LafPOS Uzaktan kurulu değil', 'not_configured');
  resendReports();
  const fx = new Effects();
  fx.audit(db, { userId: user.id, action: 'senkron', message: 'Uzaktan raporlar yeniden gönderiliyor' });
  fx.flush();
  return c.json({ ok: true });
});

/** Durum alanının internet satırı (giriş yapan herkes): "İnternet yok · N kayıt bekliyor", "Bekleyenler gönderildi" */
syncRoutes.get('/internet', (c) => {
  const s = internetStatus();
  return c.json({ configured: s.configured, state: s.state, pending: s.pending.total, sent: s.sent });
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
 * yalnız menü yetkisi olan açar (Tükendi kilidi, `products.soldOutBy`). İnternet yokken de çalışır: yerelde hemen
 * geçerli, siteye giden kutusundan gider (`site: 'kuyrukta'`, `neden: 'internet' | 'site'`); sitenin açık reddi (4xx)
 * 502, hiçbir şey değişmez
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
  const r = await pushDayNow(day.id);
  // Yanıttaki devir (ertesi günün beklenen açılışı) kör kasiyere gitmez
  return c.json({ ...r, answer: answerFor(r.answer, seesCashNumbers(user), seesStaffRefs(user)) });
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
