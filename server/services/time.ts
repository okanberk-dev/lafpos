import { and, asc, desc, eq, gt, gte, isNull, lt, lte, ne, or } from 'drizzle-orm';
import { TIME_SOURCE_LABEL } from '@shared/labels';
import { addDays, businessDate, fmtDateTime, fmtTime, istanbulParts, MAX_SHIFT_MS, STALE_SHIFT_MS } from '@shared/time';
import type { MyTimeDTO, PunchResultDTO, TimeEntryDTO, TimeSheetDTO, TimeSheetTotalDTO } from '@shared/types';
import { type DB, schema, type Tx } from '../db/client';
import type { AuthUser } from '../lib/auth';
import { toCsv } from '../lib/csv';
import type { Effects } from '../lib/effects';
import { bad, conflict, HttpError, notFound } from '../lib/http';
import { ulid } from '../lib/ids';

/**
 * Mesai (personel giriş-çıkışı). Kişi kendi girişini kasa kabuğundan (oturum) ya da kilit ekranında PIN'le yapar;
 * yönetici (`mesai.yonet`) çizelgeyi görür, elle mesai girer, düzeltir, açık mesaiyi kapatır, siler. Kurallar her
 * yazmada: çıkış girişten sonra, ileri tarih yok, mesai en çok 24 saat, kişi başına tek açık mesai, aynı kişinin
 * mesaileri çakışmaz (uç uca olabilir). İş günü girişten (05:00 kuralı). Yöneticinin her yazması denetim kaydına
 * düşer; kişinin kendi giriş-çıkışı kaydın kendisidir, denetime yazılmaz.
 */

type EntryRow = typeof schema.timeEntries.$inferSelect;
type Person = { id: string; name: string };

export { MAX_SHIFT_MS };
/** Çizelge dönemi en çok 93 gün (üç ay) */
export const MAX_SHEET_DAYS = 93;
/** Yön verilmeden aynı kişinin bu süre içindeki ikinci basışı yok sayılır (çift dokunuş, yanıtı kaybolup yinelenen istek) */
export const REPEAT_PUNCH_MS = 60_000;
/** Cihaz saati sunucudan biraz ileride olabilir: bu kadar ileriye girilen saat "şimdi" sayılır */
const CLOCK_SKEW_MS = 60_000;

const T = schema.timeEntries;

function people(t: Tx | DB) {
  return new Map(
    t
      .select({ id: schema.users.id, name: schema.users.name, color: schema.users.color })
      .from(schema.users)
      .all()
      .map((u) => [u.id, u]),
  );
}
type People = ReturnType<typeof people>;

/** Açık mesai şimdiye kadar, ama en çok 24 saat: çıkışı unutulan mesai toplamları ve CSV'yi günlerce şişirmesin */
const durationOf = (e: EntryRow, now: number) => Math.max(0, Math.min(e.clockOut ?? now, e.clockIn + MAX_SHIFT_MS) - e.clockIn);

function toDTO(e: EntryRow, who: People, now: number): TimeEntryDTO {
  const u = who.get(e.userId);
  return {
    id: e.id,
    userId: e.userId,
    userName: u?.name ?? 'Bilinmiyor',
    userColor: u?.color ?? '#616367',
    clockIn: e.clockIn,
    clockOut: e.clockOut,
    businessDate: e.businessDate,
    note: e.note,
    source: e.source,
    editedBy: e.editedBy,
    editedByName: e.editedBy ? (who.get(e.editedBy)?.name ?? null) : null,
    createdAt: e.createdAt,
    durationMs: durationOf(e, now),
    open: e.clockOut == null,
  };
}

export function entryDTO(t: Tx | DB, e: EntryRow, now = Date.now()): TimeEntryDTO {
  return toDTO(e, people(t), now);
}

function loadEntry(t: Tx | DB, id: string): EntryRow {
  const e = t.select().from(T).where(eq(T.id, id)).get();
  if (!e) throw notFound('Mesai kaydı');
  return e;
}

function openEntryOf(t: Tx | DB, userId: string): EntryRow | undefined {
  return t
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), isNull(T.clockOut)))
    .get();
}

/** "02.11.2026 09:00–17:30"; ertesi gün biterse çıkış tarihiyle, açık mesaide "02.11.2026 09:00–açık" */
function span(clockIn: number, clockOut: number | null): string {
  if (clockOut == null) return `${fmtDateTime(clockIn)}–açık`;
  return `${fmtDateTime(clockIn)}–${sameDate(clockIn, clockOut) ? fmtTime(clockOut) : fmtDateTime(clockOut)}`;
}

