import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DenemeStatusDTO } from '@shared/types';
import { type Harness, startApp } from './harness';

/**
 * Sahadan gelen düzeltmeler (Kasım 2026, Marina): patron PIN'i değişince deneme modu sessizce kapanmamalı; yarım kalmış
 * geçiş kayıt silmeden tamamlanabilmeli; adisyon indirimi gönderilmemiş kalemleri önce yazmalı; tamamı ödenmiş
 * yeniden açılmış adisyonda "Alınan ödemeler"e giriş olmalı.
 */
let h: Harness;
beforeAll(async () => {
  h = await startApp();
});
afterAll(() => h.cleanup());

async function mod() {
  const { db, schema } = await import('../server/db/client');
  const { eq } = await import('drizzle-orm');
  const { getSettings, updateSettings } = await import('../server/lib/settings');
  return { db, schema, eq, getSettings, updateSettings };
}
const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');

describe('patron PIN değişikliği denemeyi kapatmaz', () => {
  it('PIN değişince demoMode açık kalır, şerit ve "Denemeyi bitir" yerinde', async () => {
    const { db, schema, eq, getSettings } = await mod();
    const patron = db.select().from(schema.users).where(eq(schema.users.role, 'patron')).get()!;
    await h.ok('patron', 'PATCH', `/admin/users/${patron.id}`, { pin: '482915' });
    expect(getSettings()).toMatchObject({ demoMode: true, liveSince: null });
    await h.login('patron', '482915');
  });
});

describe('yarım kalmış geçiş (demoMode kapalı, liveSince yok)', () => {
  it('gerçek günleri silmeden tamamlanır; örnek PIN’li hesaplar kapanır, denetime yazılır', async () => {
    const { db, schema, getSettings, updateSettings } = await mod();
    // Eski sürümde takılan durum: deneme kapalı, gerçek gün var, örnek PIN'li hesaplar açık
    updateSettings({ demoMode: false });
    await h.ok('kasa', 'POST', '/cash/day/open', { openingCash: 0 });
    await h.ok('kasa', 'POST', '/cash/day/close', { countedCash: 0 });
    db.update(schema.businessDays).set({ trainingDay: false }).run();
    const days = db.select().from(schema.businessDays).all().length;
    expect(days).toBeGreaterThan(0);

    const st = await h.ok<DenemeStatusDTO>('patron', 'GET', '/admin/deneme');
    expect(st).toMatchObject({ liveSince: null, finalizeOnly: true });
    expect(st.samplePinUsers.length).toBeGreaterThan(0);

    const r = await h.ok<{ finalized?: boolean; closedUsers: string[] }>('patron', 'POST', '/admin/deneme/bitir', { pin: '482915' });
    expect(r.finalized).toBe(true);
    expect(r.closedUsers.length).toBeGreaterThan(0);
    expect(getSettings().liveSince).not.toBeNull();
    expect(db.select().from(schema.businessDays).all().length).toBe(days);
    const audit = db.select().from(schema.auditLog).all().find((a) => a.action === 'deneme.bitir');
    expect(audit?.message).toContain('hiçbir kayıt silinmedi');
    // Bir kez çalışır
    expect(await h.ok<{ already: boolean }>('patron', 'POST', '/admin/deneme/bitir', { pin: '482915' })).toMatchObject({ already: true });
  });
});

describe('adisyon ekranı', () => {
  it('indirim açılmadan gönderilmemiş kalemler yazılır', () => {
    const s = src('pages/order/OrderPage.tsx');
    expect(s).toMatch(/const openDiscount = \(\) =>[\s\S]*?send\(holdOnPay\)[\s\S]*?setDialog\('indirim'\)/);
    expect(s).not.toMatch(/onClick: \(\) => setDialog\('indirim'\)/);
  });

  it('ödenecek tutar yokken "Alınan ödemeler" ödeme penceresini açar; iade yetkisi aynı', () => {
    const s = src('pages/order/OrderPage.tsx');
    expect(s).toMatch(/refundEntry = [^\n]*odeme\.iade[^\n]*due <= 0[^\n]*refundedAt/);
    expect(s).toContain("label: 'Alınan ödemeler'");
    expect(s).toMatch(/Alınan ödemeler\s*<\/Button>/);
  });
});
