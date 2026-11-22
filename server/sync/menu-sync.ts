import { eq } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import { Effects } from '../lib/effects';
import { requireSiteLinked } from './laffogato-link';
import { applyMenu, cdnStale, fetchPanelMenu, fetchPublicMenu, type MenuPreview, type PanelMenu, previewMenu, recordMenuSync } from './laffogato-menu';
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
  /** İmzalı panel alınamadı: fiyat ve ürünler uygulandı, Satışta bilgisi değişmedi */
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
        // Anahtar varken Satışta bilgisinin taze kaynağı imzalı panel (CDN'deki liste bayat olabilir). Alınamazsa fiyat,
        // ad, KDV ve yeni ürünler yine uygulanır, ürünlerin Satışta bilgisine dokunulmaz; hata durum kaydına düşer ve
        // ETag yazılmaz, sonraki tur yeniden dener
        let panel: PanelMenu | null = null;
        let panelError: string | null = null;
        try {
          panel = await fetchPanelMenu();
        } catch (e) {
          panelError = e instanceof Error ? e.message : String(e);
        }
        const keep = panelError !== null;
        const held = keep ? new Set<string>() : settleSiteWrites(db, panel);
        const preview = previewMenu(db, fetched.menu, { panel, keep, held });
        const stale = cdnStale(db.select({ extId: schema.products.extId }).from(schema.products).where(eq(schema.products.extSource, 'laffogato')).all(), fetched.menu, panel);
        const warning = panelError ? `Satışta bilgisi alınamadı, ürünlerin Satışta durumu değişmedi: ${panelError}` : null;
        if (!opts.apply) return { status: 'onizleme' as const, preview, ...(warning ? { warning } : {}) };
        const fx = new Effects();
        const result = tx((t) => {
          const r = applyMenu(t, fetched.menu, { ...stations(), panel, keep, held });
          if (preview.changes.length || preview.newCategories.length) {
            fx.audit(t, {
              userId: opts.userId ?? null,
              action: 'menu.sync',
              message: `Site menüsü ${opts.userName ? `${opts.userName} tarafından ` : ''}eşitlendi: ${preview.changes.length} değişiklik (${r.created} yeni, ${r.deactivated} satışta değil${r.reactivated ? `, ${r.reactivated} yeniden satışta` : ''})${warning ? '; Satışta bilgisi alınamadı' : ''}`,
              data: { changes: preview.changes.slice(0, 100) },
            });
          }
          return r;
        });
        // CDN bayatsa ETag yazılmaz: sonraki yoklama (ya da kısa süre sonraki ETag'siz eşitleme) taze listeyi alır
        recordMenuSync(warning ? { changes: preview.changes.length, error: warning } : { ...(stale ? {} : { etag: fetched.etag }), changes: preview.changes.length });
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
