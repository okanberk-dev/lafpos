import { MonitorCog } from 'lucide-react';
import { Link } from 'react-router';
import { Ring } from '@/components/ui/Button';
import { FLOAT_CARD } from '@/components/ui/misc';
import { cn } from '@/lib/cn';
import { KONTROL_PATH } from '@/lib/download';
import { useUzaktanErisim } from '@/lib/kontrol';

/**
 * Patron panelinde (yalnız AsilPOS Uzaktan) Uzaktan yönetim'e giden kart: kasanın personeli, PIN'i, Tükendi'si ve servis
 * modu telefondan. Kartın tamamı bağlantı; ok halkası üstüne gelince ve odakta döner. Parolasız görünümde yok (uçlar
 * gerçek giriş ister: kart hep aynı hataya götürürdü)
 */
export function UzaktanYonetimKarti({ className }: { className?: string }) {
  const erisim = useUzaktanErisim();
  if (!erisim.kontrol) return null;
  return (
    <Link
      to={KONTROL_PATH}
      className={cn(FLOAT_CARD, 'flex min-h-16 items-center gap-4 px-5 py-4 transition-[border-color,transform] duration-150 hover:border-[var(--admin-border-strong)] active:scale-[0.99] motion-reduce:active:scale-100', className)}
    >
      <span aria-hidden="true" className="grid size-10 shrink-0 place-items-center rounded-[var(--r-segment)] bg-[var(--k-well)] text-[var(--k-ink)] [&>svg]:size-[18px]">
        <MonitorCog />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-base font-semibold leading-6 tracking-[-0.015em] text-ink">Kasayı uzaktan yönet</span>
        <span className="block text-pretty text-[13px] text-muted">Personel, PIN, Tükendi ve servis modu; kasa en geç 5 dakikada uygular</span>
      </span>
      <Ring />
    </Link>
  );
}
