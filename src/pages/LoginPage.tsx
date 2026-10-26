import { useQuery } from '@tanstack/react-query';
import { Coffee, Delete } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { cn } from '@/lib/cn';
import { errorMessage, get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { fmtTime } from '@shared/time';

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

  return (
    <div className="flex min-h-full flex-col bg-forest-800 text-cream lg:flex-row">
      <div className="relative flex flex-1 flex-col justify-between overflow-hidden p-8 lg:p-12">
        <div className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-forest-600/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 -left-16 size-96 rounded-full bg-burgundy-600/25 blur-3xl" />
        <div className="relative flex items-center gap-3">
          <div className="grid size-12 place-items-center rounded-2xl bg-cream/10 ring-1 ring-cream/20">
            <span className="font-[Didot,'Bodoni_72',Georgia,serif] text-xl font-bold">L’Af</span>
          </div>
          <div>
            <div className="text-lg font-semibold">{info.data?.businessName ?? "L'Affogato"}</div>
            <div className="text-xs tracking-[0.2em] text-cream/60">SINCE 1897, BOLOGNA</div>
          </div>
        </div>
        <div className="relative my-10 lg:my-0">
          <div className="tabular text-7xl font-semibold tracking-tight lg:text-8xl">{fmtTime(now)}</div>
          <div className="mt-2 text-cream/70">LafPOS · PIN ile giriş</div>
        </div>
        <div className="relative hidden flex-wrap gap-2 lg:flex">
          {info.data?.users.map((u) => (
            <span key={u.id} className="inline-flex items-center gap-2 rounded-full bg-cream/10 px-3 py-1.5 text-sm">
              <span className="size-2.5 rounded-full" style={{ background: u.color }} />
              {u.name}
            </span>
          ))}
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center bg-bg p-6 text-ink lg:max-w-xl">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center">
            <h1 className="text-2xl font-semibold">Hoş geldiniz</h1>
            <p className="mt-1 text-sm text-muted">PIN kodunuzu girin</p>
          </div>
          <div className="mb-3 flex justify-center gap-3" aria-live="polite" aria-label={`${pin.length} hane girildi`}>
            {Array.from({ length: 6 }, (_, i) => (
              <span
                key={i}
                className={cn('size-4 rounded-full transition', i < pin.length ? 'scale-110 bg-forest-700 dark:bg-forest-300' : 'bg-line-strong', i >= 4 && i >= pin.length && 'opacity-40')}
              />
            ))}
          </div>
          <div className="mb-4 h-5 text-center text-sm text-burgundy-500">{error}</div>
          <div className="grid grid-cols-3 gap-3">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((k) => (
              <PadKey key={k} onClick={() => press(k)}>
                {k}
              </PadKey>
            ))}
            <PadKey onClick={() => press('back')} aria-label="Sil">
              <Delete className="mx-auto size-7" />
            </PadKey>
            <PadKey onClick={() => press('0')}>0</PadKey>
            <PadKey onClick={() => press('ok')} primary disabled={pin.length < 4 || busy}>
              Giriş
            </PadKey>
          </div>
          {info.data?.demoPins && (
            <div className="mt-6 rounded-2xl border border-dashed border-brass-400 bg-brass-50 p-3 text-xs text-brass-700 dark:bg-brass-700/15 dark:text-brass-100">
              <div className="mb-1 flex items-center gap-1.5 font-semibold">
                <Coffee className="size-3.5" /> Kurulum modu: örnek PIN'ler
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {info.data.demoPins.map((d) => (
                  <button key={d.name} className="underline-offset-2 hover:underline" onClick={() => submit(d.pin)}>
                    {d.name}: <b className="tabular">{d.pin}</b>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 opacity-80">Canlıya geçmeden önce Yönetim › Personel'den PIN'leri değiştirip kurulum modunu kapatın</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function PadKey({ children, primary, className, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return (
    <button
      type="button"
      className={cn(
        'h-[72px] rounded-2xl text-2xl font-semibold shadow-sm transition active:scale-95 disabled:opacity-40',
        primary ? 'bg-primary text-lg text-primary-ink' : 'border border-line bg-surface text-ink active:bg-surface-3',
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
}
