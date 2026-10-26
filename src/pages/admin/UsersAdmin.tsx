import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';
import { ALL_PERMISSIONS, effectivePermissions, type Permission, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, ROLES } from '@shared/permissions';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, PageHeader, PageLoading } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

interface UserRow {
  id: string;
  name: string;
  role: Role;
  color: string;
  active: boolean;
  permGrant: Permission[];
  permRevoke: Permission[];
  maxDiscountPct: number;
  lastLoginAt: number | null;
}

const COLORS = ['#1e4031', '#6b1a2b', '#a87c2e', '#3f6b8a', '#5e8f45', '#a23e6b', '#9a3b2f', '#7a6a5f'];

export default function UsersAdmin() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const data = useQuery({ queryKey: ['users', 'admin'], queryFn: () => get<UserRow[]>('/admin/users') });
  const [edit, setEdit] = useState<(Omit<UserRow, 'id' | 'lastLoginAt'> & { id?: string; pin: string }) | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };

  const save = async () => {
    if (!edit) return;
    try {
      const body = { name: edit.name, role: edit.role, color: edit.color, maxDiscountPct: edit.maxDiscountPct, permGrant: edit.permGrant, permRevoke: edit.permRevoke, active: edit.active, ...(edit.pin ? { pin: edit.pin } : {}) };
      if (edit.id) await patch(`/admin/users/${edit.id}`, body);
      else await post('/admin/users', { ...body, pin: edit.pin });
      toast.ok('Personel kaydedildi');
      setEdit(null);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  if (data.isLoading) return <PageLoading />;
  const effective = edit ? effectivePermissions(edit.role, { grant: edit.permGrant, revoke: edit.permRevoke }) : new Set<Permission>();
  const toggle = (p: Permission) => {
    if (!edit) return;
    const byRole = ROLE_DEFAULTS[edit.role].includes(p);
    const on = effective.has(p);
    if (byRole) setEdit({ ...edit, permRevoke: on ? [...edit.permRevoke, p] : edit.permRevoke.filter((x) => x !== p) });
    else setEdit({ ...edit, permGrant: on ? edit.permGrant.filter((x) => x !== p) : [...edit.permGrant, p] });
  };

  return (
    <div>
      <PageHeader
        title="Personel ve yetkiler"
        subtitle="Her kişi kendi PIN'iyle girer; yetkisi olmayan işlemi yetkili PIN'iyle onaylatır. Maliyet ve kâr yalnız 'Maliyet, kâr ve personel tutarları' yetkisiyle görünür"
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEdit({ name: '', role: 'garson', color: COLORS[3], active: true, permGrant: [], permRevoke: [], maxDiscountPct: 10, pin: '' })}>Personel ekle</Button>}
      />
      <Card>
        <ul className="divide-y divide-line">
          {(data.data ?? []).map((u) => (
            <li key={u.id} className={cn('flex items-center gap-3 px-4 py-3', !u.active && 'opacity-50')}>
              <span className="grid size-10 place-items-center rounded-full text-sm font-semibold text-white" style={{ background: u.color }}>
                {u.name.slice(0, 2).toLocaleUpperCase('tr-TR')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-medium">
                  {u.name} {!u.active && <Badge>kapalı</Badge>}
                </span>
                <span className="text-xs text-muted">
                  {ROLE_LABELS[u.role]} · indirim sınırı %{u.maxDiscountPct}
                  {(u.permGrant.length > 0 || u.permRevoke.length > 0) && ` · ${u.permGrant.length} ek, ${u.permRevoke.length} kaldırılan yetki`}
                  {u.lastLoginAt && ` · son giriş ${fmtDateTime(u.lastLoginAt)}`}
                </span>
              </span>
              <Button size="sm" variant="ghost" onClick={() => setEdit({ ...u, pin: '' })}>
                Düzenle
              </Button>
            </li>
          ))}
        </ul>
      </Card>

      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        size="lg"
        title={edit?.id ? edit.name : 'Yeni personel'}
        footer={
          <div className="flex items-center gap-2">
            {edit?.id && edit.id !== me?.id && <Toggle checked={edit.active} onChange={(v) => setEdit({ ...edit, active: v })} label={edit.active ? 'Etkin' : 'Kapalı'} />}
            <div className="flex-1" />
            <Button onClick={() => setEdit(null)}>Vazgeç</Button>
            <Button variant="primary" disabled={!edit?.name.trim() || (!edit.id && !/^\d{4,6}$/.test(edit.pin)) || (!!edit.pin && !/^\d{4,6}$/.test(edit.pin))} onClick={save}>
              Kaydet
            </Button>
          </div>
        }
      >
        {edit && (
          <div className="space-y-4 p-5">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="Ad">
                <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} autoFocus={!edit.id} />
              </Field>
              <Field label="Rol">
                <Select value={edit.role} onChange={(e) => setEdit({ ...edit, role: e.target.value as Role, permGrant: [], permRevoke: [] })}>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={edit.id ? 'Yeni PIN (değişmeyecekse boş)' : 'PIN (4-6 hane)'}>
                <div className="relative">
                  <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
                  <Input value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" className="pl-9 tracking-[0.3em]" />
                </div>
              </Field>
              <Field label="İndirim sınırı (%)" hint="üstü yetkili onayı ister">
                <Input type="number" min={0} max={100} value={edit.maxDiscountPct} onChange={(e) => setEdit({ ...edit, maxDiscountPct: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Renk" className="sm:col-span-2">
                <div className="flex gap-2">
                  {COLORS.map((c) => (
                    <button key={c} aria-label={c} onClick={() => setEdit({ ...edit, color: c })} className={cn('size-9 rounded-full ring-offset-2', edit.color === c && 'ring-2 ring-brass-500')} style={{ background: c }} />
                  ))}
                </div>
              </Field>
            </div>
            <div>
              <div className="mb-2 text-sm font-semibold">Yetkiler</div>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {ALL_PERMISSIONS.map((p) => {
                  const on = effective.has(p);
                  const byRole = ROLE_DEFAULTS[edit.role].includes(p);
                  return (
                    <label key={p} className={cn('flex cursor-pointer items-start gap-2 rounded-xl border px-3 py-2 text-sm', on ? 'border-forest-300 bg-forest-50 dark:bg-forest-800' : 'border-line')}>
                      <input type="checkbox" checked={on} onChange={() => toggle(p)} className="mt-0.5 size-4" />
                      <span>
                        {PERMISSIONS[p]}
                        <span className="block text-xs text-muted">{byRole ? (on ? 'rol varsayılanı' : 'rolden kaldırıldı') : on ? 'kişiye ek yetki' : ''}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
