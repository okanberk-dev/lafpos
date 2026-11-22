import { ArrowUpRight, Volume2, X } from 'lucide-react';
import { type CSSProperties, type ReactNode, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { readAlertPrefs, useAlertPrefs, VOLUME_STEPS, type VolumeStep, volumeStep, writeAlertPrefs } from '@/lib/alertPrefs';
import { cn } from '@/lib/cn';
import { topDialog, trapTab } from '@/lib/focus';
import { ring, unlockAudio } from '@/lib/sound';
import { toast } from '@/lib/toast';
import { Segmented } from './ui/Field';

/**
 * Araçlar çekmecesi (gnbsite Area Board kitinin Tools çekmecesi; pano: marka rayının ev yeşili degradesinde): tam ekran,
 * yukarıdan perde gibi iner; satırlar ölçülü (18 px, büyük harf yok), üstüne gelince ve etkin ekranda sağda
 * küçük yeşil ok halkası belirir.
 * Ekranlar, bu cihaz (tema, tam ekran) ve oturum (kilitle). Escape ve Kapat kapatır, Tab çekmecede döner, kapanınca odak
 * açan düğmeye döner. Bantta odak halkası açık yeşil (ev yeşili gecede 3:1'in sınırında)
 */
export function ToolsDrawer({ open, onClose, subtitle, children, foot }: { open: boolean; onClose: () => void; subtitle?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  const latest = useRef(onClose);
  useEffect(() => {
    latest.current = onClose;
  });
  const opener = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current && typeof document !== 'undefined') opener.current = document.activeElement as HTMLElement | null;
  wasOpen.current = open;

  useEffect(() => {
    if (!open) return;
    const restore = opener.current;
    // Odak etkin ekranın satırına (yoksa çekmeceye): klavyeyle açan kişi bulunduğu yerden devam eder
    (panel.current?.querySelector<HTMLElement>('[aria-current="page"]') ?? panel.current)?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && topDialog() === panel.current) latest.current();
    };
    window.addEventListener('keydown', onKey);
    const html = document.documentElement;
    const prev = html.style.overflow;
    html.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      html.style.overflow = prev;
      if (restore?.isConnected) restore.focus?.();
    };
  }, [open]);

  if (!open) return null;
  return createPortal(
    <>
      {/* Telefonda çekmece alttan açılan pencere: arkası kararır, dokununca kapanır */}
      <div aria-hidden="true" onClick={onClose} className="lp-drawer-scrim fixed inset-0 z-[59] md:hidden" />
    <div
      ref={panel}
      role="dialog"
      aria-modal="true"
      aria-label="Araçlar"
      tabIndex={-1}
      onKeyDown={(e) => trapTab(e, panel.current)}
      style={{ '--focus': 'var(--band-accent)' } as CSSProperties}
      className="lp-drawer fixed inset-x-0 bottom-0 top-0 z-[60] max-md:top-auto overflow-y-auto overscroll-contain text-[var(--band-text)] outline-none"
    >
      <div className="mx-auto flex min-h-full w-full max-w-[1480px] flex-col px-5 pl-[max(1.25rem,env(safe-area-inset-left))] pr-[max(1.25rem,env(safe-area-inset-right))] sm:px-7">
        <header className="flex items-center justify-between gap-4 pb-2 pt-[max(1.25rem,env(safe-area-inset-top))]">
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-[var(--band-muted)]">Araçlar</p>
            {subtitle && <div className="mt-0.5 truncate text-sm text-[var(--band-text)]">{subtitle}</div>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Kapat"
            title="Kapat"
            className="grid size-11 shrink-0 place-items-center rounded-full bg-[var(--band-2)] text-[var(--band-text)] transition-colors duration-150 hover:bg-[rgb(255_255_255/0.18)]"
          >
            <X aria-hidden="true" className="size-5" />
          </button>
        </header>
        <div className="flex-1 pb-6">{children}</div>
        {foot && <footer className="border-t border-[var(--band-line)] py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-xs text-[var(--band-muted)]">{foot}</footer>}
      </div>
    </div>
    </>,
    document.body,
  );
}

/** Çekmecenin grubu: soluk küçük etiket, altında satırlar (geniş ekranda üç, tablette iki sütun, telefonda tek) */
export function DrawerGroup({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <section aria-label={label} className={cn('mt-6', className)}>
      <h2 className="mb-1 font-sans text-xs font-medium tracking-normal text-[var(--band-muted)]">{label}</h2>
      <div className="grid gap-x-8 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </section>
  );
}

/** Çekmece satırı: iri ad, altında isteğe bağlı küçük açıklama; satırlar sırayla gecikmeli iner */
export const drawerRow =
  'lp-drawer-row group relative flex min-h-14 w-full items-center gap-4 border-b border-[var(--band-line)] py-2 pl-0.5 pr-0.5 text-left text-[var(--band-text)] no-underline transition-[padding] duration-300 ease-[cubic-bezier(0.16,1,0.3,1)] hover:pl-2 focus-visible:pl-2 focus-visible:-outline-offset-2';

export function DrawerLabel({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block text-lg font-semibold leading-tight tracking-[-0.015em]">{children}</span>
      {hint && <span className="mt-0.5 block text-[13px] font-normal leading-4 text-[var(--band-muted)]">{hint}</span>}
    </span>
  );
}

