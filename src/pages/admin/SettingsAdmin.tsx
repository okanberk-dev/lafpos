import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, DatabaseBackup, Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { parseTL, tl } from '@shared/money';
import { SERVICE_MODE_HINT, SERVICE_MODE_LABEL, SERVICE_MODES, type ServiceMode, serviceModeOf } from '@shared/service-mode';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea, Toggle } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { Card, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';

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
};

const lines = (a: string[]) => a.join('\n');
const fromLines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);

export default function SettingsAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const data = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => get<Settings>('/admin/settings') });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => get<{ dir: string; files: { name: string; size: number; at: number }[] }>('/admin/backups') });
  const [s, setS] = useState<Settings | null>(null);
  const [modeBusy, setModeBusy] = useState<ServiceMode | null>(null);
  useEffect(() => {
    if (data.data) setS(data.data);
  }, [data.data]);
  if (!s) return <PageLoading />;
  const set = (patch: Partial<Settings>) => setS({ ...s, ...patch });
  const mode = serviceModeOf(s);

  // Servis modu seçilince hemen uygulanır (yalnız bu alan gider): kasalar açılış verisiyle birlikte yenilenir
  const chooseMode = async (next: ServiceMode) => {
    if (next === mode || modeBusy) return;
    setModeBusy(next);
    try {
      await put('/admin/settings', { serviceMode: next });
      setS((cur) => (cur ? { ...cur, serviceMode: next } : cur));
      toast.ok(`Servis modu: ${SERVICE_MODE_LABEL[next]}`);
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setModeBusy(null);
    }
  };

  const save = async () => {
    try {
      // Senkron anahtarları ayrı yetkiyle (Site ve lafmaliyet ekranı) değişir; servis modu seçilince kendisi kaydedilir
      const rest = Object.fromEntries(Object.entries(s).filter(([k]) => k !== 'menuAutoSync' && k !== 'onlineOrdersSync' && k !== 'serviceMode'));
      await put('/admin/settings', rest);
      toast.ok('Ayarlar kaydedildi');
      qc.invalidateQueries({ queryKey: ['admin', 'settings'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };

  return (
    <div className="space-y-4">
      <PageHeader title="Ayarlar" actions={<Button variant="primary" icon={<Save className="size-4" />} onClick={save}>Kaydet</Button>} />
      {s.demoMode && (
        <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-warn-400 bg-warn-50 p-4 text-sm text-warn-700 dark:bg-warn-700/20 dark:text-warn-100">
          <span className="flex-1">Kurulum modu açık: giriş ekranında örnek PIN'ler görünüyor. Canlıya geçmeden önce Personel'den PIN'leri değiştirip bunu kapatın</span>
          <Toggle checked={s.demoMode} onChange={(v) => set({ demoMode: v })} label="Kurulum modu" />
        </div>
      )}
      <Card flush title="Servis modu" subtitle="Seçince hemen uygulanır; açılış ekranı, menü ve tezgâh satışı buna göre değişir">
        <div role="radiogroup" aria-label="Servis modu" className="grid gap-2 p-4 sm:grid-cols-3">
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
                  on ? 'border-primary bg-[var(--admin-primary-soft)]' : 'border-line bg-surface hover:border-[var(--admin-border-field)] hover:bg-surface-2',
                )}
              >
                <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border', on ? 'border-primary bg-primary text-primary-ink' : 'border-[var(--admin-border-strong)]')}>
                  {on && <Check className="size-3.5" strokeWidth={2.5} />}
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
            <Field label="Fiş altı" hint="adisyona 'mali değeri yoktur' kendiliğinden yazılır">
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
            <Toggle checked={s.keepAwake} onChange={(v) => set({ keepAwake: v })} label="Ekran kararmasın (kasa bilgisayarı, bar ve tablet ekranları)" />
            <Toggle checked={s.productImages} onChange={(v) => set({ productImages: v })} label="Ürün kartlarında görsel (sitedeki fotoğraf; kasa bilgisayarında saklanır)" />
            <div className="flex flex-wrap items-center gap-3">
              <Toggle checked={s.autoDayEnd} onChange={(v) => set({ autoDayEnd: v })} label="Otomatik gün sonu saat" />
              <Input type="number" min={0} max={23} value={s.autoDayEndHour} onChange={(e) => set({ autoDayEndHour: Number(e.target.value) || 0 })} className="w-20" />
              <span className="text-xs text-muted">açık adisyon varsa alınmaz; sayım sonra Kasa föyünden girilir</span>
            </div>
            <Field label="Hızlı nakit düğmeleri (₺, satır satır)">
              <Textarea value={s.quickCash.map((k) => String(k / 100)).join('\n')} onChange={(e) => set({ quickCash: fromLines(e.target.value).map((x) => parseTL(x) ?? 0).filter((x) => x > 0) })} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Servis ücreti (%)" hint="masa adisyonlarına">
                <Input type="number" min={0} max={30} value={s.serviceRate} onChange={(e) => set({ serviceRate: Number(e.target.value) || 0 })} />
              </Field>
              <Field label="Otomatik kilit (dk)" hint="0 = kapalı">
                <Input type="number" min={0} value={s.autoLockMinutes} onChange={(e) => set({ autoLockMinutes: Number(e.target.value) || 0 })} />
              </Field>
            </div>
          </div>
        </Card>
        <Card flush title="Nedenler">
          <div className="grid gap-3 p-4 sm:grid-cols-3">
            <Field label="İptal">
              <Textarea value={lines(s.voidReasons)} onChange={(e) => set({ voidReasons: fromLines(e.target.value) })} className="min-h-36" />
            </Field>
            <Field label="İkram">
              <Textarea value={lines(s.compReasons)} onChange={(e) => set({ compReasons: fromLines(e.target.value) })} className="min-h-36" />
            </Field>
            <Field label="İndirim">
              <Textarea value={lines(s.discountReasons)} onChange={(e) => set({ discountReasons: fromLines(e.target.value) })} className="min-h-36" />
            </Field>
          </div>
        </Card>
        <Card flush title={boot.integrations.localStamps ? 'Bar ekranı, karaoke, damga, uyarılar' : 'Bar ekranı, karaoke, uyarılar'}>
          <div className="grid grid-cols-2 gap-3 p-4">
            <Field label="Bar uyarı (dk)">
              <Input type="number" value={s.kitchenWarnMinutes} onChange={(e) => set({ kitchenWarnMinutes: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Bar alarm (dk)">
              <Input type="number" value={s.kitchenAlarmMinutes} onChange={(e) => set({ kitchenAlarmMinutes: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Oda faturalama adımı (dk)">
              <Input type="number" value={s.roomBillingStepMinutes} onChange={(e) => set({ roomBillingStepMinutes: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Oda en az (dk)">
              <Input type="number" value={s.roomMinimumMinutes} onChange={(e) => set({ roomMinimumMinutes: Number(e.target.value) || 0 })} />
            </Field>
            {/* Yerel damga kartı varsayılan kapalı, site bağlantısı kuruluyken hiç yok (tek sadakat programı uygulamada) */}
            {boot.integrations.localStamps && (
              <Field label="Hediye için damga">
                <Input type="number" value={s.stampGoal} onChange={(e) => set({ stampGoal: Number(e.target.value) || 1 })} />
              </Field>
            )}
            <Field label="Uyarı: indirim (%)">
              <Input type="number" value={s.alertDiscountPct} onChange={(e) => set({ alertDiscountPct: Number(e.target.value) || 1 })} />
            </Field>
            <Field label="Alarm: kasa farkı (₺)">
              <Input value={String(s.alertCashDiffKurus / 100)} onChange={(e) => set({ alertCashDiffKurus: parseTL(e.target.value || '0') ?? 0 })} inputMode="decimal" />
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
          <Button
            size="sm"
            icon={<DatabaseBackup className="size-4" />}
            onClick={async () => {
              try {
                await post('/admin/backups');
                toast.ok('Yedek alındı');
                backups.refetch();
              } catch (e) {
                toast.err(errorMessage(e));
              }
            }}
          >
            Şimdi yedek al
          </Button>
        }
      >
        <div className="p-4 text-sm">
          <p className="mb-2 text-muted">
            Her gün kendiliğinden alınır, son {s.backupKeep} gün tutulur. Klasör: <code className="rounded bg-surface-2 px-1">{backups.data?.dir}</code>. Bu klasörü haftada bir başka diske ya da buluta kopyalayın
          </p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {(backups.data?.files ?? []).slice(0, 8).map((f) => (
              <li key={f.name} className="flex justify-between px-3 py-2">
                <span>{f.name}</span>
                <span className="text-muted">
                  {(f.size / 1024 / 1024).toFixed(1)} MB · {fmtDateTime(f.at)}
                </span>
              </li>
            ))}
            {!backups.data?.files.length && <li className="px-3 py-3 text-muted">Henüz yedek yok</li>}
          </ul>
          <p className="mt-2 text-xs text-muted">Alarm eşiği şu an {tl(s.alertCashDiffKurus)}</p>
        </div>
      </Card>
    </div>
  );
}
