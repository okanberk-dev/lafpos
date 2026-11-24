import { KeyRound, Pencil } from 'lucide-react';
import { type FormEvent, useId, useMemo, useState } from 'react';
import { type KontrolDurumu, type KontrolPersonel, type UyeRolu, uyeYapabilir } from '@shared/kontrol';
import { type Role, ROLE_LABELS, ROLES } from '@shared/permissions';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Select, Toggle } from '@/components/ui/Field';
import { Modal } from '@/components/ui/Modal';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Avatar, Badge, Card, EmptyState } from '@/components/ui/misc';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useFinePointer, useTick } from '@/lib/hooks';
import { pinSifrele, SIFRELEME_YOK, sifrelemeVar } from '@/lib/kontrol';
import { joinMeta } from '@/lib/text';
import { BekliyorRozeti, FormAlti, FormHatasi, KasaGuncelDegil, NEDEN, NOT, RolRozeti, SATIR, type SekmeProps } from './ortak';
import { adHatasi, type BekleyenIs, pinGirdisi, pinHatasi, sonGirisMetni, temizAd } from './yardimci';

type Form = { tur: 'ekle' } | { tur: 'duzenle'; kisi: KontrolPersonel } | { tur: 'pin'; kisi: KontrolPersonel };

/** Etkinler önce, sonra rol sırası ve ad */
const sirala = (a: KontrolPersonel, b: KontrolPersonel) => Number(b.aktif) - Number(a.aktif) || ROLES.indexOf(a.rol) - ROLES.indexOf(b.rol) || a.ad.localeCompare(b.ad, 'tr');

/** Rol seçicisi: yönetici patron rolünü veremez (seçenek kapalı, nedeni yazılı) */
function RolSecenekleri({ uyeRol, tur }: { uyeRol: UyeRolu; tur: 'personel.ekle' | 'personel.duzenle' }) {
  return (
    <>
      {ROLES.map((r) => {
        const kapali = !uyeYapabilir(uyeRol, tur, [r]);
        return (
          <option key={r} value={r} disabled={kapali}>
            {ROLE_LABELS[r]}
            {kapali ? ' (yalnız sahip)' : ''}
          </option>
        );
      })}
    </>
  );
}

/**
 * Ekip: kasadaki personel (kasanın özetinden: ad, rol, etkin, indirim sınırı, son giriş; PIN asla). Personel ekle,
 * düzenle ve PIN değiştir kuyruğa komut koyar; kasa kendi yönetim ekranının kurallarıyla uygular (PIN tekilliği, son
 * patron korunur). Henüz kasaya ulaşmamış ekleme listenin başında "Bekliyor" satırıdır
 */
export function EkipSekmesi({ panel, durum, genel, neden, bekleyen, gonder }: SekmeProps) {
  const now = useTick(60_000);
  const [form, setForm] = useState<Form | null>(null);
  const kisiler = useMemo(() => [...(durum?.personel ?? [])].sort(sirala), [durum?.personel]);
  if (!durum) return <KasaGuncelDegil bagli={panel.kasa !== null} />;
  const yeniler = panel.bekleyen.filter((b) => b.tur === 'personel.ekle');
  const sifre = sifrelemeVar() ? null : SIFRELEME_YOK;
  const ekleNeden = neden('personel.ekle') ?? sifre;
  const etkin = kisiler.filter((k) => k.aktif).length;
  return (
    <>
      <Card
        title="Personel"
        subtitle={joinMeta([`${kisiler.length} kişi`, `${etkin} etkin`])}
        actions={
          <Button variant="primary" disabled={!!ekleNeden} title={ekleNeden ?? undefined} onClick={() => setForm({ tur: 'ekle' })}>
            Personel ekle
          </Button>
        }
      >
        {ekleNeden && ekleNeden !== genel && <p className={cn('border-b border-[var(--admin-divider)] px-5 py-2.5', NEDEN)}>Personel ekleme kapalı: {ekleNeden}</p>}
        {kisiler.length === 0 && yeniler.length === 0 ? (
          <EmptyState compact title="Kasada personel yok">
            Eklenen kişi kasaya ulaşınca burada görünür
          </EmptyState>
        ) : (
          <ul>
            {yeniler.map((b) => (
              <li key={b.id} className={cn(SATIR, 'flex flex-wrap items-center gap-x-3 gap-y-1.5')}>
                <span className="min-w-0 flex-[1_1_12rem] text-pretty text-sm">{b.ozet}</span>
                <BekliyorRozeti />
              </li>
            ))}
            {kisiler.map((k) => (
              <KisiSatiri
                key={k.id}
                kisi={k}
                now={now}
                isler={bekleyen.get(`personel:${k.id}`)}
                genel={genel}
                duzenleNeden={neden('personel.duzenle', [k.rol])}
                pinNeden={neden('personel.pin', [k.rol]) ?? sifre}
                onDuzenle={() => setForm({ tur: 'duzenle', kisi: k })}
                onPin={() => setForm({ tur: 'pin', kisi: k })}
              />
            ))}
          </ul>
        )}
      </Card>
      {form?.tur === 'ekle' && <EkleFormu uyeRol={panel.ben.rol} durum={durum} gonder={gonder} onClose={() => setForm(null)} />}
      {form?.tur === 'duzenle' && <DuzenleFormu uyeRol={panel.ben.rol} kisi={form.kisi} gonder={gonder} onClose={() => setForm(null)} />}
      {form?.tur === 'pin' && <PinFormu kisi={form.kisi} durum={durum} gonder={gonder} onClose={() => setForm(null)} />}
    </>
  );
}

