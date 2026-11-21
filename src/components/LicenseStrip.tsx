import { useQuery } from '@tanstack/react-query';
import type { LicenseState } from '@shared/lisans';
import { get } from '@/lib/api';
import { useCan } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { DEMO } from '@/lib/demo';
import { REMOTE } from '@/lib/remote';

export interface LicenseInfo {
  enabled: boolean;
  state?: LicenseState;
  until?: number | null;
  message?: string;
  /** Aktif lisansın bitişine 14 günden az kaldı (yalnız uyarı) */
  soon?: boolean;
  /** Kural satışı kapatırdı ama kasa Merkez'e ulaşamıyor: satış sürer */
  offline?: boolean;
  ad?: string | null;
  /** Merkez'de verilen şube kodu */
  kod?: string | null;
  /** Aktif lisansın son günü (YYYY-MM-DD); süresizde null */
  bitis?: string | null;
  sonGorusme?: number | null;
  kurulum?: { enabled: boolean; lastOk: number | null; lastError: string | null; id: string | null };
}

export const licenseQuery = { queryKey: ['sync', 'lisans'], queryFn: () => get<LicenseInfo>('/sync/lisans'), refetchInterval: 5 * 60_000 };

/**
 * Merkez lisansı (server/sync/merkez.ts): yalnız sorun varken, deneme modu şeridiyle aynı ince satır. Uyarıda amber
 * ("Lisans pasif: 3 gün sonra yeni satış kapanacak"), kapalıyken kırmızı. Bitişe 14 günden az kalan etkin lisans da
 * amber, yalnız ayar yetkisi olana (personel bir şey yapamaz). Deneme süresi ve etkin lisans çizilmez (ferah kabuk);
 * ayrıntı Yönetim › Ayarlar ve yedek › Sürüm ve güncelleme'de
 */
export function LicenseStrip() {
  const q = useQuery({ ...licenseQuery, enabled: !REMOTE && !DEMO });
  const can = useCan();
  const d = q.data;
  const soon = d?.state === 'aktif' && !!d.soon && can('ayar.yonet');
  if (!d?.enabled || (d.state !== 'uyari' && d.state !== 'kapali' && !soon)) return null;
  const closed = d.state === 'kapali';
  return (
    <p
      role={closed ? 'alert' : 'status'}
      className={cn(
        'shrink-0 border-b px-4 py-1.5 text-center text-[13px] font-medium leading-5 text-ink md:mx-[var(--shell-gap)] md:mt-2 md:rounded-xl md:border',
        closed ? 'border-[var(--admin-danger-line)] bg-[var(--admin-danger-soft)]' : 'border-[var(--admin-warning-line)] bg-[var(--admin-warning-soft)]',
      )}
    >
      {d.message}
    </p>
  );
}
