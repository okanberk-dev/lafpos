import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { environmentManager, QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { remoteAutoEnters, type RemoteSetup, remoteSignOutFor } from '../src/lib/remote';
import { upstashFetch } from './fake-upstash';

/**
 * Tasarım geçişinin incelemesi (4 Kas 2026): giriş ve kilit ekranı, uygulama kabuğu, komut paleti, uzaktan giriş.
 * Uzaktan "Çıkış" kuralı gerçek uçla (api/uzaktan.ts, bellekte sahte Redis), ekranların kuralı kaynaktan denetlenir.
 */
const src = (file: string) => readFileSync(join(__dirname, '../src', file), 'utf8');

describe('uzaktan görünüm: "Çıkış" yalnız parola soran girişte', () => {
  const store = new Map<string, string>();
  const ENV = ['LAFPOS_CLOUD_SECRET', 'LAFPOS_UZAKTAN_PAROLA', 'LAFPOS_UZAKTAN_PAROLA_GEREKLI', 'LAFPOS_UZAKTAN_DEMO', 'KV_REST_API_URL', 'KV_REST_API_TOKEN'];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const set = (k: string, v: string | null) => (v == null ? delete process.env[k] : (process.env[k] = v));

  beforeAll(() => {
    Object.assign(process.env, { LAFPOS_CLOUD_SECRET: 'u'.repeat(40), LAFPOS_UZAKTAN_PAROLA: 'kahve-parola-123', KV_REST_API_URL: 'https://redis.test', KV_REST_API_TOKEN: 't' });
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== 'https://redis.test') throw new Error(`beklenmeyen istek: ${String(input)}`);
      return upstashFetch(store)(init);
    });
  });
  afterAll(() => {
    vi.unstubAllGlobals();
    for (const k of ENV) set(k, saved[k] ?? null);
  });

  const req = (path: string, init: RequestInit = {}) => new Request(`https://lafpos.vercel.app/api/uzaktan?yol=${path}`, init);

  it.each([
    ['parolasız görünüm, kafe bağlı (varsayılan)', { password: false, cafe: true, demo: true }, true],
    ['parolalı görünüm, kafe bağlı', { password: true, cafe: true, demo: true }, false],
    ['kafe bağlanmadı: örnek gün', { password: true, cafe: false, demo: true }, true],
    ['demo kapalı, kafe bağlanmadı, parolasız (açılış hatası "Kafeden henüz veri gelmedi")', { password: false, cafe: false, demo: false }, true],
    ['demo kapalı, kafe bağlanmadı, parolalı', { password: true, cafe: false, demo: false }, false],
  ])('%s', async (_, c, auto) => {
    const { GET, POST } = await import('../api/uzaktan');
    set('LAFPOS_UZAKTAN_PAROLA_GEREKLI', c.password ? '1' : null);
    set('LAFPOS_UZAKTAN_DEMO', c.demo ? null : '0');
    if (c.cafe) store.set('lafpos:snapshot', JSON.stringify({ v: 1, at: Date.now(), bootstrap: {}, patron: {}, floor: {}, kitchen: [], board: {}, orders: {} }));
    else store.delete('lafpos:snapshot');
    const setup = (await (await GET(req('uzaktan/kurulum'))).json()) as RemoteSetup;
    // Giriş ekranının kendi kendine girdiği her kurulumda boş gövdeli giriş gerçekten oturum açar: çıkış aynı oturumu
    // yeniden açardı, kabuk "Çıkış"ı göstermez. Parola soran kurulumda boş giriş reddedilir, "Çıkış" anlamlıdır
    expect(remoteAutoEnters(setup)).toBe(auto);
    expect(remoteSignOutFor({ data: setup, isError: false })).toBe(!auto);
    expect((await POST(req('uzaktan/giris', { method: 'POST', body: '{}' }))).status === 200).toBe(auto);
  });

  it('kurulum eksikse giriş ekranı kendi girmez (kontrol listesi), "Çıkış" görünür', () => {
    const base: RemoteSetup = { secret: true, password: true, redis: true, snapshotAt: 1, open: true };
    expect(remoteAutoEnters(base)).toBe(true);
    expect(remoteAutoEnters({ ...base, secret: false })).toBe(false);
    expect(remoteAutoEnters({ ...base, redis: false })).toBe(false);
    expect(remoteAutoEnters({ ...base, open: false })).toBe(false);
    expect(remoteAutoEnters({ ...base, open: false, demo: true })).toBe(true);
  });

  it('"Çıkış" kurulum sorulurken gizli (gelip gitmez), okunamazsa görünür, okununca parola soran girişte görünür', () => {
    const open: RemoteSetup = { secret: true, password: true, redis: true, snapshotAt: 1, open: true };
    expect(remoteSignOutFor({ isError: false })).toBe(false);
    expect(remoteSignOutFor({ isError: true })).toBe(true);
    expect(remoteSignOutFor({ data: open, isError: false })).toBe(false);
    expect(remoteSignOutFor({ data: { ...open, open: false }, isError: false })).toBe(true);
    expect(remoteSignOutFor({ data: { ...open, open: false, snapshotAt: null, demo: true }, isError: false })).toBe(false);
  });

  it('kabuk, komut paleti ve açılış hatası kararı kurulumdan alır; sekmeye yazılan işaret yok (kaynak)', () => {
    expect(src('components/AppShell.tsx')).toMatch(/const remoteSignOut = useRemoteSignOut\(\);/);
    expect(src('components/CommandPalette.tsx')).toMatch(/if \(!REMOTE \|\| remoteSignOut\) \{/);
    expect(src('App.tsx')).toMatch(/action=\{\s*remoteSignOut && \(\s*<Button size="md" variant="ghost" onClick=\{\(\) => void useAuth\.getState\(\)\.logout\(\)\}>/);
    expect(src('pages/RemoteLoginPage.tsx')).toMatch(/const auto = !!setup\.data && remoteAutoEnters\(setup\.data\);/);
    const walk = (dir: string): string[] =>
      readdirSync(join(__dirname, '../src', dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
    expect(walk('.').filter((f) => /uzaktan\.acik|remoteOpenSession/.test(src(f)))).toEqual([]);
  });
});

describe('giriş ve kilit ekranı', () => {
  const page = src('pages/LoginPage.tsx');

  it('örnek PIN çipi gönderirken odağı bırakır: hatalı girişten sonra klavyenin Enter’ı çipin PIN’ini yeniden göndermez (kaynak)', () => {
    const chips = page.slice(page.indexOf('info.data.demoPins.map'));
    expect(chips).toMatch(/onClick=\{\(e\) => \{[^}]*e\.currentTarget\.blur\(\);\s*void submit\(d\.pin\);\s*\}\}/);
    expect(chips).not.toMatch(/onClick=\{\(\) => void submit\(d\.pin\)\}/);
  });

  it('"Kasa sunucusuna ulaşılamıyor" hata sürerken yeniden sorar (kaynak)', () => {
    expect(page).toMatch(/queryKey: \['login-info'\],[\s\S]{0,500}refetchInterval: \(q\) => \(q\.state\.status === 'error' \? 5000 : false\),/);
  });

  it('kilit ekranında yalnız oturum açılır: giriş türü seçimi ve mesai yok (kaynak)', () => {
    expect(page).not.toMatch(/Segmented|mesai|\/time\//i);
  });

  it('aynı seçenekle sorgu sunucu dönünce hatadan çıkar, yanıt gelince sormayı bırakır', async () => {
    vi.useFakeTimers();
    // Node'da TanStack sunucu kipinde zamanlayıcı kurmaz: tarayıcı gibi davransın
    const wasServer = environmentManager.isServer();
    environmentManager.setIsServer(() => false);
    const client = new QueryClient();
    try {
      let up = false;
      let calls = 0;
      const observer = new QueryObserver(client, {
        queryKey: ['login-info'],
        queryFn: async () => {
          calls++;
          if (!up) throw new Error('Sunucuya ulaşılamadı');
          return { users: [] };
        },
        retry: 2,
        refetchInterval: (q) => (q.state.status === 'error' ? 5000 : false),
      });
      const off = observer.subscribe(() => undefined);
      // İlk deneme ve iki yeniden deneme (1 sn, 2 sn) düşer: uyarı görünür
      await vi.advanceTimersByTimeAsync(4000);
      expect(observer.getCurrentResult().isError).toBe(true);
      expect(calls).toBe(3);
      // Hata sürerken sormaya devam eder
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toBeGreaterThan(3);
      // Sunucu döndü: odak ya da dokunuş olmadan uyarı kalkar
      up = true;
      await vi.advanceTimersByTimeAsync(9000);
      expect(observer.getCurrentResult().status).toBe('success');
      const settled = calls;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(calls).toBe(settled);
      off();
    } finally {
      client.clear();
      environmentManager.setIsServer(() => wasServer);
      vi.useRealTimers();
    }
  });
});

describe('uygulama kabuğu', () => {
  it('alt sekme çubuğu çizilmeyen telefonda (tek ekranlı rol) ev çubuğu payını ana alan bırakır (kaynak)', () => {
    const shell = src('components/AppShell.tsx');
    expect(shell).toMatch(/const showTabs = tabs\.length > 1 \|\| meTab;/);
    // Kapanış hatırlatması varken payı kart bırakır (iki kez değil)
    expect(shell).toMatch(/!showTabs && 'max-md:pb-\[env\(safe-area-inset-bottom\)\] max-md:\[html:has\(\[data-closing-reminder\]\)_&\]:pb-0'/);
    // Çubuk çizilince payı çubuğun kendisi alır (ikisi birden değil)
    // Alt menü yüzen dok (22 Kas 2026): ev çubuğu payı dokun alt boşluğunda
    expect(shell).toMatch(/\{showTabs && \(\s*<nav\s+aria-label="Ekranlar"\s+className="[^"]*mb-\[max\(0\.5rem,env\(safe-area-inset-bottom\)\)\]/);
  });
});
