import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BadgePercent, Globe, ListChecks, Plus, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { tl } from '@shared/money';
import type { HappyHourDTO, ProductDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Chip, Field, Input, Label, NumberInput, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, ListSkeleton, Skeleton } from '@/components/ui/misc';
import { groupDraft, newGroupDraft, OptionGroupEditor, type OptionGroupDraft } from '@/components/admin/OptionGroupEditor';
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

const KIND_LABEL = { single: 'Tek seçim', multi: 'Çoklu seçim', counter: 'Adetli' };
const DAYS = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];

/** Kuralın günleri okunur biçimde: bütün hafta, hafta içi ve hafta sonu adıyla; öteki günler kısaltmayla */
function dayText(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  const key = sorted.join();
  if (key === '1,2,3,4,5,6,7') return 'Her gün';
  if (key === '1,2,3,4,5') return 'Hafta içi';
  if (key === '6,7') return 'Hafta sonu';
  return sorted.map((x) => DAYS[x - 1]).join(', ');
}

export default function OptionsAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'menu'], queryFn: () => get<{ categories: { id: string; name: string; sort: number }[]; products: ProductDTO[]; optionGroups: Group[]; optionItems: Item[] }>('/admin/menu') });
  const hh = useQuery({ queryKey: ['admin', 'happy'], queryFn: () => get<HappyHourDTO[]>('/admin/happy-hours') });
  const [edit, setEdit] = useState<OptionGroupDraft | null>(null);
  const [happy, setHappy] = useState<(Omit<HappyHourDTO, 'id'> & { id?: string }) | null>(null);
  const [saving, setSaving] = useState(false);
  // Eksik alan Kaydet'e basınca alanın altında söylenir (düğme sessizce soluk kalmaz)
  const [tried, setTried] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const happyErrors = happy ? { name: happy.name.trim() ? null : 'Kural adı gerekli', days: happy.days.length ? null : 'En az bir gün seçin' } : null;
  const openHappy = (h: NonNullable<typeof happy>) => {
    setTried(false);
    setHappy(h);
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
  const products = useMemo(() => data.data?.products ?? [], [data.data]);
  // Düzenleyicinin ürün listesi kategori sırasıyla, kategori adıyla
  const productChoices = useMemo(() => {
    const cats = data.data?.categories ?? [];
    const order = new Map(cats.map((c, i) => [c.id, i]));
    return [...products]
      .sort((a, b) => (order.get(a.categoryId) ?? 999) - (order.get(b.categoryId) ?? 999))
      .map((p) => ({ id: p.id, name: p.name, category: cats.find((c) => c.id === p.categoryId)?.name }));
  }, [products, data.data]);
  const linkedTo = (groupId: string) => products.filter((p) => p.optionGroupIds.includes(groupId)).map((p) => p.id);
  const newGroup = () => setEdit(newGroupDraft());
  const newHappy = () => openHappy({ name: '', days: [1, 2, 3, 4, 5], start: '15:00', end: '17:00', percent: 15, categoryIds: [], productIds: [], active: true });

  return (
    <div className="space-y-4">
      <PageHeader
        title="Seçenek ve happy hour"
        description="Süt, şurup ve shot site kodundaki sabit listeden gelir; kasaya özel seçenek için yerel grup ekleyin"
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
          Süt, şurup ve shot sitenin sabit listesinden, site bağlantısıyla gelir; kasaya özel seçenek için Grup ekle’ye basın
        </EmptyState>
      ) : (
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {groups.map((g) => {
          const its = items.filter((i) => i.groupId === g.id && i.active);
          const linked = linkedTo(g.id);
          return (
            <Card flush
              key={g.id}
              // Kapalı grup soluk değil (metin AA altına düşer, Düzenle devre dışı görünür): gri zemin ve "Kapalı" rozeti
              className={cn(!g.active && 'bg-[var(--admin-surface-2)]')}
              title={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {g.name}
                  {/* Kaynak bilgidir, olumlu durum değil: sitenin her yerdeki tonu (kategori çubuğunda "Site kategorisi") */}
                  {g.extSource ? (
                    <Badge tone="info">
                      <Globe aria-hidden="true" className="size-3" /> Site
                    </Badge>
                  ) : (
                    <Badge>Yerel</Badge>
                  )}
                  {!g.active && <Badge>Kapalı</Badge>}
                </span>
              }
              actions={
                !g.extSource && (
                  // Düğme başlık satırını uzatmaz: yerel grubun ayrıntı satırı yanındaki site grubununkiyle aynı hizada kalır
                  <Button size="sm" className="-my-1.5 pointer-coarse:-my-2.5" onClick={() => setEdit(groupDraft(g, its, linked))}>
                    Düzenle
                  </Button>
                )
              }
            >
              <div className="px-4 pb-4 text-sm sm:px-5">
                <div className="mb-2 text-xs text-[var(--admin-text-mute)]">
                  {KIND_LABEL[g.kind]}
                  {g.kind === 'multi' && ` · en çok ${g.maxSelect}`}
                  {/* Adetli grupta zorunluluk sayılmaz (sıfır adet de geçerli) */}
                  {g.required && g.kind !== 'counter' && ' · zorunlu'}
                  {` · ${linked.length ? `${linked.length} ürün` : 'ürüne bağlı değil'}`}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {its.map((i) => (
                    <span key={i.id} className={cn('inline-flex items-baseline gap-1.5 rounded-[var(--r-chip)] border border-[var(--admin-border)] px-2.5 py-1 text-xs text-[var(--admin-text)]', i.isDefault && 'bg-[var(--admin-panel)]')}>
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
                  %{h.percent} · {dayText(h.days)} · {h.start}–{h.end} · {h.categoryIds.length ? h.categoryIds.map((c) => boot.categories.find((x) => x.id === c)?.name).filter(Boolean).join(', ') : 'bütün menü'}
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

      {edit && (
        <OptionGroupEditor
          key={edit.id ?? 'yeni'}
          initial={edit}
          products={productChoices}
          onClose={() => setEdit(null)}
          onSaved={({ name }) => {
            toast.ok(`${name} kaydedildi`);
            setEdit(null);
            refresh();
          }}
        />
      )}

      <Modal
        open={!!happy}
        onClose={() => setHappy(null)}
        title="Happy hour kuralı"
        footer={
          // Telefonda iki eşit düğme (onay penceresi gibi); geniş ekranda sağa yaslı
          <div className="flex justify-end gap-2 max-sm:[&>*]:flex-1">
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
              {/* Yedi gün tek sırada eşit hücrelerde: telefonda "Paz" alt satıra tek başına düşmez. Kitin seçim çipi (ürün
                  çekmecesindeki seçenek grubu çipiyle aynı): kapsül, yeşil seçim */}
              <div className="grid grid-cols-7 gap-1.5">
                {DAYS.map((d, i) => {
                  const on = happy.days.includes(i + 1);
                  return (
                    <Chip key={d} on={on} onClick={() => setHappy({ ...happy, days: on ? happy.days.filter((x) => x !== i + 1) : [...happy.days, i + 1].sort((a, b) => a - b) })} className="px-0">
                      {d}
                    </Chip>
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
                    <Chip key={c.id} on={on} onClick={() => setHappy({ ...happy, categoryIds: on ? happy.categoryIds.filter((x) => x !== c.id) : [...happy.categoryIds, c.id] })}>
                      {c.name}
                    </Chip>
                  );
                })}
              </div>
            </div>
            {/* Seçenek grubundaki "Grup açık" gibi: etiket ve ipucu solda, anahtar sağda */}
            <div className="border-t border-[var(--admin-divider)] pt-3">
              <Toggle block checked={happy.active} onChange={(v) => setHappy({ ...happy, active: v })} label="Kural açık" hint="Kapalı kural indirim uygulamaz; kayıtlı kalır" />
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
