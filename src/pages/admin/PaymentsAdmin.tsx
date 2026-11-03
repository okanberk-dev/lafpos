import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CreditCard, Pencil, Plus, Power, Save } from 'lucide-react';
import { useState } from 'react';
import { PAYMENT_CHANNELS, type PaymentChannel } from '@shared/labels';
import { PLATFORM_LABEL } from '@shared/platforms';
import type { PaymentMethodDTO } from '@shared/types';
import { ActionMenu, Badge, CARD, type Column, DataTable, EmptyState, PageHeader, QuickLook, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

type Method = PaymentMethodDTO & { sort: number; active: boolean };
type Draft = Omit<Method, 'id'> & { id?: string };

const KIND = { nakit: 'Nakit', kart: 'Kredi kartı', yemek: 'Yemek kartı', havale: 'Havale / EFT', cari: 'Açık hesap', online: 'Yemek platformu', diger: 'Diğer' };
const ZFIELD = { cash: 'Nakit', card: 'Kredi kartı', meal_card: 'Yemek kartı', online: 'Online', other: 'Diğer' };
/** Türün olağan lafmaliyet alanı: tür değişince alan da ona geçer (nakit türü yalnız Nakit alanına gider) */
const ZFIELD_OF: Record<Method['kind'], Method['zField']> = { nakit: 'cash', kart: 'card', yemek: 'meal_card', havale: 'other', cari: 'other', online: 'online', diger: 'other' };
/** Komisyon kanalının ekrandaki adı (kayıtta lafmaliyet'in anahtarı durur: pluxee, getir…); platformlar Paket platformlarındaki adla */
const CHANNEL_LABEL: Record<PaymentChannel, string> = { pluxee: 'Pluxee', multinet: 'Multinet', edenred: 'Edenred', setcard: 'Setcard', metropol: 'Metropol', ...PLATFORM_LABEL };
const channelName = (c: string) => CHANNEL_LABEL[c as PaymentChannel] ?? c;

export default function PaymentsAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'methods'], queryFn: () => get<Method[]>('/admin/payment-methods') });
  const fine = useFinePointer();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const openEdit = (d: Draft) => {
    setTried(false);
    setEdit(d);
  };
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['admin', 'methods'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };
  const nameError = edit && !edit.name.trim() ? 'Ad gerekli' : null;
  const save = async () => {
    if (!edit) return;
    if (nameError) {
      setTried(true);
      return;
    }
    setSaving(true);
    try {
      const { id, ...body } = edit;
      if (id) await patch(`/admin/payment-methods/${id}`, body);
      else await post('/admin/payment-methods', body);
      toast.ok(`${edit.name} kaydedildi`);
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  // Personel'deki gibi: kapatma onay sormaz, bildirimdeki "Geri al" eski durumu yazar
  const setActive = async (m: Method, active: boolean) => {
    try {
      await patch(`/admin/payment-methods/${m.id}`, { active });
      toast.ok(`${m.name} ${active ? 'etkinleştirildi' : 'kapatıldı'}`, { action: { label: 'Geri al', run: () => void setActive(m, !active) } });
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  // Kapalı tür: durumu rozet söyler; yalnız renk karesi solar, yazılar okunur kalır
  const swatch = (m: Method) => <span aria-hidden="true" className={cn('block size-8 shrink-0 rounded-lg ring-1 ring-inset ring-black/5 dark:ring-white/15', !m.active && 'opacity-40')} style={{ background: m.color }} />;
  // Ad ve tür: tabloda renk karesinin yanında, telefonun satır kartında başlık (kare kartın solunda, alt satır adın
  // hizasından başlar)
  const named = (m: Method) => (
    <span className="min-w-0">
      <span className={cn('block font-medium md:whitespace-nowrap', m.active ? 'text-[var(--admin-text)]' : 'text-[var(--admin-text-soft)]')}>{m.name}</span>
      {/* Tür adla aynıysa yinelenmez ("Nakit / Nakit") */}
      {KIND[m.kind] !== m.name && <span className="block text-xs text-[var(--admin-text-mute)] md:whitespace-nowrap">{KIND[m.kind]}</span>}
    </span>
  );
  const columns: Column<Method>[] = [
    {
      key: 'ad',
      header: 'Ödeme türü',
      cell: (m) => (
        <span className="flex items-center gap-3">
          {swatch(m)}
          {named(m)}
        </span>
      ),
    },
    { key: 'z', header: 'lafmaliyet alanı', cell: (m) => ZFIELD[m.zField] },
    { key: 'kanal', header: 'Komisyon kanalı', cell: (m) => (m.channel ? channelName(m.channel) : <span className="text-[var(--admin-text-mute)]">Yok</span>) },
    // İç sıra numarası: tablette adlara yer açmak için yalnız geniş ekranda
    { key: 'sira', header: 'Sıra', align: 'right', cell: (m) => <span className="tabular-nums">{m.sort}</span>, hideOnPhone: true, hideBelow: 'lg' },
    { key: 'durum', header: 'Durum', cell: (m) => <Badge tone={m.active ? 'success' : 'neutral'} dot>{m.active ? 'Etkin' : 'Kapalı'}</Badge> },
  ];

  const newMethod = () => openEdit({ name: '', kind: 'yemek', zField: 'meal_card', channel: null, color: '#3f6b8a', sort: 20, active: true });

  return (
    <>
      <PageHeader
        title="Ödeme türleri"
        description="Her tür lafmaliyet Kasa raporunda bir alana ve varsa komisyon kanalına bağlanır"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={newMethod}>
            Tür ekle
          </Button>
        }
      />
      {data.isPending ? (
        <TableSkeleton rows={5} />
      ) : data.isError && !data.data ? (
        <ErrorState className={CARD} title="Ödeme türleri alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : (
        <DataTable
          caption="Ödeme türleri"
          rows={data.data ?? []}
          columns={columns}
          rowKey={(m) => m.id}
          onOpen={(m) => openEdit({ ...m })}
          selectedKey={edit?.id ?? null}
          phoneLead={swatch}
          phoneTitle={named}
          // Telefonda yalnız türden farklı olan söylenir: lafmaliyet alanı türle aynıysa yazılmaz, kanal markanın adıyla
          phoneMeta={(m) => (
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              {!m.active && <Badge>Kapalı</Badge>}
              <span>{joinMeta([ZFIELD[m.zField] !== KIND[m.kind] && `lafmaliyet: ${ZFIELD[m.zField]}`, m.channel && `Komisyon: ${channelName(m.channel)}`])}</span>
            </span>
          )}
          actions={(m) => (
            <ActionMenu
              label={`${m.name} eylemleri`}
              items={[
                { key: 'duzenle', label: 'Düzenle', icon: <Pencil />, onSelect: () => openEdit({ ...m }) },
                { key: 'durum', label: m.active ? 'Kapat' : 'Etkinleştir', icon: <Power />, danger: m.active, onSelect: () => void setActive(m, !m.active) },
              ]}
            />
          )}
          empty={
            <EmptyState icon={<CreditCard />} title="Ödeme türü yok" action={<Button variant="primary" icon={<Plus className="size-4" />} onClick={newMethod}>Tür ekle</Button>}>
              Kasada her tür bir ödeme düğmesi olur; nakit ve kredi kartıyla başlayın
            </EmptyState>
          }
        />
      )}
      <QuickLook
        open={!!edit}
        onClose={() => setEdit(null)}
        label="Ödeme türü"
        title={edit?.id ? edit.name.trim() || 'Ödeme türü' : 'Yeni ödeme türü'}
        subtitle="Kasada ödeme düğmesi, Z’de bir satır, lafmaliyet’te bir alan"
        footer={
          <>
            {edit && <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label="Etkin" />}
            <div className="flex-1" />
            <Button onClick={() => setEdit(null)}>Vazgeç</Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
              Kaydet
            </Button>
          </>
        }
      >
        {edit && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Ad" className="sm:col-span-2" required error={tried ? nameError : null}>
              <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus={!edit.id && fine} placeholder="Ör. Multinet" />
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
                    {CHANNEL_LABEL[c]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Sıra" hint="küçük olan önce">
              <NumberInput value={edit.sort} min={0} max={999} fallback={0} onCommit={(sort) => setEdit({ ...edit, sort })} />
            </Field>
            <Field label="Renk">
              {/* Kenar ve köşe alanlarla aynı (3:1 kenar, 14 px köşe) */}
              <input
                type="color"
                value={edit.color}
                onChange={(e) => setEdit({ ...edit, color: e.target.value })}
                className="h-11 w-20 cursor-pointer rounded-xl border border-line-strong bg-surface p-1 [[data-area=admin]_&]:pointer-fine:h-10"
              />
            </Field>
          </div>
        )}
      </QuickLook>
    </>
  );
}
