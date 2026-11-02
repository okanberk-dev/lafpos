import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, businessDate } from '@shared/time';
import type { MyTimeDTO, PunchResultDTO, TimeEntryDTO, TimeSheetDTO } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Mesai (personel giriş-çıkışı): kişinin kendi girişi (oturum ve kilit ekranında PIN), iş günü kuralı, yinelenen basış,
 * giriş PIN'iyle ortak deneme sınırı, yöneticinin çizelgesi ve düzeltmeleri (kurallar, denetim kaydı, kendi kaydı),
 * CSV dökümü, yetki ve canlı olaylar.
 */
let h: Harness;
let auth: typeof import('../server/lib/auth');
beforeAll(async () => {
  h = await startApp();
  auth = await import('../server/lib/auth');
});
afterAll(() => h.cleanup());

const H = 3600_000;
/** İstanbul saatiyle an (UTC+3, yaz saati yok) */
const at = (date: string, hh: number, mm = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm);
};
/** Testlerin günleri geçmişte: girilen saatler gerçek saate göre ileri tarih olmasın */
const D = addDays(businessDate(Date.now()), -12);

/** Sunucunun saati (Date.now) testin elinde; sonunda gerçek saate döner */
function clock(start: number) {
  let now = start;
  const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    to: (ms: number) => {
      now = ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    restore: () => spy.mockRestore(),
  };
}

const userId = (name: string) => h.boot.users.find((u) => u.name === name)!.id;
const codeOf = async (p: Promise<{ status: number; json: unknown }>) => {
  const r = await p;
  return [r.status, (r.json as { code?: string }).code];
};
type AuditRow = { action: string; severity: string; message: string; userName: string | null; entityId: string | null };
const audit = () => h.ok<AuditRow[]>('patron', 'GET', '/admin/audit?limit=200');

