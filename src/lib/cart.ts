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

/**
 * Kasaya ulaşamayan gönderim (sunucu yeniden başlıyor, Wi-Fi koptu): kimliği ve satırlarıyla tablette bekler; bağlantı
 * gelince aynı kimlikle yeniden gönderilir. Sunucu aynı kimliği bir kez yazar: ilk deneme aslında ulaşıp yanıtı
 * kaybolduysa kalemler iki kez yazılmaz
 */
export interface SendBatch {
  id: string;
  lines: PendingLine[];
  hold: boolean;
  at: number;
}

interface CartState {
  byOrder: Record<string, PendingLine[]>;
  batches: Record<string, SendBatch>;
  setBatch: (orderId: string, batch: SendBatch | null) => void;
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
      batches: {},
      setBatch: (orderId, batch) =>
        set((s) => {
          const next = { ...s.batches };
          if (batch) next[orderId] = batch;
          else delete next[orderId];
          return { batches: next };
        }),
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

export function useBatch(orderId: string): SendBatch | undefined {
  return useCart((s) => s.batches?.[orderId]);
}

/** Gönderimin tek seferlik kimliği (sunucu aynı kimliği bir kez yazar) */
export function newBatchId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Kasaya hiç ulaşılamadı mı (yanıt yok ya da sunucu yeniden başlıyor): gönderim kuyrukta bekler */
export function unreachable(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status;
  return status === 0 || status === 502 || status === 503 || status === 504;
}

/**
 * Kasaya ulaşamayan yeni gönderim kuyruğa girer: satırlar sepetten gönderim kaydına geçer (bekleyen gönderim donmuş bir
 * kopya değil, tek yer). Kuyruktayken sepette silinen ya da azaltılan satır artık gönderimi değiştirmez ve "silindi"
 * sanılıp kasa dönünce bara gitmez; garson yalnız "N ürün bekliyor"u görür (denetim bulgu 20/28)
 */
export function queueBatch(orderId: string, batch: SendBatch) {
  const st = useCart.getState();
  st.setBatch(orderId, batch);
  st.consume(orderId, new Map(batch.lines.map((l) => [l.key, l.qty])));
}

/** Kuyruktaki gönderim kasaya yazıldı: kayıt düşer (yalnız aynı gönderimse) */
export function dropBatch(orderId: string, batchId: string) {
  if (useCart.getState().batches?.[orderId]?.id === batchId) useCart.getState().setBatch(orderId, null);
}

/** Kasa kuyruktaki gönderimi reddetti (ör. ürün tükendi): kayıt düşer, satırlar sepete geri konur; düzeltip yeniden gönderilir */
export function returnBatch(orderId: string, batch: SendBatch) {
  dropBatch(orderId, batch.id);
  useCart.setState((st) => {
    const current = st.byOrder[orderId] ?? [];
    const keys = new Map(current.map((l) => [l.key, l]));
    const merged = current.map((l) => {
      const back = batch.lines.find((b) => b.key === l.key);
      return back ? { ...l, qty: Math.min(99, l.qty + back.qty) } : l;
    });
    return { byOrder: { ...st.byOrder, [orderId]: [...merged, ...batch.lines.filter((b) => !keys.has(b.key))] } };
  });
}

/** Aynı adisyonun gönderimi aynı anda iki yerden (arka plan döngüsü ve "Gönder") gitmez */
const inFlight = new Set<string>();
export const claimSend = (orderId: string) => (inFlight.has(orderId) ? false : (inFlight.add(orderId), true));
export const releaseSend = (orderId: string) => void inFlight.delete(orderId);

/**
 * Kuyruktaki bir gönderimi dener (uygulama düzeyindeki döngü, src/lib/outbox.ts): `send` isteği yapar. Ulaşıldıysa
 * kayıt düşer; kasa reddettiyse satırlar sepete döner; yine ulaşılamadıysa bekler. Başka yer gönderiyorsa 'busy'
 */
export async function flushBatch(orderId: string, batch: SendBatch, send: () => Promise<unknown>): Promise<'sent' | 'queued' | 'rejected' | 'busy'> {
  if (!claimSend(orderId)) return 'busy';
  try {
    await send();
    dropBatch(orderId, batch.id);
    return 'sent';
  } catch (e) {
    if (unreachable(e)) return 'queued';
    returnBatch(orderId, batch);
    return 'rejected';
  } finally {
    releaseSend(orderId);
  }
}
