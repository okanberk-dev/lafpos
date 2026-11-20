import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MonitorSmartphone, PlugZap, Save, Webhook, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { confirmDialog, type ConfirmOptions } from '@/components/ui/Confirm';
import { Field, Input, Label } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { Card, CARD, CODE, PageHeader, Segmented, SetupNotes } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { cn } from '@/lib/cn';
import { joinMeta } from '@/lib/text';
import { toast } from '@/lib/toast';

interface OkcStatus {
  provider: 'kapali' | 'tokenx' | 'simulator';
  mode: 'anlik' | 'liste';
  sectionMap: Record<string, number>;
  operatorMethods: Record<string, string>;
  active: { label: string; configured: boolean; capabilities: { instant: boolean; list: boolean; splitPayment: boolean; docKinds: string[] } } | null;
  tokenx: { configured: boolean; terminalId: string | null; branchId: string | null; webhookUrl: string | null; webhookSecret: boolean };
  lastError: { message: string; at: number } | null;
}
interface TestResult {
  terminal: { terminalId?: string; branchId?: string; merchantId?: string; error?: string };
  sections: { sectionNo: number; name: string; taxPercent: number }[];
  suggestedSectionMap: Record<string, number>;
  terminals: { id: string; mode: number }[] | null;
}
type Provider = OkcStatus['provider'];
type Mode = OkcStatus['mode'];

/** Cihazda her zaman eşlenebilen oranlar; menüde başka bir oran varsa o da listelenir */
const RATES = ['1', '10', '20'];

