import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CLOSING_REMINDER_MS, closingAtMs } from '@shared/time';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';
import { REDIS_ONEKI } from '@shared/eski-adlar';

/**
 * Patrona telefon bildirimi: kasa olayı imzalı iter (server/sync/bildirim.ts), site abonelere Web Push atar
 * (api/_bildirim.ts). Eşikler, internetsiz kuyruk, abonelik için gerçek oturum, geçersizleşen aboneliğin silinmesi,
 * Merkez'in güncelleme sorunu bildirimi, kapanış saati hatırlatması (`closingNoticeTick`) ve sitenin kabul etmediği
 * bildirimin (eski sitede yeni tür) kuyruğu tıkamaması.
 */
const CLOUD = 'https://bildirim.test';
const SECRET = 'b'.repeat(40);
const PASSWORD = 'bildirim-parola-1';
const store = new Map<string, string>();
const pushed: { endpoint: string; payload: { title: string; body: string; tag: string }; ttl: number }[] = [];
let offline = false;
/** Eski siteyi taklit eder: bu türü bilmez (400) */
let rejectKind: string | null = null;
let h: Harness;

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  const { env } = await import('../server/env');
  Object.assign(env, { cloudUrl: CLOUD, cloudSecret: SECRET });
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, ASILPOS_UZAKTAN_PAROLA: PASSWORD, ASILPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0', VAPID_PUBLIC_KEY: 'BPub', VAPID_PRIVATE_KEY: 'priv' });
  const { setPushSender } = await import('../api/_bildirim');
  setPushSender(async (sub, payload, ttl) => {
    if (sub.endpoint.endsWith('/gitti')) throw Object.assign(new Error('gone'), { statusCode: 410 });
    pushed.push({ endpoint: sub.endpoint, payload: JSON.parse(payload), ttl });
    return { statusCode: 201 };
  });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
      let result: unknown = null;
      if (cmd === 'GET') result = store.get(key!) ?? null;
      if (cmd === 'MGET') result = [key!, ...rest].map((k) => store.get(k) ?? null);
      if (cmd === 'SCARD') result = 0;
      if (cmd === 'SET') result = rest.includes('NX') && store.has(key!) ? null : (store.set(key!, rest[0]!), 'OK');
      if (cmd === 'INCR') (store.set(key!, String(Number(store.get(key!) ?? 0) + 1)), (result = Number(store.get(key!))));
      if (cmd === 'DEL') (store.delete(key!), (result = 1));
      return new Response(JSON.stringify({ result }));
    }
    if (url.startsWith(CLOUD)) {
      if (offline) throw new TypeError('fetch failed');
      if (rejectKind && (JSON.parse(String(init!.body)) as { kind?: string }).kind === rejectKind) return new Response(JSON.stringify({ code: 'bad_body' }), { status: 400 });
      const { POST } = await import('../api/uzaktan');
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      return POST(new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: 'POST', body: init!.body as string, headers: init!.headers as Record<string, string> }));
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

const flush = () => new Promise((r) => setTimeout(r, 30));
async function cloud(method: 'GET' | 'POST', path: string, body?: unknown, token?: string) {
  const { GET, POST } = await import('../api/uzaktan');
  const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body: body === undefined ? undefined : JSON.stringify(body) });
  return method === 'GET' ? GET(req) : POST(req);
}
async function token() {
  const res = await cloud('POST', 'uzaktan/giris', { parola: PASSWORD });
  return ((await res.json()) as { token: string }).token;
}
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });

