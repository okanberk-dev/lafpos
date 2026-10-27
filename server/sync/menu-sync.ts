import { eq } from 'drizzle-orm';
import { db, schema, tx } from '../db/client';
import { Effects } from '../lib/effects';
import { applyMenu, fetchPanelMenu, fetchPublicMenu, type MenuPreview, previewMenu, recordMenuSync } from './laffogato-menu';

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
  result?: { created: number; updated: number; deactivated: number };
}> {
  if (running) await running.catch(() => undefined);
  const job = (async () => {
    try {
      const fetched = await fetchPublicMenu(opts.force);
      if (fetched.status === 'degismedi') {
        recordMenuSync({ changes: 0 });
        return { status: 'degismedi' as const };
      }
      let panel: Awaited<ReturnType<typeof fetchPanelMenu>> = null;
      try {
        panel = await fetchPanelMenu();
      } catch {
        panel = null;
      }
      const preview = previewMenu(db, fetched.menu, panel);
      if (!opts.apply) return { status: 'onizleme' as const, preview };
      const fx = new Effects();
      const result = tx((t) => {
        const r = applyMenu(t, fetched.menu, { ...stations(), panel });
        if (preview.changes.length || preview.newCategories.length) {
          fx.audit(t, {
            userId: opts.userId ?? null,
            action: 'menu.sync',
            message: `Site menüsü ${opts.userName ? `${opts.userName} tarafından ` : ''}eşitlendi: ${preview.changes.length} değişiklik (${r.created} yeni, ${r.deactivated} satışta değil)`,
            data: { changes: preview.changes.slice(0, 100) },
          });
        }
        return r;
      });
      recordMenuSync({ etag: fetched.etag, changes: preview.changes.length });
      fx.emit({ topic: 'menu', kind: 'menu.synced' });
      fx.emit({ topic: 'sync', kind: 'menu.synced' });
      fx.flush();
      return { status: 'uygulandi' as const, preview, result };
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
