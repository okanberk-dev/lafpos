import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LiveEvent } from '@shared/events';
import type { OrderDTO } from '@shared/types';
import { type ClaimedStoreCopy, type StoreCopyApi, storeCopyQueue } from '../src/lib/store-copies';
import { type Harness, startApp } from './harness';

/**
 * Cihaz ödemesinin işyeri nüshası sunucuda bekler (docs/04-YAZARKASA.md §4.1, server/okc/store-copy.ts): kasa ekranı
 * ödeme anında kapalıysa ya da canlı bağlantı (SSE) kopuksa nüsha kaybolmaz; ekran açılınca ya da bağlantı yeniden
 * kurulunca bekleyenleri sorar ve her birini tam bir kez basar. Aynı nüshayı iki sekme ya da iki cihaz isterse yalnız
 * biri alır (sunucuda atomik alma)
 */

type Receipt = { id: string; status: string; amount: number; receiptNo: number | null; zNo: number | null; paymentIds?: string[] };
type Sent = { receipt: Receipt; order: OrderDTO };

let h: Harness;
// Kurulum (göçler, kurulum verisi, beş oturum) yoğun makinede 10 sn'yi aşabiliyor
beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  await h.ok('patron', 'PUT', '/okc/settings', { provider: 'simulator', mode: 'anlik' });
}, 60_000);
afterAll(() => h.cleanup());

const db = async () => {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  return { db, schema, eq };
};

const newOrder = async (qty = 2) => {
  const product = h.boot.products.find((p) => p.name === 'Türk Kahvesi')!;
  const o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
  return h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product.id, qty }] });
};

/** Kasa ekranından (nüsha basan ekran) sepeti gönderir ve eğitim cihazında öder; SSE dinleyen yok: olay kaçar */
const paidOnDevice = async (o: OrderDTO, opts: { storeCopy?: boolean; items?: { itemId: string; qty: number }[] | null; type?: number } = {}) => {
  const sent = await h.ok<Sent>('kasa', 'POST', `/okc/orders/${o.id}/send`, { items: opts.items ?? null, storeCopy: opts.storeCopy ?? true });
  const done = await h.ok<Receipt>('kasa', 'POST', `/okc/simulator/baskets/${sent.receipt.id}/pay`, { payments: [{ type: opts.type ?? 3, amount: sent.receipt.amount }] });
  expect(done.status).toBe('tamamlandi');
  return done;
};

const pending = (who = 'kasa') => h.ok<{ id: string; orderId: string }[]>(who, 'GET', '/okc/store-copies');

/** Ekranın uçları (src/lib/after-payment.tsx › storeCopyApi ile aynı kural): 409 copy_taken "başkası aldı" demektir */
const apiFor = (who: string, calls: string[] = []): StoreCopyApi => ({
  pending: () => pending(who),
  claim: async (id) => {
    calls.push(`claim:${id}`);
    const r = await h.call<ClaimedStoreCopy & { code?: string }>(who, 'POST', `/okc/store-copies/${id}/claim`, {});
    if (r.status === 409 && r.json.code === 'copy_taken') return null;
    if (r.status !== 200) throw new Error(`claim ${r.status}`);
    return r.json;
  },
  printed: async (id, claim) => {
    calls.push(`printed:${id}`);
    const r = await h.call<{ code?: string }>(who, 'POST', `/okc/store-copies/${id}/printed`, { claim });
    if (r.status === 409 && r.json.code === 'copy_taken') return;
    if (r.status !== 200) throw new Error(`printed ${r.status}`);
  },
});

/** Kasa ekranı: bastıklarını sayar (yazıcı) */
const screen = (who = 'kasa') => {
  const printed: ClaimedStoreCopy[] = [];
  const calls: string[] = [];
  const queue = storeCopyQueue(apiFor(who, calls), async (copies) => {
    printed.push(...copies);
  });
  return { queue, printed, calls };
};

const audits = async (receiptId: string) => {
  const { db: d, schema, eq } = await db();
  return d.select().from(schema.auditLog).where(eq(schema.auditLog.entityId, receiptId)).all();
};

