import { useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Lock, Pencil, Plus, Power, Save, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { ALL_PERMISSIONS, effectivePermissions, type Permission, PERMISSION_GROUPS, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, type RoleMatrix, ROLES } from '@shared/permissions';
import { fmtDateTime } from '@shared/time';
import { ActionMenu, Badge, CARD, type Column, DataTable, EmptyState, PageHeader, QuickLook, SearchField, StatusTabs, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Field, Input, Label, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { Avatar, ErrorState, Notice } from '@/components/ui/misc';
import { errorMessage, get, patch, post } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';
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

/** Son giriş: "az önce", "12 dk önce", "3 sa önce", sonra tarih (Innex: "Şu an aktif / 3 saat önce") */
function since(at: number | null): string {
  if (!at) return 'Hiç girmedi';
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 2) return 'Az önce';
  if (min < 60) return `${min} dk önce`;
  if (min < 24 * 60) return `${Math.round(min / 60)} sa önce`;
  return fmtDateTime(at);
}

/** Ad altındaki satır: "Son giriş 12 dk önce" ya da "Hiç girmedi" */
const lastSeen = (at: number | null) => (at ? `Son giriş ${since(at).toLocaleLowerCase('tr-TR')}` : since(at));

/**
 * Rol rozeti sakin ve renksiz; her şeyi gören patron Roller'deki kilitle ayrılır (mor online siparişin, kırmızı
 * alarmın rengi: rol bir durum değil)
 */
function RoleBadge({ role }: { role: Role }) {
  return (
    <Badge>
      {role === 'patron' && <Lock className="size-3" aria-hidden="true" />}
      {ROLE_LABELS[role]}
    </Badge>
  );
}

/** Yetki grubunun etiketi: cümle düzeninde (büyük harf yalnız kenar çubuğunun grup etiketlerinde) */
const GROUP_LABEL = 'text-[13px] font-semibold text-[var(--admin-text-soft)]';

/**
 * Personel (Innex personel listesi ve §3 fikir 9): rol rozeti, kişiye özel ek ve kaldırılan yetki satırda, son giriş
 * adın altında "3 sa önce" biçiminde; düzenleme sağdan açılan çekmecede, yetkiler tablo olarak. ?kisi=<id>|yeni,
 * "PIN değiştir" ayrıca &odak=pin (PIN alanı odaklı açılır).
 */
export default function UsersAdmin() {
  const qc = useQueryClient();
  const me = useAuth((s) => s.me);
  const [params, setParams] = useSearchParams();
  const data = useQuery({ queryKey: ['users', 'admin'], queryFn: () => get<UserRow[]>('/admin/users') });
  // Rol yetkileri Roller sayfasında değişebilir: "rol varsayılanı" o anki rol setidir
  const roles = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => get<{ roles: { role: Role; permissions: Permission[]; custom: boolean }[] }>('/admin/roles') });
  const matrix: RoleMatrix = Object.fromEntries((roles.data?.roles ?? []).filter((r) => r.custom).map((r) => [r.role, r.permissions]));
  const [tab, setTab] = useState<'tumu' | 'etkin' | 'kapali'>('etkin');
  const [q, setQ] = useState('');
  const openId = params.get('kisi');
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['bootstrap'] });
  };
  const open = (id: string | null, focus?: 'pin') => {
    const next = new URLSearchParams(params);
    if (id) next.set('kisi', id);
    else next.delete('kisi');
    if (id && focus) next.set('odak', focus);
    else next.delete('odak');
    setParams(next, { replace: !id && !!openId });
  };

  const all = useMemo(() => data.data ?? [], [data.data]);
  const rows = useMemo(() => {
    const k = fold(q.trim());
    return all.filter((u) => (tab === 'tumu' || (tab === 'etkin' ? u.active : !u.active)) && (!k || fold(`${u.name} ${ROLE_LABELS[u.role]}`).includes(k)));
  }, [all, q, tab]);

  // Kapatma onay sormaz, geri alınabilir: bildirimdeki "Geri al" eski durumu yazar
  const setActive = async (u: UserRow, active: boolean) => {
    try {
      await patch(`/admin/users/${u.id}`, { active });
      toast.ok(`${u.name} ${active ? 'etkinleştirildi' : 'kapatıldı'}`, { action: { label: 'Geri al', run: () => void setActive(u, !active) } });
      refresh();
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  const selected = openId && openId !== 'yeni' ? all.find((u) => u.id === openId) ?? null : null;

  // Kapalı kişi: rozet durumu söyler; yalnız avatar solar, yazılar okunur kalır (bütün satırı soldurmak AA altı)
  const avatar = (u: UserRow) => <Avatar name={u.name} color={u.color} className={u.active ? undefined : 'opacity-50 grayscale'} />;
  // Personel hücresinin yazısı: tabloda avatarın yanında, telefonun satır kartında başlık (avatar kartın solunda, alt
  // satır adın hizasından başlar)
  const who = (u: UserRow) => (
    <span className="min-w-0">
      <span className={cn('block truncate font-medium', u.active ? 'text-[var(--admin-text)]' : 'text-[var(--admin-text-soft)]')}>{u.name}</span>
      <span className="block text-xs text-[var(--admin-text-mute)]">{u.id === me?.id ? 'Siz' : lastSeen(u.lastLoginAt)}</span>
    </span>
  );
  const columns: Column<UserRow>[] = [
    {
      key: 'kisi',
      header: 'Personel',
      cell: (u) => (
        <span className="flex items-center gap-3">
          {avatar(u)}
          {who(u)}
        </span>
      ),
    },
    { key: 'rol', header: 'Rol', cell: (u) => <RoleBadge role={u.role} /> },
    {
      key: 'yetki',
      header: 'Kişiye özel',
      cell: (u) =>
        u.permGrant.length || u.permRevoke.length ? (
          <span className="flex flex-wrap gap-1">
            {u.permGrant.length > 0 && <Badge tone="primary">+{u.permGrant.length} ek</Badge>}
            {u.permRevoke.length > 0 && <Badge>−{u.permRevoke.length} kaldırıldı</Badge>}
          </span>
        ) : (
          <span className="text-[var(--admin-text-mute)]">
            <span aria-hidden="true">—</span>
            <span className="sr-only">Rolün yetkileri</span>
          </span>
        ),
      hideOnPhone: true,
      hideBelow: 'xl',
    },
    { key: 'indirim', header: 'İndirim sınırı', align: 'right', cell: (u) => <span className="tabular-nums">%{u.maxDiscountPct}</span> },
    { key: 'durum', header: 'Durum', cell: (u) => <Badge tone={u.active ? 'success' : 'neutral'} dot>{u.active ? 'Etkin' : 'Kapalı'}</Badge> },
  ];

  return (
    <>
      <PageHeader
        title="Personel"
        description="Her kişi kendi PIN’iyle girer; yetkisi olmayan işlemi yetkili PIN’iyle onaylatır"
        actions={
          <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => open('yeni')}>
            Personel ekle
          </Button>
        }
      />
      {data.isPending ? (
        <TableSkeleton rows={6} />
      ) : data.isError && !data.data ? (
        <ErrorState className={CARD} title="Personel listesi alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      ) : (
        <>
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
            phoneLead={avatar}
            phoneTitle={who}
            phoneMeta={(u) => (
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <RoleBadge role={u.role} />
                {!u.active && <Badge>Kapalı</Badge>}
              </span>
            )}
            actions={(u) => (
              <ActionMenu
                label={`${u.name} eylemleri`}
                items={[
                  { key: 'duzenle', label: 'Düzenle ve yetkiler', icon: <Pencil />, onSelect: () => open(u.id) },
                  { key: 'pin', label: 'PIN değiştir', icon: <KeyRound />, onSelect: () => open(u.id, 'pin') },
                  // "Kapat" çekmecenin × düğmesinin de adı: hesabı kapatan eylem nesnesiyle adlandırılır
                  ...(u.id === me?.id ? [] : [{ key: 'durum', label: u.active ? 'Hesabı kapat' : 'Etkinleştir', icon: <Power />, danger: u.active, onSelect: () => void setActive(u, !u.active) }]),
                ]}
              />
            )}
            empty={
              <EmptyState
                icon={<SearchX />}
                title={q.trim() ? `“${q.trim()}” ile eşleşen kişi yok` : tab === 'kapali' ? 'Kapatılmış personel yok' : 'Bu süzgeçte kişi yok'}
                action={
                  q.trim() || tab !== 'etkin' ? (
                    <Button
                      onClick={() => {
                        setQ('');
                        setTab('etkin');
                      }}
                    >
                      {q.trim() ? 'Aramayı temizle' : 'Etkin personeli göster'}
                    </Button>
                  ) : undefined
                }
              >
                {q.trim() ? 'Adın ya da rolün bir bölümünü yazın' : 'Kapatılan kişi burada listelenir; geçmiş adisyonlarında adı kalır'}
              </EmptyState>
            }
          />
        </>
      )}

      {(selected || openId === 'yeni') && (
        <UserDrawer
          key={openId}
          user={selected}
          isMe={selected?.id === me?.id}
          focusPin={!!selected && params.get('odak') === 'pin'}
          matrix={matrix}
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

function UserDrawer({ user, isMe, focusPin, matrix, onClose, onSaved }: { user: UserRow | null; isMe: boolean; focusPin: boolean; matrix: RoleMatrix; onClose: () => void; onSaved: () => void }) {
  const [d, setD] = useState<Draft>(user ? { ...user, pin: '' } : { name: '', role: 'garson', color: COLORS[3], active: true, permGrant: [], permRevoke: [], maxDiscountPct: 10, pin: '' });
  const fine = useFinePointer();
  const [saving, setSaving] = useState(false);
  // Eksik ya da hatalı alan Kaydet'e basınca alanın altında söylenir (düğme sessizce soluk kalmaz)
  const [tried, setTried] = useState(false);
  // Sayım taslaktan: rol, indirim ya da yetki değişince başlıktaki sayı da değişir (kayıtlı değer formla çelişmez)
  const effective = effectivePermissions(d.role, { grant: d.permGrant, revoke: d.permRevoke }, matrix);
  const roleBase = (role: Role) => (role === 'patron' ? ALL_PERMISSIONS : (matrix[role] ?? ROLE_DEFAULTS[role]));
  const pinOk = user ? !d.pin || /^\d{4,6}$/.test(d.pin) : /^\d{4,6}$/.test(d.pin);
  const toggle = (p: Permission) => {
    const byRole = roleBase(d.role).includes(p);
    const on = effective.has(p);
    if (byRole) setD({ ...d, permRevoke: on ? [...d.permRevoke, p] : d.permRevoke.filter((x) => x !== p) });
    else setD({ ...d, permGrant: on ? d.permGrant.filter((x) => x !== p) : [...d.permGrant, p] });
  };
  const nameError = !d.name.trim() ? 'Ad gerekli' : null;
  const pinError = pinOk ? null : !d.pin ? 'PIN gerekli (4–6 hane)' : '4–6 hane rakam';
  const save = async () => {
    if (nameError || pinError) {
      setTried(true);
      return;
    }
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
      subtitle={user ? `${ROLE_LABELS[user.role]} · ${lastSeen(user.lastLoginAt).toLocaleLowerCase('tr-TR')}` : 'PIN 4–6 hane; kişi bu PIN ile girer'}
      footer={
        <>
          {/* Anahtarın adı ayarı söyler, durumu anahtarın kendisi (Ödeme türündeki gibi) */}
          {user && !isMe && <Toggle checked={d.active} onChange={(v) => setD({ ...d, active: v })} label="Etkin" />}
          <div className="flex-1" />
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
            Kaydet
          </Button>
        </>
      }
    >
      {/* Kendi kaydında kilitli alanların nedeni en üstte: soluk alanlara bakıp aşağıda aranmasın */}
      {isMe && (
        <Notice tone="info" className="mb-4">
          Rolünüzü, yetkilerinizi ve indirim sınırınızı başka bir yetkili değiştirir; burada adınızı, renginizi ve PIN’inizi değiştirebilirsiniz
        </Notice>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Ad" required error={tried ? nameError : null}>
          <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} autoFocus={!user && fine} autoCapitalize="words" />
        </Field>
        <Field label="Rol">
          <Select value={d.role} disabled={isMe} onChange={(e) => setD({ ...d, role: e.target.value as Role, permGrant: [], permRevoke: [] })}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        </Field>
        {/* Kısa ipucu etiketle aynı satırda kalır: PIN alanı yanındaki İndirim sınırıyla aynı hizada */}
        <Field label={user ? 'Yeni PIN' : 'PIN'} hint={user ? 'boşsa değişmez' : '4–6 hane'} error={(d.pin || tried) && pinError ? pinError : null}>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--admin-text-mute)]" aria-hidden="true" />
            {/* "PIN değiştir" ile açılınca alan odaklı: kişi doğrudan yeni PIN'i yazar */}
            <Input value={d.pin} onChange={(e) => setD({ ...d, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })} inputMode="numeric" autoComplete="off" autoFocus={focusPin} className="pl-9 tracking-[0.3em]" />
          </div>
        </Field>
        <Field label="İndirim sınırı (%)" hint="üstü onay ister">
          <NumberInput value={d.maxDiscountPct} min={0} max={100} fallback={0} disabled={isMe} onCommit={(maxDiscountPct) => setD({ ...d, maxDiscountPct })} />
        </Field>
        <div className="sm:col-span-2" role="group" aria-label="Renk">
          <Label>Renk</Label>
          {/* Telefonda sekiz renk tek satır (8 × 44 px), arada boşluk yok; geniş ekranda 4 px */}
          <div className="flex flex-wrap gap-0 sm:gap-1">
            {COLORS.map((c, i) => (
              <button key={c} type="button" aria-label={`Renk ${i + 1}`} aria-pressed={d.color === c} onClick={() => setD({ ...d, color: c })} className="grid size-11 place-items-center rounded-full">
                <span
                  className={cn('size-8 rounded-full', d.color === c ? 'ring-2 ring-[var(--admin-primary)] ring-offset-2 ring-offset-[var(--admin-surface)]' : 'ring-1 ring-inset ring-black/5 dark:ring-white/15')}
                  style={{ background: c }}
                />
              </button>
            ))}
          </div>
        </div>
      </div>

      <h3 className="mb-1 mt-5 flex items-baseline justify-between gap-3 text-[15px] font-semibold">
        Yetkiler
        <span className="text-[13px] font-medium tabular-nums text-[var(--admin-text-mute)]">
          {effective.size} / {ALL_PERMISSIONS.length}
          <span className="sr-only"> yetki açık</span>
        </span>
      </h3>
      {!isMe && <p className="mb-2 text-xs text-[var(--admin-text-mute)]">İşaretliler rolden gelir; burada değiştirilen yalnız bu kişiye uygulanır (rol setleri: Roller ve yetkiler)</p>}
      <div className={cn('space-y-3', isMe && 'mt-2')}>
        {PERMISSION_GROUPS.map((g) => (
          <div key={g.key} className="overflow-hidden rounded-xl border border-[var(--admin-border)]">
            <div className={cn('bg-[var(--admin-panel)] px-3 py-1.5', GROUP_LABEL)}>{g.label}</div>
            {g.permissions.map((p) => {
              const on = effective.has(p);
              const byRole = roleBase(d.role).includes(p);
              // Rolden fark sakin: kaldırma olağan bir karar, gri (kırmızı yalnız alarm ve iptal); ek ev yeşili (eklenen)
              const source = byRole ? (on ? null : { tone: 'neutral' as const, text: 'Kişiden kaldırıldı' }) : on ? { tone: 'primary' as const, text: 'Kişiye ek' } : null;
              return (
                <label key={p} className={cn('flex min-h-11 items-center gap-3 border-t border-[var(--admin-divider)] px-3 py-2 text-sm', isMe ? 'opacity-70' : 'cursor-pointer transition-colors hover:bg-hover')}>
                  <input type="checkbox" checked={on} disabled={isMe} onChange={() => toggle(p)} className="size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
                  <span className="min-w-0 flex-1">{PERMISSIONS[p]}</span>
                  {source && <Badge tone={source.tone}>{source.text}</Badge>}
                </label>
              );
            })}
          </div>
        ))}
      </div>
    </QuickLook>
  );
}
