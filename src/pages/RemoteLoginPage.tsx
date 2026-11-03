import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { LafTile } from '@/components/LafMark';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { Notice, PageLoading } from '@/components/ui/misc';
import { errorMessage, get, post, setToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';

interface Setup {
  secret: boolean;
  password: boolean;
  redis: boolean;
  snapshotAt: number | null;
  /** Kafe bağlanmadı: örnek gün parolasız açılır */
  demo?: boolean;
  /** Parolasız görünüm (LAFPOS_UZAKTAN_PAROLA_GEREKLI yoksa): gerçek veri de parola sormadan açılır */
  open?: boolean;
}

/** Bu sekmedeki uzaktan oturum parolasız mı açıldı (demo ya da parolasız görünüm) */
const OPEN_KEY = 'lafpos.uzaktan.acik';

/**
 * Parolasız açılmış uzaktan oturumda çıkış anlamsızdır: giriş ekranı aynı oturumu hemen yeniden açar. Kullanıcı
 * menüsü ve komut paleti "Çıkış yap"ı yalnız parolayla açılmış oturumda gösterir.
 */
export function remoteOpenSession(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

function remember(key: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    /* depolama kapalı: yalnız çıkış satırı görünür kalır */
  }
}

/** Kurulum adımları: eksik olan varsa giriş yerine ne yapılacağı görünür (parolayı denemeye gerek kalmaz) */
function SetupChecklist({ s }: { s: Setup }) {
  const steps = [
    { ok: s.secret, label: 'Ortak anahtar (LAFPOS_CLOUD_SECRET)' },
    { ok: s.password, label: 'Uzaktan giriş parolası (LAFPOS_UZAKTAN_PAROLA)' },
    { ok: s.redis, label: 'Upstash Redis bağlantısı' },
  ];
  return (
    <Notice tone="warn" className="mt-5" title="Uzaktan erişimin kurulumu bitmemiş">
      <ul className="mt-2 space-y-1.5">
        {steps.map((x) => (
          <li key={x.label} className="flex items-start gap-2">
            {x.ok ? <CheckCircle2 aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-success-ink" /> : <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning-ink" />}
            <span className={x.ok ? 'text-muted' : 'text-ink'}>
              <span className="sr-only">{x.ok ? 'Tamam: ' : 'Eksik: '}</span>
              {x.label}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3">
        Eksikleri Mac’te <code className="whitespace-nowrap rounded bg-surface px-1 py-0.5 text-xs">scripts/vercel/baglanti-kur.sh</code> tek seferde tamamlar; sonra kafedeki kasaya aynı anahtar girilir
      </p>
    </Notice>
  );
}

/** Uzaktan giriş: patron parolası (Vercel'de LAFPOS_UZAKTAN_PAROLA). PIN'ler kafedeki kasada kalır */
export function RemoteLoginPage() {
  const init = useAuth((s) => s.init);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = useQuery({ queryKey: ['uzaktan', 'kurulum'], queryFn: () => get<Setup>('/uzaktan/kurulum'), retry: false });
  const ready = !!setup.data && setup.data.secret && setup.data.password && setup.data.redis;
  // Demo ya da parolasız görünüm: parola sorulmaz, doğrudan girilir (form hiç görünmez)
  const auto = !!setup.data && (!!setup.data.demo || (!!setup.data.open && ready));
  const autoTried = useRef(false);

  /** Oturumu açar; açılamazsa ileti. Parolasız girişte boş gövde gider */
  const enter = async (body: { parola?: string }) => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string }>('/uzaktan/giris', body);
      const demo = !body.parola && !!setup.data?.demo;
      remember('lafpos.demo', demo);
      remember(OPEN_KEY, !body.parola);
      setToken(res.token);
      await init();
      // Jeton alındı ama oturum okunamadı: bekleme ekranında takılı kalınmasın
      if (!useAuth.getState().me) setError('Oturum açılamadı; bağlantıyı kontrol edip yeniden deneyin');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!auto || autoTried.current) return;
    autoTried.current = true;
    void enter({});
    // enter her çizimde yenidir; parolasız giriş açılışta bir kez denenir
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) {
      setError('Parolayı girin');
      return;
    }
    void enter({ parola: password });
  };

  // Kurulum sorulurken ve parolasız giriş sürerken parola formu görünmez (her açılışta bir an "Parola" yanıp sönmesin).
  // Yazı açılıştaki ve girişten sonraki bekleme ekranlarıyla aynı: art arda gelince değişmez
  if (setup.isPending || (auto && !error)) return <PageLoading label="LafPOS açılıyor…" />;

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6">
      <form onSubmit={submit} noValidate className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
        <LafTile size="lg" />
        <h1 className="mt-4 text-xl font-bold sm:text-[22px]">LafPOS Uzaktan</h1>
        <p className="mt-1 text-pretty text-sm text-muted">Kafenin canlı durumu: patron paneli, masalar ve bar. Yalnız görüntülenir; işlemler kafedeki kasadan yapılır</p>
        {setup.isError && (
          <Notice tone="danger" role="alert" className="mt-4">
            Bağlantı kurulamadı; internet bağlantısını kontrol edip sayfayı yenileyin
          </Notice>
        )}
        {setup.data && !ready && <SetupChecklist s={setup.data} />}
        {ready && setup.data && !auto && (
          <p className="mt-3 text-xs text-muted">
            {setup.data.snapshotAt ? `Kafeden son veri: ${fmtDateTime(setup.data.snapshotAt)}` : 'Kafeden henüz veri gelmedi; kasa bilgisayarına aynı anahtar girilince başlar'}
          </p>
        )}
        {auto ? (
          // Parolasız giriş açılamadı: parola istenmez, yeniden denenir
          <>
            <Notice tone="danger" role="alert" className="mt-5">
              {error}
            </Notice>
            <Button variant="primary" size="lg" block className="mt-4" loading={busy} onClick={() => void enter({})}>
              Yeniden dene
            </Button>
          </>
        ) : (
          <>
            <Field label="Parola" error={error} className="mt-5">
              <Input
                id="parola"
                type="password"
                autoComplete="current-password"
                autoFocus={ready}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            <Button type="submit" variant="primary" size="lg" block className="mt-4" loading={busy} disabled={!!setup.data && !ready}>
              Giriş
            </Button>
          </>
        )}
      </form>
    </div>
  );
}
