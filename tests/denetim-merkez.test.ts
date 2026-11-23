import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { signedHeaders } from '../server/lib/signature';

/**
 * Oturum denetiminin Merkez ve uzaktan oturum bulguları (api/_merkez.ts, api/uzaktan.ts):
 * - kayıt kafenin ortak anahtarıyla imzalı, kimlik anahtarın özeti, IP ve bekleyen sınırı
 * - güncelleme sorunu bildirimi yalnız onaylı dükkânda, sabit metinle ve 6 saatte bir
 * - nabızda `__proto__` gibi durum paneli düşürmez
 * - nabız panelin verdiği lisansı ezmez (ayrı anahtar)
 * - parolasız görünümün jetonu parola açılınca geçersiz; parolasız oturum Merkez'de 403 (401 değil)
 */
const SECRET = 'd'.repeat(40);
const ORIGIN = 'https://denetim.test';
const PASSWORD = 'denetim-parola-12';
const store = new Map<string, string>();
const sets = new Map<string, Set<string>>();
const KEYS = ['LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_PAROLA', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'LAFPOS_UZAKTAN_DEMO', 'LAFPOS_UYE_EPOSTA', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'];
const before: Record<string, string | undefined> = {};
const pushed: { title: string; body: string }[] = [];

function redisCmd(cmd: string, key: string, rest: string[]): unknown {
  if (cmd === 'GET') return store.get(key) ?? null;
  if (cmd === 'MGET') return [key, ...rest].map((k) => store.get(k) ?? null);
  if (cmd === 'SET') {
    if (rest.includes('NX') && store.has(key)) return null;
    store.set(key, rest[0]!);
    return 'OK';
  }
  if (cmd === 'SADD' || cmd === 'SREM') {
    const s = sets.get(key) ?? new Set();
    rest.forEach((x) => (cmd === 'SADD' ? s.add(x) : s.delete(x)));
    sets.set(key, s);
    return 1;
  }
  if (cmd === 'SCARD') return sets.get(key)?.size ?? 0;
  if (cmd === 'SMEMBERS') return [...(sets.get(key) ?? [])];
  if (cmd === 'INCR') {
    store.set(key, String(Number(store.get(key) ?? 0) + 1));
    return Number(store.get(key));
  }
  if (cmd === 'DEL') return [key, ...rest].filter((k) => store.delete(k)).length;
  return 1;
}

beforeAll(async () => {
  for (const k of KEYS) before[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { LAFPOS_CLOUD_SECRET: SECRET, LAFPOS_UZAKTAN_PAROLA: PASSWORD, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', LAFPOS_UZAKTAN_DEMO: '0', VAPID_PUBLIC_KEY: 'BPub', VAPID_PRIVATE_KEY: 'priv' });
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://redis.test') {
      const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
      return new Response(JSON.stringify({ result: redisCmd(cmd!, key!, rest.map(String)) }));
    }
    if (url.endsWith('/guncelleme/surum.json')) return Response.json({ version: '0.3.0', build: 2000, date: '' });
    throw new TypeError('fetch failed');
  });
  const { setPushSender } = await import('../api/_bildirim');
  setPushSender(async (_sub, payload) => {
    pushed.push(JSON.parse(payload) as { title: string; body: string });
    return { statusCode: 201 };
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
});
beforeEach(() => {
  store.clear();
  sets.clear();
  pushed.length = 0;
  delete process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI;
});

const api = () => import('../api/uzaktan');
const merkezApi = () => import('../api/_merkez');

async function call(method: 'GET' | 'POST', path: string, opts: { body?: string; headers?: Record<string, string>; token?: string } = {}) {
  const { GET, POST } = await api();
  const headers: Record<string, string> = { 'x-forwarded-for': '7.7.7.7', ...(opts.headers ?? {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) };
  const r = new Request(`${ORIGIN}/api/uzaktan?yol=${path}`, { method, headers, body: opts.body });
  return method === 'GET' ? GET(r) : POST(r);
}

/** Kasanın kaydı: kafenin ortak anahtarıyla imzalı */
async function register(key: string, id?: string, secret = SECRET, ip = '7.7.7.7') {
  const { installIdFor } = await merkezApi();
  const body = JSON.stringify({ id: id ?? installIdFor(key), anahtar: key, surum: '0.2.0', build: 1000 });
  return call('POST', 'merkez/kayit', { body, headers: { 'x-forwarded-for': ip, ...signedHeaders(secret, 'POST', new URL(`${ORIGIN}/api/merkez/kayit`), body) } });
}

/** Kurulumun kendi anahtarıyla imzalı nabız */
async function beat(key: string, payload: unknown) {
  const { installIdFor } = await merkezApi();
  const body = JSON.stringify(payload);
  return call('POST', 'merkez/nabiz', { body, headers: { 'x-laf-kurulum': installIdFor(key), ...signedHeaders(key, 'POST', new URL(`${ORIGIN}/api/merkez/nabiz`), body) } });
}

async function adminToken() {
  process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI = '1';
  const res = await call('POST', 'uzaktan/giris', { body: JSON.stringify({ parola: PASSWORD }) });
  return ((await res.json()) as { token: string }).token;
}

async function activate(key: string, token: string) {
  const { installIdFor } = await merkezApi();
  const res = await call('POST', 'merkez/kurulum', { body: JSON.stringify({ id: installIdFor(key), lisans: 'aktif', ad: 'Marina' }), token });
  expect(res.status).toBe(200);
}

describe('Merkez kaydı: yalnız kasadan, kimlik anahtarın özeti, sınırlı', () => {
  it('imzasız ya da yanlış anahtarla imzalı kayıt reddedilir; kafenin anahtarıyla imzalı kayıt açılır', async () => {
    const { installIdFor } = await merkezApi();
    const key = 'k'.repeat(40);
    const unsigned = await call('POST', 'merkez/kayit', { body: JSON.stringify({ id: installIdFor(key), anahtar: key }) });
    expect(unsigned.status).toBe(401);
    expect((await register(key, undefined, 'x'.repeat(40))).status).toBe(401);
    expect(sets.get('lafpos:merkez:kurulumlar')?.size ?? 0).toBe(0);
    const ok = await register(key);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, yeni: true });
    // Aynı kasa yeniden bildirir: sorun yok
    expect((await register(key)).status).toBe(200);
  });

  it('yeni kurulumun kimliği anahtarının özeti olmalı: başkasının kimliğini önceden kaydetmek işe yaramaz', async () => {
    const victim = 'v'.repeat(43);
    const { installIdFor } = await merkezApi();
    // Saldırgan kurbanın (gördüğü) kimliğini kendi anahtarıyla yazmaya çalışır
    expect((await register('s'.repeat(40), installIdFor(victim))).status).toBe(400);
    expect((await register(victim)).status).toBe(200);
  });

  it('IP başına saatte en çok 10 kayıt; onay bekleyen en çok 50', async () => {
    for (let i = 0; i < 10; i++) expect((await register(`a${i}`.padEnd(40, 'x'), undefined, SECRET, '8.8.8.8')).status).toBe(200);
    expect((await register('b'.repeat(40), undefined, SECRET, '8.8.8.8')).status).toBe(429);
    for (let i = 0; i < 40; i++) sets.get('lafpos:merkez:bekleyen')!.add(`dolgu${i}`);
    const full = await register('c'.repeat(40), undefined, SECRET, '9.9.9.9');
    expect(full.status).toBe(429);
    expect(((await full.json()) as { code: string }).code).toBe('too_many_pending');
    // Sahip birini onaylayınca (ya da silince) yer açılır
    const token = await adminToken();
    await activate('a0'.padEnd(40, 'x'), token);
    expect((await register('c'.repeat(40), undefined, SECRET, '9.9.9.9')).status).toBe(200);
  });

  it('panel kaydı silebilir; kasa çalışıyorsa sonraki nabızda yeniden kaydolur', async () => {
    const key = 'e'.repeat(40);
    await register(key);
    const token = await adminToken();
    const { installIdFor } = await merkezApi();
    expect((await call('POST', 'merkez/sil', { body: JSON.stringify({ id: installIdFor(key) }), token })).status).toBe(200);
    expect(sets.get('lafpos:merkez:kurulumlar')?.has(installIdFor(key))).toBe(false);
    expect((await beat(key, {})).status).toBe(404);
    expect((await register(key)).status).toBe(200);
  });
});

describe('Merkez nabzı: bildirim ve durum', () => {
  it('onay bekleyen kurulum bildirim gönderemez; kasanın iletisi bildirime girmez', async () => {
    const key = 'p'.repeat(40);
    await register(key);
    const abonelik = { endpoint: 'https://push.test/patron', keys: { p256dh: 'p', auth: 'a' } };
    expect((await call('POST', 'uzaktan/bildirim/abone', { body: JSON.stringify({ abonelik }), token: await adminToken() })).status).toBe(200);
    for (const durum of ['hata', 'guncel', 'hata']) {
      expect((await beat(key, { guncelleme: { durum, mesaj: 'Lisansınız askıya alındı: https://kotu.example/odeme' } })).status).toBe(200);
    }
    expect(pushed).toHaveLength(0);
  });

  it('onaylı dükkânda bir kez, sabit metin ve sahibin verdiği adla; hata ve güncel arasında gidip gelmek yeniden göndermez', async () => {
    const key = 'q'.repeat(40);
    await register(key);
    const token = await adminToken();
    await activate(key, token);
    const abonelik = { endpoint: 'https://push.test/patron', keys: { p256dh: 'p', auth: 'a' } };
    expect((await call('POST', 'uzaktan/bildirim/abone', { body: JSON.stringify({ abonelik }), token })).status).toBe(200);
    for (const durum of ['hata', 'guncel', 'hata', 'guncel', 'geri-dondu']) {
      await beat(key, { guncelleme: { durum, mesaj: 'https://kotu.example/odeme' } });
    }
    expect(pushed).toHaveLength(1);
    expect(pushed[0]!.title).toBe('Güncelleme sorunu · Marina');
    expect(JSON.stringify(pushed)).not.toContain('kotu.example');
  });

  it("`__proto__` durumu saklanmaz; eski kayıttaki de panelde metin olarak görünür", async () => {
    const key = 'r'.repeat(40);
    await register(key);
    await beat(key, { guncelleme: { durum: '__proto__', mesaj: 'x' } });
    const token = await adminToken();
    const list = (await (await call('GET', 'merkez/kurulumlar', { token })).json()) as { kurulumlar: { guncelleme: { durum: string; etiket: unknown } }[] };
    expect(list.kurulumlar[0]!.guncelleme.durum).toBe('bilinmiyor');
    expect(typeof list.kurulumlar[0]!.guncelleme.etiket).toBe('string');
    // Redis'te düzeltmeden önce yazılmış kayıt
    const { installView } = await merkezApi();
    const legacy = { id: 'a'.repeat(24), key: '', ad: null, createdAt: 0, lastSeen: null, surum: null, build: null, gunAcik: null, lisans: { durum: 'bekliyor' as const }, mod: 'elle' as const, hedef: null, gonderildi: null, guncelleme: { durum: '__proto__', mesaj: 'x', yeni: null } };
    const view = installView(legacy, null, Date.now());
    expect(typeof view.guncelleme!.etiket).toBe('string');
    expect(JSON.stringify(view)).toContain('"etiket":"__proto__"');
  });

  it('panel kurulumları parça parça okur (100 kimlikte bir)', async () => {
    const token = await adminToken();
    for (let i = 0; i < 230; i++) {
      const id = `x${String(i).padStart(23, '0')}`;
      store.set(`lafpos:merkez:kurulum:${id}`, JSON.stringify({ id, key: 'k', ad: null, createdAt: 0, lastSeen: null, surum: null, build: null, guncelleme: null, gunAcik: null, lisans: { durum: 'bekliyor' }, mod: 'elle', hedef: null, gonderildi: null }));
      (sets.get('lafpos:merkez:kurulumlar') ?? sets.set('lafpos:merkez:kurulumlar', new Set()).get('lafpos:merkez:kurulumlar')!).add(id);
    }
    const res = await call('GET', 'merkez/kurulumlar', { token });
    expect(((await res.json()) as { kurulumlar: unknown[] }).kurulumlar).toHaveLength(230);
  });

  it('nabız sürerken panelden verilen lisans ve hedef ezilmez', async () => {
    const { merkez, installIdFor } = await merkezApi();
    const key = 't'.repeat(40);
    const id = installIdFor(key);
    await register(key);
    const redis = async (...cmd: (string | number)[]) => redisCmd(String(cmd[0]), String(cmd[1]), cmd.slice(2).map(String));
    let releaseGate!: () => void;
    const gate = new Promise<void>((r) => (releaseGate = r));
    const deps = (slow: boolean) => ({
      redis,
      verify: () => true,
      signedShared: () => true,
      admin: async () => true,
      demo: false,
      fetchRelease: async () => {
        if (slow) await gate;
        return { version: '0.3.0', build: 2000, date: '', not: null };
      },
    });
    const req = (path: string, body: unknown, headers: Record<string, string> = {}) => new Request(`${ORIGIN}/api/${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
    const beating = merkez(req('merkez/nabiz', { surum: '0.2.1' }, { 'x-laf-kurulum': id }), new URL(`${ORIGIN}/api/merkez/nabiz`), 'merkez/nabiz', deps(true));
    await new Promise((r) => setTimeout(r, 10));
    expect((await merkez(req('merkez/kurulum', { id, lisans: 'aktif' }), new URL(`${ORIGIN}/api/merkez/kurulum`), 'merkez/kurulum', deps(false))).status).toBe(200);
    expect((await merkez(req('merkez/gonder', { ids: [id] }), new URL(`${ORIGIN}/api/merkez/gonder`), 'merkez/gonder', deps(false))).status).toBe(200);
    releaseGate();
    const res = (await (await beating).json()) as { lisans: { durum: string }; hedef: number };
    expect(res.lisans.durum).toBe('aktif');
    expect(res.hedef).toBe(2000);
    const saved = JSON.parse(store.get(`lafpos:merkez:kurulum:${id}`)!) as { lisans: { durum: string }; hedef: number };
    expect(saved).toMatchObject({ lisans: { durum: 'aktif' }, hedef: 2000 });
    // Nabzın kendi alanı da yerinde
    expect(JSON.parse(store.get(`lafpos:merkez:durum:${id}`)!)).toMatchObject({ surum: '0.2.1' });
  });

  it('elle dükkânda gönderilen hedef kurulu derlemeden yeniyse "gönderilmedi" görünmez', async () => {
    const { installView } = await merkezApi();
    const base = { id: 'a'.repeat(24), key: '', ad: null, createdAt: 0, lastSeen: null, surum: null, build: 1000, gunAcik: null, lisans: { durum: 'aktif' as const }, mod: 'elle' as const, hedef: null, gonderildi: null, guncelleme: null };
    const rel = { version: '0.3.1', build: 3000, date: '', not: null };
    expect(installView(base, rel, 0).bekleyen).toBe(true);
    // 2000 gönderildi, kanal 3000'e geçti: kasa gün kapanınca kanaldakini kuracak
    expect(installView({ ...base, hedef: 2000 }, rel, 0).bekleyen).toBe(false);
    // Gönderilen kuruldu (kasa 2000'de), kanal 3000: yeniden gönderilmeli
    expect(installView({ ...base, build: 2000, hedef: 2000 }, rel, 0).bekleyen).toBe(true);
  });
});

describe('Uzaktan oturumları', () => {
  it('parolasız görünümün jetonu parola zorunlu olunca geçersiz (Merkez ve özet 401)', async () => {
    const open = ((await (await call('POST', 'uzaktan/giris', { body: '{}' })).json()) as { token: string }).token;
    expect(open).toBeTruthy();
    process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI = '1';
    expect((await call('GET', 'merkez/kurulumlar', { token: open })).status).toBe(401);
    expect((await call('GET', 'bootstrap', { token: open })).status).toBe(401);
    expect((await call('POST', 'merkez/kurulum', { body: JSON.stringify({ id: 'a'.repeat(24), lisans: 'aktif' }), token: open })).status).toBe(401);
    // Parolalı giriş çalışır; parola kalkınca o jeton da düşer
    const real = await adminToken();
    expect((await call('GET', 'merkez/kurulumlar', { token: real })).status).toBe(200);
    delete process.env.LAFPOS_UZAKTAN_PAROLA_GEREKLI;
    expect((await call('GET', 'merkez/kurulumlar', { token: real })).status).toBe(401);
  });

  it('parolasız görünümde Merkez ve bildirim aboneliği 403 der (oturum düşürülmez)', async () => {
    store.set('lafpos:dukkanlar', JSON.stringify({ marina: Date.now() }));
    const open = ((await (await call('POST', 'uzaktan/giris', { body: '{}' })).json()) as { token: string }).token;
    const list = await call('GET', 'merkez/kurulumlar', { token: open });
    expect(list.status).toBe(403);
    expect(((await list.json()) as { code: string }).code).toBe('remote_admin');
    expect((await call('POST', 'uzaktan/bildirim/abone', { body: '{}', token: open })).status).toBe(403);
    // Jetonsuz istek 401 kalır
    expect((await call('GET', 'merkez/kurulumlar', { token: 'yok' })).status).toBe(401);
  });
});

describe('son denetim: gönderilen güncelleme geçişte kaybolmaz', () => {
  const rel = (build: number) => ({ version: '0.3.0', build, date: '', not: null });
  const base = { id: 'b'.repeat(24), key: '', ad: 'Marina', createdAt: 0, lastSeen: null, surum: null, gunAcik: null, lisans: { durum: 'aktif' as const }, gonderildi: null, guncelleme: null };

  it('eski kasa (kesinHedef yok): gönderilen derleme kanaldan düştüyse hedef kanalın son derlemesi', async () => {
    const { targetFor, installView } = await merkezApi();
    expect(targetFor({ mod: 'elle', hedef: 85, build: 63 }, rel(86))).toBe(86);
    expect(installView({ ...base, mod: 'elle', hedef: 85, build: 63 }, rel(86), Date.now()).bekleyen).toBe(false);
    // Kurulu derlemeden yeni gönderim yoksa hedef değişmez (gönderilmemiş sürüm kurulmaz)
    expect(targetFor({ mod: 'elle', hedef: 63, build: 63 }, rel(86))).toBe(63);
    expect(targetFor({ mod: 'elle', hedef: null, build: 63 }, rel(86))).toBe(null);
    expect(targetFor({ mod: 'elle', hedef: 85, build: 63 }, null)).toBe(85);
  });

  it('yeni kasa (kesinHedef): yalnız gönderilen derleme; kanal ilerlediyse panel "gönderilmedi" gösterir', async () => {
    const { targetFor, installView } = await merkezApi();
    expect(targetFor({ mod: 'elle', hedef: 85, build: 63, kesinHedef: true }, rel(86))).toBe(85);
    expect(installView({ ...base, mod: 'elle', hedef: 85, build: 63, kesinHedef: true }, rel(86), Date.now()).bekleyen).toBe(true);
    expect(installView({ ...base, mod: 'elle', hedef: 86, build: 63, kesinHedef: true }, rel(86), Date.now()).bekleyen).toBe(false);
    expect(installView({ ...base, mod: 'otomatik', hedef: null, build: 63, kesinHedef: true }, rel(86), Date.now()).bekleyen).toBe(false);
  });
});

describe('#71 dönemindeki kasa (rastgele kimlik, tek anahtardaki kayıt, eski nabız gövdesi)', () => {
  // Eski kasa: kimlik anahtarın özeti değil, kayıt imzasız açılmış; nabızda `kesinHedef` ve `istekAlindi` yok
  const ID = '0123456789abcdef01234567';
  const KEY = 'k'.repeat(43);
  const seed = (extra: object) => {
    store.set(
      `lafpos:merkez:kurulum:${ID}`,
      JSON.stringify({ id: ID, key: KEY, ad: 'Marina', kod: 'MRN', createdAt: 1, lastSeen: 2, surum: '0.2.0', build: 1000, gunAcik: true, lisans: { durum: 'aktif' }, mod: 'elle', hedef: null, gonderildi: null, guncelleme: null, ...extra }),
    );
    sets.set('lafpos:merkez:kurulumlar', new Set([ID]));
  };
  const oldBeat = (key = KEY) => {
    const body = JSON.stringify({ surum: '0.2.0', build: 1000, gunAcik: true, guncelleme: { durum: 'bekliyor', mesaj: 'Yeni sürüm hazır; gün sonundan sonra kendiliğinden kurulacak', yeni: { surum: '0.2.0', build: 1500 } } });
    return call('POST', 'merkez/nabiz', { body, headers: { 'x-laf-kurulum': ID, ...signedHeaders(key, 'POST', new URL(`${ORIGIN}/api/merkez/nabiz`), body) } });
  };

  it('nabız 200 döner, lisans ve şube aynen; gönderilen derleme kanaldan düştüyse hedef kanalın son derlemesi', async () => {
    // Sahip 1500'ü gönderdi, kanal 2000'e ilerledi: eski kasa hedefi üst sınır sayar, 2000'i kurabilmeli
    seed({ hedef: 1500, gonderildi: 5 });
    const res = await oldBeat();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, ad: 'Marina', kod: 'MRN', lisans: { durum: 'aktif' }, mod: 'elle', hedef: 2000 });
    // Panelin kaydı yerinde; nabzın alanları ayrı anahtarda ve eski kasa `kesinHedef` taşımıyor
    expect(JSON.parse(store.get(`lafpos:merkez:kurulum:${ID}`)!)).toMatchObject({ key: KEY, hedef: 1500, lisans: { durum: 'aktif' } });
    expect(JSON.parse(store.get(`lafpos:merkez:durum:${ID}`)!)).toMatchObject({ build: 1000, gunAcik: true, kesinHedef: false, guncelleme: { durum: 'bekliyor', yeni: { build: 1500 } } });
    // Sonraki nabızlar da aynı yanıtı alır (ayrı anahtardan birleşen kayıtla)
    expect(await (await oldBeat()).json()).toMatchObject({ ok: true, hedef: 2000 });
  });

  it('kanalın son derlemesi gönderildiyse hedef o; hiç gönderilmediyse kurulu kalır; yanlış anahtar 401', async () => {
    seed({ hedef: 2000, gonderildi: 5 });
    expect(await (await oldBeat()).json()).toMatchObject({ ok: true, hedef: 2000 });
    seed({ hedef: null });
    store.delete(`lafpos:merkez:durum:${ID}`);
    expect(await (await oldBeat()).json()).toMatchObject({ ok: true, hedef: null });
    expect((await oldBeat('y'.repeat(43))).status).toBe(401);
  });

  it('panelde çevrimiçi ve "Gün kapanınca kurulacak" görünür', async () => {
    seed({ hedef: 1500, gonderildi: 5 });
    await oldBeat();
    const list = (await (await call('GET', 'merkez/kurulumlar', { token: await adminToken() })).json()) as { kurulumlar: { id: string; online: boolean; guncelleme: { etiket: string } | null; bekleyen: boolean }[] };
    expect(list.kurulumlar).toHaveLength(1);
    expect(list.kurulumlar[0]).toMatchObject({ id: ID, online: true, bekleyen: false, guncelleme: { etiket: 'Gün kapanınca kurulacak' } });
  });
});

describe('Şimdi güncelle: en güncel sürüm kuruluysa yeniden gönderilmez (sahibin isteği, 23 Kas 2026)', () => {
  it('kurulu derleme kanalın sonuysa istek ve hedef yazılmaz; eskiyse istenir; gönder de aynı kuralla', async () => {
    const { merkez, installIdFor, updateAskFor } = await merkezApi();
    const rel = { version: '0.3.0', build: 2000, date: '', not: null };
    expect(updateAskFor({ build: 2000 }, rel)).toBe('guncel');
    expect(updateAskFor({ build: 2001 }, rel)).toBe('guncel');
    expect(updateAskFor({ build: 1999 }, rel)).toBe('istendi');
    // Kanal okunamadı ya da kurulu derleme bilinmiyor: karar verilemez, istenir (kasa kendisi denetler)
    expect(updateAskFor({ build: 2000 }, null)).toBe('istendi');
    expect(updateAskFor({ build: null }, rel)).toBe('istendi');

    const key = 'g'.repeat(40);
    const id = installIdFor(key);
    await register(key);
    const redis = async (...cmd: (string | number)[]) => redisCmd(String(cmd[0]), String(cmd[1]), cmd.slice(2).map(String));
    const deps = { redis, verify: () => true, signedShared: () => true, admin: async () => true, demo: false, fetchRelease: async () => rel };
    const post = async (path: string) => (await merkez(new Request(`${ORIGIN}/api/${path}`, { method: 'POST', body: JSON.stringify({ ids: [id] }) }), new URL(`${ORIGIN}/api/${path}`), path, deps)).json();
    const saved = () => JSON.parse(store.get(`lafpos:merkez:kurulum:${id}`)!) as { guncelleIstek?: number | null; hedef: number | null; gonderildi: number | null };

    // Kayıtta derleme 1000: eski, istenir
    expect(await post('merkez/simdi-guncelle')).toMatchObject({ ok: true, istenen: 1, guncel: 0, surum: '0.3.0' });
    expect(saved()).toMatchObject({ hedef: 2000 });

    // Kasa en güncel derlemeyi kurdu (nabız): ne istek ne hedef yeniden yazılır, yanıt "güncel" der
    store.set(`lafpos:merkez:durum:${id}`, JSON.stringify({ build: 2000, surum: '0.3.0' }));
    const before = saved();
    store.set(`lafpos:merkez:kurulum:${id}`, JSON.stringify({ ...before, guncelleIstek: null, gonderildi: 1 }));
    expect(await post('merkez/simdi-guncelle')).toMatchObject({ ok: true, istenen: 0, guncel: 1, build: 2000, surum: '0.3.0' });
    expect(saved()).toMatchObject({ guncelleIstek: null, gonderildi: 1 });
    expect(await post('merkez/gonder')).toMatchObject({ ok: true, gonderilen: 0, guncel: 1 });
    expect(saved()).toMatchObject({ gonderildi: 1 });

    // Uzaktan yönetimin "Gün sonu al ve güncelle"si de aynı yoldan: güncel kasaya istek yazılmaz
    const { requestUpdateNow } = await merkezApi();
    expect(await requestUpdateNow(redis, id, 5, rel, 'komut-1')).toBe('guncel');
    expect(saved()).toMatchObject({ guncelleIstek: null });
    expect(await requestUpdateNow(redis, 'z'.repeat(24), 5, rel)).toBeNull();
  });
});