function KisiSatiri({
  kisi: k,
  now,
  isler,
  genel,
  duzenleNeden,
  pinNeden,
  onDuzenle,
  onPin,
}: {
  kisi: KontrolPersonel;
  now: number;
  isler?: BekleyenIs[];
  genel: string | null;
  duzenleNeden: string | null;
  pinNeden: string | null;
  onDuzenle: () => void;
  onPin: () => void;
}) {
  // Sayfanın üstünde yazan genel neden satırda yinelenmez; yalnız bu kişiye özgü olan (patron hesabı) yazılır
  const ozel = [duzenleNeden, pinNeden].find((n) => n && n !== genel);
  return (
    <li className={cn(SATIR, 'flex flex-wrap items-center gap-x-4 gap-y-2')}>
      <div className="flex min-w-0 flex-[1_1_16rem] items-start gap-3">
        {/* Kapalı kişi: rozet durumu söyler; yalnız avatar solar, yazılar okunur kalır */}
        <Avatar name={k.ad} color={k.renk} className={k.aktif ? undefined : 'opacity-50 grayscale'} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="min-w-0 truncate font-semibold">{k.ad}</span>
            <RolRozeti rol={k.rol} />
            <Badge tone={k.aktif ? 'success' : 'neutral'} dot>
              {k.aktif ? 'Etkin' : 'Kapalı'}
            </Badge>
            {isler && <BekliyorRozeti isler={isler} />}
          </div>
          <p className="mt-0.5 text-[13px] text-muted">{joinMeta([sonGirisMetni(k.sonGiris, now), `indirim sınırı %${k.indirim}`])}</p>
          {ozel && <p className={cn('mt-0.5', NEDEN)}>{ozel}</p>}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 max-sm:pl-11">
        <Button size="sm" icon={<Pencil className="size-4" />} disabled={!!duzenleNeden} title={duzenleNeden ?? undefined} onClick={onDuzenle} aria-label={`Düzenle: ${k.ad}`}>
          Düzenle
        </Button>
        <Button size="sm" icon={<KeyRound className="size-4" />} disabled={!!pinNeden} title={pinNeden ?? undefined} onClick={onPin} aria-label={`PIN değiştir: ${k.ad}`}>
          PIN değiştir
        </Button>
      </div>
    </li>
  );
}

/**
 * PIN ve tekrarı: gizli yazılır, yalnız rakam, tarayıcı saklamaz ve önermez. Uzunluk sınırı alanda değil süzgeçte
 * (`pinGirdisi`): "48-29-15" yapıştırılınca da 482915 kalır
 */
