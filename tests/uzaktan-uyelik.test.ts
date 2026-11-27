import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { upstashFetch } from './fake-upstash';
import { REDIS_ONEKI, VERCEL_ALANI } from '@shared/eski-adlar';

/**
 * AsilPOS Uzaktan üyeliği (api/uzaktan.ts): ASILPOS_UYE_EPOSTA tanımlıyken "Üye girişi" e-posta ve parolayla çalışır.
 * Üye parolasını ilk girişte kendisi belirler; ortamda ve Redis'te açık parola durmaz.
 */
const SECRET = 'u'.repeat(40);
const EMAIL = 'uye@ornek.test';
const PASSWORD = 'ornek-parola-2026';
const INVITE = 'LAF7-K3PQ-92XD';
const store = new Map<string, string>();
const KEYS = ['ASILPOS_CLOUD_SECRET', 'ASILPOS_UYE_EPOSTA', 'ASILPOS_UYE_DAVET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ASILPOS_UZAKTAN_DEMO', 'ASILPOS_UZAKTAN_PAROLA', 'ASILPOS_UZAKTAN_PAROLA_GEREKLI'];
const before: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) before[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, ASILPOS_UYE_EPOSTA: ` ${EMAIL.toUpperCase()} `, ASILPOS_UYE_DAVET: INVITE, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0' });
  const redis = upstashFetch(store);
  vi.stubGlobal('fetch', async (_input: string | URL | Request, init?: RequestInit) => redis(init));
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
});
beforeEach(() => {
  for (const k of [...store.keys()]) if (k.startsWith(`${REDIS_ONEKI}giris:`)) store.delete(k);
});

const api = () => import('../api/uzaktan');
const req = (path: string, init: RequestInit = {}) => new Request(`https://${VERCEL_ALANI}/api/uzaktan?yol=${path}`, init);
const post = async (path: string, body: unknown, ip = '9.9.9.9') => (await api()).POST(req(path, { method: 'POST', body: JSON.stringify(body), headers: { 'x-forwarded-for': ip } }));
const setup = async () => (await (await api()).GET(req('uzaktan/kurulum'))).json() as Promise<Record<string, unknown>>;
const get = async (path: string, token: string) => (await api()).GET(req(path, { headers: { authorization: `Bearer ${token}` } }));

