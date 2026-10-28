import { create } from 'zustand';
import type { Permission } from '@shared/permissions';
import { ApiError } from './api';
import { onSessionEnd } from './sessionEnd';

/**
 * Yetkili onayının durumu (pencere approval.tsx'te): sunucu 403 `approval_required` dönünce PIN sorulur, istek
 * `approverPin` ile tekrarlanır. Yanlış PIN'de pencere açık kalır; ileti kırmızı uyarı olur ve PIN alanı boşalır
 * (`attempt` her soruda artar).
 */
export interface ApprovalPending {
  message: string;
  permission: Permission | null;
  resolve: (pin: string | null) => void;
  /** Önceki denemenin hatası (yanlış PIN, yetkisiz kişi, çok deneme); ilk soruda null */
  error: string | null;
  /** Bu pencerede kaçıncı soru: PIN alanı her yeni soruda boşalır (aynı hata iki kez gelse de) */
  attempt: number;
}

export const useApproval = create<{ pending: ApprovalPending | null; close: () => void }>((set) => ({
  pending: null,
  close: () => set({ pending: null }),
}));

function askPin(message: string, permission: Permission | null, error: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const prev = useApproval.getState().pending;
    useApproval.setState({ pending: { message, permission, resolve, error, attempt: (prev?.attempt ?? 0) + 1 } });
  });
}

/** `fn` yetki isterse PIN sorup yeniden dener. Kullanıcı vazgeçerse (ya da oturum kapanırsa) null döner. */
export async function withApproval<T>(fn: (approverPin?: string) => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'approval_required') throw e;
    const permission = (e.data.permission as Permission) ?? null;
    const message = e.message;
    let error: string | null = null;
    for (;;) {
      const pin = await askPin(message, permission, error);
      if (!pin) return null;
      try {
        const result = await fn(pin);
        useApproval.getState().close();
        return result;
      } catch (err) {
        if (err instanceof ApiError && ['approval_invalid', 'approval_forbidden', 'rate_limited'].includes(err.code ?? '')) {
          error = err.message;
          continue;
        }
        useApproval.getState().close();
        throw err;
      }
    }
  }
}

/** Bekleyen PIN sorusundan vazgeçilir (oturum kapandı) */
export function cancelApproval() {
  const p = useApproval.getState().pending;
  if (!p) return;
  useApproval.setState({ pending: null });
  p.resolve(null);
}

onSessionEnd(cancelApproval);
