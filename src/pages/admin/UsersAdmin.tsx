import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Pencil, Plus, Power } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ALL_PERMISSIONS, effectivePermissions, type Permission, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, ROLES } from '@shared/permissions';
import { fmtDateTime } from '@shared/time';
import { ActionMenu, Badge, BTN, type Column, DataTable, DefRow, PageHeader, QuickLook, SearchField, StatusTabs, type Tone } from '@/components/admin/ui';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { fold } from '@/lib/shell';
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
type Draft = Omit<UserRow, 'id' | 'lastLoginAt'> & { id?: string; pin: string };

const COLORS = ['#1e4031', '#6b1a2b', '#a87c2e', '#3f6b8a', '#5e8f45', '#a23e6b', '#9a3b2f', '#7a6a5f'];
const ROLE_TONE: Record<Role, Tone> = { patron: 'accent', mudur: 'primary', kasiyer: 'info', garson: 'success', mutfak: 'warning', kurye: 'neutral' };

/** Son giriş: "az önce", "12 dk önce", "3 sa önce", sonra tarih (Innex: "Şu an aktif / 3 saat önce") */
function since(at: number | null): string {
  if (!at) return 'Hiç girmedi';
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 2) return 'Az önce';
  if (min < 60) return `${min} dk önce`;
  if (min < 24 * 60) return `${Math.round(min / 60)} sa önce`;
  return fmtDateTime(at);
}

function Avatar({ name, color, size = 'md' }: { name: string; color: string; size?: 'md' | 'lg' }) {
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-full font-semibold text-white', size === 'lg' ? 'size-11 text-sm' : 'size-8 text-xs')} style={{ background: color }}>
      {name.slice(0, 2).toLocaleUpperCase('tr-TR')}
    </span>
  );
}

/**
 * Personel ve yetki (Innex personel listesi ve §3 fikir 9): rol rozeti, ek ve kaldırılan yetki satırda, son
 * giriş "3 sa önce" biçiminde; düzenleme sağdan açılan çekmecede, yetkiler tablo olarak. ?kisi=<id>|yeni.
 */
