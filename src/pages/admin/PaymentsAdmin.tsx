import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { PaymentMethodDTO } from '@shared/types';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, PageHeader, PageLoading } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { toast } from '@/lib/toast';

type Method = PaymentMethodDTO & { sort: number; active: boolean };

const KIND = { nakit: 'Nakit', kart: 'Kredi kartı', yemek: 'Yemek kartı', havale: 'Havale / EFT', cari: 'Açık hesap', online: 'Yemek platformu', diger: 'Diğer' };
const ZFIELD = { cash: 'Nakit', card: 'Kredi kartı', meal_card: 'Yemek kartı', online: 'Online', other: 'Diğer' };
/** lafmaliyet komisyon kanalları (src/lib/commission/channels.ts) */
const CHANNELS = ['pluxee', 'multinet', 'edenred', 'setcard', 'metropol', 'yemeksepeti', 'trendyol', 'getir', 'migros'];

export default function PaymentsAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'methods'], queryFn: () => get<Method[]>('/admin/payment-methods') });
  const [edit, setEdit] = useState<(Omit<Method, 'id'> & { id?: string }) | null>(null);
  const save = async () => {
    if (!edit) return;
    try {
      const { id, ...body } = edit;
      if (id) await patch(`/admin/payment-methods/${id}`, body);
      else await post('/admin/payment-methods', body);
      toast.ok('Ödeme türü kaydedildi');
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['admin', 'methods'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  if (data.isLoading) return <PageLoading />;
  return (
    <div>
      <PageHeader
        title="Ödeme türleri"
        subtitle="Her tür lafmaliyet Kasa raporundaki bir alana (Nakit, Kart, Yemek kartı, Online, Diğer) ve varsa komisyon kanalına bağlanır"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ name: '', kind: 'yemek', zField: 'meal_card', channel: null, color: '#3f6b8a', sort: 20, active: true })}>Tür ekle</Button>}
      />
      <Card>
        <ul className="divide-y divide-line">
          {(data.data ?? []).map((m) => (
            <li key={m.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <span className="size-4 rounded" style={{ background: m.color }} />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{m.name}</span> {!m.active && <Badge>kapalı</Badge>}
                <span className="block text-xs text-muted">
                  {KIND[m.kind]} → lafmaliyet "{ZFIELD[m.zField]}"{m.channel && ` · komisyon kanalı ${m.channel}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEdit({ ...m })}>
                Düzenle
              </Button>
            </li>
          ))}
        </ul>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? edit.name : 'Yeni ödeme türü'} footer={<div className="flex items-center gap-2">{edit && <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Etkin" />}<div className="flex-1" /><Button onClick={() => setEdit(null)}>Vazgeç</Button><Button variant="primary" disabled={!edit?.name.trim()} onClick={save}>Kaydet</Button></div>}>
        {edit && (
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            <Field label="Ad">
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            </Field>
            <Field label="Tür">
              <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value as Method['kind'] })}>
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
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Komisyon kanalı">
              <Select value={edit.channel ?? ''} onChange={(e) => setEdit({ ...edit, channel: e.target.value || null })}>
                <option value="">Yok</option>
                {CHANNELS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Renk">
              <input type="color" value={edit.color} onChange={(e) => setEdit({ ...edit, color: e.target.value })} className="h-11 w-20 rounded-xl" />
            </Field>
            <Field label="Sıra">
              <Input type="number" value={edit.sort} onChange={(e) => setEdit({ ...edit, sort: Number(e.target.value) || 0 })} />
            </Field>
          </div>
        )}
      </Modal>
    </div>
  );
}
