import { useEffect, useState } from 'react';
import { NUMARATOR_MAX, numaratorInput } from '@shared/service-mode';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { applyNumpadKey, Numpad } from '@/components/ui/Numpad';

/**
 * Yarı self servis: masa no / numaratör. Tezgâh satışında "Öde" ya da "Gönder"e basınca bir kez sorulur (isteğe
 * bağlı, "Numarasız devam"); adisyonda saklanır, bar fişinde ve çağrı ekranında numara yerine görünür. Rakamlar tuş
 * takımından, harfli masa adları ("B4", "BAH2") alana dokunup klavyeden.
 * `flow`: satış akışının içinden açıldı (Devam / Numarasız devam); değilse düzenleme (Kaydet / Kaldır ya da Vazgeç).
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

  // Düğmeler onay pencereleriyle aynı yerde: altta, eşit iki sütun. Düzenlemede numara yoksa kaldırılacak bir şey de
  // yok: soluk "Kaldır" yerine Vazgeç
  const footer = (
    <div className="grid grid-cols-2 gap-2">
      {flow ? (
        <Button size="lg" onClick={() => onConfirm(null)}>
          Numarasız devam
        </Button>
      ) : initial ? (
        <Button size="lg" onClick={() => onConfirm(null)}>
          Kaldır
        </Button>
      ) : (
        <Button size="lg" onClick={onClose}>
          Vazgeç
        </Button>
      )}
      <Button size="lg" variant="primary" disabled={!value} onClick={() => onConfirm(value)}>
        {flow ? 'Devam' : 'Kaydet'}
      </Button>
    </div>
  );

  return (
    <Modal open={open} onClose={onClose} size="sm" title="Masa no / numaratör" subtitle="Sipariş hazır olunca personel bu masaya götürür" footer={footer}>
      <div className="space-y-3 px-5 py-4">
        {/* Yazı boyu etikette (text-4xl): dokunmatikte alanların 16 px kuralı 1em'i üst öğeden okur, değer 36 px kalır.
            Alan yazıyla büyür (field-sizing), "Masa" ile birlikte ortada durur; en uzun ad (6 harf) sığar. Odak halkası
            yalnız alan odaktayken */}
        <label className="flex items-baseline justify-center gap-2 rounded-xl border border-line-strong px-4 py-3 text-4xl transition-[border-color,box-shadow] duration-150 focus-within:border-primary focus-within:ring-4 focus-within:ring-[var(--admin-primary-soft)]">
          <span className="shrink-0 text-2xl font-semibold text-muted">Masa</span>
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
            className="tabular font-headline min-h-11 min-w-11 max-w-[6em] bg-transparent font-bold tracking-tight text-ink outline-none placeholder:text-muted [field-sizing:content]"
          />
        </label>
        <Numpad size="md" keyboard onEnter={() => value && onConfirm(value)} onKey={(k) => setValue((v) => applyNumpadKey(v, k, { maxLength: NUMARATOR_MAX }))} />
      </div>
    </Modal>
  );
}
