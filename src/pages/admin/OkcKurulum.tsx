import { useQueryClient } from '@tanstack/react-query';
import { Cable, CheckCircle2, Circle, Loader2, MinusCircle, RotateCw, Save, Wand2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { TOKEN_MEAL_OPERATORS, TOKEN_PAYMENT_APPS, isMealOperator } from '@shared/yemek-karti';
import { Button } from '@/components/ui/Button';
import { Field, Input, Select, Toggle } from '@/components/ui/Field';
import { Notice } from '@/components/ui/misc';
import { Badge, Card, DefRow } from '@/components/admin/ui';
import { errorMessage, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

/**
 * Yazarkasa kurulumunun tek düğmeli parçaları (Yönetim › Yazarkasa POS): Token kablolu kartı (durum, "Kurulumu yap",
 * kablo takılınca kendiliğinden bağlanma), Pavo'yu tek düğmeyle kurma ve yemek kartlarının cihazdaki karşılığı.
 * Ayrıntı: docs/04-YAZARKASA.md §8.6, §9.
 */

export type StepStatus = 'bekliyor' | 'suruyor' | 'tamam' | 'atlandi' | 'hata';
export interface SetupRun {
  device: 'tokenkablo' | 'pavo';
  running: boolean;
  ok: boolean | null;
  startedAt: number;
  finishedAt: number | null;
  steps: { key: string; label: string; status: StepStatus; detail: string | null }[];
}
export type KabloPhase = 'kapali' | 'desteklenmiyor' | 'kurulum' | 'baslatiliyor' | 'bekliyor' | 'baglaniyor' | 'bagli' | 'hata';
export interface TokenKabloStatus {
  phase: KabloPhase;
  message: string | null;
  fiscalId: string | null;
  model: 'X30TR' | '300TR' | null;
  sections: { sectionNo: number; name: string; taxPercent: number }[];
  paymentApps: number[];
  connectedAt: number | null;
  setup: SetupRun | null;
  /** Cihaz bağlandı ama bağlantı kendiliğinden geçmedi: neden (eğitim günü açık, başka cihaz seçili) */
  held?: string | null;
}

const PHASE: Record<KabloPhase, { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' | 'info' }> = {
  kapali: { label: 'Kapalı', tone: 'neutral' },
  desteklenmiyor: { label: 'Windows gerekli', tone: 'neutral' },
  kurulum: { label: 'Kurulum gerekli', tone: 'warning' },
  baslatiliyor: { label: 'Başlıyor', tone: 'info' },
  bekliyor: { label: 'Kablo bekleniyor', tone: 'warning' },
  baglaniyor: { label: 'Bağlanıyor', tone: 'info' },
  bagli: { label: 'Bağlı', tone: 'success' },
  hata: { label: 'Hata', tone: 'danger' },
};

/** Kurulum adımları: durum simgesi, ad, ayrıntı (hata kırmızı); sıra listeyle söylenir */
export function SetupSteps({ run }: { run: SetupRun }) {
  return (
    <ol className="space-y-2" aria-live="polite">
      {run.steps.map((st) => (
        <li key={st.key} className="flex gap-2.5 text-sm">
          <span className="mt-0.5 shrink-0">
            {st.status === 'tamam' ? (
              <CheckCircle2 aria-label="Tamam" className="size-4 text-[var(--admin-success)]" />
            ) : st.status === 'hata' ? (
              <XCircle aria-label="Hata" className="size-4 text-[var(--admin-danger-ink)]" />
            ) : st.status === 'suruyor' ? (
              <Loader2 aria-label="Sürüyor" className="size-4 animate-spin text-[var(--admin-primary)] motion-reduce:animate-none" />
            ) : st.status === 'atlandi' ? (
              <MinusCircle aria-label="Gerekmedi" className="size-4 text-[var(--admin-text-mute)]" />
            ) : (
              <Circle aria-label="Bekliyor" className="size-4 text-[var(--admin-border-field)]" />
            )}
          </span>
          <span className="min-w-0">
            <span className={cn('font-medium', st.status === 'bekliyor' ? 'text-[var(--admin-text-mute)]' : 'text-[var(--admin-text)]')}>{st.label}</span>
            {st.status === 'atlandi' && <span className="text-[var(--admin-text-mute)]"> · gerekmedi</span>}
            {st.detail && <span className={cn('block text-[13px] [overflow-wrap:anywhere]', st.status === 'hata' ? 'text-[var(--admin-danger-ink)]' : 'text-[var(--admin-text-soft)]')}>{st.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}

/**
 * Token kablolu (Beko 300TR, X30TR): durum, cihaz, "Kurulumu yap" (Visual C++, Token kütüphanesi, köprü, gerekirse
 * sürücü, kısımlar, yemek kartları, bağlantı) ve "kablo takılınca kendiliğinden bağlan". Kurulum arka planda sürer;
 * kart durum sorgusunu sık yeniler
 */
export function TokenKabloCard({ status, active, oto, onOto, savingOto }: { status: TokenKabloStatus; active: boolean; oto: boolean; onOto: (v: boolean) => void; savingOto: boolean }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState<'kur' | 'yeniden' | null>(null);
  const run = status.setup;
  const running = !!run?.running;
  // Kurulum sürerken ve cihaz bağlanırken durum 1,5 sn'de bir yenilenir (canlı akış da yeniler)
  useEffect(() => {
    if (!running && status.phase !== 'baslatiliyor' && status.phase !== 'baglaniyor') return;
    const t = setInterval(() => void qc.invalidateQueries({ queryKey: ['okc', 'status'] }), 1500);
    return () => clearInterval(t);
  }, [running, status.phase, qc]);

  const act = async (what: 'kur' | 'yeniden') => {
    if (busy) return;
    setBusy(what);
    try {
      await post(what === 'kur' ? '/okc/token-kablo/kur' : '/okc/token-kablo/yeniden');
      if (what === 'yeniden') toast.ok('Token köprüsü yeniden başlatıldı');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
      void qc.invalidateQueries({ queryKey: ['okc'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    }
  };
  const phase = PHASE[status.phase];
  const apps = status.paymentApps.map((id) => TOKEN_PAYMENT_APPS[id] ?? `Uygulama ${id}`);
  return (
    <Card
      title="Token kablolu (Beko 300TR, X30TR)"
      subtitle="Cihaz kasa bilgisayarına kabloyla bağlanır; internet ve Token hesabı gerekmez"
      actions={
        <Badge tone={phase.tone} dot>
          {phase.label}
        </Badge>
      }
      bodyClassName="space-y-4 text-sm"
    >
      {status.phase === 'bagli' ? (
        <div className="max-w-2xl">
          <DefRow label="Cihaz">
            <span className="tabular break-all">
              {status.model ?? 'Token'}
              {status.fiscalId ? ` · ${status.fiscalId}` : ''}
            </span>
          </DefRow>
          {status.sections.length > 0 && (
            <DefRow label="Kısımlar">
              <span className="[overflow-wrap:anywhere]">{status.sections.map((x) => `${x.sectionNo} ${x.name} %${x.taxPercent / 100}`).join(' · ')}</span>
            </DefRow>
          )}
          {apps.length > 0 && (
            <DefRow label="Ödeme uygulamaları">
              <span className="[overflow-wrap:anywhere]">{apps.join(', ')}</span>
            </DefRow>
          )}
        </div>
      ) : (
        status.message && <p className="text-[var(--admin-text-soft)] [overflow-wrap:anywhere]">{status.message}</p>
      )}
      {!active && status.phase === 'bagli' && (
        <Notice tone="info">{status.held ? `${status.held}. “Kurulumu yap” bağlantıyı hemen Token kabloluya geçirir` : 'Cihaz bağlı ama bağlantı başka cihazda: “Kurulumu yap” bağlantıyı Token kabloluya geçirir'}</Notice>
      )}
      {run && (
        <div className="rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-4 ring-1 ring-inset ring-[var(--admin-border)]">
          <p className="mb-3 text-xs font-medium text-[var(--admin-text-mute)]">{running ? 'Kurulum sürüyor' : run.ok ? 'Kurulum tamamlandı' : 'Kurulum yarım kaldı'}</p>
          <SetupSteps run={run} />
        </div>
      )}
      <Toggle
        block
        className="max-w-2xl"
        checked={oto}
        disabled={savingOto}
        onChange={onOto}
        label="Kablo takılınca kendiliğinden bağlan"
        hint="Cihaz takılınca kısımlar ve yemek kartları eşlenir; yazarkasa kapalıysa ya da eğitim cihazındaysa (gün açık değilken) bağlantı Token kabloluya geçer"
      />
      <div className="flex flex-wrap gap-2 border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:grow">
        <Button variant="primary" icon={<Wand2 className="size-4" />} loading={busy === 'kur' || running} disabled={!!busy || running || status.phase === 'desteklenmiyor'} onClick={() => void act('kur')}>
          Kurulumu yap
        </Button>
        {(status.phase === 'bekliyor' || status.phase === 'hata' || status.phase === 'bagli') && (
          <Button icon={<RotateCw className="size-4" />} loading={busy === 'yeniden'} disabled={!!busy || running} onClick={() => void act('yeniden')}>
            Köprüyü yeniden başlat
          </Button>
        )}
      </div>
      <p className="flex gap-2 text-xs text-muted">
        <Cable aria-hidden="true" className="mt-px size-3.5 shrink-0" />
        <span>
          300TR: Menü › Ayarlar › Harici Cihaz Modu › GMP3 › TOKENX CONNECT, kablo beşikte RS232’de, cihaz satış ekranında. X30TR: kablo soldaki Type-C’de, Satış Uygulamaları’ndan
          “TokenX Connect Uygulaması (Kablolu)” açık; cihazdaki izin sorusunu onaylayın
        </span>
      </p>
    </Card>
  );
}

/**
 * Pavo'yu tek düğmeyle kur: seri no yazılır (cihazdan okunamaz), gerisi kendiliğinden: ağda bul, kaydet, Pavo'ya geç,
 * eşleştir (cihazda onay), dene, yemek kartı ödeme araçlarını eşle
 */
export function PavoQuickSetup({ serial: initial, className }: { serial?: string | null; className?: string }) {
  const qc = useQueryClient();
  const [serial, setSerial] = useState(initial ?? '');
  const [address, setAddress] = useState('');
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<SetupRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    if (busy) return;
    if (serial.trim().length < 3) return setError('Seri numarasını yazın');
    setBusy(true);
    setError(null);
    setRun(null);
    try {
      const r = await post<{ run: SetupRun }>('/okc/pavo/kur', { serial: serial.trim(), address: address.trim() || null });
      setRun(r.run);
      if (r.run.ok) toast.ok('Pavo kuruldu ve eşleştirildi');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
      void qc.invalidateQueries({ queryKey: ['okc'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    }
  };
  return (
    <form
      className={cn('max-w-2xl space-y-4', className)}
      onSubmit={(e) => {
        e.preventDefault();
        void go();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Seri numarası" hint="Cihazda Terminal Ayarları › Seri Numarası (PAV ile başlar)" error={error === 'Seri numarasını yazın' ? error : null}>
          <Input value={serial} onChange={(e) => setSerial(e.target.value.toUpperCase())} placeholder="PAV860…" autoCapitalize="characters" spellCheck={false} className="tabular" />
        </Field>
        <Field label="IP adresi (isteğe bağlı)" hint="Boşsa cihaz ağda aranır">
          <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="192.168.1.50" inputMode="url" autoCapitalize="none" spellCheck={false} className="tabular" />
        </Field>
      </div>
      {error && error !== 'Seri numarasını yazın' && (
        <Notice tone="danger" className="text-[13px] [overflow-wrap:anywhere]">
          {error}
        </Notice>
      )}
      {run && (
        <div className="rounded-[var(--r-tile)] bg-[var(--admin-surface-2)] p-4 ring-1 ring-inset ring-[var(--admin-border)]">
          <SetupSteps run={run} />
        </div>
      )}
      <div className="flex flex-wrap gap-2 max-sm:[&>*]:grow">
        <Button type="submit" variant="primary" icon={<Wand2 className="size-4" />} loading={busy}>
          Pavo’yu kur
        </Button>
      </div>
      {busy && <p className="text-xs text-muted">Cihaz aranıyor ve eşleştiriliyor; cihazdaki onay ekranını onaylayın (en çok 2 dakika)</p>}
    </form>
  );
}

/**
 * Yemek kartları cihazda: her yemek kartı ödeme türünün cihazdaki karşılığı. Token'da yemek kartı uygulaması (operatör;
 * kanalı bilinen kart kendiliğinden), Pavo'da cihazın ödeme aracı (cihazın listesinden; eşlenmeyen kart cihaza gitmez)
 */
export function MealCardMap({
  provider,
  operatorMethods,
  pavoMediatorMethods,
  mediators,
}: {
  provider: 'tokenkablo' | 'tokenx' | 'pavo';
  operatorMethods: Record<string, string>;
  pavoMediatorMethods: Record<string, string>;
  mediators: { id: number | null; name: string | null }[];
}) {
  const boot = useBoot();
  const qc = useQueryClient();
  const meal = boot.paymentMethods.filter((m) => m.kind === 'yemek');
  const pavo = provider === 'pavo';
  const current = pavo ? pavoMediatorMethods : operatorMethods;
  // Ödeme türü → cihazdaki no (elle eşleme; Token'da yoksa kanalından)
  const initial = () =>
    Object.fromEntries(
      meal.map((m) => {
        const hit = Object.entries(current).find(([, id]) => id === m.id)?.[0];
        const byChannel = !pavo && m.channel && TOKEN_MEAL_OPERATORS[m.channel] != null ? String(TOKEN_MEAL_OPERATORS[m.channel]) : '';
        return [m.id, hit ?? byChannel];
      }),
    );
  const [sel, setSel] = useState<Record<string, string>>(initial);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!dirty) setSel(initial());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, dirty, boot.paymentMethods]);
  if (!meal.length) return null;
  const options: { value: string; label: string }[] = pavo
    ? mediators.filter((x) => x.id != null && x.id !== 1 && x.id !== 2).map((x) => ({ value: String(x.id), label: `${x.id} · ${x.name ?? 'Adsız'}` }))
    : Object.entries(TOKEN_PAYMENT_APPS)
        .filter(([id]) => isMealOperator(Number(id)))
        .map(([id, name]) => ({ value: id, label: name }));
  const save = async () => {
    if (saving) return;
    const next: Record<string, string> = {};
    for (const [methodId, no] of Object.entries(sel)) if (no) next[no] = methodId;
    // Aynı cihaz no'su iki karta verilmez
    if (Object.keys(next).length !== Object.values(sel).filter(Boolean).length) return toast.err('Aynı cihaz karşılığı iki yemek kartına verilemez');
    setSaving(true);
    try {
      const out = await put('/okc/settings', pavo ? { pavoMediatorMethods: next } : { operatorMethods: { ...Object.fromEntries(Object.entries(operatorMethods).filter(([, id]) => !meal.some((m) => m.id === id))), ...next } });
      qc.setQueryData(['okc', 'status'], out);
      setDirty(false);
      toast.ok('Yemek kartı eşlemesi kaydedildi');
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Card
      title="Yemek kartları cihazda"
      subtitle={
        pavo
          ? 'Eşlenen yemek kartı kasada seçilince cihaza o ödeme aracıyla gider; eşlenmeyen kart AsilPOS’a yazılır. Liste cihazdan gelir (“Bağlantıyı dene”)'
          : 'Kasada seçilen yemek kartı cihazda o uygulamayla açılır ve bilgi fişi kesilir; eşlenmezse kasiyer cihazda seçer'
      }
      bodyClassName="space-y-4"
    >
      {pavo && !options.length ? (
        <p className="text-sm text-muted">Cihazın ödeme araçları henüz okunmadı: Pavo kartında “Bağlantıyı dene”ye basın</p>
      ) : (
        <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
          {meal.map((m) => (
            <Field key={m.id} label={m.name}>
              <Select
                value={sel[m.id] ?? ''}
                onChange={(e) => {
                  setSel({ ...sel, [m.id]: e.target.value });
                  setDirty(true);
                }}
              >
                <option value="">{pavo ? 'Cihaza gitmez' : 'Cihazda seçilir'}</option>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </Field>
          ))}
        </div>
      )}
      {(!pavo || options.length > 0) && (
        <div className="flex border-t border-[var(--admin-divider)] pt-4 max-sm:[&>*]:flex-1">
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={saving || !dirty} onClick={() => void save()}>
            Eşlemeyi kaydet
          </Button>
        </div>
      )}
    </Card>
  );
}
