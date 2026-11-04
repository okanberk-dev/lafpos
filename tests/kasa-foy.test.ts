import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ZSummary } from '@shared/types';
import { closeDayBody, countStarted, emptyCount, savedCount } from '../src/lib/cashCount';
import { type Harness, startApp } from './harness';

/**
 * Gün sonu sayımı ve kasa föyü (inceleme, 4 Kas 2026): dokunulmamış sayaç "Sayılmadı"dır, gün ₺0 sayılmış gibi
 * kapanmaz (fark eksi beklenen nakit, alarm); "sonra gireceğim"de yarım kalan banknot adetleri saklanmaz ve föye
 * taşınmaz; banknot dökümü sayılan tutarı tutmalı; föyde silinen not silinir.
 */

describe('sayım (istemci)', () => {
  it('dokunulmamış sayaç sayılmamıştır: gün sonu nakdi ve adetleri göndermez', () => {
    expect(countStarted(emptyCount())).toBe(false);
    expect(closeDayBody(emptyCount(), false, '')).toEqual({ countedCash: null, cashCounts: {}, note: null });
    // Sıfır da sayımdır (çekmece boş, tutar alanına 0 yazıldı)
    const zero = { ...emptyCount(), touched: true };
    expect(countStarted(zero)).toBe(true);
    expect(closeDayBody(zero, false, 'Boş çekmece')).toEqual({ countedCash: 0, cashCounts: {}, note: 'Boş çekmece' });
    // Adet adet sayım: sıfır adetler gitmez
    const notes = { countedCash: 80000, banknotes: { '20000': 4, '100': 0 }, methodCounts: { kart: 12000 }, touched: true };
    expect(closeDayBody(notes, false, '')).toEqual({ countedCash: 80000, cashCounts: { 'b:20000': 4, 'm:kart': 12000 }, note: null });
    // Sayımı sonra gireceğim: nakit ve yarım kalan adetler gitmez, yazılan slip tutarı gider
    expect(closeDayBody(notes, true, '')).toEqual({ countedCash: null, cashCounts: { 'm:kart': 12000 }, note: null });
    // Kaydedilmiş sayımdan gelen adetler de sayımdır
    expect(countStarted({ countedCash: 0, banknotes: { '500': 0 }, methodCounts: {} })).toBe(true);
  });

  it('föy kaydedilmiş sayımla açılır; sayımsız günün ve toplamı tutmayan adetler gelmez', () => {
    // Sayımsız kapanan gün: sayaç boş ve "Sayılmadı", slip tutarı gelir
    const none = savedCount(null, { 'b:20000': 4, 'm:kart': 12000 });
    expect(none).toEqual({ countedCash: 0, banknotes: {}, methodCounts: { kart: 12000 } });
    expect(countStarted(none)).toBe(false);
    // Adetli sayım adetleriyle (sıfırlar düşer)
    expect(savedCount(80000, { 'b:20000': 4, 'b:100': 0, 'm:kart': 12000 })).toEqual({ countedCash: 80000, banknotes: { '20000': 4 }, methodCounts: { kart: 12000 }, touched: true });
    // Adetler toplamı tutmuyorsa (bilinmeyen değer de) sayım toplam tutarla açılır
    expect(savedCount(0, { 'b:20000': 4 })).toEqual({ countedCash: 0, banknotes: {}, methodCounts: {}, touched: true });
    expect(savedCount(20007, { 'b:20000': 1, 'b:7': 1 })).toEqual({ countedCash: 20007, banknotes: {}, methodCounts: {}, touched: true });
    // ₺0 sayılmış gün de sayılmıştır: föyde fark gösterilir
    expect(countStarted(savedCount(0, null))).toBe(true);
  });
});

let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

type Detail = { day: { id: string; closedAt: number | null }; summary: ZSummary; lafmaliyet: Record<string, unknown>; note: string | null; cashCounts: Record<string, number> | null };
type AuditRow = { action: string; severity: string; message: string };
const detail = (id: string) => h.ok<Detail>('mudur', 'GET', `/cash/days/${id}`);
const close = (body: unknown) => h.call<{ day: { id: string }; code?: string; error?: string }>('mudur', 'POST', '/cash/day/close', body);
const reopen = (id: string) => h.ok('mudur', 'POST', `/cash/days/${id}/reopen`, { reason: 'Uçtan uca test' });
const count = (id: string, body: unknown) => h.call<{ code?: string; error?: string }>('mudur', 'POST', `/cash/days/${id}/count`, body);
const lastAudit = async (action: string) => (await h.ok<AuditRow[]>('patron', 'GET', '/admin/audit?limit=200')).find((a) => a.action === action)!;

