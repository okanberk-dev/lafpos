import { eq } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import { Effects } from '../lib/effects';
import { requireSiteLinked } from './laffogato-link';
import { applyMenu, cdnStale, fetchPanelMenu, fetchPublicMenu, type MenuPreview, type PanelRead, previewMenu, recordMenuSync } from './laffogato-menu';
import { settleSiteWrites, withSiteMenuLock } from './site-outbox';

let running: Promise<unknown> | null = null;

function stations() {
  const all = db.select().from(schema.stations).where(eq(schema.stations.active, true)).all();
  return { barStationId: all.find((s) => s.kind === 'bar')?.id ?? null, kitchenStationId: all.find((s) => s.kind === 'mutfak')?.id ?? null };
}

/**
 * Site menüsünü çeker; `apply` true ise uygular. Aynı anda tek senkron çalışır.
 * Otomatik senkron (zamanlayıcı) uygular ve değişiklikleri denetim kaydına yazar; elle senkron önce önizler.
 */
export async function runMenuSync(opts: { apply: boolean; force?: boolean; userId?: string | null; userName?: string }): Promise<{
  status: 'degismedi' | 'onizleme' | 'uygulandi';
  preview?: MenuPreview;
  result?: { created: number; updated: number; deactivated: number; reactivated: number };
  /** İmzalı panel alınamadı: ad, KDV ve yeni ürünler uygulandı; Satışta bilgisi ve bağlı ürünlerin fiyatı değişmedi */
  warning?: string;
  /** CDN'deki herkese açık liste bayat: ETag yazılmadı, çağıran kısa süre sonra bir kez ETag'siz yeniden eşitler */
  cdnStale?: boolean;
}> {
  // Bağlantı yoksa (LAFFOGATO_URL) hiçbir istek gitmez; durum kaydına hata da yazılmaz, "kurulmadı" hata değildir
  requireSiteLinked();
  if (running) await running.catch(() => undefined);
  const job = (async () => {
    try {
      // Herkese açık menü kilidin dışında (CDN, ETag): Tükendi dokunuşu bu isteği beklemez
      const fetched = await fetchPublicMenu(opts.force);
      if (fetched.status === 'degismedi') {
        recordMenuSync({ changes: 0 });
        return { status: 'degismedi' as const };
      }
      // Panel okuması ile uygulama siteye Satışta yazımlarıyla aynı kilitte: istek yoldayken kasada basılan Tükendi,
      // yazımdan önceki panel görüntüsüyle geri alınmaz (server/sync/site-outbox.ts)
      return await withSiteMenuLock(async () => {
        // Anahtar varken Satışta bilgisinin ve fiyatın taze kaynağı imzalı panel (CDN'deki liste bayat olabilir; kasanın
        // şubesinin fiyatı yalnız oradadır, herkese açık liste Tuzla'nın). Alınamazsa ad, KDV ve yeni ürünler yine
        // uygulanır, ürünlerin Satışta bilgisine ve bağlı ürünlerin fiyatına dokunulmaz (son imzalı fiyat kalır); hata
        // durum kaydına düşer (Entegrasyon) ve ETag yazılmaz, sonraki tur yeniden dener
        let read: PanelRead | null = null;
        let panelError: string | null = null;
        try {
          read = await fetchPanelMenu();
        } catch (e) {
          panelError = e instanceof Error ? e.message : String(e);
        }
        const panel = read?.items ?? null;
        const keep = panelError !== null;
        const held = keep ? new Set<string>() : settleSiteWrites(db, panel);
        const preview = previewMenu(db, fetched.menu, { panel, keep, held });
        const stale = cdnStale(db.select({ extId: schema.products.extId }).from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all(), fetched.menu, panel);
        const warning = panelError ? `Satışta ve fiyat bilgisi alınamadı, ürünlerin Satışta durumu ve fiyatı değişmedi: ${panelError}` : null;
        if (!opts.apply) return { status: 'onizleme' as const, preview, ...(warning ? { warning } : {}) };
        const fx = new Effects();
        const result = tx((t) => {
          const r = applyMenu(t, fetched.menu, { ...stations(), panel, keep, held });
          if (preview.changes.length || preview.newCategories.length) {
            fx.audit(t, {
              userId: opts.userId ?? null,
              action: 'menu.sync',
              message: `Site menüsü ${opts.userName ? `${opts.userName} tarafından ` : ''}eşitlendi: ${preview.changes.length} değişiklik (${r.created} yeni, ${r.deactivated} satışta değil${r.reactivated ? `, ${r.reactivated} yeniden satışta` : ''})${warning ? '; Satışta ve fiyat bilgisi alınamadı' : ''}`,
              data: { changes: preview.changes.slice(0, 100) },
            });
          }
          return r;
        });
        // ETag liste bayat görünse de yazılır: CDN yenilenince ETag değişir, sonraki yoklama taze listeyi alır (kısa süre
        // sonra bir kez ETag'siz de eşitlenir). Herkese açık liste yalnız sitenin ana şubesinin (Tuzla) Satışta'sını
        // gösterir: Marina'da satılan, Tuzla'da tükenen ürün listede yoktur ve "bayat" görünür; ETag yazılmasaydı her
        // 15 dakikalık yoklama tam liste ve imzalı panel okuması isterdi (laffogato src/lib/mobile/menu.ts)
        // Şube fiyatının bir sonraki anı uygulanan imzalı okumadan (server/jobs.ts o ana bir eşitleme kurar)
        const prices = read ? { prices: { nextPriceAt: read.nextPriceAt, readAt: read.readAt, readLocalAt: read.readLocalAt } } : {};
        recordMenuSync(warning ? { changes: preview.changes.length, error: warning } : { etag: fetched.etag, changes: preview.changes.length, ...prices });
        fx.emit({ topic: 'menu', kind: 'menu.synced' });
        fx.emit({ topic: 'sync', kind: 'menu.synced' });
        fx.flush();
        return { status: 'uygulandi' as const, preview, result, ...(warning ? { warning } : {}), ...(stale ? { cdnStale: true } : {}) };
      });
    } catch (e) {
      recordMenuSync({ error: e instanceof Error ? e.message : String(e) });
      throw e;
    }
  })();
  running = job;
  try {
    return await job;
  } finally {
    running = null;
  }
}
