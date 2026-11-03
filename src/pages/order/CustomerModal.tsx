import { useQuery } from '@tanstack/react-query';
import { Gift, UserPlus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { tl } from '@shared/money';
import type { OrderDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { Field, Input, SearchInput } from '@/components/ui/Field';
import { EmptyState, ErrorState, ListSkeleton } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { get, patch, post } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';
import { joinMeta } from '@/lib/text';

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
  const [nameError, setNameError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const fine = useFinePointer();
  const list = useQuery({ queryKey: ['customers', 'search', q], queryFn: () => get<CustomerRow[]>(`/customers?q=${encodeURIComponent(q)}&limit=12`), enabled: open && !creating });
  if (!open) return null;

  const attach = async (customerId: string | null) => {
    const res = await act(() => patch(`/orders/${order.id}`, { customerId }), customerId ? 'Müşteri eklendi' : 'Müşteri kaldırıldı');
    if (res) onClose();
  };
  const create = async () => {
    // Zorunlu alan eksikse ileti alanın altında (düğme sessizce soluk kalmaz)
    if (!name.trim()) {
      setNameError('Ad soyad gerekli');
      nameRef.current?.focus();
      return;
    }
    const c = await act((pin) => post<CustomerRow>('/customers', { name, phone: phone || null, approverPin: pin }), 'Müşteri kaydedildi');
    if (c) await attach(c.id);
  };
  const goal = boot.settings.stampGoal;
  // Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada)
  const stamps = boot.integrations.localStamps;
  const current = order.customer;

  return (
    <Modal open onClose={onClose} title="Müşteri" subtitle={stamps ? 'Telefon ya da adla bulun; damga kartı ve açık hesap için' : 'Telefon ya da adla bulun; açık hesap ve sipariş geçmişi için'} size="md">
      <div className="space-y-3 p-4">
        {current && (
          <div className="flex items-center gap-3 rounded-2xl border border-primary-line bg-primary-soft p-3">
            <div className="min-w-0 flex-1">
              <div className="font-semibold">{current.name}</div>
              <div className="text-xs text-muted">{joinMeta([current.phone, stamps && `damga ${current.stamps}/${goal}`, current.balance !== 0 && `açık hesap ${tl(current.balance)}`])}</div>
            </div>
            {stamps && current.stamps >= goal && (
              <Button size="sm" variant="warn" icon={<Gift className="size-4" />} onClick={() => act((pin) => post(`/customers/${current.id}/redeem`, { approverPin: pin }), `${goal} damga kullanıldı; bir içeceği ikram edin`)}>
                Hediye içecek
              </Button>
            )}
            <IconButton size="sm" label="Müşteriyi kaldır" onClick={() => attach(null)}>
              <X className="size-4" />
            </IconButton>
          </div>
        )}
        {!creating ? (
          <>
            <SearchInput value={q} onChange={setQ} label="Müşteri ara" placeholder="Telefon ya da ad" autoFocus={fine} />
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line">
              {list.isPending && (
                <li>
                  <ListSkeleton rows={3} />
                </li>
              )}
              {list.isError && !list.data && (
                <li>
                  <ErrorState compact title="Müşteriler alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
                </li>
              )}
              {(list.data ?? []).map((c) => (
                <li key={c.id}>
                  <button
                    onClick={() => attach(c.id)}
                    aria-current={current?.id === c.id || undefined}
                    className={cn('flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-hover active:bg-press', current?.id === c.id && 'bg-primary-soft')}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{c.name}</span>
                      <span className="text-xs text-muted">{joinMeta([c.phone, `${c.visits} ziyaret`])}</span>
                    </span>
                    <span className="text-right text-xs">
                      {stamps && (
                        <span className="block font-semibold text-gold-ink">
                          {c.stamps}/{goal} damga
                        </span>
                      )}
                      {c.balance !== 0 && <span className={c.balance > 0 ? 'text-danger-ink' : 'text-blue-ink'}>{tl(c.balance)}</span>}
                    </span>
                  </button>
                </li>
              ))}
              {list.isSuccess && list.data.length === 0 && (
                <li>
                  <EmptyState compact art={q.trim() ? 'arama' : 'kupon'} title={q.trim() ? 'Müşteri bulunamadı' : 'Henüz müşteri yok'}>
                    {q.trim() ? 'Telefonun ya da adın bir bölümünü yazın ya da yeni müşteri ekleyin' : 'Yeni müşteri ile ilk kaydı açın'}
                  </EmptyState>
                </li>
              )}
            </ul>
            <Button block icon={<UserPlus className="size-4" />} onClick={() => { setCreating(true); setNameError(null); setPhone(/^\d/.test(q) ? q : ''); setName(/^\d/.test(q) ? '' : q); }}>
              Yeni müşteri
            </Button>
          </>
        ) : (
          <div className="space-y-3">
            <Field label="Ad soyad" required error={nameError}>
              <Input
                ref={nameRef}
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setNameError(null);
                }}
                autoFocus={fine}
                autoCapitalize="words"
                enterKeyHint="next"
              />
            </Field>
            <Field label="Telefon" hint="sonraki ziyarette bununla bulunur">
              <Input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" spellCheck={false} placeholder="Ör. 0532 123 45 67" />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Button onClick={() => setCreating(false)}>Geri</Button>
              <Button variant="primary" onClick={create}>
                Kaydet ve ekle
              </Button>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}
