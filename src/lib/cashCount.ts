import type { PaymentMethodDTO, ZSummary } from '@shared/types';

/** Kasa föyünde nakit dışı ödeme türü satırı; kör sayımda sistem tarafı (beklenen, bahşiş, işlem) null */
export interface SlipRow {
  methodId: string;
  name: string;
  /** Slipte görünmesi beklenen tutar */
  expected: number | null;
  /** Beklenen tutara dahil bahşiş */
  tips: number | null;
  count: number | null;
}

/**
 * Kasa föyünde nakit dışı ödeme türlerinin satırları (banka POS gün sonu slipi, yemek kartı raporları). Bahşiş
 * ödemenin türüyle alınır: kartla verilen bahşiş karttan çekilir, slip tutar + bahşişi gösterir (nakit bahşiş de
 * beklenen nakde böyle girer). Bu yüzden beklenen = ödeme tutarı + bahşiş. Açık hesap (cari) böyle değil: müşterinin
 * hesabına yalnız ödeme tutarı borç yazılır, bahşiş yazılmaz; satırı müşterilere yazılan borçla karşılaştırılır,
 * beklenen = ödeme tutarı. Özet yoksa kör sayım: satırlar açılış verisinin ödeme türlerinden (açık hesap hariç),
 * sistem tarafı boş.
 */
export function slipRows(summary: ZSummary | null, methods: PaymentMethodDTO[]): SlipRow[] {
  if (!summary) return methods.filter((m) => m.zField !== 'cash' && m.kind !== 'cari').map((m) => ({ methodId: m.id, name: m.name, expected: null, tips: null, count: null }));
  const cari = new Set(methods.filter((m) => m.kind === 'cari').map((m) => m.id));
  return summary.payments
    .filter((p) => p.zField !== 'cash')
    .map((p) => {
      const tips = cari.has(p.methodId) ? 0 : p.tips;
      return { methodId: p.methodId, name: p.name, expected: p.amount + tips, tips, count: p.count };
    });
}

/** Slip farkı: sayılan − beklenen; yazılmadıysa ya da kör sayımda null */
export function slipDiff(row: SlipRow, counted: number | undefined): number | null {
  return counted == null || row.expected == null ? null : counted - row.expected;
}
