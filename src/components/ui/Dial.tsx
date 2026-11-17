import type { CSSProperties, ReactNode } from 'react';

/**
 * 24 saat kadranı (gnbsite Area Board kitinin Open Positions kadranı, `.kadran`): her saat bir çizgi, boyu o saatin
 * değerine göre; değeri olan saat mürekkep, olmayan kısa ve soluk, şimdiki saat yeşil ve ucunda halkalı nokta. 00 tepede,
 * 06 sağda, 12 altta, 18 solda. Ortada büyük sayı ve küçük etiketi. Açılışta çizgiler sırayla çizilir (hareket
 * azaltmada yok). Süs gibi durur ama bilgi taşır: aynı rakamlar sayfanın tablosunda da var; ekran okuyucuya `title`
 */
export function Dial({ values, hour, value, label, title }: { values: number[]; hour: number; value: ReactNode; label: string; title: string }) {
  const cx = 150;
  const cy = 150;
  const r0 = 66;
  const max = Math.max(1, ...values.map((v) => v || 0));
  const point = (h: number, r: number) => {
    const a = (h / 24) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(a) * r, cy + Math.sin(a) * r] as const;
  };
  const lenOf = (h: number) => {
    const v = values[h] ?? 0;
    return v > 0 ? 16 + 64 * (v / max) : 8;
  };
  const [tx, ty] = point(hour, r0 + lenOf(hour) + 7);
  return (
    <svg viewBox="0 0 300 300" className="lp-dial" role="img" aria-label={title}>
      <circle className="face" cx={cx} cy={cy} r={r0 - 10} />
      {Array.from({ length: 24 }, (_, h) => {
        const len = lenOf(h);
        const [x1, y1] = point(h, r0);
        const [x2, y2] = point(h, r0 + len);
        const cls = h === hour ? 'now draw' : (values[h] ?? 0) > 0 ? 'on draw' : 'draw';
        return <line key={h} x1={x1} y1={y1} x2={x2} y2={y2} className={cls} style={{ '--len': Math.ceil(len), '--i': h } as CSSProperties} />;
      })}
      <circle className="now" cx={tx} cy={ty} r={3.5} />
      {[0, 6, 12, 18].map((h) => {
        const [x, y] = point(h, r0 - 21);
        return (
          <text key={h} x={x} y={y}>
            {String(h).padStart(2, '0')}
          </text>
        );
      })}
      <text className="dial-value tabular" x={cx} y={cy - 4}>
        {value}
      </text>
      <text className="dial-label" x={cx} y={cy + 26}>
        {label}
      </text>
    </svg>
  );
}
