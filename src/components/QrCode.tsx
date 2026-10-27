import { useMemo } from 'react';
import { encode } from 'uqr';
import { cn } from '@/lib/cn';

/** Karekod: beyaz zeminde koyu modüller (okuyucular ters renkte zorlanır), kenarda iki modül sessiz alan */
export function QrCode({ value, label, className }: { value: string; label: string; className?: string }) {
  const { d, n } = useMemo(() => {
    const qr = encode(value, { ecc: 'M', border: 2 });
    let path = '';
    qr.data.forEach((row, y) =>
      row.forEach((on, x) => {
        if (on) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { d: path, n: qr.data.length };
  }, [value]);
  return (
    <svg role="img" aria-label={label} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className={cn('size-40 shrink-0 rounded-lg border border-[var(--admin-border)] bg-white', className)}>
      <path d={d} fill="#0c0e1b" />
    </svg>
  );
}