describe('işyeri nüshası sunucuda bekler', () => {
  it('okc.paid olayı fişin kimliğini taşır', async () => {
    const { bus } = await import('../server/lib/events');
    const events: LiveEvent[] = [];
    const on = (e: LiveEvent) => events.push(e);
    bus.on('event', on);
    const o = await newOrder();
    const r = await paidOnDevice(o);
    bus.off('event', on);
    expect(events.find((e) => e.kind === 'okc.paid' && e.orderId === o.id)?.receiptId).toBe(r.id);
    // Bu testin nüshası sonraki testlere kalmasın
    await screen().queue.sync();
  });

  it('SSE kopukken ödenen nüsha ekran açılınca tam bir kez basılır; yenilenen ekran ikinci kez basmaz', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    expect((await pending()).map((p) => p.id)).toEqual([r.id]);

    const first = screen();
    await first.queue.sync();
    expect(first.printed).toHaveLength(1);
    const copy = first.printed[0]!;
    expect(copy.receiptId).toBe(r.id);
    expect(copy.order.no).toBe(o.no);
    expect(copy.device.receiptNo).toBe(r.receiptNo);
    expect(copy.payments.map((p) => p.amount)).toEqual([o.total]);
    expect(copy.at).toBeGreaterThan(0);

    // Aynı ekran yeniden sorar, sayfa yenilenir (yeni sıra), bağlantı yeniden kurulur: basılan nüsha bir daha gelmez
    await first.queue.sync();
    const reloaded = screen();
    await reloaded.queue.sync();
    await reloaded.queue.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: r.id });
    expect(first.printed).toHaveLength(1);
    expect(reloaded.printed).toHaveLength(0);
    expect(await pending()).toEqual([]);

    // Denetim kaydı: basıldı (kasiyerin adıyla)
    const log = await audits(r.id);
    expect(log.map((a) => a.action)).toEqual(['okc.store_copy']);
    expect(log[0]!.message).toContain(`#${o.no} adisyonun işyeri nüshası`);
    expect(log[0]!.message).toContain('basıldı');
  });

  it('canlı olaydaki fiş doğrudan alınır (liste sorulmaz), basılır ve basıldı denir', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    const s = screen();
    await s.queue.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: r.id });
    expect(s.printed.map((c) => c.receiptId)).toEqual([r.id]);
    expect(s.calls).toEqual([`claim:${r.id}`, `printed:${r.id}`]);
    // Aynı olay ikinci kez gelirse sunucuya bile gidilmez
    await s.queue.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: r.id });
    expect(s.calls).toHaveLength(2);
    expect(s.printed).toHaveLength(1);
  });

  it('iki istemci aynı anda sorunca yalnız biri alır (iki sekme, iki cihaz)', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    const [a, b] = await Promise.all([
      h.call<{ code?: string }>('kasa', 'POST', `/okc/store-copies/${r.id}/claim`, {}),
      h.call<{ code?: string }>('mudur', 'POST', `/okc/store-copies/${r.id}/claim`, {}),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((a.status === 409 ? a : b).json.code).toBe('copy_taken');
    // Alınan nüsha başkasına görünmez; alan basıp onaylar
    expect(await pending()).toEqual([]);
    const winner = (a.status === 200 ? a : b).json as unknown as ClaimedStoreCopy;
    await h.ok(a.status === 200 ? 'kasa' : 'mudur', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: winner.claim });

    // Ekranlar bir arada: sekme, ikinci sekme ve öteki cihaz aynı anda açılıp sorar
    const o2 = await newOrder();
    const r2 = await paidOnDevice(o2);
    const screens = [screen('kasa'), screen('kasa'), screen('mudur')];
    await Promise.all(screens.map((s) => s.queue.sync()));
    expect(screens.flatMap((s) => s.printed.map((c) => c.receiptId))).toEqual([r2.id]);
  });

  it('basıldıktan sonra listede yok; yeniden alınamaz, onayın tekrarı kaydı tekrarlamaz', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    const claimed = await h.ok<ClaimedStoreCopy>('kasa', 'POST', `/okc/store-copies/${r.id}/claim`, {});
    expect(await pending()).toEqual([]);
    await h.ok('kasa', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: claimed.claim });
    await h.ok('kasa', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: claimed.claim });
    expect(await pending()).toEqual([]);
    const again = await h.call<{ code: string }>('kasa', 'POST', `/okc/store-copies/${r.id}/claim`, {});
    expect(again.status).toBe(409);
    expect(again.json.code).toBe('copy_taken');
    // Başka anahtarla "basıldı" denmez
    expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: 'baskasi' })).json.code).toBe('copy_taken');
    expect((await audits(r.id)).filter((a) => a.action === 'okc.store_copy')).toHaveLength(1);
  });

  it('eski olay (receiptId’siz) sorun çıkarmaz: bekleyenler sorulur, basılan bir daha basılmaz', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    const s = screen();
    const old: Pick<LiveEvent, 'topic' | 'kind' | 'orderId'> = { topic: 'okc', kind: 'okc.paid', orderId: o.id };
    await s.queue.onEvent(old);
    expect(s.printed.map((c) => c.receiptId)).toEqual([r.id]);
    await s.queue.onEvent(old);
    await s.queue.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: '' });
    expect(s.printed).toHaveLength(1);
    // Başka olaylar nüshaya dokunmaz
    expect(s.queue.onEvent({ topic: 'okc', kind: 'okc.sent' })).toBeNull();
    expect(s.queue.onEvent({ topic: 'orders', kind: 'okc.paid' })).toBeNull();
  });

  it('kalem kalem iki cihaz ödemesi: her fişin nüshası kendi ödemesiyle, birer kez', async () => {
    const o = await newOrder(2);
    const item = o.items[0]!;
    const first = await paidOnDevice(o, { items: [{ itemId: item.id, qty: 1 }], type: 1 });
    const second = await paidOnDevice(o, { items: [{ itemId: item.id, qty: 1 }], type: 3 });
    const s = screen();
    await s.queue.sync();
    expect(s.printed.map((c) => c.receiptId)).toEqual([first.id, second.id]);
    expect(s.printed.map((c) => c.payments.map((p) => p.amount))).toEqual([[first.amount], [second.amount]]);
    expect(s.printed.map((c) => c.payments.map((p) => p.methodName))).toEqual([['Nakit'], [expect.stringMatching(/kart/i)]]);
  });

  it('kör kasa: kasiyer kapanan adisyonun dökümünü görmez ama nüsha bu fişin ödemesini yazar', async () => {
    const o = await newOrder();
    const r = await paidOnDevice(o);
    const copy = await h.ok<ClaimedStoreCopy>('kasa', 'POST', `/okc/store-copies/${r.id}/claim`, {});
    expect(copy.order.status).toBe('kapali');
    expect(copy.order.payments).toEqual([]);
    expect(copy.payments.map((p) => p.amount)).toEqual([o.total]);
    await h.ok('kasa', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: copy.claim });
  });

  it('alınıp basıldı denmeyen nüsha süresi dolunca yeniden verilir; eski anahtar artık geçmez', async () => {
    const { STORE_COPY_LEASE_MS } = await import('../server/okc/store-copy');
    const o = await newOrder();
    const r = await paidOnDevice(o);
    // Ekran nüshayı aldı ve basarken kapandı
    const lost = await h.ok<ClaimedStoreCopy>('kasa', 'POST', `/okc/store-copies/${r.id}/claim`, {});
    expect(await pending()).toEqual([]);
    const { db: d, schema, eq } = await db();
    d.update(schema.fiscalReceipts)
      .set({ storeCopyAt: Date.now() - STORE_COPY_LEASE_MS - 1000 })
      .where(eq(schema.fiscalReceipts.id, r.id))
      .run();
    expect((await pending()).map((p) => p.id)).toEqual([r.id]);
    const s = screen();
    await s.queue.sync();
    expect(s.printed.map((c) => c.receiptId)).toEqual([r.id]);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: lost.claim })).json.code).toBe('copy_taken');
    const log = await audits(r.id);
    expect(log.map((a) => a.message).join('\n')).toMatch(/yeniden basılıyor/);
  });

  it('istenmeyen nüsha beklemez: telefondan (nüsha basmayan ekrandan) giden sepet, fişi iptal edilen ödeme', async () => {
    const phone = await paidOnDevice(await newOrder(), { storeCopy: false });
    const voided = await paidOnDevice(await newOrder());
    await h.ok('mudur', 'POST', `/okc/simulator/baskets/${voided.id}/cancel`, { voidReceipt: true });
    const ids = (await pending()).map((p) => p.id);
    expect(ids).not.toContain(phone.id);
    expect(ids).not.toContain(voided.id);
    expect((await h.call<{ code: string }>('kasa', 'POST', `/okc/store-copies/${phone.id}/claim`, {})).json.code).toBe('copy_taken');
  });

  it('ayar kapalıysa ya da ödeme kapanmış güne aitse nüsha verilmez', async () => {
    const r = await paidOnDevice(await newOrder());
    await h.ok('patron', 'PUT', '/admin/settings', { receiptStoreCopy: false });
    expect(await pending()).toEqual([]);
    await h.ok('patron', 'PUT', '/admin/settings', { receiptStoreCopy: true });
    expect((await pending()).map((p) => p.id)).toEqual([r.id]);
    // Ödeme açık günden önceye düştü (gün kapanıp yenisi açıldı): eski günün nüshası basılmaz
    const { db: d, schema, eq } = await db();
    d.update(schema.fiscalReceipts).set({ completedAt: 1 }).where(eq(schema.fiscalReceipts.id, r.id)).run();
    expect(await pending()).toEqual([]);
  });

  it('yetki sunucuda: ödeme alamayan kişi nüshayı göremez, alamaz', async () => {
    const r = await paidOnDevice(await newOrder());
    expect((await h.call('garson', 'GET', '/okc/store-copies')).status).toBe(403);
    expect((await h.call('garson', 'POST', `/okc/store-copies/${r.id}/claim`, {})).status).toBe(403);
    expect((await h.call('garson', 'POST', `/okc/store-copies/${r.id}/printed`, { claim: 'x' })).status).toBe(403);
    await screen().queue.sync();
  });
});

