import { describe, expect, it } from 'vitest';
import { kitchenTotals } from '@shared/kitchen';
import type { KitchenTicket, KitchenTicketItem } from '@shared/types';

const item = (name: string, qty: number, status: KitchenTicketItem['status'], optionsText = '', extra: Partial<KitchenTicketItem> = {}): KitchenTicketItem => ({
  id: `${name}-${Math.random()}`,
  name,
  size: 'M',
  optionsText,
  qty,
  note: null,
  status,
  voided: false,
  stationId: null,
  sentAt: 0,
  startedAt: null,
  readyAt: null,
  ...extra,
});
const ticket = (items: KitchenTicketItem[]): KitchenTicket => ({ key: String(Math.random()), orderId: 'o', orderNo: 1, batch: 1, label: 'S1', type: 'masa', source: 'pos', waiterName: null, note: null, sentAt: 0, scheduledFor: null, numarator: null, items });

describe('bar ekranı Toplam', () => {
  it('ürün ve boy başına toplar; seçenekler alt sayım; hazır, serviste ve iptal sayılmaz', () => {
    const totals = kitchenTotals([
      ticket([item('Latte', 2, 'yeni', 'Yulaf sütü'), item('Espresso', 1, 'hazir')]),
      ticket([item('Latte', 1, 'hazirlaniyor', 'Yulaf sütü · +1 shot'), item('Latte', 3, 'yeni'), item('Latte', 1, 'yeni', '', { voided: true })]),
      ticket([item('Latte', 1, 'yeni', '', { size: 'L' }), item('Mocha', 1, 'servis')]),
    ]);
    expect(totals.map((t) => `${t.name} ${t.size} ×${t.qty}`)).toEqual(['Latte M ×6', 'Latte L ×1']);
    expect(totals[0]).toMatchObject({ waiting: 5, making: 1, options: [{ text: 'Yulaf sütü', qty: 3 }, { text: '+1 shot', qty: 1 }] });
  });
});
