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

describe('demonun ilk günü', () => {
  it('gün açık; kapanmış satışlar raporda', async () => {
    expect(boot.day?.zNo).toBe(1);
    const today = boot.day!.date;
    const summary = await h.ok<{ receipts: number; netSales: number }>('patron', 'GET', `/reports/summary?from=${today}&to=${today}`);
    expect(summary.receipts).toBe(6);
    expect(summary.netSales).toBeGreaterThan(0);
  });

  it('açık masalar, mutfakta bekleyen ve hazır kalemler, kısmen ödenmiş masa, çalışan karaoke sayacı', async () => {
    const floor = await h.ok<FloorStateDTO>('patron', 'GET', '/floor');
    const open = (name: string) => floor.tables[boot.tables.find((t) => t.name === name)!.id]?.[0];
    for (const name of ['S1', 'S4', 'B1', 'B3', 'Ü2', 'Karaoke odası']) expect(open(name), name).toBeTruthy();
    expect(open('S1').pendingKitchen).toBeGreaterThan(0);
    expect(open('S4').readyToServe).toBeGreaterThan(0);
    expect(open('B3').paid).toBeGreaterThan(0);
    expect(open('B3').paid).toBeLessThan(open('B3').total);
    expect(open('Karaoke odası').roomStartedAt).not.toBeNull();
  });

  it('kurulumun oturumları kapanır; demoyu açan kendi rolüyle girer', async () => {
    const { db, schema } = await import('../server/db/client');
    const devices = db.select({ device: schema.sessions.device }).from(schema.sessions).all().map((s) => s.device);
    expect(devices).not.toContain('Demo kurulumu');
  });
});
