import { useQuery } from '@tanstack/react-query';
import { get } from './api';

/** Oturumsuz ekranlar (çağrı, müşteri ekranı) için işletme adı: giriş ekranının herkese açık ucu */
export function useBusinessName(): string {
  const q = useQuery({ queryKey: ['login-info'], queryFn: () => get<{ businessName?: string }>('/auth/users'), staleTime: 10 * 60_000, retry: 2 });
  return q.data?.businessName ?? "L'Affogato";
}
