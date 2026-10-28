import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { HappyHourDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { PageLoading } from '@/components/ui/misc';
import { Badge, BTN, Card, PageHeader } from '@/components/admin/ui';
import { del, errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

interface Group {
  id: string;
  name: string;
  kind: 'single' | 'multi' | 'counter';
  required: boolean;
  maxSelect: number;
  sort: number;
  active: boolean;
  extSource: string | null;
}
interface Item {
  id: string;
  groupId: string;
  name: string;
  price: number;
  isDefault: boolean;
  maxQty: number;
  sort: number;
  active: boolean;
}
type EditItem = { id?: string; name: string; price: string; isDefault: boolean; maxQty: number };

const KIND_LABEL = { single: 'Tek seçim', multi: 'Çoklu seçim', counter: 'Adetli' };
const DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

export default function OptionsAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => get<{ optionGroups: Group[]; optionItems: Item[] }>('/admin/menu') });
  const hh = useQuery({ queryKey: ['admin', 'happy'], queryFn: () => get<HappyHourDTO[]>('/admin/happy-hours') });
  const [edit, setEdit] = useState<{ id?: string; name: string; kind: Group['kind']; required: boolean; maxSelect: number; active: boolean; items: EditItem[] } | null>(null);
  const [happy, setHappy] = useState<(Omit<HappyHourDTO, 'id'> & { id?: string }) | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const saveGroup = async () => {
    if (!edit) return;
    const body = { name: edit.name, kind: edit.kind, required: edit.required, maxSelect: edit.maxSelect, sort: 50, active: edit.active, items: edit.items.map((i, idx) => ({ id: i.id, name: i.name, price: parseTL(i.price || '0') ?? 0, isDefault: i.isDefault, maxQty: i.maxQty, sort: idx, active: true })) };
    try {
      if (edit.id) await put(`/admin/option-groups/${edit.id}`, body);
      else await post('/admin/option-groups', body);
      toast.ok('Seçenek grubu kaydedildi');
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const saveHappy = async () => {
    if (!happy) return;
    try {
      const { id, ...body } = happy;
      if (id) await put(`/admin/happy-hours/${id}`, body);
      else await post('/admin/happy-hours', body);
      toast.ok('Happy hour kaydedildi');
      setHappy(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  if (data.isLoading) return <PageLoading />;
  const groups = data.data?.optionGroups ?? [];
  const items = data.data?.optionItems ?? [];

  return (
    <div className="space-y-4">
      <PageHeader
        title="Seçenekler ve happy hour"
        description="Süt, şurup ve shot siteden gelir; kasaya özel grupları buradan ekleyin"
        actions={
          <button type="button" className={BTN.primary} onClick={() => setEdit({ name: '', kind: 'single', required: false, maxSelect: 1, active: true, items: [{ name: '', price: '', isDefault: true, maxQty: 1 }] })}>
            <Plus className="size-4" aria-hidden="true" />
            Grup ekle
          </button>
        }
      />
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const its = items.filter((i) => i.groupId === g.id && i.active);
          return (
            <Card flush
              key={g.id}
              className={cn(!g.active && 'opacity-60')}
              title={
                <span className="flex items-center gap-2">
                  {g.name}
                  {g.extSource ? (
                    <Badge tone="success">
                      <Globe className="size-3" /> Site
                    </Badge>
                  ) : (
                    <Badge>Yerel</Badge>
                  )}
                </span>
              }
              actions={
                !g.extSource && (
                  <button type="button" className={BTN.ghost} onClick={() => setEdit({ id: g.id, name: g.name, kind: g.kind, required: g.required, maxSelect: g.maxSelect, active: g.active, items: its.map((i) => ({ id: i.id, name: i.name, price: i.price ? String(i.price / 100).replace('.', ',') : '', isDefault: i.isDefault, maxQty: i.maxQty })) })}>
                    Düzenle
                  </button>
                )
              }
            >
              <div className="px-4 pb-4 text-sm sm:px-5">
                <div className="mb-2 text-xs text-[var(--admin-text-mute)]">
                  {KIND_LABEL[g.kind]}
                  {g.required && ' · zorunlu'}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {its.map((i) => (
                    <span key={i.id} className={cn('inline-flex items-baseline gap-1.5 rounded-full border border-[var(--admin-border)] px-2.5 py-1 text-xs text-[var(--admin-text)]', i.isDefault && 'bg-[var(--admin-panel)]')}>
                      <span>
                        {i.name}
                        {i.price > 0 && ` +${tl(i.price)}`}
                        {g.kind === 'counter' && i.maxQty > 1 && ` (en çok ${i.maxQty})`}
                      </span>
                      {i.isDefault && <span className="text-[11px] text-[var(--admin-text-mute)]">varsayılan</span>}
                    </span>
                  ))}
                </div>
              </div>
            </Card>
          );
        })}
      </div>

      <Card
        title="Happy hour"
        subtitle="Saat ve güne göre otomatik indirim"
        actions={
          <button type="button" className={BTN.ghost} onClick={() => setHappy({ name: '', days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00', percent: 15, categoryIds: [], productIds: [], active: true })}>
            <Plus className="size-4" aria-hidden="true" />
            Kural ekle
          </button>
        }
        flush
      >
        <ul className="divide-y divide-[var(--admin-divider)]">
          {(hh.data ?? []).map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-[var(--admin-text)]">{h.name}</span> <Badge tone={h.active ? 'success' : 'neutral'}>{h.active ? 'Açık' : 'Kapalı'}</Badge>
                <span className="mt-0.5 block text-xs text-[var(--admin-text-mute)]">
                  %{h.percent} · {h.days.map((d) => DAYS[d - 1]).join(', ')} · {h.start}–{h.end} · {h.categoryIds.length ? h.categoryIds.map((c) => boot.categories.find((x) => x.id === c)?.name).filter(Boolean).join(', ') : 'bütün menü'}
                </span>
              </span>
              <button type="button" className={BTN.ghost} onClick={() => setHappy({ ...h })}>
                Düzenle
              </button>
              <button
                type="button"
                className={cn(BTN.danger, 'min-w-11')}
                onClick={async () => {
                  if (!window.confirm(`${h.name} silinsin mi?`)) return;
                  await del(`/admin/happy-hours/${h.id}`).catch((e) => toast.err(errorMessage(e)));
                  refresh();
                }}
              >
                Sil
              </button>
            </li>
          ))}
          {hh.data?.length === 0 && <li className="px-4 py-6 text-center text-sm text-[var(--admin-text-mute)]">Kural yok</li>}
        </ul>
      </Card>

      <Modal open={!!edit} onClose={() => setEdit(null)} size="lg" title={edit?.id ? 'Seçenek grubu' : 'Yeni seçenek grubu'} footer={<div className="flex justify-end gap-2"><Button onClick={() => setEdit(null)}>Vazgeç</Button><Button variant="primary" disabled={!edit?.name.trim() || !edit.items.some((i) => i.name.trim())} onClick={saveGroup}>Kaydet</Button></div>}>
        {edit && (
          <div className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Ad">
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="ör. Bardak" />
              </Field>
              <Field label="Tür">
                <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Group['kind'] })}>
                  <option value="single">Tek seçim</option>
                  <option value="multi">Çoklu seçim</option>
                  <option value="counter">Adetli (ör. ekstra şeker)</option>
                </Select>
              </Field>
              <Field label="Zorunlu">
                <Toggle checked={edit.required} onChange={(v) => setEdit({ ...edit, required: v })} label={edit.required ? 'Evet' : 'Hayır'} />
              </Field>
            </div>
            <div className="space-y-2">
              {edit.items.map((it, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={it.name} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Seçenek" />
                  <Input value={it.price} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} placeholder="+₺" className="w-24" inputMode="decimal" />
                  {edit.kind === 'single' && (
                    <label className="flex items-center gap-1 whitespace-nowrap text-xs">
                      <input type="radio" checked={it.isDefault} onChange={() => setEdit({ ...edit, items: edit.items.map((x, j) => ({ ...x, isDefault: j === i })) })} /> varsayılan
                    </label>
                  )}
                  {edit.kind === 'counter' && (
                    <Input type="number" min={1} max={9} value={it.maxQty} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, maxQty: Number(e.target.value) || 1 } : x)) })} className="w-20" />
                  )}
                  <button type="button" aria-label="Seçeneği sil" className="grid size-11 shrink-0 place-items-center rounded-lg text-[var(--admin-text-mute)] hover:bg-[var(--admin-surface-2)] hover:text-[var(--admin-danger-ink)]" onClick={() => setEdit({ ...edit, items: edit.items.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit({ ...edit, items: [...edit.items, { name: '', price: '', isDefault: false, maxQty: 1 }] })}>
                Seçenek ekle
              </Button>
            </div>
            <p className="text-xs text-[var(--admin-text-mute)]">Grubu ürünlere Menü › Düzenle › Seçenek grupları'ndan bağlayın</p>
          </div>
        )}
      </Modal>

      <Modal open={!!happy} onClose={() => setHappy(null)} title="Happy hour kuralı" footer={<div className="flex justify-end gap-2"><Button onClick={() => setHappy(null)}>Vazgeç</Button><Button variant="primary" disabled={!happy?.name.trim() || !happy?.days.length} onClick={saveHappy}>Kaydet</Button></div>}>
        {happy && (
          <div className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Ad">
                <Input value={happy.name} onChange={(e) => setHappy({ ...happy, name: e.target.value })} placeholder="ör. Öğleden sonra kahvesi" />
              </Field>
              <Field label="İndirim (%)">
                <Input type="number" min={1} max={100} value={happy.percent} onChange={(e) => setHappy({ ...happy, percent: Number(e.target.value) || 1 })} />
              </Field>
              <Field label="Başlangıç">
                <Input type="time" value={happy.start} onChange={(e) => setHappy({ ...happy, start: e.target.value })} />
              </Field>
              <Field label="Bitiş">
                <Input type="time" value={happy.end} onChange={(e) => setHappy({ ...happy, end: e.target.value })} />
              </Field>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium text-[var(--admin-text-soft)]">Günler</div>
              <div className="flex flex-wrap gap-1.5">
                {DAYS.map((d, i) => {
                  const on = happy.days.includes(i + 1);
                  return (
                    <button key={d} type="button" aria-pressed={on} onClick={() => setHappy({ ...happy, days: on ? happy.days.filter((x) => x !== i + 1) : [...happy.days, i + 1].sort() })} className={cn('min-h-9 rounded-lg border px-3 text-sm transition-colors pointer-coarse:min-h-11', on ? 'border-[var(--admin-text)] font-semibold text-[var(--admin-text)]' : 'border-[var(--admin-border)] text-[var(--admin-text-soft)] hover:border-[var(--admin-border-field)]')}>
                      {d}
                    </button>
                  );
                })}
              </div>
            </div>
            <div>
              <div className="mb-1.5 text-sm font-medium text-[var(--admin-text-soft)]">Kategoriler (boş = bütün menü)</div>
              <div className="flex flex-wrap gap-1.5">
                {boot.categories.map((c) => {
                  const on = happy.categoryIds.includes(c.id);
                  return (
                    <button key={c.id} type="button" aria-pressed={on} onClick={() => setHappy({ ...happy, categoryIds: on ? happy.categoryIds.filter((x) => x !== c.id) : [...happy.categoryIds, c.id] })} className={cn('min-h-9 rounded-lg border px-3 text-sm transition-colors pointer-coarse:min-h-11', on ? 'border-[var(--admin-text)] font-semibold text-[var(--admin-text)]' : 'border-[var(--admin-border)] text-[var(--admin-text-soft)] hover:border-[var(--admin-border-field)]')}>
                      {c.name}
                    </button>
                  );
                })}
              </div>
            </div>
            <Toggle checked={happy.active} onChange={(v) => setHappy({ ...happy, active: v })} label="Kural açık" />
          </div>
        )}
      </Modal>
    </div>
  );
}
