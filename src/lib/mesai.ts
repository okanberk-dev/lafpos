import { useQuery } from '@tanstack/react-query';
import type { MyTimeDTO } from '@shared/types';
import { get } from './api';
import { REMOTE } from './remote';

/** Mesai süresi: "45 dk", "7 sa 03 dk" (saatli süre dakikayı iki haneyle yazar, alt alta hizalı okunur) */
export function fmtDuration(ms: number): string {
  const min = Math.max(0, Math.floor(ms / 60_000));
  if (min < 60) return `${min} dk`;
  return `${Math.floor(min / 60)} sa ${String(min % 60).padStart(2, '0')} dk`;
}

/**
 * Kişinin kendi mesaisi (kullanıcı menüsü, avatardaki "mesaide" noktası). Canlı olayla (`time`) ve dakikada bir
 * yenilenir; uzaktan görünümde mesai yok (kafedeki kasa bilgisayarının işi).
 */
export function useMyTime(enabled = true) {
  return useQuery({ queryKey: ['time', 'me'], queryFn: () => get<MyTimeDTO>('/time/me'), refetchInterval: 60_000, enabled: enabled && !REMOTE });
}
