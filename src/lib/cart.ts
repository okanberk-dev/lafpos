import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import type { Size } from '@shared/types';

/**
 * Henüz bara/mutfağa gönderilmemiş kalemler. Adisyon başına cihazda tutulur; tablet yenilense de kaybolmaz.
 * "Gönder" ile sunucuya tek istekte gider.
 */
export interface PendingLine {
  key: string;
  productId: string;
  size: Size;
  qty: number;
  options: { itemId: string; qty?: number }[];
  note: string;
  /** Elle girilen birim fiyat (kuruş); sunucu siparis.fiyat ister, yoksa yetkili PIN'i sorar */
  priceOverride?: number | null;
}

interface CartState {
  byOrder: Record<string, PendingLine[]>;
  add: (orderId: string, line: Omit<PendingLine, 'key'>) => void;
  update: (orderId: string, key: string, patch: Partial<PendingLine>) => void;
  remove: (orderId: string, key: string) => void;
  clear: (orderId: string) => void;
  /** Gönderilen satırları sepetten düşer (anahtar → gönderilen adet); istek sürerken eklenen ya da geri konan kalır */
  consume: (orderId: string, sent: ReadonlyMap<string, number>) => void;
}

const sameLine = (a: Omit<PendingLine, 'key'>, b: Omit<PendingLine, 'key'>) =>
  a.productId === b.productId &&
  a.size === b.size &&
  a.note === b.note &&
  (a.priceOverride ?? null) === (b.priceOverride ?? null) &&
  JSON.stringify([...a.options].sort((x, y) => x.itemId.localeCompare(y.itemId))) === JSON.stringify([...b.options].sort((x, y) => x.itemId.localeCompare(y.itemId)));

const safeStorage = createJSONStorage(() => {
  try {
    localStorage.setItem('lafpos.probe', '1');
    localStorage.removeItem('lafpos.probe');
    return localStorage;
  } catch {
    const mem = new Map<string, string>();
    return { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => void mem.set(k, v), removeItem: (k) => void mem.delete(k) };
  }
});

export const useCart = create<CartState>()(
  persist(
    (set) => ({
      byOrder: {},
      add: (orderId, line) =>
        set((s) => {
          const lines = s.byOrder[orderId] ?? [];
          const idx = lines.findIndex((l) => sameLine(l, line));
          const next = idx >= 0 ? lines.map((l, i) => (i === idx ? { ...l, qty: Math.min(99, l.qty + line.qty) } : l)) : [...lines, { ...line, key: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}` }];
          return { byOrder: { ...s.byOrder, [orderId]: next } };
        }),
      update: (orderId, key, patch) =>
        set((s) => ({ byOrder: { ...s.byOrder, [orderId]: (s.byOrder[orderId] ?? []).map((l) => (l.key === key ? { ...l, ...patch } : l)) } })),
      remove: (orderId, key) => set((s) => ({ byOrder: { ...s.byOrder, [orderId]: (s.byOrder[orderId] ?? []).filter((l) => l.key !== key) } })),
      clear: (orderId) =>
        set((s) => {
          const next = { ...s.byOrder };
          delete next[orderId];
          return { byOrder: next };
        }),
      consume: (orderId, sent) =>
        set((s) => {
          const lines = consumeLines(s.byOrder[orderId] ?? [], sent);
          const next = { ...s.byOrder };
          if (lines.length) next[orderId] = lines;
          else delete next[orderId];
          return { byOrder: next };
        }),
    }),
    { name: 'lafpos.cart', storage: safeStorage },
  ),
);

/**
 * Silinen gönderilmemiş satırları geri koyar ("Geri al"): sepette anahtarı zaten bulunan satır yeniden eklenmez (geri
 * alma iki kez çalışsa da kalemler çoğalmaz, aynı anahtarlı iki satır olmaz)
 */
export function restoreLines(current: PendingLine[], saved: PendingLine[]): PendingLine[] {
  const keys = new Set(current.map((l) => l.key));
  const missing = saved.filter((l) => !keys.has(l.key));
  return missing.length ? [...current, ...missing] : current;
}

/**
 * Gönderimden sonra sepette kalan satırlar: gönderilen her anahtardan gönderilen adet düşülür, adedi biten satır
 * kalkar. Gönderim sürerken eklenen satır (başka anahtar) ya da aynı ürüne dokunulunca artan adet beklemede kalır;
 * "Geri al" ile geri konan satır da öyle. Sepeti toptan silmek (clear) bunları bara hiç gitmeden kaybettirirdi.
 */
export function consumeLines(current: PendingLine[], sent: ReadonlyMap<string, number>): PendingLine[] {
  const out: PendingLine[] = [];
  for (const l of current) {
    const q = sent.get(l.key);
    if (q === undefined) out.push(l);
    else if (l.qty > q) out.push({ ...l, qty: l.qty - q });
  }
  return out;
}

export function usePending(orderId: string): PendingLine[] {
  return useCart((s) => s.byOrder[orderId]) ?? EMPTY;
}
const EMPTY: PendingLine[] = [];
