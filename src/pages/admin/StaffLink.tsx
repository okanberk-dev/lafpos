import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Link2, RefreshCw, Unlink } from 'lucide-react';
import { useMemo, useState } from 'react';
import { nameMatch, type NameMatch, nameSimilarity } from '@shared/name-match';
import { type Role, ROLE_LABELS } from '@shared/permissions';
import { Badge } from '@/components/admin/ui';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { ErrorState, Notice } from '@/components/ui/misc';
import { errorMessage, get, patch } from '@/lib/api';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

/** GET /admin/ladmin-personel (docs/03-ENTEGRASYON.md §4.8) */
interface LadminStaff {
  ref: string;
  name: string;
  active: boolean;
  /** Kayda bağlı lafmaliyet giriş hesabı (görünen adı) */
  account: string | null;
  /** Bu kayda bağlı LafPOS kullanıcısı */
  linkedUserId: string | null;
}
interface LadminStaffList {
  at: number;
  sube: string;
  items: LadminStaff[];
  missing: { userId: string; staffRef: string }[];
}

const MATCH_TEXT: Record<NameMatch, string> = { yuksek: 'Ad uyuyor', orta: 'Ad kısmen uyuyor', dusuk: 'Ad benzemiyor' };
const SECTION_TITLE = 'text-base font-semibold leading-6 tracking-[-0.015em] text-[var(--admin-text)]';
const branchName = (sube: string) => sube.charAt(0).toLocaleUpperCase('tr-TR') + sube.slice(1);
/** "hesap: ayse@… / Marina" */
const accountText = (s: Pick<LadminStaff, 'account'>, sube: string) => `${s.account ? `hesap: ${s.account}` : 'giriş hesabı yok'} · ${branchName(sube)}`;

/**
 * Yönetim › Personel › kişi › "lafmaliyet personeli": kişiyi lafmaliyet'in (ladmin) personel kaydına bağlar; yemek kartı
 * ve çalıştığı günler lafmaliyet'e yalnız bu kayıt numarasıyla gider, ad gitmez. Sahibin kararı (23 Kas 2026): doğru
 * hesap bağlanmalı. Bu yüzden hiçbir aday önceden seçili gelmez (aynı ad iki kişide olabilir), ad benzerliği yalnız
 * sıralama ve ipucudur, bağlamadan önce iki taraf yan yana onaylanır; ad benzemiyorsa ya da aynı ada uyan birden çok
 * kayıt varsa ayrıca "Eminim" işaretlenir. Liste yalnız bu bölüm açılınca çekilir (5 dakika önbellek)
 */
