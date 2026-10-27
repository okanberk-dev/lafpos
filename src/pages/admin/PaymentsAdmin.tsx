import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Power } from 'lucide-react';
import { useState } from 'react';
import { PAYMENT_CHANNELS } from '@shared/labels';
import type { PaymentMethodDTO } from '@shared/types';
import { ActionMenu, Badge, BTN, type Column, DataTable, PageHeader, QuickLook } from '@/components/admin/ui';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { toast } from '@/lib/toast';

type Method = PaymentMethodDTO & { sort: number; active: boolean };
type Draft = Omit<Method, 'id'> & { id?: string };

const KIND = { nakit: 'Nakit', kart: 'Kredi kartı', yemek: 'Yemek kartı', havale: 'Havale / EFT', cari: 'Açık hesap', online: 'Yemek platformu', diger: 'Diğer' };
const ZFIELD = { cash: 'Nakit', card: 'Kredi kartı', meal_card: 'Yemek kartı', online: 'Online', other: 'Diğer' };
/** Türün olağan lafmaliyet alanı: tür değişince alan da ona geçer (nakit türü yalnız Nakit alanına gider) */
const ZFIELD_OF: Record<Method['kind'], Method['zField']> = { nakit: 'cash', kart: 'card', yemek: 'meal_card', havale: 'other', cari: 'other', online: 'online', diger: 'other' };

export default function PaymentsAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'methods'], queryFn: () => get<Method[]>('/admin/payment-methods') });
  const [edit, setEdit] = useState<Draft | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'methods'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };
  const save = async () => {
    if (!edit) return;
    try {
      const { id, ...body } = edit;
      if (id) await patch(`/admin/payment-methods/${id}`, body);
      else await post('/admin/payment-methods', body);
      toast.ok(`${edit.name} kaydedildi`);
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const setActive = async (m: Method, active: boolean) => {
    try {
      await patch(`/admin/payment-methods/${m.id}`, { active });
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  if (data.isLoading) return <PageLoading />;

  const columns: Column<Method>[] = [
    {
      key: 'ad',
      header: 'Ödeme türü',
      cell: (m) => (
        <span className="flex items-center gap-3">
          <span aria-hidden="true" className="size-8 shrink-0 rounded-lg" style={{ background: m.color }} />
          <span className="min-w-0">
            <span className="block font-medium text-[var(--admin-text)]">{m.name}</span>
            <span className="block text-xs text-[var(--admin-text-mute)]">{KIND[m.kind]}</span>
          </span>
        </span>
      ),
    },
    { key: 'z', header: 'lafmaliyet alanı', cell: (m) => ZFIELD[m.zField] },
    { key: 'kanal', header: 'Komisyon kanalı', cell: (m) => m.channel ?? <span className="text-[var(--admin-text-mute)]">Yok</span> },
    { key: 'sira', header: 'Sıra', align: 'right', cell: (m) => <span className="tabular-nums">{m.sort}</span>, hideOnPhone: true },
    { key: 'durum', header: 'Durum', cell: (m) => <Badge tone={m.active ? 'success' : 'neutral'} dot>{m.active ? 'Etkin' : 'Kapalı'}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Ödeme türleri"
        description="Her tür lafmaliyet Kasa raporundaki bir alana (Nakit, Kart, Yemek kartı, Online, Diğer) ve varsa komisyon kanalına bağlanır"
        actions={
          <button type="button" className={BTN.primary} onClick={() => setEdit({ name: '', kind: 'yemek', zField: 'meal_card', channel: null, color: '#3f6b8a', sort: 20, active: true })}>
            <Plus className="size-4" aria-hidden="true" />
            Tür ekle
          </button>
        }
      />
      <DataTable
        caption="Ödeme türleri"
        rows={data.data ?? []}
        columns={columns}
        rowKey={(m) => m.id}
        onOpen={(m) => setEdit({ ...m })}
        selectedKey={edit?.id ?? null}
        rowClassName={(m) => !m.active && 'opacity-70'}
        phoneMeta={(m) => `${KIND[m.kind]} → ${ZFIELD[m.zField]}${m.channel ? ` · ${m.channel}` : ''}${m.active ? '' : ' · kapalı'}`}
        actions={(m) => (
          <ActionMenu
            label={`${m.name} eylemleri`}
            items={[
              { key: 'duzenle', label: 'Düzenle', icon: <Pencil />, onSelect: () => setEdit({ ...m }) },
              { key: 'durum', label: m.active ? 'Kapat' : 'Etkinleştir', icon: <Power />, danger: m.active, onSelect: () => setActive(m, !m.active) },
            ]}
          />
        )}
      />
      <QuickLook
        open={!!edit}
        onClose={() => setEdit(null)}
        label="Ödeme türü"
        title={edit?.id ? edit.name : 'Yeni ödeme türü'}
        subtitle="Kasada ödeme düğmesi, Z'de bir satır, lafmaliyet'te bir alan"
        footer={
          <>
            {edit && <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Etkin" />}
            <div className="flex-1" />
            <button type="button" className={BTN.ghost} onClick={() => setEdit(null)}>
              Vazgeç
            </button>
            <button type="button" className={BTN.primary} disabled={!edit?.name.trim()} onClick={save}>
              Kaydet
            </button>
          </>
        }
      >
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ad" className="sm:col-span-2">
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus={!edit.id} />
            </Field>
            <Field label="Tür">
              <Select
                value={edit.kind}
                onChange={(e) => {
                  const kind = e.target.value as Method['kind'];
                  setEdit({ ...edit, kind, zField: kind === 'nakit' || edit.zField === 'cash' ? ZFIELD_OF[kind] : edit.zField });
                }}
              >
                {Object.entries(KIND).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="lafmaliyet alanı">
              <Select value={edit.zField} onChange={(e) => setEdit({ ...edit, zField: e.target.value as Method['zField'] })}>
                {Object.entries(ZFIELD).map(([k, v]) => (
                  <option key={k} value={k} disabled={(edit.kind === 'nakit') !== (k === 'cash')}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Komisyon kanalı">
              <Select value={edit.channel ?? ''} onChange={(e) => setEdit({ ...edit, channel: e.target.value || null })}>
                <option value="">Yok</option>
                {PAYMENT_CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sıra">
              <Input type="number" value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: Number(e.target.value) || 0 })} />
            </Field>
            <Field label="Renk">
              <input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} className="h-11 w-20 cursor-pointer rounded-lg border border-[var(--admin-border)]" />
            </Field>
          </div>
        )}
      </QuickLook>
    </>
  );
}
