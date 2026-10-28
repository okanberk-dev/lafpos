/**
 * Tuş takımıyla yazılmakta olan tutar (ödeme, açılış nakdi, kasa hareketi). Değer henüz kuruş değil, kasiyerin yazdığı
 * metindir ("1250,5"); bu yüzden tl() yerine yalnız gösterim: tam kısım binlik noktayla ("1.250,5"), ₺ başta, sönük ve
 * küçük (uygulamanın geri kalanındaki "₺1.250" sırası). Boşsa "0".
 */
export function groupTyped(text: string): string {
  if (!text) return '0';
  const [int, frac] = text.split(',');
  const grouped = (int || '0').replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return frac === undefined ? grouped : `${grouped},${frac}`;
}

export function TypedAmount({ text }: { text: string }) {
  return (
    <>
      <span className="mr-1 align-baseline text-[0.6em] font-medium text-muted">₺</span>
      {groupTyped(text)}
    </>
  );
}
