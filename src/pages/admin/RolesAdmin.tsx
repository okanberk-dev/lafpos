import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Lock, RotateCcw, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { type Permission, PERMISSIONS, type Role } from '@shared/permissions';
import { Badge, CARD, PageHeader, TableSkeleton } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { ErrorState } from '@/components/ui/misc';
import { errorMessage, get, put } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/hooks';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { useUnsavedGuard } from '@/lib/unsavedGuard';

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
/** Yetki grubunun etiketi: cümle düzeninde (büyük harf yalnız kenar çubuğunun grup etiketlerinde) */
const GROUP_LABEL = 'text-[13px] font-semibold text-[var(--admin-text-soft)]';
/** "Kasiyer / Barista" dar sütunda "Kasiyer /" ve "Barista" diye kırılır: eğik çizgi yalnız kalmaz (bölünmez boşluk) */
const keepSlash = (label: string) => label.replace(' / ', '\u00a0/ ');

/**
 * Roller ve yetkiler (ModPOS "Pozisyonlar" ve "Özel Yetkiler" gibi): her rolün yetki seti burada düzenlenir,
 * o roldeki herkese uygulanır; kişiye özel ek ya da kaldırılan yetki Personel sayfasında kalır. Patron rolü
 * kilitli. Bilgisayarda roller sütun, yetkiler satır; telefonda rol seçilip yetkileri liste olarak. Matris iki
 * ekran boyu: değişiklik varken altta yapışkan şerit (Vazgeç, Kaydet), sayfadan çıkarken sorulur (Ayarlar gibi).
 */