export function StaffLinkSection({ user, configured, names }: { user: { id: string; name: string; role: Role; staffRef: string | null }; configured: boolean; names: Map<string, string> }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['admin', 'ladmin-personel'],
    queryFn: () => get<LadminStaffList>('/admin/ladmin-personel'),
    enabled: configured,
    staleTime: 60_000,
    retry: false,
  });
  const [picking, setPicking] = useState(!user.staffRef);
  const [chosen, setChosen] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const refreshUsers = () => {
    void qc.invalidateQueries({ queryKey: ['users'] });
    void qc.invalidateQueries({ queryKey: ['admin', 'ladmin-personel'] });
  };
  const linked = list.data?.items.find((i) => i.ref === user.staffRef) ?? null;
  // Aday sırası: ad benzerliği, sonra etkin olan, sonra ad. Seçim kullanıcının: hiçbiri önceden işaretli değil
  const candidates = useMemo(
    () =>
      (list.data?.items ?? [])
        .map((i) => ({ ...i, score: nameSimilarity(user.name, i.name), match: nameMatch(user.name, i.name) }))
        .sort((a, b) => b.score - a.score || Number(b.active) - Number(a.active) || a.name.localeCompare(b.name, 'tr')),
    [list.data, user.name],
  );
  const pick = candidates.find((c) => c.ref === chosen) ?? null;
  const strongMatches = candidates.filter((c) => c.match === 'yuksek' && c.active && (!c.linkedUserId || c.linkedUserId === user.id)).length;

  const refresh = async () => {
    setRefreshing(true);
    try {
      qc.setQueryData(['admin', 'ladmin-personel'], await get<LadminStaffList>('/admin/ladmin-personel?yenile=1'));
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setRefreshing(false);
    }
  };
  const save = async (staffRef: string | null) => {
    setBusy(true);
    try {
      await patch(`/admin/users/${user.id}`, { staffRef });
      toast.ok(staffRef ? `${user.name} lafmaliyet personeline bağlandı` : `${user.name} için lafmaliyet bağlantısı kaldırıldı`);
      setConfirming(false);
      setChosen(null);
      setPicking(!staffRef);
      refreshUsers();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="kisi-ladmin" className="mt-6 border-t border-[var(--admin-divider)] pt-5">
      <h3 id="kisi-ladmin" className={SECTION_TITLE}>
        lafmaliyet personeli
      </h3>
      <p className="mt-1 text-[13px] text-[var(--admin-text-mute)]">Yemek kartı ve çalıştığı günler için ladmin’deki personel kaydı. lafmaliyet’e yalnız kayıt numarası gider, ad gitmez</p>

      {user.staffRef && (
        // Bağlı kayıt: ad ve hesap tam okunur (dar ekranda kesilmez), eylemler altta
        <div className="mt-3 rounded-[var(--r-tile)] border border-[var(--admin-border)] px-3 py-2.5 text-sm">
          <div className="flex items-start gap-3">
            <Link2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[var(--admin-text-mute)]" />
            <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
              <span className="block font-medium">{linked ? linked.name : `Kayıt ${user.staffRef}`}</span>
              <span className="block text-xs text-[var(--admin-text-mute)]">{linked && list.data ? `${accountText(linked, list.data.sube)} · ${user.staffRef}` : user.staffRef}</span>
            </span>
            {list.data && !linked && <Badge tone="warning">ladmin’de bulunamadı</Badge>}
            {linked && !linked.active && <Badge tone="warning">ladmin’de pasif</Badge>}
          </div>
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            {configured && !picking && (
              <Button size="sm" icon={<ArrowLeftRight className="size-4" />} onClick={() => setPicking(true)}>
                Değiştir
              </Button>
            )}
            {/* Kaldırmak internetsiz de olur (lafmaliyet'e sorulmaz) */}
            <Button size="sm" variant="dangerOutline" icon={<Unlink className="size-4" />} loading={busy && !confirming} onClick={() => void save(null)}>
              Bağlantıyı kaldır
            </Button>
          </div>
        </div>
      )}
      {user.staffRef && list.data && !linked && (
        <p className="mt-2 text-[13px] text-[var(--admin-text-mute)]">Kayıt lafmaliyet’te silinmiş ya da başka şubeye taşınmış olabilir: lafmaliyet bu kişinin günlerini saymaz. Bağlantıyı kaldırıp doğru kayda yeniden bağlayın</p>
      )}

      {!configured ? (
        <Notice tone="info" className="mt-3">
          lafmaliyet bağlantısı tanımlı değil (Yönetim › Bağlantı bilgileri): kişi bağlantı kurulunca bağlanır
        </Notice>
      ) : (
        picking && (
          <div className="mt-3 space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[13px] font-medium text-[var(--admin-text-soft)]">{list.data ? `${branchName(list.data.sube)} personeli: ${user.name} hangisi?` : 'ladmin personeli'}</p>
              <Button size="sm" variant="ghost" icon={<RefreshCw className="size-4" />} loading={refreshing} onClick={() => void refresh()}>
                Listeyi yenile
              </Button>
            </div>
            {list.isPending ? (
              <p className="text-sm text-[var(--admin-text-mute)]">ladmin personel listesi alınıyor…</p>
            ) : list.isError ? (
              <ErrorState compact title="ladmin personel listesi alınamadı" error={list.error} retrying={list.isFetching} onRetry={() => void list.refetch()} />
            ) : candidates.length === 0 ? (
              <Notice tone="info">ladmin’de bu şubenin personeli yok. Kayıtlar ladmin Maaşlar’da şubesiyle eklenince burada görünür</Notice>
            ) : (
              <div role="radiogroup" aria-label={`${user.name} için ladmin personeli`} className="divide-y divide-[var(--admin-divider)] overflow-hidden rounded-[var(--r-tile)] border border-[var(--admin-border)]">
                {candidates.map((c) => {
                  const takenBy = c.linkedUserId && c.linkedUserId !== user.id ? (names.get(c.linkedUserId) ?? 'başka bir kişi') : null;
                  const current = c.ref === user.staffRef;
                  const disabled = !c.active || !!takenBy || current;
                  return (
                    <button
                      key={c.ref}
                      type="button"
                      role="radio"
                      aria-checked={chosen === c.ref}
                      disabled={disabled}
                      onClick={() => setChosen(c.ref)}
                      className={cn(
                        'flex min-h-11 w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors',
                        disabled ? 'cursor-not-allowed bg-[var(--admin-surface-2)] text-[var(--admin-text-soft)]' : 'hover:bg-hover',
                        chosen === c.ref && 'bg-[var(--admin-primary-soft)]',
                      )}
                    >
                      <span aria-hidden="true" className={cn('grid size-4 shrink-0 place-items-center rounded-full border', chosen === c.ref ? 'border-[var(--admin-primary)]' : 'border-[var(--admin-border-strong)]')}>
                        {chosen === c.ref && <span className="size-2 rounded-full bg-[var(--admin-primary)]" />}
                      </span>
                      {/* Ad ve hesap kesilmez (doğru kişiyi seçmek için tamamı okunmalı): dar ekranda alt satıra iner */}
                      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
                        <span className="block font-medium">{c.name}</span>
                        <span className="block text-xs text-[var(--admin-text-mute)]">{list.data ? accountText(c, list.data.sube) : ''}</span>
                      </span>
                      {current ? (
                        <Badge>Şu an bağlı</Badge>
                      ) : !c.active ? (
                        <Badge>ladmin’de pasif</Badge>
                      ) : takenBy ? (
                        <Badge>Bağlı: {takenBy}</Badge>
                      ) : (
                        <Badge tone={c.match === 'yuksek' ? 'success' : c.match === 'orta' ? 'neutral' : 'warning'}>{MATCH_TEXT[c.match]}</Badge>
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              {user.staffRef && (
                <Button
                  size="sm"
                  onClick={() => {
                    setPicking(false);
                    setChosen(null);
                  }}
                >
                  Vazgeç
                </Button>
              )}
              <Button size="sm" variant="primary" icon={<Link2 className="size-4" />} disabled={!pick} onClick={() => setConfirming(true)}>
                {pick ? 'Bağla…' : 'Kişi seçin'}
              </Button>
            </div>
          </div>
        )
      )}

      {confirming && pick && list.data && (
        <ConfirmLink
          lafpos={`${user.name} · ${ROLE_LABELS[user.role]}`}
          ladmin={`${pick.name} · ${accountText(pick, list.data.sube)}`}
          refText={pick.ref}
          // Ad benzemiyorsa ya da aynı ada uyan birden çok etkin kayıt varsa ayrıca "Eminim" istenir
          needsSure={pick.match !== 'yuksek' || strongMatches > 1}
          why={pick.match !== 'yuksek' ? MATCH_TEXT[pick.match] : 'Bu ada uyan birden çok kayıt var: soyadına ve hesabına bakın'}
          busy={busy}
          onClose={() => setConfirming(false)}
          onConfirm={() => void save(pick.ref)}
          sureName={pick.name}
        />
      )}
    </section>
  );
}

function ConfirmLink({
  lafpos,
  ladmin,
  refText,
  needsSure,
  why,
  sureName,
  busy,
  onClose,
  onConfirm,
}: {
  lafpos: string;
  ladmin: string;
  refText: string;
  needsSure: boolean;
  why: string;
  sureName: string;
  busy: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const [sure, setSure] = useState(false);
  return (
    <Modal
      open
      onClose={onClose}
      size="md"
      hideClose
      title="Bu iki kayıt aynı kişi mi?"
      subtitle="Yemek kartı ve çalıştığı günler bu kayda yazılır"
      footer={
        <>
          <div className="flex-1" />
          <Button onClick={onClose}>Vazgeç</Button>
          <Button variant="primary" icon={<Link2 className="size-4" />} loading={busy} disabled={needsSure && !sure} onClick={onConfirm}>
            Bağla
          </Button>
        </>
      }
    >
      <div className="space-y-3 p-4">
        <dl className="grid gap-2 text-sm">
          <div className="rounded-[var(--r-tile)] border border-[var(--admin-border)] px-3 py-2.5">
            <dt className="text-xs text-[var(--admin-text-mute)]">LafPOS</dt>
            <dd className="font-medium">{lafpos}</dd>
          </div>
          <div className="rounded-[var(--r-tile)] border border-[var(--admin-border)] px-3 py-2.5">
            <dt className="text-xs text-[var(--admin-text-mute)]">ladmin ({refText})</dt>
            <dd className="font-medium">{ladmin}</dd>
          </div>
        </dl>
        {needsSure && (
          <>
            <Notice tone="warn">{why}. Yanlış kişiye bağlanırsa yemek kartı ve günler başkasına yazılır</Notice>
            <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded-[var(--r-tile)] border border-[var(--admin-border)] px-3 py-2 text-sm">
              <input type="checkbox" checked={sure} onChange={(e) => setSure(e.target.checked)} className="size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
              <span>Eminim: bu kişi ladmin’deki {sureName}</span>
            </label>
          </>
        )}
      </div>
    </Modal>
  );
}
