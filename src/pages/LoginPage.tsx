import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { LafTile } from '@/components/LafMark';
import { Button } from '@/components/ui/Button';
import { Segmented } from '@/components/ui/Field';
import { Avatar, Notice } from '@/components/ui/misc';
import { Numpad, PinDots } from '@/components/ui/Numpad';
import { errorMessage, get, post } from '@/lib/api';
import { cn } from '@/lib/cn';
import { fmtDuration } from '@/lib/mesai';
import { useAuth } from '@/lib/auth';
import { businessDate, fmtDateLong, fmtTime } from '@shared/time';
import type { PunchResultDTO } from '@shared/types';

interface LoginInfo {
  users: { id: string; name: string; role: string; color: string }[];
  businessName: string;
  demoPins: { name: string; pin: string }[] | null;
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  // Oturum aç ya da mesai (aynı PIN'le giriş-çıkış; oturum açılmaz, sonuç birkaç saniye görünür)
  const [mode, setMode] = useState<'oturum' | 'mesai'>('oturum');
  const [punched, setPunched] = useState<PunchResultDTO | null>(null);
  const clearPunch = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (clearPunch.current) clearTimeout(clearPunch.current);
  }, []);
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
      if (mode === 'mesai') {
        const r = await post<PunchResultDTO>('/time/punch', { pin: value });
        setPunched(r);
        setPin('');
        // Bu cihazda az sonra açılacak oturum (kullanıcı menüsü, avatar noktası) güncel mesaiyle başlasın
        void qc.invalidateQueries({ queryKey: ['time'] });
        if (clearPunch.current) clearTimeout(clearPunch.current);
        clearPunch.current = setTimeout(() => setPunched(null), 8000);
        return;
      }
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
    // Sıradaki kişi yazmaya başlayınca öncekinin mesai sonucu kalkar
    if (k !== 'ok') setPunched(null);
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
  const showPunch = mode === 'mesai' && !!punched;
  return (
    // Solda marka yüzeyi (L'Affogato yeşili, krem yazı): kim ve ne zaman; sağda PIN. Telefonda marka şeridi üstte
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6 lg:p-4">
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
            <div className="tabular font-headline text-3xl font-light leading-none tracking-[-0.02em] lg:text-[96px]">{fmtTime(now)}</div>
            <div className="mt-1 hidden text-sm text-[var(--brand-cream)]/80 sm:block lg:mt-3 lg:text-base">{fmtDateLong(today)}</div>
          </div>
          {!!users.length && (
            // Ekip bir liste: düğme gibi kapsül değil (dokunmatik kasada adına dokunan bir şey olacağını sanmasın)
            <div className="hidden lg:block">
              <div className="mb-2.5 text-[13px] font-medium text-[var(--brand-cream)]/80">Ekip</div>
              <ul className="flex flex-wrap gap-x-4 gap-y-2">
                {users.map((u) => (
                  <li key={u.id} className="inline-flex items-center gap-2 text-xs font-medium text-[var(--brand-cream)]/90">
                    {/* Kitin avatarı (kabuk, yönetim ve personel ekranlarıyla aynı); yeşil marka yüzeyinde açık halka */}
                    <Avatar name={u.name} color={u.color} className="size-6 text-[11px] ring-white/25 dark:ring-white/25" />
                    {u.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {/* Sağ altta çekirdeğin yansıması: yalnız süs, ekran okuyucuya kapalı */}
          <span aria-hidden="true" className="pointer-events-none absolute -bottom-24 -right-16 hidden size-80 rounded-full bg-[radial-gradient(circle,rgb(232_200_119/0.16),transparent_65%)] lg:block" />
        </section>

        <section className="flex flex-col justify-center rounded-3xl border border-line bg-surface p-5 shadow-[var(--shadow-card)] sm:p-7">
          {/* Tuş takımı PIN tuşu ölçüsünde kalır: dikey tablette kart geniş, tuşlar 640 px'e yayılmaz */}
          <div className="mx-auto flex w-full max-w-[400px] flex-col">
            <Segmented
              label="Giriş türü"
              className="mx-auto mb-4"
              value={mode}
              onChange={(m) => {
                // Tıklanan düğme odakta kalırsa fiziksel klavyenin Enter'ı PIN'i onaylamaz, düğmeye basar: odak bırakılır
                if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
                if (m === mode) return;
                setMode(m);
                setPin('');
                setError(null);
              }}
              options={[
                { value: 'oturum', label: 'Oturum aç' },
                { value: 'mesai', label: 'Mesai' },
              ]}
            />
            {info.isError && (
              // PIN yazılmadan önce söylenir: yoğun sabahta aynı PIN'i defalarca denemesin
              <Notice
                tone="danger"
                role="alert"
                className="mb-4"
                action={
                  <Button size="sm" loading={info.isFetching} onClick={() => void info.refetch()}>
                    Yeniden dene
                  </Button>
                }
              >
                Kasa sunucusuna ulaşılamıyor; LafPOS bilgisayarının açık ve aynı ağda olduğunu kontrol edin
              </Notice>
            )}
            {/* Başlık ile mesai sonucu aynı sabit yükseklikte yer paylaşır: sonuç kartı gelip gidince tuşlar kaymaz
                (sıradaki kişinin parmağı yanlış sıraya düşmez). Kart görünürken başlık ekran okuyucuda kalır */}
            <div className="relative mb-4 grid min-h-[58px] place-items-center text-center">
              <div className={cn(showPunch && 'sr-only')}>
                <h1 className="text-xl font-bold sm:text-[22px]">{mode === 'mesai' ? 'Mesai başlat ya da bitir' : 'Hoş geldiniz'}</h1>
                <p className="mt-1 text-[13px] text-muted">{mode === 'mesai' ? 'PIN kodunuzu girin; oturum açılmaz' : 'Devam etmek için PIN kodunuzu girin'}</p>
              </div>
              {showPunch && punched && (
                <div role="status" className="animate-fade flex w-full items-center gap-3 rounded-2xl border border-success-line bg-success-soft px-3 py-2.5 text-left">
                  <Avatar name={punched.user.name} color={punched.user.color} className="size-9 text-xs" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5 text-[15px] font-semibold leading-5">
                      <CheckCircle2 aria-hidden="true" className="size-4 shrink-0 text-success-ink" />
                      <span className="truncate">{punched.state === 'in' ? `Hoş geldiniz, ${punched.user.name}` : `Görüşmek üzere, ${punched.user.name}`}</span>
                    </span>
                    <span className="block truncate text-[13px] leading-4 text-ink-2">
                      {punched.repeated
                        ? `${punched.state === 'in' ? `Giriş ${fmtTime(punched.entry.clockIn)}` : `Çıkış ${fmtTime(punched.entry.clockOut ?? punched.entry.clockIn)}`} · zaten kayıtlı`
                        : punched.state === 'in'
                          ? `Giriş ${fmtTime(punched.entry.clockIn)} · mesainiz başladı`
                          : `Çıkış ${fmtTime(punched.entry.clockOut ?? now)} · bu mesai ${fmtDuration(punched.entry.durationMs)}`}
                    </span>
                  </span>
                </div>
              )}
            </div>
            <PinDots filled={pin.length} className="mb-2" />
            <div role="alert" className="mb-3 min-h-5 text-balance text-center text-[13px] font-medium text-[var(--admin-danger-ink)]">
              {error}
            </div>
            {/* Ortak tuş takımı; fiziksel klavye de girer (rakam, Backspace, Delete, Enter) */}
            <Numpad size="lg" keyboard onKey={press} confirm={{ label: mode === 'mesai' ? 'Onayla' : 'Giriş', disabled: pin.length < 4 || busy, onPress: () => press('ok') }} />
            {info.data?.demoPins && (
              // Kurulum modu iki sekmede de aynı yerde (kart sekme değişince zıplamaz); örnek PIN'e dokunmak onu girer:
              // Oturum aç'ta oturum açar, Mesai'de o kişinin mesaisini başlatır ya da bitirir
              <Notice tone="warn" className="mt-4" title="Kurulum modu: örnek PIN’ler">
                {/* Gövde ikonun altından başlar (kitin ikon payı 16 + 12 px): telefonda örnek PIN'ler iki satıra sığar */}
                <div className="-ml-7">
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {info.data.demoPins.map((d) => (
                      <button
                        key={d.name}
                        type="button"
                        onClick={() => void submit(d.pin)}
                        className="inline-flex min-h-8 items-center gap-1 rounded-full bg-surface px-3 text-xs font-medium text-ink ring-1 ring-inset ring-warning-line transition-[box-shadow,background-color] duration-150 hover:ring-[var(--admin-warning)] active:bg-press pointer-coarse:min-h-11"
                      >
                        {d.name} <b className="tabular font-semibold">{d.pin}</b>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs">Canlıya geçmeden önce Yönetim › Personel’den PIN’leri değiştirip kurulum modunu kapatın</p>
                </div>
              </Notice>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
