import { useQueryClient } from '@tanstack/react-query';
import { ExternalLink, MonitorPlay, Plus, Save, X } from 'lucide-react';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CUSTOMER_DISPLAY_THEMES, type CustomerDisplaySettings, type CustomerDisplayTheme, type DisplayStateDTO } from '@shared/types';
import { Card, CODE, PageHeader, Segmented } from '@/components/admin/ui';
import { CustomerDisplayView, DISPLAY_DEFAULTS } from '@/components/display/CustomerDisplayView';
import { Button, buttonClass, IconButton } from '@/components/ui/Button';
import { Field, Input, Toggle } from '@/components/ui/Field';
import { errorMessage, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { useTick } from '@/lib/hooks';
import { toast } from '@/lib/toast';
import { useUnsavedGuard } from '@/lib/unsavedGuard';

const THEMES: Record<CustomerDisplayTheme, { label: string; hint: string; swatch: string; ink: string }> = {
  gece: { label: 'Gece', hint: 'Loş salonda göz almaz', swatch: 'radial-gradient(70% 70% at 50% 40%, #1d6d56 0%, #0f0e0d 75%)', ink: '#fbf6f1' },
  porselen: { label: 'Porselen', hint: 'Gün ışığında, sitenin zemini', swatch: '#f7f3ed', ink: '#211c18' },
  yesil: { label: 'Ev yeşili', hint: 'Marka yüzeyi, krem yazı', swatch: 'radial-gradient(130% 95% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)', ink: '#fbf6f1' },
};

type Preview = 'karsilama' | 'siparis' | 'tesekkur';
const SAMPLE: Record<Preview, DisplayStateDTO> = {
  karsilama: { kind: 'idle', at: 0 },
  siparis: {
    kind: 'order',
    at: 0,
    label: 'Masa 4',
    lines: [
      { name: 'Latte', size: 'Büyük', qty: 2, options: 'Yulaf sütü', total: 49000 },
      { name: "L'Affogato", size: null, qty: 1, options: '', total: 28000 },
      { name: 'San Sebastian', size: null, qty: 1, options: '', total: 26000 },
    ],
    discount: 0,
    service: 0,
    total: 103000,
    paid: 0,
    due: 103000,
  },
  tesekkur: { kind: 'thanks', at: 0, total: 103000, call: 'No 34' },
};

/** 1280×720'lik ekranı kabın genişliğine ölçekleyen çerçeve: önizleme gerçek ekranın birebir küçüğüdür */
function ScaledScreen({ children }: { children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    if (!box.current) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / 1280));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative aspect-video w-full overflow-hidden rounded-2xl border border-[var(--admin-border)] bg-[var(--admin-surface-2)] shadow-[var(--shadow-card)]">
      <div className="absolute left-0 top-0 h-[720px] w-[1280px] origin-top-left" style={{ transform: `scale(${scale})` }} aria-hidden="true" inert>
        {children}
      </div>
    </div>
  );
}

/**
 * Yönetim › Müşteri ekranı: iki ekranlı kasanın müşteriye dönük ekranı. Tema, karşılama ve teşekkür metni, dönen
 * duyurular, karekod ve saat; sağda gerçek ekranın canlı önizlemesi (karşılama, sipariş, teşekkür). Kayıt bütün
 * ayarı yazar, ekran yarım dakika içinde yeni görünüme geçer.
 */
