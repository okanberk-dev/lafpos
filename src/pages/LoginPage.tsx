import { useQuery } from '@tanstack/react-query';
import { Coffee, Delete } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LafMark } from '@/components/LafMark';
import { cn } from '@/lib/cn';
import { errorMessage, get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { businessDate, fmtDateLong, fmtTime } from '@shared/time';

interface LoginInfo {
  users: { id: string; name: string; role: string; color: string }[];
  businessName: string;
  demoPins: { name: string; pin: string }[] | null;
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const info = useQuery({ queryKey: ['login-info'], queryFn: () => get<LoginInfo>('/auth/users'), retry: 2 });

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);

  const submit = async (value: string) => {
    if (value.length < 4 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await login(value);
      navigate('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const press = (k: string) => {
    if (busy) return;
    setError(null);
    if (k === 'back') {
      setPin(pin.slice(0, -1));
      return;
    }
    if (k === 'ok') {
      void submit(pin);
      return;
    }
    const next = (pin + k).slice(0, 6);
    setPin(next);
    // 6 hane dolunca kendiliğinden girer; 4-5 haneli PIN için "Giriş"e basılır
    if (next.length === 6) void submit(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
      else if (e.key === 'Enter') press('ok');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const today = businessDate(now);
  return (
    // Innex: gri zemin, beyaz kartlar. Solda kim ve ne zaman, sağda PIN
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6">
      <div className="grid w-full max-w-4xl gap-3 lg:grid-cols-[1fr_minmax(360px,420px)]">
        <section className="flex flex-col justify-between gap-6 rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <span className="grid size-11 shrink-0 place-items-center rounded-xl bg-night text-white dark:bg-surface-3">
              <LafMark className="h-4" bean="#e8c877" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{info.data?.businessName ?? "L'Affogato"}</span>
              <span className="block text-xs text-muted">LafPOS · kasa</span>
            </span>
          </div>
          <div>
            <div className="tabular text-6xl font-semibold tracking-[-0.03em] sm:text-7xl">{fmtTime(now)}</div>
            <div className="mt-1 text-sm text-muted">{fmtDateLong(today)}</div>
          </div>
          {!!info.data?.users.length && (
            <div className="hidden flex-wrap gap-1.5 lg:flex">
              {info.data.users.map((u) => (
                <span key={u.id} className="inline-flex items-center gap-1.5 rounded-md bg-surface-3 px-2 py-1 text-xs font-medium text-ink-2">
                  <span className="size-2 rounded-full" style={{ background: u.color }} />
                  {u.name}
                </span>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-line bg-surface p-5 sm:p-6">
          <div className="mb-5 text-center">
            <h1 className="text-lg font-semibold tracking-[-0.01em]">Hoş geldiniz</h1>
            <p className="mt-0.5 text-[13px] text-muted">PIN kodunuzu girin</p>
          </div>
          <div className="mb-2 flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} hane girildi`}>
            {Array.from({ length: 6 }, (_, i) => (
              <span key={i} className={cn('size-3.5 rounded-full transition', i < pin.length ? 'bg-ink' : 'bg-surface-3 ring-1 ring-inset ring-line', i >= 4 && i >= pin.length && 'opacity-50')} />
            ))}
          </div>
          <div className="mb-3 h-5 text-center text-[13px] font-medium text-[var(--admin-danger-ink)]">{error}</div>
          <div className="grid grid-cols-3 gap-2">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
              <PadKey key={k} onClick={() => press(k)}>
                {k}
              </PadKey>
            ))}
            <PadKey onClick={() => press('back')} aria-label="Sil">
              <Delete className="mx-auto size-6" />
            </PadKey>
            <PadKey onClick={() => press('0')}>0</PadKey>
            <PadKey onClick={() => press('ok')} primary disabled={pin.length < 4 || busy}>
              Giriş
            </PadKey>
          </div>
          {info.data?.demoPins && (
            <div className="mt-5 rounded-xl bg-[var(--admin-warning-soft)] p-3 text-xs text-[var(--admin-warning)]">
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                <Coffee className="size-3.5" /> Kurulum modu: örnek PIN'ler
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {info.data.demoPins.map((d) => (
                  <button key={d.name} className="inline-flex items-center gap-1 underline-offset-2 hover:underline pointer-coarse:min-h-11" onClick={() => submit(d.pin)}>
                    {d.name}: <b className="tabular">{d.pin}</b>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-ink-2">Canlıya geçmeden önce Yönetim › Personel'den PIN'leri değiştirip kurulum modunu kapatın</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function PadKey({ children, primary, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'tabular h-16 rounded-xl text-2xl font-semibold transition active:scale-[0.97] disabled:opacity-40 sm:h-[68px]',
        primary ? 'bg-primary text-base text-primary-ink hover:bg-[var(--admin-primary-hover)]' : 'border border-[var(--admin-border-strong)] bg-surface text-ink hover:bg-surface-2 active:bg-surface-3',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
