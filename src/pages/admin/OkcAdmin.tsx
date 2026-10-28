import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MonitorSmartphone, PlugZap, Save, Webhook, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { ErrorState, Notice, Skeleton } from '@/components/ui/misc';
import { Card, CARD, CODE, PageHeader, SetupNotes } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
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

const RATES = ['1', '10', '20'];

const DOC_LABEL: Record<string, string> = { okc_fis: 'mali fiş', bilgi_fisi: 'bilgi fişi', e_arsiv: 'e-Arşiv', e_fatura: 'e-Fatura' };

/** Bağlantısı henüz olmayan markalar: neden ve üreticiden ne istenecek (docs/04-OKC.md'de ayrıntı) */
const OTHER_VENDORS: { name: string; channel: string; state: string }[] = [
  { name: 'Hugin', channel: 'Cloud Link (TSM)', state: 'Açık belge eksik: satış sonucunun ödeme, Z ve fiş alanları istenecek' },
  { name: 'Pavo', channel: 'IP REST, bulut', state: 'Yalnız iş ortaklarına belge veriyor; e-Arşiv hesabı gerekir' },
  { name: 'Ingenico', channel: 'GMP-3 DLL (Windows)', state: 'Geliştirici programı ve sürüm başına kayıt gerekir' },
  { name: 'Verifone, Inpos, Profilo, PayGo, Vera', channel: 'TSM ya da kablolu', state: 'Açık belge yok; üreticiden istenecek' },
];

