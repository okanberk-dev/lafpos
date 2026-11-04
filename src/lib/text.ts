/**
 * "·" ayraçlı meta satırı ("3 ürün · 12 dk · Garson"): boş, null ya da false parça düşer, "—" dolgusu yazılmaz.
 * `max` verilirse en çok o kadar parça (önce gelenler kalır).
 *   joinMeta([`${n} ürün`, fmtAgo(o.openedAt), o.waiterName])
 */
export function joinMeta(parts: (string | number | null | undefined | false)[], max?: number): string {
  const kept = parts.filter((p): p is string | number => p !== null && p !== undefined && p !== false && String(p).trim() !== '').map((p) => String(p).trim());
  return (max ? kept.slice(0, max) : kept).join(' · ');
}

/**
 * Türkiye numarasının 10 hanesi (sunucunun `normalizePhone`'u gibi: başta 90 ya da 0 yok); başka biçim (dahili,
 * maskeli platform numarası, eksik hane, 0'la başlayan 10 hane) null
 */
function trDigits(p: string): string | null {
  let d = p.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('90')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return /^[1-9]\d{9}$/.test(d) ? d : null;
}

/**
 * Telefon her ekranda aynı biçimde: "5321112233", "+90 532 111 22 33" → "0532 111 22 33". Türkiye numarası
 * olmayan değer (dahili, maskeli platform numarası) yazıldığı gibi kalır
 */
export function fmtPhone(p: string): string {
  const d = trDigits(p);
  return d ? `0${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6, 8)} ${d.slice(8)}` : p;
}

/** Aranabilir bağlantı: Türkiye numarası "tel:+905321112233"; başka değer olduğu gibi (dahili numaraya yapışmaz) */
export function telHref(p: string): string {
  const d = trDigits(p);
  return d ? `tel:+90${d}` : `tel:${p.trim()}`;
}