const sameDate = (a: number, b: number) => istanbulParts(a).date === istanbulParts(b).date;

/** Düzeltmenin yeni saati: eski saatle aynı takvim günündeyse yalnız saat */
const nextTime = (ms: number | null, ref: number | null) => (ms == null ? 'açık' : ref != null && sameDate(ms, ref) ? fmtTime(ms) : fmtDateTime(ms));

const cleanNote = (note: string | null | undefined) => note?.trim() || null;

/**
 * Mesainin kuralları (elle giriş, düzeltme, kapatma, kişinin kendi girişi). Saatleri doğrulanmış hâliyle döner: cihaz
 * saatinin bir dakikalık ilerisi şimdiye çekilir. `exceptId`: düzeltilen kaydın kendisi (kendisiyle çakışmaz).
 */
function checkSpan(t: Tx, person: Person, clockIn: number, clockOut: number | null, now: number, exceptId?: string) {
  if (clockIn > now + CLOCK_SKEW_MS) throw bad('İleri bir saate mesai girilemez', 'future_time');
  const start = Math.min(clockIn, now);
  let end: number | null = null;
  if (clockOut != null) {
    if (clockOut > now + CLOCK_SKEW_MS) throw bad('Mesai ileri bir saatte bitemez', 'future_time');
    end = Math.min(clockOut, now);
    if (end <= start) throw bad('Çıkış saati girişten sonra olmalı', 'time_order');
    if (end - start > MAX_SHIFT_MS) throw bad('Bir mesai en çok 24 saat olabilir', 'shift_too_long');
  } else {
    if (now - start > MAX_SHIFT_MS) throw bad('Açık mesai 24 saatten eski olamaz; çıkış saatini de girin', 'shift_too_long');
    const open = openEntryOf(t, person.id);
    if (open && open.id !== exceptId) throw conflict(`${person.name} zaten içeride (giriş ${fmtDateTime(open.clockIn)}); önce o mesaiyi kapatın`, 'already_clocked_in');
  }
  // Çakışma: aynı kişinin başka bir mesaisi bu aralığa giriyor (açık mesai şimdiye, sonrasına uzanır); uç uca olabilir
  const clash = t
    .select()
    .from(T)
    .where(
      and(
        eq(T.userId, person.id),
        exceptId ? ne(T.id, exceptId) : undefined,
        end == null ? undefined : lt(T.clockIn, end),
        or(isNull(T.clockOut), gt(T.clockOut, start)),
      ),
    )
    .orderBy(asc(T.clockIn))
    .get();
  if (clash) throw conflict(`${person.name} için bu saatlerle çakışan bir mesai var: ${span(clash.clockIn, clash.clockOut)}`, 'overlap');
  return { clockIn: start, clockOut: end };
}

// ─── Kişinin kendi giriş-çıkışı ──────────────────────────────────────────────

export function clockIn(t: Tx, person: Person, fx: Effects, source: 'pin' | 'oturum', now = Date.now()): EntryRow {
  const open = openEntryOf(t, person.id);
  if (open) throw conflict(`Zaten içeridesiniz (giriş ${fmtDateTime(open.clockIn)})`, 'already_clocked_in');
  checkSpan(t, person, now, null, now);
  const row: EntryRow = { id: ulid(now), userId: person.id, clockIn: now, clockOut: null, businessDate: businessDate(now), note: null, source, editedBy: null, createdAt: now };
  t.insert(T).values(row).run();
  fx.emit({ topic: 'time', kind: 'time.in', byUserId: person.id });
  return row;
}

export function clockOut(t: Tx, person: Person, fx: Effects, now = Date.now()): EntryRow {
  const open = openEntryOf(t, person.id);
  if (!open) throw conflict('Açık mesainiz yok; önce giriş yapın', 'not_clocked_in');
  // Çıkışı unutulmuş eski mesai şimdiye uzatılmaz: saati bir yetkili girer (Yönetim › Mesai)
  if (now - open.clockIn > MAX_SHIFT_MS) {
    throw conflict(`Girişiniz 24 saatten eski (${fmtDateTime(open.clockIn)}); çıkış saatini bir yetkili düzeltsin`, 'shift_too_long');
  }
  if (now <= open.clockIn) throw conflict('Çıkış saati girişten sonra olmalı', 'time_order');
  t.update(T).set({ clockOut: now }).where(eq(T.id, open.id)).run();
  fx.emit({ topic: 'time', kind: 'time.out', byUserId: person.id });
  return { ...open, clockOut: now };
}