describe('telefon bildirimi', () => {
  it('abonelik yalnız gerçek oturumla; açık anahtar herkese', async () => {
    expect(await (await cloud('GET', 'uzaktan/bildirim/anahtar')).json()).toEqual({ ready: true, publicKey: 'BPub' });
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/1') })).status).toBe(401);
    const t = await token();
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: { endpoint: 'http://kotu' } }, t)).status).toBe(400);
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/1') }, t)).status).toBe(200);
    expect((await cloud('POST', 'uzaktan/bildirim/abone', { abonelik: sub('https://push.test/gitti') }, t)).status).toBe(200);
  });

  it('imzasız olay reddedilir', async () => {
    expect((await cloud('POST', 'uzaktan/bildirim', { kind: 'iptal', title: 'x', body: 'y' })).status).toBe(401);
  });

  it('eşik altı iptal gitmez; eşik üstü iptal patrona gider, geçersiz abonelik silinir', async () => {
    const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Latte').id, qty: 1 }, { productId: product('Mocha').id, qty: 30 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items.find((i) => i.name === 'Latte')!.id}/void`, { reason: 'Vazgeçti', approverPin: PINS.mudur });
    await flush();
    expect(pushed).toHaveLength(0);
    await h.ok('kasa', 'POST', `/orders/${o.id}/items/${o.items.find((i) => i.name === 'Mocha')!.id}/void`, { reason: 'Yanlış masa', approverPin: PINS.mudur });
    await flush();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.payload.title).toMatch(/^Büyük iptal: ₺/);
    expect(pushed[0]!.payload.body).toContain(`Adisyon ${o.no}`);
    // Neden bildirime girmez
    expect(JSON.stringify(pushed[0])).not.toContain('Yanlış masa');
    expect(Object.keys(JSON.parse(store.get(`${REDIS_ONEKI}bildirim:aboneler`)!))).toEqual(['https://push.test/1']);
  });

  it('kapalıyken gitmez; internet yokken kuyrukta bekler, dönünce gider', async () => {
    await h.ok('patron', 'PUT', '/sync/bildirim', { enabled: false });
    const { notify, flushNotices, pendingNotices } = await import('../server/sync/bildirim');
    pushed.length = 0;
    await notify({ kind: 'deneme', title: 'kapalı', body: '' });
    expect(pushed).toHaveLength(0);
    await h.ok('patron', 'PUT', '/sync/bildirim', { enabled: true, cashDiffMin: 1000 });
    offline = true;
    await notify({ kind: 'deneme', title: 'bekleyen', body: '' });
    expect(pendingNotices()).toBe(1);
    offline = false;
    expect(await flushNotices()).toBe(1);
    expect(pendingNotices()).toBe(0);
    expect(pushed.map((p) => p.payload.title)).toEqual([expect.stringContaining('bekleyen')]);
  });

  it('gün sonunda kasa farkı eşiği geçince; ayar yetkisi yoksa ayar değişmez', async () => {
    pushed.length = 0;
    expect((await h.call('garson', 'PUT', '/sync/bildirim', { enabled: false })).status).toBe(403);
    // Kalemleri iptal edilen adisyon kapanır; nakit bir satış, kasada ₺20 eksik sayılır (eşik ₺10)
    const open = (await h.ok<OrderDTO[]>('kasa', 'GET', '/orders?status=acik')).filter((o) => o.status === 'acik');
    for (const o of open) await h.ok('kasa', 'POST', `/orders/${o.id}/cancel`, { reason: 'Deneme', approverPin: PINS.mudur });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: h.boot.paymentMethods.find((m) => m.name === 'Nakit')!.id, amount: o.total });
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: o.total - 2000 });
    await flush();
    const kasa = pushed.find((p) => /^Kasa eksik: ₺20/.test(p.payload.title));
    expect(kasa?.payload.body).toMatch(/beklenen .*sayılan/);
  });

  it('Merkez: güncelleme eski sürüme dönünce onaylı dükkânın patronuna bir kez, sabit metinle', async () => {
    pushed.length = 0;
    const { identity, merkezBeat } = await import('../server/sync/merkez');
    const { env } = await import('../server/env');
    Object.assign(env, { merkezUrl: CLOUD });
    const { mkdirSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const dir = join(env.dataDir, 'guncelleme');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'durum.json'), JSON.stringify({ durum: 'guncel', mesaj: 'Güncel' }));
    expect(identity().id).toBeTruthy();
    expect(await merkezBeat()).toBe(true);
    // Onay bekleyen kurulumdan bildirim gitmez: sahip lisansı verir
    const t = await token();
    expect((await cloud('POST', 'merkez/kurulum', { id: identity().id, lisans: 'aktif', ad: 'Marina' }, t)).status).toBe(200);
    writeFileSync(join(dir, 'durum.json'), JSON.stringify({ durum: 'geri-dondu', mesaj: 'Yeni sürüm açılmadı; ayrıntı https://ornek.test' }));
    expect(await merkezBeat()).toBe(true);
    expect(await merkezBeat()).toBe(true);
    const sent = pushed.filter((p) => p.payload.title.startsWith('Güncelleme sorunu'));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({ title: 'Güncelleme sorunu · Marina', body: 'Yeni sürüm kurulamadı; eski sürüm çalışıyor' });
    Object.assign(env, { merkezUrl: '' });
  });

  it('son bildirimler listesi gerçek oturumla okunur', async () => {
    const t = await token();
    const list = (await (await cloud('GET', 'uzaktan/bildirim/son', undefined, t)).json()) as { kind: string }[];
    expect(list.length).toBeGreaterThan(0);
    expect((await cloud('GET', 'uzaktan/bildirim/son')).status).toBe(401);
  });
});

