import { Check } from 'lucide-react';
import { type CSSProperties, useEffect, useState } from 'react';
import { tl } from '@shared/money';
import { fmtTime } from '@shared/time';
import type { CustomerDisplaySettings, CustomerDisplayTheme, DisplayStateDTO } from '@shared/types';
import { LafMark } from '@/components/LafMark';
import { QrCode } from '@/components/QrCode';
import { cn } from '@/lib/cn';

/** Sunucunun varsayılanıyla aynı (server/lib/settings.ts): ayar gelmeden ya da eski sunucuda ekran yine çizilir */
export const DISPLAY_DEFAULTS: CustomerDisplaySettings = {
  theme: 'gece',
  welcomeTitle: 'Hoş geldiniz',
  welcomeSubtitle: 'Drink it. Eat the cup.',
  thanksTitle: 'Teşekkürler, afiyet olsun',
  messages: [],
  qrUrl: '',
  qrLabel: 'Uygulamayı indirin, damga kazanın',
  showClock: true,
  showOptions: true,
};

/**
 * Ekranın kendi paleti: uygulamanın temasından bağımsız (yönetimdeki önizleme açık temada da gece çizer). Değerler
 * laffogato.net'ten (docs/BRAND.md): gece kafesi, porselen zemin, ev yeşili marka yüzeyi; tutar paneli her temada
 * markanın yüzeyidir. Soluk yazılar kendi zemininde 4.5:1'in üstünde.
 */
const PALETTE: Record<CustomerDisplayTheme, Record<string, string>> = {
  gece: {
    '--d-bg': '#0f0e0d',
    '--d-glow': 'radial-gradient(60% 55% at 50% 40%, rgb(29 109 86 / 0.34), transparent 72%)',
    '--d-surface': '#181715',
    '--d-chip': '#272522',
    '--d-line': '#2e2c29',
    '--d-text': '#f3f1ec',
    '--d-soft': '#cfcbc3',
    '--d-mute': '#a39f96',
    '--d-accent': '#5cc9a2',
    '--d-letters': '#fbf6f1',
    '--d-bean': '#e8c877',
    '--d-panel': 'radial-gradient(130% 90% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
    '--d-panel-text': '#fbf6f1',
    '--d-panel-soft': 'rgb(251 246 241 / 0.86)',
    '--d-rule': 'linear-gradient(to right, #d3e2d9 0 33.33%, #fbf8f4 33.33% 66.66%, #f6e9ec 66.66% 100%)',
  },
  porselen: {
    '--d-bg': '#f7f3ed',
    '--d-glow': 'radial-gradient(60% 55% at 50% 40%, rgb(29 109 86 / 0.1), transparent 72%)',
    '--d-surface': '#ffffff',
    '--d-chip': '#f2ece4',
    '--d-line': '#ebe5dc',
    '--d-text': '#211c18',
    '--d-soft': '#564d46',
    '--d-mute': '#675e56',
    '--d-accent': '#1d6d56',
    '--d-letters': '#211c18',
    '--d-bean': '#b08a2e',
    '--d-panel': 'radial-gradient(130% 90% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
    '--d-panel-text': '#fbf6f1',
    '--d-panel-soft': 'rgb(251 246 241 / 0.86)',
    '--d-rule': 'linear-gradient(to right, #1d6d56 0 33.33%, #e0d8cd 33.33% 66.66%, #9d2543 66.66% 100%)',
  },
  yesil: {
    '--d-bg': '#0c3b2d',
    '--d-glow': 'radial-gradient(130% 95% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
    '--d-surface': 'rgb(255 255 255 / 0.07)',
    '--d-chip': 'rgb(255 255 255 / 0.12)',
    '--d-line': 'rgb(255 255 255 / 0.14)',
    '--d-text': '#fbf6f1',
    '--d-soft': 'rgb(251 246 241 / 0.9)',
    '--d-mute': 'rgb(251 246 241 / 0.86)',
    '--d-accent': '#e8c877',
    '--d-letters': '#fbf6f1',
    '--d-bean': '#e8c877',
    '--d-panel': '#fbf8f4',
    '--d-panel-text': '#211c18',
    '--d-panel-soft': '#564d46',
    '--d-rule': 'linear-gradient(to right, #d3e2d9 0 33.33%, #fbf8f4 33.33% 66.66%, #f6e9ec 66.66% 100%)',
  },
};

/** Boştaki duyurular 6 sn'de bir döner (hareket azaltmada yalnız metin değişir) */
function useRotation(count: number, ms = 6000) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (count < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % count), ms);
    return () => clearInterval(t);
  }, [count, ms]);
  return count ? i % count : 0;
}