export default function RolesAdmin() {
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'roles'], queryFn: () => get<RolesData>('/admin/roles') });
  const [draft, setDraft] = useState<Partial<Record<Role, Permission[]>>>({});
  const [phoneRole, setPhoneRole] = useState<Role>('kasiyer');
  const [saving, setSaving] = useState(false);
  const wide = useMediaQuery('(min-width: 768px)');

  const roles = useMemo(() => data.data?.roles ?? [], [data.data]);
  const current = (r: RoleRow) => draft[r.role] ?? r.permissions;
  const changed = (r: RoleRow) => !!draft[r.role] && !sameSet(draft[r.role]!, r.permissions);
  const dirty = roles.filter(changed);
  // Kenar çubuğu, alt sekme, komut paleti, geri tuşu ve sekmeyi kapatmak kaydedilmemiş değişikliği sorar
  useUnsavedGuard(dirty.length > 0);

  const toggle = (r: RoleRow, p: Permission) => {
    if (r.locked) return;
    const list = current(r);
    setDraft({ ...draft, [r.role]: list.includes(p) ? list.filter((x) => x !== p) : [...list, p] });
  };
  const reset = (r: RoleRow) => setDraft({ ...draft, [r.role]: r.defaults });
  // Roller sırayla kaydedilir: biri reddedilirse önce kaydedilenler taslaktan düşer (sayaç kalanları gösterir), ekran
  // sunucudaki durumu yeniden okur, ileti hangi rolün kaydedilemediğini söyler. Başarı bildirimi taslak düştükten sonra:
  // telefonda bildirim şerit varken onun üstünde durur, şerit kalkınca aşağı zıplamasın
  const save = async () => {
    if (saving) return;
    setSaving(true);
    const saved: RoleRow[] = [];
    try {
      for (const r of dirty) {
        try {
          await put(`/admin/roles/${r.role}`, { permissions: draft[r.role] });
        } catch (e) {
          toast.err(`${r.label}: ${errorMessage(e)}${saved.length ? ` (${saved.map((x) => x.label).join(', ')} kaydedildi)` : ''}`);
          return;
        }
        saved.push(r);
      }
    } finally {
      // Önce sunucunun yeni hâli okunur, sonra taslak düşer (kaydedilen rol bir an eski yetkileriyle görünmesin)
      await qc.invalidateQueries({ queryKey: ['admin', 'roles'] }).catch(() => undefined);
      if (saved.length) {
        setDraft((d) => {
          const next = { ...d };
          for (const r of saved) delete next[r.role];
          return next;
        });
        qc.invalidateQueries({ queryKey: ['users'] });
      }
      setSaving(false);
    }
    toast.ok(saved.length === 1 ? `${saved[0].label} rolünün yetkileri kaydedildi` : `${saved.length} rolün yetkileri kaydedildi`);
  };

  // Telefonda Kaydet yalnız alttaki yapışkan şeritte (değişiklik varken); başlıkta gri, dolu bir düğme durmaz
  const header = (
    <PageHeader
      title="Roller ve yetkiler"
      description="Rolün yetkisi o roldeki herkese uygulanır; kişiye özel ek Personel’de"
      actions={
        data.data && wide ? (
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty.length} onClick={() => void save()}>
            Kaydet
          </Button>
        ) : undefined
      }
    />
  );

  if (data.isPending)
    return (
      <>
        {header}
        <TableSkeleton rows={10} />
      </>
    );
  if (!data.data)
    return (
      <>
        {header}
        <ErrorState className={CARD} title="Roller alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
      </>
    );
  const groups = data.data.groups;
  const total = groups.reduce((n, g) => n + g.permissions.length, 0);
  const phone = roles.find((r) => r.role === phoneRole) ?? roles[0];

  return (
    <>
      {header}

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
                {roles.map((r) => {
                  const same = sameSet(current(r), r.defaults);
                  return (
                    <th key={r.role} scope="col" className="px-1 py-2 text-center align-bottom">
                      <span className="flex flex-col items-center gap-1">
                        <span className="inline-flex max-w-20 items-center justify-center gap-1 text-center text-[13px] font-semibold leading-tight text-[var(--admin-text)]">
                          {r.locked && <Lock className="size-3.5 shrink-0 text-[var(--admin-text-mute)]" aria-label="kilitli" />}
                          {keepSlash(r.label)}
                        </span>
                        <span className="text-xs font-normal text-[var(--admin-text-mute)]">{r.users} kişi</span>
                        {/* "Varsayılana dön" yeri her sütunda ayrılır: değişen sütunun başlığı zıplamaz, komşuları ezilmez */}
                        {r.locked ? (
                          <span aria-hidden="true" className="size-8 pointer-coarse:size-11" />
                        ) : (
                          <button
                            type="button"
                            onClick={() => reset(r)}
                            disabled={same}
                            aria-hidden={same || undefined}
                            tabIndex={same ? -1 : undefined}
                            aria-label={`${r.label}: varsayılana dön`}
                            title="Varsayılana dön"
                            className={cn(
                              'grid size-8 place-items-center rounded-full text-[var(--admin-primary)] transition-colors hover:bg-[var(--admin-primary-soft)] active:bg-[var(--admin-primary-soft)] pointer-coarse:size-11',
                              same && 'invisible',
                            )}
                          >
                            <RotateCcw className="size-4" aria-hidden="true" />
                          </button>
                        )}
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            {groups.map((g) => (
              <GroupRows key={g.key} group={g} roles={roles} current={current} toggle={toggle} />
            ))}
          </table>
        </div>
      </div>

      {/* Telefon: önce rol (seçicide hepsi görünür), sonra o rolün yetkileri */}
      <div className="md:hidden">
        <Field label="Rol" className="mb-2">
          <Select value={phone.role} onChange={(e) => setPhoneRole(e.target.value as Role)}>
            {roles.map((r) => (
              <option key={r.role} value={r.role}>
                {joinMeta([r.label, `${r.users} kişi`, changed(r) && 'değişti'])}
              </option>
            ))}
          </Select>
        </Field>
        <p className="mb-3 text-[13px] text-[var(--admin-text-mute)]">
          {phone.locked ? (
            'Patron rolü her yetkiye sahiptir ve değiştirilemez'
          ) : (
            <>
              <span className="tabular-nums">
                {current(phone).length} / {total}
              </span>{' '}
              yetki açık
            </>
          )}
        </p>
        {!phone.locked && !sameSet(current(phone), phone.defaults) && (
          <Button icon={<RotateCcw className="size-4" />} onClick={() => reset(phone)} className="mb-3">
            Varsayılana dön
          </Button>
        )}
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key}>
              <h2 className={cn('px-1 pb-2', GROUP_LABEL)}>{g.label}</h2>
              <ul className={cn(CARD, 'divide-y divide-[var(--admin-divider)] overflow-hidden')}>
                {g.permissions.map((p) => {
                  const on = current(phone).includes(p);
                  return (
                    <li key={p}>
                      <label className={cn('flex min-h-14 items-center gap-3 px-4 py-2.5 text-sm', phone.locked ? 'opacity-70' : 'cursor-pointer')}>
                        <input type="checkbox" checked={on} disabled={phone.locked} onChange={() => toggle(phone, p)} className="size-5 shrink-0 accent-[var(--admin-primary)]" />
                        <span className="min-w-0 flex-1">{PERMISSIONS[p]}</span>
                        {/* Varsayılandan fark: seçim olağan bir karar, alarm değil (kırmızı yalnız alarm ve iptal) */}
                        {!phone.locked && on !== phone.defaults.includes(p) && <Badge tone={on ? 'primary' : 'neutral'}>{on ? 'Eklendi' : 'Kaldırıldı'}</Badge>}
                      </label>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>

      {dirty.length > 0 && (
        // Ev çubuğu payını telefonda altındaki sekme çubuğu (AppShell) alır; burada yalnız iç boşluk. Telefonda bildirim
        // bu şeridin üstünde durur (data-action-bar): kaydedilemeyen rolün hatası Vazgeç ve Kaydet'i örtmez
        <div data-action-bar="" className="sticky bottom-0 z-10 -mx-4 mt-4 flex items-center gap-3 border-t border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-3 sm:-mx-5 sm:px-5">
          <span className="min-w-0 text-[13px] text-[var(--admin-text-mute)]">
            {/* Telefonda kısa (hangi rolün değiştiği seçicide "değişti" diye yazar) */}
            <span className="sm:hidden">Kaydedilmemiş değişiklik</span>
            <span className="max-sm:hidden">{dirty.length === 1 ? `${dirty[0].label} rolünde kaydedilmemiş değişiklik` : `${dirty.length} rolde kaydedilmemiş değişiklik`}</span>
          </span>
          <span className="flex-1" />
          <Button disabled={saving} onClick={() => setDraft({})}>
            Vazgeç
          </Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
            Kaydet
          </Button>
        </div>
      )}
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
        <th scope="rowgroup" className={cn('sticky left-0 z-[1] bg-[var(--admin-panel)] px-4 py-1.5 text-left', GROUP_LABEL)}>
          {group.label}
        </th>
        <td colSpan={roles.length} aria-hidden="true" />
      </tr>
      {group.permissions.map((p) => (
        <tr key={p} className="group border-t border-[var(--admin-divider)] hover:bg-[var(--hover-solid)]">
          <th scope="row" className="sticky left-0 z-[1] bg-[var(--admin-surface)] px-4 py-2 text-left font-normal text-[var(--admin-text)] group-hover:bg-[var(--hover-solid)]">
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
