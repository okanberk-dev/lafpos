import { useQuery } from '@tanstack/react-query';
import { type ServiceMode, serviceModeOf } from '@shared/service-mode';
import type { FloorStateDTO } from '@shared/types';
import { get } from './api';
import { useCan } from './auth';
import { useBootQuery } from './boot';
import { homePath } from './nav';
import { REMOTE } from './remote';

/** İşletmenin servis modu (açılış verisinden; ayar değişince canlı olayla yenilenir) */
export function useServiceMode(): ServiceMode {
  const { data } = useBootQuery();
  return serviceModeOf(data?.settings);
}

/** Bu kişinin servis moduna göre açılış sayfası */
export function useHomePath(): string {
  const can = useCan();
  return homePath(can, useServiceMode());
}

/**
 * Self serviste Masalar menüde yalnız masa kullanılıyorsa görünür: masa tanımlı ve masada açık adisyon var
 * (taşınmış tezgâh satışı, sitenin QR masa siparişi). Masa planının canlı sorgusunu paylaşır.
 */
export function useTablesInUse(mode: ServiceMode): boolean {
  const { data: boot } = useBootQuery();
  const can = useCan();
  const enabled = mode === 'self' && !!boot?.tables.length && can('siparis.al');
  const floor = useQuery({ queryKey: ['floor'], queryFn: () => get<FloorStateDTO>('/floor'), enabled, staleTime: 30_000, refetchInterval: REMOTE ? 10_000 : false });
  return enabled && Object.values(floor.data?.tables ?? {}).some((list) => list.length > 0);
}
