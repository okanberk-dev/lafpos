/** Dönem bir takvim ayının tamamı mı: ayın 1'inden aynı ayın son gününe ("2026-02-01" – "2026-02-28") */
function wholeMonth(range: { from: string; to: string }): boolean {
  const [y, m, d] = range.from.split('-').map(Number);
  if (!y || !m || d !== 1 || range.to.slice(0, 7) !== range.from.slice(0, 7)) return false;
  return Number(range.to.slice(8, 10)) === new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Raporlar KPI şeridinin kıyas etiketi. Sunucunun uzun adı (server/services/reports.ts `comparison`) kısaltılırken
 * neyle kıyaslandığı kaybolmaz: "Geçen hafta" demez (dönem seçicideki "Geçen hafta" toplamıyla karışır), ayın ilk
 * günlerini ve "aynı saate kadar" kesimini söyler. Kıyas dönemi (`range`) önceki ayın tamamıysa yalnız "Önceki ay"
 * (Ekim'in tamamı Eylül'ün tamamıyla: "Önceki ayın ilk 30 günü" değil).
 */
export function previousShort(label: string, range?: { from: string; to: string }): string {
  const partial = /aynı saate kadar/.test(label);
  let base: string;
  if (label.startsWith('önceki ay')) {
    const days = range ? Math.round((Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000) + 1 : null;
    base = range && wholeMonth(range) ? 'Önceki ay' : days && days > 0 ? `Önceki ayın ilk ${days} günü` : 'Önceki ayın aynı günleri';
  } else if (label.startsWith('geçen hafta')) {
    base = '1 hafta önce';
  } else {
    const weeks = label.match(/^(\d+) hafta/)?.[1];
    base = weeks ? `${weeks} hafta önce` : 'Önceki dönem';
  }
  return partial ? `${base}, bu saate dek` : base;
}

/**
 * "İndirim ve ikram" KPI'sinin dökümü: değer `discounts + complimentary`, complimentary ödenmez ve zayiyi de içerir.
 * İndirim hep yazılır; ikram (ödenmez ve zayi dışı), ödenmez ve zayi sıfırsa düşer; iptal ciroya girmez, sonda.
 */
export function lossParts(s: { discounts: number; complimentary: number; odenmez: number; zayi: number; voided: number }, fmt: (k: number) => string): string {
  const ikram = Math.max(0, s.complimentary - s.odenmez - s.zayi);
  return [`İndirim ${fmt(s.discounts)}`, ikram > 0 && `ikram ${fmt(ikram)}`, s.odenmez > 0 && `ödenmez ${fmt(s.odenmez)}`, s.zayi > 0 && `zayi ${fmt(s.zayi)}`, s.voided > 0 && `iptal ${fmt(s.voided)}`].filter(Boolean).join(' · ');
}
