import { useQuery } from '@tanstack/react-query';
import { Coffee } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LafTile } from '@/components/LafMark';
import { Numpad, PinDots } from '@/components/ui/Numpad';
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
    if (k === 'clear') {
      setPin('');
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

  const today = businessDate(now);
  const users = info.data?.users ?? [];
  return (
    // Solda marka yüzeyi (L'Affogato yeşili, krem yazı): kim ve ne zaman; sağda PIN. Telefonda marka şeridi üstte
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6">
      <div className="grid w-full max-w-5xl gap-3 lg:min-h-[560px] lg:grid-cols-[1fr_minmax(380px,440px)]">
        <section
          className="relative flex items-center justify-between gap-4 overflow-hidden rounded-3xl p-4 text-[var(--brand-cream)] sm:p-6 lg:flex-col lg:items-stretch lg:justify-between lg:p-9"
          style={{ background: 'var(--brand-panel)' }}
        >
          <div className="flex items-center gap-3">
            <LafTile className="shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" />
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-semibold">{info.data?.businessName ?? "L'Affogato"}</span>
              <span className="block text-xs text-[var(--brand-cream)]/80">LafPOS · kasa</span>
            </span>
          </div>
          <div className="shrink-0 text-right lg:text-left">
            <div className="tabular text-3xl font-light leading-none tracking-[-0.02em] lg:text-[96px]">{fmtTime(now)}</div>
            <div className="mt-1 hidden text-sm text-[var(--brand-cream)]/80 sm:block lg:mt-3 lg:text-base">{fmtDateLong(today)}</div>
          </div>
          {!!users.length && (
            <div className="hidden lg:block">
              <div className="mb-2.5 text-xs font-medium uppercase tracking-[0.08em] text-[var(--brand-cream)]/80">Bugünkü ekip</div>
              <div className="flex flex-wrap gap-1.5">
                {users.map((u) => (
                  <span key={u.id} className="inline-flex items-center gap-2 rounded-full bg-white/10 py-1 pl-1 pr-3 text-xs font-medium ring-1 ring-inset ring-white/15">
                    <span className="grid size-6 place-items-center rounded-full text-[11px] font-semibold text-white ring-1 ring-inset ring-white/25" style={{ background: u.color }}>
                      {u.name.slice(0, 1).toLocaleUpperCase('tr-TR')}
                    </span>
                    {u.name}
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Sağ altta çekirdeğin yansıması: yalnız süs, ekran okuyucuya kapalı */}
          <span aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-16 hidden size-80 rounded-full bg-[radial-gradient(circle,rgb(232_200_119/0.16),transparent_65%)] lg:block" />
        </section>

        <section className="flex flex-col justify-center rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-8">
          <div className="mb-6 text-center">
            <h1 className="text-xl font-semibold">Hoş geldiniz</h1>
            <p className="mt-1 text-[13px] text-muted">Devam etmek için PIN kodunuzu girin</p>
          </div>
          <PinDots filled={pin.length} className="mb-2" />
          <div role="alert" className="mb-4 h-5 text-center text-[13px] font-medium text-[var(--admin-danger-ink)]">
            {error}
          </div>
          {/* Ortak tuş takımı; fiziksel klavye de girer (rakam, Backspace, Delete, Enter) */}
          <Numpad size="lg" keyboard onKey={press} confirm={{ label: 'Giriş', disabled: pin.length < 4 || busy, onPress: () => press('ok') }} />
          {info.data?.demoPins && (
            <div className="mt-5 rounded-2xl border border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)] p-3.5 text-xs text-[var(--admin-warning)]">
              <div className="mb-1.5 flex items-center gap-1.5 font-semibold">
                <Coffee className="size-3.5" /> Kurulum modu: örnek PIN’ler
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-1">
                {info.data.demoPins.map((d) => (
                  <button key={d.name} className="inline-flex items-center gap-1 underline-offset-2 hover:underline pointer-coarse:min-h-11" onClick={() => submit(d.pin)}>
                    {d.name}: <b className="tabular">{d.pin}</b>
                  </button>
                ))}
              </div>
              <div className="mt-1.5 text-ink-2">Canlıya geçmeden önce Yönetim › Personel’den PIN’leri değiştirip kurulum modunu kapatın</div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
