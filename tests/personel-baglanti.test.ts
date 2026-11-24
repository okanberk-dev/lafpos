import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import { nameMatch, nameSimilarity } from '@shared/name-match';
import { type Harness, startApp } from './harness';

/**
 * Personel bağlantısı (docs/03-ENTEGRASYON.md §4.8; sahip kararı 2: "ladmin'de hesapları var; doğru hesabı bağladığından
 * emin ol"): LafPOS kullanıcısı lafmaliyet'in personel kaydına (`s:<staff.id>`) yalnız elle ve taze listeye karşı
 * bağlanır (etkin, başka kullanıcıya bağlı değil), bağlantı internet yokken kurulmaz ama kaldırılır, denetime ladmin'deki
 * ad yazılmaz. Gün sonu gövdesinin `workedStaffRefs`'i gönderirken çözülür (bağlantı yoksa alan hiç gitmez), "Bugün
 * çalışanlar" düzeltmesi kayıtlardan çıkan listenin yerine geçer, lafmaliyet'in yanıtındaki `staff` Entegrasyon'da görünür.
 */

interface StaffItem {
  ref: string;
  name: string;
  active: boolean;
  account: string | null;
}

let h: Harness;
let server: Server;
let staffReply: { status: number; body: unknown } | 'drop';
let staffItems: StaffItem[];
const staffCalls: { url: string; signed: boolean }[] = [];
const posts: Record<string, unknown>[] = [];
let dayReply: ((body: { date?: string }) => unknown) | null = null;

const ITEMS: StaffItem[] = [
  { ref: 's:12', name: 'Ayşe Yılmaz', active: true, account: 'ayse@laffogato.net' },
  { ref: 's:7', name: 'Cem Kaya', active: true, account: null },
  { ref: 's:3', name: 'Damla Ak', active: true, account: 'Damla Ak' },
  { ref: 's:40', name: 'Eski Personel', active: false, account: null },
];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/api/panel/pos/personel') {
        staffCalls.push({ url: req.url ?? '', signed: !!req.headers['x-laf-signature'] && !!req.headers['x-laf-timestamp'] });
        if (staffReply === 'drop') {
          req.socket.destroy();
          return;
        }
        res.writeHead(staffReply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(staffReply.body));
        return;
      }
      const body = raw ? JSON.parse(raw) : null;
      // Gün sonundan sonra çekilen maliyet ve ötekiler: bu testte yok
      if (url.pathname !== '/api/pos/gun') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }
      posts.push(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(dayReply ? dayReply(body) : { ok: true, date: body?.date, lines: 0, matched: 0, unmatched: [], counted: true, switchDay: '2026-11-01' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  h = await startApp({ LAFMALIYET_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, LAFMALIYET_SYNC_SECRET: 'p'.repeat(48) });
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false, okcProvider: 'kapali' });
});

afterAll(() => {
  server.close();
  h.cleanup();
});

beforeEach(async () => {
  staffItems = ITEMS.map((i) => ({ ...i }));
  staffReply = { status: 200, body: listBody() };
  dayReply = null;
  // Her test taze önbellekle başlar (önbellek 5 dakika)
  (await import('../server/sync/lafmaliyet-personel')).resetStaffCache();
});

const listBody = (sube = 'marina') => ({ version: 1, now: '2026-11-24T09:00:00.000Z', sube, items: staffItems });
const user = (name: string) => h.boot.users.find((u) => u.name === name)!;

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq, and, desc } = await import('drizzle-orm');
  const lm = await import('../server/sync/lafmaliyet');
  return { db, schema, eq, and, desc, lm };
}

async function staffRefOf(name: string) {
  const { db, schema, eq } = await mod();
  return db.select({ staffRef: schema.users.staffRef }).from(schema.users).where(eq(schema.users.id, user(name).id)).get()!.staffRef;
}

async function setRef(name: string, ref: string | null) {
  const { db, schema, eq } = await mod();
  db.update(schema.users).set({ staffRef: ref }).where(eq(schema.users.id, user(name).id)).run();
}

async function lastAudit(action: string) {
  const { db, schema, eq, desc } = await mod();
  return db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action)).orderBy(desc(schema.auditLog.id)).get();
}

