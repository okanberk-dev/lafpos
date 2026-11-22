import { Lock, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { KontrolRol } from '@shared/kontrol';
import { ALL_PERMISSIONS, type Permission, PERMISSION_GROUPS, PERMISSIONS, type Role, ROLE_DEFAULTS, ROLE_LABELS, ROLES } from '@shared/permissions';
import { Button } from '@/components/ui/Button';
import { Field, Select } from '@/components/ui/Field';
import { Badge, Card } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';
import { useUnsavedGuard } from '@/lib/unsavedGuard';
import { BekliyorRozeti, KasaGuncelDegil, NEDEN, type SekmeProps } from './ortak';

const ayni = (a: Permission[], b: Permission[]) => a.length === b.length && a.every((p) => b.includes(p));
/** Yetki grubunun etiketi: cümle düzeninde (Yönetim › Roller ve yetkiler gibi) */
const GROUP_LABEL = 'text-[13px] font-semibold text-[var(--admin-text-soft)]';

/**
 * Roller: rol başına yetki seti (kasanın özetinden), Yönetim › Roller ve yetkiler'in telefondaki düzeni: rol seçilir,
 * yetkiler gruplar hâlinde onay kutusu. Patron kilitli. Kaydet değişen her rol için bir komut koyar; kasaya ulaşana dek
 * gönderilen set ekranda kalır ("Bekliyor"), kasa uygulayınca özet yeni seti getirir. Rol yetkilerini yalnız sahip değiştirir
 */
export function RollerSekmesi({ panel, durum, genel, neden, bekleyen, gonder }: SekmeProps) {
  const roller = useMemo<KontrolRol[]>(
    () => ROLES.map((r) => durum?.roller.find((x) => x.rol === r) ?? { rol: r, izinler: r === 'patron' ? ALL_PERMISSIONS : ROLE_DEFAULTS[r], ozel: false, kisi: 0 }),
    [durum?.roller],
  );
  const [secili, setSecili] = useState<Role>('kasiyer');
  const [taslak, setTaslak] = useState<Partial<Record<Role, Permission[]>>>({});
  // Gönderilip henüz kasaya ulaşmamış set (komut kimliğiyle): kuyruktan düşünce kasanın özeti geçerli olur
  const [gonderilen, setGonderilen] = useState<Partial<Record<Role, { izinler: Permission[]; id: string }>>>({});
  const [kaydediyor, setKaydediyor] = useState(false);
  const bekleyenIdler = new Set(panel.bekleyen.map((b) => b.id));
  const taban = (x: KontrolRol) => {
    const g = gonderilen[x.rol];
    return g && bekleyenIdler.has(g.id) ? g.izinler : x.izinler;
  };
  const gorunen = (x: KontrolRol) => taslak[x.rol] ?? taban(x);
  const degisen = roller.filter((x) => taslak[x.rol] && !ayni(taslak[x.rol]!, taban(x)));
  // Kenar çubuğu, alt sekme ve sekmeyi kapatmak kaydedilmemiş değişikliği sorar
  useUnsavedGuard(degisen.length > 0);
  if (!durum) return <KasaGuncelDegil bagli={panel.kasa !== null} />;

  const r = roller.find((x) => x.rol === secili) ?? roller[0];
  const kilitli = r.rol === 'patron';
  const kayitNeden = neden('rol.yetki');
  const kapali = kilitli || !!kayitNeden;
  const liste = gorunen(r);
  const toplam = ALL_PERMISSIONS.length;
  const bekliyor = (x: KontrolRol) => bekleyen.has(`rol:${x.rol}`) || (!!gonderilen[x.rol] && bekleyenIdler.has(gonderilen[x.rol]!.id));

  const toggle = (p: Permission) =>
    setTaslak((t) => {
      const l = t[r.rol] ?? taban(r);
      return { ...t, [r.rol]: l.includes(p) ? l.filter((x) => x !== p) : [...l, p] };
    });
  const kaydet = async () => {
    if (kaydediyor) return;
    setKaydediyor(true);
    try {
      // Roller sırayla: biri reddedilirse önce gönderilenler taslaktan düşer, ileti hangi rolün gitmediğini söyler
      for (const x of degisen) {
        const izinler = taslak[x.rol]!;
        try {
          const komut = await gonder({ tur: 'rol.yetki', veri: { rol: x.rol, izinler } });
          setGonderilen((g) => ({ ...g, [x.rol]: { izinler, id: komut.id } }));
        } catch (e) {
          toast.err(`${ROLE_LABELS[x.rol]}: ${errorMessage(e)}`);
          return;
        }
        setTaslak((t) => {
          const n = { ...t };
          delete n[x.rol];
          return n;
        });
      }
    } finally {
      setKaydediyor(false);
    }
  };

  return (
    <>
      <Card title="Rol yetkileri" subtitle="Rolün yetkisi kasada o roldeki herkese uygulanır; kişiye özel ek ya da kaldırılan yetki kasada kalır">
        <div className="grid gap-3 p-5">
          <Field label="Rol">
            <Select value={r.rol} onChange={(e) => setSecili(e.target.value as Role)}>
              {roller.map((x) => (
                <option key={x.rol} value={x.rol}>
                  {joinMeta([ROLE_LABELS[x.rol], `${x.kisi} kişi`, bekliyor(x) && 'bekliyor', degisen.includes(x) && 'değişti'])}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {kilitli ? (
              <p className="flex items-center gap-2 text-[13px] text-muted">
                <Lock aria-hidden="true" className="size-3.5 shrink-0" />
                Patron rolü her yetkiye sahiptir ve değiştirilemez
              </p>
            ) : (
              <p className="text-[13px] text-muted">
                <span className="font-semibold tabular-nums text-ink">
                  {liste.length} / {toplam}
                </span>{' '}
                yetki açık
              </p>
            )}
            {r.ozel && !kilitli && <Badge>Varsayılandan farklı</Badge>}
            {bekliyor(r) && <BekliyorRozeti isler={bekleyen.get(`rol:${r.rol}`)} />}
            <span className="flex-1" />
            {!kilitli && !ayni(liste, ROLE_DEFAULTS[r.rol]) && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} disabled={!!kayitNeden} onClick={() => setTaslak((t) => ({ ...t, [r.rol]: ROLE_DEFAULTS[r.rol] }))}>
                Varsayılana dön
              </Button>
            )}
          </div>
          {kayitNeden && kayitNeden !== genel && <p className={NEDEN}>{kayitNeden}</p>}
        </div>
      </Card>

      {PERMISSION_GROUPS.map((g) => (
        <section key={g.key} aria-labelledby={`yetki-${g.key}`}>
          <h3 id={`yetki-${g.key}`} className="flex items-baseline justify-between gap-3 px-1 pb-2">
            <span className={GROUP_LABEL}>{g.label}</span>
            <span className="text-xs font-medium tabular-nums text-muted">
              {g.permissions.filter((p) => liste.includes(p)).length} / {g.permissions.length}
              <span className="sr-only"> açık</span>
            </span>
          </h3>
          <ul className="divide-y divide-[var(--admin-divider)] overflow-hidden rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface shadow-[var(--card-shadow)]">
            {g.permissions.map((p) => {
              const on = liste.includes(p);
              const once = taban(r).includes(p);
              return (
                <li key={p}>
                  <label className={cn('flex min-h-12 items-center gap-3 px-4 py-2.5 text-sm', kapali ? 'cursor-default' : 'cursor-pointer hover:bg-hover')}>
                    <input type="checkbox" checked={on} disabled={kapali} onChange={() => toggle(p)} className="size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
                    <span className={cn('min-w-0 flex-1', kapali && 'text-ink-2')}>{PERMISSIONS[p]}</span>
                    {/* Kaydedilmemiş fark: seçim olağan bir karar, alarm değil */}
                    {on !== once && <Badge tone={on ? 'primary' : 'neutral'}>{on ? 'Eklenecek' : 'Kaldırılacak'}</Badge>}
                  </label>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      {degisen.length > 0 && (
        // Kaydet telefonda başparmağın altında: değişiklik varken zeminde yüzen yapışkan şerit (Roller ve yetkiler gibi)
        <div data-action-bar="" className="pointer-events-none sticky bottom-0 z-10 pb-3">
          <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-[var(--r-card)] border border-[var(--card-line)] bg-surface px-4 py-3 shadow-[var(--shadow-lift)] sm:px-5">
            <span className="flex min-w-0 flex-[1_1_12rem] items-center gap-2 text-[13px] text-ink-2">
              <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--admin-warning)]" />
              {degisen.length === 1 ? `${ROLE_LABELS[degisen[0].rol]} rolünde kaydedilmemiş değişiklik` : `${degisen.length} rolde kaydedilmemiş değişiklik`}
            </span>
            <div className="flex gap-2 max-sm:w-full max-sm:[&>*]:flex-1">
              <Button disabled={kaydediyor} onClick={() => setTaslak({})}>
                Vazgeç
              </Button>
              <Button variant="primary" loading={kaydediyor} disabled={!!kayitNeden} title={kayitNeden ?? undefined} onClick={() => void kaydet()}>
                Kaydet
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