export default function UsersAdmin() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const [params, setParams] = useSearchParams();
  const data = useQuery({ queryKey: ['users', 'admin'], queryFn: () => get<UserRow[]>('/admin/users') });
  const [tab, setTab] = useState<'tumu' | 'etkin' | 'kapali'>('etkin');
  const [q, setQ] = useState('');
  const openId = params.get('kisi');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };
  const open = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set('kisi', id);
    else next.delete('kisi');
    setParams(next, { replace: !id && !!openId });
  };

  const all = useMemo(() => data.data ?? [], [data.data]);
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter((u) => (tab === 'tumu' || (tab === 'etkin' ? u.active : !u.active)) && (!k || fold(`${u.name} ${ROLE_LABELS[u.role]}`).includes(k)));
  }, [all, q, tab]);

  const setActive = async (u: UserRow, active: boolean) => {
    try {
      await patch(`/admin/users/${u.id}`, { active });
      toast.ok(`${u.name} ${active ? 'etkinleştirildi' : 'kapatıldı'}`);
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  if (data.isLoading) return <PageLoading />;
  const selected = openId && openId !== 'yeni' ? all.find((u) => u.id === openId) ?? null : null;

  const columns: Column<UserRow>[] = [
    {
      key: 'kisi',
      header: 'Personel',
      cell: (u) => (
        <span className="flex items-center gap-3">
          <Avatar name={u.name} color={u.color} />
          <span className="min-w-0">
            <span className="block truncate font-medium text-[var(--admin-text)]">{u.name}</span>
            <span className="block text-xs text-[var(--admin-text-mute)]">{u.id === me?.id ? 'Siz' : ROLE_LABELS[u.role]}</span>
          </span>
        </span>
      ),
    },
    { key: 'rol', header: 'Rol', cell: (u) => <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge> },
    {
      key: 'yetki',
      header: 'Kişiye özel yetki',
      cell: (u) =>
        u.permGrant.length || u.permRevoke.length ? (
          <span className="flex flex-wrap gap-1">
            {u.permGrant.length > 0 && <Badge tone="primary">+{u.permGrant.length} ek</Badge>}
            {u.permRevoke.length > 0 && <Badge tone="danger">−{u.permRevoke.length} kaldırılan</Badge>}
          </span>
        ) : (
          <span className="text-[var(--admin-text-mute)]">Rolün yetkileri</span>
        ),
      hideOnPhone: true,
      hideBelow: 'xl',
    },
    { key: 'indirim', header: 'İndirim sınırı', align: 'right', cell: (u) => <span className="tabular-nums">%{u.maxDiscountPct}</span> },
    { key: 'giris', header: 'Son giriş', cell: (u) => <span className="whitespace-nowrap text-[var(--admin-text-soft)]">{since(u.lastLoginAt)}</span> },
    { key: 'durum', header: 'Durum', cell: (u) => <Badge tone={u.active ? 'success' : 'neutral'} dot>{u.active ? 'Etkin' : 'Kapalı'}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Personel ve yetki"
        description="Her kişi kendi PIN'iyle girer; yetkisi olmayan işlemi yetkili PIN'iyle onaylatır. Maliyet ve kâr yalnız 'Maliyet, kâr ve personel tutarları' yetkisiyle görünür"
        actions={
          <button type="button" className={BTN.primary} onClick={() => open('yeni')}>
            <Plus className="size-4" aria-hidden="true" />
            Personel ekle
          </button>
        }
      />
      <StatusTabs
        label="Personel durumu"
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'etkin', label: 'Etkin', count: all.filter((u) => u.active).length },
          { value: 'kapali', label: 'Kapalı', count: all.filter((u) => !u.active).length },
          { value: 'tumu', label: 'Tümü', count: all.length },
        ]}
      />
      <div className="mb-3 flex items-center gap-2">
        <SearchField value={q} onChange={setQ} placeholder="Ad ya da rol" label="Personel ara" />
      </div>
      <DataTable
        caption="Personel"
        rows={rows}
        columns={columns}
        rowKey={(u) => u.id}
        onOpen={(u) => open(u.id)}
        selectedKey={openId}
        rowClassName={(u) => !u.active && 'opacity-70'}
        phoneMeta={(u) => (
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge tone={ROLE_TONE[u.role]}>{ROLE_LABELS[u.role]}</Badge>
            <span>{since(u.lastLoginAt)}</span>
            {!u.active && <Badge>Kapalı</Badge>}
          </span>
        )}
        actions={(u) => (
          <ActionMenu
            label={`${u.name} eylemleri`}
            items={[
              { key: 'duzenle', label: 'Düzenle ve yetkiler', icon: <Pencil />, onSelect: () => open(u.id) },
              { key: 'pin', label: 'PIN değiştir', icon: <KeyRound />, onSelect: () => open(u.id) },
              ...(u.id === me?.id ? [] : [{ key: 'durum', label: u.active ? 'Kapat' : 'Etkinleştir', icon: <Power />, danger: u.active, onSelect: () => setActive(u, !u.active) }]),
            ]}
          />
        )}
      />

      {(selected || openId === 'yeni') && (
        <UserDrawer
          key={openId}
          user={selected}
          isMe={selected?.id === me?.id}
          onClose={() => open(null)}
          onSaved={() => {
            refresh();
            open(null);
          }}
        />
      )}
    </>
  );
}

