import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, Globe, ListChecks, Plus, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { parseTL, tl } from '@shared/money';
import type { HappyHourDTO } from '@shared/types';
import { Button, IconButton } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Label, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, ListSkeleton, Skeleton } from '@/components/ui/misc';
import { Badge, Card, CARD, EmptyState, PageHeader } from '@/components/admin/ui';
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
  const [saving, setSaving] = useState(false);
  // Eksik alan Kaydet'e basınca alanın altında söylenir (düğme sessizce soluk kalmaz)
  const [tried, setTried] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const groupErrors = edit ? { name: edit.name.trim() ? null : 'Grup adı gerekli', items: edit.items.some((i) => i.name.trim()) ? null : 'En az bir seçenek yazın' } : null;
  const happyErrors = happy ? { name: happy.name.trim() ? null : 'Kural adı gerekli', days: happy.days.length ? null : 'En az bir gün seçin' } : null;
  const openGroup = (g: NonNullable<typeof edit>) => {
    setTried(false);
    setEdit(g);
  };
  const openHappy = (h: NonNullable<typeof happy>) => {
    setTried(false);
    setHappy(h);
  };

  const saveGroup = async () => {
    if (!edit) return;
    if (groupErrors?.name || groupErrors?.items) {
      setTried(true);
      return;
    }
    // Adı boş kalan satır gönderilmez (sunucu boş adı reddeder)
    const body = { name: edit.name, kind: edit.kind, required: edit.required, maxSelect: edit.maxSelect, sort: 50, active: edit.active, items: edit.items.filter((i) => i.name.trim()).map((i, idx) => ({ id: i.id, name: i.name.trim(), price: parseTL(i.price || '0') ?? 0, isDefault: i.isDefault, maxQty: i.maxQty, sort: idx, active: true })) };
    setSaving(true);
    try {
      if (edit.id) await put(`/admin/option-groups/${edit.id}`, body);
      else await post('/admin/option-groups', body);
      toast.ok(`${edit.name.trim()} kaydedildi`);
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const saveHappy = async () => {
    if (!happy) return;
    if (happyErrors?.name || happyErrors?.days) {
      setTried(true);
      return;
    }
    setSaving(true);
    try {
      const { id, ...body } = happy;
      if (id) await put(`/admin/happy-hours/${id}`, body);
      else await post('/admin/happy-hours', body);
      toast.ok('Happy hour kuralı kaydedildi');
      setHappy(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const removeHappy = async (h: HappyHourDTO) => {
    if (!(await confirmDialog({ title: `${h.name} kuralı silinsin mi`, body: 'Bundan sonra indirim uygulanmaz; geçmiş satışlar değişmez', confirmLabel: 'Kuralı sil' }))) return;
    try {
      await del(`/admin/happy-hours/${h.id}`);
      toast.ok(`${h.name} silindi`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const groups = data.data?.optionGroups ?? [];
  const items = data.data?.optionItems ?? [];
  const newGroup = () => openGroup({ name: '', kind: 'single', required: false, maxSelect: 1, active: true, items: [{ name: '', price: '', isDefault: true, maxQty: 1 }] });
  const newHappy = () => openHappy({ name: '', days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00', percent: 15, categoryIds: [], productIds: [], active: true });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Seçenekler ve happy hour"
        description="Süt, şurup ve shot siteden gelir; kasaya özel grupları buradan ekleyin"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={newGroup}>
            Grup ekle
          </Button>
        }
      />
      {data.isPending ? (
        <div role="status" aria-label="Yükleniyor…" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      ) : data.isError && !data.data ? (
        <ErrorState className={CARD} title="Seçenek grupları alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : groups.length === 0 ? (
        <EmptyState icon={<ListChecks />} title="Seçenek grubu yok" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={newGroup}>Grup ekle</Button>}>
          Süt, şurup ve shot grupları site bağlantısıyla gelir; kasaya özel grup için Grup ekle’ye basın
        </EmptyState>
      ) : (
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
                  <Button size="sm" onClick={() => openGroup({ id: g.id, name: g.name, kind: g.kind, required: g.required, maxSelect: g.maxSelect, active: g.active, items: its.map((i) => ({ id: i.id, name: i.name, price: i.price ? String(i.price / 100).replace('.', ',') : '', isDefault: i.isDefault, maxQty: i.maxQty })) })}>
                    Düzenle
                  </Button>
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
      )}

      <Card
        title="Happy hour"
        subtitle="Saat ve güne göre otomatik indirim"
        actions={
          <Button size="sm" icon={<Plus className="size-4" />} onClick={newHappy}>
            Kural ekle
          </Button>
        }
        flush
      >
        {hh.isPending ? (
          <ListSkeleton rows={2} />
        ) : hh.isError && !hh.data ? (
          <ErrorState compact title="Happy hour kuralları alınamadı" error={hh.error} onRetry={() => void hh.refetch()} retrying={hh.isFetching} />
        ) : !hh.data?.length ? (
          <EmptyState bare icon={<BadgePercent />} title="Happy hour kuralı yok" action={<Button size="sm" icon={<Plus className="size-4" />} onClick={newHappy}>Kural ekle</Button>}>
            Seçtiğiniz gün ve saatlerde menüye yüzde indirim uygular
          </EmptyState>
        ) : (
        <ul className="divide-y divide-[var(--admin-divider)]">
          {hh.data.map((h) => (
            <li key={h.id} className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm sm:px-5">
              <span className="min-w-0 flex-1">
                <span className="font-semibold text-[var(--admin-text)]">{h.name}</span> <Badge tone={h.active ? 'success' : 'neutral'}>{h.active ? 'Açık' : 'Kapalı'}</Badge>
                <span className="mt-0.5 block text-xs text-[var(--admin-text-mute)]">
                  %{h.percent} · {h.days.map((d) => DAYS[d - 1]).join(', ')} · {h.start}–{h.end} · {h.categoryIds.length ? h.categoryIds.map((c) => boot.categories.find((x) => x.id === c)?.name).filter(Boolean).join(', ') : 'bütün menü'}
                </span>
              </span>
              <Button size="sm" onClick={() => openHappy({ ...h })}>
                Düzenle
              </Button>
              <Button size="sm" variant="dangerOutline" onClick={() => void removeHappy(h)}>
                Sil
              </Button>
            </li>
          ))}
        </ul>
        )}
      </Card>

      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        size="lg"
        title={edit?.id ? 'Seçenek grubu' : 'Yeni seçenek grubu'}
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEdit(null)}>Vazgeç</Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void saveGroup()}>
              Kaydet
            </Button>
          </div>
        }
      >
        {edit && (
          <div className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Ad" required error={tried ? groupErrors?.name : null}>
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Ör. bardak" maxLength={40} />
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
              {/* Sütun adları: satırdaki alanlar yalnız yer tutucu taşımasın */}
              <div className="flex items-center gap-2 text-xs font-medium text-[var(--admin-text-mute)]" aria-hidden="true">
                <span className="min-w-0 flex-1">Seçenek</span>
                <span className="w-20 shrink-0 text-right">Ek fiyat (₺)</span>
                {edit.kind === 'single' && <span className="w-[4.5rem] shrink-0 text-center">Varsayılan</span>}
                {edit.kind === 'counter' && <span className="w-16 shrink-0 text-right">En çok</span>}
                <span className="w-11 shrink-0 pointer-fine:w-9" />
              </div>
              {edit.items.map((it, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input value={it.name} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} placeholder="Ör. yulaf sütü" aria-label={`${i + 1}. seçenek adı`} maxLength={40} className="min-w-0 flex-1" />
                  <Input value={it.price} onChange={(e) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} placeholder="0" aria-label={`${i + 1}. seçenek ek fiyatı (₺)`} className="tabular w-20 shrink-0 text-right" inputMode="decimal" />
                  {edit.kind === 'single' && (
                    // Bütün hücre dokunma alanı (44 px); sütun adı üstte, ekran okuyucuya satırın kendi adı
                    <label className="flex min-h-11 w-[4.5rem] shrink-0 cursor-pointer items-center justify-center rounded-lg hover:bg-hover pointer-fine:min-h-9">
                      <input type="radio" name="varsayilan" checked={it.isDefault} onChange={() => setEdit({ ...edit, items: edit.items.map((x, j) => ({ ...x, isDefault: j === i })) })} className="size-4 accent-[var(--admin-primary)]" />
                      <span className="sr-only">{`${i + 1}. seçenek varsayılan`}</span>
                    </label>
                  )}
                  {edit.kind === 'counter' && (
                    <NumberInput value={it.maxQty} min={1} max={9} fallback={1} aria-label={`${i + 1}. seçenekten en çok adet`} onCommit={(maxQty) => setEdit({ ...edit, items: edit.items.map((x, j) => (j === i ? { ...x, maxQty } : x)) })} className="w-16 shrink-0" />
                  )}
                  <IconButton label={`${i + 1}. seçeneği sil`} className="text-[var(--admin-text-mute)] hover:text-[var(--admin-danger-ink)]" onClick={() => setEdit({ ...edit, items: edit.items.filter((_, j) => j !== i) })}>
                    <Trash2 className="size-4" />
                  </IconButton>
                </div>
              ))}
              {tried && groupErrors?.items && (
                <p role="alert" className="text-[13px] text-[var(--admin-danger-ink)]">
                  {groupErrors.items}
                </p>
              )}
              <Button size="sm" icon={<Plus className="size-4" />} onClick={() => setEdit({ ...edit, items: [...edit.items, { name: '', price: '', isDefault: false, maxQty: 1 }] })}>
                Seçenek ekle
              </Button>
            </div>
            <p className="text-xs text-[var(--admin-text-mute)]">Grubu ürünlere Ürünler’de, ürünün hızlı bakışındaki Seçenek grupları’ndan bağlayın</p>
          </div>
        )}
      </Modal>

      <Modal
        open={!!happy}
        onClose={() => setHappy(null)}
        title="Happy hour kuralı"
        footer={
          <div className="flex justify-end gap-2">
            <Button onClick={() => setHappy(null)}>Vazgeç</Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void saveHappy()}>
              Kaydet
            </Button>
          </div>
        }
      >
        {happy && (
          <div className="space-y-3 p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Ad" required error={tried ? happyErrors?.name : null}>
                <Input value={happy.name} onChange={(e) => setHappy({ ...happy, name: e.target.value })} placeholder="Ör. öğleden sonra kahvesi" />
              </Field>
              <Field label="İndirim (%)" hint="1–100">
                <NumberInput value={happy.percent} min={1} max={100} onCommit={(percent) => setHappy({ ...happy, percent })} />
              </Field>
              <Field label="Başlangıç">
                <Input type="time" value={happy.start} onChange={(e) => setHappy({ ...happy, start: e.target.value })} />
              </Field>
              <Field label="Bitiş">
                <Input type="time" value={happy.end} onChange={(e) => setHappy({ ...happy, end: e.target.value })} />
              </Field>
            </div>
            <div role="group" aria-label="Günler">
              <Label hint="en az bir gün">Günler</Label>
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
              {tried && happyErrors?.days && (
                <p role="alert" className="mt-1.5 text-[13px] text-[var(--admin-danger-ink)]">
                  {happyErrors.days}
                </p>
              )}
            </div>
            <div role="group" aria-label="Kategoriler">
              <Label hint="boşsa bütün menü">Kategoriler</Label>
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