/** Satırın sağındaki yeşil ok halkası: üstüne gelince, odakta ve etkin ekranda belirir (kitin çekmece oku) */
export function DrawerArrow() {
  return (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 -rotate-45 scale-0 place-items-center rounded-full bg-[var(--ok-ring)] text-[var(--ok-arrow)] transition-transform duration-300 group-hover:rotate-0 group-hover:scale-100 group-focus-visible:rotate-0 group-focus-visible:scale-100 group-aria-[current=page]:rotate-0 group-aria-[current=page]:scale-100 motion-reduce:transition-none"
    >
      <ArrowUpRight className="size-3.5 stroke-[2.25]" />
    </span>
  );
}

/** Çekmecedeki kit denetimi (Segmented) bantta: zemin yarı saydam, seçili açık yazı (Tema satırıyla aynı) */
const BAND_CONTROLS =
  '[--admin-surface:var(--band-2)] [--surface-2:var(--band-2)] [--admin-border:var(--band-line)] [--admin-border-strong:var(--band-line)] [--admin-ink-fill:var(--band-text)] [--admin-on-ink:#0a5c44] [--shadow-action:none] [--admin-text:var(--band-text)] [--admin-text-soft:var(--band-muted)] [--ink:var(--band-text)] [--ink-2:var(--band-muted)] [--hover:rgb(255_255_255/0.08)]';

/**
 * Çekmecenin anahtar satırı: bütün satır dokunulur (`role="switch"`), sağda bantın renginde anahtar (açıkken açık nane
 * ray ve koyu yeşil top, kapalıyken yarı saydam ray)
 */
export function DrawerSwitch({ on, onChange, label, hint, style }: { on: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode; style?: CSSProperties }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => onChange(!on)} className={drawerRow} style={style}>
      <DrawerLabel hint={hint}>{label}</DrawerLabel>
      <span aria-hidden="true" className={cn('relative h-[26px] w-[46px] shrink-0 rounded-full ring-1 ring-inset transition-colors duration-200', on ? 'bg-[var(--band-accent)] ring-transparent' : 'bg-[var(--band-2)] ring-[var(--band-muted)]')}>
        <span className={cn('absolute left-[3px] top-[3px] size-5 rounded-full transition-transform duration-200 motion-reduce:transition-none', on ? 'translate-x-5 bg-[#0a5c44]' : 'bg-[var(--band-muted)]')} />
      </span>
    </button>
  );
}

/**
 * Araçlar › Sesli uyarılar (bu cihaz; src/lib/alertPrefs.ts): ses açık mı, düzeyi, hangi uyarılar ve "Sesi dene".
 * Diğer sistemlerden gelen online sipariş ve karaoke uyarısı (src/components/SiteInbox.tsx); duyma yetkisi olmayana
 * çizilmez. "Sesi dene" tarayıcının sesini de açar (ilk dokunuş kuralı)
 */
export function AlertSoundGroup({ online, karaoke, delay = 0 }: { online: boolean; karaoke: boolean; delay?: number }) {
  const prefs = useAlertPrefs();
  if (!online && !karaoke) return null;
  const at = (i: number): CSSProperties => ({ animationDelay: `${delay + i * 35}ms` });
  const test = async () => {
    await unlockAudio();
    if (!ring(readAlertPrefs().volume)) toast.warn('Tarayıcı sesi açmadı; ekrana bir kez dokunup yeniden deneyin');
  };
  return (
    <DrawerGroup label="Sesli uyarılar">
      <DrawerSwitch on={prefs.sound} onChange={(v) => writeAlertPrefs({ sound: v })} label="Uyarı sesi" hint="Sitenin ve uygulamanın siparişleri ve karaokesi; kapalıyken şerit ve bildirim kalır. Bu cihazda saklanır" style={at(0)} />
      <div className={cn(drawerRow, 'flex-wrap gap-y-2 hover:pl-0.5')} style={at(1)}>
        <DrawerLabel hint="Masa siparişi her düzeyde biraz daha yüksek">Ses düzeyi</DrawerLabel>
        <span className={BAND_CONTROLS}>
          <Segmented<VolumeStep>
            label="Ses düzeyi"
            value={volumeStep(prefs.volume)}
            onChange={(v) => {
              const volume = VOLUME_STEPS.find((s) => s.value === v)?.volume ?? prefs.volume;
              writeAlertPrefs({ volume });
              // Seçilen düzey hemen duyulsun (ses kapalıysa ya da kilitliyse çalmaz)
              if (prefs.sound) ring(volume);
            }}
            options={VOLUME_STEPS.map((s) => ({ value: s.value, label: s.label }))}
          />
        </span>
      </div>
      {online && <DrawerSwitch on={prefs.online} onChange={(v) => writeAlertPrefs({ online: v })} label="Online siparişler" hint="Gelince Gördüm diyene dek 3 sn'de bir zil; siteden kalkınca tek ses" style={at(2)} />}
      {karaoke && <DrawerSwitch on={prefs.karaoke} onChange={(v) => writeAlertPrefs({ karaoke: v })} label="Karaoke rezervasyonları" hint="Sitede yeni, iptal edilen ya da saati değişen rezervasyon" style={at(3)} />}
      <button type="button" onClick={() => void test()} className={drawerRow} style={at(4)}>
        <DrawerLabel hint="Zil bir kez çalar; tarayıcı sesi kapattıysa açar">Sesi dene</DrawerLabel>
        <Volume2 aria-hidden="true" className="size-5 shrink-0 text-[var(--band-muted)]" />
      </button>
    </DrawerGroup>
  );
}