describe('kendi giriş-çıkışı', () => {
  it('oturumdan giriş ve çıkış; bugün açık mesai şimdiye kadar sayılır; denetime yazılmaz', async () => {
    const c = clock(at(D, 9));
    try {
      const inn = await h.ok<{ entry: TimeEntryDTO; me: MyTimeDTO }>('kasa', 'POST', '/time/clock-in');
      expect(inn.entry).toMatchObject({ userName: 'Kasa', source: 'oturum', open: true, businessDate: D, clockIn: at(D, 9), clockOut: null, editedBy: null });
      expect(inn.me.open?.id).toBe(inn.entry.id);
      c.advance(2 * H);
      const me = await h.ok<MyTimeDTO>('kasa', 'GET', '/time/me');
      expect(me.today).toMatchObject({ date: D, workedMs: 2 * H });
      expect(me.open?.durationMs).toBe(2 * H);
      expect(await codeOf(h.call('kasa', 'POST', '/time/clock-in'))).toEqual([409, 'already_clocked_in']);
      c.advance(6 * H);
      const out = await h.ok<{ entry: TimeEntryDTO; me: MyTimeDTO }>('kasa', 'POST', '/time/clock-out');
      expect(out.entry).toMatchObject({ open: false, clockOut: at(D, 17), durationMs: 8 * H });
      expect(out.me).toMatchObject({ open: null, today: { date: D, workedMs: 8 * H }, weekMs: 8 * H });
      const twice = await h.call<{ code: string; error: string }>('kasa', 'POST', '/time/clock-out');
      expect([twice.status, twice.json.code, twice.json.error]).toEqual([409, 'not_clocked_in', 'Açık mesainiz yok; önce giriş yapın']);
    } finally {
      c.restore();
    }
    // Kişinin kendi giriş-çıkışı kaydın kendisidir: denetim kaydına düşmez
    expect((await audit()).filter((a) => a.action.startsWith('time.'))).toEqual([]);
  });

  it('iş günü girişten: gece 03:00te biten mesai başladığı günün; hafta son 7 iş günü', async () => {
    const day = addDays(D, 1);
    const c = clock(at(day, 22));
    try {
      expect(await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.garson })).toMatchObject({ state: 'in', repeated: false, user: { name: 'Garson' } });
      c.to(at(addDays(day, 1), 3));
      const out = await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.garson });
      expect(out).toMatchObject({ state: 'out', entry: { businessDate: day, durationMs: 5 * H }, todayMs: 5 * H });
      expect((await h.ok<MyTimeDTO>('garson', 'GET', '/time/me')).today).toMatchObject({ date: day, workedMs: 5 * H });
      // 05:00'ten sonra yeni iş günü: bugün boş, hafta mesaiyi sayar
      c.to(at(addDays(day, 1), 6));
      let me = await h.ok<MyTimeDTO>('garson', 'GET', '/time/me');
      expect(me.today).toEqual({ date: addDays(day, 1), workedMs: 0, entries: [] });
      expect(me.weekMs).toBe(5 * H);
      c.to(at(addDays(day, 7), 12));
      me = await h.ok<MyTimeDTO>('garson', 'GET', '/time/me');
      expect(me.weekMs).toBe(0);
    } finally {
      c.restore();
    }
  });

  it('PIN ile basış oturum açmaz; yön yoksa durum değişir, bir dakika içindeki ikinci basış yok sayılır', async () => {
    const { db, schema } = await import('../server/db/client');
    const sessions = () => db.select().from(schema.sessions).all().length;
    const before = sessions();
    const day = addDays(D, 3);
    const c = clock(at(day, 8));
    try {
      const first = await h.call<PunchResultDTO & { token?: string }>('', 'POST', '/time/punch', { pin: PINS.mudur });
      expect(first.status).toBe(200);
      expect(first.json).toMatchObject({ state: 'in', repeated: false, user: { name: 'Müdür' }, entry: { source: 'pin', open: true, businessDate: day } });
      expect(first.json).not.toHaveProperty('token');
      // Çift dokunuş: içeride kalır, yeni kayıt açılmaz
      c.advance(20_000);
      expect(await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.mudur })).toMatchObject({ state: 'in', repeated: true, entry: { id: first.json.entry.id } });
      // Yön verilen basış yinelenen sayılmaz
      expect(await codeOf(h.call('', 'POST', '/time/punch', { pin: PINS.mudur, action: 'in' }))).toEqual([409, 'already_clocked_in']);
      c.advance(4 * H);
      const out = await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.mudur });
      expect(out).toMatchObject({ state: 'out', repeated: false, entry: { open: false, durationMs: 4 * H + 20_000 } });
      expect(await codeOf(h.call('', 'POST', '/time/punch', { pin: PINS.mudur, action: 'out' }))).toEqual([409, 'not_clocked_in']);
      c.advance(30_000);
      expect(await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.mudur })).toMatchObject({ state: 'out', repeated: true, entry: { id: out.entry.id } });
      c.advance(60_000);
      expect(await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.mudur, action: 'in' })).toMatchObject({ state: 'in', repeated: false });
      c.advance(H);
      expect(await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.mudur, action: 'out' })).toMatchObject({ state: 'out', todayMs: 5 * H + 20_000 });
    } finally {
      c.restore();
    }
    expect(sessions()).toBe(before);
  });

  it('kapalı hesap basamaz: hatalı PIN ile aynı yanıt', async () => {
    const { id } = await h.ok<{ id: string }>('patron', 'POST', '/admin/users', { name: 'Eski Barista', role: 'kasiyer', pin: '5791' });
    await h.ok('patron', 'PATCH', `/admin/users/${id}`, { active: false });
    try {
      const closed = await h.call('', 'POST', '/time/punch', { pin: '5791' });
      const wrong = await h.call('', 'POST', '/time/punch', { pin: '5792' });
      expect(closed).toEqual({ status: 401, json: { error: 'PIN hatalı', code: 'pin_invalid' } });
      expect(wrong).toEqual(closed);
    } finally {
      auth.resetFailures();
    }
  });

  it('hatalı PIN giriş ekranının deneme sınırına sayılır: basış ve giriş birlikte kilitlenir', async () => {
    auth.resetFailures();
    try {
      for (let i = 0; i < 3; i++) expect((await h.call('', 'POST', '/auth/login', { pin: '0000' })).status).toBe(401);
      for (let i = 0; i < 2; i++) expect((await h.call('', 'POST', '/time/punch', { pin: '0001' })).status).toBe(401);
      // Beşinci hatadan sonra doğru PIN de geçmez: ne basış ne giriş
      expect(await codeOf(h.call('', 'POST', '/time/punch', { pin: PINS.garson }))).toEqual([429, 'rate_limited']);
      expect(await codeOf(h.call('', 'POST', '/auth/login', { pin: PINS.garson }))).toEqual([429, 'rate_limited']);
    } finally {
      auth.resetFailures();
    }
    // Kilitliyken basış yazılmadı: garson içeride değil
    expect((await h.ok<MyTimeDTO>('garson', 'GET', '/time/me')).open).toBeNull();
  });
});

