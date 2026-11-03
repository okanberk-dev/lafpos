import { useQuery } from '@tanstack/react-query';
import { Gift, UserPlus, X } from 'lucide-react';
import { useId, useRef, useState } from 'react';
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

/** Açık hesap bakiyesi sözle: artı müşterinin borcu, eksi alacağı (renk tek başına anlam taşımaz) */
const balanceText = (balance: number) => (balance > 0 ? `Borç ${tl(balance)}` : `Alacak ${tl(-balance)}`);

/** Adisyona müşteri: telefonla bul ya da ekle. Damga kartı ve açık hesap için. */
export function CustomerModal({ order, open, onClose, act }: { order: OrderDTO; open: boolean; onClose: () => void; act: Act }) {
  const boot = useBoot();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  /** Süren istek: kaydet, hediye ya da ekle/kaldır; ikinci dokunuş ikinci müşteri ya da ikinci hediye yazmaz */
  const [busy, setBusy] = useState<'create' | 'redeem' | 'attach' | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const formId = useId();
  const fine = useFinePointer();
  const list = useQuery({ queryKey: ['customers', 'search', q], queryFn: () => get<CustomerRow[]>(`/customers?q=${encodeURIComponent(q)}&limit=12`), enabled: open && !creating });
  if (!open) return null;
  const goal = boot.settings.stampGoal;
  // Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada)
  const stamps = boot.integrations.localStamps;
  const current = order.customer;

  const attach = async (customerId: string | null, message?: string) => {
    const res = await act(() => patch(`/orders/${order.id}`, { customerId }), message ?? (customerId ? 'Müşteri eklendi' : 'Müşteri kaldırıldı'));
    if (res) onClose();
    return res;
  };
  const pick = async (customerId: string | null) => {
    if (busy) return;
    setBusy('attach');
    try {
      await attach(customerId);
    } finally {
      setBusy(null);
    }
  };
  const create = async () => {
    if (busy) return;
    // Zorunlu alan eksikse ileti alanın altında (düğme sessizce soluk kalmaz)
    if (!name.trim()) {
      setNameError('Ad soyad gerekli');
      nameRef.current?.focus();
      return;
    }
    setBusy('create');
    try {
      // Tek bildirim: kayıt ve ekleme birlikte söylenir
      const c = await act((pin) => post<CustomerRow>('/customers', { name, phone: phone || null, approverPin: pin }));
      if (!c) return;
      const added = await attach(c.id, 'Müşteri kaydedildi ve adisyona eklendi');
      // Kayıt oldu ama adisyona eklenemedi: ikinci kez kaydedilmesin, listede bulunup eklenir
      if (!added) {
        setCreating(false);
        setQ(c.phone ?? c.name);
      }
    } finally {
      setBusy(null);
    }
  };
  const redeem = async (customerId: string) => {
    if (busy) return;
    setBusy('redeem');
    try {
      await act((pin) => post(`/customers/${customerId}/redeem`, { approverPin: pin }), `${goal} damga kullanıldı; bir içeceği ikram edin`);
    } finally {
      setBusy(null);
    }
  };
  const startCreate = () => {
    setCreating(true);
    setNameError(null);
    setPhone(/^\d/.test(q) ? q : '');
    setName(/^\d/.test(q) ? '' : q);
  };

  const footer = creating ? (
    <div className="grid grid-cols-2 gap-2">
      <Button disabled={busy === 'create'} onClick={() => setCreating(false)}>
        Geri
      </Button>
      <Button type="submit" form={formId} variant="primary" className="whitespace-normal leading-tight" loading={busy === 'create'}>
        Kaydet ve ekle
      </Button>
    </div>
  ) : (
    <Button block icon={<UserPlus className="size-4" />} onClick={startCreate}>
      Yeni müşteri
    </Button>
  );

  return (
    <Modal
      open
      onClose={onClose}
      persistent={busy === 'create'}
      title={creating ? 'Yeni müşteri' : 'Müşteri'}
      subtitle={creating ? undefined : stamps ? 'Telefon ya da adla bulun; damga kartı ve açık hesap için' : 'Telefon ya da adla bulun; açık hesap ve sipariş geçmişi için'}
      size="md"
      footer={footer}
    >
      {!creating ? (
        <div className="space-y-3 px-5 py-4">
          {current && (
            <div className="flex items-center gap-3 rounded-2xl border border-primary-line bg-primary-soft py-2 pl-4 pr-2">
              <div className="min-w-0 flex-1 py-1">
                <div className="font-semibold">{current.name}</div>
                <div className="tabular text-xs text-ink-2">{joinMeta([current.phone, stamps && `${current.stamps}/${goal} damga`, current.balance !== 0 && balanceText(current.balance).toLocaleLowerCase('tr')])}</div>
              </div>
              {/* Damga ödülü pirinçte (damga kartının rengi); amber zamanın rengidir */}
              {stamps && current.stamps >= goal && (
                <Button size="sm" icon={<Gift className="size-4 text-gold-ink" />} loading={busy === 'redeem'} disabled={!!busy && busy !== 'redeem'} onClick={() => void redeem(current.id)}>
                  Hediye içecek
                </Button>
              )}
              <IconButton size="sm" label="Müşteriyi kaldır" disabled={!!busy} onClick={() => void pick(null)}>
                <X className="size-4" />
              </IconButton>
            </div>
          )}
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
                  onClick={() => void pick(c.id)}
                  disabled={!!busy}
                  aria-current={current?.id === c.id || undefined}
                  className={cn('flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition-colors duration-150 enabled:hover:bg-hover enabled:active:bg-press disabled:cursor-progress', current?.id === c.id && 'bg-primary-soft')}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{c.name}</span>
                    <span className="tabular text-xs text-muted">{joinMeta([c.phone, `${c.visits} ziyaret`])}</span>
                  </span>
                  <span className="tabular shrink-0 text-right text-xs">
                    {stamps && (
                      <span className="block font-semibold text-gold-ink">
                        {c.stamps}/{goal} damga
                      </span>
                    )}
                    {c.balance !== 0 && <span className="block text-ink-2">{balanceText(c.balance)}</span>}
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
        </div>
      ) : (
        // Adda Enter telefona geçer, telefonda kaydeder; düğme alt şeritte, formun dışında (form=)
        <form
          id={formId}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
          className="space-y-3 px-5 py-4"
        >
          <Field label="Ad soyad" required error={nameError}>
            <Input
              ref={nameRef}
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameError(null);
              }}
              onKeyDown={(e) => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                phoneRef.current?.focus();
              }}
              autoFocus={fine}
              autoCapitalize="words"
              enterKeyHint="next"
            />
          </Field>
          <Field label="Telefon" hint="sonraki ziyarette bununla bulunur">
            <Input ref={phoneRef} type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" spellCheck={false} enterKeyHint="done" placeholder="Ör. 0532 123 45 67" />
          </Field>
        </form>
      )}
    </Modal>
  );
}