const PROVIDER_LABEL: Record<Provider, string> = { kapali: 'Kapalı', simulator: 'Eğitim cihazı', tokenx: 'Token · Beko' };
const MODE_LABEL: Record<Mode, string> = { anlik: 'Kasada ödeme', liste: 'Masada ödeme' };
/** Ödeme yerinin anlamı; Token cihazında aynı mod ayrıca seçilir */
const MODE_HINT: Record<Mode, { what: string; token: string }> = {
  anlik: { what: 'Sepet hemen cihaza düşer, ödeme kasada alınır', token: 'Token cihazında “Sepet ödemesini hemen al” seçili olmalı' },
  liste: { what: 'Cihaz açık hesapları listeler, ödeme masada alınır', token: 'Token cihazında “Birden fazla sepeti listele” seçili olmalı' },
};
const DOC_LABEL: Record<string, string> = { okc_fis: 'Mali fiş', bilgi_fisi: 'Bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

/**
 * Bağlantı değişince sorulur: mali fiş buna bağlı. Kapatmak yıkıcı (kırmızı): adisyon cihaza gitmez, fişi kasiyer
 * yazarkasada elle keser; öteki seçimler bundan sonraki hesapların nereye gideceğini söyler
 */
const PROVIDER_CONFIRM: Record<Provider, ConfirmOptions> = {
  kapali: { title: 'Yazarkasa bağlantısı kapatılsın mı', body: 'Adisyonlar cihaza gitmez; mali fişi kasiyer yazarkasada elle keser', confirmLabel: 'Bağlantıyı kapat', tone: 'danger' },
  simulator: { title: 'Eğitim cihazına geçilsin mi', body: 'Hesaplar eğitim cihazı ekranına gider, mali fiş kesilmez; gerçek cihaz bağlanana kadar deneme ve eğitim için', confirmLabel: 'Eğitim cihazına geç', tone: 'primary' },
  tokenx: { title: 'Token cihazına geçilsin mi', body: 'Bundan sonraki hesaplar Token cihazına sepet olarak gider; ödeme ve mali fiş cihazda alınır', confirmLabel: 'Token’a geç', tone: 'primary' },
};

/** Bağlantısı henüz olmayan markalar: neden ve üreticiden ne istenecek (docs/04-OKC.md'de ayrıntı) */
const OTHER_VENDORS: { name: string; channel: string; state: string }[] = [
  { name: 'Hugin', channel: 'Cloud Link (TSM)', state: 'Açık belge eksik: satış sonucunun ödeme, Z ve fiş alanları istenecek' },
  { name: 'Pavo', channel: 'IP REST, bulut', state: 'Yalnız iş ortaklarına belge veriyor; e-Arşiv hesabı gerekir' },
  { name: 'Ingenico', channel: 'GMP-3 DLL (Windows)', state: 'Geliştirici programı ve sürüm başına kayıt gerekir' },
  { name: 'Verifone, Inpos, Profilo, PayGo, Vera', channel: 'TSM ya da kablolu', state: 'Açık belge yok; üreticiden istenecek' },
];

/** Token kurulumu: Token seçiliyse kartının hemen altında (eksikse açık), değilse sayfa sonunda kapalı */
function TokenSetup({ open }: { open?: boolean }) {
  return (
    <SetupNotes open={open}>
      <p>
        TokenX Connect bilgileri kasa bilgisayarının ayarlarına (<code className={CODE}>.env</code>) yazılır, sonra “Bağlantıyı dene”:
      </p>
      <pre className="overflow-x-auto rounded-lg bg-[var(--admin-surface-2)] p-3 font-mono text-xs leading-5 text-[var(--admin-text)]">{`TOKENX_AUTH_URL=     (Token’ın verdiği kimlik adresi)
TOKENX_BASKET_URL=   (sepet API adresi)
TOKENX_SETTINGS_URL= (client-settings adresi)
TOKENX_CLIENT_ID=
TOKENX_CLIENT_SECRET=
TOKENX_TERMINAL_ID=  (cihazdaki QR’da, AV/AT ile başlar)
TOKENX_BRANCH_ID=    (masada ödeme modu için)
TOKENX_WEBHOOK_SECRET= (en az 16 karakter)
LAFPOS_PUBLIC_URL=   (webhook için; yoksa durum sorgulanır)`}</pre>
      <p>
        Ayrıntı ve diğer markalar için üreticiden istenecekler: <code className={CODE}>docs/04-YAZARKASA.md</code>
      </p>
    </SetupNotes>
  );
}

export default function OkcAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['okc', 'status'], queryFn: () => get<OkcStatus>('/okc/status') });
  const [map, setMap] = useState<Record<string, string>>({});
  // Elle değiştirilen eşleme sunucudan gelen yenilemeyle (bağlantı ya da ödeme yeri kaydı, canlı akış) ezilmez
  const [mapDirty, setMapDirty] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  // Ayar kaydı (bağlantı, ödeme yeri, eşleme) ile Token'a giden istek (deneme, webhook) ayrı izlenir: bulut yanıt
  // vermezse deneme 10–40 sn sürer, o arada bağlantıyı kapatmak ya da eşlemeyi kaydetmek beklemez, dokunuş yutulmaz
  const [saving, setSaving] = useState<'map' | 'provider' | 'mode' | null>(null);
  const [checking, setChecking] = useState<'test' | 'webhook' | null>(null);

  useEffect(() => {
    if (status.data && !mapDirty) setMap(Object.fromEntries(Object.entries(status.data.sectionMap).map(([k, v]) => [k, String(v)])));
  }, [status.data, mapDirty]);

  const editMap = (next: Record<string, string>) => {
    setMap(next);
    setMapDirty(true);
  };
  /** Ayar kaydı: sunucu güncel durumu döndürür, ekran onunla hemen güncellenir (seçim bir an eski değerde kalmaz) */
  const save = async (body: Record<string, unknown>, done = 'Yazarkasa ayarı kaydedildi') => {
    try {
      const next = await put<OkcStatus>('/okc/settings', body);
      qc.setQueryData(['okc', 'status'], next);
      toast.ok(done);
      void qc.invalidateQueries({ queryKey: ['okc'] });
      void qc.invalidateQueries({ queryKey: ['bootstrap'] });
      return true;
    } catch (e) {
      toast.err(errorMessage(e));
      return false;
    }
  };
  const saveMap = async () => {
    if (saving) return;
    setSaving('map');
    if (await save({ sectionMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])) }, 'Kısım eşlemesi kaydedildi')) setMapDirty(false);
    setSaving(null);
  };
  const registerWebhook = async () => {
    setChecking('webhook');
    try {
      const r = await post<{ url: string }>('/okc/webhook/register');
      toast.ok(`Webhook kaydedildi: ${r.url}`);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };
  const runTest = async () => {
    setChecking('test');
    try {
      const r = await post<TestResult>('/okc/test');
      setTest(r);
      toast.ok('Token bağlantısı çalışıyor');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setChecking(null);
    }
  };

  const header = <PageHeader title="Yazarkasa POS" description="Bağlantı açıkken adisyon cihaza sepet olarak gider; ödeme ve mali fiş cihazda alınır" />;
  if (!status.data)
    return (
      <div className="space-y-4">
        {header}
        {status.isError ? (
          <ErrorState className={CARD} title="Yazarkasa durumu alınamadı" error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />
        ) : (
          <div role="status" aria-label="Yükleniyor…" className="space-y-4">
            <Skeleton className="h-40 rounded-2xl" />
            <Skeleton className="h-28 rounded-2xl" />
          </div>
        )}
      </div>
    );
  const s = status.data;

  // Bağlantı tek dokunuşla değişmez: sorulur, istek sürerken seçim kilitli (ikinci dokunuş ikinci istek göndermez).
  // Token denemesi ve webhook kaydı kilitlemez: bulut yanıt vermezken de bağlantı kapatılabilir
  const setProvider = async (v: Provider) => {
    if (v === s.provider || saving) return;
    if (!(await confirmDialog(PROVIDER_CONFIRM[v]))) return;
    setSaving('provider');
    await save({ provider: v }, v === 'kapali' ? 'Yazarkasa bağlantısı kapatıldı' : `Yazarkasa bağlantısı: ${PROVIDER_LABEL[v]}`);
    setSaving(null);
  };
  const setMode = async (v: Mode) => {
    if (v === s.mode || saving) return;
    setSaving('mode');
    await save({ mode: v }, `Ödeme yeri: ${MODE_LABEL[v]}`);
    setSaving(null);
  };
  // Ayarlar sırayla kaydedilir: biri kaydedilirken iki ray da soluk ve kilitli (dokunuş sessizce yutulmaz, kilit görünür)
  const locked = (key: 'provider' | 'mode') => ({ 'aria-busy': saving === key || undefined, className: cn('transition-opacity duration-150', saving && 'pointer-events-none opacity-60') });

  const caps = s.active
    ? [
        s.active.capabilities.instant && 'Kasada ödeme',
        s.active.capabilities.list && 'Masada ödeme',
        s.active.capabilities.splitPayment && 'Bölünmüş ödeme',
        ...s.active.capabilities.docKinds.map((d) => DOC_LABEL[d] ?? d),
      ].filter((t): t is string => !!t)
    : [];

  // Menüde kullanılan oranlar (küçükten büyüğe) cihazda eşlenmeli: eşlenmeyen oranlı hesap kasada gönderilemez
  const usedRates = [...new Set(boot.products.map((p) => String(p.kdvRate)))].filter((r) => r !== '0').sort((a, b) => Number(a) - Number(b));
  const rates = [...new Set([...RATES, ...usedRates])].sort((a, b) => Number(a) - Number(b));
  const missing = usedRates.filter((r) => !map[r]);
  const invalid = rates.filter((r) => map[r] && Number(map[r]) < 1);

  return (
    <div className="space-y-4">
      {header}
      {/* Bağlantı ve ödeme yeri tek seçimli ray (Paket platformlarındaki mod seçimi gibi): oklar gezer, seçim Enter ya da
          dokunuşla; telefonda ray tam genişlik, sığmayan seçenek alt satıra iner */}
      <Card title="Bağlantı" bodyClassName="space-y-4">
        <div {...locked('provider')}>
          <Segmented
            label="Yazarkasa bağlantısı"
            value={s.provider}
            onChange={(v) => void setProvider(v)}
            options={(['kapali', 'simulator', 'tokenx'] as const).map((value) => ({ value, label: PROVIDER_LABEL[value] }))}
          />
        </div>
        {s.provider === 'kapali' && <p className="text-sm text-muted">Adisyon cihaza gitmez; mali fişi kasiyer yazarkasada elle keser</p>}
        {caps.length > 0 && (
          // Cihazın yapabildikleri sakin bir onay listesi (kutu kalabalığı değil): yeşil tik, soluk yazı
          <div>
            <span className="text-xs font-medium text-[var(--admin-text-mute)]">Cihaz destekliyor</span>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1.5">
              {caps.map((t) => (
                <li key={t} className="inline-flex items-center gap-1.5 text-[13px] text-[var(--admin-text-soft)]">
                  <CheckCircle2 aria-hidden="true" className="size-3.5 shrink-0 text-[var(--admin-success)]" />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        )}
        {s.provider === 'simulator' && (
          <p className="text-sm text-muted">
            Gerçek cihaz bağlanana kadar akışı denemek ve personeli eğitmek için; sepetler <Link to="/cihaz" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">eğitim cihazı</Link> ekranında ödenir
          </p>
        )}
        {s.provider !== 'kapali' && (
          <div>
            <Label>Ödeme yeri</Label>
            <div {...locked('mode')}>
              <Segmented label="Ödeme yeri" value={s.mode} onChange={(v) => void setMode(v)} options={(['anlik', 'liste'] as const).map((value) => ({ value, label: MODE_LABEL[value] }))} />
            </div>
            {/* Seçime göre tek cümle; Token cihazının kendi ayarı yalnız Token seçiliyken */}
            <p className="mt-1.5 text-xs text-muted">{s.provider === 'tokenx' ? `${MODE_HINT[s.mode].what}; ${MODE_HINT[s.mode].token}` : MODE_HINT[s.mode].what}</p>
          </div>
        )}
      </Card>

      {s.provider === 'tokenx' && (
        <>
          <Card title="TokenX Connect (bulut)" bodyClassName="space-y-3 text-sm">
            <div className="flex items-center gap-2">
              {s.tokenx.configured ? <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-success)]" /> : <XCircle aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-danger-ink)]" />}
              {s.tokenx.configured ? joinMeta(['Bilgiler tanımlı', s.tokenx.terminalId && `terminal ${s.tokenx.terminalId}`, s.tokenx.branchId && `şube ${s.tokenx.branchId}`]) : 'Token bilgileri eksik; kurulum adımları aşağıda'}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon={<PlugZap className="size-4" />} loading={checking === 'test'} disabled={!s.tokenx.configured} onClick={() => void runTest()}>
                Bağlantıyı dene
              </Button>
              <Button icon={<Webhook className="size-4" />} loading={checking === 'webhook'} disabled={!s.tokenx.configured || !s.tokenx.webhookUrl || !s.tokenx.webhookSecret} onClick={() => void registerWebhook()}>
                Webhook’u Token’a kaydet
              </Button>
            </div>
            <p className="text-xs text-muted">
              {s.tokenx.webhookUrl ? `Webhook adresi: ${s.tokenx.webhookUrl}` : 'Webhook adresi yok: kafedeki sunucu internetten erişilemiyorsa LafPOS sepet durumunu 2,5 sn’de bir sorgular; sonuç yine gelir'}
            </p>
            {s.lastError && (
              <Notice tone="danger" title={`Son hata · ${fmtDateTime(s.lastError.at)}`} className="text-[13px]">
                {s.lastError.message}
              </Notice>
            )}
            {test && (
              <div className="rounded-xl border border-line p-3 text-xs">
                <div className="mb-1 font-semibold">Cihaz</div>
                <div>{test.terminal.error ? `Terminal bilgisi alınamadı: ${test.terminal.error}` : `${test.terminal.terminalId} · şube ${test.terminal.branchId}`}</div>
                <div className="mb-1 mt-2 font-semibold">Kısımlar (KDV)</div>
                <ul>
                  {test.sections.map((x) => (
                    <li key={x.sectionNo}>
                      {x.sectionNo}. {x.name} · %{x.taxPercent / 100}
                    </li>
                  ))}
                </ul>
                <Button size="sm" className="mt-2" onClick={() => editMap(Object.fromEntries(Object.entries(test.suggestedSectionMap).map(([k, v]) => [k, String(v)])))}>
                  Önerilen eşlemeyi kullan
                </Button>
              </div>
            )}
          </Card>
          {/* Bilgiler eksikken açık gelir: o an gereken tek şey bu, sayfanın sonunda aranmaz */}
          <TokenSetup open={!s.tokenx.configured} />
        </>
      )}

      {s.provider !== 'kapali' && (
        <Card title="KDV oranı → cihazdaki kısım" bodyClassName="space-y-3">
          <p className="text-sm text-muted">
            Her KDV oranı cihazda tanımlı bir kısma (departman) gider. {usedRates.length ? `Menüde kullanılan oranlar: ${usedRates.map((r) => `%${r}`).join(', ')}` : 'Menüde KDV oranı tanımlı ürün yok'}
          </p>
          <div className="grid grid-cols-3 gap-3 sm:max-w-md">
            {rates.map((r) => {
              const used = usedRates.includes(r);
              return (
                <Field
                  key={r}
                  // İki satırlık etiket her alanda aynı: dar ekranda kırılan ipucu alanları kaydırmaz
                  label={
                    <>
                      <span className="block">%{r} KDV</span>
                      <span className="block text-xs font-normal text-muted">{used ? 'menüde var' : 'menüde yok'}</span>
                    </>
                  }
                  error={missing.includes(r) ? 'Kısım no gerekli' : invalid.includes(r) ? '1–99 arası' : null}
                >
                  <Input value={map[r] ?? ''} onChange={(e) => editMap({ ...map, [r]: e.target.value.replace(/\D/g, '').slice(0, 2) })} inputMode="numeric" maxLength={2} placeholder="Kısım no" className="tabular" />
                </Field>
              );
            })}
          </div>
          {/* Bağlantı ya da ödeme yeri kaydedilirken kapalı görünür (tıklama yutulmaz); Token denemesi sürerken kaydeder */}
          <Button variant="primary" icon={<Save className="size-4" />} loading={saving === 'map'} disabled={!!saving || !mapDirty || missing.length > 0 || invalid.length > 0} onClick={() => void saveMap()}>
            Eşlemeyi kaydet
          </Button>
        </Card>
      )}

      <Card title="Nasıl çalışır" bodyClassName="flex gap-3 text-sm text-ink-2">
        <MonitorSmartphone aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-primary)]" />
        <ol className="list-decimal space-y-1 pl-4">
          <li>Ödeme penceresinde “Hesabı yazarkasaya gönder”e basılır (kalem seçerek bölünmüş hesap da gönderilebilir)</li>
          <li>Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar</li>
          <li>Sonuç LafPOS’a gelir, ödemeler adisyona işlenir, adisyon kapanır; Z no ve fiş no adisyonda kalır</li>
          <li>Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır, adisyon yeniden açılır ve patron paneline alarm düşer</li>
        </ol>
      </Card>

      {s.provider !== 'tokenx' && <TokenSetup />}

      {/* Geliştirici bilgisi ana akışta kart değil: kurulum notu gibi kapalı durur, telefonda tablo yerine liste */}
      <SetupNotes summary="Diğer yazarkasa markaları">
        <ul className="divide-y divide-[var(--admin-divider)]">
          {OTHER_VENDORS.map((v) => (
            <li key={v.name} className="py-2 first:pt-0">
              <p className="text-[13px] font-medium text-[var(--admin-text)]">
                {v.name} <span className="font-normal text-[var(--admin-text-mute)]">· {v.channel}</span>
              </p>
              <p>{v.state}</p>
            </li>
          ))}
        </ul>
        <p>LafPOS’ta her marka ayrı bir sağlayıcıdır; üretici belgeyi ve test bilgilerini verince sağlayıcı eklenir, adisyon ve ödeme akışı değişmez. Masada ödemede GMP-3 §6.1 gereği üreticinin bulut kanalının bilgi fişi ve TSM kaydını desteklediği yazılı teyit edilmeli</p>
      </SetupNotes>
    </div>
  );
}