describe('ekranın nüsha sırası (sunucu sahtesiyle)', () => {
  /** Bekleyenler ve atomik alma; `grant` süresi dolan nüshayı yeniden verir */
  const fakeServer = () => {
    const waiting: string[] = [];
    const calls: string[] = [];
    let failConfirm = 0;
    const api: StoreCopyApi = {
      pending: async () => {
        calls.push('pending');
        return waiting.map((id) => ({ id }));
      },
      claim: async (id) => {
        calls.push(`claim:${id}`);
        const i = waiting.indexOf(id);
        if (i < 0) return null;
        waiting.splice(i, 1);
        return { receiptId: id, claim: `k-${id}` } as ClaimedStoreCopy;
      },
      printed: async (id) => {
        calls.push(`printed:${id}`);
        if (failConfirm > 0) {
          failConfirm -= 1;
          throw new Error('ağ');
        }
      },
    };
    return { api, calls, grant: (id: string) => waiting.push(id), failConfirmOnce: () => (failConfirm = 1) };
  };

  it('yazdırılamayan nüshanın onayı gitmez; sunucu yeniden verince basılır', async () => {
    const srv = fakeServer();
    let broken = true;
    const printed: string[] = [];
    const q = storeCopyQueue(srv.api, async (copies) => {
      if (broken) throw new Error('yazıcı');
      printed.push(...copies.map((c) => c.receiptId));
    });
    srv.grant('a');
    await q.sync();
    expect(srv.calls).not.toContain('printed:a');
    broken = false;
    srv.grant('a');
    await q.sync();
    expect(printed).toEqual(['a']);
    expect(srv.calls.filter((c) => c === 'printed:a')).toHaveLength(1);
  });

  it('onayı ulaşmayan nüsha yeniden basılmaz, onay sonraki turda yeniden gider', async () => {
    const srv = fakeServer();
    const printed: string[] = [];
    const q = storeCopyQueue(srv.api, async (copies) => {
      printed.push(...copies.map((c) => c.receiptId));
    });
    srv.failConfirmOnce();
    srv.grant('a');
    await q.sync();
    // Sunucu süresi dolunca aynı nüshayı yeniden verse de bu sekme basmaz (zaten bastı), onayı yeniden gönderir
    srv.grant('a');
    await q.sync();
    expect(printed).toEqual(['a']);
    expect(srv.calls.filter((c) => c === 'printed:a')).toHaveLength(2);
    expect(srv.calls.filter((c) => c === 'claim:a')).toHaveLength(1);
  });

  it('görünmeyen sekme nüsha almaz (yazdıramaz); görünür olunca alır ve basar', async () => {
    const srv = fakeServer();
    let visible = false;
    const printed: string[] = [];
    const q = storeCopyQueue(
      srv.api,
      async (copies) => {
        printed.push(...copies.map((c) => c.receiptId));
      },
      { ready: () => visible },
    );
    srv.grant('a');
    await q.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: 'a' });
    await q.sync();
    expect(srv.calls.filter((c) => c.startsWith('claim'))).toEqual([]);
    expect(printed).toEqual([]);
    visible = true;
    await q.sync();
    expect(printed).toEqual(['a']);
  });

  it('işler sırayla: yazdırmalar üst üste binmez, art arda sorgular birleşir', async () => {
    const srv = fakeServer();
    let busy = false;
    let overlap = false;
    const printed: string[][] = [];
    const q = storeCopyQueue(srv.api, async (copies) => {
      if (busy) overlap = true;
      busy = true;
      await new Promise((ok) => setTimeout(ok, 5));
      printed.push(copies.map((c) => c.receiptId));
      busy = false;
    });
    srv.grant('a');
    srv.grant('b');
    // Açılış, bağlantının kurulması ve iki olay aynı anda
    await Promise.all([q.sync(), q.sync(), q.sync(), q.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: 'b' }), q.onEvent({ topic: 'okc', kind: 'okc.paid', receiptId: 'c' })]);
    expect(overlap).toBe(false);
    // Bekleyen iki nüsha tek yazdırmada (aralarında kâğıt kesilir); b ikinci kez basılmaz, c'yi başka ekran almıştı
    expect(printed).toEqual([['a', 'b']]);
    expect(srv.calls.filter((c) => c === 'pending')).toHaveLength(1);
  });
});
