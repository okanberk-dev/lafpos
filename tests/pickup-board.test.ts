import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { OrderDTO, PickupBoardDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/** Çağrı ekranı: tezgâh ve gel-al siparişleri "Hazırlanıyor"dan "Hazır"a geçer; masa siparişi görünmez */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  await h.login('bar', '3333');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;

describe('çağrı ekranı', () => {
  it('hazırlanıyor → hazır → teslim; masa siparişi yok; hazır 10 dakika sonra düşer', async () => {
    const counter = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    const sent = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${counter.id}/items`, { items: [{ productId: product('Latte').id, size: 'M', qty: 1 }] });
    const pickup = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', deliveryName: 'Ayşe Yılmaz' });
    await h.ok('kasa', 'POST', `/orders/${pickup.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
    const table = h.boot.tables.find((t) => t.kind !== 'oda')!;
    const dine = await h.ok<OrderDTO>('garson', 'POST', '/orders', { type: 'masa', tableId: table.id });
    await h.ok('garson', 'POST', `/orders/${dine.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });

    let board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.preparing.map((e) => e.no).sort()).toEqual([counter.no, pickup.no].sort());
    // Yalnız ad: soyadı çağrı ekranına çıkmaz
    expect(board.preparing.find((e) => e.id === pickup.id)?.name).toBe('Ayşe');
    expect(board.preparing.some((e) => e.id === dine.id)).toBe(false);

    const ids = sent.items.map((i) => i.id);
    // "Hazır" siparişi alan kişiye uyarı olarak gider
    const { bus } = await import('../server/lib/events');
    const seen: { kind: string; message?: string; forUserId?: string }[] = [];
    const listen = (e: { kind: string; message?: string; forUserId?: string }) => seen.push(e);
    bus.on('event', listen);
    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'hazir' });
    bus.off('event', listen);
    const alert = seen.find((e) => e.kind === 'items.ready');
    expect(alert?.message).toBe(`Tezgâh #${counter.no} · 1 ürün hazır`);
    expect(alert?.forUserId).toBe(counter.waiterId);
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready.map((e) => e.id)).toEqual([counter.id]);
    expect(board.preparing.map((e) => e.id)).toEqual([pickup.id]);

    const { pickupBoard, PICKUP_READY_MS } = await import('../server/services/floor');
    const { db } = await import('../server/db/client');
    expect(pickupBoard(db, Date.now() + PICKUP_READY_MS + 1000).ready).toEqual([]);

    await h.ok('bar', 'POST', '/kitchen/status', { itemIds: ids, status: 'servis' });
    board = await h.ok<PickupBoardDTO>('', 'GET', '/public/board');
    expect(board.ready).toEqual([]);
    // Eski oturumlu uç yok; çağrı ekranı oturumsuz okur
    expect((await h.call('bar', 'GET', '/kitchen/board')).status).toBe(404);
  });
});
