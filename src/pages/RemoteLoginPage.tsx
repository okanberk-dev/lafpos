import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { fmtDateTime } from '@shared/time';
import { LafMark } from '@/components/LafMark';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
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

/** Kurulum adımları: eksik olan varsa giriş yerine ne yapılacağı görünür (parolayı denemeye gerek kalmaz) */
function SetupChecklist({ s }: { s: Setup }) {
  const steps = [
    { ok: s.secret, label: 'Ortak anahtar (LAFPOS_CLOUD_SECRET)' },
    { ok: s.password, label: 'Uzaktan giriş parolası (LAFPOS_UZAKTAN_PAROLA)' },
    { ok: s.redis, label: 'Upstash Redis bağlantısı' },
  ];
  return (
    <div className="mt-5 rounded-xl border border-line bg-surface-2 p-4 text-sm">
      <p className="font-semibold">Uzaktan erişimin kurulumu bitmemiş</p>
      <ul className="mt-2 space-y-1.5">
        {steps.map((x) => (
          <li key={x.label} className="flex items-center gap-2">
            {x.ok ? <CheckCircle2 className="size-4 shrink-0 text-[var(--admin-success)]" /> : <CircleAlert className="size-4 shrink-0 text-[var(--admin-warning)]" />}
            <span className={x.ok ? 'text-muted' : ''}>{x.label}</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-muted">
        Eksikleri Mac'te <code className="rounded bg-surface px-1 py-0.5 text-[12px]">scripts/vercel/baglanti-kur.sh</code> tek seferde tamamlar; sonra kafedeki kasaya aynı anahtar girilir
      </p>
    </div>
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
  const demoTried = useRef(false);

  // Demo ya da parolasız görünüm: parola sorulmaz, doğrudan girilir
  useEffect(() => {
    const demo = !!setup.data?.demo;
    if (!(demo || (setup.data?.open && ready)) || demoTried.current) return;
    demoTried.current = true;
    void (async () => {
      try {
        const res = await post<{ token: string }>('/uzaktan/giris', {});
        if (demo) sessionStorage.setItem('lafpos.demo', '1');
        else sessionStorage.removeItem('lafpos.demo');
        setToken(res.token);
        await init();
      } catch (err) {
        setError(errorMessage(err));
      }
    })();
  }, [setup.data, ready, init]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string }>('/uzaktan/giris', { parola: password });
      sessionStorage.removeItem('lafpos.demo');
      setToken(res.token);
      await init();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center bg-bg p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6">
        <span className="grid size-12 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
          <LafMark className="h-5" bean="#e8c877" />
        </span>
        <h1 className="mt-4 text-xl font-semibold tracking-[-0.01em]">LafPOS Uzaktan</h1>
        <p className="mt-1 text-sm text-muted">Kafenin canlı durumu: patron paneli, masalar, bar. Salt okunur; işlemler kafedeki kasadan</p>
        {setup.data && !ready && <SetupChecklist s={setup.data} />}
        {ready && setup.data && (
          <p className="mt-3 text-xs text-muted">
            {setup.data.snapshotAt ? `Kafeden son veri: ${fmtDateTime(setup.data.snapshotAt)}` : 'Kafeden henüz veri gelmedi; kasa bilgisayarına aynı anahtar girilince başlar'}
          </p>
        )}
        <label className="mt-5 block text-sm font-medium" htmlFor="parola">
          Parola
        </label>
        <Input
          id="parola"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 text-base"
        />
        {error && <p className="mt-2 text-sm text-[var(--admin-danger-ink)]">{error}</p>}
        <Button type="submit" variant="primary" size="lg" block className="mt-4" loading={busy} disabled={!!setup.data && !ready}>
          Giriş
        </Button>
      </form>
    </div>
  );
}
