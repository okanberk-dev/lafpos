import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Permission, PERMISSIONS, type Role } from '@shared/permissions';
import { Badge, BTN, CARD, PageHeader, StatusTabs } from '@/components/admin/ui';
import { PageLoading } from '@/components/ui/misc';
import { errorMessage, get, put } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

interface RoleRow {
  role: Role;
  label: string;
  locked: boolean;
  permissions: Permission[];
  defaults: Permission[];
  custom: boolean;
  users: number;
}
interface RolesData {
  groups: { key: string; label: string; permissions: Permission[] }[];
  roles: RoleRow[];
}

const sameSet = (a: Permission[], b: Permission[]) => a.length === b.length && a.every((p) => b.includes(p));

/**
 * Roller ve yetkiler (ModPOS "Pozisyonlar" ve "Özel Yetkiler" gibi): her rolün yetki seti burada düzenlenir,
 * o roldeki herkese uygulanır; kişiye özel ek ya da kaldırılan yetki Personel sayfasında kalır. Patron rolü
 * kilitli. Bilgisayarda roller sütun, yetkiler satır; telefonda rol seçilip yetkileri liste olarak.
 */
export default function RolesAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => get<RolesData>('/admin/roles') });
  const [draft, setDraft] = useState<Partial<Record<Role, Permission[]>>>({});
  const [phoneRole, setPhoneRole] = useState<Role>('kasiyer');
  const [saving, setSaving] = useState(false);

  const roles = useMemo(() => data.data?.roles ?? [], [data.data]);
  const current = (r: RoleRow) => draft[r.role] ?? r.permissions;
  const dirty = roles.filter((r) => draft[r.role] && !sameSet(draft[r.role]!, r.permissions));

  const toggle = (r: RoleRow, p: Permission) => {
    if (r.locked) return;
    const list = current(r);
    setDraft({ ...draft, [r.role]: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] });
  };
  const reset = (r: RoleRow) => setDraft({ ...draft, [r.role]: r.defaults });
  const save = async () => {
    setSaving(true);
    try {
      for (const r of dirty) await put(`/admin/roles/${r.role}`, { permissions: draft[r.role] });
      toast.ok(dirty.length === 1 ? `${dirty[0].label} rolünün yetkileri kaydedildi` : `${dirty.length} rolün yetkileri kaydedildi`);
      setDraft({});
      qc.invalidateQueries({ queryKey: ['admin', 'roles'] });
      qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (data.isLoading || !data.data) return <PageLoading />;
  const groups = data.data.groups;
  const phone = roles.find((r) => r.role === phoneRole) ?? roles[0];

  const actions = (
    <>
      {dirty.length > 0 && (
        <button type="button" className={BTN.ghost} onClick={() => setDraft({})}>
          Vazgeç
        </button>
      )}
      <button type="button" className={BTN.primary} disabled={!dirty.length || saving} onClick={save}>
        {dirty.length ? `Kaydet (${dirty.length})` : 'Kaydet'}
      </button>
    </>
  );

  return (
    <>
      <PageHeader
        title="Roller ve yetkiler"
        description="Rolün yetkisi o roldeki herkese uygulanır; kişiye özel ek Personel'de"
        actions={actions}
      />

      {/* Bilgisayar ve tablet: roller sütun */}
      <div className={cn(CARD, 'hidden overflow-hidden md:block')}>
        <div className="overflow-x-auto" data-overflow-ok>
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Rollere göre yetkiler</caption>
            <thead>
              <tr className="bg-[var(--admin-surface-2)]">
                <th scope="col" className="sticky left-0 z-[1] h-12 min-w-44 bg-[var(--admin-surface-2)] px-4 text-left text-[13px] font-medium text-[var(--admin-text-mute)] md:w-[38%]">
                  Yetki
                </th>
                {roles.map((r) => (
                  <th key={r.role} scope="col" className="px-1 py-2 text-center align-bottom">
                    <span className="flex flex-col items-center gap-1">
                      <span className="inline-flex max-w-20 items-center justify-center gap-1 text-center text-[13px] font-semibold leading-tight text-[var(--admin-text)]">
                        {r.locked && <Lock className="size-3.5 text-[var(--admin-text-mute)]" aria-label="kilitli" />}
                        {r.label}
                      </span>
                      <span className="text-xs font-normal text-[var(--admin-text-mute)]">{r.users} kişi</span>
                      {!r.locked && !sameSet(current(r), r.defaults) && (
                        <button type="button" onClick={() => reset(r)} className="inline-flex min-h-8 items-center gap-1 rounded-md px-1.5 text-xs font-medium text-[var(--admin-primary)] hover:bg-[var(--admin-primary-soft)] pointer-coarse:min-h-11">
                          <RotateCcw className="size-3" aria-hidden="true" />
                          Varsayılan
                        </button>
                      )}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            {groups.map((g) => (
              <GroupRows key={g.key} group={g} roles={roles} current={current} toggle={toggle} />
            ))}
          </table>
        </div>
      </div>

      {/* Telefon: önce rol, sonra o rolün yetkileri */}
      <div className="md:hidden">
        <StatusTabs label="Rol" value={phone.role} onChange={setPhoneRole} tabs={roles.map((r) => ({ value: r.role, label: r.label, count: current(r).length }))} />
        {phone.locked && <p className="mb-3 text-[13px] text-[var(--admin-text-mute)]">Patron rolü her yetkiye sahiptir ve değiştirilemez</p>}
        {!phone.locked && !sameSet(current(phone), phone.defaults) && (
          <button type="button" onClick={() => reset(phone)} className={cn(BTN.ghost, 'mb-3')}>
            <RotateCcw className="size-4" aria-hidden="true" />
            Varsayılana dön
          </button>
        )}
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className="px-1 pb-2 text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--admin-text-mute)]">{g.label}</h2>
              <ul className={cn(CARD, 'divide-y divide-[var(--admin-divider)] overflow-hidden')}>
                {g.permissions.map((p) => {
                  const on = current(phone).includes(p);
                  return (
                    <li key={p}>
                      <label className={cn('flex min-h-14 items-center gap-3 px-4 py-2.5 text-sm', phone.locked ? 'opacity-70' : 'cursor-pointer')}>
                        <input type="checkbox" checked={on} disabled={phone.locked} onChange={() => toggle(phone, p)} className="size-5 shrink-0 accent-[var(--admin-primary)]" />
                        <span className="min-w-0 flex-1">{PERMISSIONS[p]}</span>
                        {!phone.locked && on !== phone.defaults.includes(p) && <Badge tone={on ? 'primary' : 'danger'}>{on ? 'eklendi' : 'kaldırıldı'}</Badge>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </>
  );
}

function GroupRows({
  group,
  roles,
  current,
  toggle,
}: {
  group: RolesData['groups'][number];
  roles: RoleRow[];
  current: (r: RoleRow) => Permission[];
  toggle: (r: RoleRow, p: Permission) => void;
}) {
  // Her grup kendi gövdesi: grup başlığı yalnız kendi satırlarına (rowgroup); ilk sütun yatay kaydırmada yerinde kalır
  return (
    <tbody>
      <tr className="border-t border-[var(--admin-border)] bg-[var(--admin-panel)]">
        <th scope="rowgroup" className="sticky left-0 z-[1] bg-[var(--admin-panel)] px-4 py-1.5 text-left text-[11px] font-medium uppercase tracking-[0.06em] text-[var(--admin-text-mute)]">
          {group.label}
        </th>
        <td colSpan={roles.length} aria-hidden="true" />
      </tr>
      {group.permissions.map((p) => (
        <tr key={p} className="group border-t border-[var(--admin-divider)] hover:bg-[var(--admin-surface-2)]">
          <th scope="row" className="sticky left-0 z-[1] bg-[var(--admin-surface)] px-4 py-2 text-left font-normal text-[var(--admin-text)] group-hover:bg-[var(--admin-surface-2)]">
            {PERMISSIONS[p]}
          </th>
          {roles.map((r) => {
            const on = current(r).includes(p);
            const changed = !r.locked && on !== r.defaults.includes(p);
            return (
              <td key={r.role} className="px-1 py-1 text-center">
                <label className={cn('inline-grid size-11 place-items-center rounded-md pointer-fine:size-8', !r.locked && 'cursor-pointer hover:bg-[var(--admin-panel)]', changed && 'bg-[var(--admin-primary-soft)]')}>
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={r.locked}
                    onChange={() => toggle(r, p)}
                    aria-label={`${r.label}: ${PERMISSIONS[p]}`}
                    className="size-4 accent-[var(--admin-primary)] disabled:opacity-60"
                  />
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
}
