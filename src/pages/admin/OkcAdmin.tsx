import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, MonitorSmartphone, PlugZap, Webhook, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { fmtDateTime } from '@shared/time';
import { Button } from '@/components/ui/Button';
import { Field, Input, Segmented } from '@/components/ui/Field';
import { PageLoading } from '@/components/ui/misc';
import { Card, PageHeader } from '@/components/admin/ui';
import { errorMessage, get, post, put } from '@/lib/api';
import { useBoot } from '@/lib/boot';
import { toast } from '@/lib/toast';

interface OkcStatus {
  provider: 'kapali' | 'tokenx' | 'simulator';
  mode: 'anlik' | 'liste';
  sectionMap: Record<string, number>;
  operatorMethods: Record<string, string>;
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

export default function OkcAdmin() {
  const boot = useBoot();
  const qc = useQueryClient();
  const status = useQuery({ queryKey: ['okc', 'status'], queryFn: () => get<OkcStatus>('/okc/status') });
  const [map, setMap] = useState<Record<string, string>>({});
  const [test, setTest] = useState<TestResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status.data) setMap(Object.fromEntries(Object.entries(status.data.sectionMap).map(([k, v]) => [k, String(v)])));
  }, [status.data]);

  const save = async (body: Record<string, unknown>) => {
    try {
      await put('/okc/settings', body);
      toast.ok('Kaydedildi');
      qc.invalidateQueries({ queryKey: ['okc'] });
      qc.invalidateQueries({ queryKey: ['bootstrap'] });
    } catch (e) {
      toast.err(errorMessage(e));
    }
  };
  const runTest = async () => {
    setBusy(true);
    try {
      const r = await post<TestResult>('/okc/test');
      setTest(r);
      toast.ok('Token bağlantısı çalışıyor');
    } catch (e) {
      toast.err(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (status.isLoading || !status.data) return <PageLoading />;
  const s = status.data;
  const usedRates = [...new Set(boot.products.map((p) => String(p.kdvRate)))].filter((r) => r !== '0');

  return (
    <div className="space-y-4">
      <PageHeader title="Yazarkasa POS" description="Adisyon cihaza sepet olarak gider; ödeme ve mali fiş cihazda alınır, sonuç (Z no, fiş no, ödemeler) adisyona işlenir" />
      <Card flush title="Bağlantı">
        <div className="space-y-4 p-4">
          <Segmented
            value={s.provider}
            onChange={(v) => save({ provider: v })}
            options={[
              { value: 'kapali', label: 'Kapalı' },
              { value: 'simulator', label: 'Eğitim cihazı' },
              { value: 'tokenx', label: 'Token (TokenX Connect)' },
            ]}
          />
          {s.provider === 'simulator' && (
            <p className="text-sm text-muted">
              Gerçek cihaz bağlanana kadar akışı denemek ve personeli eğitmek için. Sepetler <Link to="/cihaz" className="font-semibold text-brand-600 underline">eğitim cihazı</Link> ekranında ödenir
            </p>
          )}
          {s.provider !== 'kapali' && (
            <div>
              <div className="mb-1.5 text-sm font-medium text-ink-2">Ödeme yeri</div>
              <Segmented
                value={s.mode}
                onChange={(v) => save({ mode: v })}
                options={[
                  { value: 'anlik', label: 'Kasada ödeme (sepet hemen cihaza düşer)' },
                  { value: 'liste', label: 'Masada ödeme (cihaz açık hesapları listeler)' },
                ]}
              />
              <p className="mt-1.5 text-xs text-muted">Token cihazında da aynı mod seçilmeli: "Sepet ödemesini hemen al" ya da "Birden fazla sepeti listele"</p>
            </div>
          )}
        </div>
      </Card>

      {s.provider === 'tokenx' && (
        <Card flush title="TokenX Connect (Cloud)">
          <div className="space-y-3 p-4 text-sm">
            <div className="flex items-center gap-2">
              {s.tokenx.configured ? <CheckCircle2 className="size-5 text-brand-500" /> : <XCircle className="size-5 text-danger-500" />}
              {s.tokenx.configured ? `Bilgiler tanımlı · terminal ${s.tokenx.terminalId ?? '—'}${s.tokenx.branchId ? ` · şube ${s.tokenx.branchId}` : ''}` : 'Token bilgileri .env dosyasında eksik'}
            </div>
            {!s.tokenx.configured && (
              <pre className="overflow-x-auto rounded-xl bg-surface-2 p-3 text-xs">{`TOKENX_AUTH_URL=     (Token'ın verdiği kimlik adresi)
TOKENX_BASKET_URL=   (sepet API adresi)
TOKENX_SETTINGS_URL= (client-settings adresi)
TOKENX_CLIENT_ID=
TOKENX_CLIENT_SECRET=
TOKENX_TERMINAL_ID=  (cihazdaki QR'da, AV/AT ile başlar)
TOKENX_BRANCH_ID=    (masada ödeme modu için)
TOKENX_WEBHOOK_SECRET= (en az 16 karakter)
LAFPOS_PUBLIC_URL=   (webhook için; yoksa durum sorgulanır)`}</pre>
            )}
            <div className="flex flex-wrap gap-2">
              <Button icon={<PlugZap className="size-4" />} loading={busy} disabled={!s.tokenx.configured} onClick={runTest}>
                Bağlantıyı dene
              </Button>
              <Button
                icon={<Webhook className="size-4" />}
                disabled={!s.tokenx.configured || !s.tokenx.webhookUrl || !s.tokenx.webhookSecret}
                onClick={async () => {
                  try {
                    const r = await post<{ url: string }>('/okc/webhook/register');
                    toast.ok(`Webhook kaydedildi: ${r.url}`);
                  } catch (e) {
                    toast.err(errorMessage(e));
                  }
                }}
              >
                Webhook'u Token'a kaydet
              </Button>
            </div>
            <p className="text-xs text-muted">
              {s.tokenx.webhookUrl ? `Webhook adresi: ${s.tokenx.webhookUrl}` : 'Webhook adresi yok: kafedeki sunucu internetten erişilemiyorsa LafPOS sepet durumunu 2,5 sn\'de bir sorgular; sonuç yine gelir'}
            </p>
            {s.lastError && (
              <p className="rounded-xl bg-danger-50 p-2 text-xs text-danger-600 dark:bg-danger-800/30">
                Son hata ({fmtDateTime(s.lastError.at)}): {s.lastError.message}
              </p>
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
                  <Input value={map[r] ?? ''} onChange={(e) => setMap({ ...map, [r]: e.target.value.replace(/\D/g, '') })} inputMode="numeric" placeholder="kısım no" />
                </Field>
              ))}
            </div>
            <Button variant="primary" onClick={() => save({ sectionMap: Object.fromEntries(Object.entries(map).filter(([, v]) => v).map(([k, v]) => [k, Number(v)])) })}>
              Eşlemeyi kaydet
            </Button>
          </div>
        </Card>
      )}

      <Card flush title="Nasıl çalışır">
        <div className="flex gap-3 p-4 text-sm text-ink-2">
          <MonitorSmartphone className="size-5 shrink-0 text-brand-600" />
          <ol className="list-decimal space-y-1 pl-4">
            <li>Ödeme penceresinde "Hesabı yazarkasaya gönder"e basılır (kalem seçerek bölünmüş hesap da gönderilebilir).</li>
            <li>Kasiyer cihazda nakit, kart ya da yemek kartıyla ödemeyi alır; mali fiş cihazdan çıkar.</li>
            <li>Sonuç LafPOS'a gelir, ödemeler adisyona işlenir, adisyon kapanır; Z no ve fiş no adisyonda kalır.</li>
            <li>Cihazda fiş iptal edilirse LafPOS ödemesi geri alınır, adisyon yeniden açılır ve patron paneline alarm düşer.</li>
          </ol>
        </div>
      </Card>
    </div>
  );
}
