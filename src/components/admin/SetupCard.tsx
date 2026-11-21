import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronRight } from 'lucide-react';
import { Link } from 'react-router';
import { Card } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { get, put } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { REMOTE } from '@/lib/remote';

interface Step {
  key: string;
  title: string;
  detail: string;
  done: boolean;
  to: string;
}

const KEY = ['admin', 'kurulum'];

/**
 * Karşılama sihirbazı (server/services/kurulum.ts): yeni kurulumun adımları sırayla, her biri ilgili ekrana götürür.
 * Sıradaki adım vurgulu; bütün adımlar bitince ya da "Gizle" ile kaybolur (sade Genel bakış)
 */
export function SetupCard() {
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: KEY, queryFn: () => get<{ steps: Step[]; hidden: boolean }>('/admin/kurulum'), enabled: can('ayar.yonet') && !REMOTE });
  const hide = useMutation({ mutationFn: () => put('/admin/kurulum', { hidden: true }), onSuccess: () => void qc.invalidateQueries({ queryKey: KEY }) });
  const d = q.data;
  if (!d || d.hidden) return null;
  const done = d.steps.filter((s) => s.done).length;
  if (done === d.steps.length) return null;
  const next = d.steps.find((s) => !s.done)?.key;
  return (
    <Card
      title="Kurulum"
      subtitle={`${done} / ${d.steps.length} adım tamam`}
      actions={
        <Button size="sm" variant="ghost" loading={hide.isPending} onClick={() => hide.mutate()}>
          Gizle
        </Button>
      }
    >
      {/* İlerleme çubuğu: adım sayısıyla aynı oranda */}
      <div aria-hidden="true" className="mb-3 h-1.5 overflow-hidden rounded-full bg-[var(--admin-surface-2)]">
        <div className="h-full rounded-full bg-[var(--admin-primary)] transition-[width] duration-300" style={{ width: `${(done / d.steps.length) * 100}%` }} />
      </div>
      <ol className="divide-y divide-[var(--admin-divider)]">
        {d.steps.map((s, i) => (
          <li key={s.key}>
            <Link to={s.to} className={cn('flex min-h-14 items-center gap-3 py-2.5', s.key === next && 'font-semibold')}>
              <span
                aria-hidden="true"
                className={cn(
                  'grid size-7 shrink-0 place-items-center rounded-full text-[13px] font-semibold',
                  s.done ? 'bg-[var(--admin-primary)] text-white' : s.key === next ? 'bg-[var(--admin-primary-soft)] text-[var(--admin-primary)]' : 'bg-[var(--admin-surface-2)] text-muted',
                )}
              >
                {s.done ? <Check className="size-4" /> : i + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className={cn('block text-[15px]', s.done && 'text-muted')}>
                  <span className="sr-only">{s.done ? 'Tamam: ' : 'Yapılacak: '}</span>
                  {s.title}
                </span>
                <span className="block text-[13px] font-normal text-muted">{s.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted" />
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