describe('AsilPOS Uzaktan üyeliği', () => {
  it('üyelik açıkken giriş parolasız açılmaz; kurulum "new" der ve hiçbir değer dönmez', async () => {
    const s = await setup();
    expect(s).toMatchObject({ member: 'new', open: false, password: true, secret: true, redis: true });
    expect(JSON.stringify(s)).not.toContain('ornek.test');
    expect((await post('uzaktan/giris', {})).status).toBe(400);
    expect((await get('bootstrap', 'yok')).status).toBe(401);
  });

  it('üyelik yalnız izinli e-posta ve davet koduyla, en az 10 karakter parolayla ve bir kez açılır', async () => {
    // E-postayı bilen ama kodu bilmeyen açamaz; yanlış e-posta ve yanlış kod aynı yanıtı alır
    const noCode = await post('uzaktan/uye', { eposta: EMAIL, parola: PASSWORD });
    const wrongCode = await post('uzaktan/uye', { eposta: EMAIL, parola: PASSWORD, davet: 'LAF7-K3PQ-0000' });
    const wrongEmail = await post('uzaktan/uye', { eposta: 'baskasi@ornek.test', parola: PASSWORD, davet: INVITE });
    expect([noCode.status, wrongCode.status, wrongEmail.status]).toEqual([403, 403, 403]);
    expect(await wrongCode.json()).toEqual(await wrongEmail.json());
    expect((await post('uzaktan/uye', { eposta: EMAIL, parola: 'kisa', davet: INVITE })).status).toBe(400);
    expect(store.has(`${REDIS_ONEKI}uye:${EMAIL}`)).toBe(false);

    // Kod büyük-küçük harf, boşluk ve tireden bağımsız
    const made = await post('uzaktan/uye', { eposta: EMAIL.toUpperCase(), parola: PASSWORD, davet: ' laf7 k3pq92xd ' });
    expect(made.status).toBe(200);
    const { token } = (await made.json()) as { token: string };
    // Redis'te parola değil özeti durur
    const saved = store.get(`${REDIS_ONEKI}uye:${EMAIL}`)!;
    expect(saved).not.toContain(PASSWORD);
    expect(JSON.parse(saved).h).toMatch(/^s1\$/);
    expect((await setup()).member).toBe('ready');

    // İkinci kez açılamaz: başkası üyeliğin parolasını değiştiremez
    const again = await post('uzaktan/uye', { eposta: EMAIL, parola: 'baska-bir-parola-1', davet: INVITE });
    expect(again.status).toBe(409);
    expect(store.get(`${REDIS_ONEKI}uye:${EMAIL}`)).toBe(saved);

    // Kafe bağlanmadı: oturum geçerli, özet yok (İndir sayfası bu durumda açılır); yazma uçları kapalı
    expect((await get('auth/me', token)).status).toBe(200);
    expect(((await (await get('bootstrap', token)).json()) as { code: string }).code).toBe('no_snapshot');
    expect((await (await api()).POST(req('orders', { method: 'POST', body: '{}', headers: { authorization: `Bearer ${token}` } }))).status).toBe(403);
  });

  it('giriş: yanlış parola ve bilinmeyen e-posta aynı yanıtı alır; doğru ikili 30 günlük oturum açar', async () => {
    const wrong = await post('uzaktan/giris', { eposta: EMAIL, parola: 'yanlis-parola-1' });
    const unknown = await post('uzaktan/giris', { eposta: 'yok@ornek.test', parola: PASSWORD });
    expect([wrong.status, unknown.status]).toEqual([401, 401]);
    expect(await wrong.json()).toEqual(await unknown.json());

    const ok = await post('uzaktan/giris', { eposta: EMAIL, parola: PASSWORD });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token: string };
    const { memberTokenValid, memberTokenEmail, tokenValid } = await api();
    const hash = JSON.parse(store.get(`${REDIS_ONEKI}uye:${EMAIL}`)!).h as string;
    expect(memberTokenEmail(token)).toBe(EMAIL);
    expect(memberTokenValid(SECRET, token, hash, Date.now() + 29 * 86400_000)).toBe(true);
    expect(memberTokenValid(SECRET, token, hash, Date.now() + 31 * 86400_000)).toBe(false);
    // Parola değişince (özet değişir) eski oturum düşer; başka anahtarla ve parolalı düzenin belirteciyle geçmez
    expect(memberTokenValid(SECRET, token, hash.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')))).toBe(false);
    expect(memberTokenValid('y'.repeat(40), token, hash)).toBe(false);
    expect(tokenValid(SECRET, token)).toBe(false);
    expect((await get('auth/me', token)).status).toBe(200);
  });

  it('davet kodu tanımlı değilse ya da kısaysa üyelik hiç açılmaz', async () => {
    for (const code of [undefined, 'KISA-1']) {
      if (code) process.env.ASILPOS_UYE_DAVET = code;
      else delete process.env.ASILPOS_UYE_DAVET;
      const res = await post('uzaktan/uye', { eposta: 'yeni@ornek.test', parola: PASSWORD, davet: code ?? '' });
      expect(res.status).toBe(503);
    }
    process.env.ASILPOS_UYE_DAVET = INVITE;
  });

  it('deneme sınırı: IP başına 15 dakikada 8', async () => {
    let last = 0;
    for (let i = 0; i < 9; i++) last = (await post('uzaktan/giris', { eposta: EMAIL, parola: 'yanlis-parola-1' }, '7.7.7.7')).status;
    expect(last).toBe(429);
    // Sınır dolunca doğru parola da girmez; başka IP etkilenmez
    expect((await post('uzaktan/giris', { eposta: EMAIL, parola: PASSWORD }, '7.7.7.7')).status).toBe(429);
    expect((await post('uzaktan/giris', { eposta: EMAIL, parola: PASSWORD }, '8.8.8.8')).status).toBe(200);
  });

  it('örnek gün üyeliksiz açık kalır ama üye oturumu demoya düşmez', async () => {
    delete process.env.ASILPOS_UZAKTAN_DEMO;
    try {
      const s = await setup();
      expect(s).toMatchObject({ member: 'ready', demo: true });
      const demo = await post('uzaktan/giris', {});
      expect(((await demo.json()) as { demo?: boolean }).demo).toBe(true);
      const { token } = (await (await post('uzaktan/giris', { eposta: EMAIL, parola: PASSWORD })).json()) as { token: string };
      expect(((await (await get('bootstrap', token)).json()) as { code: string }).code).toBe('no_snapshot');
    } finally {
      process.env.ASILPOS_UZAKTAN_DEMO = '0';
    }
  });

  it('giriş ekranı: üyelik açıkken kendiliğinden girmez, "Çıkış" görünür', async () => {
    const { remoteAutoEnters, remoteSignOutFor } = await import('../src/lib/remote');
    const base = { secret: true, password: true, redis: true, snapshotAt: 1, open: false };
    expect(remoteAutoEnters({ ...base, demo: true, member: 'new' })).toBe(false);
    expect(remoteAutoEnters({ ...base, member: 'ready' })).toBe(false);
    expect(remoteSignOutFor({ data: { ...base, demo: true, member: 'ready' }, isError: false })).toBe(true);
  });
});
