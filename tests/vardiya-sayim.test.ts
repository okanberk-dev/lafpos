import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { OrderDTO, ShiftCountDTO, ZSummary } from '@shared/types';
import { type Harness, PINS, startApp } from './harness';

/**
 * Vardiya kasa sayımı: açık ve bugünün günü ister, kasa.gun doğrudan; beklenen nakit o anki ara rapordan; kör kasada
 * beklenen ve fark gitmez (başkasının sayımında sayılan da); devralan PIN'iyle onaylar; fark eşiğe göre denetim
 * kaydına bilgi, uyarı ya da alarm; beklenen nakdi ve Z'yi değiştirmez.
 */
let h: Harness;
let auth: typeof import('../server/lib/auth');
beforeAll(async () => {
  h = await startApp();
  auth = await import('../server/lib/auth');
});
afterAll(() => h.cleanup());

const userId = (name: string) => h.boot.users.find((u) => u.name === name)!.id;
const codeOf = async (p: Promise<{ status: number; json: unknown }>) => {
  const r = await p;
  return [r.status, (r.json as { code?: string }).code];
};
type CashDay = { day: { id: string; zNo: number } | null; summary: ZSummary | null; shiftCounts: ShiftCountDTO[]; blind: boolean };
const expected = async () => (await h.ok<CashDay>('mudur', 'GET', '/cash/day')).summary!.expectedCash;
type AuditRow = { action: string; severity: string; message: string; amount: number | null; userName: string | null; approverName: string | null; entityId: string | null };
const shiftAudit = async (id: string) => (await h.ok<AuditRow[]>('patron', 'GET', '/admin/audit?limit=100')).find((a) => a.action === 'cash.shift_count' && a.entityId === id)!;

let staleDayId = '';

describe('vardiya sayımı: gün', () => {
  it('açık gün yoksa 409 day_closed; dünden açık kalan günde 409 stale_day', async () => {
    expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: 0 }))).toEqual([409, 'day_closed']);
    expect(await h.ok('kasa', 'GET', '/cash/shift-counts')).toEqual([]);
    // Dün açılıp gün sonu alınmamış gün
    const yesterday = Date.now() - 86400_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => yesterday);
    try {
      staleDayId = (await h.ok<{ id: string }>('kasa', 'POST', '/cash/day/open', { openingCash: 0 })).id;
    } finally {
      clock.mockRestore();
    }
    const stale = await h.call<{ code: string; error: string }>('kasa', 'POST', '/cash/shift-counts', { countedCash: 0 });
    expect([stale.status, stale.json.code]).toEqual([409, 'stale_day']);
    expect(stale.json.error).toContain('Önce gün sonunu alın');
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: null });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 50000 });
  });
});

