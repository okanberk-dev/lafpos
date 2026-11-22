import { describe, expect, it } from 'vitest';
import { dayText } from '@shared/gun-sonu-metni';
import type { ZSummary } from '@shared/types';

describe('gün sonu WhatsApp metni', () => {
  it('başlık, ciro, fiş, kıyas, ödeme grupları, ciro dışı, kasa farkı, en çok satanlar', () => {
    const s = {
      netSales: 462050, receipts: 17, discounts: 22950, complimentary: 11000, odenmez: 11000, zayi: 0, voided: 78000,
      payments: [{ zField: 'card', amount: 320300 }, { zField: 'cash', amount: 141750 }],
      expectedCash: 451250, countedCash: 412000, cashDiff: -39250,
      offDevice: { card: 0, cash: 0 },
      topProducts: [{ name: 'LATTE', qty: 6, amount: 120000 }, { name: 'ICED LATTE', qty: 3, amount: 60000 }],
    } as unknown as ZSummary;
    const t = dayText({ branch: 'Marina', date: '2026-11-22', zNo: 2, s, yesterday: 400800, lastWeek: 575300 });
    expect(t).toContain('☕ *Marina · Gün sonu*');
    expect(t).toContain('22.11.2026 · Z 2');
    expect(t).toContain('17 fiş');
    expect(t).toContain('Dün: ');
    expect(t).toContain('(+%15)');
    expect(t).toContain('• Kart: ');
    expect(t).toContain('• Nakit: ');
    expect(t).toContain('• Ödenmez: ');
    expect(t).toContain('⚠️');
    expect(t).toContain('1. LATTE · 6 adet');
    expect(t).not.toContain('Yazarkasadan geçmeyen');
  });
});