describe('yönetici çizelgesi', () => {
  it('mesai.yonet ister: garson ve kasiyer göremez; müdür kişi toplamlarını görür', async () => {
    const range = `from=${D}&to=${addDays(D, 4)}`;
    for (const who of ['garson', 'kasa']) {
      const r = await h.call<{ code: string; permission: string }>(who, 'GET', `/time?${range}`);
      expect([r.status, r.json.code, r.json.permission]).toEqual([403, 'forbidden', 'mesai.yonet']);
    }
    const sheet = await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?${range}`);
    expect(sheet).toMatchObject({ from: D, to: addDays(D, 4), clockedIn: [] });
    expect(sheet.totals.map((t) => [t.userName, t.workedMs, t.shifts, t.openNow])).toEqual([
      ['Garson', 5 * H, 1, false],
      ['Kasa', 8 * H, 1, false],
      ['Müdür', 5 * H + 20_000, 2, false],
    ]);
    // En yeni üstte
    expect(sheet.entries.map((e) => e.clockIn)).toEqual([...sheet.entries.map((e) => e.clockIn)].sort((a, b) => b - a));
    // Kişiye süzme; ters dönem çevrilir
    const one = await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?from=${addDays(D, 4)}&to=${D}&userId=${userId('Garson')}`);
    expect([one.from, one.to, one.entries.map((e) => e.userName)]).toEqual([D, addDays(D, 4), ['Garson']]);
    expect(await codeOf(h.call('mudur', 'GET', `/time?from=${D}&to=${addDays(D, 93)}`))).toEqual([422, 'range_too_long']);
    expect(await codeOf(h.call('mudur', 'GET', '/time?from=2026-02-30'))).toEqual([422, 'validation']);
  });

  it('elle mesai: sıra, 24 saat, ileri tarih ve çakışma kuralları; uç uca olur', async () => {
    const E = addDays(D, 5);
    const garson = userId('Garson');
    const post = (body: Record<string, unknown>) => h.call<TimeEntryDTO>('mudur', 'POST', '/time/entries', body);
    const first = await post({ userId: garson, clockIn: at(E, 10), clockOut: at(E, 18), note: 'Girişi unuttu' });
    expect(first.status).toBe(200);
    expect(first.json).toMatchObject({ source: 'yonetim', editedByName: 'Müdür', businessDate: E, durationMs: 8 * H, note: 'Girişi unuttu', open: false });
    expect(await codeOf(post({ userId: garson, clockIn: at(E, 17), clockOut: at(E, 20) }))).toEqual([409, 'overlap']);
    expect(await codeOf(post({ userId: garson, clockIn: at(E, 6), clockOut: at(E, 22) }))).toEqual([409, 'overlap']);
    expect((await post({ userId: garson, clockIn: at(E, 18), clockOut: at(E, 20) })).status).toBe(200);
    expect(await codeOf(post({ userId: garson, clockIn: at(E, 21), clockOut: at(E, 21) }))).toEqual([400, 'time_order']);
    expect(await codeOf(post({ userId: garson, clockIn: at(E, 21), clockOut: at(addDays(E, 1), 21, 1) }))).toEqual([400, 'shift_too_long']);
    expect(await codeOf(post({ userId: garson, clockIn: Date.now() - H, clockOut: Date.now() + 10 * 60_000 }))).toEqual([400, 'future_time']);
    expect(await codeOf(post({ userId: garson, clockIn: Date.now() + 10 * 60_000 }))).toEqual([400, 'future_time']);
    // Açık mesai 24 saatten eski girilmez (çıkışı da girilmeli)
    expect(await codeOf(post({ userId: garson, clockIn: Date.now() - 30 * H }))).toEqual([400, 'shift_too_long']);
    expect(await codeOf(post({ userId: 'yok-boyle-biri', clockIn: at(E, 6), clockOut: at(E, 7) }))).toEqual([404, 'not_found']);
    expect(await codeOf(h.call('kasa', 'POST', '/time/entries', { userId: garson, clockIn: at(E, 6), clockOut: at(E, 7) }))).toEqual([403, 'forbidden']);
  });

  it('kişi başına tek açık mesai; açık mesai kapatılır, yeniden açılır; düzeltmede gönderilmeyen alan değişmez', async () => {
    const day = addDays(D, 6);
    const garson = userId('Garson');
    const c = clock(at(day, 12));
    try {
      const open = await h.ok<PunchResultDTO>('', 'POST', '/time/punch', { pin: PINS.garson, action: 'in' });
      c.advance(H);
      expect(await codeOf(h.call('mudur', 'POST', '/time/entries', { userId: garson, clockIn: at(day, 12, 30) }))).toEqual([409, 'already_clocked_in']);
      expect(await codeOf(h.call('mudur', 'POST', `/time/entries/${open.entry.id}/close`, { at: at(day, 14) }))).toEqual([400, 'future_time']);
      const closed = await h.ok<TimeEntryDTO>('mudur', 'POST', `/time/entries/${open.entry.id}/close`, { at: at(day, 12, 45) });
      expect(closed).toMatchObject({ open: false, clockOut: at(day, 12, 45), durationMs: 45 * 60_000, editedByName: 'Müdür', source: 'pin' });
      expect(await codeOf(h.call('mudur', 'POST', `/time/entries/${open.entry.id}/close`, {}))).toEqual([409, 'entry_closed']);
      // Not düzeltmesi saatlere dokunmaz (patchOf)
      const noted = await h.ok<TimeEntryDTO>('mudur', 'PATCH', `/time/entries/${open.entry.id}`, { note: 'Erken çıktı' });
      expect(noted).toMatchObject({ clockIn: at(day, 12), clockOut: at(day, 12, 45), note: 'Erken çıktı' });
      // Çıkışı silmek mesaiyi yeniden açar
      const reopened = await h.ok<TimeEntryDTO>('mudur', 'PATCH', `/time/entries/${open.entry.id}`, { clockOut: null });
      expect(reopened).toMatchObject({ open: true, clockOut: null, note: 'Erken çıktı' });
      expect((await h.ok<MyTimeDTO>('garson', 'GET', '/time/me')).open?.id).toBe(open.entry.id);
      expect(await codeOf(h.call('mudur', 'PATCH', `/time/entries/${open.entry.id}`, {}))).toEqual([422, 'validation']);
      // Şimdiye kadar kapatma
      expect(await h.ok<TimeEntryDTO>('mudur', 'POST', `/time/entries/${open.entry.id}/close`, {})).toMatchObject({ open: false, clockOut: at(day, 13) });
    } finally {
      c.restore();
    }
  });

  it('düzeltme ve silme denetime uyarı, elle giriş ve kapatma bilgi olarak düşer; kişi ve saatler yazılır', async () => {
    const E = addDays(D, 5);
    const sheet = await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?from=${E}&to=${E}`);
    const [late, early] = sheet.entries;
    expect([early.clockIn, late.clockIn]).toEqual([at(E, 10), at(E, 18)]);
    const edited = await h.ok<TimeEntryDTO>('mudur', 'PATCH', `/time/entries/${early.id}`, { clockIn: at(E, 9, 30), note: null });
    expect(edited).toMatchObject({ clockIn: at(E, 9, 30), clockOut: at(E, 18), note: null, durationMs: 8.5 * H });
    expect(await codeOf(h.call('mudur', 'PATCH', `/time/entries/${early.id}`, { clockOut: at(E, 19) }))).toEqual([409, 'overlap']);
    expect(await codeOf(h.call('kasa', 'PATCH', `/time/entries/${early.id}`, { note: 'x' }))).toEqual([403, 'forbidden']);
    // Değişmeyen düzeltme yazılmaz
    const before = (await audit()).length;
    await h.ok('mudur', 'PATCH', `/time/entries/${early.id}`, { clockIn: at(E, 9, 30) });
    expect((await audit()).length).toBe(before);
    await h.ok('mudur', 'DELETE', `/time/entries/${late.id}`);
    expect(await codeOf(h.call('mudur', 'DELETE', `/time/entries/${late.id}`))).toEqual([404, 'not_found']);

    const rows = (await audit()).filter((a) => a.action.startsWith('time.'));
    const of = (action: string) => rows.filter((a) => a.action === action);
    expect(of('time.create').map((a) => a.severity)).toEqual(['info', 'info']);
    expect(of('time.close').map((a) => a.severity)).toEqual(['info', 'info']);
    expect(of('time.edit').every((a) => a.severity === 'uyari')).toBe(true);
    expect(of('time.delete').map((a) => a.severity)).toEqual(['uyari']);
    expect(rows.every((a) => a.userName === 'Müdür' && a.message.startsWith('Müdür, Garson '))).toBe(true);
    const edit = of('time.edit').find((a) => a.entityId === early.id)!;
    expect(edit.message).toContain('giriş');
    expect(edit.message).toContain('10:00 → 09:30');
    expect(edit.message).toContain('not silindi');
    expect(of('time.delete')[0].message).toMatch(/Müdür, Garson mesaisini sildi: \d{2}\.\d{2}\.\d{4} 18:00–20:00/);
    expect(of('time.close').some((a) => a.message.includes('12:00–12:45'))).toBe(true);
    // Uyarılar patron paneline de düşer (uyarı akışı); bilgi düşmez
    expect(rows.filter((a) => a.severity !== 'info').length).toBeGreaterThan(0);
  });

  it('yönetici kendi mesaisini düzeltemez, kendine elle mesai giremez; patron düzeltebilir', async () => {
    const mine = (await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?from=${D}&to=${addDays(D, 4)}&userId=${userId('Müdür')}`)).entries[0];
    expect(await codeOf(h.call('mudur', 'PATCH', `/time/entries/${mine.id}`, { note: 'uzat' }))).toEqual([403, 'self_edit']);
    expect(await codeOf(h.call('mudur', 'DELETE', `/time/entries/${mine.id}`))).toEqual([403, 'self_edit']);
    const E = addDays(D, 7);
    expect(await codeOf(h.call('mudur', 'POST', '/time/entries', { userId: userId('Müdür'), clockIn: at(E, 9), clockOut: at(E, 17) }))).toEqual([403, 'self_edit']);
    expect(await h.ok<TimeEntryDTO>('patron', 'PATCH', `/time/entries/${mine.id}`, { note: 'Patron onayladı' })).toMatchObject({ note: 'Patron onayladı', editedByName: 'Patron' });
    expect((await h.call('patron', 'POST', '/time/entries', { userId: userId('Patron'), clockIn: at(E, 9), clockOut: at(E, 17) })).status).toBe(200);
  });

  it('şu an içeride olanlar dönemden bağımsız görünür', async () => {
    const c = clock(Date.now() - 2 * H);
    try {
      await h.ok('', 'POST', '/time/punch', { pin: PINS.kasa, action: 'in' });
    } finally {
      c.restore();
    }
    const sheet = await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?from=${D}&to=${D}`);
    expect(sheet.clockedIn.map((e) => e.userName)).toEqual(['Kasa']);
    expect(sheet.clockedIn[0].durationMs).toBeGreaterThanOrEqual(2 * H);
    expect(sheet.totals.find((t) => t.userName === 'Kasa')?.openNow).toBe(true);
    await h.ok('kasa', 'POST', '/time/clock-out');
    expect((await h.ok<TimeSheetDTO>('mudur', 'GET', `/time?from=${D}&to=${D}`)).clockedIn).toEqual([]);
  });

  it('CSV dökümü: başlık satırı, kişi ve giriş sırası; yetkisize 403', async () => {
    const r = await h.call<string>('mudur', 'GET', `/time/export.csv?from=${D}&to=${addDays(D, 7)}`);
    expect(r.status).toBe(200);
    const lines = r.json.replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe('Personel;İş günü;Giriş;Çıkış;Dakika;Saat;Kaynak;Not;Düzelten');
    expect(lines.slice(1, -1).map((l) => l.split(';')[0])).toEqual(['Garson', 'Garson', 'Garson', 'Kasa', 'Müdür', 'Müdür', 'Patron']);
    expect(lines.find((l) => l.startsWith(`Kasa;${D};`))).toMatch(/;480;8;Oturum;;$/);
    expect(lines.find((l) => l.includes(';Erken çıktı;'))).toMatch(/;60;1;PIN;Erken çıktı;Müdür$/);
    expect((await h.call('garson', 'GET', `/time/export.csv?from=${D}&to=${D}`)).status).toBe(403);
  });
});

describe('yetki ve canlı olaylar', () => {
  it('müdür varsayılan alır, kasiyer ve garson almaz; kayıtlı rol setine bir kez eklenir', async () => {
    const { PERMISSION_GROUPS, ROLE_DEFAULTS } = await import('@shared/permissions');
    expect(ROLE_DEFAULTS.mudur).toContain('mesai.yonet');
    for (const role of ['kasiyer', 'garson', 'mutfak', 'kurye'] as const) expect(ROLE_DEFAULTS[role], role).not.toContain('mesai.yonet');
    expect(PERMISSION_GROUPS.find((g) => g.permissions.includes('mesai.yonet'))?.key).toBe('yonetim');

    const oldMudur = ROLE_DEFAULTS.mudur.filter((p) => p !== 'mesai.yonet');
    await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: oldMudur });
    await h.ok('patron', 'PUT', '/admin/roles/kasiyer', { permissions: [...ROLE_DEFAULTS.kasiyer, 'kasa.rakam'] });
    try {
      expect((await h.call('mudur', 'GET', '/time')).status).toBe(403);
      const { getSettings, setSyncState, upgradeRoleSets } = await import('../server/lib/settings');
      setSyncState('rol-yetki-eklemeleri', []);
      upgradeRoleSets();
      expect(getSettings().rolePermissions.mudur).toContain('mesai.yonet');
      expect(getSettings().rolePermissions.kasiyer).not.toContain('mesai.yonet');
      expect((await h.call('mudur', 'GET', '/time')).status).toBe(200);
      // Patron sonra kaldırırsa geri gelmez
      await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: oldMudur });
      upgradeRoleSets();
      expect(getSettings().rolePermissions.mudur).not.toContain('mesai.yonet');
    } finally {
      await h.ok('patron', 'PUT', '/admin/roles/mudur', { permissions: ROLE_DEFAULTS.mudur });
      await h.ok('patron', 'PUT', '/admin/roles/kasiyer', { permissions: ROLE_DEFAULTS.kasiyer });
    }
  });

  it('her yazma time konusunda olay yayar', async () => {
    const { bus } = await import('../server/lib/events');
    const seen: string[] = [];
    const listen = (e: { topic: string; kind: string }) => {
      if (e.topic === 'time') seen.push(e.kind);
    };
    bus.on('event', listen);
    const day = addDays(D, 8);
    const c = clock(at(day, 9));
    try {
      await h.ok('', 'POST', '/time/punch', { pin: PINS.garson });
      c.advance(H);
      await h.ok('', 'POST', '/time/punch', { pin: PINS.garson });
      const e = await h.ok<TimeEntryDTO>('mudur', 'POST', '/time/entries', { userId: userId('Kasa'), clockIn: at(day, 6), clockOut: at(day, 8) });
      await h.ok('mudur', 'PATCH', `/time/entries/${e.id}`, { clockOut: at(day, 8, 30) });
      await h.ok('mudur', 'DELETE', `/time/entries/${e.id}`);
    } finally {
      c.restore();
      bus.off('event', listen);
    }
    expect(seen).toEqual(['time.in', 'time.out', 'time.edit', 'time.edit', 'time.delete']);
  });
});