describe('gün sonu sayımı ve kasa föyü (sunucu)', () => {
  let dayId = '';
  const card = () => h.boot.paymentMethods.find((m) => m.name === 'Kredi kartı')!.id;

  it('dokunulmamış sayaçla kapanan gün sayımsızdır: ₺0 ve alarm yazılmaz, lafmaliyet’e sayılan gitmez', async () => {
    dayId = (await h.ok<{ id: string }>('mudur', 'POST', '/cash/day/open', { openingCash: 89000 })).id;
    const res = await close(closeDayBody(emptyCount(), false, ''));
    expect(res.status).toBe(200);
    const d = await detail(dayId);
    expect(d.summary).toMatchObject({ expectedCash: 89000, countedCash: null, cashDiff: null });
    expect(d.lafmaliyet).toMatchObject({ counted_cash: null, cash_diff: null });
    const a = await lastAudit('day.close');
    expect(a.severity).toBe('info');
    expect(a.message).toContain('kasa farkı sayılmadı');
  });

  it('sayımı sonra gireceğim: yarım kalan banknot adetleri saklanmaz, slip tutarı kalır; föy boş sayaçla açılır', async () => {
    await reopen(dayId);
    // Eski istemci adetleri sayımsız kapanışta da gönderirdi
    expect((await close({ countedCash: null, cashCounts: { 'b:20000': 4, [`m:${card()}`]: 12000 } })).status).toBe(200);
    const d = await detail(dayId);
    expect(d.summary.countedCash).toBeNull();
    expect(d.cashCounts).toEqual({ [`m:${card()}`]: 12000 });
    const fill = savedCount(d.summary.countedCash, d.cashCounts);
    expect(fill).toEqual({ countedCash: 0, banknotes: {}, methodCounts: { [card()]: 12000 } });
    expect(countStarted(fill)).toBe(false);
  });

  it('gün sonunda toplamı tutmayan banknot dökümü reddedilir (gün açık kalır); tutan döküm saklanır', async () => {
    await reopen(dayId);
    const bad = await close({ countedCash: 50000, cashCounts: { 'b:20000': 4 }, note: 'Kart slipinde 1 işlem eksik' });
    expect([bad.status, bad.json.code]).toEqual([422, 'validation']);
    expect(bad.json.error).toBe('Banknotların toplamı (₺800,00) sayılan tutarla (₺500,00) aynı değil');
    expect((await h.ok<{ day: { id: string } | null }>('mudur', 'GET', '/cash/day')).day?.id).toBe(dayId);
    expect((await close({ countedCash: 80000, cashCounts: { 'b:20000': 4, 'b:100': 0 }, note: 'Kart slipinde 1 işlem eksik' })).status).toBe(200);
    const d = await detail(dayId);
    expect(d.summary).toMatchObject({ countedCash: 80000, cashDiff: -9000 });
    expect(d.cashCounts).toEqual({ 'b:20000': 4, 'b:100': 0 });
    expect(savedCount(d.summary.countedCash, d.cashCounts)).toEqual({ countedCash: 80000, banknotes: { '20000': 4 }, methodCounts: {}, touched: true });
  });

  it('föy: banknotlar sayılanı tutmalı; tutmayan kayıt reddedilir, gün kaydı değişmez', async () => {
    // Föyde adetler ₺800 iken Sayılan ₺0 (eski föy penceresi): çelişen kayıt yazılmaz
    const bad = await count(dayId, { countedCash: 0, banknotes: { '20000': 4 }, note: 'Kart slipinde 1 işlem eksik' });
    expect([bad.status, bad.json.code]).toEqual([422, 'validation']);
    expect((await detail(dayId)).summary.countedCash).toBe(80000);
    expect((await count(dayId, { countedCash: 89000, banknotes: { '20000': 4, '5000': 1, '2000': 2, '100': 0 } })).status).toBe(200);
    const d = await detail(dayId);
    expect(d.summary).toMatchObject({ countedCash: 89000, cashDiff: 0 });
    // Not gönderilmedi: kapanıştaki not kalır
    expect(d.note).toBe('Kart slipinde 1 işlem eksik');
  });

  it('föy notu: gönderilmeyen ya da null not kalır, yazılan yerine geçer, silinen (boş) not silinir', async () => {
    const noteOf = async () => (await detail(dayId)).note;
    expect((await count(dayId, { countedCash: 89000, note: null })).status).toBe(200);
    expect(await noteOf()).toBe('Kart slipinde 1 işlem eksik');
    expect((await count(dayId, { countedCash: 89000, note: '  Slip sonradan bulundu ' })).status).toBe(200);
    expect(await noteOf()).toBe('Slip sonradan bulundu');
    expect((await count(dayId, { countedCash: 89000, note: '' })).status).toBe(200);
    expect(await noteOf()).toBeNull();
    expect((await count(dayId, { countedCash: 89000, note: 'Geri yazıldı' })).status).toBe(200);
    expect((await count(dayId, { countedCash: 89000, note: '   ' })).status).toBe(200);
    expect(await noteOf()).toBeNull();
  });
});
