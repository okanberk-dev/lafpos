import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIRM_MS, GRACE_DAYS, licenseState, normalizeBranchCode, TRIAL_DAYS } from '@shared/lisans';
import type { BootstrapDTO, OrderDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Merkez: kasanın kaydı (ilk görüşte güven), imzalı nabız, lisans süreleri (deneme, uyarı, kapanma; internetsiz kasada
 * satış kapanmaz), şube kodu ve lisansın son günü, panelden lisans, seçerek güncelleme gönderme ve "Şimdi güncelle". Kasa gerçek bulut işleyicisiyle (api/uzaktan.ts) konuşur; Upstash
 * yerine bellekte sahte Redis.
 */
const CLOUD = 'https://merkez.test';
const SECRET = 'm'.repeat(40);
const PASSWORD = 'merkez-parola-123';
const DAY = 86_400_000;
const BUILD = 1_795_000_000;
const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
let release: { v: 1; version: string; build: number; date: string; not?: string } | null = { v: 1, version: '0.3.0', build: BUILD + 500, date: '2026-11-21T10:00:00.000Z', not: 'Merkez ve lisans' };
let cloudDown = false;
let h: Harness;

const api = () => import('../api/uzaktan');

async function redisCmd(cmd: string, key: string, rest: string[]): Promise<unknown> {
  if (cmd === 'GET') return store.get(key) ?? null;
  if (cmd === 'MGET') return [key, ...rest].map((k) => store.get(k) ?? null);
  if (cmd === 'SET') {
    if (rest.includes('NX') && store.has(key)) return null;
    store.set(key, rest[0]!);
    return 'OK';
  }
  if (cmd === 'SADD') {
    const s = sets.get(key) ?? new Set();
    rest.forEach((x) => s.add(x));
    sets.set(key, s);
    return 1;
  }
  if (cmd === 'SMEMBERS') return [...(sets.get(key) ?? [])];
  if (cmd === 'INCR') {
    store.set(key, String(Number(store.get(key) ?? 0) + 1));
    return Number(store.get(key));
  }
  if (cmd === 'DEL') return store.delete(key) ? 1 : 0;
  return 1;
}

beforeAll(async () => {
  h = await startApp();
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, LAFPOS_UZAKTAN_PAROLA_GEREKLI: '1', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0' });
  const { env } = await import('../server/env');
  Object.assign(env, { merkezUrl: CLOUD, cloudSecret: SECRET });
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
      return new Response(JSON.stringify({ result: await redisCmd(cmd!, key!, rest) }), { status: 200 });
    }
    if (url === `${CLOUD}/guncelleme/surum.json`) return release ? Response.json(release) : new Response('yok', { status: 404 });
    if (url.startsWith(`${CLOUD}/api/`)) {
      if (cloudDown) throw new TypeError('fetch failed');
      const { GET, POST } = await api();
      const path = new URL(url).pathname.replace(/^\/api\//, '');
      const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method: init?.method ?? 'GET', headers: init?.headers, body: init?.body as string | undefined });
      return (init?.method ?? 'GET') === 'POST' ? POST(req) : GET(req);
    }
    return realFetch(input, init);
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  h.cleanup();
});

async function adminToken(): Promise<string> {
  const { POST } = await api();
  const res = await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', body: JSON.stringify({ parola: PASSWORD }), headers: { 'x-forwarded-for': '1.1.1.1' } }));
  return ((await res.json()) as { token: string }).token;
}

