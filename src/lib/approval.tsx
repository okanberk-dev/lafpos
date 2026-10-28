import { ShieldCheck } from 'lucide-react';
import { useEffect, useState } from 'react';
import { PERMISSIONS } from '@shared/permissions';
import { Button } from '@/components/ui/Button';
import { Notice } from '@/components/ui/misc';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad, PinDots } from '@/components/ui/Numpad';
import { errorMessage } from './api';
import { useApproval } from './approvalStore';
import { DEMO, demoApprovers } from './demo';

export { cancelApproval, withApproval } from './approvalStore';

export function ApprovalHost() {
  const pending = useApproval((s) => s.pending);
  const close = useApproval((s) => s.close);
  const [pin, setPin] = useState('');

  // Her soru (ilk ve her yanlış PIN'den sonraki) boş alanla başlar
  useEffect(() => {
    setPin('');
  }, [pending?.attempt]);

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
        <Notice key={pending.attempt} tone={pending.error ? 'danger' : 'warn'} icon={<ShieldCheck />} role={pending.error ? 'alert' : undefined}>
          {pending.error ?? pending.message}. {DEMO ? 'Demoda PIN sorulmaz: onaylayacak kişiyi seçin' : 'Yetkili kişi PIN’ini girsin'}
        </Notice>
        {DEMO ? (
          <div className="grid gap-2">
            {demoApprovers().map((u) => (
              <Button key={u.role} onClick={() => submit(u.pin)}>
                {u.name} onaylasın
              </Button>
            ))}
            <Button variant="ghost" onClick={cancel}>
              Vazgeç
            </Button>
          </div>
        ) : (
          <>
            <PinDots filled={pin.length} className="py-1" />
            {/* Kasa bilgisayarında PIN klavyeden de girilir; Enter onaylar */}
            <Numpad
              keyboard
              onEnter={() => submit()}
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
          </>
        )}
      </div>
    </Modal>
  );
}

export { errorMessage };