/** Bir iş gününde çalışılan süre */
function workedOn(t: Tx | DB, userId: string, date: string, now: number): number {
  return t
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), eq(T.businessDate, date)))
    .all()
    .reduce((a, e) => a + durationOf(e, now), 0);
}

/**
 * Kilit ekranında PIN'le giriş-çıkış (oturum açılmaz). Yön verilmezse durum değişir: içerideyse çıkış, değilse giriş.
 * Yön verilmeden aynı kişinin kendi basışından bir dakika içinde gelen ikinci basış yok sayılır (çift dokunuş ya da
 * yanıtı kaybolup yinelenen istek kişiyi az önce girdiği mesaiden çıkarmasın); durum olduğu gibi döner. Yönsüz basış
 * çıkışı unutulmuş eski mesaiyi (`STALE_SHIFT_MS`) şimdiye kapatmaz: sabah işe gelen kişi dünkü mesaiyi 19 saatle
 * kapatıp dışarıda kalmasın; çıkış saatini bir yetkili girer. `todayMs` girişte bugünün, çıkışta kapanan mesainin iş
 * gününün toplamı.
 */
export function punch(t: Tx, person: Person & { color: string }, fx: Effects, action: 'in' | 'out' | undefined, now = Date.now()): PunchResultDTO {
  const user = { id: person.id, name: person.name, color: person.color };
  const open = openEntryOf(t, person.id);
  if (!action) {
    const last = open ?? t.select().from(T).where(eq(T.userId, person.id)).orderBy(desc(T.clockIn)).get();
    const at = last ? (last.clockOut ?? last.clockIn) : null;
    // Yalnız kişinin kendi basışı: yöneticinin az önce kapattığı ya da girdiği mesai yinelenen basış sayılmaz
    const own = last && last.editedBy == null && last.source !== 'yonetim';
    if (last && own && at != null && now - at < REPEAT_PUNCH_MS) {
      return { user, state: open ? 'in' : 'out', entry: entryDTO(t, last, now), todayMs: workedOn(t, person.id, open ? businessDate(now) : last.businessDate, now), repeated: true };
    }
  }
  if (!action && open && now - open.clockIn > STALE_SHIFT_MS) {
    throw conflict(`Açık kalmış bir mesainiz var (giriş ${fmtDateTime(open.clockIn)}); çıkışı unutulmuş olabilir. Çıkış saatini bir yetkili girsin, sonra yeniden basın`, 'stale_shift');
  }
  const goIn = action ? action === 'in' : !open;
  const row = goIn ? clockIn(t, person, fx, 'pin', now) : clockOut(t, person, fx, now);
  return { user, state: goIn ? 'in' : 'out', entry: entryDTO(t, row, now), todayMs: workedOn(t, person.id, goIn ? businessDate(now) : row.businessDate, now), repeated: false };
}

/** Kişinin kendi mesaisi: açık mesai, bugün (iş günü) ve son 7 iş günü; açık mesai şimdiye kadar sayılır */
export function myTime(t: Tx | DB, userId: string, now = Date.now()): MyTimeDTO {
  const who = people(t);
  const today = businessDate(now);
  const week = t
    .select()
    .from(T)
    .where(and(eq(T.userId, userId), gte(T.businessDate, addDays(today, -6)), lte(T.businessDate, today)))
    .orderBy(asc(T.clockIn))
    .all();
  const open = openEntryOf(t, userId);
  const entries = week.filter((e) => e.businessDate === today).map((e) => toDTO(e, who, now));
  return {
    open: open ? toDTO(open, who, now) : null,
    today: { date: today, workedMs: entries.reduce((a, e) => a + e.durationMs, 0), entries },
    weekMs: week.reduce((a, e) => a + durationOf(e, now), 0),
    serverTime: now,
  };
}

// ─── Yönetici: çizelge ve düzeltmeler (mesai.yonet) ─────────────────────────

/**
 * Yönetici kendi mesaisini düzeltemez, kendine elle mesai giremez (patron hariç): saatini kendisi uzatmasın. Kendi
 * giriş-çıkışı her zamanki gibi.
 */
function assertNotSelf(actor: AuthUser, userId: string) {
  if (actor.role !== 'patron' && actor.id === userId) {
    throw new HttpError(403, 'Kendi mesai kaydınızı düzeltemezsiniz; başka bir yetkili düzeltsin', 'self_edit');
  }
}

