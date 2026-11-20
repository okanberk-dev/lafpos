import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Lock, RotateCcw, Save } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
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
/** Grubun açık yetki sayısı: "6 / 9"; ekran okuyucuya "açık" eki */
const countOf = (on: number, total: number) => (
  <>
    {on} / {total}
    <span className="sr-only"> açık</span>
  </>
);

/**
 * Kilitli rolün (patron) yetkisi: gri kutuda tik. Devre dışı onay kutusu soluk gri çizilir, okunmaz; kutu yerinde kalır
 * (ekran okuyucu "işaretli, devre dışı" okur), görünen işaret bu
 */
function LockedMark({ on, className }: { on: boolean; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center rounded-md bg-[var(--admin-panel)] text-[var(--admin-text-soft)]', className)}>
      {on && <Check className="size-3.5 stroke-[2.5]" />}
    </span>
  );
}

/** Açık yetkinin oranı: ince hap iz, ev yeşili dolgu (raporların yatay çubuğu); sayı yanında yazılı, çubuk süs */
function PermMeter({ on, total }: { on: number; total: number }) {
  return (
    <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-[var(--r-track)]" style={{ background: 'var(--chart-track)' }}>
      <div className="h-full rounded-[var(--r-track)] transition-[width] duration-300 motion-reduce:transition-none" style={{ width: `${total ? (on / total) * 100 : 0}%`, background: 'var(--chart-accent)' }} />
    </div>
  );
}

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
  // Telefonda bildirim yapışkan şeridin üstünde durur: şerit telefonda iki satır (yazı, düğmeler), boyu html'de
  // --action-bar-h (lib/toast.tsx; adisyondaki gibi). Şerit sökülünce silinir
  const measureActionBar = useCallback((el: HTMLDivElement | null) => {
    if (!el || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const ro = new ResizeObserver(() => root.style.setProperty('--action-bar-h', `${Math.ceil(el.getBoundingClientRect().height)}px`));
    ro.observe(el);
    return () => {
      ro.disconnect();
      root.style.removeProperty('--action-bar-h');
    };
  }, []);
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
              {/* Başlık şeridi kitin DataTable'ı gibi (zemini --table-head-bg); yapışkan ilk hücre opak: kayan hücreler altından görünmez */}
              <tr className="border-b border-[var(--admin-border)] bg-[var(--table-head-bg)]">
                <th scope="col" className="sticky left-0 z-[1] h-12 min-w-44 bg-[var(--admin-surface)] px-4 text-left text-[13px] font-medium text-[var(--admin-text-mute)] md:w-[38%]">
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
                              'grid size-8 place-items-center rounded-[var(--r-btn)] text-[var(--admin-primary)] transition-colors hover:bg-[var(--admin-primary-soft)] active:bg-[var(--admin-primary-soft)] pointer-coarse:size-11',
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

      {/* Telefon: önce rol (seçicide hepsi görünür) ve özeti bir kartta (açık yetki sayısı, oranın çubuğu, varsayılana dön),
          sonra o rolün yetkileri gruplar hâlinde */}
      <div className="md:hidden">
        <div className={cn(CARD, 'mb-4 p-4')}>
          <Field label="Rol">
            <Select value={phone.role} onChange={(e) => setPhoneRole(e.target.value as Role)}>
              {roles.map((r) => (
                <option key={r.role} value={r.role}>
                  {joinMeta([r.label, `${r.users} kişi`, changed(r) && 'değişti'])}
                </option>
              ))}
            </Select>
          </Field>
          {phone.locked ? (
            <p className="mt-3 flex items-center gap-2 text-[13px] text-[var(--admin-text-mute)]">
              <Lock className="size-3.5 shrink-0" aria-hidden="true" />
              Patron rolü her yetkiye sahiptir ve değiştirilemez
            </p>
          ) : (
            <>
              <p className="mt-3 text-[13px] text-[var(--admin-text-mute)]">
                <span className="font-semibold tabular-nums text-[var(--admin-text)]">
                  {current(phone).length} / {total}
                </span>{' '}
                yetki açık
              </p>
              <div className="mt-2">
                <PermMeter on={current(phone).length} total={total} />
              </div>
              {!sameSet(current(phone), phone.defaults) && (
                <Button icon={<RotateCcw className="size-4" />} onClick={() => reset(phone)} className="mt-3 w-full">
                  Varsayılana dön
                </Button>
              )}
            </>
          )}
        </div>
        <div className="space-y-4">
          {groups.map((g) => (
            <section key={g.key}>
              {/* Grubun adı ve açık yetkisi kartın üstünde, zeminde */}
              <h2 className="flex items-baseline justify-between gap-3 px-1 pb-2">
                <span className={GROUP_LABEL}>{g.label}</span>
                <span className="text-xs font-medium tabular-nums text-[var(--admin-text-mute)]">{countOf(g.permissions.filter((p) => current(phone).includes(p)).length, g.permissions.length)}</span>
              </h2>
              <ul className={cn(CARD, 'divide-y divide-[var(--admin-divider)] overflow-hidden')}>
                {g.permissions.map((p) => {
                  const on = current(phone).includes(p);
                  return (
                    <li key={p}>
                      <label className={cn('flex min-h-14 items-center gap-3 px-4 py-2.5 text-sm', !phone.locked && 'cursor-pointer')}>
                        <input type="checkbox" checked={on} disabled={phone.locked} onChange={() => toggle(phone, p)} className={cn('size-5 shrink-0 accent-[var(--admin-primary)]', phone.locked && 'sr-only')} />
                        {phone.locked && <LockedMark on={on} className="size-5" />}
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
        // Ev çubuğu payını telefonda altındaki sekme çubuğu (AppShell) alır. Telefonda bildirim bu şeridin üstünde durur
        // (data-action-bar): kaydedilemeyen rolün hatası Vazgeç ve Kaydet'i örtmez. Şerit pano kartı gibi zeminde yüzer
        // (köşe 18, saç teli, açılan parçanın gölgesi), alttan 12 px yukarıda; kenara taşan negatif pay yok
        <div data-action-bar="" className="sticky bottom-0 pointer-events-none z-10 mt-4 pb-3" ref={measureActionBar}>
          {/* Telefonda yazı kendi satırında, iki düğme altında eşit genişlikte (44 px düğmelerin yanına sığmaz) */}
          <div className="pointer-events-auto flex flex-wrap items-center gap-x-3 gap-y-2.5 rounded-[var(--r-card)] border border-[var(--card-line)] bg-[var(--admin-surface)] p-3 shadow-[var(--shadow-pop)] sm:py-2.5 sm:pl-5 sm:pr-2.5">
            <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-[var(--admin-text-soft)] max-sm:basis-full max-sm:px-1">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--admin-warning)]" />
              {/* Telefonda kısa (hangi rolün değiştiği seçicide "değişti" diye yazar) */}
              <span className="sm:hidden">Kaydedilmemiş değişiklik</span>
              <span className="max-sm:hidden">{dirty.length === 1 ? `${dirty[0].label} rolünde kaydedilmemiş değişiklik` : `${dirty.length} rolde kaydedilmemiş değişiklik`}</span>
            </span>
            <span className="flex-1 max-sm:hidden" />
            <Button disabled={saving} onClick={() => setDraft({})} className="max-sm:flex-1">
              Vazgeç
            </Button>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()} className="max-sm:flex-1">
              Kaydet
            </Button>
          </div>
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
        <th scope="rowgroup" className={cn('sticky left-0 z-[1] bg-[var(--admin-panel)] px-4 py-2 text-left', GROUP_LABEL)}>
          {group.label}
        </th>
        {/* Ara toplam: her rolün bu gruptaki açık yetkisi ("6 / 9"), sütununun hizasında */}
        {roles.map((r) => (
          <td key={r.role} className="px-1 py-2 text-center text-xs font-medium tabular-nums text-[var(--admin-text-mute)]">
            {countOf(group.permissions.filter((p) => current(r).includes(p)).length, group.permissions.length)}
          </td>
        ))}
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
                    className={cn('size-4 accent-[var(--admin-primary)]', r.locked && 'sr-only')}
                  />
                  {r.locked && <LockedMark on={on} className="size-4" />}
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </tbody>
  );
}