/**
 * Müşteri ekranının kendisi: boşta karşılama (logo, başlık, slogan, dönen duyurular, karekod), adisyon açıkken kalemler
 * ve büyük tutar, ödemeden sonra teşekkür (self serviste çağrı numarası). Sayfa (`/musteri-ekrani`) ve yönetimdeki
 * canlı önizleme aynı bileşeni çizer; kabını doldurur.
 */
export function CustomerDisplayView({
  state,
  config,
  businessName,
  now,
  className,
}: {
  state: DisplayStateDTO;
  config: CustomerDisplaySettings;
  businessName: string;
  now: number;
  className?: string;
}) {
  const messages = config.messages.filter((m) => m.trim());
  const shown = useRotation(messages.length);
  const style = PALETTE[config.theme] as CSSProperties;
  const welcome = config.welcomeTitle.trim() || DISPLAY_DEFAULTS.welcomeTitle;
  const thanks = config.thanksTitle.trim() || DISPLAY_DEFAULTS.thanksTitle;
  const qr = config.qrUrl.trim();

  const mark = (cls: string) => <LafMark className={cn('text-[var(--d-letters)]', cls)} bean="var(--d-bean)" title={businessName} />;
  const rule = <span aria-hidden="true" className="mx-auto block h-1 w-12 rounded-full" style={{ background: 'var(--d-rule)' }} />;
  const qrCard = qr ? (
    <div className="flex max-w-full items-center gap-4 rounded-3xl bg-white p-3 pr-5 text-[#211c18] shadow-[0_10px_30px_rgb(0_0_0/0.18)]">
      <QrCode value={qr} label={config.qrLabel || 'Karekod'} className="size-24 border-0 md:size-28" />
      {config.qrLabel && <p className="max-w-[18ch] text-pretty text-base font-medium leading-snug md:text-lg">{config.qrLabel}</p>}
    </div>
  ) : null;

  return (
    <div className={cn('relative h-full w-full overflow-hidden text-[var(--d-text)]', className)} style={{ ...style, background: 'var(--d-bg)' }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'var(--d-glow)' }} />

      {state.kind === 'order' ? (
        <div className="relative grid h-full min-h-0 gap-4 p-3 md:p-6 lg:grid-cols-[1.45fr_1fr]">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-[var(--d-line)] bg-[var(--d-surface)]">
            <header className="flex items-center gap-3 border-b border-[var(--d-line)] px-5 py-4 md:px-6">
              {mark('h-7 shrink-0')}
              <h1 className="font-headline text-xl font-bold md:text-2xl">Siparişiniz</h1>
              <span className="flex-1" />
              <span className="truncate rounded-full bg-[var(--d-chip)] px-3 py-1 text-sm font-medium text-[var(--d-soft)]">{state.label}</span>
            </header>
            <ul className="scroll-thin min-h-0 flex-1 divide-y divide-[var(--d-line)] overflow-y-auto">
              {state.lines.map((l, i) => (
                <li key={`${l.name}-${i}`} className="flex items-start gap-4 px-5 py-4 md:px-6">
                  <span className="tabular grid min-w-11 place-items-center rounded-2xl bg-[var(--d-chip)] px-2 py-1.5 font-headline text-xl font-bold">{l.qty}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-semibold leading-snug md:text-xl">
                      {l.name}
                      {l.size && <span className="ml-2 text-base font-medium text-[var(--d-mute)]">{l.size}</span>}
                    </span>
                    {config.showOptions && l.options && <span className="mt-0.5 block text-sm text-[var(--d-mute)] md:text-base">{l.options}</span>}
                  </span>
                  <span className="tabular whitespace-nowrap font-headline text-lg font-bold md:text-xl">{l.total ? tl(l.total) : 'İkram'}</span>
                </li>
              ))}
            </ul>
          </section>
          <section className="flex flex-col gap-5 overflow-hidden rounded-3xl p-6 text-[var(--d-panel-text)] md:p-8" style={{ background: 'var(--d-panel)' }}>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-base font-medium text-[var(--d-panel-soft)]">{businessName}</span>
              {config.showClock && <span className="tabular font-headline text-lg font-semibold text-[var(--d-panel-soft)]">{fmtTime(now)}</span>}
            </div>
            <div className="flex-1" />
            <div className="space-y-2 text-lg">
              {state.discount > 0 && <PanelRow label="İndirim" value={`−${tl(state.discount)}`} />}
              {state.service > 0 && <PanelRow label="Servis" value={tl(state.service)} />}
              {state.paid > 0 && <PanelRow label="Ödenen" value={tl(state.paid)} />}
            </div>
            <div>
              <p className="text-lg text-[var(--d-panel-soft)]">{state.paid > 0 ? 'Kalan' : 'Toplam'}</p>
              <p className="tabular font-headline text-[clamp(3rem,7vw,5.5rem)] font-extrabold leading-none tracking-[-0.035em]">{tl(state.paid > 0 ? state.due : state.total)}</p>
            </div>
            {messages.length > 0 && (
              <p key={shown} className="animate-fade border-t border-current/15 pt-4 text-base leading-snug text-[var(--d-panel-soft)]">
                {messages[shown]}
              </p>
            )}
          </section>
        </div>
      ) : (
        <div className="relative flex h-full flex-col">
          <div className="flex items-center justify-between gap-4 px-6 pt-5 md:px-10 md:pt-8">
            <span className="truncate text-base font-medium text-[var(--d-mute)] md:text-lg">{businessName}</span>
            {config.showClock && <span className="tabular font-headline text-xl font-semibold text-[var(--d-soft)] md:text-2xl">{fmtTime(now)}</span>}
          </div>
          {/* Izgara öğesi içeriğin en geniş kelimesine göre büyümesin: uzun masa no telefonda taşmasın */}
          <div className="grid min-h-0 flex-1 place-items-center px-6 py-6 text-center md:px-10">
            <div className="w-full min-w-0">
              {state.kind === 'thanks' ? (
                <>
                  <span className="mx-auto grid size-20 place-items-center rounded-full bg-[var(--d-accent)] text-[var(--d-bg)] md:size-24">
                    <Check aria-hidden="true" className="size-10 stroke-[2.5] md:size-12" />
                  </span>
                  <h1 className="mt-8 font-headline text-[clamp(2.25rem,6vw,4.5rem)] font-extrabold leading-[1.05] tracking-[-0.035em]">{thanks}</h1>
                  <p className="tabular mt-4 text-xl text-[var(--d-soft)] md:text-2xl">{tl(state.total)}</p>
                  {state.call && <CallNumber call={state.call} />}
                </>
              ) : (
                <>
                  {mark('mx-auto h-20 md:h-28')}
                  <h1 className="mt-8 font-headline text-[clamp(2.5rem,7vw,5.25rem)] font-extrabold leading-[1.02] tracking-[-0.035em]">{welcome}</h1>
                  <div className="mt-5">{rule}</div>
                  {config.welcomeSubtitle.trim() && <p className="mx-auto mt-5 max-w-[32ch] text-pretty text-xl font-light text-[var(--d-soft)] md:text-2xl">{config.welcomeSubtitle}</p>}
                </>
              )}
            </div>
          </div>
          {state.kind !== 'thanks' && (messages.length > 0 || qrCard) && (
            <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-6 md:px-10 md:pb-10">
              {messages.length > 0 ? (
                <p
                  key={shown}
                  className="animate-fade max-w-full rounded-full border border-[var(--d-line)] bg-[var(--d-surface)] px-5 py-3 text-base font-medium text-[var(--d-soft)] backdrop-blur-sm md:text-lg"
                >
                  {messages[shown]}
                </p>
              ) : (
                <span />
              )}
              {qrCard}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function PanelRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="tabular flex justify-between gap-4 text-[var(--d-panel-soft)]">
      <span>{label}</span>
      <span>{value}</span>
    </div>
  );
}

/**
 * Self servisin çağrı kimliği teşekkürde: "No 34" numara (müşteri çağrı ekranında bekler), "Masa 12" masa (personel
 * getirir). Kasa `callText` biçiminde gönderir.
 */
function CallNumber({ call }: { call: string }) {
  const no = /^No (.+)$/.exec(call)?.[1];
  const shown = no ?? call;
  // Uzun kimlik ("Masa WWWWWW"): çağrı ekranındaki gibi ekranla küçülen yazı ve kırılan kelime (390 px'te taşmasın)
  const long = shown.length > 5;
  return (
    <div className="mx-auto mt-8 w-fit min-w-56 max-w-full rounded-3xl border border-[var(--d-line)] bg-[var(--d-surface)] px-8 py-5 max-sm:min-w-0 max-sm:px-5">
      <p className="text-lg font-medium text-[var(--d-mute)]">{no ? 'Numaranız' : 'Siparişiniz'}</p>
      <p className={cn('tabular font-headline font-extrabold leading-tight tracking-tight [overflow-wrap:anywhere]', long ? 'text-[clamp(2.25rem,9vw,5rem)]' : 'text-7xl md:text-8xl')}>{shown}</p>
      <p className="mt-1 text-lg text-[var(--d-soft)]">{no ? 'Hazır olunca çağrı ekranında görünür' : 'Masanıza getirilecek'}</p>
    </div>
  );
}
