import { useEffect, useState } from 'react';
import { NUMARATOR_MAX } from '@shared/service-mode';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';

/**
 * Yarı self servis: masa no / numaratör. Tezgâh satışında "Öde" ya da "Gönder"e basınca bir kez sorulur (isteğe
 * bağlı, "Numarasız devam"); adisyonda saklanır, bar fişinde ve çağrı ekranında numara yerine görünür.
 * `flow`: satış akışının içinden açıldı (Devam / Numarasız devam); değilse düzenleme (Kaydet / Kaldır).
 */
export function NumaratorModal({
  open,
  initial,
  flow,
  onClose,
  onConfirm,
}: {
  open: boolean;
  initial: string | null;
  flow: boolean;
  onClose: () => void;
  onConfirm: (value: string | null) => void;
}) {
  const [value, setValue] = useState('');
  useEffect(() => {
    if (open) setValue(initial ?? '');
  }, [open, initial]);

  return (
    <Modal open={open} onClose={onClose} size="sm" title="Masa no / numaratör" subtitle="Sipariş hazır olunca personel bu masaya götürür">
      <div className="space-y-3 p-4">
        <output aria-live="polite" className="tabular block rounded-xl border border-primary px-4 py-3 text-center text-4xl font-bold tracking-tight ring-4 ring-[var(--admin-primary-soft)]">
          {value ? `Masa ${value}` : <span className="text-muted">—</span>}
        </output>
        <Numpad size="md" onKey={(k) => setValue((v) => applyNumpadKey(v, k, { maxLength: NUMARATOR_MAX }))} />
        <div className="grid grid-cols-2 gap-2 pt-1">
          {flow ? (
            <Button size="lg" onClick={() => onConfirm(null)}>
              Numarasız devam
            </Button>
          ) : (
            <Button size="lg" disabled={!initial} onClick={() => onConfirm(null)}>
              Kaldır
            </Button>
          )}
          <Button size="lg" variant="primary" disabled={!value} onClick={() => onConfirm(value)}>
            {flow ? 'Devam' : 'Kaydet'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