describe('vardiya sayımı', () => {
  it('nakit satıştan sonra kör kasiyer sayar: yanıtta beklenen ve fark yok; yönetici görür; uyarı düşer', async () => {
    const cash = h.boot.paymentMethods.find((m) => m.name === 'Nakit')!;
    let o = await h.ok<OrderDTO>('kasa', 'POST', '/orders', { type: 'tezgah' });
    o = await h.ok<OrderDTO>('kasa', 'POST', `/orders/${o.id}/items`, { items: [{ productId: h.boot.products.find((p) => p.name === 'Latte')!.id, size: 'M', qty: 2 }] });
    await h.ok('kasa', 'POST', `/orders/${o.id}/payments`, { methodId: cash.id, amount: o.total, given: o.total });
    const exp = await expected();
    expect(exp).toBe(50000 + o.total);

    const blind = await h.ok<ShiftCountDTO>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp - 1250, toUserId: userId('Garson'), note: 'Akşam vardiyası' });
    expect(blind).toMatchObject({ userName: 'Kasa', toUserName: 'Garson', confirmed: false, counted: exp - 1250, expected: null, diff: null, note: 'Akşam vardiyası', banknotes: null });
    expect(blind.shiftDiff).toBeNull();
    const seen = (await h.ok<ShiftCountDTO[]>('mudur', 'GET', '/cash/shift-counts')).find((s) => s.id === blind.id)!;
    expect(seen).toMatchObject({ counted: exp - 1250, expected: exp, diff: -1250, shiftDiff: -1250 });
    const a = await shiftAudit(blind.id);
    expect(a).toMatchObject({ severity: 'uyari', amount: -1250, userName: 'Kasa', approverName: null });
    expect(a.message).toMatch(/^Kasa vardiyayı devretti, kasayı Garson devraldı \(Z \d+\): sayılan ₺[\d.,]+, fark -₺12,50$/);
    // Kasa hareketi değildir: beklenen nakit aynı
    expect(await expected()).toBe(exp);
  });

  it('fark vardiyanın kendisininki (önceki sayımdan bu yana): fark yoksa bilgi, eşiği aşan alarm; devralansız ara sayım', async () => {
    const exp = await expected();
    // Önceki sayım 12,50 eksikti, para bulundu: gün toplamı denk, bu sayımın farkı +12,50
    const found = await h.ok<ShiftCountDTO>('mudur', 'POST', '/cash/shift-counts', { countedCash: exp });
    expect(found).toMatchObject({ toUserId: null, expected: exp, diff: 0, shiftDiff: 1250 });
    const fa = await shiftAudit(found.id);
    expect(fa).toMatchObject({ severity: 'uyari', amount: 1250 });
    expect(fa.message).toMatch(/: sayılan ₺[\d.,]+, bu vardiyada fark \+₺12,50 \(gün toplamı denk\)$/);
    const even = await h.ok<ShiftCountDTO>('mudur', 'POST', '/cash/shift-counts', { countedCash: exp });
    expect(even).toMatchObject({ diff: 0, shiftDiff: 0 });
    const ea = await shiftAudit(even.id);
    expect(ea.severity).toBe('info');
    expect(ea.message).toMatch(/^Müdür vardiya sayımı yaptı \(Z \d+\): sayılan ₺[\d.,]+, fark yok$/);
    const big = await h.ok<ShiftCountDTO>('mudur', 'POST', '/cash/shift-counts', { countedCash: exp + 10000 });
    expect([big.diff, big.shiftDiff]).toEqual([10000, 10000]);
    expect((await shiftAudit(big.id)).severity).toBe('alarm');
  });

  it('kasa.gun doğrudan ister: garson sayamaz', async () => {
    const r = await h.call<{ code: string; permission: string }>('garson', 'POST', '/cash/shift-counts', { countedCash: 1000 });
    expect([r.status, r.json.code, r.json.permission]).toEqual([403, 'forbidden', 'kasa.gun']);
  });

  it('devralan PIN\'iyle onaylar; başka birinin PIN\'i hatalı PIN gibi reddedilir; devralan seçilmediyse PIN\'in sahibi', async () => {
    auth.resetFailures();
    try {
      // Önceki ara sayımda fazla çıkan 100 TL çekmecede: bu devrin kendi farkı yok
      const exp = (await expected()) + 10000;
      const wrongPerson = await h.call<{ code: string; error: string }>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp, toUserId: userId('Müdür'), approverPin: PINS.garson });
      const wrongPin = await h.call<{ code: string; error: string }>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp, toUserId: userId('Müdür'), approverPin: '9898' });
      expect([wrongPerson.status, wrongPerson.json.code]).toEqual([403, 'approval_invalid']);
      expect(wrongPerson).toEqual(wrongPin);
      expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: exp, approverPin: PINS.kasa }))).toEqual([403, 'approval_invalid']);

      const confirmed = await h.ok<ShiftCountDTO>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp, toUserId: userId('Müdür'), approverPin: PINS.mudur });
      expect(confirmed).toMatchObject({ toUserName: 'Müdür', confirmed: true, expected: null, diff: null });
      const a = await shiftAudit(confirmed.id);
      expect(a).toMatchObject({ approverName: 'Müdür', severity: 'info' });
      expect(a.message).toContain('kasayı Müdür devraldı (PIN ile onayladı)');

      const byPin = await h.ok<ShiftCountDTO>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp, approverPin: PINS.garson });
      expect(byPin).toMatchObject({ toUserId: userId('Garson'), toUserName: 'Garson', confirmed: true });
    } finally {
      auth.resetFailures();
    }
  });

  it('girdi: kendine devir yok, bilinmeyen devralan 422, banknot toplamı sayılanla aynı olmalı', async () => {
    expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: 1000, toUserId: userId('Kasa') }))).toEqual([400, 'self_handover']);
    expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: 1000, toUserId: 'yok-boyle-biri' }))).toEqual([422, 'invalid_reference']);
    expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: 25000, banknotes: { '20000': 1, '1000': 4 } }))).toEqual([422, 'validation']);
    expect(await codeOf(h.call('kasa', 'POST', '/cash/shift-counts', { countedCash: 1000, banknotes: { '₺10': 1 } }))).toEqual([422, 'validation']);
    const notes = await h.ok<ShiftCountDTO>('kasa', 'POST', '/cash/shift-counts', { countedCash: 25000, banknotes: { '20000': 1, '1000': 5, '500': 0 } });
    expect(notes.banknotes).toEqual({ '20000': 1, '1000': 5 });
  });

  it('kasa ekranı ve gün dökümü sayımları taşır; kör kasiyer başkasının sayımında tutarı da görmez', async () => {
    const mine = await h.ok<CashDay>('kasa', 'GET', '/cash/day');
    expect(mine.blind).toBe(true);
    expect(mine.shiftCounts.length).toBeGreaterThanOrEqual(6);
    expect(mine.shiftCounts.every((s) => s.expected === null && s.diff === null && s.shiftDiff === null)).toBe(true);
    // Kendi sayımı ve devraldığı sayım tutarlı; yalnız müdürün kendi ara sayımı (devralansız) tutarsız
    for (const s of mine.shiftCounts) {
      const own = s.userName === 'Kasa' || s.toUserName === 'Kasa';
      expect(s.counted === null, `${s.userName} → ${s.toUserName}`).toBe(!own);
    }
    expect(mine.shiftCounts.filter((s) => s.counted === null).map((s) => s.userName)).toEqual(['Müdür', 'Müdür', 'Müdür']);
    // Sırayla (ilk sayım ilk)
    expect(mine.shiftCounts.map((s) => s.createdAt)).toEqual([...mine.shiftCounts.map((s) => s.createdAt)].sort((a, b) => a - b));

    const boss = await h.ok<CashDay>('patron', 'GET', '/cash/day');
    expect(boss.shiftCounts.every((s) => s.counted !== null && s.expected !== null && s.diff !== null && s.shiftDiff !== null)).toBe(true);
    // Vardiyanın farkı önceki sayımdan bu yana: farkların farkı
    boss.shiftCounts.forEach((s, i) => expect(s.shiftDiff, s.id).toBe(s.diff! - (i ? boss.shiftCounts[i - 1].diff! : 0)));
    const dayId = boss.day!.id;
    const detail = await h.ok<{ shiftCounts: ShiftCountDTO[] }>('patron', 'GET', `/cash/days/${dayId}`);
    expect(detail.shiftCounts).toEqual(boss.shiftCounts);
    expect(await h.ok<ShiftCountDTO[]>('patron', 'GET', `/cash/shift-counts?dayId=${dayId}`)).toEqual(boss.shiftCounts);
  });

  it('başka bir günün sayımları rapor yetkisi ister', async () => {
    expect(await codeOf(h.call('kasa', 'GET', `/cash/shift-counts?dayId=${staleDayId}`))).toEqual([403, 'forbidden']);
    expect(await h.ok('mudur', 'GET', `/cash/shift-counts?dayId=${staleDayId}`)).toEqual([]);
    expect(await codeOf(h.call('mudur', 'GET', '/cash/shift-counts?dayId=yok-boyle-gun'))).toEqual([404, 'not_found']);
  });

  it('önceki devirde bulunan eksik sonraki devirde yeniden alarm olmaz, devralana yazılmaz (inceleme)', async () => {
    const exp = await expected();
    const before = (await h.ok<ShiftCountDTO[]>('patron', 'GET', '/cash/shift-counts')).at(-1)!.diff!;
    // Kasa kasayı Müdür'e 150 TL eksik devreder: alarm
    const short = await h.ok<ShiftCountDTO>('kasa', 'POST', '/cash/shift-counts', { countedCash: exp + before - 15000, toUserId: userId('Müdür') });
    expect((await shiftAudit(short.id)).severity).toBe('alarm');
    // Müdür aldığı kadarını Kasa'ya devreder: kendi vardiyası tuttu; gün toplamındaki eksik yine görünür ama alarm değil
    const next = await h.ok<ShiftCountDTO>('mudur', 'POST', '/cash/shift-counts', { countedCash: exp + before - 15000, toUserId: userId('Kasa') });
    expect([next.diff, next.shiftDiff]).toEqual([before - 15000, 0]);
    const a = await shiftAudit(next.id);
    expect(a).toMatchObject({ severity: 'info', amount: 0 });
    expect(a.message).toContain('bu vardiyada fark yok (gün toplamı -₺');
  });

  it('canlı olay cash konusunda; gün sonu ve Z sayımlardan etkilenmez', async () => {
    const { bus } = await import('../server/lib/events');
    const seen: string[] = [];
    const listen = (e: { topic: string; kind: string }) => {
      if (e.topic === 'cash') seen.push(e.kind);
    };
    bus.on('event', listen);
    const exp = await expected();
    try {
      await h.ok('kasa', 'POST', '/cash/shift-counts', { countedCash: exp });
    } finally {
      bus.off('event', listen);
    }
    expect(seen).toEqual(['shift.counted']);
    const closed = await h.ok<{ summary: ZSummary }>('mudur', 'POST', '/cash/day/close', { countedCash: exp });
    expect(closed.summary).toMatchObject({ expectedCash: exp, countedCash: exp, cashDiff: 0 });
  });
});
