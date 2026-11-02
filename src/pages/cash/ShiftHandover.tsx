import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, BadgeCheck } from 'lucide-react';
import { useState } from 'react';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import type { ShiftCountDTO, ZSummary } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Textarea } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card } from '@/components/ui/misc';
import { errorMessage, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { CashCount, type CountResult } from './CashCount';

const emptyCount = (): CountResult => ({ countedCash: 0, banknotes: {}, methodCounts: {} });

/**
 * Vardiya devri: gün içinde kasiyer değişirken devreden kasayı sayar. Beklenen nakit ve fark o anın ara raporundan
 * (kör kasada gizli); devralan PIN'ini girerse devir onaylı yazılır. Sayım, beklenen ve fark denetim kaydına düşer.
 */
export function ShiftHandoverModal({ open, onClose, summary }: { open: boolean; onClose: () => void; summary: ZSummary | null }) {
  const boot = useBoot();
  const me = useAuth((s) => s.me);
  const qc = useQueryClient();
  const [count, setCount] = useState<CountResult>(emptyCount());
  const [toUserId, setToUserId] = useState('');
  const [pin, setPin] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const staff = boot.users.filter((u) => u.active && u.id !== me?.id);
  const reset = () => {
    setCount(emptyCount());
    setToUserId('');
    setPin('');
    setNote('');
  };
  const save = async () => {
    setBusy(true);
    try {
      const banknotes = Object.fromEntries(Object.entries(count.banknotes).filter(([, n]) => n > 0));
      const r = await post<ShiftCountDTO>('/cash/shift-counts', {
        countedCash: count.countedCash,
        ...(Object.keys(banknotes).length ? { banknotes } : {}),
        toUserId: toUserId || null,
        approverPin: pin || null,
        note: note.trim() || null,
      });
      await qc.invalidateQueries({ queryKey: ['cash'] });
      const who = r.toUserName ? `${r.toUserName} devraldı` : 'Ara sayım kaydedildi';
      toast.ok(r.diff == null ? `${who}; fark yöneticinin ekranında` : r.diff === 0 ? `${who}; kasa tuttu` : `${who}; fark ${tl(r.diff)}`);
      reset();
      onClose();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open={open}
      onClose={onClose}
      persistent={count.countedCash > 0}
      size="lg"
      title="Vardiya devri"
      subtitle="Çekmeceyi sayın, devralanı seçin; devralan PIN'ini girerse devir onaylı yazılır"
      footer={
        <div className="flex gap-2">
          <Button className="flex-1" onClick={onClose}>
            Vazgeç
          </Button>
          <Button className="flex-[2]" variant="primary" icon={<ArrowLeftRight className="size-4" />} loading={busy} disabled={count.countedCash <= 0} onClick={() => void save()}>
            Devri kaydet · <span className="tabular">{tl(count.countedCash)}</span>
          </Button>
        </div>
      }
    >
      <div className="space-y-5 p-5">
        <CashCount cashOnly summary={summary} value={count} onChange={setCount} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Devralan" hint="boşsa ara sayım">
            <Select value={toUserId} onChange={(e) => setToUserId(e.target.value)}>
              <option value="">Seçilmedi</option>
              {staff.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Devralanın PIN'i" hint="isteğe bağlı, onay">
            <Input type="password" inputMode="numeric" autoComplete="off" maxLength={6} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} placeholder="••••" />
          </Field>
        </div>
        <Field label="Not" hint="isteğe bağlı">
          <Textarea value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="Ör. bozuk para azaldı, 2 rulo istendi" />
        </Field>
      </div>
    </Modal>
  );
}

/** Günün vardiya devirleri: kim kime, ne saydı; beklenen ve fark yalnız kasa rakamlarını görene */
export function ShiftCountsCard({ counts }: { counts: ShiftCountDTO[] }) {
  if (!counts.length) return null;
  return (
    <Card title="Vardiya devirleri" subtitle="Gün içinde kasiyer değişirken yapılan sayımlar">
      <ul className="divide-y divide-[var(--admin-divider)]">
        {counts.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-surface-3 text-ink-2">
              <ArrowLeftRight className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 font-medium">
                {s.toUserName ? `${s.userName} → ${s.toUserName}` : `${s.userName} · ara sayım`}
                {s.confirmed && (
                  <Badge tone="success">
                    <BadgeCheck className="size-3" aria-hidden="true" />
                    Onaylı
                  </Badge>
                )}
              </span>
              <span className="block text-xs text-muted">{joinMeta([fmtTime(s.createdAt), s.note])}</span>
            </span>
            <span className="text-right">
              <span className="tabular block font-semibold">{s.counted != null ? tl(s.counted) : '—'}</span>
              {s.diff != null && (
                <span className={cn('tabular block text-xs font-medium', s.diff === 0 ? 'text-success-ink' : 'text-danger-ink')}>
                  {s.diff === 0 ? 'Tuttu' : `Fark ${tl(s.diff)}`}
                  {s.expected != null && <span className="font-normal text-muted"> · beklenen {tl(s.expected)}</span>}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