describe('kapanış saati bildirimi', () => {
  /** Gün kasa farkı testinde kapandı: senaryo için gün veritabanında açılır (yeniden açılış anı elle; saat oynatılamaz) */
  async function setDay(patch: { closedAt?: number | null; reopenedAt?: number | null }) {
    const { db, schema } = await import('../server/db/client');
    const { desc, eq } = await import('drizzle-orm');
    const day = db.select().from(schema.businessDays).orderBy(desc(schema.businessDays.openedAt)).get()!;
    db.update(schema.businessDays).set(patch).where(eq(schema.businessDays.id, day.id)).run();
    return { ...day, ...patch };
  }
  const titles = () => pushed.map((p) => p.payload.title);

  it('kapanışa 30 dk kala bir kez; saat girilmemişse, bu tür kapalıyken ve pencereden önce gitmez; kapatmayı yalnız patron yapar', async () => {
    const { closingNoticeTick, notifySettings } = await import('../server/sync/bildirim');
    pushed.length = 0;
    const day = await setDay({ closedAt: null, reopenedAt: null });
    expect(notifySettings().kapanis).toBe(true);
    // Kapanış saati varsayılan boş: anahtar açık olsa da hiçbir şey gitmez
    expect(await closingNoticeTick(Date.now())).toBe(false);
    await h.ok('mudur', 'PUT', '/admin/settings', { closingTime: '23:00' });
    const closeAt = closingAtMs(day.date, '23:00');
    expect(await closingNoticeTick(closeAt - CLOSING_REMINDER_MS - 60_000)).toBe(false);
    // Kapatmak bildirimi azaltır: müdür yapamaz, patron yapar (denetim kaydında)
    expect((await h.call('mudur', 'PUT', '/sync/bildirim', { kapanis: false })).status).toBe(403);
    await h.ok('patron', 'PUT', '/sync/bildirim', { kapanis: false });
    const { db, schema } = await import('../server/db/client');
    const audit = db.select().from(schema.auditLog).all().filter((a) => a.action === 'ayar').at(-1);
    expect(audit?.message).toContain('kapanış saati açık → kapalı');
    expect(await closingNoticeTick(closeAt - 10 * 60_000)).toBe(false);
    // Açmak bildirimi çoğaltır: müdür de yapar
    await h.ok('mudur', 'PUT', '/sync/bildirim', { kapanis: true });
    expect(await closingNoticeTick(closeAt - 10 * 60_000)).toBe(true);
    expect(await closingNoticeTick(closeAt - 9 * 60_000)).toBe(false);
    // Kapanış geçse de aynı gün için ikinci bildirim yok
    expect(await closingNoticeTick(closeAt + 5 * 60_000)).toBe(false);
    expect(titles()).toEqual([expect.stringMatching(/^Kapanışa 10 dk kaldı/)]);
    expect(pushed[0]!.payload).toMatchObject({ body: `Kapanış 23:00 · gün sonu henüz alınmadı (Z ${day.zNo})`, tag: 'kapanis' });
    // Push servisinde bir saatten fazla beklemez (telefon kapalıysa saatler sonra gelmez)
    expect(pushed[0]!.ttl).toBe(3600);
  });

  it('yeniden açılan günde bir kez daha; internet yokken kuyruğa girmez, dönünce o anki durumla gider; kapalı günde gitmez', async () => {
    const { closingNoticeTick, pendingNotices } = await import('../server/sync/bildirim');
    const { noteReachable } = await import('../server/lib/internet');
    pushed.length = 0;
    const day = await setDay({ closedAt: null, reopenedAt: null });
    const closeAt = closingAtMs(day.date, '23:00');
    // Kapanıştan sonra gelen müşteri: gün yeniden açıldı, 30 dakika hatırlatılmaz
    const reopenedAt = closeAt + 60_000;
    await setDay({ reopenedAt });
    expect(await closingNoticeTick(reopenedAt + 60_000)).toBe(false);
    // 30 dakika sonra gün hâlâ açık ama internet yok: gitmez, kuyrukta bekletilmez (bayat "kapanışa N dk" gitmesin)
    offline = true;
    expect(await closingNoticeTick(reopenedAt + CLOSING_REMINDER_MS)).toBe(false);
    expect(pendingNotices()).toBe(0);
    offline = false;
    noteReachable();
    // Gidemeyen bildirim en sık 5 dakikada bir yeniden denenir; sonra o anki durumla ("geçti") bir kez gider
    expect(await closingNoticeTick(reopenedAt + CLOSING_REMINDER_MS + 2 * 60_000)).toBe(false);
    expect(await closingNoticeTick(reopenedAt + CLOSING_REMINDER_MS + 6 * 60_000)).toBe(true);
    expect(await closingNoticeTick(reopenedAt + CLOSING_REMINDER_MS + 7 * 60_000)).toBe(false);
    expect(titles()).toEqual([expect.stringMatching(/^Kapanış saati geçti/)]);
    expect(pushed[0]!.payload.body).toBe(`Kapanış 23:00 · gün hâlâ açık (Z ${day.zNo})`);
    // Gün sonu alındıysa hiçbir şey
    await setDay({ closedAt: closeAt + 3 * 3600_000, reopenedAt: closeAt + 2 * 3600_000 });
    expect(await closingNoticeTick(closeAt + 4 * 3600_000)).toBe(false);
    expect(pushed).toHaveLength(1);
  });

  it('sitenin kabul etmediği bildirim (eski sitede yeni tür, 400) düşer: yeniden denenmez, kuyruğu tıkamaz', async () => {
    const { closingNoticeTick, flushNotices, notify, pendingNotices } = await import('../server/sync/bildirim');
    pushed.length = 0;
    const day = await setDay({ closedAt: null, reopenedAt: null });
    const closeAt = closingAtMs(day.date, '23:00');
    // Yeni yeniden açılış: yeni hatırlatma; eski site "kapanis"i bilmiyor
    await setDay({ reopenedAt: closeAt + 5 * 3600_000 });
    rejectKind = 'kapanis';
    expect(await closingNoticeTick(closeAt + 6 * 3600_000)).toBe(false);
    rejectKind = null;
    expect(await closingNoticeTick(closeAt + 6 * 3600_000 + 60_000)).toBe(false);
    expect(pushed).toHaveLength(0);
    // Kuyrukta 400 alan kayıt arkadakini bekletmez
    offline = true;
    await notify({ kind: 'internet', title: 'eski sitede yok', body: '' });
    await notify({ kind: 'deneme', title: 'arkadaki', body: '' });
    expect(pendingNotices()).toBe(2);
    offline = false;
    rejectKind = 'internet';
    expect(await flushNotices()).toBe(1);
    rejectKind = null;
    expect(pendingNotices()).toBe(0);
    expect(titles()).toEqual([expect.stringContaining('arkadaki')]);
    await h.ok('mudur', 'PUT', '/admin/settings', { closingTime: null });
  });
});
