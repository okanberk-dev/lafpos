import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { create } from 'zustand';
import { PERMISSIONS, type Permission } from '@shared/permissions';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';
import { ApiError, errorMessage } from './api';

/**
 * Yetkili onayı: sunucu 403 `approval_required` dönünce PIN penceresi açılır, istek `approverPin` ile
 * tekrarlanır. Yanlış PIN'de pencere açık kalır.
 */
interface Pending {
  message: string;
  permission: Permission | null;
  resolve: (pin: string | null) => void;
  error: string | null;
}

const useApproval = create<{ pending: Pending | null; open: (p: Omit<Pending, 'error'>) => void; fail: (msg: string) => void; close: () => void }>((set) => ({
  pending: null,
  open: (p) => set({ pending: { ...p, error: null } }),
  fail: (msg) => set((s) => (s.pending ? { pending: { ...s.pending, error: msg } } : s)),
  close: () => set({ pending: null }),
}));

function askPin(message: string, permission: Permission | null): Promise<string | null> {
  return new Promise((resolve) => useApproval.getState().open({ message, permission, resolve }));
}

/** `fn` yetki isterse PIN sorup yeniden dener. Kullanıcı vazgeçerse null döner. */
export async function withApproval<T>(fn: (approverPin?: string) => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'approval_required') throw e;
    const permission = (e.data.permission as Permission) ?? null;
    let message = e.message;
    for (;;) {
      const pin = await askPin(message, permission);
      if (!pin) return null;
      try {
        const result = await fn(pin);
        useApproval.getState().close();
        return result;
      } catch (err) {
        if (err instanceof ApiError && ['approval_invalid', 'approval_forbidden', 'rate_limited'].includes(err.code ?? '')) {
          useApproval.getState().fail(err.message);
          message = err.message;
          continue;
        }
        useApproval.getState().close();
        throw err;
      }
    }
  }
}

export function ApprovalHost() {
  const pending = useApproval((s) => s.pending);
  const close = useApproval((s) => s.close);
  const [pin, setPin] = useState('');

  useEffect(() => {
    setPin('');
  }, [pending?.message, pending?.error]);

  if (!pending) return null;
  const submit = (value = pin) => {
    if (value.length < 4) return;
    pending.resolve(value);
  };
  const cancel = () => {
    pending.resolve(null);
    close();
  };
  return (
    <Modal open onClose={cancel} size="sm" title="Yetkili onayı" subtitle={pending.permission ? PERMISSIONS[pending.permission] : undefined}>
      <div className="space-y-4 p-5">
        <div className="flex items-start gap-3 rounded-2xl bg-warn-50 p-3 text-sm text-warn-700 dark:bg-warn-700/20 dark:text-warn-100">
          <ShieldCheck className="mt-0.5 size-5 shrink-0" />
          <span>{pending.error ?? pending.message}. Yetkili kişi PIN'ini girsin</span>
        </div>
        <div className="flex justify-center gap-3 py-1" aria-label="PIN">
          {Array.from({ length: 6 }, (_, i) => (
            <span key={i} className={`size-3.5 rounded-full ${i < pin.length ? 'bg-brand-700 dark:bg-brand-300' : 'bg-line-strong'} ${i >= 4 && i >= pin.length ? 'opacity-40' : ''}`} />
          ))}
        </div>
        <Numpad
          onKey={(k) => {
            const next = applyNumpadKey(pin, k, { maxLength: 6 });
            setPin(next);
          }}
        />
        <div className="grid grid-cols-2 gap-2">
          <Button onClick={cancel}>Vazgeç</Button>
          <Button variant="primary" disabled={pin.length < 4} onClick={() => submit()}>
            Onayla
          </Button>
        </div>
      </div>
    </Modal>
  );
}

export { errorMessage };