describe('ad benzerliği (Türkçe katlanmış; yalnız ipucu, seçim yapmaz)', () => {
  it('ilk ad ve soyad uyarsa yüksek, Türkçe harf farkı uyumu bozmaz, başka ad düşük', () => {
    expect(nameMatch('Ayşe', 'AYSE YILMAZ')).toBe('yuksek');
    expect(nameMatch('ayşe yılmaz', 'Ayşe Yılmaz')).toBe('yuksek');
    expect(nameSimilarity('İbrahim', 'ibrahim demir')).toBeGreaterThanOrEqual(0.8);
    expect(nameMatch('Çağrı', 'Cagri Öz')).toBe('yuksek');
    expect(nameMatch('Yılmaz', 'Ayşe Yılmaz')).toBe('orta');
    expect(nameMatch('Cem', 'Alper Kaya')).toBe('dusuk');
    expect(nameMatch('Ali', 'Alican Ak')).toBe('dusuk');
    expect(nameMatch('', 'Ayşe')).toBe('dusuk');
  });
});

describe('ladmin personel listesi (GET /admin/ladmin-personel)', () => {
  it('yalnız personel yönetimi; imzalı istek kasanın şubesiyle; 5 dakika önbellek, bağlı kullanıcı ve listede olmayan bağlantı söylenir', async () => {
    expect((await h.call('mudur', 'GET', '/admin/ladmin-personel')).status).toBe(403);
    await setRef('Garson', 's:99');
    const before = staffCalls.length;
    const r = await h.ok<{ sube: string; items: (StaffItem & { linkedUserId: string | null })[]; missing: { userId: string; staffRef: string }[] }>('patron', 'GET', '/admin/ladmin-personel');
    expect(staffCalls.length).toBe(before + 1);
    expect(staffCalls.at(-1)).toEqual({ url: '/api/panel/pos/personel?sube=marina', signed: true });
    expect(r.sube).toBe('marina');
    expect(r.items.map((i) => [i.ref, i.name, i.active, i.account, i.linkedUserId])).toEqual([
      ['s:12', 'Ayşe Yılmaz', true, 'ayse@laffogato.net', null],
      ['s:7', 'Cem Kaya', true, null, null],
      ['s:3', 'Damla Ak', true, 'Damla Ak', null],
      ['s:40', 'Eski Personel', false, null, null],
    ]);
    expect(r.missing).toEqual([{ userId: user('Garson').id, staffRef: 's:99' }]);
    // Önbellekten: ikinci okuma ladmin'e gitmez; "Yenile" 30 saniyeden önce de gitmez
    await h.ok('patron', 'GET', '/admin/ladmin-personel');
    await h.ok('patron', 'GET', '/admin/ladmin-personel?yenile=1');
    expect(staffCalls.length).toBe(before + 1);
    // 5 dakika sonra yeniden çekilir
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1000);
    try {
      await h.ok('patron', 'GET', '/admin/ladmin-personel');
      expect(staffCalls.length).toBe(before + 2);
    } finally {
      spy.mockRestore();
    }
    await setRef('Garson', null);
  });

  it('ulaşılamayan, eski (404), bozuk yanıt ve başka şube: 503 ya da 409, Türkçe neden; liste uydurulmaz', async () => {
    const cases: [typeof staffReply, number, string, RegExp][] = [
      ['drop', 503, 'ladmin_unavailable', /ulaşılamadı/],
      [{ status: 404, body: { error: 'not_found' } }, 503, 'ladmin_unavailable', /henüz sunmuyor/],
      [{ status: 500, body: {} }, 503, 'ladmin_unavailable', /HTTP 500/],
      [{ status: 200, body: { version: 1, sube: 'marina', items: [{ ref: '12', name: 'X', active: true }] } }, 503, 'ladmin_unavailable', /beklenen biçimde değil/],
      [{ status: 200, body: listBody('tuzla') }, 503, 'ladmin_unavailable', /beklenen biçimde değil/],
      [{ status: 409, body: { error: 'wrong_branch', sube: 'marina', expected: 'tuzla' } }, 409, 'wrong_branch', /"tuzla"/],
    ];
    for (const [reply, status, code, message] of cases) {
      (await import('../server/sync/lafmaliyet-personel')).resetStaffCache();
      staffReply = reply;
      const r = await h.call<{ code: string; error: string }>('patron', 'GET', '/admin/ladmin-personel');
      expect(r.status, JSON.stringify(reply)).toBe(status);
      expect(r.json.code).toBe(code);
      expect(r.json.error).toMatch(message);
    }
  });
});

