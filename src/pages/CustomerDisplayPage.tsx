import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { tl } from '@shared/money';
import type { DisplayStateDTO } from '@shared/types';
import { LafMark } from '@/components/LafMark';
import { get } from '@/lib/api';
import { useTick } from '@/lib/hooks';
import { useBusinessName } from '@/lib/publicInfo';
import { useWakeLock } from '@/lib/wakelock';

/** "Teşekkürler" bu kadar kalır, sonra hoş geldiniz */
const THANKS_MS = 10_000;

/**
 * Müşteri ekranı (ikinci monitör ya da müşteriye dönük tablet): kasadaki adisyonun kalemleri ve tutarı, ödeme
 * bitince teşekkür, boşta hoş geldiniz. Kasa Adisyon › İşlemler › Müşteri ekranı'ndan yansıtır; ekran adı ?ekran=. Personel girişi istemez.
 */
export default function CustomerDisplayPage() {
  const businessName = useBusinessName();
  const now = useTick(2_000);
  const [params] = useSearchParams();
  const code = (params.get('ekran') ?? 'kasa').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24) || 'kasa';
  useWakeLock(true);
  // Oturumsuz ekran: canlı bağlantı yok, sık yoklanır (yalnız bellekten okunan küçük bir yanıt)
  const q = useQuery({ queryKey: ['display', code], queryFn: () => get<DisplayStateDTO>(`/public/display/${code}`), refetchInterval: 1_500 });

  const s = q.data;
  const state: DisplayStateDTO = !s || (s.kind === 'thanks' && now - s.at > THANKS_MS) ? { kind: 'idle', at: 0 } : s;

  return (
    <div className="flex h-full flex-col bg-bg p-3 md:p-6">
      {state.kind === 'order' ? (
        <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[1.4fr_1fr]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-line bg-surface">
            <header className="flex items-center gap-3 border-b border-[var(--admin-divider)] px-5 py-4">
              <span className="grid size-11 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
                <LafMark className="h-4" bean="#e8c877" />
              </span>
              <h1 className="text-xl font-semibold tracking-[-0.01em]">Siparişiniz</h1>
              <span className="flex-1" />
              <span className="text-sm text-muted">{state.label}</span>
            </header>
            <ul className="scroll-thin min-h-0 flex-1 divide-y divide-[var(--admin-divider)] overflow-y-auto">
              {state.lines.map((l, i) => (
                <li key={`${l.name}-${i}`} className="flex items-start gap-4 px-5 py-3.5">
                  <span className="tabular grid min-w-9 place-items-center rounded-lg bg-surface-3 px-2 py-1 text-lg font-semibold">{l.qty}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-semibold leading-snug">
                      {l.name}
                      {l.size && <span className="ml-2 text-base font-medium text-muted">{l.size}</span>}
                    </span>
                    {l.options && <span className="block text-sm text-muted">{l.options}</span>}
                  </span>
                  <span className="tabular text-lg font-semibold">{l.total ? tl(l.total) : 'İkram'}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-4 rounded-2xl border border-line bg-surface p-6">
            <div className="flex flex-1 flex-col items-center justify-center text-center">
              <LafMark className="h-16 text-ink" />
              <p className="mt-4 text-lg font-medium text-ink-2">{businessName}</p>
            </div>
            {state.discount > 0 && (
              <div className="tabular flex justify-between text-lg text-muted">
                <span>İndirim</span>
                <span>−{tl(state.discount)}</span>
              </div>
            )}
            {state.service > 0 && (
              <div className="tabular flex justify-between text-lg text-muted">
                <span>Servis</span>
                <span>{tl(state.service)}</span>
              </div>
            )}
            {state.paid > 0 && (
              <div className="tabular flex justify-between text-lg text-muted">
                <span>Ödenen</span>
                <span>{tl(state.paid)}</span>
              </div>
            )}
            <div>
              <p className="text-lg text-muted">{state.paid > 0 ? 'Kalan' : 'Toplam'}</p>
              <p className="tabular text-6xl font-bold tracking-tight md:text-7xl">{tl(state.paid > 0 ? state.due : state.total)}</p>
            </div>
          </section>
        </div>
      ) : (
        <div className="grid flex-1 place-items-center rounded-2xl border border-line bg-surface p-8 text-center">
          <div>
            <span className="mx-auto grid size-24 place-items-center rounded-[20px] bg-night text-white dark:bg-surface-3">
              <LafMark className="h-9" bean="#e8c877" />
            </span>
            {state.kind === 'thanks' ? (
              <>
                <h1 className="mt-8 text-4xl font-semibold tracking-tight md:text-5xl">Teşekkürler, afiyet olsun</h1>
                <p className="tabular mt-3 text-xl text-muted">{tl(state.total)}</p>
              </>
            ) : (
              <>
                <h1 className="mt-8 text-4xl font-semibold tracking-tight md:text-5xl">Hoş geldiniz</h1>
                <p className="mt-3 text-xl text-muted">{businessName}</p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