async function panel<T = any>(method: 'GET' | 'POST', path: string, body?: unknown, token?: string): Promise<{ status: number; json: T }> {
  const { GET, POST } = await api();
  const t = token ?? (await adminToken());
  const req = new Request(`${CLOUD}/api/uzaktan?yol=${path}`, { method, headers: { authorization: `Bearer ${t}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const res = await (method === 'GET' ? GET(req) : POST(req));
  return { status: res.status, json: (await res.json()) as T };
}

describe('lisans kuralı (shared/lisans.ts)', () => {
  const at = Date.parse('2026-11-01T09:00:00+03:00');
  it('onaysız kurulum 14 gün deneme, sonra 7 gün uyarı, sonra yeni satış kapalı', () => {
    expect(licenseState(null, { installedAt: at, now: at + 13 * DAY })).toMatchObject({ state: 'deneme' });
    expect(licenseState({ durum: 'bekliyor' }, { installedAt: at, now: at + TRIAL_DAYS * DAY + 1 })).toMatchObject({ state: 'uyari' });
    expect(licenseState({ durum: 'bekliyor' }, { installedAt: at, now: at + (TRIAL_DAYS + GRACE_DAYS) * DAY + 1 })).toMatchObject({ state: 'kapali' });
  });
  it('aktif lisans bitiş gününün sonuna kadar (İstanbul); bitişsiz süresiz', () => {
    const rec = { durum: 'aktif' as const, bitis: '2026-11-30' };
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-11-30T23:59:00+03:00') })).toMatchObject({ state: 'aktif' });
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-12-01T00:01:00+03:00') }).state).toBe('uyari');
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-12-08T00:01:00+03:00') }).state).toBe('kapali');
    expect(licenseState({ durum: 'aktif' }, { installedAt: at, now: at + 900 * DAY })).toMatchObject({ state: 'aktif', until: null });
  });
  it('pasif: pasife alındığı andan 7 gün uyarı', () => {
    const p = { durum: 'pasif' as const, pasifAt: at };
    expect(licenseState(p, { installedAt: at, now: at + 6 * DAY }).message).toMatch(/1 gün sonra yeni satış kapanacak/);
    expect(licenseState(p, { installedAt: at, now: at + 7 * DAY }).state).toBe('kapali');
  });
  it('bitişe 14 gün kala yalnız uyarı: durum aktif kalır', () => {
    const rec = { durum: 'aktif' as const, bitis: '2026-11-30' };
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-11-10T12:00:00+03:00') }).soon).toBeUndefined();
    expect(licenseState(rec, { installedAt: at, now: Date.parse('2026-11-25T12:00:00+03:00') })).toMatchObject({ state: 'aktif', soon: true, message: expect.stringMatching(/30 Kasım 2026 tarihinde bitiyor: 6 gün kaldı/) });
  });
  it('çevrimdışı kural: Merkez son 15 dakikada onaylamadıysa satış kapanmaz, yalnız uyarı', () => {
    const p = { durum: 'pasif' as const, pasifAt: at };
    const now = at + 30 * DAY;
    expect(licenseState(p, { installedAt: at, now, confirmedAt: now - 60_000 }).state).toBe('kapali');
    expect(licenseState(p, { installedAt: at, now, confirmedAt: now - CONFIRM_MS - 1 })).toMatchObject({ state: 'uyari', offline: true });
    expect(licenseState(p, { installedAt: at, now, confirmedAt: null })).toMatchObject({ state: 'uyari', offline: true });
    // Hiç bağlanmamış kurulumun bitmiş denemesi de satış kesmez
    expect(licenseState(null, { installedAt: at, now: at + 60 * DAY, confirmedAt: null }).state).toBe('uyari');
  });
  it('şube kodu: büyük harfe çevrilir; harf, rakam ve tire, en çok 12', () => {
    expect(normalizeBranchCode(' mrn ')).toBe('MRN');
    expect(normalizeBranchCode('TZL-2')).toBe('TZL-2');
    expect(normalizeBranchCode('')).toBeNull();
    expect(normalizeBranchCode(null)).toBeNull();
    expect(normalizeBranchCode('Şube 1')).toBeUndefined();
    expect(normalizeBranchCode('A'.repeat(13))).toBeUndefined();
  });
});

describe('Merkez: kayıt, nabız, panel', () => {
  it('Merkez kapalıyken (adres yok) lisans uygulanmaz', async () => {
    const { env } = await import('../server/env');
    const { licenseNow } = await import('../server/sync/merkez');
    Object.assign(env, { merkezUrl: '' });
    expect(licenseNow()).toBeNull();
    // Kafenin ortak anahtarı yoksa da (kayıt imzalanamaz)
    Object.assign(env, { merkezUrl: CLOUD, cloudSecret: '' });
    expect(licenseNow()).toBeNull();
    Object.assign(env, { merkezUrl: CLOUD, cloudSecret: SECRET });
  });

  it('kasa ilk nabızda kaydolur, "Onay bekliyor"da görünür; anahtar panele dönmez', async () => {
    const { merkezBeat, identity, merkezLast } = await import('../server/sync/merkez');
    expect(await merkezBeat()).toBe(true);
    const me = identity();
    expect(me.registered).toBe(true);
    expect(merkezLast()).toMatchObject({ lisans: { durum: 'bekliyor' }, mod: 'elle', hedef: null });
    const list = await panel('GET', 'merkez/kurulumlar');
    expect(list.status).toBe(200);
    expect(list.json.kurulumlar).toHaveLength(1);
    expect(list.json.kurulumlar[0]).toMatchObject({ id: me.id, ad: null, online: true, lisans: { durum: 'bekliyor', state: 'deneme' }, bekleyen: false });
    expect(JSON.stringify(list.json)).not.toContain(me.key);
    expect(list.json.enYeni).toMatchObject({ version: '0.3.0', not: 'Merkez ve lisans' });
  });

  it('kayıt bir kez: aynı kimliğe başka anahtar yazılamaz; imzasız ya da yanlış imzalı nabız reddedilir', async () => {
    const { identity } = await import('../server/sync/merkez');
    const { POST } = await api();
    const me = identity();
    const { signedHeaders } = await import('../server/lib/signature');
    // İmzasız kayıt hiç işlenmez; kafenin anahtarıyla imzalı olsa da kayıtlı kimliğe başka anahtar yazılamaz
    const stolenBody = JSON.stringify({ id: me.id, anahtar: 'x'.repeat(40) });
    expect((await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/kayit`, { method: 'POST', body: stolenBody }))).status).toBe(401);
    const stolen = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/kayit`, { method: 'POST', body: stolenBody, headers: signedHeaders(SECRET, 'POST', new URL(`${CLOUD}/api/merkez/kayit`), stolenBody) }));
    expect(stolen.status).toBe(409);
    const unsigned = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/nabiz`, { method: 'POST', headers: { 'x-laf-kurulum': me.id }, body: '{}' }));
    expect(unsigned.status).toBe(401);
    const body = '{"surum":"9.9.9"}';
    const forged = await POST(new Request(`${CLOUD}/api/uzaktan?yol=merkez/nabiz`, { method: 'POST', headers: { 'x-laf-kurulum': me.id, ...signedHeaders('y'.repeat(40), 'POST', new URL(`${CLOUD}/api/merkez/nabiz`), body) }, body }));
    expect(forged.status).toBe(401);
  });

  it('panel yalnız gerçek oturumla: jetonsuz 401, parolasız görünümde 403 (oturum düşmez)', async () => {
    expect((await panel('GET', 'merkez/kurulumlar', undefined, 'yok')).status).toBe(401);
    delete process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI;
    try {
      const { POST } = await api();
      const open = (await (await POST(new Request(`${CLOUD}/api/uzaktan?yol=uzaktan/giris`, { method: 'POST' }))).json()) as { token: string };
      expect((await panel('GET', 'merkez/kurulumlar', undefined, open.token)).status).toBe(403);
      expect((await panel('POST', 'merkez/gonder', { ids: ['a'.repeat(24)] }, open.token)).status).toBe(403);
    } finally {
      process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI = '1';
    }
  });

  it('sahip ad verir ve lisansı aktif yapar; kasa sonraki nabızda alır', async () => {
    const { merkezBeat, identity, licenseNow, merkezLast } = await import('../server/sync/merkez');
    const id = identity().id;
    const res = await panel('POST', 'merkez/kurulum', { id, ad: 'Tuzla', lisans: 'aktif', bitis: '2099-12-31' });
    expect(res.json.kurulum).toMatchObject({ ad: 'Tuzla', lisans: { durum: 'aktif', bitis: '2099-12-31', state: 'aktif' } });
    expect((await panel('POST', 'merkez/kurulum', { id, lisans: 'aktif', bitis: '31.12.2099' })).status).toBe(400);
    await merkezBeat();
    expect(merkezLast()).toMatchObject({ ad: 'Tuzla', lisans: { durum: 'aktif', bitis: '2099-12-31' } });
    expect(licenseNow()!.state).toBe('aktif');
  });

  it("şube kodu ve lisansın son günü Uzaktan'dan verilir; kasa nabızla alır, Yönetim ve fiş başlığı gösterir", async () => {
    const { merkezBeat, identity, merkezLast } = await import('../server/sync/merkez');
    const id = identity().id;
    expect((await panel('POST', 'merkez/kurulum', { id, kod: 'Şube 1' })).status).toBe(400);
    const res = await panel('POST', 'merkez/kurulum', { id, kod: 'tzl', lisans: 'aktif', bitis: '2099-12-31' });
    expect(res.json.kurulum).toMatchObject({ kod: 'TZL', lisans: { bitis: '2099-12-31', state: 'aktif' } });
    await merkezBeat();
    expect(merkezLast()).toMatchObject({ kod: 'TZL', lisans: { durum: 'aktif', bitis: '2099-12-31' } });
    const lisans = await h.ok<Record<string, unknown>>('kasa', 'GET', '/sync/lisans');
    expect(lisans).toMatchObject({ enabled: true, state: 'aktif', ad: 'Tuzla', kod: 'TZL', bitis: '2099-12-31' });
    const boot = await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap');
    expect(boot.branch).toEqual({ name: 'Tuzla', code: 'TZL' });
    // Kod boş bırakılınca silinir; ad kalır
    await panel('POST', 'merkez/kurulum', { id, kod: '' });
    await merkezBeat();
    expect(merkezLast()!.kod).toBeNull();
    expect((await h.ok<BootstrapDTO>('kasa', 'GET', '/bootstrap')).branch).toEqual({ name: 'Tuzla', code: null });
  });

  it('süresi dolmuş lisans (uyarı süresinde) adisyon açmayı, kalem eklemeyi ve tahsilatı durdurmaz', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const id = identity().id;
    const expired = new Date(Date.now() - 2 * DAY).toISOString().slice(0, 10);
    await panel('POST', 'merkez/kurulum', { id, lisans: 'aktif', bitis: expired });
    await merkezBeat();
    expect(await h.ok<{ state: string; message: string }>('kasa', 'GET', '/sync/lisans')).toMatchObject({ state: 'uyari', message: expect.stringMatching(/Lisansın süresi doldu/) });
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, size: 'M', qty: 1 }] });
    const nakit = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    expect((await h.call('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: nakit.id, amount: o.total })).status).toBe(200);
  });

  it('pasif lisans: önce uyarı (satış sürer), 7 gün sonra Merkez onaylıyorsa yeni satış kapanır; tahsilat ve raporlar açık', async () => {
    const { merkezBeat, identity, assertCanSell, licenseNow } = await import('../server/sync/merkez');
    const id = identity().id;
    await panel('POST', 'merkez/kurulum', { id, lisans: 'pasif' });
    await merkezBeat();
    const latte = h.boot.products.find((p) => p.name === 'Latte')!;
    const open = await h.call<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(open.status).toBe(200);
    const withItem = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${open.json.id}/items`, { items: [{ productId: latte.id, size: 'M', qty: 1 }] });
    const lisans = await h.ok<{ enabled: boolean; state: string; message: string }>('kasa', 'GET', '/sync/lisans');
    expect(lisans).toMatchObject({ enabled: true, state: 'uyari', ad: 'Tuzla' });
    // 8 gün sonra, internet yokken: kasa son kaydı kendi saatiyle sayar ama Merkez onaylamadığı için satış sürer (uyarı)
    cloudDown = true;
    const later = Date.now() + 8 * DAY;
    try {
      expect(await merkezBeat(later)).toBe(false);
      expect(() => assertCanSell(later)).not.toThrow();
      expect(licenseNow(later)).toMatchObject({ state: 'uyari', offline: true });
    } finally {
      cloudDown = false;
    }
    // Merkez'e ulaşınca (kayıt hâlâ pasif) yeni satış kapanır
    expect(await merkezBeat(later)).toBe(true);
    expect(() => assertCanSell(later)).toThrow(/yeni satış kapalı/);
    // Uçlar: 8 gün önce pasife alınmış kayıt, Merkez az önce onayladı (oturum süresi gerçek saatle kalsın)
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const last = getSyncState<Record<string, unknown>>('merkez.son')!;
    setSyncState('merkez.son', { ...last, lisans: { durum: 'pasif', pasifAt: Date.now() - 8 * DAY }, at: Date.now() });
    const blocked = await h.call<{ code: string }>('kasa', 'POST', '/orders', { type: 'tezgah' });
    expect(blocked.status).toBe(403);
    expect(blocked.json.code).toBe('license_blocked');
    const items = await h.call<{ code: string }>('kasa', 'POST', `/orders/${open.json.id}/items`, { items: [] });
    expect(items.status).toBe(403);
    // Açık adisyonun tahsilatı ve raporlar açık
    const nakit = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    expect((await h.call('kasa', 'POST', `/orders/${open.json.id}/payments`, { methodId: nakit.id, amount: withItem.total })).status).toBe(200);
    expect((await h.call('patron', 'GET', '/reports/patron')).status).toBe(200);
    // Kasa Merkez'e 15 dakikadır ulaşamıyor: aynı kayıtla satış yeniden açık (çevrimdışı kasa durmaz)
    setSyncState('merkez.son', { ...last, lisans: { durum: 'pasif', pasifAt: Date.now() - 8 * DAY }, at: Date.now() - CONFIRM_MS - 60_000 });
    expect((await h.call('kasa', 'POST', '/orders', { type: 'tezgah' })).status).toBe(200);
    expect(await h.ok<{ state: string; offline?: boolean }>('kasa', 'GET', '/sync/lisans')).toMatchObject({ state: 'uyari', offline: true });
    // Sahip yeniden aktif yapınca satış açılır
    await panel('POST', 'merkez/kurulum', { id, lisans: 'aktif', bitis: null });
    await merkezBeat();
    expect(() => assertCanSell(later)).not.toThrow();
  });

  it('seçerek gönderme: "ben gönderince" dükkân hedefi gönderilince alır; otomatik dükkân hep son derlemeyi', async () => {
    const { merkezBeat, identity, merkezTarget } = await import('../server/sync/merkez');
    const id = identity().id;
    expect(merkezTarget()).toEqual({ enabled: true, hedef: null });
    let list = await panel('GET', 'merkez/kurulumlar');
    expect(list.json.kurulumlar[0].mod).toBe('elle');
    expect((await panel('POST', 'merkez/gonder', { ids: [] })).status).toBe(400);
    const sent = await panel('POST', 'merkez/gonder', { ids: [id] });
    expect(sent.json).toMatchObject({ gonderilen: 1, build: BUILD + 500 });
    await merkezBeat();
    expect(merkezTarget()).toEqual({ enabled: true, hedef: BUILD + 500 });

    // Yeni sürüm main'e girdi: "ben gönderince" dükkân eski hedefte kalır, otomatik olan yeniyi alır
    release = { ...release!, build: BUILD + 900, version: '0.3.1' };
    const { resetReleaseCache } = await api();
    resetReleaseCache();
    await merkezBeat();
    expect(merkezTarget().hedef).toBe(BUILD + 500);
    list = await panel('GET', 'merkez/kurulumlar');
    expect(list.json.enYeni.build).toBe(BUILD + 900);
    await panel('POST', 'merkez/kurulum', { id, mod: 'otomatik' });
    await merkezBeat();
    expect(merkezTarget().hedef).toBe(BUILD + 900);
    // Güncelleyicinin sorusu (yalnız bu bilgisayardan) hedefi taşır
    const local = await h.call<{ merkez: unknown }>('kasa', 'GET', '/kasa/guncelleme-durumu', undefined, { 'x-forwarded-for': '127.0.0.1' });
    expect([200, 403]).toContain(local.status);
  });

  it('kurulum yenilenemediyse (kurulumUyari) nabızla panele gider; uyarı kalkınca panelden de kalkar', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const { env } = await import('../server/env');
    const id = identity().id;
    const file = join(env.dataDir, 'guncelleme', 'durum.json');
    mkdirSync(join(env.dataDir, 'guncelleme'), { recursive: true });
    const uyari = "Kurulumu yenileyin (LafPOS-Kur.cmd'yi yeniden çalıştırın): baslat.cmd eski kaldı";
    try {
      writeFileSync(file, JSON.stringify({ durum: 'guncel', mesaj: 'Güncel', kurulumUyari: uyari }));
      await merkezBeat();
      let row = (await panel('GET', 'merkez/kurulumlar')).json.kurulumlar.find((k: { id: string }) => k.id === id);
      expect(row.guncelleme).toMatchObject({ durum: 'guncel', kurulumUyari: uyari });
      writeFileSync(file, JSON.stringify({ durum: 'guncel', mesaj: 'Güncel', kurulumUyari: null }));
      await merkezBeat();
      row = (await panel('GET', 'merkez/kurulumlar')).json.kurulumlar.find((k: { id: string }) => k.id === id);
      expect(row.guncelleme.kurulumUyari).toBeNull();
    } finally {
      rmSync(file, { force: true });
    }
  });

  it('Uzaktan\'tan "Şimdi güncelle": kasa nabızda alır, yerel isteği yazar (gün açıkken kurdurmaz), denetim kaydına bir kez yazar', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const { env } = await import('../server/env');
    const { pendingUpdateRequest } = await import('../server/lib/surum');
    const id = identity().id;
    const file = join(env.dataDir, 'guncelleme', 'istek.json');
    const audits = async () => (await h.ok<{ action: string; message: string }[]>('patron', 'GET', '/admin/audit?limit=50')).filter((a) => a.action === 'guncelleme' && a.message.includes("Merkez'den"));
    expect((await panel('POST', 'merkez/simdi-guncelle', { ids: [] })).status).toBe(400);
    const before = (await audits()).length;
    const prevBekci = process.env.LAFPOS_STDIN_CONTROL;
    process.env.LAFPOS_STDIN_CONTROL = '1';
    try {
      const asked = await panel('POST', 'merkez/simdi-guncelle', { ids: [id] });
      expect(asked.json).toMatchObject({ ok: true, istenen: 1 });
      expect((await panel('GET', 'merkez/kurulumlar')).json.kurulumlar[0]).toMatchObject({ istekBekliyor: true });
      // Gün açık (beforeAll): istek denetler ve indirir, hemen kurmaz
      await merkezBeat();
      expect(pendingUpdateRequest()).toMatchObject({ by: 'merkez', simdi: false });
      expect((await audits()).length).toBe(before + 1);
      expect((await audits())[0]!.message).toMatch(/gün kapalıyken kurulur/);
      // Aynı istek ikinci nabızda yeniden işlenmez; kasa aldığını bildirir, panel "istendi"yi düşürür
      rmSync(file, { force: true });
      await merkezBeat();
      expect(existsSync(file)).toBe(false);
      expect((await audits()).length).toBe(before + 1);
      expect((await panel('GET', 'merkez/kurulumlar')).json.kurulumlar[0].istekBekliyor).toBe(false);
    } finally {
      process.env.LAFPOS_STDIN_CONTROL = prevBekci ?? '';
      rmSync(file, { force: true });
    }
    // Windows güncelleyicisi olmayan kurulumda istek yazılmaz, denetim kaydı söyler
    await new Promise((r) => setTimeout(r, 5));
    await panel('POST', 'merkez/simdi-guncelle', { ids: [id] });
    await merkezBeat();
    expect(existsSync(file)).toBe(false);
    expect((await audits())[0]!.message).toMatch(/otomatik güncelleyici yok/);
    // Satış bu sırada sürer
    expect((await h.call('kasa', 'POST', '/orders', { type: 'tezgah' })).status).toBe(200);
  });

  it('Merkez\'den gönderilen sürüm kasiyere sorulmaz: gün sonunda kurulur; panel adımları gösterir (aldı, kuruluyor, kurulamadı)', async () => {
    const { merkezBeat, identity, merkezTarget, effectiveUpdateChoice } = await import('../server/sync/merkez');
    const { env } = await import('../server/env');
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const { UPDATE_CHOICE_KEY } = await import('../server/lib/surum');
    const id = identity().id;
    const hedef = merkezTarget().hedef!;
    expect(hedef).toBeGreaterThan(0);
    const file = join(env.dataDir, 'guncelleme', 'durum.json');
    mkdirSync(join(env.dataDir, 'guncelleme'), { recursive: true });
    const status = (over: Record<string, unknown>) => writeFileSync(file, JSON.stringify({ durum: 'bekliyor', mesaj: 'Yeni sürüm hazır', yeni: { surum: '0.3.1', build: hedef }, ...over }));
    const row = async () => (await panel('GET', 'merkez/kurulumlar')).json.kurulumlar.find((k: { id: string }) => k.id === id);
    const prevChoice = getSyncState(UPDATE_CHOICE_KEY);
    // Seçim kaydı silinemez (NOT NULL): başka derlemenin seçimi "seçim yok" demektir
    const none = { build: 1, secim: 'simdi', at: 0, by: '' };
    try {
      setSyncState(UPDATE_CHOICE_KEY, none);
      status({});
      // Gün açık, kasada seçim yapılmadı: soru yok, seçim kendiliğinden gün sonu
      const offer = await h.ok<{ secim: string | null; secimKaynak: string | null; dayOpen: boolean }>('patron', 'GET', '/admin/guncelleme/teklif');
      expect(offer).toMatchObject({ secim: 'gunsonu', secimKaynak: 'merkez', dayOpen: true });
      await merkezBeat();
      expect((await row()).guncelleme).toMatchObject({ etiket: 'Gün sonunda kurulacak' });
      expect((await row()).gonderim).toEqual({ etiket: 'Kasa aldı · gün sonunda kurulacak', ton: 'info' });
      // Kasada "Şimdi güncelle" seçilirse o geçerli (mevcut davranış)
      setSyncState(UPDATE_CHOICE_KEY, { build: hedef, secim: 'simdi', at: Date.now(), by: 'Patron' });
      expect(effectiveUpdateChoice({ build: hedef })).toEqual({ secim: 'simdi', kaynak: 'kasa' });
      setSyncState(UPDATE_CHOICE_KEY, none);
      // Merkez'in göndermediği (daha yeni) derleme kasada sorulur
      expect(effectiveUpdateChoice({ build: hedef + 1 })).toBeNull();
      status({ durum: 'kuruluyor', mesaj: 'Yeni sürüm kuruluyor' });
      await merkezBeat();
      expect((await row()).gonderim).toEqual({ etiket: 'Kuruluyor', ton: 'info' });
      status({ durum: 'geri-dondu', mesaj: '0.3.1 kurulunca sorun çıktı; eski sürüme dönüldü', yeni: null });
      await merkezBeat();
      expect((await row()).gonderim).toEqual({ etiket: 'Kurulamadı: 0.3.1 kurulunca sorun çıktı; eski sürüme dönüldü', ton: 'warning' });
    } finally {
      rmSync(file, { force: true });
      setSyncState(UPDATE_CHOICE_KEY, prevChoice ?? none);
    }
  });

  it('gönderimin adımları (deliveryStatus): gönderildi, kasa aldı, kuruluyor, kuruldu (çalışan derleme), kurulamadı; eski kasa', async () => {
    const { deliveryStatus } = await import('../api/_merkez');
    const at = Date.parse('2026-11-22T19:20:00.000Z'); // 22:20 İstanbul
    const base = { hedef: BUILD + 900, gonderildi: at, build: BUILD + 500, surum: '0.3.0', guncelleme: { durum: 'guncel', mesaj: 'Güncel', yeni: null, secim: null } };
    expect(deliveryStatus({ ...base, hedef: null })).toBeNull();
    expect(deliveryStatus(base)).toEqual({ etiket: 'Gönderildi 22:20', ton: 'info' });
    const yeni = { surum: '0.3.1', build: BUILD + 900 };
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'indiriliyor', mesaj: '', yeni, secim: null } })!.etiket).toBe('Kasa aldı · indiriliyor');
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'bekliyor', mesaj: '', yeni, secim: 'gunsonu' } })!.etiket).toBe('Kasa aldı · gün sonunda kurulacak');
    // Eski kasa: seçim alanı yok, eski etiket
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'bekliyor', mesaj: '', yeni } })!.etiket).toMatch(/^Kasa aldı · /);
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'kuruluyor', mesaj: '', yeni, secim: 'gunsonu' } })!.etiket).toBe('Kuruluyor');
    // Kuruldu yalnız çalışan derleme gönderilene varınca; an kasanın son kurulumu (22:41)
    const done = Date.parse('2026-11-22T19:41:00.000Z');
    expect(deliveryStatus({ ...base, build: BUILD + 900, surum: '0.3.1', guncelleme: { durum: 'guncel', mesaj: 'Güncellendi', yeni: null, secim: null, sonKurulum: done } })).toEqual({ etiket: 'Kuruldu 22:41 · sürüm 0.3.1', ton: 'success' });
    expect(deliveryStatus({ ...base, build: BUILD + 900, surum: '0.3.1', guncelleme: null })!.etiket).toBe('Kuruldu · sürüm 0.3.1');
    // Durum "güncel" dese de çalışan derleme eskiyse kurulmuş sayılmaz
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'guncel', mesaj: 'Güncellendi', yeni: null, sonKurulum: done } })!.etiket).toBe('Gönderildi 22:20');
    expect(deliveryStatus({ ...base, guncelleme: { durum: 'hata', mesaj: 'Yeni sürüm indirilemedi: ağ yok', yeni: null } })).toEqual({ etiket: 'Kurulamadı: Yeni sürüm indirilemedi: ağ yok', ton: 'warning' });
  });

  it('geçmiş ciro (LafPOS öncesi günler) nabızla kasaya gelir; kasanın kendi patron panelinin kıyasına girer, silinince düşer', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const { addDays } = await import('@shared/time');
    const id = identity().id;
    const today = (await h.ok<{ date: string }>('patron', 'GET', '/reports/patron')).date;
    const dun = addDays(today, -1);
    const up = await panel('POST', 'merkez/gecmis', { id, kaynak: 'ModPOS', gunler: [{ date: dun, ciro: 46205, adisyon: 3, closes: [[300, 6205, 1], [600, 40000, 2]] }] });
    expect(up.status).toBe(200);
    await merkezBeat();
    const p = await h.ok<{ stats: { days: Record<string, { closes: number[][] }>; daily: [string, number, number][] } }>('patron', 'GET', '/reports/patron');
    expect(p.stats.days[dun]!.closes).toEqual([[300, 6205, 1], [600, 40000, 2]]);
    expect(p.stats.daily).toContainEqual([dun, 46205, 3]);
    // Kaynağın adı da gelir (kasanın Raporlar'ı günleri "ModPOS" diye etiketler); bu sürümden önce alınmış (adsız) kayıt
    // için kasa nabızda 0 söyler, Merkez kaydı bir kez adıyla yeniden gönderir
    const { getSyncState, setSyncState } = await import('../server/lib/settings');
    const { GECMIS_KEY } = await import('@shared/gecmis');
    const got = getSyncState<{ at: number; kaynak?: string; gunler: unknown[] }>(GECMIS_KEY)!;
    expect(got.kaynak).toBe('ModPOS');
    setSyncState(GECMIS_KEY, { at: got.at, gunler: got.gunler });
    await merkezBeat();
    expect(getSyncState<{ at: number; kaynak?: string }>(GECMIS_KEY)).toMatchObject({ at: got.at, kaynak: 'ModPOS' });
    const sum = await h.ok<{ byDay: { date: string; kaynak?: string }[] }>('patron', 'GET', `/reports/summary?from=${dun}&to=${dun}`);
    expect(sum.byDay).toEqual([expect.objectContaining({ date: dun, kaynak: 'ModPOS', netSales: 46205 })]);
    await panel('POST', 'merkez/gecmis', { id, gunler: [] });
    await merkezBeat();
    const after = await h.ok<{ stats: { days: Record<string, unknown> } }>('patron', 'GET', '/reports/patron');
    expect(after.stats.days[dun]).toBeUndefined();
  });

  it('Merkez kaydı silinirse (Redis sıfırlandı) kasa yeniden kaydolur', async () => {
    const { merkezBeat, identity } = await import('../server/sync/merkez');
    const id = identity().id;
    store.delete(`lafpos:merkez:kurulum:${id}`);
    expect(await merkezBeat()).toBe(false);
    expect(identity().registered).toBe(false);
    expect(await merkezBeat()).toBe(true);
    expect(store.has(`lafpos:merkez:kurulum:${id}`)).toBe(true);
  });

  it('kayıtlı eski (rastgele) kimlik: kayıt silinse de aynı kimlikle, adı ve lisansıyla döner; dükkân kimliği değişmez', async () => {
    const { merkezBeat, identity, remoteShop, merkezLast, licenseNow } = await import('../server/sync/merkez');
    const { setSyncState } = await import('../server/lib/settings');
    const { randomBytes } = await import('node:crypto');
    const oldId = randomBytes(12).toString('hex');
    const key = randomBytes(32).toString('base64url');
    const createdAt = Date.now() - 30 * DAY;
    setSyncState('merkez.kimlik', { id: oldId, key, createdAt, registered: true });
    const inst = { id: oldId, key, ad: 'Marina', createdAt, lastSeen: null, surum: null, build: null, guncelleme: null, gunAcik: null, lisans: { durum: 'aktif', bitis: null }, mod: 'elle', hedef: null, gonderildi: null, kod: 'MRN' };
    store.set(`lafpos:merkez:kurulum:${oldId}`, JSON.stringify(inst));
    expect(await merkezBeat()).toBe(true);
    expect(remoteShop()).toBe(oldId);
    // Lisansı aktif kurulum silinmez
    expect((await panel('POST', 'merkez/sil', { id: oldId })).status).toBe(400);
    expect(store.has(`lafpos:merkez:kurulum:${oldId}`)).toBe(true);
    // Pasife alınıp silinir: kasa sonraki nabızlarda aynı kimlikle, adı, kodu ve lisansıyla döner
    expect((await panel('POST', 'merkez/kurulum', { id: oldId, lisans: 'pasif' })).status).toBe(200);
    expect((await panel('POST', 'merkez/sil', { id: oldId })).status).toBe(200);
    expect(await merkezBeat()).toBe(false);
    expect(identity().id).toBe(oldId);
    expect(await merkezBeat()).toBe(true);
    expect(remoteShop()).toBe(oldId);
    expect(merkezLast()).toMatchObject({ ad: 'Marina', kod: 'MRN', lisans: { durum: 'pasif' } });
    // Pasif yeniden aktif: satış açık
    expect((await panel('POST', 'merkez/kurulum', { id: oldId, lisans: 'aktif' })).status).toBe(200);
    await merkezBeat();
    expect(licenseNow()?.state).not.toBe('kapali');
    expect((await h.call('kasa', 'POST', '/orders', { type: 'tezgah' })).status).toBe(200);
  });
});
