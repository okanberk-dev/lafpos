/**
 * KPI şeridinin ızgarası (yönetim ui.tsx KpiStrip ve iskeleti): iskelet yüklenecek şeritle aynı sütun ve satır
 * sayısını kullanır, veri gelince sayfa zıplamaz. Telefonda iki sütun, tek kalan son hücre tam genişlik.
 * Beş hücre tablette 2+2+2 / 3+3 (altı sütunlu ızgarada), geniş ekranda tek satır.
 * Dört hücre tablette 2+2, geniş ekranda tek satır (tablette dörde bölünen şeritte etiket kırılır, rakam küçülürdü).
 */
export function kpiGridCols(n: number): string {
  return n === 5 ? 'md:grid-cols-6 xl:grid-cols-5' : n >= 6 ? 'md:grid-cols-3 xl:grid-cols-6' : n === 4 ? 'md:grid-cols-2 xl:grid-cols-4' : n === 2 ? 'md:grid-cols-2' : n === 1 ? 'md:grid-cols-1' : 'md:grid-cols-3';
}

export function kpiCellSpan(n: number, i: number): string | null {
  return n === 5 ? (i < 3 ? 'md:col-span-2 xl:col-span-1' : 'md:col-span-3 xl:col-span-1') : null;
}

/** Telefonda tek kalan son hücre iki sütunu kaplar */
export const KPI_LAST_ODD = '[&>*:last-child:nth-child(odd)]:max-md:col-span-2';
