import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, DatabaseBackup, HardDrive, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { parseTL, tlCompact } from '@shared/money';
import { SERVICE_MODE_HINT, SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode, serviceModeOf } from '@shared/service-mode';
import { fmtDateTime } from '@shared/time';
import { nextZNo } from '@shared/z-no';
import { Button } from '@/components/ui/Button';
import { Field, Input, NumberInput, Textarea, Toggle } from '@/components/ui/Field';
import { ErrorState, ListSkeleton, Notice, Skeleton } from '@/components/ui/misc';
import { Card, CARD, CODE, EmptyState, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useMediaQuery } from '@/lib/hooks';
import { draftConflicts, fromLines, rebaseDraft } from '@/lib/settingsDraft';
import { toast } from '@/lib/toast';
import { useUnsavedGuard } from '@/lib/unsavedGuard';

type Settings = Record<string, unknown> & {
  businessName: string;
  businessAddress: string;
  businessPhone: string;
  receiptHeader: string;
  receiptFooter: string;
  serviceRate: number;
  autoLockMinutes: number;
  keepAwake: boolean;
  productImages: boolean;
  voidReasons: string[];
  compReasons: string[];
  odenmezReasons: string[];
  zayiReasons: string[];
  discountReasons: string[];
  quickCash: number[];
  sizeLabels: { M: string; L: string };
  requireDayOpen: boolean;
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
};

const lines = (a: string[]) => a.join('\n');
/** Kaydedilmemiş değişiklik karşılaştırması: servis modu seçilince kendisi kaydedilir, sayılmaz */
const comparable = (x: Settings) => JSON.stringify({ ...x, serviceMode: null });

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