function PinAlanlari({ pin, tekrar, setPin, setTekrar, goster, yeni }: { pin: string; tekrar: string; setPin: (v: string) => void; setTekrar: (v: string) => void; goster: boolean; yeni?: boolean }) {
  const h = pinHatasi(pin, tekrar);
  // Şifre kutusu: gizliyken rakamlar sayfaya yazılmaz, göz düğmesiyle gösterilir; parola yöneticisi karışmaz
  const ortak = { inputMode: 'numeric', pattern: '[0-9]*', autoComplete: 'off', 'data-1p-ignore': '', 'data-lpignore': 'true', wide: true, showLabel: 'PIN’i göster', hideLabel: 'PIN’i gizle' } as const;
  return (
    <>
      <Field label={yeni ? 'Yeni PIN' : 'PIN'} hint="4–6 rakam" error={goster ? h.pin : null}>
        <PasswordInput {...ortak} value={pin} onChange={(e) => setPin(pinGirdisi(e.target.value))} />
      </Field>
      <Field label={yeni ? 'Yeni PIN tekrar' : 'PIN tekrar'} error={goster ? h.tekrar : null}>
        <PasswordInput {...ortak} value={tekrar} onChange={(e) => setTekrar(pinGirdisi(e.target.value))} />
      </Field>
    </>
  );
}

const PIN_NOTU = 'PIN bu tarayıcıda kasanın anahtarıyla şifrelenir; bulut yalnız şifreli hâlini taşır, açık PIN hiçbir yere yazılmaz';

function EkleFormu({ uyeRol, durum, gonder, onClose }: { uyeRol: UyeRolu; durum: KontrolDurumu; gonder: SekmeProps['gonder']; onClose: () => void }) {
  const fine = useFinePointer();
  const formId = useId();
  const [ad, setAd] = useState('');
  const [rol, setRol] = useState<Role>('garson');
  const [indirim, setIndirim] = useState(10);
  const [pin, setPin] = useState('');
  const [tekrar, setTekrar] = useState('');
  const [denendi, setDenendi] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bekle, setBekle] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bekle) return;
    const ph = pinHatasi(pin, tekrar);
    if (adHatasi(ad) || ph.pin || ph.tekrar) return setDenendi(true);
    setBekle(true);
    setHata(null);
    try {
      await gonder({ tur: 'personel.ekle', veri: { ad: temizAd(ad), rol, indirim, pin: await pinSifrele(pin, durum.anahtar) } });
      onClose();
    } catch (err) {
      setHata(errorMessage(err));
    } finally {
      // Açık PIN gönderimden sonra formda kalmaz (başarısızsa yeniden yazılır)
      setPin('');
      setTekrar('');
      setDenendi(false);
      setBekle(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Personel ekle" subtitle="Kişi kasada bu PIN’le girer" footer={<FormAlti formId={formId} bekle={bekle} etiket="Personel ekle" onClose={onClose} />}>
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="px-5 py-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ad" required error={denendi ? adHatasi(ad) : null} className="sm:col-span-2">
            <Input value={ad} maxLength={40} autoCapitalize="words" autoFocus={fine} onChange={(e) => setAd(e.target.value)} />
          </Field>
          <Field label="Rol">
            <Select value={rol} onChange={(e) => setRol(e.target.value as Role)}>
              <RolSecenekleri uyeRol={uyeRol} tur="personel.ekle" />
            </Select>
          </Field>
          <Field label="İndirim sınırı (%)" hint="üstü onay ister">
            <NumberInput value={indirim} min={0} max={100} fallback={0} commitOnChange onCommit={setIndirim} />
          </Field>
          <PinAlanlari pin={pin} tekrar={tekrar} setPin={setPin} setTekrar={setTekrar} goster={denendi} />
          <p className={cn('sm:col-span-2', NOT)}>{PIN_NOTU}</p>
        </div>
        <FormHatasi hata={hata} />
      </form>
    </Modal>
  );
}

