import { useState } from 'react';
import { LafMark } from '@/components/LafMark';
import { Button } from '@/components/ui/Button';
import { errorMessage, post, setToken } from '@/lib/api';
import { useAuth } from '@/lib/auth';

/** Uzaktan giriş: patron parolası (Vercel'de LAFPOS_UZAKTAN_PAROLA). PIN'ler kafedeki kasada kalır */
export function RemoteLoginPage() {
  const init = useAuth((s) => s.init);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    try {
      const res = await post<{ token: string }>('/uzaktan/giris', { parola: password });
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
        <label className="mt-5 block text-sm font-medium" htmlFor="parola">
          Parola
        </label>
        <input
          id="parola"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1.5 h-11 w-full rounded-xl border border-[var(--admin-border-strong)] bg-surface px-3.5 text-base outline-none focus:border-primary focus:ring-4 focus:ring-[var(--admin-primary-soft)]"
        />
        {error && <p className="mt-2 text-sm text-[var(--admin-danger-ink)]">{error}</p>}
        <Button type="submit" variant="primary" size="lg" block className="mt-4" loading={busy}>
          Giriş
        </Button>
      </form>
    </div>
  );
}