function UserDrawer({ user, isMe, onClose, onSaved }: { user: UserRow | null; isMe: boolean; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(user ? { ...user, pin: '' } : { name: '', role: 'garson', color: COLORS[3], active: true, permGrant: [], permRevoke: [], maxDiscountPct: 10, pin: '' });
  const [saving, setSaving] = useState(false);
  const effective = effectivePermissions(d.role, { grant: d.permGrant, revoke: d.permRevoke });
  const pinOk = user ? !d.pin || /^\d{4,6}$/.test(d.pin) : /^\d{4,6}$/.test(d.pin);
  const toggle = (p: Permission) => {
    const byRole = ROLE_DEFAULTS[d.role].includes(p);
    const on = effective.has(p);
    if (byRole) setD({ ...d, permRevoke: on ? [...d.permRevoke, p] : d.permRevoke.filter((x) => x !== p) });
    else setD({ ...d, permGrant: on ? d.permGrant.filter((x) => x !== p) : [...d.permGrant, p] });
  };
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: d.name, role: d.role, color: d.color, maxDiscountPct: d.maxDiscountPct, permGrant: d.permGrant, permRevoke: d.permRevoke, active: d.active, ...(d.pin ? { pin: d.pin } : {}) };
      if (user) await patch(`/admin/users/${user.id}`, body);
      else await post('/admin/users', { ...body, pin: d.pin });
      toast.ok(`${d.name} kaydedildi`);
      onSaved();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <QuickLook
      open
      onClose={onClose}
      label={user ? `${user.name} ayrıntısı` : 'Yeni personel'}
      title={
        <span className="flex items-center gap-2.5">
          <Avatar name={d.name || '?'} color={d.color} />
          {user ? user.name : 'Yeni personel'}
        </span>
      }
      subtitle={user ? `${ROLE_LABELS[user.role]} · son giriş ${since(user.lastLoginAt).toLocaleLowerCase('tr-TR')}` : 'PIN 4-6 hane; kişi bu PIN ile girer'}
      footer={
        <>
          {user && !isMe && <Toggle checked={d.active} onChange={(v) => setD({ ...d, active: v })} label={d.active ? 'Etkin' : 'Kapalı'} />}
          <div className="flex-1" />
          <button type="button" className={BTN.ghost} onClick={onClose}>
            Vazgeç
          </button>
          <button type="button" className={BTN.primary} disabled={!d.name.trim() || !pinOk || saving} onClick={save}>
            Kaydet
          </button>
        </>
      }
    >
      {user && (
        <div className="mb-4 rounded-xl border border-[var(--admin-border)] px-3">
          <DefRow label="Rol">{ROLE_LABELS[user.role]}</DefRow>
          <DefRow label="İndirim sınırı">%{user.maxDiscountPct} · üstü yetkili onayı ister</DefRow>
          <DefRow label="Etkin yetki">{effectivePermissions(user.role, { grant: user.permGrant, revoke: user.permRevoke }).size} / {ALL_PERMISSIONS.length}</DefRow>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ad">
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus={!user} />
        </Field>
        <Field label="Rol">
          <Select value={d.role} onChange={(e) => setD({ ...d, role: e.target.value as Role, permGrant: [], permRevoke: [] })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={user ? 'Yeni PIN' : 'PIN'} hint={user ? 'değişmeyecekse boş' : '4-6 hane'} error={d.pin && !pinOk ? '4-6 hane rakam' : null}>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--admin-text-mute)]" aria-hidden="true" />
            <Input value={d.pin} onChange={(e) => setD({ ...d, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" autoComplete="off" className="pl-9 tracking-[0.3em]" />
          </div>
        </Field>
        <Field label="İndirim sınırı (%)" hint="üstü onay ister">
          <Input type="number" min={0} max={100} value={d.maxDiscountPct} onChange={(e) => setD({ ...d, maxDiscountPct: Math.max(0, Math.min(100, Number(e.target.value) || 0)) })} />
        </Field>
        <div className="sm:col-span-2">
          <div className="mb-1.5 text-sm font-medium text-[var(--admin-text-soft)]">Renk</div>
          <div className="flex flex-wrap gap-1">
            {COLORS.map((c) => (
              <button key={c} type="button" aria-label={`Renk ${c}`} aria-pressed={d.color === c} onClick={() => setD({ ...d, color: c })} className="grid size-11 place-items-center rounded-full">
                <span className={cn('size-8 rounded-full ring-offset-2 ring-offset-[var(--admin-surface)]', d.color === c && 'ring-2 ring-[var(--admin-primary)]')} style={{ background: c }} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <h3 className="mb-2 mt-5 text-sm font-semibold">Yetkiler</h3>
      <div className="overflow-hidden rounded-xl border border-[var(--admin-border)]">
        {ALL_PERMISSIONS.map((p) => {
          const on = effective.has(p);
          const byRole = ROLE_DEFAULTS[d.role].includes(p);
          const source = byRole ? (on ? null : { tone: 'danger' as const, text: 'rolden kaldırıldı' }) : on ? { tone: 'primary' as const, text: 'ek yetki' } : null;
          return (
            <label key={p} className="flex min-h-11 cursor-pointer items-center gap-3 border-b border-[var(--admin-divider)] px-3 py-2 text-sm last:border-0 hover:bg-[var(--admin-surface-2)]">
              <input type="checkbox" checked={on} onChange={() => toggle(p)} className="size-4 accent-[var(--admin-primary)]" />
              <span className="min-w-0 flex-1">{PERMISSIONS[p]}</span>
              {source && <Badge tone={source.tone}>{source.text}</Badge>}
            </label>
          );
        })}
      </div>
    </QuickLook>
  );
}