export default function DisplayAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const saved = { ...DISPLAY_DEFAULTS, ...boot.settings.customerDisplay };
  const [draft, setDraft] = useState<CustomerDisplaySettings>(saved);
  const [preview, setPreview] = useState<Preview>('karsilama');
  const [newMessage, setNewMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const [tried, setTried] = useState(false);
  const now = useTick(30_000);
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  useUnsavedGuard(dirty);
  // Başka bir cihaz kaydederse (canlı ayar olayı) ve burada değişiklik yoksa taslak yenilenir
  const savedKey = JSON.stringify(boot.settings.customerDisplay);
  useEffect(() => {
    if (!dirty) setDraft({ ...DISPLAY_DEFAULTS, ...boot.settings.customerDisplay });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  const set = <K extends keyof CustomerDisplaySettings>(k: K, v: CustomerDisplaySettings[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const qrError = draft.qrUrl.trim() && !/^https?:\/\/\S+$/.test(draft.qrUrl.trim()) ? 'Adres http:// ya da https:// ile başlamalı' : null;
  const addMessage = () => {
    const m = newMessage.trim();
    if (!m || draft.messages.length >= 6) return;
    set('messages', [...draft.messages, m.slice(0, 90)]);
    setNewMessage('');
  };
  const save = async () => {
    if (qrError) {
      setTried(true);
      return;
    }
    setSaving(true);
    try {
      const body: CustomerDisplaySettings = {
        ...draft,
        welcomeTitle: draft.welcomeTitle.trim(),
        welcomeSubtitle: draft.welcomeSubtitle.trim(),
        thanksTitle: draft.thanksTitle.trim(),
        qrUrl: draft.qrUrl.trim(),
        qrLabel: draft.qrLabel.trim(),
        messages: draft.messages.map((m) => m.trim()).filter(Boolean),
      };
      await put('/admin/settings', { customerDisplay: body });
      await Promise.all([qc.invalidateQueries({ queryKey: ['bootstrap'] }), qc.invalidateQueries({ queryKey: ['display-config'] })]);
      toast.ok('Müşteri ekranı kaydedildi; ekran yarım dakika içinde yenilenir');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };
  const origin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <>
      <PageHeader
        title="Müşteri ekranı"
        description="İki ekranlı kasada müşteriye dönük ekran: görünüm, karşılama ve teşekkür metni, duyurular ve karekod"
        actions={
          <>
            <a href="/musteri-ekrani?ekran=kasa" target="_blank" rel="noreferrer" className={buttonClass('secondary', 'md')}>
              <ExternalLink className="size-4" aria-hidden="true" />
              Ekranı aç
            </a>
            <Button variant="primary" icon={<Save className="size-4" />} loading={saving} disabled={!dirty} onClick={() => void save()}>
              Kaydet
            </Button>
          </>
        }
      />
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <div className="min-w-0 space-y-4">
          <Card title="Görünüm" subtitle="Tema ekranın bütününü değiştirir; tutar paneli her temada markanın yüzeyidir">
            <div role="radiogroup" aria-label="Tema" className="grid gap-3 sm:grid-cols-3">
              {CUSTOMER_DISPLAY_THEMES.map((t) => {
                const on = draft.theme === t;
                return (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('theme', t)}
                    className={cn(
                      'group flex flex-col overflow-hidden rounded-2xl border text-left transition-[border-color,box-shadow] duration-150',
                      on ? 'border-[var(--admin-primary)] shadow-[0_0_0_3px_var(--admin-primary-soft)]' : 'border-[var(--admin-border)] hover:border-[var(--admin-border-field)]',
                    )}
                  >
                    <span className="grid h-20 place-items-center border-b border-[var(--admin-border)]" style={{ background: THEMES[t].swatch, color: THEMES[t].ink }}>
                      <span className="font-headline text-lg font-extrabold tracking-[-0.03em]">Hoş geldiniz</span>
                    </span>
                    <span className="px-3 py-2.5">
                      <span className="block text-sm font-semibold text-[var(--admin-text)]">{THEMES[t].label}</span>
                      <span className="block text-xs text-[var(--admin-text-mute)]">{THEMES[t].hint}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="mt-4 space-y-3 border-t border-[var(--admin-divider)] pt-4">
              <Toggle block checked={draft.showClock} onChange={(v) => set('showClock', v)} label="Saat" hint="Sağ üstte büyük saat" />
              <Toggle block checked={draft.showOptions} onChange={(v) => set('showOptions', v)} label="Seçenekleri göster" hint="Siparişte süt, şurup gibi seçimler satırın altında" />
            </div>
          </Card>

          <Card title="Metinler" subtitle="Boş başlık varsayılana döner">
            <div className="space-y-4">
              <Field label="Karşılama başlığı" hint={`${draft.welcomeTitle.length}/60`}>
                <Input value={draft.welcomeTitle} maxLength={60} placeholder={DISPLAY_DEFAULTS.welcomeTitle} onChange={(e) => set('welcomeTitle', e.target.value)} />
              </Field>
              <Field label="Alt satır" hint="slogan; boşsa yok">
                <Input value={draft.welcomeSubtitle} maxLength={90} placeholder="Drink it. Eat the cup." onChange={(e) => set('welcomeSubtitle', e.target.value)} />
              </Field>
              <Field label="Teşekkür başlığı" hint={`${draft.thanksTitle.length}/60`}>
                <Input value={draft.thanksTitle} maxLength={60} placeholder={DISPLAY_DEFAULTS.thanksTitle} onChange={(e) => set('thanksTitle', e.target.value)} />
              </Field>
            </div>
          </Card>

          <Card title="Duyurular" subtitle="Boşta ve sipariş sırasında 6 saniyede bir döner; en çok 6">
            {draft.messages.length > 0 && (
              <ul className="mb-3 space-y-2">
                {draft.messages.map((m, i) => (
                  <li key={`${i}-${m}`} className="flex items-center gap-2 rounded-xl border border-[var(--admin-border)] bg-[var(--admin-surface-2)] py-1 pl-3.5 pr-1 text-sm">
                    <span className="min-w-0 flex-1 truncate">{m}</span>
                    <IconButton label={`“${m}” duyurusunu kaldır`} size="sm" onClick={() => set('messages', draft.messages.filter((_, j) => j !== i))}>
                      <X className="size-4" />
                    </IconButton>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2">
              <Input
                value={newMessage}
                maxLength={90}
                disabled={draft.messages.length >= 6}
                placeholder={draft.messages.length >= 6 ? 'En çok 6 duyuru' : 'Ör. Happy hour 15:00-17:00, ikinci kahve yarı fiyat'}
                aria-label="Yeni duyuru"
                onChange={(e) => setNewMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addMessage();
                  }
                }}
              />
              <Button icon={<Plus className="size-4" />} disabled={!newMessage.trim() || draft.messages.length >= 6} onClick={addMessage}>
                Ekle
              </Button>
            </div>
          </Card>

          <Card title="Karekod" subtitle="Uygulama, menü, Wi-Fi ya da Instagram; adres boşsa çizilmez">
            <div className="space-y-4">
              <Field label="Adres" error={tried ? qrError : null}>
                <Input value={draft.qrUrl} inputMode="url" placeholder="https://laffogato.net" onChange={(e) => set('qrUrl', e.target.value)} />
              </Field>
              <Field label="Karekodun yanındaki yazı" hint={`${draft.qrLabel.length}/60`}>
                <Input value={draft.qrLabel} maxLength={60} placeholder="Uygulamayı indirin, damga kazanın" onChange={(e) => set('qrLabel', e.target.value)} />
              </Field>
            </div>
          </Card>
        </div>

        <div className="min-w-0 space-y-4 xl:sticky xl:top-4 xl:self-start">
          <Card
            title="Önizleme"
            subtitle="Gerçek ekranın birebir küçüğü; kaydetmeden görürsünüz"
            actions={
              <Segmented<Preview>
                label="Önizlenen durum"
                value={preview}
                onChange={setPreview}
                options={[
                  { value: 'karsilama', label: 'Karşılama' },
                  { value: 'siparis', label: 'Sipariş' },
                  { value: 'tesekkur', label: 'Teşekkür' },
                ]}
              />
            }
          >
            <ScaledScreen>
              <CustomerDisplayView state={SAMPLE[preview]} config={draft} businessName={boot.settings.businessName} now={now} />
            </ScaledScreen>
          </Card>
          <Card title="Kurulum" subtitle="İki ekranlı kasa ya da müşteriye dönük tablet">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-[var(--admin-text-soft)]">
              <li>
                İkinci ekranda tarayıcıyla <span className={CODE}>{origin}/musteri-ekrani?ekran=kasa</span> adresini tam ekran açın; personel girişi istemez.
              </li>
              <li>Kasada Adisyon › İşlemler › Müşteri ekranı'ndan aynı ekran adını seçin: adisyon, tutar ve teşekkür o ekrana gider.</li>
              <li>Birden çok kasa varsa her birine ayrı ad verin (ekran=kasa2).</li>
            </ol>
            <div className="mt-4 flex items-center gap-2 rounded-xl bg-[var(--admin-surface-2)] px-3.5 py-3 text-xs text-[var(--admin-text-mute)]">
              <MonitorPlay className="size-4 shrink-0" aria-hidden="true" />
              Ekran ayarı yarım dakikada bir okur; Kaydet'ten sonra yenilemeye gerek yok.
            </div>
          </Card>
        </div>
      </div>
    </>
  );
}
