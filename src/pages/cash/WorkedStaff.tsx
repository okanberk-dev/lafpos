import { Pencil, RotateCcw, Save, Users } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Chip } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, Notice } from '@/components/ui/misc';
import { errorMessage, put } from '@/lib/api';
import { toast } from '@/lib/toast';

/** GET /cash/days/:id `worked`: o gün çalışanlar (docs/03-ENTEGRASYON.md §4.8) */
export interface WorkedDTO {
  /** Geçerli liste: kayıtlardan çıkan; düzeltme varsa onun eklediği katılır, çıkardığı düşer (kapanmış günde seçilenin tamamı) */
  ids: string[];
  /** Günün kayıtlarından çıkan (adisyon, kalem, ödeme, kasa hareketi, vardiya sayımı, günü açan ve kapatan) */
  derivedIds: string[];
  /** "Bugün çalışanlar" elle düzeltildi */
  corrected: boolean;
  /** Seçilebilecek personel; `linked`: lafmaliyet personeline bağlı (yalnız bağlı kişi lafmaliyet'e gider) */
  people: { id: string; name: string; active: boolean; linked: boolean }[];
}

/**
 * Kasa › Geçmiş günler › "Bugün çalışanlar": lafmaliyet'in yemek kartı günleri bu listeden (bağlı kişilerin personel
 * kimliği gider, ad gitmez). Liste günün kayıtlarından çıkar; ortak girişle çalışan ya da hiç giriş yapmayan (bar)
 * personel görünmez, yalnız günü kapatan yönetici görünür: yönetim düzeltir, düzeltme kayıtların yerine geçer ve gün
 * lafmaliyet'e yeniden gider
 */
export function WorkedStaffCard({ dayId, worked, editable, onSaved }: { dayId: string; worked: WorkedDTO; editable: boolean; onSaved: () => void }) {
  const [editing, setEditing] = useState(false);
  const byId = new Map(worked.people.map((p) => [p.id, p]));
  const people = worked.ids
    .map((id) => byId.get(id))
    .filter((p): p is WorkedDTO['people'][number] => !!p)
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  const anyLinked = worked.people.some((p) => p.linked);
  return (
    <Card
      title="Bugün çalışanlar"
      subtitle={worked.corrected ? 'Elle düzeltildi' : 'Günün kayıtlarından: adisyon, ödeme, kasa hareketi, gün açma ve kapama'}
      actions={
        editable ? (
          <Button size="sm" icon={<Pencil className="size-4" />} className="pointer-coarse:min-h-11" onClick={() => setEditing(true)}>
            Düzelt
          </Button>
        ) : undefined
      }
    >
      {people.length === 0 ? (
        <EmptyState compact icon={<Users />} title={worked.corrected ? 'Bu gün kimse çalışmadı olarak düzeltildi' : 'Kayıtlarda çalışan yok'} />
      ) : (
        <ul className="flex flex-wrap gap-2 px-4 py-3" aria-label="Çalışanlar">
          {people.map((p) => (
            <li key={p.id} className="flex items-center gap-1.5 rounded-[var(--r-chip)] border border-[var(--admin-border)] bg-surface-2 px-3 py-1.5 text-sm">
              <span className="font-medium">{p.name}</span>
              {anyLinked && !p.linked && <Badge>lafmaliyet’e bağlı değil</Badge>}
            </li>
          ))}
        </ul>
      )}
      {editing && <WorkedEditor dayId={dayId} worked={worked} onClose={() => setEditing(false)} onSaved={onSaved} />}
    </Card>
  );
}

function WorkedEditor({ dayId, worked, onClose, onSaved }: { dayId: string; worked: WorkedDTO; onClose: () => void; onSaved: () => void }) {
  const [picked, setPicked] = useState<string[]>(worked.ids);
  const [saving, setSaving] = useState(false);
  const derived = new Set(worked.derivedIds);
  const toggle = (id: string) => setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]));
  const save = async (userIds: string[] | null) => {
    setSaving(true);
    try {
      await put(`/cash/days/${dayId}/worked`, { userIds });
      toast.ok(userIds == null ? 'Çalışanlar kayıtlara döndü' : 'Çalışanlar kaydedildi');
      onSaved();
      onClose();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      title="Bugün çalışanları düzelt"
      subtitle="Ortak girişle çalışanı ya da hiç giriş yapmayanı ekleyin, yalnız günü kapatanı çıkarın"
      footer={
        <>
          {worked.corrected && (
            <Button icon={<RotateCcw className="size-4" />} disabled={saving} onClick={() => void save(null)}>
              Kayıtlara döndür
            </Button>
          )}
          <div className="flex-1" />
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save(picked)}>
            Kaydet
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <div role="group" aria-label="Çalışanlar" className="flex flex-wrap gap-2">
          {worked.people.map((p) => (
            <Chip key={p.id} on={picked.includes(p.id)} tone="ink" className="pointer-fine:min-h-11" onClick={() => toggle(p.id)}>
              {p.name}
              {derived.has(p.id) && <span className="sr-only"> (kayıtlarda var)</span>}
            </Chip>
          ))}
        </div>
        <Notice tone="info">Kaydedince gün lafmaliyet’e yeniden gider; lafmaliyet yemek kartı günlerini yalnız personeline bağlı kişilerde sayar (Yönetim › Personel)</Notice>
      </div>
    </Modal>
  );
}
