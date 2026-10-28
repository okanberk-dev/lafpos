/**
 * "·" ayraçlı meta satırı ("3 ürün · 12 dk · Garson"): boş, null ya da false parça düşer, "—" dolgusu yazılmaz.
 * `max` verilirse en çok o kadar parça (önce gelenler kalır).
 *   joinMeta([`${n} ürün`, fmtAgo(o.openedAt), o.waiterName])
 */
export function joinMeta(parts: (string | number | null | undefined | false)[], max?: number): string {
  const kept = parts.filter((p): p is string | number => p !== null && p !== undefined && p !== false && String(p).trim() !== '').map((p) => String(p).trim());
  return (max ? kept.slice(0, max) : kept).join(' · ');
}
