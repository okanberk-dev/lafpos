import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO } from '@shared/types';
import { navFor, POS_NAV } from '../src/lib/nav';
import { type Harness, startApp } from './harness';

/**
 * Bar ekranı ve "Bara gönder" ayarı (operatör, 20 Kasım 2026: "bara gönder seçeneğini de ayarlardan açma kapatma olsun;
 * kapatınca bar ekranı kısmı da kapanabilir"). Varsayılan açık; kapalıyken kalem hiçbir istasyona gitmez (istasyonsuz,
 * teslim), bar ekranı fiş almaz, menüde Bar yok, adisyonun düğmesi "Kaydet (N)".
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

describe('bar ayarı', () => {
  it('varsayılan açık: açılış verisinde var, kalem bara gider', async () => {
    expect(h.boot.settings.barEnabled).toBe(true);
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
    expect(o.items[0].stationId).not.toBeNull();
    expect(o.items[0].status).toBe('yeni');
  });

  it('kapalıyken kalem istasyonsuz yazılır ve teslim sayılır; bar ekranına fiş düşmez; açınca yine bara gider', async () => {
    await h.ok('patron', 'PUT', '/admin/settings', { barEnabled: false });
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const before = await h.ok<{ orderId: string }[]>('kasa', 'GET', '/kitchen');
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 2 }] });
    expect(o.items[0].stationId).toBeNull();
    expect(o.items[0].status).toBe('servis');
    // Ödeme bekletme (tezgâhta "Öde") da bara bir şey bekletmez
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }], hold: true });
    expect(o.items.every((i) => !i.held && i.stationId == null)).toBe(true);
    const after = await h.ok<{ orderId: string }[]>('kasa', 'GET', '/kitchen');
    expect(after.filter((t) => t.orderId === o.id)).toHaveLength(0);
    expect(after.length).toBe(before.length);
    await h.ok('patron', 'PUT', '/admin/settings', { barEnabled: true });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
    expect(o.items.at(-1)?.stationId).not.toBeNull();
  });

  it('menü: kapalıyken Bar yok (her servis modunda), açıkken var', () => {
    for (const mode of ['masa', 'self'] as const) {
      expect(navFor(mode, { bar: false }).some((n) => n.to === '/mutfak')).toBe(false);
      expect(navFor(mode).some((n) => n.to === '/mutfak')).toBe(true);
    }
    expect(POS_NAV.some((n) => n.to === '/mutfak')).toBe(true);
  });

  it('ekran (kaynak): bar ekranı kapalıyken not gösterir; adisyon "Kaydet" der; ayar Yönetim › Ayarlar\'da', () => {
    const kitchen = readFileSync(new URL('../src/pages/KitchenPage.tsx', import.meta.url), 'utf8');
    expect(kitchen).toMatch(/if \(boot\.settings\.barEnabled === false\) \{[\s\S]*?title="Bar ekranı kapalı"/);
    const page = readFileSync(new URL('../src/pages/order/OrderPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain("const barOn = boot.settings.barEnabled !== false;");
    const admin = readFileSync(new URL('../src/pages/admin/SettingsAdmin.tsx', import.meta.url), 'utf8');
    expect(admin).toMatch(/checked=\{s\.barEnabled\}\s*onChange=\{\(v\) => set\(\{ barEnabled: v \}\)\}/);
    const shell = readFileSync(new URL('../src/components/AppShell.tsx', import.meta.url), 'utf8');
    expect(shell).toContain('visibleNav(can, mode, { tablesInUse, bar })');
  });
});
