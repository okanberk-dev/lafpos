import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BootstrapDTO, FloorStateDTO } from '@shared/types';
import { startApp, type Harness } from './harness';

/**
 * Tarayıcı demosunun ilk günü (demo/scenario.ts) gerçek uçlardan kurulur: bir uç ya da menü değişince demo boş ya
 * da yarım açılmasın. "sqljs" projesinde demodaki veritabanıyla da koşar.
 */
let h: Harness;
let boot: BootstrapDTO;

beforeAll(async () => {
  h = await startApp();
  const { createApp } = await import('../server/app');
  const { seedDemoDay } = await import('../demo/scenario');
  const app = createApp();
  await seedDemoDay((req) => app.fetch(req));
  boot = await h.ok<BootstrapDTO>('patron', 'GET', '/bootstrap');
});

afterAll(() => h.cleanup());

describe('demonun ilk günü (self servis)', () => {
  it('self serviste açılır; gün açık, teslim edilmiş ve barda bekleyen satışlar raporda', async () => {
    expect(boot.settings.serviceMode).toBe('self');
    expect(boot.day?.zNo).toBe(1);
    const today = boot.day!.date;
    const summary = await h.ok<{ receipts: number; netSales: number }>('patron', 'GET', `/reports/summary?from=${today}&to=${today}`);
    expect(summary.receipts).toBe(9);
    expect(summary.netSales).toBeGreaterThan(0);
  });

  it('masa yok; çağrı ekranında hazırlanan ve hazır numaralar; bir platform siparişi barda, biri onay bekliyor', async () => {
    const floor = await h.ok<FloorStateDTO>('patron', 'GET', '/floor');
    expect(Object.values(floor.tables).flat()).toEqual([]);
    const board = await h.ok<{ preparing: unknown[]; ready: unknown[] }>('', 'GET', '/public/board');
    expect(board.preparing.length).toBeGreaterThanOrEqual(2);
    expect(board.ready.length).toBeGreaterThanOrEqual(1);
    const platforms = await h.ok<{ orders: { platform: string; status: string }[] }>('patron', 'GET', '/platforms');
    expect(platforms.orders.map((o) => `${o.platform}:${o.status}`).sort()).toEqual(['trendyol:kabul', 'yemeksepeti:bekliyor']);
    // Raporlar › Paket platformları: barda bekleyen açık, onay bekleyen hiçbir rakama girmez
    const today = boot.day!.date;
    const report = await h.ok<{ revenue: number; pending: number; platforms: { platform: string; open: { orders: number } }[] }>('patron', 'GET', `/reports/platforms?from=${today}&to=${today}`);
    expect(report).toMatchObject({ revenue: 0, pending: 1, platforms: [{ platform: 'trendyol', open: { orders: 1 } }] });
  });

  it('kurulumun oturumları kapanır; demoyu açan kendi rolüyle girer', async () => {
    const { db, schema } = await import('../server/db/client');
    const devices = db.select({ device: schema.sessions.device }).from(schema.sessions).all().map((s) => s.device);
    expect(devices).not.toContain('Demo kurulumu');
  });
});
