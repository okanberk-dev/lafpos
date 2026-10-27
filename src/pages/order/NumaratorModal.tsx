import { useEffect, useState } from 'react';
import { NUMARATOR_MAX, numaratorInput } from '@shared/service-mode';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';

/**
 * Yarı self servis: masa no / numaratör. Tezgâh satışında "Öde" ya da "Gönder"e basınca bir kez sorulur (isteğe
 * bağlı, "Numarasız devam"); adisyonda saklanır, bar fişinde ve çağrı ekranında numara yerine görünür. Rakamlar tuş
 * takımından, harfli masa adları ("B4", "BAH2") alana dokunup klavyeden.
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
        <label className="flex items-baseline justify-center gap-2 rounded-xl border border-primary px-4 py-3 ring-4 ring-[var(--admin-primary-soft)]">
          <span className="text-2xl font-semibold text-muted">Masa</span>
          <input
            aria-label="Masa no"
            value={value}
            onChange={(e) => setValue(numaratorInput(e.target.value))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && value) onConfirm(value);
            }}
            placeholder="—"
            inputMode="text"
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            maxLength={NUMARATOR_MAX}
            className="tabular min-h-11 w-[7ch] bg-transparent text-4xl font-bold tracking-tight text-ink outline-none placeholder:text-muted"
          />
        </label>
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
