import type { PaymentMethodDTO, ZSummary } from '@shared/types';

/** Türk lirası banknot ve madeni paralar (kuruş) */
export const DENOMINATIONS = [20000, 10000, 5000, 2000, 1000, 500, 100, 50, 25, 10, 5];

/** Kasa sayımı: banknot adetleri (kuruş değeri → adet), sayılan nakit, ödeme türü bazında sayılan tutarlar */
export interface CountResult {
  countedCash: number;
  banknotes: Record<string, number>;
  methodCounts: Record<string, number>;
  /**
   * Nakit sayımı başladı: bir adet ya da tutar girildi (sıfır da sayılır) ya da kaydedilmiş sayım açıldı. Başlamamış
   * sayım "Sayılmadı"dır: fark yazılmaz ve ₺0 sayılmış gibi kaydedilmez
   */
  touched?: boolean;
}

export const emptyCount = (): CountResult => ({ countedCash: 0, banknotes: {}, methodCounts: {} });

/** Nakit sayımı başladı mı: ekrandaki "Sayılmadı" ile gün sonuna giden sayım aynı kuralla */
export function countStarted(v: CountResult): boolean {
  return !!v.touched || v.countedCash > 0 || Object.keys(v.banknotes).length > 0;
}

/**
 * Gün sonu isteğinin gövdesi. Nakit yalnız sayım başladıysa ve "Sayımı sonra gireceğim" seçilmediyse gider: dokunulmamış
 * sayaç ₺0 sayılmış gibi kaydedilmez (fark eksi beklenen nakit, alarm, lafmaliyet'e 0), gün sayımsız kapanır ve föy
 * sonra girilir. Banknot adetleri yalnız sayılan nakitle gider (yarım kalıp sonraya bırakılan sayım föye taşınmaz);
 * yazılan slip tutarları her durumda gider.
 */
export function closeDayBody(count: CountResult, later: boolean, note: string) {
  const cash = !later && countStarted(count);
  const banknotes = cash ? Object.entries(count.banknotes).filter(([, n]) => n > 0).map(([k, n]) => [`b:${k}`, n] as const) : [];
  const methods = Object.entries(count.methodCounts).map(([k, v]) => [`m:${k}`, v] as const);
  return { countedCash: cash ? count.countedCash : null, cashCounts: Object.fromEntries([...banknotes, ...methods]), note: note || null };
}

/**
 * Kaydedilmiş sayım (`b:` banknot adedi, `m:` ödeme türünün sayılan tutarı) föy penceresinin sayımına: düzeltme boş
 * föyle değil, girilenle açılır. Sayımsız kapanan günün banknotları gelmez (sayaç boş, "Sayılmadı"); toplamı tutmayan
 * banknotlar da gelmez, sayım toplam tutarla açılır: Sayılan ile adetler hep birbirini tutar.
 */
export function savedCount(countedCash: number | null, cashCounts: Record<string, number> | null | undefined): CountResult {
  const of = (prefix: string) =>
    Object.fromEntries(
      Object.entries(cashCounts ?? {})
        .filter(([k]) => k.startsWith(prefix))
        .map(([k, n]) => [k.slice(prefix.length), n]),
    );
  const methodCounts = of('m:');
  if (countedCash == null) return { countedCash: 0, banknotes: {}, methodCounts };
  const saved = of('b:');
  const notes: Record<string, number> = {};
  for (const d of DENOMINATIONS) if ((saved[String(d)] ?? 0) > 0) notes[String(d)] = saved[String(d)];
  const fromNotes = DENOMINATIONS.reduce((a, d) => a + d * (notes[String(d)] ?? 0), 0);
  return { countedCash, banknotes: fromNotes === countedCash ? notes : {}, methodCounts, touched: true };
}

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
