import { Check, ChevronDown } from 'lucide-react';
import { useId, useState } from 'react';
import { cn } from '@/lib/cn';

/**
 * Gün sonu rehberi: "Gün sonu (Z)" penceresinin üstünde, ekibin her akşam aynı sırayla yaptığı adımlar. Adıma dokununca
 * işaretlenir (yalnız bu pencerede; kayda girmez). Basılı rehber (`~/Downloads/Gun-Sonu-Rehberi.html`) aynı metinden
 * üretilir: adımlar değişirse ikisi de buradan değişir
 */
export const DAY_CLOSE_STEPS: { title: string; detail: string }[] = [
  { title: 'Açık adisyon kalmasın', detail: 'Masalar ekranında açık hesap varsa ödemesini alın; ödenmeyecekse “Ödenmez” ya da müşterinin açık hesabına yazın.' },
  { title: 'Banka POS’unun gün sonunu alın', detail: 'Kart cihazından gün sonu (Z) slibini alın; slipteki toplamı aşağıda “Kredi kartı” satırına girin.' },
  { title: 'Yemek kartı cihazlarının gün sonunu alın', detail: 'Multinet, Pluxee ve diğerlerinin slip toplamlarını kendi satırlarına girin (o gün yoksa boş bırakın).' },
  { title: 'Çekmecedeki nakdi sayın', detail: 'Banknot ve bozuk paraları sayıp girin. Fark çıkarsa nedenini “Not”a yazın (ör. bozuk para verildi).' },
  { title: '“Günü kapat”a basın', detail: 'Z raporu ekranda açılır ve yazdırılır. Çıktıyı ve slipleri birlikte kasaya koyun.' },
  { title: 'Bilgisayarı kapatmayın', detail: 'Kasa bilgisayarını en az 10 dakika açık ve internete bağlı bırakın: güncellemeler gün sonundan sonra kendiliğinden kurulur.' },
];

export function DayCloseGuide({ className }: { className?: string }) {
  const [open, setOpen] = useState(true);
  const [done, setDone] = useState<Set<number>>(() => new Set());
  const id = useId();
  const toggle = (i: number) =>
    setDone((d) => {
      const next = new Set(d);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  return (
    <section aria-label="Gün sonu adımları" className={cn('rounded-[var(--r-card)] bg-surface-2 px-4 py-3', className)}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)} className="flex min-h-11 w-full items-center justify-between gap-3 text-left">
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-ink">Gün sonu adımları</span>
          <span className="block text-xs text-muted">
            {done.size}/{DAY_CLOSE_STEPS.length} tamam · sırayla yapın, dokunup işaretleyin
          </span>
        </span>
        <ChevronDown aria-hidden="true" className={cn('size-4 shrink-0 text-muted transition-transform duration-200', open && 'rotate-180')} />
      </button>
      <ol id={id} hidden={!open} className="mt-1 space-y-1 pb-1">
        {DAY_CLOSE_STEPS.map((s, i) => {
          const on = done.has(i);
          return (
            <li key={s.title}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => toggle(i)}
                className="flex min-h-11 w-full items-start gap-3 rounded-[var(--r-tile)] px-1 py-2 text-left transition-colors duration-150 hover:bg-hover active:bg-press"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'tabular mt-0.5 grid size-6 shrink-0 place-items-center rounded-full text-xs font-semibold',
                    on ? 'bg-[var(--admin-ink-fill)] text-[var(--admin-on-ink)]' : 'bg-surface text-ink-2 ring-1 ring-inset ring-[var(--admin-border-strong)]',
                  )}
                >
                  {on ? <Check className="size-3.5 stroke-[2.5]" /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-sm font-medium', on ? 'text-muted line-through' : 'text-ink')}>{s.title}</span>
                  <span className="block text-pretty text-xs leading-5 text-muted">{s.detail}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
