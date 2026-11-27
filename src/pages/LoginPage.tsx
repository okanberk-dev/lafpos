import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { LafTile } from '@/components/LafMark';
import { Button } from '@/components/ui/Button';
import { Avatar, Notice } from '@/components/ui/misc';
import { Numpad, PinDots } from '@/components/ui/Numpad';
import { errorMessage, get } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { businessDate, fmtDateLong, fmtTime } from '@shared/time';

interface LoginInfo {
  users: { id: string; name: string; role: string; color: string }[];
  businessName: string;
  demoPins: { name: string; pin: string }[] | null;
}

/** Saate göre selam (İstanbul saati): giriş kartında saatin üstünde */
function greeting(ms: number): string {
  const h = Number(fmtTime(ms).slice(0, 2));
  return h >= 5 && h < 11 ? 'Günaydın' : h >= 11 && h < 18 ? 'İyi günler' : h >= 18 && h < 23 ? 'İyi akşamlar' : 'İyi geceler';
}

export function LoginPage() {
  const login = useAuth((s) => s.login);
  const navigate = useNavigate();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const info = useQuery({
    queryKey: ['login-info'],
    queryFn: () => get<LoginInfo>('/auth/users'),
    retry: 2,
    // "Kasa sunucusuna ulaşılamıyor" kendiliğinden kalksın: kilit ekranı kasada saatlerce açık durur, odak ya da ağ
    // olayı gelmeyebilir. Hata sürerken 5 sn'de bir yeniden sorulur, yanıt gelince sorgu durur
    refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false),
  });

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
    // Pano girişi (Keel): açık gri zeminde solda ters kart (mürekkep zemin; logo, işletme, iri saat, tarih ve ekip),
    // sağda beyaz PIN kartı. Telefonda marka ve saat şerit olarak kartın üstünde. Zemin belirteçten gelir: ray beyaz
    // olunca bu kartın yazıları görünmez kalmıştı (22 Kas 2026)
    <div className="flex min-h-full items-center justify-center bg-bg p-3 sm:p-6 lg:p-10">
      <div className="grid w-full max-w-5xl items-stretch gap-3 lg:min-h-[580px] lg:grid-cols-[1fr_minmax(380px,430px)] lg:gap-5">
        <section className="relative isolate flex items-center justify-between gap-4 overflow-hidden rounded-[var(--r-card)] k-inverse px-4 py-3.5 shadow-[var(--shadow-lift)] [--band-muted:var(--k-inv-mute)] [--band-text:var(--k-on-select)] sm:px-5 lg:h-full lg:flex-col lg:items-stretch lg:justify-between lg:rounded-[var(--r-stage)] lg:p-9">
          {/* Süs: sağ üstte yumuşak nane ışıltı ve ince halkalar (Keel'in koyu kartındaki derinlik); yazının altında kalır */}
          <div aria-hidden="true" className="pointer-events-none absolute -right-28 -top-28 -z-10 size-[380px] rounded-full [background:radial-gradient(closest-side,color-mix(in_oklab,var(--k-mint)_30%,transparent),transparent)]" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-40 -left-24 -z-10 hidden size-[420px] rounded-full border border-[color-mix(in_oklab,var(--k-on-select)_8%,transparent)] lg:block" />
          <div aria-hidden="true" className="pointer-events-none absolute -bottom-56 -left-40 -z-10 hidden size-[560px] rounded-full border border-[color-mix(in_oklab,var(--k-on-select)_5%,transparent)] lg:block" />
          <div className="flex items-center gap-3">
            <LafTile className="shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)]" />
            <span className="min-w-0">
              <span className="block truncate font-headline text-lg font-bold tracking-[-0.025em]">{info.data?.businessName ?? "L'Affogato"}</span>
              <span className="block text-xs text-[var(--band-muted)]">AsilPOS · kasa</span>
            </span>
          </div>
          <div className="shrink-0 text-right lg:text-left">
            <div className="mb-3 hidden text-[15px] font-medium text-[var(--band-muted)] lg:block">{greeting(now)}</div>
            <div className="tabular font-headline text-3xl font-light leading-none tracking-[-0.04em] lg:text-[112px]">
              {fmtTime(now).slice(0, 2)}
              <span className="text-[var(--band-muted)]">:</span>
              {fmtTime(now).slice(3)}
            </div>
            <div className="mt-1 hidden text-sm text-[var(--band-muted)] sm:block lg:mt-4 lg:text-base">{fmtDateLong(today)}</div>
          </div>
          {!!users.length && (
            // Ekip bir liste: düğme gibi kapsül değil (dokunmatik kasada adına dokunan bir şey olacağını sanmasın)
            <div className="hidden lg:block">
              <div className="mb-3 text-[13px] font-medium text-[var(--band-muted)]">Ekip</div>
              <ul className="flex flex-wrap gap-x-5 gap-y-2.5">
                {users.map((u) => (
                  <li key={u.id} className="inline-flex items-center gap-2 text-sm font-medium text-[var(--band-text)]">
                    {/* Kitin avatarı (kabuk, yönetim ve personel ekranlarıyla aynı); gecede açık halka */}
                    <Avatar name={u.name} color={u.color} className="size-7 text-[11px] ring-white/25 dark:ring-white/25" />
                    {u.name}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section className="flex flex-col justify-center rounded-[var(--r-card)] border border-transparent bg-surface p-5 text-ink shadow-[var(--shadow-leaf)] sm:p-7 lg:rounded-[var(--r-stage)] dark:border-[var(--admin-border)]">
          {/* Tuş takımı PIN tuşu ölçüsünde kalır: dikey tablette kart geniş, tuşlar 640 px'e yayılmaz */}
          <div className="mx-auto flex w-full max-w-[400px] flex-col">
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
                Kasa sunucusuna ulaşılamıyor; AsilPOS bilgisayarının açık ve aynı ağda olduğunu kontrol edin
              </Notice>
            )}
            <div className="mb-5">
              <h1 className="font-headline text-2xl font-bold tracking-[-0.035em] sm:text-[28px]">Hoş geldiniz</h1>
              <p className="mt-1 text-[13px] text-muted">Devam etmek için PIN kodunuzu girin</p>
            </div>
            <PinDots filled={pin.length} className="mb-2 justify-start gap-3.5 [&>span]:size-3.5" />
            <div role="alert" className="mb-3 min-h-5 text-balance text-[13px] font-medium text-[var(--admin-danger-ink)]">
              {error}
            </div>
            {/* Ortak tuş takımı; fiziksel klavye de girer (rakam, Backspace, Delete, Enter) */}
            <Numpad size="lg" keyboard onKey={press} confirm={{ label: 'Giriş', disabled: pin.length < 4 || busy, onPress: () => press('ok') }} />
            {info.data?.demoPins && (
              // Deneme modu: örnek PIN'e dokunmak o kişiyle oturum açar
              <Notice tone="warn" className="mt-4" title="Deneme modu: örnek PIN’ler">
                {/* Gövde ikonun altından başlar (kitin ikon payı 16 + 12 px): telefonda örnek PIN'ler iki satıra sığar */}
                <div className="-ml-7">
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {info.data.demoPins.map((d) => (
                      <button
                        key={d.name}
                        type="button"
                        onClick={(e) => {
                          // Giriş hatalı dönerse sayfa açık kalır: çip odakta kalırsa klavyeyle yazılan PIN'in Enter'ı
                          // çipe basar, çipin PIN'i yeniden gider. Odak bırakılır
                          e.currentTarget.blur();
                          void submit(d.pin);
                        }}
                        className="inline-flex min-h-8 items-center gap-1 rounded-full bg-surface px-3 text-xs font-medium text-ink ring-1 ring-inset ring-warning-line transition-[box-shadow,background-color] duration-150 hover:ring-[var(--admin-warning)] active:bg-press pointer-coarse:min-h-11"
                      >
                        {d.name} <b className="tabular font-semibold">{d.pin}</b>
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs">Deneme bitince patron Yönetim › Ayarlar ve yedek › “Denemeyi bitir, gerçek kullanıma başla” der; örnek PIN’ler kapanır</p>
                </div>
              </Notice>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
