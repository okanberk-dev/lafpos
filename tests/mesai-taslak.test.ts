import { describe, expect, it } from 'vitest';
import { businessDate } from '@shared/time';
import type { TimeEntryDTO } from '@shared/types';
import { draftErrors, draftOf, draftTimes, editBody, type MesaiDraft } from '../src/lib/mesaiDraft';

/**
 * Yönetim › Mesai çizelgesinin düzeltme taslağı (src/lib/mesaiDraft.ts): tarih iş günüdür (05:00 kuralı), düzeltme
 * yalnız değişen alanı gönderir. İnceleme bulguları: yalnız not düzeltmesi saatleri dakikaya kırpıp 24 saatlik mesai
 * yazıyor, eşzamanlı çıkışı geri alıyor, gece yarısından sonraki elle kayıt bir gün önceye düşüyordu.
 */
const H = 3600_000;
/** İstanbul saatiyle an (UTC+3) */
const at = (date: string, hh: number, mm = 0, ss = 0) => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d, hh - 3, mm, ss);
};
const entry = (over: Partial<TimeEntryDTO>): TimeEntryDTO => ({
  id: 'e1',
  userId: 'u1',
  userName: 'Garson',
  userColor: '#123456',
  clockIn: at('2026-10-21', 9, 3, 27),
  clockOut: at('2026-10-21', 17, 45, 12),
  businessDate: '2026-10-21',
  note: null,
  source: 'pin',
  editedBy: null,
  editedByName: null,
  createdAt: 0,
  durationMs: 0,
  open: false,
  ...over,
});
const NOW = at('2026-11-03', 12);

describe('iş günü', () => {
  it('05:00 öncesi giriş seçili iş gününün gecesidir; iş günü yine o gün', () => {
    const d: MesaiDraft = { userId: 'u1', date: '2026-10-22', inTime: '00:30', outTime: '03:00', note: '' };
    const t = draftTimes(d);
    expect(t).toEqual({ clockIn: at('2026-10-23', 0, 30), clockOut: at('2026-10-23', 3) });
    expect(businessDate(t.clockIn)).toBe('2026-10-22');
  });

  it('gece yarısını geçen vardiya: çıkış ertesi gün', () => {
    expect(draftTimes({ userId: 'u1', date: '2026-10-22', inTime: '22:00', outTime: '02:00', note: '' })).toEqual({ clockIn: at('2026-10-22', 22), clockOut: at('2026-10-23', 2) });
    expect(draftTimes({ userId: 'u1', date: '2026-10-22', inTime: '22:00', outTime: '05:30', note: '' }).clockOut).toBe(at('2026-10-23', 5, 30));
  });

  it('kaydın taslağı tablodaki iş gününü taşır: gece 01:30 girişi açılıp kaydedilince yerinde kalır', () => {
    const e = entry({ clockIn: at('2026-11-03', 1, 30), clockOut: at('2026-11-03', 4), businessDate: '2026-11-02' });
    const d = draftOf(e);
    expect(d.date).toBe('2026-11-02');
    expect(draftTimes(d)).toEqual({ clockIn: e.clockIn, clockOut: e.clockOut });
    expect(editBody(d)).toBeNull();
  });
});

describe('yalnız değişen alan', () => {
  it('yalnız not: saatler gitmez (saniyeler korunur, denetime sahte düzeltme düşmez)', () => {
    const d = { ...draftOf(entry({})), note: ' Kamerayla doğrulandı ' };
    expect(editBody(d)).toEqual({ note: 'Kamerayla doğrulandı' });
  });

  it('aynı dakikada açılıp kapanan mesai: not düzeltmesi 24 saat yazmaz, hata da vermez', () => {
    const e = entry({ clockIn: at('2026-10-21', 9, 0, 10), clockOut: at('2026-10-21', 9, 0, 40) });
    const d = { ...draftOf(e), note: 'yanlışlıkla basıldı' };
    expect(d.inTime).toBe(d.outTime);
    expect(draftErrors(d, NOW)).toEqual({});
    expect(editBody(d)).toEqual({ note: 'yanlışlıkla basıldı' });
  });

  it('açık mesaiye not: çıkış gönderilmez (o arada kilit ekranında yapılan çıkış geri alınmaz)', () => {
    const d = { ...draftOf(entry({ clockOut: null, open: true })), note: 'geç geldi' };
    expect(editBody(d)).toEqual({ note: 'geç geldi' });
  });

  it('24 saatten eski açık mesaiye not eklenir; çıkış saati girilince yalnız çıkış gider', () => {
    const e = entry({ clockIn: at('2026-10-31', 14), clockOut: null, open: true, businessDate: '2026-10-31' });
    const noted = { ...draftOf(e), note: 'çıkışı unuttu' };
    expect(draftErrors(noted, NOW)).toEqual({});
    expect(editBody(noted)).toEqual({ note: 'çıkışı unuttu' });
    const closed = { ...draftOf(e), outTime: '22:00' };
    expect(draftErrors(closed, NOW)).toEqual({});
    expect(editBody(closed)).toEqual({ clockOut: at('2026-10-31', 22) });
  });

  it('girişi değişen kayıtta çıkış dakikası aynıysa gitmez; çıkışı silmek mesaiyi açar', () => {
    const e = entry({});
    expect(editBody({ ...draftOf(e), inTime: '08:30' })).toEqual({ clockIn: at('2026-10-21', 8, 30) });
    expect(editBody({ ...draftOf(e), outTime: '' })).toEqual({ clockOut: null });
  });

  it('elle kayıtta gövde yok (tam kayıt POST ile gider)', () => {
    expect(editBody({ userId: 'u1', date: '2026-10-21', inTime: '09:00', outTime: '17:00', note: '' })).toBeNull();
  });
});

describe('alan hataları', () => {
  const base: MesaiDraft = { userId: 'u1', date: '2026-11-03', inTime: '09:00', outTime: '17:00', note: '' };

  it('hata kendi alanının altında: ileri giriş girişte, ileri çıkış çıkışta', () => {
    expect(draftErrors({ ...base, inTime: '13:00', outTime: '' }, NOW)).toEqual({ in: 'Gelecekteki bir saat girilemez' });
    expect(draftErrors({ ...base, inTime: '09:00', outTime: '15:00' }, NOW)).toEqual({ out: 'Gelecekteki bir saat girilemez' });
  });

  it('aynı giriş ve çıkış 24 saat sayılmaz, hata olur', () => {
    expect(draftErrors({ ...base, date: '2026-11-01', inTime: '09:00', outTime: '09:00' }, NOW)).toEqual({ out: 'Çıkış girişten sonra olmalı' });
  });

  it('24 saatten eski elle kayıt açık bırakılamaz; kişi seçilmeli', () => {
    expect(draftErrors({ ...base, date: '2026-11-01', outTime: '' }, NOW)).toEqual({ out: '24 saatten eski mesai açık kalamaz; çıkışı girin' });
    expect(draftErrors({ ...base, date: '2026-11-03', inTime: '08:00', outTime: '' }, NOW + H)).toEqual({});
    expect(draftErrors({ ...base, userId: '' }, NOW)).toEqual({ who: 'Kişi seçin' });
  });
});