function DuzenleFormu({ uyeRol, kisi, gonder, onClose }: { uyeRol: UyeRolu; kisi: KontrolPersonel; gonder: SekmeProps['gonder']; onClose: () => void }) {
  const formId = useId();
  const [ad, setAd] = useState(kisi.ad);
  const [rol, setRol] = useState<Role>(kisi.rol);
  const [aktif, setAktif] = useState(kisi.aktif);
  const [indirim, setIndirim] = useState(kisi.indirim);
  const [denendi, setDenendi] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bekle, setBekle] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bekle) return;
    if (adHatasi(ad)) return setDenendi(true);
    const yeniAd = temizAd(ad);
    // Yalnız değişen alanlar gider: kasa geri kalanına dokunmaz
    const veri = {
      id: kisi.id,
      ...(yeniAd !== kisi.ad ? { ad: yeniAd } : {}),
      ...(rol !== kisi.rol ? { rol } : {}),
      ...(aktif !== kisi.aktif ? { aktif } : {}),
      ...(indirim !== kisi.indirim ? { indirim } : {}),
    };
    if (Object.keys(veri).length === 1) return setHata('Değişiklik yok');
    if (!uyeYapabilir(uyeRol, 'personel.duzenle', [kisi.rol, rol])) return setHata('Patron hesabına yalnız sahip dokunur');
    setBekle(true);
    setHata(null);
    try {
      await gonder({ tur: 'personel.duzenle', veri });
      onClose();
    } catch (err) {
      setHata(errorMessage(err));
    } finally {
      setBekle(false);
    }
  };
  return (
    <Modal open onClose={onClose} title={kisi.ad} subtitle={`${ROLE_LABELS[kisi.rol]} · ${kisi.aktif ? 'etkin' : 'kapalı'}`} footer={<FormAlti formId={formId} bekle={bekle} etiket="Değişikliği gönder" onClose={onClose} />}>
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="px-5 py-4 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Ad" required error={denendi ? adHatasi(ad) : null} className="sm:col-span-2">
            <Input value={ad} maxLength={40} autoCapitalize="words" onChange={(e) => setAd(e.target.value)} />
          </Field>
          <Field label="Rol">
            <Select value={rol} onChange={(e) => setRol(e.target.value as Role)}>
              <RolSecenekleri uyeRol={uyeRol} tur="personel.duzenle" />
            </Select>
          </Field>
          <Field label="İndirim sınırı (%)" hint="üstü onay ister">
            <NumberInput value={indirim} min={0} max={100} fallback={0} commitOnChange onCommit={setIndirim} />
          </Field>
          <div className="sm:col-span-2">
            <Toggle block checked={aktif} onChange={setAktif} label="Etkin" hint="Kapalı hesap kasaya giremez; geçmiş adisyonlarında adı kalır" />
          </div>
        </div>
        <FormHatasi hata={hata} />
      </form>
    </Modal>
  );
}

function PinFormu({ kisi, durum, gonder, onClose }: { kisi: KontrolPersonel; durum: KontrolDurumu; gonder: SekmeProps['gonder']; onClose: () => void }) {
  const formId = useId();
  const [pin, setPin] = useState('');
  const [tekrar, setTekrar] = useState('');
  const [denendi, setDenendi] = useState(false);
  const [hata, setHata] = useState<string | null>(null);
  const [bekle, setBekle] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (bekle) return;
    const ph = pinHatasi(pin, tekrar);
    if (ph.pin || ph.tekrar) return setDenendi(true);
    setBekle(true);
    setHata(null);
    try {
      await gonder({ tur: 'personel.pin', veri: { id: kisi.id, pin: await pinSifrele(pin, durum.anahtar) } });
      onClose();
    } catch (err) {
      setHata(errorMessage(err));
    } finally {
      setPin('');
      setTekrar('');
      setDenendi(false);
      setBekle(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="PIN değiştir" subtitle={`${kisi.ad} kasaya yeni PIN’le girer`} size="sm" footer={<FormAlti formId={formId} bekle={bekle} etiket="PIN’i değiştir" onClose={onClose} />}>
      <form id={formId} onSubmit={(e) => void submit(e)} noValidate className="px-5 py-4 sm:px-6">
        <div className="grid gap-4">
          <PinAlanlari pin={pin} tekrar={tekrar} setPin={setPin} setTekrar={setTekrar} goster={denendi} yeni />
          <p className={NOT}>{PIN_NOTU}</p>
        </div>
        <FormHatasi hata={hata} />
      </form>
    </Modal>
  );
}
