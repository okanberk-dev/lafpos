import { useMemo } from 'react';
import { encode } from 'uqr';
import { cn } from '@/lib/cn';

/**
 * Karekod: beyaz zeminde espresso modüller (okuyucular ters renkte zorlanır), kenarda dört modül sessiz alan (ISO
 * 18004; koyu kartta ve lamine masa kartında eski telefonlar da okusun). Kodlanamayan içerikte sahte boş kare değil,
 * çizilemediğini söyleyen kesikli kutu.
 */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { d, n } = useMemo(() => {
    let qr: ReturnType<typeof encode>;
    try {
      qr = encode(value, { ecc: 'M', border: 4 });
    } catch {
      // Karekoda sığmayan uzun içerik çizimi (ve sayfayı) düşürmesin
      return { d: '', n: 0 };
    }
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.data.length };
  }, [value]);
  if (!d) {
    return (
      <div role="img" aria-label={`${label} çizilemedi`} className={cn('grid shrink-0 place-items-center rounded-lg border border-dashed border-[var(--admin-border-field)] p-3 text-center text-xs text-muted', className ?? 'size-40')}>
        Karekod çizilemedi: adres çok uzun
      </div>
    );
  }
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className={cn('shrink-0 rounded-lg border border-[var(--admin-border)] bg-white', className ?? 'size-40')}>
      <path d={d} fill="#211c18" />
    </svg>
  );
}
