import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * Üye girişinin yanıt süresi e-postanın kayıtlı olup olmadığını söylemez: kayıtlı üye, listede olup açılmamış ve
 * listede olmayan e-postada aynı sayıda parola özeti (scrypt) hesaplanır ve aynı sayıda Redis okuması yapılır.
 */
const scrypt = vi.hoisted(() => ({ calls: 0 }));
vi.mock('node:crypto', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:crypto')>();
  return {
    ...real,
    scryptSync: (...args: Parameters<typeof real.scryptSync>) => {
      scrypt.calls++;
      return real.scryptSync(...args);
    },
  };
});

const SECRET = 's'.repeat(40);
const OWNER = 'patron@ornek.test';
const OTHER = 'ortak@ornek.test';
const PASSWORD = 'sure-parola-2026';
const INVITE = 'SURE-1234-ABCD';
const store = new Map<string, string>();
let gets = 0;
const KEYS = ['ASILPOS_CLOUD_SECRET', 'ASILPOS_UYE_EPOSTA', 'ASILPOS_UYE_DAVET', 'KV_REST_API_URL', 'KV_REST_API_TOKEN', 'ASILPOS_UZAKTAN_DEMO'];
const before: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const k of KEYS) before[k] = process.env[k];
  Object.assign(process.env, { ASILPOS_CLOUD_SECRET: SECRET, ASILPOS_UYE_EPOSTA: `${OWNER},${OTHER}`, ASILPOS_UYE_DAVET: INVITE, KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't', ASILPOS_UZAKTAN_DEMO: '0' });
  vi.stubGlobal('fetch', async (_input: unknown, init?: RequestInit) => {
    const [cmd, key, ...rest] = JSON.parse(String(init!.body)) as string[];
    let result: unknown = null;
    if (cmd === 'GET') (gets++, (result = store.get(key!) ?? null));
    if (cmd === 'SET') result = rest.includes('NX') && store.has(key!) ? null : (store.set(key!, rest[0]!), 'OK');
    if (cmd === 'INCR') (store.set(key!, String(Number(store.get(key!) ?? 0) + 1)), (result = Number(store.get(key!))));
    if (cmd === 'DEL') (store.delete(key!), (result = 1));
    return new Response(JSON.stringify({ result }));
  });
});
afterAll(() => {
  vi.unstubAllGlobals();
  for (const k of KEYS) before[k] === undefined ? delete process.env[k] : (process.env[k] = before[k]);
});

async function login(email: string, ip: string) {
  const { POST } = await import('../api/uzaktan');
  scrypt.calls = 0;
  gets = 0;
  const res = await POST(new Request(`https://sure.test/api/uzaktan?yol=uzaktan/giris`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify({ eposta: email, parola: 'yanlis-parola-1' }) }));
  return { status: res.status, scrypt: scrypt.calls, gets };
}

describe('üye girişinin süresi', () => {
  it('kayıtlı, açılmamış ve listede olmayan e-postada aynı iş yapılır', async () => {
    const { POST } = await import('../api/uzaktan');
    const made = await POST(new Request('https://sure.test/api/uzaktan?yol=uzaktan/uye', { method: 'POST', headers: { 'x-forwarded-for': '1.0.0.1' }, body: JSON.stringify({ eposta: OWNER, parola: PASSWORD, davet: INVITE }) }));
    expect(made.status).toBe(200);
    // İlk sahte özet bir kez hesaplanır (ısınma)
    await login('isinma@ornek.test', '1.0.0.2');
    const member = await login(OWNER, '1.0.0.3');
    const notOpened = await login(OTHER, '1.0.0.4');
    const stranger = await login('yabanci@ornek.test', '1.0.0.5');
    for (const r of [member, notOpened, stranger]) expect(r.status).toBe(401);
    expect(member.scrypt).toBe(1);
    expect(notOpened.scrypt).toBe(member.scrypt);
    expect(stranger.scrypt).toBe(member.scrypt);
    expect(notOpened.gets).toBe(member.gets);
    expect(stranger.gets).toBe(member.gets);
  });
});
