import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ROLE_DEFAULTS } from '@shared/permissions';
import type { OrderDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Denetim bulguları (26 Eki 2026), alan: PIN onayı, oturum, yetki sızıntısı, girdi doğrulama. Her bulgu bir testle:
 * yetkili onayı ve giriş PIN'i taraması (auth-51), oturumu kapanan kişiye akan canlı olaylar (auth-52), kasa
 * rakamlarıyla gelen personel tutarları (auth-54), PIN tekilliğinden PIN taraması (auth-56), boş düzenleme
 * (input-71) ve takvimde olmayan tarih ve saat (input-74).
 */
let h: Harness;
type App = { request: (path: string, init?: RequestInit, env?: unknown) => Response | Promise<Response> };
let app: App;
let auth: typeof import('../server/lib/auth');

beforeAll(async () => {
  h = await startApp();
  // Aynı modüller ve veritabanı üzerinde ikinci uygulama: istek başka bir bağlantı adresinden gelsin ve canlı akış okunsun
  app = (await import('../server/app')).createApp();
  auth = await import('../server/lib/auth');
  await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
});
afterAll(() => h.cleanup());

const product = (name: string) => h.boot.products.find((p) => p.name === name)!;
const method = (name: string) => h.boot.paymentMethods.find((m) => m.name === name)!;
const audit = (severity: 'alarm' | 'uyari') =>
  h.ok<{ action: string; message: string; userName: string | null }[]>('patron', 'GET', `/admin/audit?severity=${severity}&limit=500`);
const userId = async (name: string) => (await h.ok<{ id: string; name: string }[]>('patron', 'GET', '/admin/users')).find((u) => u.name === name)!.id;

/** İstek başka bir cihazdan (bağlantı adresinden) gelir */
async function callFrom<T = unknown>(addr: string, who: string, method: string, path: string, body?: unknown) {
  const res = await app.request(
    `/api${path}`,
    {
      method,
      headers: { 'content-type': 'application/json', ...(h.tokens[who] ? { authorization: `Bearer ${h.tokens[who]}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { incoming: { socket: { remoteAddress: addr } } },
  );
  const text = await res.text();
  return { status: res.status, json: (text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : text) as T };
}

/** Saat ileri sarılarak sınamalar (deneme sınırı Date.now ile çalışır) */
function fakeClock() {
  const t0 = Date.now();
  let offset = 0;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => t0 + offset);
  return {
    advance: (ms: number) => {
      offset += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

describe('auth-51: yetkili onayı ve giriş PIN taraması', () => {
  it('hatalı PIN ile yetkisi olmayan kişinin PIN\'i aynı yanıtı alır; yanıt PIN\'in sahibini söylemez', async () => {
    auth.resetFailures();
    try {
      // Ön kontrol ucu (/auth/approve): Kasa'nın PIN'i personel yönetimini onaylayamaz
      const wrong = await h.call<{ error: string; code: string }>('garson', 'POST', '/auth/approve', { pin: '9876', permission: 'personel.yonet' });
      const forbidden = await h.call<{ error: string; code: string }>('garson', 'POST', '/auth/approve', { pin: PINS.kasa, permission: 'personel.yonet' });
      expect(wrong.status).toBe(403);
      expect(forbidden).toEqual(wrong);
      expect(forbidden.json.error).not.toContain('Kasa');

      // İşlemin içindeki onay da (garsonun kasa hareketi; Bar ekranının yetkisi yok)
      const wrongInFlow = await h.call<{ error: string; code: string }>('garson', 'POST', '/cash/movements', { kind: 'giris', amount: 100, approverPin: '9876' });
      const forbiddenInFlow = await h.call<{ error: string; code: string }>('garson', 'POST', '/cash/movements', { kind: 'giris', amount: 100, approverPin: '3333' });
      expect(wrongInFlow.status).toBe(403);
      expect(forbiddenInFlow).toEqual(wrongInFlow);
      expect(forbiddenInFlow.json.error).not.toContain('Bar');

      // Yetkisi olan yetkili onaylar
      expect((await h.call<{ name: string }>('garson', 'POST', '/auth/approve', { pin: PINS.mudur, permission: 'kasa.hareket' })).json.name).toBe('Müdür');
    } finally {
      auth.resetFailures();
    }
  });

  it('kendi PIN\'ini araya sokan personel kilide takılır, saatte 12 denemeyi geçemez; denetim kaydına alarm düşer', async () => {
    auth.resetFailures();
    const clock = fakeClock();
    try {
      // Denetimdeki tarama: 4 yanlış PIN, bir kendi PIN'i (doğru PIN eskiden sayacı sıfırlıyordu)
      let wrong = 0;
      let limited = false;
      let sinceOwn = 0;
      const found: string[] = [];
      for (let n = 1000; n <= 1999 && !limited; n++) {
        const pin = String(n);
        if (pin === PINS.garson) continue;
        const r = await h.call<{ name?: string; code?: string }>('garson', 'POST', '/auth/approve', { pin, permission: 'siparis.al' });
        if (r.status === 429) limited = true;
        else if (r.status === 200) found.push(pin);
        else {
          wrong += 1;
          sinceOwn += 1;
        }
        if (sinceOwn === 4) {
          expect((await h.call('garson', 'POST', '/auth/approve', { pin: PINS.garson, permission: 'siparis.al' })).status).toBe(200);
          sinceOwn = 0;
        }
      }
      expect(limited, 'yetkili onayı kilidi devreye girmeli').toBe(true);
      expect(wrong).toBeLessThanOrEqual(10);
      expect(found).not.toContain(PINS.patron);

      // Kilitliyken doğru PIN de geçmez (yanıt PIN'e bağlı değil)
      const lockedRight = await h.call<{ code: string }>('garson', 'POST', '/auth/approve', { pin: PINS.mudur, permission: 'siparis.al' });
      expect(lockedRight.status).toBe(429);
      expect(lockedRight.json.code).toBe('rate_limited');

      // Bir saat boyunca her açılışta bir deneme ve araya kendi PIN'i: en çok saatte 12 hatalı deneme
      let hourWrong = 0;
      let next = 2000;
      for (let step = 0; step < 120; step++) {
        clock.advance(30_000);
        const r = await h.call('garson', 'POST', '/auth/approve', { pin: String(next), permission: 'siparis.al' });
        if (r.status === 429) continue;
        next += 1;
        if (r.status === 403) hourWrong += 1;
        await h.call('garson', 'POST', '/auth/approve', { pin: PINS.garson, permission: 'siparis.al' });
      }
      expect(hourWrong).toBeGreaterThan(0);
      expect(hourWrong).toBeLessThanOrEqual(12);

      const alarms = (await audit('alarm')).filter((a) => a.action === 'auth.pin_lock' && a.userName === 'Garson');
      expect(alarms.length).toBeGreaterThanOrEqual(1);
      // Alarm aynı kişi için saatte bir yazılır (panel dolmasın)
      expect(alarms.length).toBeLessThanOrEqual(2);
    } finally {
      clock.restore();
      auth.resetFailures();
    }
  });

  it('onay kilidi kişiye de bağlı: cihaz değiştirmek aşmaz, başka cihazdaki başka kişi etkilenmez', async () => {
    auth.resetFailures();
    try {
      for (let i = 0; i < 5; i++) {
        expect((await callFrom('10.0.0.21', 'garson', 'POST', '/auth/approve', { pin: String(4000 + i), permission: 'siparis.al' })).status).toBe(403);
      }
      expect((await callFrom('10.0.0.21', 'garson', 'POST', '/auth/approve', { pin: PINS.mudur, permission: 'siparis.al' })).status).toBe(429);
      // Aynı kişi başka cihazdan
      expect((await callFrom('10.0.0.22', 'garson', 'POST', '/auth/approve', { pin: PINS.mudur, permission: 'siparis.al' })).status).toBe(429);
      // Başka kişi başka cihazdan
      expect((await callFrom('10.0.0.22', 'kasa', 'POST', '/auth/approve', { pin: PINS.mudur, permission: 'siparis.al' })).status).toBe(200);
    } finally {
      auth.resetFailures();
    }
  });

  it('onaylayamayan kişinin PIN\'i hatalı PIN gibi sayılır: kilidin zamanı PIN\'in kimde olduğunu söylemez', async () => {
    auth.resetFailures();
    try {
      // 4 hatalı PIN, sonra Kasa'nın PIN'i (personel yönetimi yok): beşinci hata sayılır, kilit gelir
      for (let i = 0; i < 4; i++) expect((await h.call('garson', 'POST', '/auth/approve', { pin: String(4100 + i), permission: 'personel.yonet' })).status).toBe(403);
      expect((await h.call('garson', 'POST', '/auth/approve', { pin: PINS.kasa, permission: 'personel.yonet' })).status).toBe(403);
      expect((await h.call('garson', 'POST', '/auth/approve', { pin: PINS.patron, permission: 'personel.yonet' })).status).toBe(429);
    } finally {
      auth.resetFailures();
    }
  });

  it('işlemin içindeki onay da: yetkisi olmayanın PIN\'i sayılır, kilit alarmı geri alınan işlemle silinmez', async () => {
    auth.resetFailures();
    try {
      for (let i = 0; i < 4; i++) {
        expect((await h.call('garson', 'POST', '/cash/movements', { kind: 'giris', amount: 100, approverPin: String(4200 + i) })).status).toBe(403);
      }
      // Bar ekranının PIN'i geçerli ama kasa hareketi yetkisi yok: işlem geri alınır, hata sayılır
      expect((await h.call('garson', 'POST', '/cash/movements', { kind: 'giris', amount: 100, approverPin: '3333', description: 'onaysız' })).status).toBe(403);
      expect((await h.call('garson', 'POST', '/cash/movements', { kind: 'giris', amount: 100, approverPin: PINS.mudur })).status).toBe(429);
      const alarms = (await audit('alarm')).filter((a) => a.action === 'auth.pin_lock' && a.userName === 'Garson');
      expect(alarms.length).toBeGreaterThanOrEqual(1);
    } finally {
      auth.resetFailures();
    }
  });

  it('sınırı aşan indirimde yetkisi olmayanın PIN\'i adını vermez; yetkilinin sınırı söylenir', async () => {
    auth.resetFailures();
    try {
      await h.ok('patron', 'POST', '/admin/users', { name: 'İndirimci', role: 'garson', permGrant: ['siparis.indirim'], pin: '4747' });
      await h.login('indirimci', '4747');
      const o = await h.ok<OrderDTO>('indirimci', 'POST', '/orders', { type: 'tezgah' });
      const full = await h.ok<OrderDTO>('indirimci', 'POST', `/orders/${o.id}/items`, { items: [{ productId: product('Türk kahvesi').id, qty: 1 }] });
      const pct = { type: 'percent', value: 50, reason: 'deneme' };
      const wrong = await h.call<{ error: string; code: string }>('indirimci', 'POST', `/orders/${full.id}/discount`, { ...pct, approverPin: '9876' });
      const forbidden = await h.call<{ error: string; code: string }>('indirimci', 'POST', `/orders/${full.id}/discount`, { ...pct, approverPin: PINS.kasa });
      expect(wrong.status).toBe(403);
      expect(forbidden).toEqual(wrong);
      expect(forbidden.json.error).not.toContain('Kasa');
      // Yetkisi olan yetkili onaylar
      expect((await h.call('indirimci', 'POST', `/orders/${full.id}/discount`, { ...pct, approverPin: PINS.mudur })).status).toBe(200);
      await h.ok('indirimci', 'POST', `/orders/${full.id}/cancel`, { reason: 'deneme', approverPin: PINS.mudur });
    } finally {
      auth.resetFailures();
    }
  });

  it('giriş: güvenilen cihazda araya doğru PIN sokarak tarama da durur', async () => {
    auth.resetFailures();
    const clock = fakeClock();
    try {
      let wrong = 0;
      let limited = false;
      let sinceOwn = 0;
      const found: string[] = [];
      for (let n = 1800; n <= 1999 && !limited; n++) {
        const r = await h.call<{ me?: { name: string } }>('', 'POST', '/auth/login', { pin: String(n) });
        if (r.status === 429) limited = true;
        else if (r.status === 200) found.push(String(n));
        else {
          wrong += 1;
          sinceOwn += 1;
        }
        if (sinceOwn === 4) {
          expect((await h.call('', 'POST', '/auth/login', { pin: PINS.garson })).status).toBe(200);
          sinceOwn = 0;
        }
      }
      expect(limited, 'cihaz kilidi devreye girmeli').toBe(true);
      expect(wrong).toBeLessThanOrEqual(10);
      expect(found).not.toContain(PINS.patron);
      expect((await audit('alarm')).some((a) => a.action === 'auth.pin_lock')).toBe(true);

      // Puan zamanla düşer: kilit bitince kafedeki cihaz yeniden girer
      clock.advance(10 * 60_000);
      expect((await h.call('', 'POST', '/auth/login', { pin: PINS.kasa })).status).toBe(200);
    } finally {
      clock.restore();
      auth.resetFailures();
    }
  });
});

/** Canlı akışı (SSE) açar; okuma süresi gerçek saatle ölçülür (Date.now sahte olabilir) */
async function openStream(token: string) {
  const res = await app.request('/api/events', { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let closed = false;
  let pending: ReturnType<typeof reader.read> | null = null;
  async function readFor(ms: number) {
    const until = performance.now() + ms;
    while (!closed && performance.now() < until) {
      pending ??= reader.read();
      const r = await Promise.race([pending, new Promise<null>((ok) => setTimeout(() => ok(null), Math.max(0, until - performance.now())))]);
      if (!r) break;
      pending = null;
      if (r.done) closed = true;
      else buf += dec.decode(r.value);
    }
    return buf;
  }
  return {
    readFor,
    isClosed: () => closed,
    /** Akışa düşmüş olaylar (konu ve metinle) */
    events: () => buf.split('\n').filter((l) => l.startsWith('data: {"topic"')),
    cancel: () => reader.cancel().catch(() => undefined),
  };
}

describe('auth-52: canlı akış oturumu sürekli denetler', () => {
  it('çıkış yapınca akış kapanır, olay gitmez', async () => {
    await h.login('m2', PINS.mudur);
    const s = await openStream(h.tokens.m2);
    expect(await s.readFor(150)).toContain('event: hello');
    expect((await h.call('m2', 'POST', '/auth/logout')).status).toBe(200);
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 150000, description: 'çıkıştan sonra' });
    await s.readFor(300);
    expect(s.events()).toEqual([]);
    expect(s.isClosed(), 'oturumu kapanan akış kapanmalı').toBe(true);
    await s.cancel();
  });

  it('hesabı kapatılan kişinin akışı kapanır, kasa rakamlı uyarı gitmez', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'Gece müdürü', role: 'mudur', pin: '2470' });
    await h.login('gece', '2470');
    const s = await openStream(h.tokens.gece);
    await s.readFor(150);
    await h.ok('patron', 'PATCH', `/admin/users/${await userId('Gece müdürü')}`, { active: false });
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 250000, description: 'kapatıldıktan sonra' });
    await s.readFor(300);
    expect(s.events().filter((l) => l.includes('kapatıldıktan sonra'))).toEqual([]);
    expect(s.isClosed()).toBe(true);
    await s.cancel();
  });

  it('rolünden patron paneli alınan kişinin açık akışına uyarı gitmez; akış ve diğer olaylar sürer', async () => {
    await h.ok('patron', 'POST', '/admin/users', { name: 'Yeni müdür', role: 'mudur', pin: '2471' });
    await h.login('yeni', '2471');
    const s = await openStream(h.tokens.yeni);
    await s.readFor(150);
    try {
      await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: ROLE_DEFAULTS.mudur.filter((p) => p !== 'patron.panel') });
      expect((await h.call('yeni', 'GET', '/reports/patron')).status).toBe(403);
      await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 120000, description: 'yetki alındıktan sonra' });
      await s.readFor(300);
      expect(s.events().filter((l) => l.includes('yetki alındıktan sonra'))).toEqual([]);
      expect(s.events().some((l) => l.includes('"topic":"cash"'))).toBe(true);
      expect(s.isClosed()).toBe(false);
    } finally {
      await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: ROLE_DEFAULTS.mudur });
      await s.cancel();
    }
  });

  it('süresi dolan oturumun akışı bir sonraki yoklamada kapanır', async () => {
    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    await h.login('m5', PINS.mudur);
    const s = await openStream(h.tokens.m5);
    await s.readFor(150);
    const id = createHash('sha256').update(h.tokens.m5).digest('hex');
    db.update(schema.sessions).set({ expiresAt: Date.now() - 1 }).where(eq(schema.sessions.id, id)).run();
    const clock = fakeClock();
    try {
      clock.advance(25_000);
      await h.ok('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 50000, description: 'süre dolduktan sonra' });
      await s.readFor(300);
    } finally {
      clock.restore();
    }
    expect(s.events()).toEqual([]);
    expect(s.isClosed()).toBe(true);
    await s.cancel();
  });
});

describe('auth-56: PIN tekilliği PIN taraması için kullanılamaz', () => {
  it('patron olmayan personel yöneticisi kukla hesapla PIN tarayamaz; çakışma denetim kaydına düşer', async () => {
    auth.resetFailures();
    try {
      await h.ok('patron', 'POST', '/admin/users', { name: 'Vardiya sorumlusu', role: 'garson', permGrant: ['personel.yonet'], pin: '5151' });
      await h.login('sorumlu', '5151');
      const dummy = await h.ok<{ id: string }>('sorumlu', 'POST', '/admin/users', { name: 'Kukla', role: 'garson', pin: '700001' });

      // Çakışma: yanıt PIN'in kimde olduğunu söylemez
      const clash = await h.call<{ error: string; code: string }>('sorumlu', 'PATCH', `/admin/users/${dummy.id}`, { pin: PINS.kasa });
      expect(clash.status).toBe(409);
      expect(clash.json.error).not.toMatch(/Kasa|personelde/);
      expect((await audit('uyari')).some((a) => a.action === 'user.pin_conflict' && a.userName === 'Vardiya sorumlusu')).toBe(true);

      // Denetimdeki tarama: 1000-1999 arası; kısa sürede kilitlenir, patronun PIN'ine varamaz
      const taken: string[] = [];
      let tries = 0;
      let limited = false;
      for (let n = 1000; n <= 1999 && !limited; n++) {
        const r = await h.call<{ code?: string }>('sorumlu', 'PATCH', `/admin/users/${dummy.id}`, { pin: String(n) });
        if (r.status === 429) limited = true;
        else {
          tries += 1;
          if (r.status === 409) taken.push(String(n));
        }
      }
      expect(limited, 'PIN verme sınırı devreye girmeli').toBe(true);
      expect(tries).toBeLessThanOrEqual(10);
      expect(taken).not.toContain(PINS.patron);
      expect((await audit('alarm')).some((a) => a.action === 'auth.pin_lock' && a.userName === 'Vardiya sorumlusu')).toBe(true);
      // Kilitliyken yeni personel açarken de PIN veremez
      expect((await h.call('sorumlu', 'POST', '/admin/users', { name: 'Kukla 2', role: 'garson', pin: '700002' })).status).toBe(429);

      // Patron her hesabı zaten yönetir: art arda PIN vermesine sınır yok (kurulumda bütün ekip)
      for (let i = 0; i < 12; i++) await h.ok('patron', 'POST', '/admin/users', { name: `Ekip ${i}`, role: 'garson', pin: String(810000 + i) });
    } finally {
      auth.resetFailures();
    }
  });
});

describe.skip('input-71: boş düzenleme gövdesi', () => {
  it('değişecek alan yoksa 422; olmayan kayıt 404; dolu düzenleme çalışır', async () => {
    const floor = await h.ok<{ sections: { id: string; name: string }[]; tables: { id: string; name: string }[] }>('patron', 'GET', '/admin/floor');
    const menu = await h.ok<{ categories: { id: string; extSource: string | null }[] }>('patron', 'GET', '/admin/menu');
    const st = await h.ok<{ stations: { id: string; name: string }[] }>('patron', 'GET', '/admin/stations');
    const res = await h.ok<{ id: string }>('mudur', 'POST', '/reservations', { date: '2026-10-27', time: '19:00', name: 'Boş' });
    const cust = await h.ok<{ id: string }>('mudur', 'POST', '/customers', { name: 'Boş Müşteri' });
    const garson = await userId('Garson');
    const cases: [string, string][] = [
      ['patron', `/admin/sections/${floor.sections[0]!.id}`],
      ['patron', `/admin/tables/${floor.tables[0]!.id}`],
      ['patron', `/admin/stations/${st.stations[0]!.id}`],
      ['patron', `/admin/payment-methods/${h.boot.paymentMethods[0]!.id}`],
      ['patron', `/admin/categories/${menu.categories[0]!.id}`],
      ['garson', `/reservations/${res.id}`],
      ['patron', `/admin/users/${garson}`],
      ['mudur', `/customers/${cust.id}`],
    ];
    for (const [who, path] of cases) {
      const r = await h.call<{ code: string }>(who, 'PATCH', path, {});
      expect(r.status, path).toBe(422);
      expect(r.json.code, path).toBe('validation');
    }
    // Bilinmeyen alan da değişiklik sayılmaz
    expect((await h.call('patron', 'PATCH', `/admin/sections/${floor.sections[0]!.id}`, { foo: 1 })).status).toBe(422);
    // Siteden gelen kategoride yalnız sitenin alanı (ad) gönderilirse değişecek alan kalmaz
    const synced = menu.categories.find((c) => c.extSource);
    if (synced) expect((await h.call('patron', 'PATCH', `/admin/categories/${synced.id}`, { name: 'Başka ad' })).status).toBe(422);

    for (const p of ['/admin/sections/NOPE', '/admin/tables/NOPE', '/admin/stations/NOPE', '/admin/payment-methods/NOPE']) {
      expect((await h.call('patron', 'PATCH', p, { active: true })).status, p).toBe(404);
    }

    await h.ok('patron', 'PATCH', `/admin/sections/${floor.sections[0]!.id}`, { name: floor.sections[0]!.name });
    await h.ok('patron', 'PATCH', `/admin/tables/${floor.tables[0]!.id}`, { seats: 4 });
    await h.ok('patron', 'PATCH', `/admin/stations/${st.stations[0]!.id}`, { name: st.stations[0]!.name });
    await h.ok('patron', 'PATCH', `/admin/payment-methods/${h.boot.paymentMethods[0]!.id}`, { sort: 0 });
    await h.ok('garson', 'PATCH', `/reservations/${res.id}`, { guests: 3 });
    await h.ok('mudur', 'PATCH', `/customers/${cust.id}`, { note: 'Pencere kenarı' });
    await h.ok('patron', 'PATCH', `/admin/users/${garson}`, { color: '#3f6b8a' });
  });
});

describe.skip('input-74: takvimde olmayan tarih ve saat', () => {
  it('rezervasyon, happy hour ve ileri tarihli sipariş geçersiz tarih ve saati 422 ile reddeder', async () => {
    const bad = [
      { date: '2026-99-99', time: '19:00' },
      { date: '2026-02-30', time: '19:00' },
      { date: '2026-10-27', time: '99:99' },
      { date: '2026-10-27', time: '24:00' },
      { date: '2026-10-27', time: '7:00' },
    ];
    for (const b of bad) expect((await h.call('garson', 'POST', '/reservations', { ...b, name: 'Hayalet' })).status, JSON.stringify(b)).toBe(422);
    const ok = await h.ok<{ id: string }>('garson', 'POST', '/reservations', { date: '2028-02-29', time: '23:59', name: 'Artık yıl' });
    expect((await h.call('garson', 'PATCH', `/reservations/${ok.id}`, { time: '25:00' })).status).toBe(422);
    expect((await h.call('garson', 'PATCH', `/reservations/${ok.id}`, { date: '2026-04-31' })).status).toBe(422);
    expect((await h.call('garson', 'GET', '/reservations?date=2026-13-01')).status).toBe(422);

    const hh = { name: 'Akşam', days: [5, 1, 1, 5], start: '18:00', end: '20:00', percent: 20 };
    expect((await h.call('patron', 'POST', '/admin/happy-hours', { ...hh, start: '99:99', end: '00:61' })).status).toBe(422);
    expect((await h.call('patron', 'POST', '/admin/happy-hours', { ...hh, end: '24:00' })).status).toBe(422);
    const created = await h.ok<{ id: string }>('patron', 'POST', '/admin/happy-hours', hh);
    const rule = (await h.ok<{ id: string; days: number[] }[]>('patron', 'GET', '/admin/happy-hours')).find((r) => r.id === created.id)!;
    expect(rule.days).toEqual([1, 5]);
    expect((await h.call('patron', 'PUT', `/admin/happy-hours/${created.id}`, { ...hh, start: '18:60' })).status).toBe(422);
    await h.ok('patron', 'DELETE', `/admin/happy-hours/${created.id}`);

    const vague = await h.call<{ code: string }>('kasa', 'POST', '/orders', { type: 'gelal', scheduledFor: 'yarın bir ara' });
    expect(vague.status).toBe(422);
    expect((await h.call('kasa', 'POST', '/orders', { type: 'gelal', scheduledFor: '2026-02-30T10:00:00+03:00' })).status).toBe(422);
    const later = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'gelal', scheduledFor: '2026-10-27T19:30:00+03:00' });
    expect(Number.isFinite(new Date(later.scheduledFor!).getTime())).toBe(true);
  });
});

describe.skip('auth-54: personel tutarları rapor.maliyet ister', () => {
  it('kasa rakamlarını gören ama maliyet yetkisi olmayan kişi X ve Z özetinde personel tutarlarını görmez', async () => {
    const sell = async (who: string, name: string, qty: number) => {
      const o = await h.ok<OrderDTO>(who, 'POST', '/orders', { type: 'tezgah' });
      const full = await h.ok<OrderDTO>(who, 'POST', `/orders/${o.id}/items`, { items: [{ productId: product(name).id, qty }] });
      await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: method('Nakit').id, amount: full.total });
    };
    await sell('garson', 'Türk kahvesi', 2);
    await sell('kasa', 'Türk kahvesi', 1);

    // Kör kasası kaldırılmış kasiyer (kasa.rakam) ve rapor gören ama maliyet görmeyen kişi
    await h.ok('patron', 'POST', '/admin/users', { name: 'Açık kasa', role: 'kasiyer', permGrant: ['kasa.rakam'], pin: '4545' });
    await h.ok('patron', 'POST', '/admin/users', { name: 'Raporcu', role: 'kasiyer', permGrant: ['rapor.gor'], pin: '4546' });
    await h.login('acik', '4545');
    await h.login('raporcu', '4546');
    const me = await h.ok<{ permissions: string[] }>('acik', 'GET', '/auth/me');
    expect(me.permissions).toContain('kasa.rakam');
    expect(me.permissions).not.toContain('rapor.maliyet');
    expect((await h.call('acik', 'GET', '/reports/staff')).status).toBe(403);

    type Day = { day: { id: string }; summary: { byUser: { name: string; amount: number }[]; netSales: number; expectedCash: number } | null };
    const x = await h.ok<Day>('acik', 'GET', '/cash/day');
    expect(x.summary, 'kasa rakamları görünür').not.toBeNull();
    expect(x.summary!.netSales).toBeGreaterThan(0);
    expect(x.summary!.byUser).toEqual([]);
    const full = await h.ok<Day>('mudur', 'GET', '/cash/day');
    expect(full.summary!.byUser.length).toBeGreaterThanOrEqual(2);

    const detail = await h.ok<Day>('raporcu', 'GET', `/cash/days/${x.day.id}`);
    expect(detail.summary!.byUser).toEqual([]);
    expect((await h.ok<Day>('mudur', 'GET', `/cash/days/${x.day.id}`)).summary!.byUser.length).toBeGreaterThanOrEqual(2);

    // Gün sonu ve kasa föyü yanıtı da
    const closed = await h.ok<Day>('acik', 'POST', '/cash/day/close', { countedCash: null });
    expect(closed.summary!.byUser).toEqual([]);
    const counted = await h.ok<Day>('acik', 'POST', `/cash/days/${x.day.id}/count`, { countedCash: closed.summary!.expectedCash });
    expect(counted.summary!.byUser).toEqual([]);
    expect((await h.ok<Day>('mudur', 'GET', `/cash/days/${x.day.id}`)).summary!.byUser.length).toBeGreaterThanOrEqual(2);
  });
});
