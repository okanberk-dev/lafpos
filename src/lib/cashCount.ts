import type { PaymentMethodDTO, ZSummary } from '@shared/types';

/** Kasa föyünde nakit dışı ödeme türü satırı; kör sayımda sistem tarafı (beklenen, bahşiş, işlem) null */
export interface SlipRow {
  methodId: string;
  name: string;
  /** Slipte görünmesi beklenen tutar */
  expected: number | null;
  tips: number | null;
  count: number | null;
}

/**
 * Kasa föyünde nakit dışı ödeme türlerinin satırları (banka POS gün sonu slipi, yemek kartı raporları). Bahşiş
 * ödemenin türüyle alınır: kartla verilen bahşiş karttan çekilir, slip tutar + bahşişi gösterir (nakit bahşiş de
 * beklenen nakde böyle girer). Bu yüzden beklenen = ödeme tutarı + bahşiş. Özet yoksa kör sayım: satırlar açılış
 * verisinin ödeme türlerinden, sistem tarafı boş.
 */
export function slipRows(summary: ZSummary | null, methods: PaymentMethodDTO[]): SlipRow[] {
  return summary
    ? summary.payments.filter((p) => p.zField !== 'cash').map((p) => ({ methodId: p.methodId, name: p.name, expected: p.amount + p.tips, tips: p.tips, count: p.count }))
    : methods.filter((m) => m.zField !== 'cash' && m.kind !== 'cari').map((m) => ({ methodId: m.id, name: m.name, expected: null, tips: null, count: null }));
}

/** Slip farkı: sayılan − beklenen; yazılmadıysa ya da kör sayımda null */
export function slipDiff(row: SlipRow, counted: number | undefined): number | null {
  return counted == null || row.expected == null ? null : counted - row.expected;
}
