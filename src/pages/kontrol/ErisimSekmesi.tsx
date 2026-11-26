import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Lock, UserMinus } from 'lucide-react';
import { type FormEvent, useId, useState } from 'react';
import { DAVET_ROLLERI, type DavetRolu, type DavetYaniti, type KontrolPaneli, UYE_ROL_ACIKLAMA, UYE_ROL_ETIKET, type UzaktanUye } from '@shared/kontrol';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, Select } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { Badge, Card, EmptyState, ErrorState, ListSkeleton, Notice } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useFinePointer } from '@/lib/hooks';
import { kontrolAnahtari, uyeDavetEt, uyeKaldir, uyelerSorgusu, uyeRolDegistir } from '@/lib/kontrol';
import { toast } from '@/lib/toast';
import { FormAlti, FormHatasi, NEDEN, NOT, SATIR } from './ortak';
import { ALAN_ADI } from '@shared/eski-adlar';

const EPOSTA_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** Giriş ekranındaki düğmenin adıyla (RemoteLoginPage: "Davet kodum var") */
const DAVET_NOTU = `Kod 7 gün geçerli; kişi ${ALAN_ADI}’te Üye girişi › Davet kodum var ile kodu ve kendi parolasını girer`;
/** Üyelik kapalı (parolalı giriş): kişi eklenemez, bulut 409 der */
const UYELIK_KAPALI = 'Kişi eklemek için önce üye girişi açılmalı';

/**
 * Erişim (yalnız sahip): internetteki panele kim girer. Sahip e-posta ve rol (Yönetici ya da Yalnız görür) seçer; kişiye
 * bir kez görünen davet kodu verilir. Kasadaki Patron paneli yetkisinden ayrıdır: o, kasadaki ekranı açar. Ortamda
 * (Vercel) tanımlı sahip kilitlidir: panelden değiştirilmez, kaldırılmaz
 */
