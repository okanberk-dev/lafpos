import { existsSync, readFileSync } from 'node:fs';
import { kasaBakim } from './lib/kasa-bakim';
import { relative, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { z } from 'zod';
import { env } from './env';
import { type AppEnv, authMiddleware, can, clientKey } from './lib/auth';
import { escposRaster, printerAddress, RASTER_MAX_HEIGHT, RASTER_WIDTH, sendRaw } from './lib/escpos';
import { activityMiddleware, busyNow } from './lib/mesgul';
import { body, constraintError, HttpError } from './lib/http';
import { adminRoutes } from './routes/admin';
import { authRoutes } from './routes/auth';
import { cashRoutes } from './routes/cash';
import { eventRoutes } from './routes/events';
import { customerRoutes } from './routes/customers';
import { displayPublicRoutes, displayRoutes } from './routes/display';
import { pavoEodRunning } from './okc/providers/pavo';
import { okcPublicRoutes, okcRoutes } from './routes/okc';
import { platformRoutes } from './routes/platforms';
import { posRoutes } from './routes/pos';
import { reportRoutes } from './routes/reports';
import { reservationRoutes } from './routes/reservations';
import { syncRoutes } from './routes/sync';
import { productImage, thumbFor } from './services/media';
import { getOpenDay } from './services/orders';
import { merkezTarget } from './sync/merkez';
import { db } from './db/client';
import { installedVersion, isLoopback } from './lib/surum';
import { getSettings, getSyncState, setSyncState } from './lib/settings';
import { parsePrinters, pickReceiptPrinter, PRINTERS_KEY, type WinPrinter } from './lib/yazici';

export function createApp() {
  const app = new Hono<AppEnv>();

  app.onError((err, c) => {
    if (err instanceof HttpError) {
      return c.json({ error: err.message, code: err.code ?? null, ...(err.extra ?? {}) }, err.status);
    }
    const constraint = constraintError(err);
    if (constraint) {
      console.warn('[kısıt]', c.req.method, c.req.path, err.message);
      return c.json({ error: constraint.message, code: constraint.code ?? null }, constraint.status);
    }
    console.error('[hata]', c.req.method, c.req.path, err);
    return c.json({ error: 'Beklenmeyen bir hata oluştu', code: 'internal' }, 500);
  });

  app.use('/api/*', async (c, next) => {
    await next();
    c.header('cache-control', 'no-store');
  });
  app.use('/api/*', authMiddleware);
  // Satış/ödeme yazmaları sayılır: güncelleme satış sürerken kurulmaz (lib/mesgul.ts)
  app.use('/api/*', activityMiddleware);

  // Derleme numarası: güncelleyici yeni sürümün gerçekten açıldığını buradan anlar (guncelle.mjs)
  app.get('/api/health', (c) => c.json({ ok: true, time: Date.now(), build: installedVersion().build }));
  // Güncelleyicinin (bekçi) sorusu: açık iş günü var mı. Oturumsuz; yalnız bu bilgisayardan (yerel ağdaki ya da
  // Tailscale'deki cihaz 403 alır), yanıtta gün açık mı dışında bir şey yok
  app.get('/api/kasa/guncelleme-durumu', (c) => {
    if (!isLoopback(clientKey(c))) return c.json({ error: 'Yalnız bu bilgisayardan', code: 'forbidden' }, 403);
    // Merkez'in hedefi: güncelleyici yalnız bu derlemeye kadar kurar (Merkez kapalıysa kanalın son sürümü)
    // `mesgul`: satış ya da ödeme sürüyor; güncelleyici gün açıkken (Şimdi güncelle) kurmadan önce bunu bekler.
    // `eod`: cihazda banka gün sonu sürüyor (gün kapanınca arka planda, en çok 3 dk); gün kapalıyken güncelleyici
    // yalnız bunu bekler, sunucu yeniden başlayıp gün sonunu belirsiz bırakmasın (inceleme, 23 Kas 2026)
    return c.json({ dayOpen: !!getOpenDay(db), merkez: merkezTarget(), mesgul: busyNow(), eod: pavoEodRunning() });
  });

  // Kasa bekçisinin sorusu (app\kasa-yazici.ps1): kasa penceresinin bakım arası sürüyor mu (lib/kasa-bakim.ts). Oturumsuz;
  // yalnız bu bilgisayardan. `active` iken (`until`'e dek) bekçi kapatılan kasa penceresini yeniden açmaz
  app.get('/api/kasa/bakim', (c) => {
    if (!isLoopback(clientKey(c))) return c.json({ error: 'Yalnız bu bilgisayardan', code: 'forbidden' }, 403);
    const b = kasaBakim();
    // `active` sunucunun saatiyle: bekçi kendi saatini karşılaştırmaz
    return c.json({ until: b?.until ?? null, active: !!b });
  });

  // Kasa kısayolunun yazıcı betiği (app\kasa-yazici.ps1, oturumdaki kullanıcı): bilgisayardaki yazıcıları bildirir, yanıtta
  // varsayılan yapılacak fiş yazıcısının adı. Oturumsuz; yalnız bu bilgisayardan (lib/yazici.ts)
  app.post('/api/kasa/yazicilar', async (c) => {
    if (!isLoopback(clientKey(c))) return c.json({ error: 'Yalnız bu bilgisayardan', code: 'forbidden' }, 403);
    let raw: unknown = null;
    try {
      raw = await c.req.json();
    } catch {
      raw = null;
    }
    const reported = parsePrinters((raw as { printers?: unknown } | null)?.printers ?? raw);
    // Boş liste (Windows yazıcı sorgusu açılışta ya da kurulumda zaman aşımına uğradı) bilinen listeyi silmez: silseydi
    // seçili fiş yazıcısı "Seçilmedi"ye düşer, ödeme sonrası fişler basılmazdı (saha, 22 Kas 2026)
    const known = getSyncState<{ at: number; printers: WinPrinter[] }>(PRINTERS_KEY);
    const chosen = getSettings().receiptPrinter;
    const keep = known?.printers?.find((p) => p.name === chosen);
    // Seçili yazıcı bu bildirimde yoksa (ağ yazıcısı açılışta henüz bağlanmadı) listede kalır: seçim "Seçilmedi"ye düşmez
    const printers = !reported.length && known?.printers?.length ? known.printers : keep && !reported.some((p) => p.name === keep.name) ? [...reported, keep] : reported;
    setSyncState(PRINTERS_KEY, { at: reported.length ? Date.now() : (known?.at ?? Date.now()), printers });
    return c.json({ name: pickReceiptPrinter(printers, getSettings().receiptPrinter).name });
  });

  // Fişi yazdırma penceresi açmadan basar (lib/escpos.ts): arayüzün çizdiği 1 bitlik görüntü seçili fiş yazıcısının ağ
  // adresine (portu IP'li Standard TCP/IP, RAW 9100) gider, her istek ayrı kesilir. Oturum gerekir; bu bilgisayardan ya
  // da ödeme alan veya ayar yöneten kişiden. Adres yoksa ya da yazıcıya ulaşılamazsa hata döner: arayüz tarayıcıdan basar
  app.post('/api/kasa/fis', async (c) => {
    const user = c.get('user');
    if (!isLoopback(clientKey(c)) && !can(user, 'odeme.al') && !can(user, 'ayar.yonet')) throw new HttpError(403, 'Bu işlem için yetkiniz yok', 'forbidden');
    const maxBytes = (RASTER_WIDTH / 8) * RASTER_MAX_HEIGHT;
    if (Number(c.req.header('content-length') ?? 0) > maxBytes * 1.4 + 1024) throw new HttpError(422, 'Fiş görüntüsü çok büyük', 'too_large');
    // Yazıcının ağ adresi gövdeden önce: adresi olmayan (USB) yazıcıda her fiş en çok ~200 KB'lik gövde okunup
    // çözüldükten sonra 409 alıyordu; arayüz zaten tarayıcıdan basar (inceleme, 23 Kas 2026)
    const seen = getSyncState<{ at: number; printers: WinPrinter[] }>(PRINTERS_KEY);
    const name = pickReceiptPrinter(seen?.printers ?? [], getSettings().receiptPrinter).name;
    const addr = printerAddress(seen?.printers.find((p) => p.name === name)?.port);
    if (!name || !addr) throw new HttpError(409, 'Fiş yazıcısının ağ adresi yok', 'no_printer_address');
    const input = await body(
      c,
      z.object({
        width: z.literal(RASTER_WIDTH),
        height: z.number().int().min(1).max(RASTER_MAX_HEIGHT),
        data: z.string().max(Math.ceil(maxBytes / 3) * 4).regex(/^[A-Za-z0-9+/]*={0,2}$/),
      }),
    );
    // Biçime uyan ama çözülemeyen base64 ("A" gibi: uzunluğu 4'e tamamlanamaz) 500 değil, geçersiz görüntüdür
    let bits: Uint8Array;
    try {
      bits = Uint8Array.from(atob(input.data), (ch) => ch.charCodeAt(0));
    } catch {
      throw new HttpError(422, 'Fiş görüntüsü çözülemedi', 'validation');
    }
    if (bits.length !== (input.width / 8) * input.height) throw new HttpError(422, 'Fiş görüntüsünün boyu tutmuyor', 'validation');
    try {
      await sendRaw(addr, escposRaster({ width: input.width, height: input.height, bits }));
    } catch (e) {
      console.warn('[fiş yazıcısı]', addr.host, e instanceof Error ? e.message : e);
      throw new HttpError(502, 'Fiş yazıcısına ulaşılamadı', 'printer_unreachable');
    }
    return c.json({ ok: true, printer: name });
  });

  // Ürün kartındaki görselin küçük kopyası. /api dışında: tarayıcı önbelleğe alır, <img> oturum taşımaz;
  // görseller sitede de herkese açık. Adres değişince arayüz ?v= ile yenisini ister
  app.get('/media/products/:id', async (c) => {
    const thumb = await thumbFor(productImage(c.req.param('id')) ?? '');
    if (!thumb) return c.body(null, 404);
    return c.body(new Uint8Array(thumb.body), 200, { 'content-type': thumb.type, 'cache-control': 'public, max-age=604800' });
  });
  app.route('/api/auth', authRoutes);
  app.route('/api/events', eventRoutes);
  app.route('/api/cash', cashRoutes);
  app.route('/api/okc', okcRoutes);
  app.route('/api/public/okc', okcPublicRoutes);
  app.route('/api/customers', customerRoutes);
  app.route('/api/sync', syncRoutes);
  app.route('/api/display', displayRoutes);
  app.route('/api/public', displayPublicRoutes);
  app.route('/api/reports', reportRoutes);
  app.route('/api/admin', adminRoutes);
  app.route('/api/reservations', reservationRoutes);
  app.route('/api/platforms', platformRoutes);
  app.route('/api', posRoutes);
  app.all('/api/*', (c) => c.json({ error: 'Böyle bir uç yok', code: 'not_found' }, 404));

  // Üretimde derlenmiş arayüz aynı porttan sunulur (tek süreç)
  if (existsSync(env.webDist)) {
    const root = relative(process.cwd(), env.webDist) || '.';
    const indexHtml = readFileSync(resolve(env.webDist, 'index.html'), 'utf8');
    app.use('/*', serveStatic({ root }));
    // Olmayan derleme dosyası 404'tür: arayüz sayfası JS yerine dönerse tarayıcı boş ekranda kalır (güncellemeden sonra)
    app.get('/assets/*', (c) => c.text('Bulunamadı', 404));
    app.get('*', (c) => c.html(indexHtml));
  }
  return app;
}