describe('bağlama (PATCH /admin/users/:id staffRef)', () => {
  it('etkin ve boşta personele bağlanır; denetimde ladmin adı yok; başka kişiye bağlı kayıt 409, pasif ve listede olmayan 422', async () => {
    const kasa = user('Kasa');
    expect((await h.call('patron', 'PATCH', `/admin/users/${kasa.id}`, { staffRef: '12' })).status).toBe(422);
    await h.ok('patron', 'PATCH', `/admin/users/${kasa.id}`, { staffRef: 's:12' });
    expect(await staffRefOf('Kasa')).toBe('s:12');
    const audit = (await lastAudit('user.staff_link'))!;
    expect(audit).toMatchObject({ entity: 'user', entityId: kasa.id, severity: 'info', data: { staffRef: 's:12', previous: null } });
    expect(audit.message).toContain('Kasa');
    expect(JSON.stringify(audit)).not.toMatch(/Ayşe|ayse@/);
    // Listede ve kullanıcılar listesinde görünür
    const users = await h.ok<{ id: string; staffRef: string | null }[]>('patron', 'GET', '/admin/users');
    expect(users.find((u) => u.id === kasa.id)!.staffRef).toBe('s:12');
    const list = await h.ok<{ items: { ref: string; linkedUserId: string | null }[] }>('patron', 'GET', '/admin/ladmin-personel');
    expect(list.items.find((i) => i.ref === 's:12')!.linkedUserId).toBe(kasa.id);

    const taken = await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${user('Garson').id}`, { staffRef: 's:12' });
    expect(taken.status).toBe(409);
    expect(taken.json.code).toBe('staff_ref_taken');
    const inactive = await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${user('Garson').id}`, { staffRef: 's:40' });
    expect([inactive.status, inactive.json.code]).toEqual([422, 'staff_ref_inactive']);
    const unknown = await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${user('Garson').id}`, { staffRef: 's:55' });
    expect([unknown.status, unknown.json.code]).toEqual([422, 'staff_ref_unknown']);
    expect(await staffRefOf('Garson')).toBeNull();

    // Başka alanın düzenlemesi bağlantıya dokunmaz (patchOf: gönderilmeyen alan varsayılanla ezilmez)
    await h.ok('patron', 'PATCH', `/admin/users/${kasa.id}`, { color: '#3f6b8a' });
    expect(await staffRefOf('Kasa')).toBe('s:12');

    // Bağlantıyı değiştirmek uyarı önemiyle yazılır
    await h.ok('patron', 'PATCH', `/admin/users/${kasa.id}`, { staffRef: 's:7' });
    expect(await lastAudit('user.staff_link')).toMatchObject({ severity: 'uyari', data: { staffRef: 's:7', previous: 's:12' } });
  });

  it('ladmin şimdi listede pasif gösteriyorsa önbellekteki eski "etkin" bilgiyle bağlanmaz (5 dakikadan eski liste yeniden çekilir)', async () => {
    await h.ok('patron', 'GET', '/admin/ladmin-personel');
    staffItems = staffItems.map((i) => (i.ref === 's:3' ? { ...i, active: false } : i));
    staffReply = { status: 200, body: listBody() };
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 6 * 60_000);
    try {
      const r = await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${user('Garson').id}`, { staffRef: 's:3' });
      expect([r.status, r.json.code]).toEqual([422, 'staff_ref_inactive']);
    } finally {
      spy.mockRestore();
    }
  });

  it('internet yokken bağlantı kurulmaz (503), kaldırılır; kaldırma denetime uyarı önemiyle yazılır', async () => {
    const garson = user('Garson');
    staffReply = 'drop';
    const r = await h.call<{ code: string }>('patron', 'PATCH', `/admin/users/${garson.id}`, { staffRef: 's:3' });
    expect([r.status, r.json.code]).toEqual([503, 'ladmin_unavailable']);
    expect(await staffRefOf('Garson')).toBeNull();
    await setRef('Garson', 's:3');
    await h.ok('patron', 'PATCH', `/admin/users/${garson.id}`, { staffRef: null });
    expect(await staffRefOf('Garson')).toBeNull();
    expect(await lastAudit('user.staff_link')).toMatchObject({ entityId: garson.id, severity: 'uyari', data: { staffRef: null, previous: 's:3' } });
  });
});

