import { useQuery } from '@tanstack/react-query';
import { Gift, Search, UserPlus, X } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';

type Act = <T>(fn: (approverPin?: string) => Promise<T>, ok?: string) => Promise<T | null>;

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  balance: number;
  stamps: number;
  visits: number;
}

/** Adisyona müşteri: telefonla bul ya da ekle. Damga kartı ve açık hesap için. */
export function CustomerModal({ order, open, onClose, act }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act }) {
  const boot = useBoot();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const list = useQuery({ queryKey: ['customers', 'search', q], queryFn: () => get<CustomerRow[]>(`/customers?q=${encodeURIComponent(q)}&limit=12`), enabled: open && !creating });
  if (!open) return null;

  const attach = async (customerId: string | null) => {
    const res = await act(() => patch(`/orders/${order.id}`, { customerId }), customerId ? 'Müşteri eklendi' : 'Müşteri kaldırıldı');
    if (res) onClose();
  };
  const create = async () => {
    const c = await act((pin) => post<CustomerRow>('/customers', { name, phone: phone || null, approverPin: pin }), 'Müşteri kaydedildi');
    if (c) await attach(c.id);
  };
  const goal = boot.settings.stampGoal;
  const current = order.customer;

  return (
    <Modal open onClose={onClose} title="Müşteri" subtitle="Telefon ya da adla bulun; damga kartı ve açık hesap için" size="md">
      <div className="space-y-3 p-4">
        {current && (
          <div className="flex items-center gap-3 rounded-2xl border border-brand-200 bg-[var(--admin-primary-soft)] p-3 dark:border-transparent">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{current.name}</div>
              <div className="text-xs text-muted">
                {current.phone ?? 'telefon yok'} · damga {current.stamps}/{goal}
                {current.balance !== 0 && ` · açık hesap ${tl(current.balance)}`}
              </div>
            </div>
            {current.stamps >= goal && (
              <Button size="sm" variant="warn" icon={<Gift className="size-4" />} onClick={() => act((pin) => post(`/customers/${current.id}/redeem`, { approverPin: pin }), `${goal} damga kullanıldı; bir içeceği ikram edin`)}>
                Hediye
              </Button>
            )}
            <Button size="sm" variant="ghost" aria-label="Müşteriyi kaldır" onClick={() => attach(null)}>
              <X className="size-4" />
            </Button>
          </div>
        )}
        {!creating ? (
          <>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Telefon ya da ad" className="pl-9" autoFocus inputMode="search" />
            </div>
            <ul className="divide-y divide-line rounded-2xl border border-line">
              {(list.data ?? []).map((c) => (
                <li key={c.id}>
                  <button onClick={() => attach(c.id)} className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2', current?.id === c.id && 'bg-brand-50')}>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="text-xs text-muted">
                        {c.phone ?? '—'} · {c.visits} ziyaret
                      </span>
                    </span>
                    <span className="text-right text-xs">
                      <span className="block font-semibold text-warn-600">
                        {c.stamps}/{goal} damga
                      </span>
                      {c.balance !== 0 && <span className={c.balance > 0 ? 'text-danger-500' : 'text-brand-500'}>{tl(c.balance)}</span>}
                    </span>
                  </button>
                </li>
              ))}
              {list.data?.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Bulunamadı</li>}
            </ul>
            <Button block icon={<UserPlus className="size-4" />} onClick={() => { setCreating(true); setPhone(/^\d/.test(q) ? q : ''); setName(/^\d/.test(q) ? '' : q); }}>
              Yeni müşteri
            </Button>
          </>
        ) : (
          <div className="space-y-3">
            <Field label="Ad soyad">
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </Field>
            <Field label="Telefon" hint="Sonraki ziyarette bununla bulunur">
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="05xx xxx xx xx" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setCreating(false)}>Geri</Button>
              <Button variant="primary" disabled={!name.trim()} onClick={create}>
                Kaydet ve ekle
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