function personOf(t: Tx, userId: string): Person {
  const u = t.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(eq(schema.users.id, userId)).get();
  if (!u) throw notFound('Personel');
  return u;
}

export function createEntry(
  t: Tx,
  actor: AuthUser,
  fx: Effects,
  input: { userId: string; clockIn: number; clockOut?: number | null; note?: string | null },
  now = Date.now(),
): EntryRow {
  const person = personOf(t, input.userId);
  assertNotSelf(actor, person.id);
  const s = checkSpan(t, person, input.clockIn, input.clockOut ?? null, now);
  const row: EntryRow = {
    id: ulid(now),
    userId: person.id,
    clockIn: s.clockIn,
    clockOut: s.clockOut,
    businessDate: businessDate(s.clockIn),
    note: cleanNote(input.note),
    source: 'yonetim',
    editedBy: actor.id,
    createdAt: now,
  };
  t.insert(T).values(row).run();
  fx.audit(t, {
    userId: actor.id,
    action: 'time.create',
    severity: 'info',
    entity: 'time_entry',
    entityId: row.id,
    message: `${actor.name}, ${person.name} için mesai girdi: ${span(row.clockIn, row.clockOut)}${row.note ? ` (${row.note})` : ''}`,
    data: { userId: person.id, clockIn: row.clockIn, clockOut: row.clockOut },
  });
  fx.emit({ topic: 'time', kind: 'time.edit', byUserId: actor.id });
  return row;
}

/** Düzeltme: gönderilen alanlar değişir; çıkış null gönderilirse mesai yeniden açılır (kurallar yine geçerli) */
export function editEntry(
  t: Tx,
  actor: AuthUser,
  fx: Effects,
  id: string,
  patch: { clockIn?: number; clockOut?: number | null; note?: string | null },
  now = Date.now(),
): EntryRow {
  const row = loadEntry(t, id);
  const person = personOf(t, row.userId);
  assertNotSelf(actor, person.id);
  const wantIn = patch.clockIn ?? row.clockIn;
  const wantOut = patch.clockOut === undefined ? row.clockOut : patch.clockOut;
  const s = wantIn !== row.clockIn || wantOut !== row.clockOut ? checkSpan(t, person, wantIn, wantOut, now, row.id) : { clockIn: row.clockIn, clockOut: row.clockOut };
  const note = patch.note === undefined ? row.note : cleanNote(patch.note);
  const changes = [
    s.clockIn !== row.clockIn && `giriş ${fmtDateTime(row.clockIn)} → ${nextTime(s.clockIn, row.clockIn)}`,
    s.clockOut !== row.clockOut && `çıkış ${row.clockOut == null ? 'açık' : fmtDateTime(row.clockOut)} → ${nextTime(s.clockOut, row.clockOut ?? row.clockIn)}`,
    note !== row.note && (note ? `not: ${note}` : 'not silindi'),
  ].filter((x): x is string => !!x);
  // Değişmeyen düzeltme yazılmaz, denetime düşmez
  if (!changes.length) return row;
  const next: EntryRow = { ...row, clockIn: s.clockIn, clockOut: s.clockOut, businessDate: businessDate(s.clockIn), note, editedBy: actor.id };
  t.update(T).set({ clockIn: next.clockIn, clockOut: next.clockOut, businessDate: next.businessDate, note: next.note, editedBy: next.editedBy }).where(eq(T.id, row.id)).run();
  fx.audit(t, {
    userId: actor.id,
    action: 'time.edit',
    severity: 'uyari',
    entity: 'time_entry',
    entityId: row.id,
    message: `${actor.name}, ${person.name} mesaisini düzeltti: ${changes.join(', ')}`,
    data: { userId: person.id, before: { clockIn: row.clockIn, clockOut: row.clockOut, note: row.note }, after: { clockIn: next.clockIn, clockOut: next.clockOut, note: next.note } },
  });
  fx.emit({ topic: 'time', kind: 'time.edit', byUserId: actor.id });
  return next;
}

