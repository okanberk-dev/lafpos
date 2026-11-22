import { Check } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
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
 * markanın yüzeyidir. Soluk yazılar kendi zemininde 4.5:1'in üstünde. Kart gölgesi yalnız porselende (sıcak toprak,
 * kasa kartıyla aynı); koyu zeminde ayrımı çizgi yapar. Karekod kartı her temada beyaz kâğıt, mürekkebi sabit.
 */
const PALETTE: Record<CustomerDisplayTheme, Record<string, string>> = {
  gece: {
    '--d-bg': '#000000',
    // Gece (uygulamanın koyu temasıyla aynı nötr palet): siyah zeminde krema dalgaları, ortada ev yeşili hale
    '--d-glow': 'var(--waves-light) 0 0 / 800px 240px repeat, radial-gradient(60% 55% at 50% 40%, rgb(10 133 96 / 0.26), transparent 72%)',
    '--d-surface': '#1c1c1e',
    '--d-chip': '#2a2a2c',
    '--d-line': '#38383a',
    '--d-text': '#f5f5f7',
    '--d-soft': '#d1d1d6',
    '--d-mute': '#9e9ea4',
    '--d-accent': '#34d399',
    '--d-letters': '#fbf6f1',
    '--d-bean': '#e8c877',
    '--d-panel': 'radial-gradient(130% 90% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
    '--d-panel-text': '#fbf6f1',
    '--d-panel-soft': 'rgb(251 246 241 / 0.86)',
    '--d-rule': 'linear-gradient(to right, #34d399 0 33.33%, #f5f5f7 33.33% 66.66%, #ff7b72 66.66% 100%)',
    '--d-card-shadow': 'none',
    '--d-qr-ink': '#211c18',
    '--d-qr-shadow': '0 10px 30px rgb(0 0 0 / 0.18)',
  },
  porselen: {
    '--d-bg': '#f4f1ec',
    '--d-glow': 'var(--waves-dark) 0 0 / 800px 240px repeat, radial-gradient(60% 55% at 50% 40%, rgb(29 109 86 / 0.1), transparent 72%)',
    '--d-surface': '#ffffff',
    '--d-chip': '#f0ebe5',
    '--d-line': '#e7e1d8',
    '--d-text': '#17130f',
    '--d-soft': '#4b433c',
    '--d-mute': '#665d55',
    '--d-accent': '#1d6d56',
    '--d-letters': '#211c18',
    '--d-bean': '#b08a2e',
    '--d-panel': 'radial-gradient(130% 90% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
    '--d-panel-text': '#fbf6f1',
    '--d-panel-soft': 'rgb(251 246 241 / 0.86)',
    '--d-rule': 'linear-gradient(to right, #1d6d56 0 33.33%, #e0d8cd 33.33% 66.66%, #9d2543 66.66% 100%)',
    '--d-card-shadow': '0 1px 2px rgb(59 42 30 / 0.04), 0 6px 16px rgb(59 42 30 / 0.05)',
    '--d-qr-ink': '#211c18',
    '--d-qr-shadow': '0 10px 30px rgb(59 42 30 / 0.12)',
  },
  yesil: {
    '--d-bg': '#0c3b2d',
    '--d-glow': 'var(--waves-light) 0 0 / 800px 240px repeat, radial-gradient(130% 95% at 18% 0%, #1d6d56 0%, #155240 46%, #0c3b2d 100%)',
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
    '--d-card-shadow': 'none',
    '--d-qr-ink': '#211c18',
    '--d-qr-shadow': '0 10px 30px rgb(0 0 0 / 0.18)',
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
 * Büyük tutarın boyu panelin kendi genişliğinden (panel `@container`): Gabarito 800'de karakter başına ~0,5 em,
 * tutar panelin %95'ine sığar, en çok 88 px (DESIGN: 48-88). Yatay telefonda ve 8" tablette panel dar kalınca tutar
 * küçülür, kesilmez; geniş ekranda 88 px'te durur.
 */
const totalSize = (text: string): CSSProperties => ({ fontSize: `min(5.5rem, ${(190 / Math.max(6, text.length)).toFixed(2)}cqi)` });

/**
 * Müşteri ekranının kendisi: boşta karşılama (logo, başlık, slogan, dönen duyurular, karekod), adisyon açıkken kalemler
 * ve büyük tutar, ödemeden sonra teşekkür (self serviste çağrı numarası). Sayfa (`/musteri-ekrani`) ve yönetimdeki
 * canlı önizleme aynı bileşeni çizer; kabını doldurur. Yerleşim ve ölçek pencereye değil kabın kendisine göre
 * (`container-type: size`; `@3xl` kabın 768 px'i, `orientation` kabın yatay ya da dikey oluşu): yönetimdeki 1280×720
 * önizleme telefonda da gerçek ekranın birebir küçüğüdür.
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

  // Kasada eklenen kalem listenin sonuna düşer: liste kendiliğinden en alta kayar (ikinci monitörde kimse kaydırmaz).
  // Üstte kalan kalemler varken listenin üst kenarı solar: "yukarıda daha var"
  const listRef = useRef<HTMLUListElement>(null);
  const [moreAbove, setMoreAbove] = useState(false);
  const lineCount = state.kind === 'order' ? state.lines.length : 0;
  useEffect(() => {
    const el = listRef.current;
    if (!el || !lineCount) return;
    const overflows = el.scrollHeight > el.clientHeight + 1;
    setMoreAbove(overflows);
    if (overflows) el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [lineCount]);

  const mark = (cls: string) => <LafMark className={cn('text-[var(--d-letters)]', cls)} bean="var(--d-bean)" title={businessName} />;
  const rule = <span aria-hidden="true" className="mx-auto block h-1 w-12 rounded-full" style={{ background: 'var(--d-rule)' }} />;
  const qrCard = qr ? (
    <div className="flex max-w-full items-center gap-4 rounded-3xl bg-white p-3 pr-5 text-[var(--d-qr-ink)] shadow-[var(--d-qr-shadow)]">
      <QrCode value={qr} label={config.qrLabel || 'Karekod'} className="size-24 border-0 @3xl:size-28 [@container(height<36rem)]:size-20!" />
      {config.qrLabel && <p className="max-w-[18ch] text-pretty text-base font-medium leading-snug @3xl:text-lg">{config.qrLabel}</p>}
    </div>
  ) : null;
  const amount = state.kind === 'order' ? tl(state.paid > 0 ? state.due : state.total) : '';

  return (
    // surface-soft: Yönetim › Müşteri ekranı'ndaki önizlemede de kasanın köşeleri (gerçek ekranın birebir küçüğü)
    <div className={cn('surface-soft relative h-full w-full overflow-hidden text-[var(--d-text)] [container-type:size]', className)} style={{ ...style, background: 'var(--d-bg)' }}>
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={{ background: 'var(--d-glow)' }} />

      {state.kind === 'order' ? (
        // Yatay kapta liste ve tutar yan yana; dikeyde liste kalan boyu alıp kayar, tutar paneli kendi boyunda altta
        // (yatay telefonda ve 8" tablette panel ikiye bölünüp tutarı kesmez)
        <div className="relative grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] gap-4 p-3 @3xl:p-6 [@container(orientation:landscape)]:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)] [@container(orientation:landscape)]:grid-rows-1">
          <section className="flex min-h-0 flex-col overflow-hidden rounded-3xl border border-[var(--d-line)] bg-[var(--d-surface)] shadow-[var(--d-card-shadow)]">
            <header className="flex items-center gap-3 border-b border-[var(--d-line)] px-5 py-4 @3xl:px-6">
              {mark('h-7 shrink-0 @[100rem]:h-9')}
              <h1 className="font-headline text-xl font-bold @3xl:text-2xl @[100rem]:text-3xl">Siparişiniz</h1>
              <span className="flex-1" />
              <span className="truncate rounded-full bg-[var(--d-chip)] px-3 py-1 text-sm font-medium text-[var(--d-soft)] @[100rem]:px-4 @[100rem]:text-lg">{state.label}</span>
            </header>
            <ul
              ref={listRef}
              onScroll={(e) => setMoreAbove(e.currentTarget.scrollTop > 4)}
              className={cn('no-scrollbar min-h-0 flex-1 divide-y divide-[var(--d-line)] overflow-y-auto', moreAbove && '[mask-image:linear-gradient(to_bottom,transparent,black_48px)]')}
            >
              {state.lines.map((l, i) => (
                <li key={`${l.name}-${i}`} className="flex items-start gap-4 px-5 py-4 @3xl:px-6 @[100rem]:py-5">
                  <span className="tabular grid min-w-11 place-items-center rounded-xl bg-[var(--d-chip)] px-2 py-1.5 font-headline text-xl font-bold @[100rem]:min-w-14 @[100rem]:text-2xl">{l.qty}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-semibold leading-snug @3xl:text-xl @[100rem]:text-2xl">
                      {l.name}
                      {l.size && <span className="ml-2 text-base font-medium text-[var(--d-mute)] @[100rem]:text-lg">{l.size}</span>}
                    </span>
                    {config.showOptions && l.options && <span className="mt-0.5 block text-sm text-[var(--d-mute)] @3xl:text-base @[100rem]:text-lg">{l.options}</span>}
                  </span>
                  <span className="tabular whitespace-nowrap font-headline text-lg font-bold @3xl:text-xl @[100rem]:text-2xl">{l.total ? tl(l.total) : 'İkram'}</span>
                </li>
              ))}
            </ul>
          </section>
          {/* Panel kendi kabı: tutar onun genişliğine göre, iç yazılar geniş panelde (büyük ekran, dikey tablet) bir boy büyük */}
          <section className="@container flex flex-col gap-5 overflow-hidden rounded-3xl p-6 text-[var(--d-panel-text)] @3xl:p-8" style={{ background: 'var(--d-panel)' }}>
            <div className="flex items-center justify-between gap-3">
              <span className="truncate text-base font-medium text-[var(--d-panel-soft)] @lg:text-xl">{businessName}</span>
              {config.showClock && <span className="tabular font-headline text-lg font-semibold text-[var(--d-panel-soft)] @lg:text-xl">{fmtTime(now)}</span>}
            </div>
            <div className="flex-1" />
            {(state.discount > 0 || state.service > 0 || state.paid > 0) && (
              <div className="space-y-2 text-lg @lg:text-xl">
                {state.discount > 0 && <PanelRow label="İndirim" value={`−${tl(state.discount)}`} />}
                {state.service > 0 && <PanelRow label="Servis" value={tl(state.service)} />}
                {state.paid > 0 && <PanelRow label="Ödenen" value={tl(state.paid)} />}
              </div>
            )}
            <div>
              <p className="text-lg text-[var(--d-panel-soft)] @lg:text-xl">{state.paid > 0 ? 'Kalan' : 'Toplam'}</p>
              <p className="tabular whitespace-nowrap font-headline font-extrabold leading-none tracking-[-0.035em]" style={totalSize(amount)}>
                {amount}
              </p>
            </div>
            {messages.length > 0 && (
              <p key={shown} className="animate-fade border-t border-current/15 pt-4 text-base leading-snug text-[var(--d-panel-soft)] @lg:text-lg">
                {messages[shown]}
              </p>
            )}
          </section>
        </div>
      ) : (
        <div className="relative flex h-full flex-col">
          <div className="flex items-center justify-between gap-4 px-6 pt-5 @3xl:px-10 @3xl:pt-8 [@container(height<36rem)]:px-6! [@container(height<36rem)]:pt-3!">
            <span className="truncate text-base font-medium text-[var(--d-mute)] @3xl:text-lg">{businessName}</span>
            {config.showClock && <span className="tabular font-headline text-xl font-semibold text-[var(--d-soft)] @3xl:text-2xl">{fmtTime(now)}</span>}
          </div>
          {/* Izgara öğesi içeriğin en geniş kelimesine göre büyümesin: uzun masa no telefonda taşmasın. Alçak kapta
              (yatay telefon: 576 px'ten kısa) logo, simge ve aralıklar küçülür: alt şerit başlığın üstüne binmez */}
          <div className="grid min-h-0 flex-1 place-items-center px-6 py-6 text-center @3xl:px-10 [@container(height<36rem)]:py-2!">
            <div className="w-full min-w-0">
              {state.kind === 'thanks' ? (
                <>
                  <span className="mx-auto grid size-20 place-items-center rounded-full bg-[var(--d-accent)] text-[var(--d-bg)] @3xl:size-24 [@container(height<36rem)]:size-14!">
                    <Check aria-hidden="true" className="size-10 stroke-[2.5] @3xl:size-12 [@container(height<36rem)]:size-7!" />
                  </span>
                  <h1 className="mt-8 font-headline text-[clamp(2.25rem,6cqw,4.5rem)] font-extrabold leading-[1.05] tracking-[-0.035em] [@container(height<36rem)]:mt-4!">{thanks}</h1>
                  <p className="tabular mt-4 font-headline text-xl font-medium text-[var(--d-soft)] @3xl:text-[26px] [@container(height<36rem)]:mt-2!">{tl(state.total)}</p>
                  {state.call && <CallNumber call={state.call} />}
                </>
              ) : (
                <>
                  {mark('mx-auto h-20 @3xl:h-28 [@container(height<36rem)]:h-14!')}
                  <h1 className="mt-8 font-headline text-[clamp(2.5rem,7cqw,5.25rem)] font-extrabold leading-[1.02] tracking-[-0.035em] [@container(height<36rem)]:mt-4! [@container(height<36rem)]:text-[clamp(2.25rem,5cqw,3.5rem)]!">{welcome}</h1>
                  <div className="mt-5 [@container(height<36rem)]:mt-3!">{rule}</div>
                  {config.welcomeSubtitle.trim() && (
                    <p className="mx-auto mt-5 max-w-[32ch] text-pretty text-xl font-light text-[var(--d-soft)] @3xl:text-2xl [@container(height<36rem)]:mt-3! [@container(height<36rem)]:text-lg!">{config.welcomeSubtitle}</p>
                  )}
                </>
              )}
            </div>
          </div>
          {state.kind !== 'thanks' && (messages.length > 0 || qrCard) && (
            // Yatayda duyuru solda, karekod sağda; dikey kapta ikisi alt alta ve ortada (logonun ve başlığın hizasında)
            <div className="flex flex-wrap items-end justify-between gap-4 px-6 pb-6 @3xl:px-10 @3xl:pb-10 [@container(height<36rem)]:flex-nowrap! [@container(height<36rem)]:px-6! [@container(height<36rem)]:pb-4! [@container(orientation:portrait)]:flex-col [@container(orientation:portrait)]:flex-nowrap [@container(orientation:portrait)]:items-center">
              {messages.length > 0 ? (
                <p
                  key={shown}
                  className="animate-fade max-w-full text-pretty rounded-3xl border border-[var(--d-line)] bg-[var(--d-surface)] px-5 py-3 text-base font-medium text-[var(--d-soft)] shadow-[var(--d-card-shadow)] backdrop-blur-sm @3xl:text-lg [@container(orientation:landscape)]:rounded-full [@container(orientation:portrait)]:text-center [@container(height<36rem)]:rounded-3xl! [@container(height<36rem)]:text-base!"
                >
                  {messages[shown]}
                </p>
              ) : (
                <span className="[@container(orientation:portrait)]:hidden" />
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
    <div className="mx-auto mt-8 w-fit min-w-56 max-w-full rounded-3xl border border-[var(--d-line)] bg-[var(--d-surface)] px-8 py-5 shadow-[var(--d-card-shadow)] @max-[40rem]:min-w-0 @max-[40rem]:px-5 [@container(height<36rem)]:mt-4! [@container(height<36rem)]:py-3!">
      <p className="text-lg font-medium text-[var(--d-mute)] [@container(height<36rem)]:text-base!">{no ? 'Numaranız' : 'Siparişiniz'}</p>
      <p
        className={cn(
          'tabular font-headline font-extrabold leading-[1.05] tracking-tight [overflow-wrap:anywhere]',
          long ? 'text-[clamp(2.25rem,9cqw,5rem)] [@container(height<36rem)]:text-[clamp(2rem,6cqw,3.5rem)]!' : 'text-7xl @3xl:text-8xl [@container(height<36rem)]:text-6xl!',
        )}
      >
        {shown}
      </p>
      <p className="mt-1 text-lg text-[var(--d-soft)] [@container(height<36rem)]:text-base!">{no ? 'Hazır olunca çağrı ekranında görünür' : 'Masanıza getirilecek'}</p>
    </div>
  );
}