describe('gün sonu gövdesi workedStaffRefs (gönderirken çözülür)', () => {
  let n = 0;
  /** Kapanmış gerçek gün: verilen kişilerin kayıtlarıyla (adisyonu açan, ödemeyi alan, kasa hareketi) */
  async function closedDay(actors: { order?: string; payment?: string; movement?: string }) {
    const { db, schema } = await mod();
    const { ulid } = await import('../server/lib/ids');
    const id = ulid();
    const at = Date.now() - 3600_000;
    const date = addDays(businessDate(Date.now()), -(60 + ++n));
    const method = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    db.insert(schema.businessDays).values({ id, date, zNo: 500 + n, openedAt: at, openingCash: 0, closedAt: at + 60_000, trainingDay: false }).run();
    const orderId = ulid();
    db.insert(schema.orders).values({ id: orderId, dayId: id, no: 1, type: 'tezgah', status: 'kapali', openedAt: at, openedBy: actors.order ? user(actors.order).id : null, closedAt: at + 1000, updatedAt: at + 1000 }).run();
    if (actors.payment) db.insert(schema.payments).values({ id: ulid(), orderId, dayId: id, methodId: method.id, methodName: 'Nakit', zField: 'cash', amount: 0, userId: user(actors.payment).id, createdAt: at + 500 }).run();
    if (actors.movement) db.insert(schema.cashMovements).values({ id: ulid(), dayId: id, kind: 'giris', amount: 100, userId: user(actors.movement).id, createdAt: at + 700 }).run();
    return { id, date };
  }
  async function send(id: string) {
    const { db, schema, eq, lm } = await mod();
    const key = lm.enqueueDay(id)!;
    db.update(schema.outbox).set({ nextAttemptAt: 0 }).where(eq(schema.outbox.dedupeKey, key)).run();
    await lm.flushOutbox();
    return posts.at(-1)!;
  }

  it('bağlı kullanıcı yokken alan hiç gitmez (eski gövde bayt bayt aynı)', async () => {
    for (const n of ['Kasa', 'Garson', 'Müdür', 'Patron']) await setRef(n, null);
    const day = await closedDay({ order: 'Kasa', payment: 'Müdür' });
    const body = await send(day.id);
    expect(body.date).toBe(day.date);
    expect('workedStaffRefs' in body).toBe(false);
    const preview = await h.ok<Record<string, unknown>>('patron', 'GET', `/sync/lafmaliyet/gun/${day.id}`);
    expect('workedStaffRefs' in preview).toBe(false);
  });

  it('kayıtlardan: bağlı ve o gün iş yapanlar, sıralı ve tekil; bağsız ya da o gün iş yapmayan girmez; bağlantı gün kapandıktan sonra kurulsa da gönderimde çözülür', async () => {
    const day = await closedDay({ order: 'Kasa', payment: 'Kasa', movement: 'Müdür' });
    const { db, schema, eq, lm } = await mod();
    const key = lm.enqueueDay(day.id)!;
    // Gövde kuyruğa bağlantıdan önce girdi; bağlantı sonra
    await setRef('Kasa', 's:12');
    await setRef('Müdür', 's:3');
    await setRef('Garson', 's:7');
    db.update(schema.outbox).set({ nextAttemptAt: 0 }).where(eq(schema.outbox.dedupeKey, key)).run();
    await lm.flushOutbox();
    const body = posts.at(-1)!;
    expect(body.date).toBe(day.date);
    expect(body.workedStaffRefs).toEqual(['s:3', 's:12']);
    expect(Object.keys(body).at(-1)).toBe('workedStaffRefs');
    expect(JSON.stringify(body)).not.toMatch(/Kasa"|Müdür|Garson/);
  });

  it('"Bugün çalışanlar" düzeltmesi kayıtlardan çıkan listenin yerine geçer, gün yeniden gider, denetime yazılır; null kayıtlara döner', async () => {
    await setRef('Kasa', 's:12');
    await setRef('Garson', 's:7');
    const day = await closedDay({ order: 'Kasa' });
    await send(day.id);
    expect(posts.at(-1)!.workedStaffRefs).toEqual(['s:12']);
    // Yetki: Geçmiş günler'i gören (rapor.gor); kasiyer değil
    expect((await h.call('kasa', 'PUT', `/cash/days/${day.id}/worked`, { userIds: [user('Garson').id] })).status).toBe(403);
    expect((await h.call('mudur', 'PUT', `/cash/days/${day.id}/worked`, { userIds: ['yok'] })).status).toBe(422);
    const sentBefore = posts.length;
    await h.ok('mudur', 'PUT', `/cash/days/${day.id}/worked`, { userIds: [user('Garson').id, user('Kasa').id, user('Bar ekranı').id] });
    await vi.waitFor(() => expect(posts.length).toBe(sentBefore + 1));
    expect(posts.at(-1)!.workedStaffRefs).toEqual(['s:7', 's:12']);
    expect(await lastAudit('day.worked_staff')).toMatchObject({ severity: 'uyari', data: { userIds: [user('Garson').id, user('Kasa').id, user('Bar ekranı').id], previous: null } });
    const detail = await h.ok<{ worked: { ids: string[]; derivedIds: string[]; corrected: boolean; people: { id: string; name: string; linked: boolean }[] } }>('mudur', 'GET', `/cash/days/${day.id}`);
    expect(detail.worked).toMatchObject({ corrected: true, derivedIds: [user('Kasa').id] });
    expect(new Set(detail.worked.ids)).toEqual(new Set([user('Garson').id, user('Kasa').id, user('Bar ekranı').id]));
    expect(detail.worked.people.find((p) => p.id === user('Garson').id)).toMatchObject({ name: 'Garson', linked: true });
    expect(JSON.stringify(detail.worked)).not.toContain('s:7');
    // Boş liste "kimse çalışmadı" demektir: alan boş dizi gider
    await h.ok('mudur', 'PUT', `/cash/days/${day.id}/worked`, { userIds: [] });
    await vi.waitFor(() => expect(posts.length).toBe(sentBefore + 2));
    expect(posts.at(-1)!.workedStaffRefs).toEqual([]);
    await h.ok('mudur', 'PUT', `/cash/days/${day.id}/worked`, { userIds: null });
    await vi.waitFor(() => expect(posts.length).toBe(sentBefore + 3));
    expect(posts.at(-1)!.workedStaffRefs).toEqual(['s:12']);
    expect((await h.ok<{ worked: { corrected: boolean } }>('mudur', 'GET', `/cash/days/${day.id}`)).worked.corrected).toBe(false);
  });

  it('açık gün düzeltilmez (409)', async () => {
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    const { db, schema } = await mod();
    const { isNull } = await import('drizzle-orm');
    const open = db.select().from(schema.businessDays).where(isNull(schema.businessDays.closedAt)).get()!;
    const r = await h.call<{ code: string }>('mudur', 'PUT', `/cash/days/${open.id}/worked`, { userIds: [] });
    expect([r.status, r.json.code]).toEqual([409, 'day_open']);
    await h.ok('mudur', 'POST', '/cash/day/close', { countedCash: null });
  });

  it("lafmaliyet'in yanıtındaki staff okunur (sayılan, bilinmeyen, başka şube); bozuk alan günü düşürmez; Entegrasyon adları LafPOS'tan çözer", async () => {
    await setRef('Kasa', 's:12');
    await setRef('Garson', 's:7');
    dayReply = (b) => ({ ok: true, date: b.date, counted: true, staff: { counted: ['s:12'], unknown: ['s:7'], otherBranch: ['s:99'] } });
    const day = await closedDay({ order: 'Kasa' });
    await send(day.id);
    const status = await h.ok<{ lafmaliyet: { answer: { staff?: unknown }; staffIssues?: unknown } }>('patron', 'GET', '/sync/status');
    expect(status.lafmaliyet.answer.staff).toEqual({ counted: ['s:12'], unknown: ['s:7'], otherBranch: ['s:99'] });
    expect(status.lafmaliyet.staffIssues).toEqual({ unknown: [{ ref: 's:7', name: 'Garson' }], otherBranch: [{ ref: 's:99', name: null }] });
    // Personel yönetimi ya da bağlantı yönetimi olmayan kişiye gitmez
    const garson = await h.ok<{ lafmaliyet: { answer: Record<string, unknown> | null; staffIssues?: unknown } }>('garson', 'GET', '/sync/status');
    expect(garson.lafmaliyet.answer && 'staff' in garson.lafmaliyet.answer).toBe(false);
    expect(garson.lafmaliyet.staffIssues).toBeUndefined();

    dayReply = (b) => ({ ok: true, date: b.date, counted: true, staff: { counted: 'hepsi' } });
    const other = await closedDay({ order: 'Kasa' });
    await send(other.id);
    const { lm } = await mod();
    expect(lm.lastDayAnswer()).toMatchObject({ date: other.date, counted: true });
    expect(lm.lastDayAnswer()!.staff).toBeUndefined();
  });
});
