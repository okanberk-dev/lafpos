import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Armchair, BellRing, Check, DatabaseBackup, FolderOpen, HandPlatter, HardDrive, Loader2, Lock, type LucideIcon, QrCode, Save } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { parseTL, tlCompact } from '@shared/money';
import { SERVICE_MODE_HINT, SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode, serviceModeOf } from '@shared/service-mode';
import { fmtDateTime } from '@shared/time';
import { nextZNo, zStartPlaceholder } from '@shared/z-no';
import { Button } from '@/components/ui/Button';
import { confirmDialog } from '@/components/ui/Confirm';
import { Field, Input, NumberInput, Segmented, Select, Textarea, Toggle } from '@/components/ui/Field';
import { ErrorState, ListSkeleton, Notice, Skeleton } from '@/components/ui/misc';
import { Badge, Card, CARD, CODE, EmptyState, IconBox, PageHeader } from '@/components/admin/ui';
import { DenemeCard } from '@/components/admin/DenemeCard';
import { branchSlug } from '@shared/baglanti';
import { CloudBackupCard } from '@/components/admin/CloudBackupCard';
import { UpdateCard } from '@/components/admin/UpdateCard';
import { PrinterCard } from '@/components/admin/PrinterCard';
import { ApiError, errorMessage, get, post, put } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { draftConflicts, fromLines, rebaseDraft } from '@/lib/settingsDraft';
import { toast } from '@/lib/toast';
import { REMOTE } from '@/lib/remote';
import { useUnsavedGuard } from '@/lib/unsavedGuard';

type Settings = Record<string, unknown> & {
  businessName: string;
  businessAddress: string;
  businessPhone: string;
  receiptHeader: string;
  receiptFooter: string;
  receiptCustomerName: boolean;
  serviceRate: number;
  autoLockMinutes: number;
  keepAwake: boolean;
  productImages: boolean;
  askOptions: 'zorunlu' | 'hep';
  voidReasons: string[];
  compReasons: string[];
  odenmezReasons: string[];
  zayiReasons: string[];
  discountReasons: string[];
  discountPresetPct: number;
  quickCash: number[];
  sizeLabels: { M: string; L: string };
  requireDayOpen: boolean;
  barEnabled: boolean;
  kitchenWarnMinutes: number;
  kitchenAlarmMinutes: number;
  roomBillingStepMinutes: number;
  roomMinimumMinutes: number;
  stampGoal: number;
  demoMode: boolean;
  alertDiscountPct: number;
  alertCashDiffKurus: number;
  backupKeep: number;
  autoDayEnd: boolean;
  autoDayEndHour: number;
  posSizeSuffix: { M: string; L: string; TEK: string };
  serviceMode: ServiceMode;
  zNoStart: number | null;
  branchId: string;
};

const lines = (a: string[]) => a.join('\n');
/** Kaydedilmemiş değişiklik karşılaştırması: servis modu seçilince kendisi kaydedilir, sayılmaz */
// Servis modu ve müşteri ekranı kendi ekranlarında kaydedilir: bu taslağın değişikliği sayılmaz, kayıtla gitmez
const comparable = (x: Settings) => JSON.stringify({ ...x, serviceMode: null, customerDisplay: null });

/**
 * Tutar alanı (₺): yazarken serbest ("12," yazılabilir), alandan çıkınca kuruşa çevrilip biçimlenir. Her tuşta
 * kuruşa çevirip geri yazmak virgülü siliyordu; geçerli tutar yine her tuşta forma geçer (taslak olduğu gibi kalır),
 * yoksa "değişiklik var"a bağlı Kaydet ilk dokunuşta yalnız alanı bırakırdı
 */
function TlInput({ value, onCommit, ...rest }: { value: number; onCommit: (kurus: number) => void } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [draft, setDraft] = useState(tlCompact(value));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(tlCompact(value));
  }, [value]);
  const commit = () => {
    const k = parseTL(draft || '0');
    const next = k == null || k < 0 ? value : k;
    setDraft(tlCompact(next));
    if (next !== value) onCommit(next);
  };
  const change = (text: string) => {
    setDraft(text);
    const k = text.trim() === '' ? null : parseTL(text);
    if (k != null && k >= 0 && k !== value) onCommit(k);
  };
  return (
    <Input
      {...rest}
      value={draft}
      inputMode="decimal"
      onChange={(e) => change(e.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
      }}
      className="tabular text-right"
    />
  );
}

/**
 * Satır satır liste alanı (nedenler, hızlı nakit): metin kendi taslağında durur, her tuşta ayrıştırılan liste forma
 * geçer (Kaydet ilk tuşta etkin). Ayrıştırılan liste metne geri yazılmaz: yoksa satır sonundaki boşluk ve yeni satır
 * silinir, "Yanlış masa" "Yanlışmasa" olurdu. Alandan çıkınca ya da değer dışarıdan değişince metin yeniden kurulur.
 */