export default function SettingsAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<Settings>('/admin/settings') });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => get<{ dir: string; files: { name: string; size: number; at: number }[] }>('/admin/backups') });
  // Z zinciri `cash` altında: gün açılıp kapanınca ve ayar kaydedilince canlı akış kendiliğinden yeniler
  const zChain = useQuery({ queryKey: ['cash', 'z-chain'], queryFn: () => get<{ lastZ: number | null; nextZ: number }>('/admin/settings/z') });
  const [s, setS] = useState<Settings | null>(null);
  const [modeBusy, setModeBusy] = useState<ServiceMode | null>(null);
  const [saving, setSaving] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const wide = useMediaQuery('(min-width: 768px)');
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
        <PageHeader title="Ayarlar ve yedek" />
        {data.isError ? (
          <ErrorState className={CARD} title="Ayarlar alınamadı" error={data.error} onRetry={() => void data.refetch()} retrying={data.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="space-y-4">
            <Skeleton className="h-36 rounded-2xl" />
            <div className="grid gap-4 xl:grid-cols-2">
              <Skeleton className="h-80 rounded-2xl" />
              <Skeleton className="h-80 rounded-2xl" />
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
  const zError =
    s.zNoStart != null && s.zNoStart !== data.data?.zNoStart ? (s.zNoStart < 1 ? 'Z numarası 1 ya da daha büyük olmalı' : lastZ != null && s.zNoStart <= lastZ ? `Z numarası geri alınamaz; son Z ${lastZ}` : null) : null;

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
    setSaving(true);
    try {
      // Senkron anahtarları ayrı yetkiyle (Site ve lafmaliyet ekranı) değişir; servis modu seçilince kendisi kaydedilir
      const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'menuAutoSync' && k !== 'onlineOrdersSync' && k !== 'serviceMode'));
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
    } catch (e) {
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
      {/* Telefonda Kaydet yalnız alttaki yapışkan şeritte (değişiklik varken) */}
      <PageHeader
        title="Ayarlar ve yedek"
        actions={
          wide ? (
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} onClick={() => void save()} disabled={!dirty}>
              Kaydet
            </Button>
          ) : undefined
        }
      />
      {s.demoMode && (
        <Notice tone="warn" title="Kurulum modu açık">
          <p>Giriş ekranında örnek PIN’ler görünüyor. Canlıya geçmeden önce Personel’den PIN’leri değiştirip kurulum modunu kapatın</p>
          {/* Uzun metin anahtarı itmesin: etiket tam genişlik, anahtar sağda */}
          <Toggle block className="mt-2" checked={s.demoMode} onChange={(v) => set({ demoMode: v })} label="Kurulum modu" />
        </Notice>
      )}
      <Card flush title="Servis modu" subtitle="Seçince hemen uygulanır; açılış ekranı, menü ve tezgâh satışı buna göre değişir">
        <div role="radiogroup" aria-label="Servis modu" className="grid gap-2 p-4 sm:grid-cols-2 xl:grid-cols-4">
          {SERVICE_MODES.map((m) => {
            const on = m === mode;
            return (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={!!modeBusy}
                onClick={() => void chooseMode(m)}
                className={cn(
                  'flex min-h-16 items-start gap-3 rounded-xl border px-3.5 py-3 text-left transition-colors disabled:opacity-70',
                  on ? 'border-primary bg-[var(--admin-primary-soft)]' : 'border-line bg-surface hover:border-[var(--admin-border-field)] hover:bg-hover',
                )}
              >
                <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border', on ? 'border-primary bg-primary text-primary-ink' : 'border-[var(--admin-border-strong)]')}>
                  {on && <Check aria-hidden="true" className="size-3.5 stroke-[2.5]" />}
                </span>
                <span className="min-w-0">
                  <span className={cn('block text-sm font-semibold', on && 'text-primary')}>{SERVICE_MODE_LABEL[m]}</span>
                  <span className="block text-xs text-muted">{SERVICE_MODE_HINT[m]}</span>
                </span>
              </button>
            );
          })}
        </div>
      </Card>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card flush title="İşletme ve fiş">
          <div className="grid gap-3 p-4">
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
            <div className="grid grid-cols-2 gap-3">
              <Field label="M boy adı">
                <Input value={s.sizeLabels.M} onChange={(e) => set({ sizeLabels: { ...s.sizeLabels, M: e.target.value } })} />
              </Field>
              <Field label="L boy adı">
                <Input value={s.sizeLabels.L} onChange={(e) => set({ sizeLabels: { ...s.sizeLabels, L: e.target.value } })} />
              </Field>
            </div>
          </div>
        </Card>
        <Card flush title="Kasa ve gün">
          <div className="grid gap-3 p-4">
            <Toggle checked={s.requireDayOpen} onChange={(v) => set({ requireDayOpen: v })} label="Satış için gün açılmış olmalı" />
            <Toggle checked={s.keepAwake} onChange={(v) => set({ keepAwake: v })} label="Ekran kararmasın" hint="kasa bilgisayarı, bar ve tablet ekranları" />
            <Toggle checked={s.productImages} onChange={(v) => set({ productImages: v })} label="Ürün kartlarında görsel" hint="sitedeki fotoğraf, kasa bilgisayarında saklanır" />
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
              <Toggle checked={s.autoDayEnd} onChange={(v) => set({ autoDayEnd: v })} label="Otomatik gün sonu" hint="açık adisyon varsa alınmaz; sayım sonra Kasa föyünden girilir" />
              {/* Telefonda saat, anahtarın yazısının altına hizalı (anahtar 44 + aralık 12 px) */}
              <label className="ml-14 flex shrink-0 items-center gap-2 text-sm text-muted sm:ml-0">
                Saat
                <NumberInput commitOnChange value={s.autoDayEndHour} min={0} max={23} fallback={0} onCommit={(autoDayEndHour) => set({ autoDayEndHour })} className="w-20" />
              </label>
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
                  placeholder="Boşsa 1’den"
                  aria-describedby="z-chain-info"
                  className="tabular text-right sm:max-w-48"
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
            <Field label="Hızlı nakit düğmeleri (₺, satır satır)">
              <LinesTextarea value={s.quickCash} format={formatQuickCash} parse={parseQuickCash} onChange={(quickCash) => set({ quickCash })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Servis ücreti (%)" hint="masa adisyonlarına">
                <NumberInput commitOnChange value={s.serviceRate} min={0} max={30} fallback={0} onCommit={(serviceRate) => set({ serviceRate })} />
              </Field>
              <Field label="Otomatik kilit (dk)" hint="0 ise kapalı">
                <NumberInput commitOnChange value={s.autoLockMinutes} min={0} max={120} fallback={0} onCommit={(autoLockMinutes) => set({ autoLockMinutes })} />
              </Field>
            </div>
          </div>
        </Card>
        <Card flush title="Nedenler">
          <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
            <Field label="İptal">
              <LinesTextarea value={s.voidReasons} format={lines} parse={fromLines} onChange={(voidReasons) => set({ voidReasons })} className="min-h-36" />
            </Field>
            <Field label="İkram">
              <LinesTextarea value={s.compReasons} format={lines} parse={fromLines} onChange={(compReasons) => set({ compReasons })} className="min-h-36" />
            </Field>
            <Field label="Ödenmez" hint="ör. personel yemeği, patron hesabı">
              <LinesTextarea value={s.odenmezReasons} format={lines} parse={fromLines} onChange={(odenmezReasons) => set({ odenmezReasons })} className="min-h-36" />
            </Field>
            <Field label="Zayi" hint="ör. döküldü, yanlış hazırlandı">
              <LinesTextarea value={s.zayiReasons} format={lines} parse={fromLines} onChange={(zayiReasons) => set({ zayiReasons })} className="min-h-36" />
            </Field>
            <Field label="İndirim">
              <LinesTextarea value={s.discountReasons} format={lines} parse={fromLines} onChange={(discountReasons) => set({ discountReasons })} className="min-h-36" />
            </Field>
          </div>
        </Card>
        <Card flush title={boot.integrations.localStamps ? 'Bar ekranı, karaoke, damga, uyarılar' : 'Bar ekranı, karaoke, uyarılar'}>
          <div className="grid grid-cols-2 gap-3 p-4">
            <Field label="Bar uyarı (dk)">
              <NumberInput commitOnChange value={s.kitchenWarnMinutes} min={1} max={120} onCommit={(kitchenWarnMinutes) => set({ kitchenWarnMinutes })} />
            </Field>
            <Field label="Bar alarm (dk)">
              <NumberInput commitOnChange value={s.kitchenAlarmMinutes} min={1} max={240} onCommit={(kitchenAlarmMinutes) => set({ kitchenAlarmMinutes })} />
            </Field>
            <Field label="Oda faturalama adımı (dk)">
              <NumberInput commitOnChange value={s.roomBillingStepMinutes} min={1} max={120} onCommit={(roomBillingStepMinutes) => set({ roomBillingStepMinutes })} />
            </Field>
            <Field label="Oda en az (dk)">
              <NumberInput commitOnChange value={s.roomMinimumMinutes} min={0} max={600} fallback={0} onCommit={(roomMinimumMinutes) => set({ roomMinimumMinutes })} />
            </Field>
            {/* Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada) */}
            {boot.integrations.localStamps && (
              <Field label="Hediye için damga">
                <NumberInput commitOnChange value={s.stampGoal} min={1} max={50} onCommit={(stampGoal) => set({ stampGoal })} />
              </Field>
            )}
            <Field label="Uyarı: indirim (%)">
              <NumberInput commitOnChange value={s.alertDiscountPct} min={1} max={100} onCommit={(alertDiscountPct) => set({ alertDiscountPct })} />
            </Field>
            <Field label="Alarm: kasa farkı (₺)">
              <TlInput value={s.alertCashDiffKurus} onCommit={(alertCashDiffKurus) => set({ alertCashDiffKurus })} />
            </Field>
            <Field label="lafmaliyet boy ekleri" hint="M / L">
              <div className="flex gap-1.5">
                <Input value={s.posSizeSuffix.M} onChange={(e) => set({ posSizeSuffix: { ...s.posSizeSuffix, M: e.target.value } })} />
                <Input value={s.posSizeSuffix.L} onChange={(e) => set({ posSizeSuffix: { ...s.posSizeSuffix, L: e.target.value } })} />
              </div>
            </Field>
          </div>
        </Card>
      </div>
      <Card flush
        title="Yedek"
        actions={
          <Button size="sm" icon={<DatabaseBackup className="size-4" />} loading={backingUp} onClick={() => void backupNow()}>
            Şimdi yedek al
          </Button>
        }
      >
        <div className="p-4 text-sm">
          <p className="mb-2 text-muted">
            Her gün kendiliğinden alınır, son {s.backupKeep} gün tutulur.{backups.data?.dir && <> Klasör: <code className={CODE}>{backups.data.dir}</code>.</>} Bu klasörü haftada bir başka diske ya da buluta kopyalayın
          </p>
          {backups.isPending ? (
            <ListSkeleton rows={3} className="rounded-xl border border-line" />
          ) : backups.isError && !backups.data ? (
            <ErrorState compact className="rounded-xl border border-line" title="Yedek listesi alınamadı" error={backups.error} onRetry={() => void backups.refetch()} retrying={backups.isFetching} />
          ) : !backups.data?.files.length ? (
            <EmptyState bare icon={<HardDrive />} title="Henüz yedek alınmadı">
              Yedek her gün kendiliğinden alınır; hemen almak için Şimdi yedek al’a basın
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line rounded-xl border border-line">
              {backups.data.files.slice(0, 8).map((f) => (
                <li key={f.name} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 px-3 py-2">
                  <span className="min-w-0 break-all">{f.name}</span>
                  <span className="tabular shrink-0">
                    {fmtDateTime(f.at)} <span className="text-muted">· {(f.size / 1048576).toLocaleString('tr-TR', { maximumFractionDigits: 1 })} MB</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>
      {dirty && (
        // Ev çubuğu payını telefonda altındaki sekme çubuğu (AppShell) alır; burada yalnız iç boşluk
        <div className="sticky bottom-0 z-10 -mx-4 flex items-center gap-3 border-t border-[var(--admin-border)] bg-[var(--admin-surface)] px-4 py-3 sm:-mx-5 sm:px-5">
          <span className="text-[13px] text-[var(--admin-text-mute)]">Kaydedilmemiş değişiklik</span>
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
