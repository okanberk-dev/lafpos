import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dayText } from '@shared/gun-sonu-metni';
import { handoverByRecipient, UNSPECIFIED_RECIPIENT } from '@shared/teslim';
import { CLOSING_REMINDER_MS, closingAtMs } from '@shared/time';
import type { ZSummary } from '@shared/types';
import { CLOSING_SNOOZE_AFTER_MS, closingPhase, snoozeUntil } from '../src/lib/closingReminder';
import { type Harness, startApp } from './harness';

/**
 * Sahibin isteği (25 Kasım 2026):
 * - Ayarlarda kapanış saati; kapanışa 30 dakika kala gün açıksa sağ altta "Gün sonu al" bildirimi (src/components/
 *   ClosingReminder.tsx, kurallar src/lib/closingReminder.ts).
 * - Teslimde paranın kime verildiği yazılır (zorunlu); Z raporu, fiş ve WhatsApp metni teslimi alıcıya göre döker,
 *   lafmaliyet'e (ladmin) satırın `recipient`'ı gider (docs/03-ENTEGRASYON.md §4.7).
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
  const { updateSettings } = await import('../server/lib/settings');
  updateSettings({ demoMode: false });
  updateSettings({ okcProvider: 'kapali' });
});
afterAll(() => h.cleanup());

async function lastAudit(action: string) {
  const { db, schema } = await import('../server/db/client');
  return db.select().from(schema.auditLog).all().filter((a) => a.action === action).at(-1);
}

async function openDayId(): Promise<string> {
  const cur = await h.ok<{ day: { id: string } | null }>('mudur', 'GET', '/cash/day');
  if (cur.day) return cur.day.id;
  return (await h.ok<{ id: string }>('mudur', 'POST', '/cash/day/open', { openingCash: 0 })).id;
}

describe('Kapanış saati: ayar', () => {
  it('varsayılan kapalı (null), herkese bootstrap ile gider', async () => {
    const b = await h.ok<{ settings: { closingTime: string | null } }>('kasa', 'GET', '/bootstrap');
    expect(b.settings.closingTime).toBeNull();
  });

  it('müdür SS:DD yazar ve kapatır (null kaydı siler); bozuk saat 422; denetimde "Kapanış saati"', async () => {
    await h.ok('mudur', 'PUT', '/admin/settings', { closingTime: '23:30' });
    expect((await h.ok<{ closingTime: string | null }>('mudur', 'GET', '/admin/settings')).closingTime).toBe('23:30');
    expect((await h.ok<{ settings: { closingTime: string | null } }>('kasa', 'GET', '/bootstrap')).settings.closingTime).toBe('23:30');
    const a = await lastAudit('settings.update');
    expect(a?.message).toMatch(/Kapanış saati/);
    for (const bad of ['24:00', '7:30', '23:5', '23:30:00', 'akşam']) {
      expect((await h.call('mudur', 'PUT', '/admin/settings', { closingTime: bad })).status, bad).toBe(422);
    }
    expect((await h.ok<{ closingTime: string | null }>('mudur', 'GET', '/admin/settings')).closingTime).toBe('23:30');
    await h.ok('mudur', 'PUT', '/admin/settings', { closingTime: null });
    expect((await h.ok<{ closingTime: string | null }>('mudur', 'GET', '/admin/settings')).closingTime).toBeNull();
    // Kasiyer ayar değiştiremez
    expect((await h.call('kasa', 'PUT', '/admin/settings', { closingTime: '22:00' })).status).toBe(403);
  });

  it('closingAtMs: kapanış iş gününe yerleşir; 05:00\'e kadarki saat ertesi güne düşer, 05:00 günün sonu', () => {
    expect(new Date(closingAtMs('2026-11-25', '23:30')).toISOString()).toBe('2026-11-25T20:30:00.000Z');
    expect(new Date(closingAtMs('2026-11-25', '01:00')).toISOString()).toBe('2026-11-25T22:00:00.000Z');
    expect(new Date(closingAtMs('2026-11-25', '04:59')).toISOString()).toBe('2026-11-26T01:59:00.000Z');
    // 05:00'te kapanan dükkân: günün sonu (gün 05:00'te döner), sabahı değil; bütün gün "geçti" demez
    expect(new Date(closingAtMs('2026-11-25', '05:00')).toISOString()).toBe('2026-11-26T02:00:00.000Z');
    expect(new Date(closingAtMs('2026-11-25', '05:01')).toISOString()).toBe('2026-11-25T02:01:00.000Z');
    expect(new Date(closingAtMs('2026-11-25', '00:00')).toISOString()).toBe('2026-11-25T21:00:00.000Z');
  });
});

describe('Kapanış saati: hatırlatma kuralları', () => {
  const day = { id: 'g1', date: '2026-11-25', closedAt: null, reopenedAt: null };
  const closeAt = closingAtMs('2026-11-25', '23:00');

  it('30 dakikadan önce yok; pencerede kalan dakika; kapanıştan sonra "geçti"', () => {
    expect(closingPhase(day, '23:00', closeAt - CLOSING_REMINDER_MS - 1)).toBeNull();
    expect(closingPhase(day, '23:00', closeAt - CLOSING_REMINDER_MS)).toEqual({ kind: 'yaklasiyor', closeAt, minutesLeft: 30 });
    expect(closingPhase(day, '23:00', closeAt - 61_000)).toEqual({ kind: 'yaklasiyor', closeAt, minutesLeft: 2 });
    expect(closingPhase(day, '23:00', closeAt - 1)).toEqual({ kind: 'yaklasiyor', closeAt, minutesLeft: 1 });
    expect(closingPhase(day, '23:00', closeAt)).toEqual({ kind: 'gecti', closeAt });
    // Dünden açık kalan gün de geçti sayılır (kapanış açık günün tarihinden)
    expect(closingPhase(day, '23:00', closeAt + 10 * 3600_000)).toEqual({ kind: 'gecti', closeAt });
  });

  it('ayar kapalı, gün yok ya da kapanmış, bozuk saat: hatırlatma yok', () => {
    expect(closingPhase(day, null, closeAt)).toBeNull();
    expect(closingPhase(null, '23:00', closeAt)).toBeNull();
    expect(closingPhase({ ...day, closedAt: closeAt - 5 }, '23:00', closeAt)).toBeNull();
    expect(closingPhase(day, '9:00', closeAt)).toBeNull();
  });

  it('kapanıştan sonra yeniden açılan gün 30 dakika hatırlatılmaz, sonra yine açıksa döner; öncesinde açılan hatırlatılır', () => {
    const reopenedAt = closeAt + 60_000;
    expect(closingPhase({ ...day, reopenedAt }, '23:00', closeAt + 120_000)).toBeNull();
    expect(closingPhase({ ...day, reopenedAt }, '23:00', reopenedAt + CLOSING_REMINDER_MS - 1)).toBeNull();
    expect(closingPhase({ ...day, reopenedAt }, '23:00', reopenedAt + CLOSING_REMINDER_MS)).toEqual({ kind: 'gecti', closeAt });
    // Ertesi sabah hâlâ açık (dünden kalan gün): kart görünür
    expect(closingPhase({ ...day, reopenedAt }, '23:00', closeAt + 8 * 3600_000)).toEqual({ kind: 'gecti', closeAt });
    expect(closingPhase({ ...day, reopenedAt: closeAt - 3 * 3600_000 }, '23:00', closeAt)).toEqual({ kind: 'gecti', closeAt });
  });

  it('"Sonra": kapanıştan önce kapanışa dek, sonra 15 dakika; başka günün ertelemesi sayılmaz', () => {
    const before = closeAt - 10 * 60_000;
    const p1 = closingPhase(day, '23:00', before)!;
    const until1 = snoozeUntil(p1, before);
    expect(until1).toBe(closeAt);
    expect(closingPhase(day, '23:00', before + 60_000, { dayId: 'g1', until: until1 })).toBeNull();
    expect(closingPhase(day, '23:00', closeAt, { dayId: 'g1', until: until1 })).toEqual({ kind: 'gecti', closeAt });
    const p2 = closingPhase(day, '23:00', closeAt)!;
    const until2 = snoozeUntil(p2, closeAt);
    expect(until2).toBe(closeAt + CLOSING_SNOOZE_AFTER_MS);
    expect(closingPhase(day, '23:00', closeAt + 60_000, { dayId: 'g1', until: until2 })).toBeNull();
    expect(closingPhase(day, '23:00', closeAt + 60_000, { dayId: 'eski', until: until2 })).toEqual({ kind: 'gecti', closeAt });
  });
});

describe('Teslim: kime', () => {
  it('teslimde alıcı zorunlu; harcama ve girişte alıcı olmaz; kapalı ya da bilinmeyen hesap 422', async () => {
    await openDayId();
    const none = await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 10000 });
    expect(none.status).toBe(400);
    expect(none.json.code).toBe('recipient_required');
    expect((await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 10000, recipientName: '   ' })).json.code).toBe('recipient_required');
    const onExpense = await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'harcama', amount: 1000, description: 'Buz', recipientName: 'Banka' });
    expect(onExpense.status).toBe(400);
    expect(onExpense.json.code).toBe('recipient_not_allowed');
    expect((await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'giris', amount: 1000, recipientUserId: 'x' })).json.code).toBe('recipient_not_allowed');
    const unknown = await h.call<{ code: string }>('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 1000, recipientUserId: 'yok-boyle-biri' });
    expect(unknown.status).toBe(422);
    expect(unknown.json.code).toBe('invalid_reference');
  });

  it('hesaba teslimde ad o anki hâliyle saklanır; elle yazılan ad sadeleşir; denetimde "→ alıcı"', async () => {
    const dayId = await openDayId();
    const boot = await h.ok<{ users: { id: string; name: string; role: string }[] }>('kasa', 'GET', '/bootstrap');
    const patron = boot.users.find((u) => u.role === 'patron')!;
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 50000, description: 'Akşam teslimi', recipientUserId: patron.id });
    let a = await lastAudit('cash.teslim');
    expect(a?.message).toContain(`→ ${patron.name}`);
    expect(a?.data).toMatchObject({ recipientUserId: patron.id, recipientName: patron.name });
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 20000, recipientName: '  Banka   şubesi ' });
    a = await lastAudit('cash.teslim');
    expect(a?.message).toContain('→ Banka şubesi');
    await h.ok('kasa', 'POST', '/cash/movements', { kind: 'teslim', amount: 15000, recipientUserId: patron.id });

    const { db, schema } = await import('../server/db/client');
    const { eq } = await import('drizzle-orm');
    const rows = db.select().from(schema.cashMovements).where(eq(schema.cashMovements.dayId, dayId)).all().filter((m) => m.kind === 'teslim');
    expect(rows.map((m) => [m.amount, m.recipientUserId, m.recipientName])).toEqual([
      [50000, patron.id, patron.name],
      [20000, null, 'Banka şubesi'],
      [15000, patron.id, patron.name],
    ]);
    // Alıcısız eski teslim (bu özellikten önce): "Belirtilmemiş" satırında sayılır
    db.insert(schema.cashMovements).values({ id: '01OLDTESLIM0000000000000000'.slice(0, 26), dayId, kind: 'teslim', amount: 5000, description: 'eski', userId: null, createdAt: Date.now() }).run();

    // Ara rapor: teslim toplamı aynı formül, alıcıya göre döküm (Σ = handedOver), hareket listesinde alıcı
    const x = await h.ok<{ summary: ZSummary; movements: { kind: string; recipientName: string | null }[] }>('mudur', 'GET', '/cash/day');
    expect(x.summary.handedOver).toBe(90000);
    expect(x.summary.handedOverBy).toEqual([
      { userId: patron.id, name: patron.name, count: 2, amount: 65000 },
      { userId: null, name: 'Banka şubesi', count: 1, amount: 20000 },
      { userId: null, name: UNSPECIFIED_RECIPIENT, count: 1, amount: 5000 },
    ]);
    expect(x.summary.handedOverBy!.reduce((s, r) => s + r.amount, 0)).toBe(x.summary.handedOver);
    expect(x.movements.filter((m) => m.kind === 'teslim').map((m) => m.recipientName)).toEqual([patron.name, 'Banka şubesi', patron.name, null]);

    // lafmaliyet gövdesi: teslim satırının sonunda `recipient`, alıcısız eski teslimde ve öteki türlerde alan yok
    const p = await h.ok<{ cashMoves: Record<string, unknown>[] }>('patron', 'GET', `/sync/lafmaliyet/gun/${dayId}`);
    const teslim = p.cashMoves.filter((m) => m.kind === 'teslim');
    expect(teslim.map((m) => m.recipient)).toEqual([patron.name, 'Banka şubesi', patron.name, undefined]);
    expect(Object.keys(teslim[0]!).at(-1)).toBe('recipient');
    expect(p.cashMoves.filter((m) => m.kind !== 'teslim').every((m) => !('recipient' in m))).toBe(true);
    expect(JSON.stringify(p.cashMoves)).not.toMatch(/userId|recipientUserId/);
  });

  it('teslimsiz günün özetinde döküm alanı yok (eski Z ile aynı biçim)', () => {
    expect(handoverByRecipient([{ kind: 'harcama', amount: 100 }, { kind: 'giris', amount: 50 }])).toEqual([]);
  });

  it('döküm: aynı ad büyük-küçük harf farkıyla tek satır, tutara göre azalan, eşitlikte ada göre', () => {
    expect(
      handoverByRecipient([
        { kind: 'teslim', amount: 100, recipientName: 'Banka' },
        { kind: 'teslim', amount: 300, recipientName: 'banka ' },
        { kind: 'teslim', amount: 400, recipientName: 'Ceren' },
        { kind: 'teslim', amount: 400, recipientName: 'Ali' },
        { kind: 'harcama', amount: 999, recipientName: 'Ali' },
      ]),
    ).toEqual([
      { userId: null, name: 'Ali', count: 1, amount: 400 },
      { userId: null, name: 'Banka', count: 2, amount: 400 },
      { userId: null, name: 'Ceren', count: 1, amount: 400 },
    ]);
  });

  it('WhatsApp metni: Kasa bölümünde harcama ve teslim kime gittiğiyle', () => {
    const s = {
      netSales: 100000,
      receipts: 10,
      payments: [],
      byZField: { cash: 0, card: 0, meal_card: 0, online: 0, other: 0 },
      discounts: 0,
      complimentary: 0,
      voided: 0,
      cashOut: 4500,
      handedOver: 70000,
      handedOverBy: [
        { userId: 'u1', name: 'Patron', count: 1, amount: 50000 },
        { userId: null, name: 'Banka', count: 1, amount: 20000 },
      ],
      expectedCash: 10000,
      countedCash: null,
      cashDiff: null,
      topProducts: [],
    } as unknown as ZSummary;
    const text = dayText({ branch: 'Marina', date: '2026-11-25', zNo: 12, s });
    expect(text).toContain('• Harcama: ₺45,00');
    expect(text).toContain('• Teslim: ₺700,00 (Patron ₺500,00, Banka ₺200,00)');
  });
});