export function ErisimSekmesi({ panel }: { panel: KontrolPaneli }) {
  const qc = useQueryClient();
  const q = useQuery(uyelerSorgusu);
  // Pencere: yeni kişi ya da davet bekleyen kişiye yeni kod (önceki kod geçersiz olur)
  const [ekle, setEkle] = useState<{ eposta: string; rol: DavetRolu } | null>(null);
  const [mesgul, setMesgul] = useState<string | null>(null);
  // Parolalı girişte (e-postasız oturum) üyelik kapalıdır: davet edilen kişi giremez
  const uyelikKapali = !panel.demo && panel.ben.eposta == null;
  const kapali = panel.demo ? 'Örnek görünüm: işlem gönderilmez' : uyelikKapali ? UYELIK_KAPALI : null;
  const uyeler = [...(q.data?.uyeler ?? [])].sort((a, b) => Number(b.sabit) - Number(a.sabit) || a.eposta.localeCompare(b.eposta, 'tr'));

  const yenile = () => void qc.invalidateQueries({ queryKey: kontrolAnahtari.uyeler });
  const rolDegistir = async (u: UzaktanUye, rol: DavetRolu) => {
    if (rol === u.rol) return;
    setMesgul(u.eposta);
    try {
      await uyeRolDegistir(u.eposta, rol);
      toast.ok(`${u.eposta}: ${UYE_ROL_ETIKET[rol]}`);
      yenile();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setMesgul(null);
    }
  };
  const kaldir = async (u: UzaktanUye) => {
    const ok = await confirmDialog({
      title: `${u.eposta} panelden kaldırılsın mı`,
      body: u.durum === 'davet' ? 'Davet kodu geçersiz olur' : 'Oturumu en geç bir dakikada kapanır; yeniden girmesi için yeni davet gerekir',
      confirmLabel: 'Kaldır',
    });
    if (!ok) return;
    setMesgul(u.eposta);
    try {
      await uyeKaldir(u.eposta);
      toast.ok(`${u.eposta} panelden kaldırıldı`);
      yenile();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setMesgul(null);
    }
  };

  return (
    <>
      {uyelikKapali ? (
        <Notice tone="warn" role="note" title={UYELIK_KAPALI}>
          Şu an panele parolayla giriliyor. Kurulumda sahip e-postası tanımlanınca üye girişi açılır; sonra buradan kişi eklenir ve herkes kendi e-postası ve parolasıyla girer
        </Notice>
      ) : (
        <Notice tone="info" role="note">
          Bu liste internetteki paneli kimin göreceğini belirler; kasadaki Patron paneli yetkisinden ayrıdır
        </Notice>
      )}
      <Card
        title="Panel erişimi"
        subtitle={q.data ? `${uyeler.length} kişi` : undefined}
        actions={
          <Button variant="primary" disabled={!!kapali} title={kapali ?? undefined} onClick={() => setEkle({ eposta: '', rol: 'yonetici' })}>
            Kişi ekle
          </Button>
        }
      >
        {q.isPending ? (
          <ListSkeleton rows={3} />
        ) : q.isError && !q.data ? (
          <ErrorState compact title="Liste alınamadı" error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : uyeler.length === 0 ? (
          <EmptyState compact title="Panele eklenen kişi yok">
            {uyelikKapali ? 'Üye girişi açılınca buradan kişi eklenir' : 'Kişi ekle ile e-posta ve rol seçin; kişiye bir kez görünen davet kodu verilir'}
          </EmptyState>
        ) : (
          <ul>
            {uyeler.map((u) => (
              <UyeSatiri
                key={u.eposta}
                uye={u}
                ben={panel.ben.eposta}
                kapali={kapali}
                mesgul={mesgul === u.eposta}
                onRol={(r) => void rolDegistir(u, r)}
                onKaldir={() => void kaldir(u)}
                onYeniKod={() => setEkle({ eposta: u.eposta, rol: u.rol === 'izleyici' ? 'izleyici' : 'yonetici' })}
              />
            ))}
          </ul>
        )}
      </Card>
      {ekle && <DavetFormu ilk={ekle} onClose={() => setEkle(null)} onDavet={yenile} />}
    </>
  );
}

function UyeSatiri({
  uye: u,
  ben,
  kapali,
  mesgul,
  onRol,
  onKaldir,
  onYeniKod,
}: {
  uye: UzaktanUye;
  ben: string | null;
  kapali: string | null;
  mesgul: boolean;
  onRol: (r: DavetRolu) => void;
  onKaldir: () => void;
  onYeniKod: () => void;
}) {
  // E-posta Türkçe kurala göre küçültülmez (I → ı olurdu)
  const kendisi = !!ben && ben.toLowerCase() === u.eposta.toLowerCase();
  const durum = u.durum === 'davet' ? (u.davetBitis ? `Davet bekliyor · son gün ${fmtDateTime(u.davetBitis)}` : 'Davet bekliyor') : 'Etkin';
  return (
    <li className={cn(SATIR, 'flex flex-wrap items-center gap-x-4 gap-y-2')}>
      <div className="min-w-0 flex-[1_1_14rem]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 font-semibold [overflow-wrap:anywhere]">{u.eposta}</span>
          {kendisi && <Badge tone="primary">Siz</Badge>}
          {u.sabit && (
            <Badge>
              <Lock aria-hidden="true" className="size-3" />
              {UYE_ROL_ETIKET[u.rol]}
            </Badge>
          )}
        </div>
        <p className="mt-0.5 text-[13px] text-muted">{durum}</p>
        {u.sabit && <p className={cn('mt-0.5', NEDEN)}>Sahip LafPOS’un sunucu ayarında tanımlı; buradan değiştirilmez</p>}
      </div>
      {!u.sabit && (
        <div className="flex flex-wrap items-center gap-2 max-sm:w-full">
          <label className="min-w-0 max-sm:flex-1">
            <span className="sr-only">{u.eposta} rolü</span>
            <Select value={u.rol} disabled={!!kapali || mesgul} title={kapali ?? undefined} onChange={(e) => onRol(e.target.value as DavetRolu)} className="min-w-36">
              {DAVET_ROLLERI.map((r) => (
                <option key={r} value={r}>
                  {UYE_ROL_ETIKET[r]}
                </option>
              ))}
            </Select>
          </label>
          {/* Kod bir kez görünür: kaybolduysa yeni kod (öncekinin yerine geçer) */}
          {u.durum === 'davet' && (
            <Button size="sm" icon={<KeyRound className="size-4" />} disabled={!!kapali || mesgul} title={kapali ?? undefined} onClick={onYeniKod} aria-label={`Yeni davet kodu: ${u.eposta}`}>
              Yeni kod
            </Button>
          )}
          <Button size="sm" variant="dangerOutline" icon={<UserMinus className="size-4" />} disabled={!!kapali || mesgul} title={kapali ?? undefined} onClick={onKaldir} aria-label={`Kaldır: ${u.eposta}`}>
            Kaldır
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * Kişi ekle (ya da davet bekleyene yeni kod): e-posta ve rol; yanıttaki davet kodu bu pencerede bir kez görünür, pencere
 * kapanınca unutulur. İstek sürerken pencere kapanmaz: kapansaydı davet oluşur, kod kimseye görünmezdi
 */
function DavetFormu({ ilk, onClose, onDavet }: { ilk: { eposta: string; rol: DavetRolu }; onClose: () => void; onDavet: () => void }) {
  const fine = useFinePointer();
  const formId = useId();
  const [eposta, setEposta] = useState(ilk.eposta);
  const [rol, setRol] = useState<DavetRolu>(ilk.rol);
  const yeniKod = !!ilk.eposta;
  const [denendi, setDenendi] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bekle, setBekle] = useState(false);
  const [davet, setDavet] = useState<(DavetYaniti & { eposta: string }) | null>(null);
  const temiz = eposta.trim().toLowerCase();
  const epostaHata = !temiz ? 'E-posta gerekli' : EPOSTA_RE.test(temiz) ? null : 'E-posta adresi anlaşılamadı';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bekle) return;
    if (epostaHata) return setDenendi(true);
    setBekle(true);
    setHata(null);
    try {
      const r = await uyeDavetEt(temiz, rol);
      setDavet({ ...r, eposta: temiz });
      onDavet();
    } catch (err) {
      setHata(errorMessage(err));
    } finally {
      setBekle(false);
    }
  };
  const kopyala = async (kod: string) => {
    try {
      await navigator.clipboard.writeText(kod);
      toast.ok('Kod kopyalandı');
    } catch {
      toast.err('Kopyalanamadı; kodu elle yazın');
    }
  };

  if (davet)
    return (
      // Kod yalnız burada görünür: arka plana dokunmak pencereyi kapatıp kodu kaybettirmesin
      <Modal
        open
        persistent
        onClose={onClose}
        title="Davet kodu"
        subtitle={`${davet.eposta} · ${UYE_ROL_ETIKET[rol]}`}
        size="sm"
        footer={
          <div className="flex justify-end">
            <Button variant="primary" onClick={onClose} className="max-sm:w-full">
              Tamam
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 px-5 py-4 sm:px-6">
          <p className="text-sm text-ink-2">Kod bir kez görünür; pencere kapanınca yeniden gösterilmez. Kişiye iletin:</p>
          <div className="flex flex-wrap items-center gap-3 rounded-[var(--r-tile)] border border-[var(--admin-border)] bg-surface-2 px-4 py-3">
            <code className="min-w-0 flex-1 select-all font-mono text-xl font-semibold tracking-[0.06em] text-ink [overflow-wrap:anywhere]">{davet.kod}</code>
            <Button size="sm" icon={<Copy className="size-4" />} onClick={() => void kopyala(davet.kod)}>
              Kopyala
            </Button>
          </div>
          <p className={NOT}>
            {DAVET_NOTU}. Son gün {fmtDateTime(davet.bitis)}
          </p>
        </div>
      </Modal>
    );

  return (
    <Modal
      open
      persistent={bekle}
      hideClose={bekle}
      onClose={onClose}
      title={yeniKod ? 'Yeni davet kodu' : 'Kişi ekle'}
      subtitle={yeniKod ? 'Önceki kod geçersiz olur' : 'Panele girecek kişinin e-postası ve rolü'}
      footer={<FormAlti formId={formId} bekle={bekle} kilitli={bekle} etiket="Davet kodu oluştur" onClose={onClose} />}
    >
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="px-5 py-4 sm:px-6">
        <div className="grid gap-4">
          <Field label="E-posta" required error={denendi ? epostaHata : null}>
            <Input type="email" inputMode="email" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={120} value={eposta} readOnly={yeniKod} autoFocus={fine && !yeniKod} onChange={(e) => setEposta(e.target.value)} />
          </Field>
          <fieldset className="grid gap-2">
            <legend className="mb-1.5 text-[13px] font-semibold text-ink">Rol</legend>
            {DAVET_ROLLERI.map((r) => (
              <label
                key={r}
                className={cn(
                  'flex min-h-11 cursor-pointer items-start gap-3 rounded-[var(--r-tile)] border px-4 py-3 transition-colors duration-150',
                  rol === r ? 'k-picked' : 'border-[var(--admin-border)] hover:border-[var(--admin-border-strong)]',
                )}
              >
                <input type="radio" name="davet-rol" value={r} checked={rol === r} onChange={() => setRol(r)} className="mt-0.5 size-5 shrink-0 accent-[var(--admin-primary)] pointer-fine:size-4" />
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-ink">{UYE_ROL_ETIKET[r]}</span>
                  <span className="mt-0.5 block text-pretty text-[13px] leading-5 text-muted">{UYE_ROL_ACIKLAMA[r]}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <p className={NOT}>{DAVET_NOTU}</p>
        </div>
        <FormHatasi hata={hata} />
      </form>
    </Modal>
  );
}
