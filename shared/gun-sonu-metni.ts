/**
 * Gün sonu raporunun WhatsApp sürümü (sahip, 22 Kas 2026: "kolay kopyala"): Gün sonu penceresinde ve Kasa › Geçmiş
 * günler'de tek dokunuşla panoya alınan, başlıklı ve emojili düz metin. Saf işlev (ekran ve test). Mail sürümü ladmin'de
 * (lafmaliyet): AsilPOS'un gün sonu ona gidince kendiliğinden gönderilir.
 */
import { roundHalfUp, tl } from './money';
import type { ZSummary } from './types';

const Z_GROUP: Record<string, string> = { cash: 'Nakit', card: 'Kart', meal_card: 'Yemek kartı' };

export interface DayTextInput {
  branch: string;
  date: string;
  zNo: number;
  s: ZSummary;
  /** Kıyas (varsa): dün ve geçen hafta aynı günün cirosu (kuruş) */
  yesterday?: number | null;
  lastWeek?: number | null;
  /** Pavo banka gün sonu sonucu (varsa): "Alındı", "Alınamadı: …" */
  bankEod?: string | null;
}

const pct = (now: number, then: number | null | undefined) => {
  if (!then) return '';
  const d = ((now - then) / then) * 100;
  return ` (${d >= 0 ? '+' : ''}%${Math.round(d)})`;
};

export function dayText(i: DayTextInput): string {
  const { s } = i;
  const groups = new Map<string, number>();
  for (const p of s.payments) {
    const g = Z_GROUP[p.zField] ?? 'Diğer';
    groups.set(g, (groups.get(g) ?? 0) + p.amount);
  }
  const lines: string[] = [];
  lines.push(`☕ *${i.branch} · Gün sonu*`);
  lines.push(`📅 ${i.date.split('-').reverse().join('.')} · Z ${i.zNo}`);
  lines.push('');
  lines.push(`💰 *Ciro: ${tl(s.netSales)}*`);
  // Ortalama kuruşa para kuralıyla yuvarlanır (shared/money.ts, yarım-yukarı): ekrandaki "ort." ile aynı rakam
  lines.push(`🧾 ${s.receipts} fiş · ortalama ${s.receipts ? tl(roundHalfUp(s.netSales / s.receipts)) : '—'}`);
  if (i.yesterday != null || i.lastWeek != null) {
    if (i.yesterday != null) lines.push(`↔️ Dün: ${tl(i.yesterday)}${pct(s.netSales, i.yesterday)}`);
    if (i.lastWeek != null) lines.push(`↔️ Geçen hafta: ${tl(i.lastWeek)}${pct(s.netSales, i.lastWeek)}`);
  }
  lines.push('');
  lines.push('*Ödemeler*');
  for (const g of ['Nakit', 'Kart', 'Yemek kartı', 'Diğer']) if (groups.get(g)) lines.push(`• ${g}: ${tl(groups.get(g)!)}`);
  if (s.offDevice && (s.offDevice.card || s.offDevice.cash)) lines.push(`• Yazarkasadan geçmeyen: kart ${tl(s.offDevice.card)}, nakit ${tl(s.offDevice.cash)}`);
  lines.push('');
  const odenmez = s.odenmez ?? 0;
  const zayi = s.zayi ?? 0;
  const ikram = s.complimentary - odenmez - zayi;
  lines.push('*Ciro dışı*');
  lines.push(`• İndirim: ${tl(s.discounts)}`);
  lines.push(`• İkram: ${tl(Math.max(0, ikram))}`);
  if (odenmez) lines.push(`• Ödenmez: ${tl(odenmez)}`);
  if (zayi) lines.push(`• Zayi: ${tl(zayi)}`);
  lines.push(`• İptal: ${tl(s.voided)}`);
  lines.push('');
  lines.push('*Kasa*');
  // Kasadan çıkan: harcama ve teslim (teslim kime gittiğiyle; alıcısız eski teslim "Belirtilmemiş")
  if (s.cashOut) lines.push(`• Harcama: ${tl(s.cashOut)}`);
  if (s.handedOver) {
    const to = (s.handedOverBy ?? []).map((r) => `${r.name} ${tl(r.amount)}`).join(', ');
    lines.push(`• Teslim: ${tl(s.handedOver)}${to ? ` (${to})` : ''}`);
  }
  lines.push(`• Beklenen nakit: ${tl(s.expectedCash)}`);
  if (s.countedCash != null) lines.push(`• Sayılan: ${tl(s.countedCash)}`);
  if (s.cashDiff != null) lines.push(`• Fark: ${s.cashDiff === 0 ? 'yok ✅' : `${s.cashDiff > 0 ? '+' : '−'}${tl(Math.abs(s.cashDiff))} ⚠️`}`);
  if (i.bankEod) lines.push(`• Pavo banka gün sonu: ${i.bankEod}`);
  if (s.topProducts.length) {
    lines.push('');
    lines.push('*En çok satan 5*');
    s.topProducts.slice(0, 5).forEach((p, n) => lines.push(`${n + 1}. ${p.name} · ${p.qty} adet`));
  }
  return lines.join('\n');
}