export default function OkcAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['okc', 'status'], queryFn: () => get<OkcStatus>('/okc/status') });
  const [map, setMap] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState<'test' | 'webhook' | 'map' | null>(null);

  useEffect(() => {
    if (status.data) setMap(Object.fromEntries(Object.entries(status.data.sectionMap).map(([k, v]) => [k, String(v)])));
  }, [status.data]);

  const save = async (body: Record<string, unknown>, done = 'Yazarkasa ayarı kaydedildi') => {
    try {
      await put('/okc/settings', body);
      toast.ok(done);
      qc.invalidateQueries({ queryKey: ['okc'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const saveMap = async () => {
    setBusy('map');
    await save({ sectionMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])) }, 'Kısım eşlemesi kaydedildi');
    setBusy(null);
  };
  const registerWebhook = async () => {
    setBusy('webhook');
    try {
      const r = await post<{ url: string }>('/okc/webhook/register');
      toast.ok(`Webhook kaydedildi: ${r.url}`);
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  const runTest = async () => {
    setBusy('test');
    try {
      const r = await post<TestResult>('/okc/test');
      setTest(r);
      toast.ok('Token bağlantısı çalışıyor');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const header = <PageHeader title="Yazarkasa POS" description="Adisyon cihaza sepet olarak gider; ödeme ve mali fiş cihazda alınır" />;
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
  const usedRates = [...new Set(boot.products.map((p) => String(p.kdvRate)))].filter((r) => r !== '0');

  return (
    <div className="space-y-4">
      {header}
      <Card flush title="Bağlantı">
        <div className="space-y-4 p-4">
          <Segmented
            wrap
            label="Yazarkasa bağlantısı"
            value={s.provider}
            onChange={(v) => save({ provider: v })}
            options={[
              { value: 'kapali', label: 'Kapalı' },
              { value: 'simulator', label: 'Eğitim cihazı' },
              { value: 'tokenx', label: 'Token · Beko (TokenX Connect)' },
            ]}
          />
          {s.active && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {[
                s.active.capabilities.instant && 'Kasada ödeme',
                s.active.capabilities.list && 'Masada ödeme',
                s.active.capabilities.splitPayment && 'Bölünmüş ödeme',
                s.active.capabilities.docKinds.map((d) => DOC_LABEL[d] ?? d).join(', '),
              ]
                .filter(Boolean)
                .map((t) => (
                  <span key={String(t)} className="rounded-md bg-surface-2 px-2 py-1 text-ink-2">
                    {t}
                  </span>
                ))}
            </div>
          )}
          {s.provider === 'simulator' && (
            <p className="text-sm text-muted">
              Gerçek cihaz bağlanana kadar akışı denemek ve personeli eğitmek için. Sepetler <Link to="/cihaz" className="font-semibold text-[var(--admin-primary)] underline underline-offset-2">eğitim cihazı</Link> ekranında ödenir
            </p>
          )}
          {s.provider !== 'kapali' && (
            <div>
              <div className="mb-1.5 text-[13px] font-medium text-ink-2">Ödeme yeri</div>
              <Segmented
                wrap
                label="Ödeme yeri"
                value={s.mode}
                onChange={(v) => save({ mode: v })}
                options={[
                  { value: 'anlik', label: 'Kasada ödeme (sepet hemen cihaza düşer)' },
                  { value: 'liste', label: 'Masada ödeme (cihaz açık hesapları listeler)' },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted">Token cihazında da aynı mod seçilmeli: “Sepet ödemesini hemen al” ya da “Birden fazla sepeti listele”</p>
            </div>
          )}
        </div>
      </Card>

      {s.provider === 'tokenx' && (
        <Card flush title="TokenX Connect (Cloud)">
          <div className="space-y-3 p-4 text-sm">
            <div className="flex items-center gap-2">
              {s.tokenx.configured ? <CheckCircle2 aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-success)]" /> : <XCircle aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-danger-ink)]" />}
              {s.tokenx.configured ? joinMeta(['Bilgiler tanımlı', s.tokenx.terminalId && `terminal ${s.tokenx.terminalId}`, s.tokenx.branchId && `şube ${s.tokenx.branchId}`]) : 'Token bilgileri eksik; adımlar sayfanın sonunda'}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button icon={<PlugZap className="size-4" />} loading={busy === 'test'} disabled={!s.tokenx.configured} onClick={() => void runTest()}>
                Bağlantıyı dene
              </Button>
              <Button icon={<Webhook className="size-4" />} loading={busy === 'webhook'} disabled={!s.tokenx.configured || !s.tokenx.webhookUrl || !s.tokenx.webhookSecret} onClick={() => void registerWebhook()}>
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
                <Button size="sm" className="mt-2" onClick={() => setMap(Object.fromEntries(Object.entries(test.suggestedSectionMap).map(([k, v]) => [k, String(v)])))}>
                  Önerilen eşlemeyi kullan
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}

      {s.provider !== 'kapali' && (
        <Card flush title="KDV oranı → cihazdaki kısım">
          <div className="space-y-3 p-4">
            <p className="text-sm text-muted">Her KDV oranı cihazda tanımlı bir kısma (departman) gider. Menüde kullanılan oranlar: {usedRates.map((r) => `%${r}`).join(', ')}</p>
            <div className="grid grid-cols-3 gap-3 sm:max-w-md">
              {RATES.map((r) => (
                <Field key={r} label={`%${r} KDV`}>
                  <Input value={map[r] ?? ''} onChange={(e) => setMap({ ...map, [r]: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="Kısım no" className="tabular" />
                </Field>
              ))}
            </div>
            <Button variant="primary" icon={<Save className="size-4" />} loading={busy === 'map'} onClick={() => void saveMap()}>
              Eşlemeyi kaydet
            </Button>
          </div>
        </Card>
      )}

      <Card flush title="Diğer markalar">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2">Marka</th>
                <th className="px-2 py-2">Kanal</th>
                <th className="px-4 py-2">Durum</th>
              </tr>
            </thead>
            <tbody>
              {OTHER_VENDORS.map((v) => (
                <tr key={v.name} className="border-b border-line/60 last:border-0">
                  <td className="px-4 py-2 font-medium">{v.name}</td>
                  <td className="px-2 py-2 text-ink-2">{v.channel}</td>
                  <td className="px-4 py-2 text-muted">{v.state}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-4 py-3 text-xs text-muted">
          LafPOS’ta her marka ayrı bir sağlayıcıdır; üretici belgeyi ve test bilgilerini verince sağlayıcı eklenir, adisyon ve ödeme akışı değişmez. Masada ödemede GMP-3 §6.1 gereği üreticinin bulut kanalının bilgi fişi ve TSM kaydını desteklediği yazılı teyit edilmeli.
        </p>
      </Card>

      <Card flush title="Nasıl çalışır">
        <div className="flex gap-3 p-4 text-sm text-ink-2">
          <MonitorSmartphone aria-hidden="true" className="size-5 shrink-0 text-[var(--admin-primary)]" />
          <ol className="list-decimal space-y-1 pl-4">
            <li>Ödeme penceresinde “Hesabı yazarkasaya gönder”e basılır (kalem seçerek bölünmüş hesap da gönderilebilir).</li>
            <li>Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar.</li>
            <li>Sonuç LafPOS’a gelir, ödemeler adisyona işlenir, adisyon kapanır; Z no ve fiş no adisyonda kalır.</li>
            <li>Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır, adisyon yeniden açılır ve patron paneline alarm düşer.</li>
          </ol>
        </div>
      </Card>

      {/* Token seçili ve bilgiler eksikken açık gelir: o an gereken tek şey bu */}
      <SetupNotes open={s.provider === 'tokenx' && !s.tokenx.configured}>
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
    </div>
  );
}
