import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { LafTile } from '@/components/LafMark';
import { Button, buttonClass } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { PasswordInput } from '@/components/ui/PasswordInput';
import { Notice, PageLoading } from '@/components/ui/misc';
import { errorMessage, post, setToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { type RemoteSetup, remoteAutoEnters, remoteSetupQuery, remoteSetupReady } from '@/lib/remote';

function remember(key: string, on: boolean) {
  try {
    if (on) sessionStorage.setItem(key, '1');
    else sessionStorage.removeItem(key);
  } catch {
    /* depolama kapalı: yalnız demo notu görünmez */
  }
}

/** Kurulum adımları: eksik olan varsa giriş yerine ne yapılacağı görünür (parolayı denemeye gerek kalmaz) */
function SetupChecklist({ s }: { s: RemoteSetup }) {
  const steps = [
    { ok: s.secret, label: 'Ortak anahtar (ASILPOS_CLOUD_SECRET)' },
    { ok: s.password, label: 'Uzaktan giriş parolası (ASILPOS_UZAKTAN_PAROLA)' },
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

/**
 * Uzaktan giriş (sitenin "Üye girişi"). Üyelik açıksa (ASILPOS_UYE_EPOSTA) e-posta ve parola: üye ilk girişte davet
 * koduyla parolasını kendisi belirler, sonra aynı ikiliyle girer. İlk giriş formu üyelik hiç açılmamışken kendiliğinden,
 * sonra "Davet kodum var" ile açılır (sahibin panelden davet ettiği yönetici ve izleyici). Üyelik kapalıysa eski düzen:
 * patron parolası (ASILPOS_UZAKTAN_PAROLA) ya da parolasız görünüm. PIN'ler kafedeki kasada kalır. İndirme bağlantısı
 * burada yok, yalnız girişten sonra (İndir)
 */
export function RemoteLoginPage() {
  const init = useAuth((s) => s.init);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [password2, setPassword2] = useState('');
  const [invite, setInvite] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setup = useQuery({ ...remoteSetupQuery, retry: false });
  const ready = !!setup.data && remoteSetupReady(setup.data);
  // Demo ya da parolasız görünüm: parola sorulmaz, doğrudan girilir (form hiç görünmez). Kabuk "Çıkış"ı aynı kuralla
  // gizler (useRemoteSignOut): çıkış bu ekranı açar, bu ekran da aynı oturumu hemen yeniden açardı
  const auto = !!setup.data && remoteAutoEnters(setup.data);
  const autoTried = useRef(false);
  const member = setup.data?.member;
  // Davet edilen kişi: üyelik açık ('ready') ama kendi üyeliği yok; kodla ilk girişi yapar
  const [davetKodum, setDavetKodum] = useState(false);
  const creating = member === 'new' || (!!member && davetKodum);

  /** Oturumu açar; açılamazsa ileti. Parolasız girişte boş gövde gider */
  const enter = async (body: { eposta?: string; parola?: string; davet?: string }, path = '/uzaktan/giris') => {
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string }>(path, body);
      const demo = !body.parola && !!setup.data?.demo;
      remember('asilpos.demo', demo);
      setToken(res.token);
      await init();
      // Jeton alındı ama oturum okunamadı: bekleme ekranında takılı kalınmasın
      if (!useAuth.getState().me) setError('Oturum açılamadı; bağlantıyı kontrol edip yeniden deneyin');
    } catch (err) {
      setError(errorMessage(err));
      // Üyelik bu arada açılmış olabilir (başka cihazdan): form girişe döner
      if (path === '/uzaktan/uye') void setup.refetch();
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
    if (member) {
      if (!email.trim() || !password) return setError('E-posta ve parolayı girin');
      if (creating && !invite.trim()) return setError('Davet kodunu girin');
      if (creating && password.length < 10) return setError('Parola en az 10 karakter olmalı');
      if (creating && password !== password2) return setError('İki parola aynı değil');
      void enter(creating ? { eposta: email.trim(), parola: password, davet: invite.trim() } : { eposta: email.trim(), parola: password }, creating ? '/uzaktan/uye' : '/uzaktan/giris');
      return;
    }
    if (!password) {
      setError('Parolayı girin');
      return;
    }
    void enter({ parola: password });
  };

  // Kurulum sorulurken ve parolasız giriş sürerken parola formu görünmez (her açılışta bir an "Parola" yanıp sönmesin).
  // Yazı açılıştaki ve girişten sonraki bekleme ekranlarıyla aynı: art arda gelince değişmez
  if (setup.isPending || (auto && !error)) return <PageLoading label="AsilPOS açılıyor…" />;

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6">
      <form onSubmit={submit} noValidate className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6 shadow-[var(--shadow-card)]">
        <LafTile size="lg" />
        {/* Sitenin üye girişi: girişten sonra canlı görünüm ve İndir (Windows programı) açılır */}
        <p className="mt-4 text-sm font-semibold text-muted">AsilPOS Uzaktan</p>
        <h1 className="mt-0.5 text-xl font-bold sm:text-[22px]">{creating ? 'Üyeliği oluştur' : 'Üye girişi'}</h1>
        <p className="mt-1 text-pretty text-sm text-muted">
          {creating
            ? 'İlk giriş: e-postanızı ve size verilen davet kodunu yazın, bir parola belirleyin. Sonraki girişlerde yalnız e-posta ve parola sorulur'
            : 'Kafenin canlı durumu (patron paneli, masalar, bar, raporlar) ve Windows programının indirilmesi. Yalnız görüntülenir; işlemler kafedeki kasadan yapılır'}
        </p>
        {setup.isError && (
          <Notice tone="danger" role="alert" className="mt-4">
            Bağlantı kurulamadı; internet bağlantısını kontrol edip sayfayı yenileyin
          </Notice>
        )}
        {setup.data && !ready && <SetupChecklist s={setup.data} />}
        {ready && setup.data && !auto && !creating && (
          <p className="mt-3 text-xs text-muted">
            {setup.data.snapshotAt ? `Kafeden son veri: ${fmtDateTime(setup.data.snapshotAt)}` : member ? 'Kafe henüz bağlanmadı; girişten sonra programı indirip kurabilirsiniz' : 'Kafeden henüz veri gelmedi; kasa bilgisayarına aynı anahtar girilince başlar'}
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
            {member && (
              <Field label="E-posta" className="mt-5">
                <Input
                  id="eposta"
                  type="email"
                  inputMode="email"
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  autoFocus={ready}
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            )}
            {creating && (
              <Field label="Davet kodu" className="mt-3">
                <Input
                  id="davet"
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  spellCheck={false}
                  value={invite}
                  onChange={(e) => {
                    setInvite(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            )}
            <Field label="Parola" hint={creating ? 'En az 10 karakter' : undefined} error={creating ? null : error} className={member ? 'mt-3' : 'mt-5'}>
              <PasswordInput
                id="parola"
                autoComplete={creating ? 'new-password' : 'current-password'}
                // Güç çubuğu yalnız üyelik oluştururken (yeni parola); girişte değil
                strength={creating}
                strengthMin={10}
                strengthLabel="Parola gücü"
                showLabel="Parolayı göster"
                hideLabel="Parolayı gizle"
                autoFocus={ready && !member}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setError(null);
                }}
              />
            </Field>
            {creating && (
              <Field label="Parola (yeniden)" error={error} className="mt-3">
                <PasswordInput
                  id="parola2"
                  autoComplete="new-password"
                  showLabel="Parolayı göster"
                  hideLabel="Parolayı gizle"
                  value={password2}
                  onChange={(e) => {
                    setPassword2(e.target.value);
                    setError(null);
                  }}
                />
              </Field>
            )}
            <Button type="submit" variant="primary" size="lg" block className="mt-4" loading={busy} disabled={!!setup.data && !ready}>
              {creating ? 'Üyeliği oluştur' : 'Giriş'}
            </Button>
            {/* Panelden davet edilen kişi ilk girişi kodla yapar; üyelik hiç açılmamışken form zaten ilk giriş */}
            {member === 'ready' && (
              <Button
                variant="ghost"
                size="lg"
                block
                className="mt-2"
                onClick={() => {
                  setDavetKodum((x) => !x);
                  setError(null);
                  setPassword('');
                  setPassword2('');
                }}
              >
                {davetKodum ? 'Hesabım var, giriş yap' : 'Davet kodum var'}
              </Button>
            )}
            {/* Kafe bağlanmadan önce site demoyu üyeliksiz de açar (tarayıcıdaki örnek kasa, gerçek veri değil) */}
            {member && setup.data?.demo && (
              <a href="/demo/" className={buttonClass('ghost', 'lg', { block: true, className: 'mt-2' })}>
                Demoyu dene
              </a>
            )}
          </>
        )}
      </form>
    </div>
  );
}