function LinesTextarea<T>({ value, format, parse, onChange, className }: { value: T[]; format: (v: T[]) => string; parse: (text: string) => T[]; onChange: (v: T[]) => void; className?: string }) {
  const [draft, setDraft] = useState(() => format(value));
  const focused = useRef(false);
  const key = JSON.stringify(value);
  const prevKey = useRef(key);
  useEffect(() => {
    // Odaktayken de metin yeniden kurulur, kullanıcı yazmadıysa (metin önceki değerin aynısıysa): yoksa ilk tuş eski
    // listeyi yazıp dışarıdan gelen değişikliği (başka cihaz) ezerdi
    if (!focused.current || JSON.stringify(parse(draft)) === prevKey.current) setDraft(format(value));
    prevKey.current = key;
    // Yalnız değer değişince (format her çizimde yeni işlev)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <Textarea
      value={draft}
      className={className}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(format(value));
      }}
      onChange={(e) => {
        setDraft(e.target.value);
        const next = parse(e.target.value);
        if (JSON.stringify(next) !== key) onChange(next);
      }}
    />
  );
}

const parseQuickCash = (text: string) => fromLines(text).map((x) => parseTL(x) ?? 0).filter((x) => x > 0);
const formatQuickCash = (a: number[]) => a.map((k) => String(k / 100)).join('\n');
/** Satır listesi alanı: en az altı satır, içerik uzadıkça büyür (destekleyen tarayıcıda); liste kaydırmada saklanmaz */
const LIST_AREA = 'min-h-36 field-sizing-content';
/** Otomatik gün sonunun saati: 00:00-23:30, yarım saatte bir (22.5 = 22:30) */
const HOURS = Array.from({ length: 48 }, (_, i) => i / 2);
const hourLabel = (h: number) => `${String(Math.floor(h)).padStart(2, '0')}:${h % 1 ? '30' : '00'}`;
/** Kaydet tek yerde: değişiklik olunca altta yapışkan şeritte (DESIGN §5); başlıkta ikinci birincil düğme yok */
const DESCRIPTION = 'Fiş, kasa, uyarılar ve nedenler; değişiklik yapınca Kaydet altta çıkar';

/**
 * Modun seçim karosundaki ikonu: masaya servis oturan misafir, yarı self masaya götürülen tepsi, self çağrılan numara, QR
 * masadaki kod
 */
const MODE_ICON: Record<ServiceMode, LucideIcon> = { masa: Armchair, yari_self: HandPlatter, self: BellRing, qr_self: QrCode };

/**
 * Kartın içindeki alt bölüm (Gün sonu ve Z, Boylar...): üstünde satır ayracı, adı 15/600 mürekkep; kart başlığı (16/600)
 * ile alan etiketi (13) arasında bir basamak. Uzun kart bir bakışta bölümlerine ayrılır, alanların sırası değişmez
 */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="mt-1 grid gap-3 border-t border-[var(--admin-divider)] pt-4">
      <h3 className="text-[15px] font-semibold leading-5 tracking-[-0.01em] text-[var(--admin-text)]">{title}</h3>
      {children}
    </section>
  );
}

