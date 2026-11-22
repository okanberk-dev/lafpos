import type { LiveEvent } from '@shared/events';
import type { OrderDTO } from '@shared/types';

/**
 * Cihaz ödemesinin işyeri nüshası kasa ekranında (docs/04-YAZARKASA.md §4.1; sunucu `server/okc/store-copy.ts`).
 * Basılmamış nüshayı sunucu bilir; ekran nüshayı sunucudan alır (atomik: iki sekme ya da iki cihazdan yalnız biri),
 * basar ve "basıldı" der. Ne zaman sorar:
 *
 * - `okc.paid` olayında: olaydaki fiş (`receiptId`) doğrudan alınır. Fiş kimliği taşımayan eski olayda bekleyenler sorulur.
 * - Açılışta ve canlı bağlantı yeniden kurulunca (`sync`): olay kaçtıysa (ekran kapalı, yenileniyor, kilitli, bağlantı
 *   kopuk) nüsha o zaman basılır.
 *
 * İşler sırayla yürür (aynı sekmede iki alma ya da iki yazdırma üst üste binmez). Basılamayan nüshanın onayı gitmez:
 * sunucu onu süresi dolunca yeniden verir. Onayı ulaşmayan nüsha bu sekmede yeniden basılmaz, onay yeniden gider.
 * `ready` yanlışken (sekme görünmüyor: tarayıcı arka plandaki sekmede yazdırmayı bekletir) nüsha alınmaz; görünür bir
 * sekme alır, yoksa nüsha sunucuda bekler ve sekme görünür olunca sorulur.
 */

/** Sunucunun bu ekrana verdiği nüsha (`POST /okc/store-copies/:id/claim`) */
export interface ClaimedStoreCopy {
  receiptId: string;
  /** Alışın anahtarı: "basıldı" onayıyla geri gider */
  claim: string;
  order: OrderDTO;
  /** Bu fişin ödemeleri */
  payments: { id: string; methodName: string; amount: number; tip: number; userName: string | null }[];
  device: { receiptNo: number | null; zNo: number | null; docKind: string | null; docId: string | null };
  /** Ödemenin anı */
  at: number;
}

export interface StoreCopyApi {
  /** Basılmayı bekleyen nüshalar */
  pending: () => Promise<{ id: string }[]>;
  /** Nüshayı bu ekrana al; başka ekran aldıysa ya da artık basılmayacaksa null */
  claim: (receiptId: string) => Promise<ClaimedStoreCopy | null>;
  /** "Basıldı" onayı; nüsha başka ekrana verildiyse de sessizce biter. Hata atarsa (ağ) onay sonra yeniden denenir */
  printed: (receiptId: string, claim: string) => Promise<void>;
}

export function storeCopyQueue(api: StoreCopyApi, print: (copies: ClaimedStoreCopy[]) => Promise<void>, opts: { ready?: () => boolean } = {}) {
  const ready = opts.ready ?? (() => true);
  /** Bu sekmede basılan nüshalar: ikinci kez alınmaz */
  const done = new Set<string>();
  /** Basıldı ama onayı sunucuya ulaşmadı: anahtarıyla yeniden denenir */
  const unconfirmed = new Map<string, string>();
  let chain: Promise<void> = Promise.resolve();
  let syncQueued = false;

  const confirm = async (id: string, claim: string) => {
    try {
      await api.printed(id, claim);
      unconfirmed.delete(id);
    } catch {
      // Sonraki turda yeniden denenir
    }
  };

  const take = async (ids: string[]) => {
    for (const [id, claim] of [...unconfirmed]) await confirm(id, claim);
    const got: ClaimedStoreCopy[] = [];
    for (const id of new Set(ids)) {
      // Yazdıramayan (görünmeyen) sekme nüsha almaz: alırsa nüsha süresi dolana dek kimseye verilmezdi
      if (!ready()) break;
      if (done.has(id)) continue;
      const copy = await api.claim(id).catch(() => null);
      if (copy) got.push(copy);
    }
    if (!got.length) return;
    try {
      await print(got);
    } catch {
      // Yazdırılamadı: onay gitmez, sunucu nüshayı süresi dolunca yeniden verir
      return;
    }
    for (const c of got) {
      done.add(c.receiptId);
      unconfirmed.set(c.receiptId, c.claim);
    }
    for (const c of got) await confirm(c.receiptId, c.claim);
  };

  const run = (job: () => Promise<void>): Promise<void> => {
    chain = chain.then(job).catch(() => undefined);
    return chain;
  };

  /** Bekleyen nüshaları sorar, alabildiklerini basar. Sırada bekleyen bir sorgu varsa ikincisi eklenmez */
  const sync = (): Promise<void> => {
    if (syncQueued) return chain;
    syncQueued = true;
    return run(async () => {
      syncQueued = false;
      await take((await api.pending()).map((p) => p.id));
    });
  };

  return {
    sync,
    /** Canlı olay: yalnız `okc.paid`; fiş kimliği varsa o nüsha, yoksa (eski sürümün olayı) bekleyenler */
    onEvent(e: Pick<LiveEvent, 'topic' | 'kind' | 'receiptId'>): Promise<void> | null {
      if (e.topic !== 'okc' || e.kind !== 'okc.paid') return null;
      const id = typeof e.receiptId === 'string' && e.receiptId ? e.receiptId : null;
      return id ? run(() => take([id])) : sync();
    },
  };
}