/** Açık mesaiyi kapatır: şimdi ya da verilen saatte (çıkışı unutulmuş mesai) */
export function closeEntry(t: Tx, actor: AuthUser, fx: Effects, id: string, at: number | undefined, now = Date.now()): EntryRow {
  const row = loadEntry(t, id);
  if (row.clockOut != null) throw conflict('Bu mesai zaten kapalı', 'entry_closed');
  const person = personOf(t, row.userId);
  assertNotSelf(actor, person.id);
  const s = checkSpan(t, person, row.clockIn, at ?? now, now, row.id);
  const next: EntryRow = { ...row, clockOut: s.clockOut, editedBy: actor.id };
  t.update(T).set({ clockOut: next.clockOut, editedBy: actor.id }).where(eq(T.id, row.id)).run();
  fx.audit(t, {
    userId: actor.id,
    action: 'time.close',
    severity: 'info',
    entity: 'time_entry',
    entityId: row.id,
    message: `${actor.name}, ${person.name} için açık mesaiyi kapattı: ${span(next.clockIn, next.clockOut)}`,
    data: { userId: person.id, clockIn: next.clockIn, clockOut: next.clockOut },
  });
  fx.emit({ topic: 'time', kind: 'time.edit', byUserId: actor.id });
  return next;
}

export function deleteEntry(t: Tx, actor: AuthUser, fx: Effects, id: string) {
  const row = loadEntry(t, id);
  const person = personOf(t, row.userId);
  assertNotSelf(actor, person.id);
  t.delete(T).where(eq(T.id, row.id)).run();
  fx.audit(t, {
    userId: actor.id,
    action: 'time.delete',
    severity: 'uyari',
    entity: 'time_entry',
    entityId: row.id,
    message: `${actor.name}, ${person.name} mesaisini sildi: ${span(row.clockIn, row.clockOut)}${row.note ? ` (${row.note})` : ''}`,
    data: { userId: person.id, clockIn: row.clockIn, clockOut: row.clockOut, note: row.note, source: row.source },
  });
  fx.emit({ topic: 'time', kind: 'time.delete', byUserId: actor.id });
}

/**
 * Mesai çizelgesi: dönemin iş günlerindeki mesailer (en yeni üstte), kişi toplamları (ada göre) ve şu an içeride
 * olanlar (dönemden bağımsız: çıkışı unutulan eski mesai de görünür). `userId` verilirse yalnız o kişi.
 */
export function timeSheet(t: Tx | DB, range: { from: string; to: string; userId?: string }, now = Date.now()): TimeSheetDTO {
  const who = people(t);
  const mine = range.userId ? eq(T.userId, range.userId) : undefined;
  const rows = t
    .select()
    .from(T)
    .where(and(gte(T.businessDate, range.from), lte(T.businessDate, range.to), mine))
    .orderBy(desc(T.clockIn))
    .all();
  const open = t.select().from(T).where(and(isNull(T.clockOut), mine)).orderBy(asc(T.clockIn)).all();
  const inside = new Set(open.map((e) => e.userId));
  const entries = rows.map((e) => toDTO(e, who, now));
  const totals = new Map<string, TimeSheetTotalDTO>();
  for (const e of entries) {
    const row = totals.get(e.userId) ?? { userId: e.userId, userName: e.userName, userColor: e.userColor, workedMs: 0, shifts: 0, openNow: inside.has(e.userId) };
    row.workedMs += e.durationMs;
    row.shifts += 1;
    totals.set(e.userId, row);
  }
  return {
    from: range.from,
    to: range.to,
    entries,
    totals: [...totals.values()].sort((a, b) => a.userName.localeCompare(b.userName, 'tr')),
    clockedIn: open.map((e) => toDTO(e, who, now)),
    serverTime: now,
  };
}

/** Excel'in Türkçe ayarıyla açılan döküm: kişiye, sonra girişe göre; süre dakika ve ondalık saat (açık mesai şimdiye kadar) */
export function timeSheetCsv(sheet: TimeSheetDTO): string {
  const rows = [...sheet.entries].sort((a, b) => a.userName.localeCompare(b.userName, 'tr') || a.clockIn - b.clockIn);
  return toCsv([
    ['Personel', 'İş günü', 'Giriş', 'Çıkış', 'Dakika', 'Saat', 'Kaynak', 'Not', 'Düzelten'],
    ...rows.map((e) => [
      e.userName,
      e.businessDate,
      fmtDateTime(e.clockIn),
      e.clockOut == null ? 'Açık' : fmtDateTime(e.clockOut),
      Math.floor(e.durationMs / 60_000),
      Math.round(e.durationMs / 36_000) / 100,
      TIME_SOURCE_LABEL[e.source],
      e.note ?? '',
      e.editedByName ?? '',
    ]),
  ]);
}