export default function SettingsAdmin() {
  const boot = useBoot();
  const patron = useAuth((st) => st.me?.role === 'patron');
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<Settings>('/admin/settings') });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => get<{ dir: string; files: { name: string; size: number; at: number }[] }>('/admin/backups') });
  // Z zinciri `cash` altında: gün açılıp kapanınca ve ayar kaydedilince canlı akış kendiliğinden yeniler
  const zChain = useQuery({ queryKey: ['cash', 'z-chain'], queryFn: () => get<{ lastZ: number | null; nextZ: number }>('/admin/settings/z') });
  // Şube kimliğinin kilidi `sync` altında: lafmaliyet ilk günü kabul edince canlı akış kendiliğinden yeniler
  // `acceptedBranch`: lafmaliyet'in kabul ettiği şube (şu anki kimlik değil; ona dönmek onay istemez)
  const branchLock = useQuery({
    queryKey: ['sync', 'branch-lock'],
    queryFn: () => get<{ locked: boolean; branchId: string; acceptedBranch: string | null }>('/admin/settings/branch-lock'),
  });
  const [s, setS] = useState<Settings | null>(null);
  const [modeBusy, setModeBusy] = useState<ServiceMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  // Sunucudan yeni veri gelince (odak dönüşü, canlı akış, başka cihaz) kaydedilmemiş alanlar korunur: yalnız
  // kullanıcının dokunmadığı alanlar yeni değeri alır, karşılaştırma tabanı (data.data) güncellenir
  const base = useRef<Settings | null>(null);
  const draftRef = useRef(s);
  useEffect(() => {
    draftRef.current = s;
  });
  useEffect(() => {
    const next = data.data;
    if (!next) return;
    const prev = base.current;
    base.current = next;
    // Aynı alanı başka cihaz da değiştirdiyse sessizce ezilmez: söylenir, sunucudaki bir dokunuşla alınır
    const cur = draftRef.current;
    const conflicts = cur && prev && prev !== next ? draftConflicts(prev, cur, next) : [];
    if (conflicts.length) {
      toast.warn(conflicts.length === 1 ? 'Değiştirdiğiniz bir ayar başka cihazda da kaydedildi; kaydederseniz sizinki geçer' : `Değiştirdiğiniz ${conflicts.length} ayar başka cihazda da kaydedildi; kaydederseniz sizinkiler geçer`, {
        action: { label: 'Sunucudakini al', run: () => setS((d) => (d ? { ...d, ...Object.fromEntries(conflicts.map((k) => [k, next[k]])) } : d)) },
      });
    }
    setS((c) => (c && prev ? rebaseDraft(prev, c, next) : next));
  }, [data.data]);
  const dirty = !!s && !!data.data && comparable(s) !== comparable(data.data);
  // Sekme kapanırken ve uygulama içi geçişte (kenar çubuğu, palet) kaydedilmemiş değişiklik sorulur
  useUnsavedGuard(dirty);
  if (!s) {
    // Başlık hemen; ayarlar gelene dek kart iskeleti, alınamazsa sonsuz yükleme yerine neden ve yeniden dene
    return (
      <div className="space-y-4">
        <PageHeader title="Ayarlar ve yedek" description={DESCRIPTION} />
        {data.isError ? (
          <ErrorState className={CARD} title="Ayarlar alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="space-y-4">
            <Skeleton className="h-36 rounded-[var(--r-card)]" />
            <div className="grid gap-4 xl:grid-cols-2">
              <Skeleton className="h-80 rounded-[var(--r-card)]" />
              <Skeleton className="h-80 rounded-[var(--r-card)]" />
            </div>
          </div>
        )}
      </div>
    );
  }
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const mode = serviceModeOf(s);
  // İlk Z numarası yalnız değiştiyse denetlenir (sunucu da öyle): zincir geri alınmaz
  const lastZ = zChain.data ? (zChain.data.lastZ ?? 0) : null;
  // Şube kimliği lafmaliyet'le aynı kuralda (docs/03-ENTEGRASYON.md §4): yanlış kimlik günü yanlış şubeye yazar
  const branchError = /^[a-z][a-z0-9-]{1,23}$/.test(s.branchId) ? null : 'Harfle başlamalı; küçük harf, rakam ve tire (en az 2 karakter)';
  const zError =
    s.zNoStart != null && s.zNoStart !== data.data?.zNoStart ? (s.zNoStart < 1 ? 'Z numarası 1 ya da daha büyük olmalı' : lastZ != null && s.zNoStart <= lastZ ? `Z numarası geri alınamaz; son Z ${lastZ}` : null) : null;
  // Alarm uyarıdan önce gelirse amber hiç görünmez (bar ekranı önce alarma bakar): alanda hata, Kaydet göndermez
  const kitchenError = s.kitchenAlarmMinutes <= s.kitchenWarnMinutes ? 'Alarm süresi uyarıdan uzun olmalı' : null;

  // Servis modu seçilince hemen uygulanır (yalnız bu alan gider): kasalar açılış verisiyle birlikte yenilenir
  const chooseMode = async (next: ServiceMode) => {
    if (next === mode || modeBusy) return;
    setModeBusy(next);
    try {
      await put('/admin/settings', { serviceMode: next });
      setS((cur) => (cur ? { ...cur, serviceMode: next } : cur));
      // Önbellek sunucuyla aynı kalsın: sonraki yenileme yeni nesne getirip taslağı yeniden kurmasın
      qc.setQueryData<Settings>(['admin', 'settings'], (d) => (d ? { ...d, serviceMode: next } : d));
      toast.ok(`Servis modu: ${SERVICE_MODE_LABEL[next]}`);
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setModeBusy(null);
    }
  };

  const save = async () => {
    if (saving) return;
    // Yalnız sunucudaki tabandan farklı alanlar gider: başka cihazın arada kaydettiği alan ezilmez, denetim kaydı yalnız
    // değişeni yazar (uç `patchOf`, eksik alan dokunulmaz kalır). Senkron anahtarları ayrı yetkiyle (Site ve lafmaliyet
    // ekranı) değişir; servis modu seçilince kendisi kaydedilir; müşteri ekranı kendi ekranında (Yönetim › Müşteri
    // ekranı): açılıştaki kopyası geri yazılıp oradaki kaydı ezmesin
    const was = base.current;
    const rest = Object.fromEntries(
      Object.entries(s).filter(([k, v]) => k !== 'menuAutoSync' && k !== 'onlineOrdersSync' && k !== 'serviceMode' && k !== 'customerDisplay' && JSON.stringify(v) !== JSON.stringify(was?.[k])),
    );
    // Gönderilecek fark yoksa istek gitmez (boş kayıt denetime düşmesin): taslak tabana döner
    if (!Object.keys(rest).length) {
      if (was) setS({ ...was, serviceMode: s.serviceMode });
      return;
    }
    // Alanın altında hata yazarken kayıt gitmez ("kaydedildi" ile hata yan yana kalmasın); sunucu da reddeder
    if (kitchenError) {
      toast.err('Bar fişi alarmı uyarıdan uzun olmalı');
      return;
    }
    if (branchError) {
      toast.err('Şube kimliği geçersiz: harfle başlamalı, küçük harf, rakam ve tire');
      return;
    }
    // Kilitli şube kimliği (lafmaliyet bu kasanın gününü kabul etti) patronun ayrıca onayıyla değişir: onay ayar değil,
    // yalnız bu kayıtla gider. Patron dışındakine sunucu zaten "yalnız patron" der
    const branchChange = typeof rest.branchId === 'string' ? { to: rest.branchId } : null;
    const accepted = branchLock.data?.acceptedBranch ?? null;
    if (branchChange && patron && branchLock.data?.locked && branchChange.to !== accepted) {
      const ok = await confirmDialog({
        title: 'Şube kimliği değişsin mi',
        body: `lafmaliyet bu kasanın günlerini ${accepted ? `“${accepted}” şubesine kaydetti` : 'kabul etti'}. Kaydederseniz bundan sonraki günler “${branchChange.to}” şubesine gider; gönderilmiş günler yerinde kalır`,
        confirmLabel: 'Şube kimliğini değiştir',
        tone: 'danger',
      });
      if (!ok) return;
      rest.confirmBranchChange = true;
    }
    setSaving(true);
    try {
      const sent = s;
      // Kayıt ucu kaydedilen ayarları döndürür (GET ile aynı biçim): taslak onunla yeniden kurulur. Ayrı bir yenileme
      // başarısız olsa ya da çevrimdışı diye duraklasa önbellekteki eski ayarlar taslağı geri alırdı
      const saved = await put<Settings>('/admin/settings', rest);
      toast.ok('Ayarlar kaydedildi');
      // Kaydedilen taslak sunucunun biçimini alır (kırpılan metin "kaydedilmemiş" kalmasın); kayıt sürerken yapılan
      // değişiklikler korunur. Taban önce yazılır: önbellek değişince çalışan eşitleme taslağa dokunmaz
      base.current = saved;
      qc.setQueryData(['admin', 'settings'], saved);
      setS((cur) => (cur ? rebaseDraft(sent, cur, saved) : saved));
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      if (branchChange) void qc.invalidateQueries({ queryKey: ['sync', 'branch-lock'] });
    } catch (e) {
      // Kilit sayfa açıldıktan sonra kondu (ilk gün o arada kabul edildi): not alanın altında belirir, Kaydet onay sorar
      if (e instanceof ApiError && e.code === 'branch_locked') void branchLock.refetch();
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const backupNow = async () => {
    setBackingUp(true);
    try {
      await post('/admin/backups');
      toast.ok('Yedek alındı');
      void backups.refetch();
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBackingUp(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Kaydet yalnız alttaki yapışkan şeritte, değişiklik varken (her genişlikte tek kayıt yolu) */}
      <PageHeader title="Ayarlar ve yedek" description={DESCRIPTION} />
      {/* Kayıtlı değerden çizilir: anahtar kapatılınca uyarı ve anahtar kaybolmaz (sayfa zıplamaz), kayıttan önce geri
          açılabilir; kapanacağı söylenir */}
      {/* Deneme modu ve "gerçek kullanıma başla" yalnız patrona (sunucu da yalnız patrona açar); patron kurulum modunu
          oradan kapatır, aşağıdaki anahtar öbür yöneticiler için */}
      {patron && !REMOTE && <DenemeCard />}
      {data.data?.demoMode && !patron && (
        <Notice tone="warn" title={s.demoMode ? 'Kurulum modu açık' : 'Kurulum modu kaydedince kapanır'}>
          <p>
            {s.demoMode
              ? 'Giriş ekranında örnek PIN’ler görünüyor. Canlıya geçmeden önce Personel’den PIN’leri değiştirip kurulum modunu kapatın'
              : 'Kaydedince örnek PIN’ler giriş ekranından kalkar; vazgeçmek için anahtarı yeniden açın'}
          </p>
          {/* Uzun metin anahtarı itmesin: etiket tam genişlik, anahtar sağda */}
          <Toggle block className="mt-2" checked={s.demoMode} onChange={(v) => set({ demoMode: v })} label="Kurulum modu" />
        </Notice>
      )}
      <Card title="Servis modu" subtitle="Seçince hemen uygulanır; açılış ekranı, menü ve tezgâh satışı buna göre değişir">
        <div role="radiogroup" aria-label="Servis modu" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {SERVICE_MODES.map((m) => {
            const on = m === mode;
            const busy = modeBusy === m;
            const Icon = MODE_ICON[m];
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                aria-busy={busy || undefined}
                disabled={!!modeBusy}
                onClick={() => void chooseMode(m)}
                className={cn(
                  // Seçim karosu (köşe 12): telefonda ikon solda, geniş ekranda üstte; seçim dairesi sağ üstte, ikonun
                  // hizasında. Seçili açık nane zeminde, ikon beyaz karoda (kasanın ödeme türü karosu gibi); uygulanırken
                  // seçilen karo soluklaşmaz, dairesinde dönen gösterge
                  'relative flex min-h-16 items-start gap-3 rounded-[var(--r-tile)] border p-3.5 pr-11 text-left transition-[background-color,border-color,box-shadow] sm:flex-col sm:pr-3.5',
                  !busy && 'disabled:opacity-60',
                  on
                    ? 'border-primary bg-[var(--admin-primary-soft)] shadow-[inset_0_0_0_1px_var(--admin-primary)]'
                    : 'border-line bg-surface shadow-[var(--shadow-control)] hover:border-[var(--admin-border-field)] hover:bg-hover',
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-[var(--r-control)] [&>svg]:size-[18px]',
                    on ? 'bg-[var(--admin-surface)] text-primary shadow-[var(--shadow-control)]' : 'bg-[var(--admin-panel)] text-[var(--admin-text-soft)]',
                  )}
                >
                  <Icon />
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-sm font-semibold', on && 'text-primary')}>{SERVICE_MODE_LABEL[m]}</span>
                  <span className="mt-0.5 block text-xs leading-4 text-muted">{SERVICE_MODE_HINT[m]}</span>
                </span>
                {/* Boş halka alan kenarı tonunda (iki temada 3:1): seçilmemiş kutucuk düz metin kutusu gibi okunmasın */}
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute right-3.5 top-[22px] grid size-5 place-items-center rounded-full border',
                    on ? 'border-primary bg-primary text-primary-ink' : 'border-[var(--admin-border-field)] bg-surface',
                    busy && 'border-transparent bg-transparent text-primary',
                  )}
                >
                  {busy ? <Loader2 className="size-4 animate-spin motion-reduce:animate-none" /> : on && <Check className="size-3.5 stroke-[2.5]" />}
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      {/* Geniş ekranda iki sütun: uzun Kasa ve gün sağda iki satır boyu, solda İşletme ve fiş ile Bar ekranı alt alta.
          Nedenler beş liste yan yana olduğu için tam genişlikte, ayrı kartta (yarım kartta her liste 76 px'e iniyordu) */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Card title="İşletme ve fiş">
          <div className="grid gap-3">
            <Field label="İşletme adı">
              <Input value={s.businessName} onChange={(e) => set({ businessName: e.target.value })} />
            </Field>
            <Field label="Adres">
              <Input value={s.businessAddress} onChange={(e) => set({ businessAddress: e.target.value })} />
            </Field>
            <Field label="Fiş üstü">
              <Textarea value={s.receiptHeader} onChange={(e) => set({ receiptHeader: e.target.value })} />
            </Field>
            <Field label="Fiş altı" hint="adisyona “mali değeri yoktur” kendiliğinden yazılır">
              <Textarea value={s.receiptFooter} onChange={(e) => set({ receiptFooter: e.target.value })} />
            </Field>
            <Toggle
              block
              checked={s.receiptCustomerName}
              onChange={(v) => set({ receiptCustomerName: v })}
              label="Fişte müşteri adı"
              hint="adisyona müşteri bağlıysa adı hesap fişine yazılır"
            />
            {/* Boy ayarları bir arada, kendi bölümünde: kasadaki boy adı ve lafmaliyet'e giden adın boy eki, her alan kendi
                etiketiyle */}
            <Group title="Boylar">
              <div className="grid grid-cols-2 gap-3">
                <Field label="M boy adı">
                  <Input value={s.sizeLabels.M} onChange={(e) => set({ sizeLabels: { ...s.sizeLabels, M: e.target.value } })} />
                </Field>
                <Field label="L boy adı">
                  <Input value={s.sizeLabels.L} onChange={(e) => set({ sizeLabels: { ...s.sizeLabels, L: e.target.value } })} />
                </Field>
                <Field label="lafmaliyet’te M eki">
                  <Input value={s.posSizeSuffix.M} onChange={(e) => set({ posSizeSuffix: { ...s.posSizeSuffix, M: e.target.value } })} />
                </Field>
                <Field label="lafmaliyet’te L eki">
                  <Input value={s.posSizeSuffix.L} onChange={(e) => set({ posSizeSuffix: { ...s.posSizeSuffix, L: e.target.value } })} />
                </Field>
              </div>
            </Group>
          </div>
        </Card>
        {/* Üç bölüm: kasa ekranı (başlıksız, kartın adı söyler), gün sonu ve Z, ödeme ve kilit. Anahtarlar sayfanın
            öteki anahtarları gibi yazı solda, anahtar sağda */}
        <Card title="Kasa ve gün" className="xl:row-span-2">
          <div className="grid gap-3">
            <Toggle block checked={s.requireDayOpen} onChange={(v) => set({ requireDayOpen: v })} label="Satış için gün açılmış olmalı" />
            <Toggle block checked={s.keepAwake} onChange={(v) => set({ keepAwake: v })} label="Ekran kararmasın" hint="kasa bilgisayarı, bar ve tablet ekranları" />
            <Toggle block checked={s.productImages} onChange={(v) => set({ productImages: v })} label="Ürün kartlarında görsel" hint="sitedeki fotoğraf, kasa bilgisayarında saklanır" />
            {/* Ürün kartı ve boy düğmesi: hemen ekler ya da seçenek penceresini açar (seçenek profili, docs/02-PLAN.md) */}
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink-2">Seçenekleri sor</div>
              <Segmented
                wrap
                label="Seçenekleri sor"
                value={s.askOptions === 'hep' ? 'hep' : 'zorunlu'}
                onChange={(askOptions) => set({ askOptions })}
                options={[
                  { value: 'zorunlu', label: 'Zorunlu seçim varsa' },
                  { value: 'hep', label: 'Seçenekli her üründe' },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted">
                {s.askOptions === 'hep'
                  ? 'Seçeneği olan her ürün pencereyle eklenir; iki boyluda dokunulan boy seçili gelir'
                  : 'Ürün tek dokunuşla eklenir (süt gibi isteğe bağlı seçenek varsayılanıyla); şeker gibi zorunlu seçimi olan pencereyle açılır'}
              </p>
            </div>
            <Group title="Gün sonu ve Z">
              <div>
                <Toggle block checked={s.autoDayEnd} onChange={(v) => set({ autoDayEnd: v })} label="Otomatik gün sonu" hint="açık adisyon varsa alınmaz; sayım sonra Kasa föyünden girilir" />
                {/* Saat "06:00" diye seçilir (çıplak "6" saat mi, kaçta mı belli değildi); anahtar kapalıyken kilitli, gün sonu
                    o saatte alınıyormuş gibi görünmez. Anahtarın yazısının altında, onunla aynı hizadan */}
                <label className="mt-2 flex items-center gap-2 text-sm text-muted">
                  Saat
                  <Select value={String(s.autoDayEndHour)} disabled={!s.autoDayEnd} aria-label="Otomatik gün sonu saati" onChange={(e) => set({ autoDayEndHour: Number(e.target.value) })} className="tabular w-28">
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourLabel(h)}
                      </option>
                    ))}
                  </Select>
                </label>
              </div>
              <div>
                <Field
                  label="Şube kimliği"
                  hint="Bu kasanın şubesi: gün sonu lafmaliyet'te bu şubenin cirosuna yazılır; sitenin online siparişleri, masa çağrıları ve Tükendi'si bu şube adına okunur ve yazılır. Paneldeki kimliğin aynısı olmalı (bugün marina)"
                  error={branchError}
                >
                  <Input
                    value={s.branchId}
                    onChange={(e) => set({ branchId: branchSlug(e.target.value) })}
                    placeholder="marina"
                    autoCapitalize="none"
                    spellCheck={false}
                    aria-describedby={branchLock.data?.locked ? 'branch-lock-info' : undefined}
                    className="sm:max-w-60"
                  />
                </Field>
                {/* lafmaliyet bir günü kabul ettiyse: yanlış değişiklik sonraki günleri başka şubeye yazar. Kayıtta onay sorulur */}
                {branchLock.data?.locked && (
                  <p id="branch-lock-info" className="mt-1.5 flex items-start gap-1.5 text-xs text-muted">
                    <Lock aria-hidden="true" className="mt-px size-3.5 shrink-0" />
                    <span>
                      {branchLock.data.acceptedBranch
                        ? `Kilitli: lafmaliyet bu kasanın günlerini “${branchLock.data.acceptedBranch}” şubesine kaydetti${
                            branchLock.data.acceptedBranch !== branchLock.data.branchId
                              ? `; kayıtlı kimlik şu an “${branchLock.data.branchId}”. O şubeye dönmek onay istemez, başka kimlik patronun ayrıca onayını ister`
                              : '. Değiştirmek patronun ayrıca onayını ister'
                          }`
                        : 'Kilitli: lafmaliyet bu kasanın günlerini kabul etti. Değiştirmek patronun ayrıca onayını ister'}
                    </span>
                  </p>
                )}
              </div>
              <div>
                <Field label="İlk Z numarası" hint="ModPOS’un son Z numarasının bir fazlası. Geçiş gününden önce bir kez girilir; sonraki gün sonları buradan devam eder" error={zError}>
                  <Input
                    value={s.zNoStart == null ? '' : String(s.zNoStart)}
                    onChange={(e) => {
                      const digits = e.target.value.replace(/\D/g, '').slice(0, 8);
                      set({ zNoStart: digits === '' ? null : Number(digits) });
                    }}
                    inputMode="numeric"
                    pattern="[0-9]*"
                    placeholder={zStartPlaceholder(lastZ)}
                    aria-describedby="z-chain-info"
                    className="tabular text-right sm:max-w-60"
                  />
                </Field>
                {/* Yüklenirken ya da alınamazsa "yok" yazılmaz */}
                {lastZ == null && !zChain.isError ? (
                  <Skeleton className="mt-2 h-3.5 w-52 rounded" />
                ) : (
                  <p id="z-chain-info" className="tabular mt-1.5 text-xs text-muted">
                    {lastZ == null ? 'Son Z alınamadı' : `${lastZ ? `Son Z: ${lastZ}` : 'Henüz gün açılmadı'} · sıradaki gün: Z ${nextZNo(lastZ, zError ? data.data?.zNoStart : s.zNoStart)}`}
                  </p>
                )}
              </div>
            </Group>
            <Group title="Ödeme ve kilit">
              <Field label="Hızlı nakit düğmeleri (₺, satır satır)">
                <LinesTextarea value={s.quickCash} format={formatQuickCash} parse={parseQuickCash} onChange={(quickCash) => set({ quickCash })} className={LIST_AREA} />
              </Field>
              {/* İkisinin açıklaması da alanın altında: etiketler tek satır kalır, alanlar her genişlikte aynı hizada */}
              <div className="grid grid-cols-2 gap-3">
                <Field label="Servis ücreti (%)" hint="masa adisyonlarına eklenir">
                  <NumberInput commitOnChange value={s.serviceRate} min={0} max={30} fallback={0} onCommit={(serviceRate) => set({ serviceRate })} />
                </Field>
                <Field label="Otomatik kilit (dk)" hint="0 yazılırsa kilitlenmez">
                  <NumberInput commitOnChange value={s.autoLockMinutes} min={0} max={120} fallback={0} onCommit={(autoLockMinutes) => set({ autoLockMinutes })} />
                </Field>
              </div>
            </Group>
          </div>
        </Card>
        {/* Eşik adı ne olacağını söyler (amber, kırmızı, uyarı, alarm); açıklamalar alanın altında, etiketler tek satır.
            Üç bölüm: bar ekranı ve fiş süreleri, karaoke odası, uyarılar */}
        <Card title={boot.integrations.localStamps ? 'Bar ekranı, karaoke, damga, uyarılar' : 'Bar ekranı, karaoke, uyarılar'}>
          <div className="grid gap-3">
            {/* Bar ekranı olmayan işletme kapatır (operatör 20 Kas 2026): sipariş bara gitmez, adisyonda "Bara gönder"
                yerine "Kaydet", Bar menüden kalkar; fiş süreleri o zaman kullanılmaz */}
            <Toggle
              block
              checked={s.barEnabled}
              onChange={(v) => set({ barEnabled: v })}
              label="Bar ekranı ve “Bara gönder”"
              hint="kapalıyken sipariş bara gitmez, adisyonda “Kaydet” çıkar ve Bar menüden kalkar"
            />
            <div className="grid grid-cols-2 gap-3">
              <Field label="Bar fişi uyarısı (dk)" hint="bu süreyi geçen fiş ambere döner">
                <NumberInput commitOnChange value={s.kitchenWarnMinutes} min={1} max={120} onCommit={(kitchenWarnMinutes) => set({ kitchenWarnMinutes })} />
              </Field>
              <Field label="Bar fişi alarmı (dk)" hint="bu süreyi geçen fiş kırmızıya döner" error={kitchenError}>
                <NumberInput commitOnChange value={s.kitchenAlarmMinutes} min={1} max={240} onCommit={(kitchenAlarmMinutes) => set({ kitchenAlarmMinutes })} />
              </Field>
            </div>
            <Group title="Karaoke odası">
              <div className="grid grid-cols-2 gap-3">
                <Field label="Oda ücret adımı (dk)">
                  <NumberInput commitOnChange value={s.roomBillingStepMinutes} min={1} max={120} onCommit={(roomBillingStepMinutes) => set({ roomBillingStepMinutes })} />
                </Field>
                <Field label="Oda en az süre (dk)">
                  <NumberInput commitOnChange value={s.roomMinimumMinutes} min={0} max={600} fallback={0} onCommit={(roomMinimumMinutes) => set({ roomMinimumMinutes })} />
                </Field>
              </div>
            </Group>
            <Group title={boot.integrations.localStamps ? 'Damga ve uyarılar' : 'Uyarılar'}>
              <div className="grid grid-cols-2 gap-3">
                {/* Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada) */}
                {boot.integrations.localStamps && (
                  <Field label="Hediye için damga">
                    <NumberInput commitOnChange value={s.stampGoal} min={1} max={50} onCommit={(stampGoal) => set({ stampGoal })} />
                  </Field>
                )}
                <Field label="İndirim uyarısı (%)" hint="bu oran ve üstü uyarı düşer">
                  <NumberInput commitOnChange value={s.alertDiscountPct} min={1} max={100} onCommit={(alertDiscountPct) => set({ alertDiscountPct })} />
                </Field>
                <Field label="Kasa farkı alarmı (₺)">
                  <TlInput value={s.alertCashDiffKurus} onCommit={(alertCashDiffKurus) => set({ alertCashDiffKurus })} />
                </Field>
              </div>
            </Group>
          </div>
        </Card>
      </div>
      <Card title="Nedenler" subtitle="Satır satır yazın; kasada bu sırayla çıkar">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
          <Field label="İptal">
            <LinesTextarea value={s.voidReasons} format={lines} parse={fromLines} onChange={(voidReasons) => set({ voidReasons })} className={LIST_AREA} />
          </Field>
          <Field label="İkram">
            <LinesTextarea value={s.compReasons} format={lines} parse={fromLines} onChange={(compReasons) => set({ compReasons })} className={LIST_AREA} />
          </Field>
          <Field label="Ödenmez" hint="ör. personel yemeği, patron hesabı">
            <LinesTextarea value={s.odenmezReasons} format={lines} parse={fromLines} onChange={(odenmezReasons) => set({ odenmezReasons })} className={LIST_AREA} />
          </Field>
          <Field label="Zayi" hint="ör. döküldü, yanlış hazırlandı">
            <LinesTextarea value={s.zayiReasons} format={lines} parse={fromLines} onChange={(zayiReasons) => set({ zayiReasons })} className={LIST_AREA} />
          </Field>
          <Field label="İndirim" hint="nedene dokununca hazır yüzde yazılır">
            <LinesTextarea value={s.discountReasons} format={lines} parse={fromLines} onChange={(discountReasons) => set({ discountReasons })} className={LIST_AREA} />
          </Field>
          <Field label="Hazır indirim yüzdesi" hint="0 yazılırsa yüzde elle girilir">
            <NumberInput commitOnChange value={s.discountPresetPct} min={0} max={100} fallback={0} onCommit={(discountPresetPct) => set({ discountPresetPct })} />
          </Field>
        </div>
      </Card>
      <Card
        title="Yedek"
        subtitle={`Her gün kendiliğinden alınır, son ${s.backupKeep} gün tutulur`}
        actions={
          <Button size="sm" icon={<DatabaseBackup className="size-4" />} loading={backingUp} onClick={() => void backupNow()}>
            Şimdi yedek al
          </Button>
        }
      >
        <div className="grid gap-4 text-sm">
          {/* Yedeğin yeri ve elle kopyalama hatırlatması kartın içindeki karoda (köşe 12, soluk zemin): liste ya da boş
              durum altında kalır */}
          <div className="flex items-start gap-3 rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-3">
            <IconBox>
              <FolderOpen />
            </IconBox>
            <p className="min-w-0 pt-1 text-[13px] leading-5 text-muted">
              {backups.data?.dir && (
                <>
                  Klasör: <code className={CODE}>{backups.data.dir}</code>.{' '}
                </>
              )}
              Bu klasörü haftada bir başka diske ya da buluta kopyalayın
            </p>
          </div>
          {backups.isPending ? (
            <ListSkeleton rows={3} className="rounded-[var(--r-tile)] border border-line" />
          ) : backups.isError && !backups.data ? (
            <ErrorState compact className="rounded-[var(--r-tile)] border border-line" title="Yedek listesi alınamadı" error={backups.error} onRetry={() => void backups.refetch()} retrying={backups.isFetching} />
          ) : !backups.data?.files.length ? (
            <EmptyState bare icon={<HardDrive />} title="Henüz yedek alınmadı">
              Yedek her gün kendiliğinden alınır; hemen almak için Şimdi yedek al’a basın
            </EmptyState>
          ) : (
            // Satır: ikon karosu, dosya adı (en yenisinde "Son yedek" rozeti), sağda zamanı ve boyu; telefonda zaman adın
            // altına, adın hizasından iner (sunucu en yeniden eskiye sıralar)
            <ul className="divide-y divide-[var(--admin-divider)] overflow-hidden rounded-[var(--r-tile)] border border-line">
              {backups.data.files.slice(0, 8).map((f, i) => (
                <li key={f.name} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-2.5">
                  <IconBox>
                    <DatabaseBackup />
                  </IconBox>
                  <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="min-w-0 break-all font-medium text-[var(--admin-text)]">{f.name}</span>
                    {i === 0 && <Badge tone="success">Son yedek</Badge>}
                  </span>
                  <span className="tabular shrink-0 text-[13px] max-sm:w-full max-sm:pl-10">
                    {fmtDateTime(f.at)} <span className="text-muted">· {(f.size / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {!REMOTE && <PrinterCard />}
      {!REMOTE && <CloudBackupCard />}
      {!REMOTE && <UpdateCard />}
      {dirty && (
        // Kaydet şeridi zeminde yüzen kart (kartların hizasında, köşe 18, hafif kalkık gölge): kenara taşan negatif pay
        // yok, telefonda kabın 8 px payını aşmaz. Ev çubuğu payını telefonda altındaki sekme çubuğu (AppShell) alır
        <div className="sticky bottom-3 z-10 flex items-center gap-3 rounded-[var(--r-card)] border border-[var(--card-line)] bg-[var(--admin-surface)] px-4 py-3 shadow-[var(--shadow-lift)] sm:px-5">
          {/* Telefonda yazı yalnız ekran okuyucuya: iki düğmenin yanında iki satıra kırılıyordu. Amber nokta: kaydedilmemiş */}
          <span className="flex items-center gap-2 text-[13px] text-[var(--admin-text-soft)] max-sm:sr-only">
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-[var(--admin-warning)]" />
            Kaydedilmemiş değişiklik
          </span>
          <span className="flex-1" />
          <Button disabled={saving} onClick={() => data.data && setS({ ...data.data, serviceMode: s.serviceMode })}>
            Vazgeç
          </Button>
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()}>
            Kaydet
          </Button>
        </div>
      )}
    </div>
  );
}
